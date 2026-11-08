//! What the back end's update has downloaded, and how much it downloads, while the Intelligence
//! CLI's `local update` runs.
//!
//! THE CLI SAYS NOTHING WHILE IT RUNS. It is run with `--json`, and with `--json` its progress
//! is silent (Intelligence `apps/cli/src/services/local-setup-progress.ts`,
//! `plainLocalSetupProgress`): one report at the end, minutes later. It pulls the release's images
//! into its k3d cluster's own containerd, with `ctr images pull` inside the cluster's node, never
//! through the engine's pull API, so no engine event says anything either.
//!
//! So this reads the cluster's content store, and only reads it, while the update runs. Every
//! layer containerd downloads is an ingest named `layer-sha256:<digest>` while it arrives
//! (`remotes.MakeRefKey`), which `ctr content active` lists with the bytes so far, and a blob
//! under its digest once it is whole, which `ctr content ls` lists with its size. What is new since
//! the update started is what it downloaded. The size comes from the registry, for the release's
//! own images, less the layers the cluster already has. It changes nothing in the cluster and
//! decides nothing: a cluster that cannot be read leaves the window showing only the update's own
//! sentence, as before.

use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::registry::Layer;

/// The images a release names by its version: Intelligence `apps/cli/src/services/
/// local-default-release.ts`, `runtimeServices`, at 704fdd4b1. The CLI reads each from
/// `ghcr.io/copilotkit/intelligence/<service>` at the release's version. The images it carries in
/// its own build (the cluster's system images, Redis, object storage) are set up with the cluster
/// and do not change with the release; one that does is still counted, once it starts to arrive.
pub const RELEASE_IMAGES: [&str; 5] = [
    "ghcr.io/copilotkit/intelligence/app-api",
    "ghcr.io/copilotkit/intelligence/app-frontend",
    "ghcr.io/copilotkit/intelligence/realtime-gateway",
    "ghcr.io/copilotkit/intelligence/db-migrations",
    "ghcr.io/copilotkit/intelligence/postgres-pgvector",
];

/// How often the cluster is read. Each read is two `exec`s into its node.
pub const POLL: Duration = Duration::from_secs(1);

/// The update's download, as the window shows it under "Waiting for the back end".
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transferred {
    pub bytes: u64,
    /// None until the registry has said, and for good when it cannot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_per_second: Option<u64>,
}

/// A size as `ctr` prints it: `go-units` `HumanSize`, four significant digits in powers of 1000,
/// such as `946B`, `2.815kB` or `16.03MB`.
pub fn human_size(text: &str) -> Option<u64> {
    let split = text.find(|c: char| c.is_ascii_alphabetic())?;
    let (number, unit) = text.split_at(split);
    let number: f64 = number.parse().ok()?;
    let power = ["B", "kB", "MB", "GB", "TB", "PB"]
        .iter()
        .position(|known| *known == unit)?;
    Some((number * 1000_f64.powi(power as i32)).round() as u64)
}

/// The blobs in `ctr content ls`: each digest with its size. The header and anything that is not a
/// blob line are skipped.
pub fn content_list(text: &str) -> HashMap<String, u64> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let digest = fields.next()?;
            let size = human_size(fields.next()?)?;
            digest
                .starts_with("sha256:")
                .then(|| (digest.to_string(), size))
        })
        .collect()
}

/// The downloads in `ctr content active`: each digest with the bytes it has so far. A ref names
/// its digest after a kind and, sometimes, a name: `layer-sha256:<hex>`,
/// `manifest-<name>@sha256:<hex>`.
pub fn active_list(text: &str) -> HashMap<String, u64> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let reference = fields.next()?;
            let offset = human_size(fields.next()?)?;
            let at = reference.find("sha256:")?;
            Some((reference[at..].to_string(), offset))
        })
        .collect()
}

/// The update's download, from the content store as it was when the update began.
pub struct Watch {
    before: HashSet<String>,
    /// The release's layers the cluster did not have, with their sizes, once the registry said.
    expected: Option<HashMap<String, u64>>,
    /// The most counted so far, so a read between two listings never shows less.
    most: u64,
}

impl Watch {
    pub fn new(before: &HashMap<String, u64>) -> Self {
        Self {
            before: before.keys().cloned().collect(),
            expected: None,
            most: 0,
        }
    }

    /// The release's layers, from its registry. Those already in the cluster download nothing.
    pub fn expect(&mut self, layers: &[Layer]) {
        self.expected = Some(
            layers
                .iter()
                .filter(|layer| !self.before.contains(&layer.digest))
                .map(|layer| (layer.digest.clone(), layer.size))
                .collect(),
        );
    }

    /// What has downloaded since the update began, and of how much, from one reading: `active`
    /// first, then `blobs`, so a layer that finished between the two counts once, whole.
    pub fn measure(
        &mut self,
        blobs: &HashMap<String, u64>,
        active: &HashMap<String, u64>,
    ) -> (u64, Option<u64>) {
        let expected = |digest: &str| self.expected.as_ref()?.get(digest).copied();
        let mut bytes = 0;
        let mut unexpected = 0;
        for (digest, size) in blobs {
            if self.before.contains(digest) {
                continue;
            }
            match expected(digest) {
                Some(size) => bytes += size,
                None => {
                    bytes += size;
                    unexpected += size;
                }
            }
        }
        for (digest, offset) in active {
            if blobs.contains_key(digest) || self.before.contains(digest) {
                continue;
            }
            match expected(digest) {
                Some(size) => bytes += (*offset).min(size),
                None => {
                    bytes += offset;
                    unexpected += offset;
                }
            }
        }
        let size = self
            .expected
            .as_ref()
            .map(|expected| expected.values().sum::<u64>() + unexpected);
        self.most = self.most.max(bytes);
        let bytes = size.map_or(self.most, |size| self.most.min(size));
        (bytes, size.map(|size| size.max(bytes)))
    }
}

/// The release's layers for this computer, deduplicated, or None when any registry cannot say.
pub fn release_layers(version: &str) -> Option<Vec<Layer>> {
    let mut seen = HashSet::new();
    let mut layers = Vec::new();
    for repository in RELEASE_IMAGES {
        for layer in crate::registry::image_layers(
            &format!("{repository}:{version}"),
            crate::registry::host_architecture(),
        )? {
            if seen.insert(layer.digest.clone()) {
                layers.push(layer);
            }
        }
    }
    Some(layers)
}

fn read(engine: &impl Fn() -> Option<Command>, node: &str, args: &[&str]) -> Option<String> {
    let mut command = engine()?;
    command.args(["exec", node, "ctr"]).args(args);
    let output = command.output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Reads stack `stack`'s cluster every `POLL` until `stop`, and tells `heard` what the update has
/// downloaded whenever that changes, or the speed does. `engine` is a command for the engine the
/// CLI runs the cluster on (`local_eval::engine_command`); `version` is the release the update
/// installs, for its size.
pub fn watch(
    stack: &str,
    version: Option<String>,
    engine: impl Fn() -> Option<Command>,
    stop: &AtomicBool,
    heard: impl Fn(Transferred),
) {
    let node = format!("k3d-{stack}-server-0");
    let sizes = version.map(|version| {
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(release_layers(&version));
        });
        receiver
    });
    let mut watch = None;
    let mut speed = crate::pull_metrics::Speed::default();
    let mut last = Transferred::default();
    while !stop.load(Ordering::SeqCst) {
        let reading = read(&engine, &node, &["content", "active"]).and_then(|active| {
            Some((
                active_list(&active),
                content_list(&read(&engine, &node, &["content", "ls"])?),
            ))
        });
        if let Some((active, blobs)) = reading {
            let watch = watch.get_or_insert_with(|| Watch::new(&blobs));
            if let Some(Ok(Some(layers))) = sizes.as_ref().map(|sizes| sizes.try_recv()) {
                watch.expect(&layers);
            }
            let (bytes, size) = watch.measure(&blobs, &active);
            let now = Transferred {
                bytes,
                size,
                bytes_per_second: speed.observe(Instant::now(), bytes),
            };
            if now != last {
                heard(now.clone());
                last = now;
            }
        }
        let until = Instant::now() + POLL;
        while Instant::now() < until && !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ctr content ls` as the node of a real local stack prints it (containerd v1.7.23-k3s2),
    /// trimmed to three blobs, labels cut short.
    const LISTED: &str = "DIGEST\t\t\t\t\t\t\t\t\tSIZE\tAGE\tLABELS\n\
sha256:00e4ef5a328f187bf2d9715f4786fbe09aaff02cdbb5bd7b79b52fa84c8a72b4\t946B\t13 days\tcontainerd.io/distribution.source.docker.io=rancher/klipper-lb\n\
sha256:048bcf48fc2cce517a61777e22bac782ba59ea5e9b9a54bcb42dbee99566a91f\t2.815kB\t13 days\tcontainerd.io/distribution.source.docker.io=rancher/mirrored-metrics-server\n\
sha256:058cf3d8c2ba04ad7c064698c08c5e886a8623c0ad6171b8d72684253534417d\t537.7kB\t13 days\tcontainerd.io/uncompressed=sha256:94\n";

    /// `ctr content active` while `ctr images pull` runs: containerd's `REF\tSIZE\tAGE\t`, the
    /// ref from `remotes.MakeRefKey` and the size `units.HumanSize` of the bytes so far.
    const ACTIVE: &str = "REF\tSIZE\tAGE\t\n\
layer-sha256:1111111111111111111111111111111111111111111111111111111111111111\t12.35MB\t3 seconds\t\n\
layer-sha256:2222222222222222222222222222222222222222222222222222222222222222\t1.5GB\t2 minutes\t\n\
manifest-ghcr.io/copilotkit/intelligence/app-api@sha256:3333333333333333333333333333333333333333333333333333333333333333\t1.2kB\t1 second\t\n";

    fn digest(n: char) -> String {
        format!("sha256:{}", n.to_string().repeat(64))
    }

    #[test]
    fn reads_sizes_as_ctr_prints_them() {
        assert_eq!(human_size("946B"), Some(946));
        assert_eq!(human_size("2.815kB"), Some(2_815));
        assert_eq!(human_size("16.03MB"), Some(16_030_000));
        assert_eq!(human_size("1.5GB"), Some(1_500_000_000));
        assert_eq!(human_size("SIZE"), None);
        assert_eq!(human_size("12"), None);
    }

    #[test]
    fn reads_the_content_store_listings() {
        let blobs = content_list(LISTED);
        assert_eq!(blobs.len(), 3);
        assert_eq!(
            blobs["sha256:048bcf48fc2cce517a61777e22bac782ba59ea5e9b9a54bcb42dbee99566a91f"],
            2_815
        );
        let active = active_list(ACTIVE);
        assert_eq!(active[&digest('1')], 12_350_000);
        assert_eq!(active[&digest('2')], 1_500_000_000);
        assert_eq!(active[&digest('3')], 1_200);
        assert_eq!(active.len(), 3);
    }

    #[test]
    fn counts_what_arrived_since_the_update_began_out_of_the_release_it_installs() {
        let old = digest('0');
        let before = HashMap::from([(old.clone(), 5_000)]);
        let mut watch = Watch::new(&before);
        // Nothing yet, and no size until the registry says.
        assert_eq!(watch.measure(&before, &HashMap::new()), (0, None));
        // The release: one layer the cluster has, two it does not.
        watch.expect(&[
            Layer {
                digest: old.clone(),
                size: 5_000,
            },
            Layer {
                digest: digest('1'),
                size: 100_000_000,
            },
            Layer {
                digest: digest('2'),
                size: 2_000_000_000,
            },
        ]);
        let active = active_list(ACTIVE);
        let (bytes, size) = watch.measure(&before, &active);
        // 12.35 MB and 1.5 GB of the release's layers, and the 1.2 kB manifest, which the
        // registry's size did not name and so is added to it.
        assert_eq!(bytes, 12_350_000 + 1_500_000_000 + 1_200);
        assert_eq!(size, Some(2_100_000_000 + 1_200));
        // The first layer finished between the two reads: counted once, whole.
        let mut blobs = before.clone();
        blobs.insert(digest('1'), 100_000_000);
        let (bytes, _) = watch.measure(&blobs, &active);
        assert_eq!(bytes, 100_000_000 + 1_500_000_000 + 1_200);
        // Everything here: all of it, of all of it.
        blobs.insert(digest('2'), 2_000_000_000);
        blobs.insert(digest('3'), 1_200);
        assert_eq!(
            watch.measure(&blobs, &HashMap::new()),
            (2_100_001_200, Some(2_100_001_200))
        );
    }

    #[test]
    fn a_reading_never_shows_less_than_one_before_it() {
        let mut watch = Watch::new(&HashMap::new());
        let active = HashMap::from([(digest('1'), 500)]);
        assert_eq!(watch.measure(&HashMap::new(), &active).0, 500);
        // The ingest committed and was not yet listed: still 500, not 0.
        assert_eq!(watch.measure(&HashMap::new(), &HashMap::new()).0, 500);
    }
}
