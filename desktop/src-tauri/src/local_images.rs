/*!
The back end's container images, downloaded by OpenBot before the CopilotKit CLI pulls them.

THE PROBLEM. `local setup` and `local update` (a new update, or the next Start's retry of one that
did not finish) each pull every image the release runs into the stack's k3d node with
`ctr images pull`, four at once, each under a
fixed ten-minute limit (Intelligence `apps/cli/src/services/local-install.ts` at 48a3863,
`LOCAL_IMAGE_PULL_CONCURRENCY` and `timeoutMs: 600_000`). On a 100 to 150 KB/s line a 147 MB image
does not arrive in ten minutes: the pull is stopped while it is still downloading, the step fails,
and every retry fails the same way.

THE WORKAROUND. Before the CLI runs that step, this module pulls the same images, by the same
digests, with the same `ctr images pull`, into the same place: the node's containerd, namespace
`k8s.io`. The CLI then finds them present, and its own pulls finish at once. The CLI runs exactly as
before afterwards.

HOW IT DOWNLOADS. One image at a time, with no fixed limit. A download stops only when no new bytes
have arrived for `Limits::stall`, or after the generous `Limits::image`. Bytes are what containerd
itself holds for the release's blobs (`ctr content ls` and `ctr content active`), so a slow line
that is still moving is never stopped. containerd keeps what a stopped pull fetched, as an ingest,
and the next pull of the same blob continues from there with a range request; a failed pull is
started again for as long as bytes keep arriving.

WHICH IMAGES. Read from the pinned CLI's own bytes (`cli_images`), the way `cli_release` reads the
release it installs: its built-in image inventory, the names its install leaves out, its runtime
image repositories, and the release, whose tag gives those repositories' digests. The digests are
read from the registry as the CLI reads them: the SHA-256 of the index the tag serves. Anything that
cannot be read is left for the CLI to pull, as before.

WHAT LEAVES. Bytes arrived and bytes in all (`Download`), by attempt. No image name, digest or
engine output.
*/

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// What the pinned CLI pulls for the release it installs, read out of the CLI itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CliImages {
    /// The release the CLI installs. Its runtime images are pulled at this tag's digest.
    pub release: String,
    /// Images named by digest in the CLI: its built-in inventory, less what its install leaves
    /// out, then the Kubernetes system images.
    pub fixed: Vec<String>,
    /// Repositories whose image is the one the release's tag names.
    pub tagged: Vec<String>,
}

/**
The images the CLI in `source` pulls when it installs or updates a stack, or `None` when any part
of that cannot be read from it.

The CLI is a bundle esbuild wrote, and these are its own lines (see the fixture beside the tests):
the release (`const pinnedVersion = false ? "" : "<release>"`, as `cli_release` reads it), the
built-in inventory (`define_CLI_LOCAL_EVALUATION_SUPPORT_default = {...}`), the names the install's
pull leaves out (`.filter(([name]) => ![...].includes(name))`), the runtime images
(`runtimeServices = {...}`) and the repository they live in (`` const repository = `...${service}`; ``).
A CLI whose bytes say any of it differently is a CLI this build does not know, and nothing is
guessed for it.
*/
pub fn cli_images(source: &str) -> Option<CliImages> {
    let release = crate::cli_release::pinned_release_in(source)?;
    let support: Support = serde_json::from_str(&json_of(literal_after(
        source,
        "define_CLI_LOCAL_EVALUATION_SUPPORT_default = ",
    )?)?)
    .ok()?;
    let left_out: Vec<String> = serde_json::from_str(between(
        source,
        ".filter(([name]) => !",
        ".includes(name))",
    )?)
    .ok()?;
    let services: BTreeMap<String, String> =
        serde_json::from_str(&json_of(literal_after(source, "runtimeServices = ")?)?).ok()?;
    let prefix = between(source, "const repository = `", "${service}`;")?;
    if !prefix.ends_with('/') || !repository(prefix.trim_end_matches('/')) {
        return None;
    }
    let mut fixed = Vec::new();
    for (name, image) in &support.images {
        // The runtime images replace the inventory's entries of the same name.
        if left_out.contains(name) || services.contains_key(name) {
            continue;
        }
        push_unique(&mut fixed, image.reference()?);
    }
    for image in &support.kubernetes_images {
        push_unique(&mut fixed, image.reference()?);
    }
    let mut tagged = Vec::new();
    for service in services.values() {
        let named = format!("{prefix}{service}");
        if !repository(&named) {
            return None;
        }
        push_unique(&mut tagged, named);
    }
    Some(CliImages {
        release,
        fixed,
        tagged,
    })
}

/**
The images `cli_images` leaves out, because k3d pulls them through the engine when the CLI creates
the cluster and not into the node: the names the CLI's install filters out of its inventory (the
k3s node image, k3d's proxy and tools), each by the digest the CLI gives k3d (`--image`,
`K3D_IMAGE_LOADBALANCER`, `K3D_IMAGE_TOOLS`). `None` when any part cannot be read.
*/
pub fn cli_cluster_images(source: &str) -> Option<Vec<String>> {
    let support: Support = serde_json::from_str(&json_of(literal_after(
        source,
        "define_CLI_LOCAL_EVALUATION_SUPPORT_default = ",
    )?)?)
    .ok()?;
    let left_out: Vec<String> = serde_json::from_str(between(
        source,
        ".filter(([name]) => !",
        ".includes(name))",
    )?)
    .ok()?;
    left_out
        .iter()
        .map(|name| support.images.get(name)?.reference())
        .collect()
}

#[derive(Deserialize)]
struct Support {
    images: BTreeMap<String, Image>,
    #[serde(rename = "kubernetesImages")]
    kubernetes_images: Vec<Image>,
}

#[derive(Deserialize)]
struct Image {
    repository: String,
    digest: String,
}

impl Image {
    fn reference(&self) -> Option<String> {
        (repository(&self.repository) && digest(&self.digest))
            .then(|| format!("{}@{}", self.repository, self.digest))
    }
}

fn push_unique(into: &mut Vec<String>, value: String) {
    if !into.contains(&value) {
        into.push(value);
    }
}

/// A repository as it reaches `ctr`: a registry host and path, nothing that reads as a flag or a
/// second word.
fn repository(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 255
        && bytes[0].is_ascii_alphanumeric()
        && !name.contains("..")
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"./_:-".contains(byte)
        })
}

fn digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

fn sha256(bytes: &[u8]) -> String {
    let hex: String = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("sha256:{hex}")
}

/// The text between the first `start` and the `end` after it.
fn between<'a>(source: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let from = source.find(start)? + start.len();
    let rest = &source[from..];
    Some(&rest[..rest.find(end)?])
}

/// The object or array literal that follows the first `marker`, brackets matched outside strings.
fn literal_after<'a>(source: &'a str, marker: &str) -> Option<&'a str> {
    let start = source.find(marker)? + marker.len();
    let text = &source[start..];
    let (open, close) = match text.as_bytes().first()? {
        b'{' => (b'{', b'}'),
        b'[' => (b'[', b']'),
        _ => return None,
    };
    let (mut depth, mut quoted, mut escaped) = (0usize, false, false);
    for (index, byte) in text.bytes().enumerate() {
        if quoted {
            match byte {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => quoted = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => quoted = true,
            _ if byte == open => depth += 1,
            _ if byte == close => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[..=index]);
                }
            }
            _ => {}
        }
    }
    None
}

/// esbuild's object literal as JSON: its keys are bare words, its values JSON already.
fn json_of(literal: &str) -> Option<String> {
    static KEY: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let key = KEY.get_or_init(|| {
        regex::Regex::new(r"([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:").expect("a valid pattern")
    });
    // Strings in these literals are digests, repositories, versions and addresses: none holds a
    // brace or a comma before a word and a colon, so only keys match.
    Some(key.replace_all(literal, "$1\"$2\":").into_owned())
}

/// How long a download may go on.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// No new bytes for this long, and the download is stopped.
    pub stall: Duration,
    /// However it is going, one image is not downloaded for longer than this.
    pub image: Duration,
    /// Between looks at what containerd holds.
    pub poll: Duration,
    /// One small engine call: reading a manifest, listing images, starting the node.
    pub call: Duration,
}

impl Limits {
    /// Three minutes without a byte is a line that stopped; an hour for one image is far beyond
    /// the 147 MB image at 100 KB/s that the CLI's ten minutes could not take.
    ///
    /// containerd writes an ingest a whole MiB at a time (its copy buffer, `copyWithBuffer` in
    /// containerd 1.7), so what it reports moves in MiB steps. Three minutes is one step for a
    /// connection bringing under 6 KB/s: well below a line anybody would wait on.
    pub fn standard() -> Self {
        Self {
            stall: Duration::from_secs(3 * 60),
            image: Duration::from_secs(60 * 60),
            poll: Duration::from_secs(2),
            call: Duration::from_secs(3 * 60),
        }
    }
}

/// How much of the download has arrived, in bytes, of how much in all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub done: u64,
    pub total: u64,
}

/// Why a download stopped before it finished. What it fetched stays in containerd for the next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stop {
    /// No new bytes for `Limits::stall`.
    Stalled,
    /// One image took longer than `Limits::image`.
    TooLong,
    Cancelled,
}

/// What a download that did not stop did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Done {
    /// Every image was already there.
    NothingToDo,
    Downloaded,
    /// The node, or what the images are, could not be found out. The CLI pulls, as before.
    Unavailable,
}

/**
Where the back end's images are pulled from first: CopilotKit's own copy of ghcr.io and Docker Hub,
with each registry itself after it.

WHY. ghcr.io's CDN can be slow for a whole office (0.24 to 0.32 MB/s on a 300 Mbit line, measured
2026-11-06, while nodejs.org gave 31.5 MB/s on the same Mac in the same minute). So the images are
also published to `https://downloads.copilotkit.ai`: CloudFront over a private S3 bucket, holding a
read-only OCI Distribution v2 tree at the domain root with ghcr.io's paths unchanged. A key it does
not hold answers 403, not 404; query strings are ignored.

HOW. As a registry mirror of the node's containerd, the documented way: k3s's
`/etc/rancher/k3s/registries.yaml` (docs.k3s.io/installation/private-registry), from which k3s
writes containerd's `certs.d/<registry>/hosts.toml` each time it starts (k3s
`pkg/agent/containerd/config.go`). containerd tries a `hosts.toml`'s hosts in order and the
registry itself last (containerd `docs/hosts.md`), and moves on from a host on any failure: a 403,
a 404 or no answer, for a manifest and for a blob (containerd 1.7.23 `remotes/docker/resolver.go`
and `fetcher.go`). An image is still stored under its ghcr.io name, so the CLI and Kubernetes find
it where they look.

WHO READS IT. Kubernetes' pulls, through containerd's CRI, read the hosts directory on every pull.
`ctr` reads it only when given `--hosts-dir` (containerd `cmd/ctr/commands/resolver.go`; k3s says
so in `PreloadImages`), so every `ctr` this module runs is given it. The CLI's own
`ctr images pull` is not, and cannot be from here: what puts its pulls on the mirror is this
module pulling the same images first, after which the CLI's pull finds every blob present.

WHEN IT IS WRITTEN. Into a node the CLI creates, by k3d, before the node first starts: `local_eval`
gives the CLI `K3D_REGISTRIES_CONFIG`, naming the file `registries_file` writes, the CLI hands its
environment to `k3d cluster create`, and k3d v5.8.3 reads that variable as its `--registry-config`
flag (`cmd/cluster/clusterCreate.go`, viper with the `K3D` prefix) and writes the file to
`/etc/rancher/k3s/registries.yaml`. Into a node made before that, by `apply_mirror` before each
download, with the `hosts.toml` k3s would write from it, which containerd reads on the next pull.
Both live in the node's own filesystem, so they are there after every restart.
*/
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mirror {
    /// Each registry the images are named for, as containerd's hosts directory names it, with the
    /// address its copy is served from. An address with no path has the standard `/v2` API root
    /// beneath it; an address with a path is the API root itself.
    pub registries: Vec<(String, String)>,
}

impl Mirror {
    /// ghcr.io's paths at the root, Docker Hub's under `v2/docker.io/` (its official images under
    /// `library/`, as containerd names them).
    pub fn standard() -> Self {
        Self {
            registries: vec![
                ("ghcr.io".into(), "https://downloads.copilotkit.ai".into()),
                (
                    "docker.io".into(),
                    "https://downloads.copilotkit.ai/v2/docker.io".into(),
                ),
            ],
        }
    }

    /// The k3s registries file: each mirror, with its registry itself after it.
    pub fn registries_yaml(&self) -> String {
        let mut yaml = String::from("mirrors:\n");
        for (registry, endpoint) in &self.registries {
            yaml.push_str(&format!(
                "  {registry:?}:\n    endpoint:\n      - {endpoint:?}\n"
            ));
        }
        yaml
    }

    /**
    The `hosts.toml` k3s v1.31 writes for `registry` from `registries_yaml`, byte for byte, so the
    file written here and the one k3s writes when the node next starts are the same file. Its first
    line marks it as k3s's own, and k3s replaces it from the registries file at every start. The
    registry is plain HTTP only where k3s makes it so: a loopback address on a port other than 443.
    Docker Hub's API is `registry-1.docker.io`. An address with a path keeps it as the API root
    (`override_path`), as k3s's `normalizeEndpointAddress` keeps it.
    */
    fn hosts_toml(registry: &str, endpoint: &str) -> String {
        let loopback = ["127.0.0.1:", "localhost:", "[::1]:"]
            .iter()
            .any(|prefix| registry.starts_with(prefix))
            && !registry.ends_with(":443");
        let scheme = if loopback { "http" } else { "https" };
        let server = if registry == "docker.io" {
            "registry-1.docker.io"
        } else {
            registry
        };
        let endpoint = endpoint.trim_end_matches('/');
        let path = endpoint
            .split_once("://")
            .map_or(endpoint, |(_, rest)| rest)
            .split_once('/')
            .map_or("", |(_, path)| path);
        let (host, override_path) = match path {
            "" | "v2" => (format!("{}/v2", endpoint.trim_end_matches("/v2")), ""),
            _ => (endpoint.to_owned(), "  override_path = true\n"),
        };
        format!(
            "# File generated by k3s. DO NOT EDIT.\n\nserver = \"{scheme}://{server}/v2\"\ncapabilities = [\"pull\", \"resolve\", \"push\"]\n\n\n[host]\n[host.\"{host}\"]\n  capabilities = [\"pull\", \"resolve\"]\n{override_path}"
        )
    }
}

/// Where k3s keeps containerd's per-registry `hosts.toml`.
const HOSTS_DIR: &str = "/var/lib/rancher/k3s/agent/etc/containerd/certs.d";

static REGISTRIES_FILE: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Where the registries file for new nodes lives. Set once, at start-up, by the app, which knows
/// its data directory.
pub fn registries_file_lives_at(path: std::path::PathBuf) {
    let _ = REGISTRIES_FILE.set(path);
}

/// The registries file for `k3d cluster create`, written when it changed, or None when it cannot
/// be: k3d stops on a file it cannot open, so the CLI then creates its node as before, and
/// `apply_mirror` writes the mirror into it.
pub fn registries_file() -> Option<&'static std::path::Path> {
    let path = REGISTRIES_FILE.get()?;
    let wanted = Mirror::standard().registries_yaml();
    if std::fs::read_to_string(path).ok().as_deref() != Some(wanted.as_str()) {
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        let written = path
            .parent()
            .is_some_and(|dir| std::fs::create_dir_all(dir).is_ok())
            && std::fs::write(&temporary, &wanted).is_ok()
            && std::fs::rename(&temporary, path).is_ok();
        if !written {
            log::warn!("[local images] could not write the registry mirror file");
            return None;
        }
    }
    Some(path.as_path())
}

/// The stack's k3d node, reached through the container engine the CLI runs on.
pub struct Node<'a> {
    engine: &'a (dyn Fn() -> Command + Sync),
    stack: String,
    name: String,
    mirror: Mirror,
}

impl<'a> Node<'a> {
    /// The node k3d names for `stack`, as the CLI names it: `k3d-<stack>-server-0`.
    pub fn for_stack(engine: &'a (dyn Fn() -> Command + Sync), stack: &str) -> Self {
        Self {
            engine,
            stack: stack.to_owned(),
            name: format!("k3d-{stack}-server-0"),
            mirror: Mirror::standard(),
        }
    }

    /// The same node, pulling through `mirror` instead.
    #[cfg(test)]
    pub(crate) fn with_mirror(self, mirror: Mirror) -> Self {
        Self { mirror, ..self }
    }

    /**
    The mirror written into the running node, for now and for every start after: the registries
    file k3s reads at start, unless the node has one already, and the `hosts.toml` k3s would write
    from it, which containerd reads on the next pull. A registries file that names some other
    mirror is somebody's own configuration, and nothing is changed. False when nothing was written.
    */
    fn apply_mirror(&self, limits: Limits) -> bool {
        // `$1` the registries file, `$2` the address it is known by, then each registry's
        // directory and `hosts.toml`. A registries file this wrote, or k3d wrote from the one
        // `registries_file` wrote, names that address and is brought up to date.
        const SCRIPT: &str = r#"set -e
registries=/etc/rancher/k3s/registries.yaml
if [ -e "$registries" ] && ! grep -qF "$2" "$registries"; then exit 3; fi
mkdir -p /etc/rancher/k3s
printf '%s' "$1" > "$registries.openbot"
mv "$registries.openbot" "$registries"
shift 2
while [ $# -gt 1 ]; do
  mkdir -p "$1"
  printf '%s' "$2" > "$1/hosts.toml.openbot"
  mv "$1/hosts.toml.openbot" "$1/hosts.toml"
  shift 2
done"#;
        let Some((_, known_by)) = self.mirror.registries.first() else {
            return false;
        };
        let mut files = Vec::new();
        for (registry, endpoint) in &self.mirror.registries {
            files.push(format!("{HOSTS_DIR}/{registry}"));
            files.push(Mirror::hosts_toml(registry, endpoint));
        }
        let registries = self.mirror.registries_yaml();
        let mut args = vec!["sh", "-c", SCRIPT, "sh", &registries, known_by];
        args.extend(files.iter().map(String::as_str));
        self.exec(&args, limits.call, 4096)
            .is_some_and(|(ok, _)| ok)
    }

    /// An engine command, to its end or `limit`. Its exit status and at most `cap` bytes of stdout.
    fn run(&self, args: &[&str], limit: Duration, cap: usize) -> Option<(bool, Vec<u8>)> {
        let mut command = (self.engine)();
        command.args(args);
        run_within(command, limit, cap)
    }

    /// `args` run in the node.
    fn exec(&self, args: &[&str], limit: Duration, cap: usize) -> Option<(bool, Vec<u8>)> {
        let mut all = vec!["exec", self.name.as_str()];
        all.extend_from_slice(args);
        self.run(&all, limit, cap)
    }

    /// Whether the node is running, when it is this stack's: the CLI labels the node it creates
    /// `copilotkit.local-stack=<stack>` (`--runtime-label`), and nothing else is touched.
    fn running(&self, limits: Limits) -> Option<bool> {
        let (ok, out) = self.run(
            &[
                "inspect",
                "--format",
                "{{.State.Running}} {{index .Config.Labels \"copilotkit.local-stack\"}}",
                &self.name,
            ],
            limits.call,
            4096,
        )?;
        let out = String::from_utf8(out).ok()?;
        let mut words = out.split_whitespace();
        let running = words.next()?;
        (ok && words.next() == Some(self.stack.as_str()) && words.next().is_none())
            .then_some(running == "true")
    }

    /// The node started, as the CLI's own `local start` starts it, and its containerd answering.
    fn start(&self, limits: Limits) -> bool {
        if !self
            .run(&["start", &self.name], limits.call, 4096)
            .is_some_and(|(ok, _)| ok)
        {
            return false;
        }
        let until = Instant::now() + limits.call;
        while Instant::now() < until {
            if self.image_names(limits).is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        false
    }

    fn stop(&self, limits: Limits) {
        let _ = self.run(&["stop", &self.name], limits.call, 4096);
    }

    /// Every image name in the node's containerd. A pull by `repo@digest` is listed by that name.
    fn image_names(&self, limits: Limits) -> Option<HashSet<String>> {
        let (ok, out) = self.exec(&["ctr", "images", "ls", "-q"], limits.call, 4 << 20)?;
        ok.then(|| lines(&out).map(str::to_owned).collect())
    }

    /**
    Whether the node's kubelet says it is short of disk: its `DiskPressure` condition, from `kubectl
    get nodes` run in the node, as the CLI runs its own `kubectl`. k3s raises it below 5% free and
    removes images it is not running above 85% used, which is how a relaunch on a nearly full disk
    loses the back end's images. None when the node does not answer.
    */
    pub fn disk_pressure(&self, limit: Duration) -> Option<bool> {
        let (ok, out) = self.exec(
            &[
                "kubectl",
                "get",
                "nodes",
                "--request-timeout=5s",
                "-o",
                "json",
            ],
            limit,
            4 << 20,
        )?;
        ok.then(|| disk_pressure_of(&out)).flatten()
    }

    /// The node's architecture, as an image index names it.
    fn architecture(&self, limits: Limits) -> Option<&'static str> {
        let (ok, out) = self.exec(&["uname", "-m"], limits.call, 64)?;
        match (ok, String::from_utf8(out).ok()?.trim()) {
            (true, "aarch64" | "arm64") => Some("arm64"),
            (true, "x86_64" | "amd64") => Some("amd64"),
            _ => None,
        }
    }

    /// One manifest or index, as the registry serves it, through the node's containerd.
    fn fetch(&self, reference: &str, limits: Limits) -> Option<Vec<u8>> {
        let (ok, out) = self.exec(
            &[
                "ctr",
                "content",
                "fetch-object",
                "--hosts-dir",
                HOSTS_DIR,
                reference,
            ],
            limits.call,
            4 << 20,
        )?;
        ok.then_some(out)
    }

    /// What containerd holds now: the blobs it has, and how far each ingest has got.
    fn content(&self, limits: Limits) -> Option<Content> {
        let (ok, out) = self.exec(
            &[
                "sh",
                "-c",
                "ctr content ls -q && echo ----- && ctr content active",
            ],
            limits.call,
            16 << 20,
        )?;
        ok.then(|| Content::parse(&String::from_utf8_lossy(&out)))
            .flatten()
    }

    /**
    `ctr images pull <reference>` in the node, as the CLI runs it. Through `sh` only to learn its
    process id: stopping the engine's `exec` client leaves the process running inside the node, so
    a pull is stopped by its id (`Pull::stop`). Its output goes nowhere, so nothing it prints can
    hold it up.
    */
    fn pull(&self, reference: &str) -> Option<Pull> {
        let mut command = (self.engine)();
        command
            .args([
                "exec",
                &self.name,
                "sh",
                "-c",
                "ctr images pull --hosts-dir \"$2\" \"$1\" >/dev/null 2>&1 & echo $!; wait $!",
                "sh",
                reference,
                HOSTS_DIR,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().ok()?;
        let stdout = child.stdout.take()?;
        let (sender, received) = mpsc::channel();
        std::thread::spawn(move || {
            let mut first = String::new();
            let mut reader = BufReader::new(stdout);
            let _ = reader.read_line(&mut first);
            let _ = sender.send(first);
            // Drained to its end, which is the pull's.
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
        });
        match received
            .recv_timeout(Duration::from_secs(30))
            .ok()
            .and_then(|line| line.trim().parse::<u32>().ok())
        {
            Some(pid) => Some(Pull { child, pid }),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                None
            }
        }
    }
}

/// `DiskPressure` from `kubectl get nodes -o json`: true when any node has it, false when every
/// node that says has not, None when none says.
pub fn disk_pressure_of(json: &[u8]) -> Option<bool> {
    let nodes: Value = serde_json::from_slice(json).ok()?;
    let said: Vec<bool> = nodes
        .get("items")?
        .as_array()?
        .iter()
        .filter_map(|node| node.pointer("/status/conditions")?.as_array())
        .flatten()
        .filter(|condition| condition.get("type").and_then(Value::as_str) == Some("DiskPressure"))
        .filter_map(|condition| match condition.get("status")?.as_str()? {
            "True" => Some(true),
            "False" => Some(false),
            _ => None,
        })
        .collect();
    (!said.is_empty()).then(|| said.contains(&true))
}

/// An engine command, to its end or `limit`: its exit status and at most `cap` bytes of stdout.
/// One still running at `limit` is killed and gives no answer.
pub(crate) fn run_within(
    mut command: Command,
    limit: Duration,
    cap: usize,
) -> Option<(bool, Vec<u8>)> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let (sender, received) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.take(cap as u64).read_to_end(&mut bytes);
        let _ = sender.send(bytes);
    });
    let until = Instant::now() + limit;
    let status = loop {
        if let Some(status) = child.try_wait().ok()? {
            break status;
        }
        if Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let bytes = received.recv_timeout(Duration::from_secs(5)).ok()?;
    Some((status.success(), bytes))
}

/// What every k3d node on the engine says of `DiskPressure` (`Node::disk_pressure`): true when
/// any has it. The nodes share the engine's disk.
pub fn any_disk_pressure(engine: &(dyn Fn() -> Command + Sync), limits: Limits) -> Option<bool> {
    let said: Vec<bool> = stack_nodes(engine, limits)?
        .iter()
        .filter_map(|stack| Node::for_stack(engine, stack).disk_pressure(limits.call))
        .collect();
    (!said.is_empty()).then(|| said.contains(&true))
}

fn lines(bytes: &[u8]) -> impl Iterator<Item = &str> {
    std::str::from_utf8(bytes)
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
}

/// One running `ctr images pull`.
struct Pull {
    child: Child,
    pid: u32,
}

impl Pull {
    fn finished(&mut self) -> Option<bool> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.success()),
            Ok(None) => None,
            Err(_) => Some(false),
        }
    }

    /// Stop the pull in the node, then its `exec` client. containerd keeps what it fetched.
    fn stop(mut self, node: &Node, limits: Limits) {
        let pid = self.pid.to_string();
        let _ = node.exec(&["kill", "-TERM", &pid], limits.call, 4096);
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until && self.finished().is_none() {
            std::thread::sleep(Duration::from_millis(50));
        }
        if self.finished().is_none() {
            let _ = node.exec(&["kill", "-KILL", &pid], limits.call, 4096);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The blobs containerd has, and the bytes each ingest in progress holds so far.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Content {
    present: HashSet<String>,
    active: HashMap<String, u64>,
}

impl Content {
    /// `ctr content ls -q`, a `-----` line, then `ctr content active`.
    fn parse(text: &str) -> Option<Self> {
        // An empty store lists nothing, so the separator can be the first line.
        let (listed, active) = format!("\n{text}")
            .split_once("\n-----\n")
            .map(|(listed, active)| (listed.to_owned(), active.to_owned()))?;
        let (listed, active) = (listed.as_str(), active.as_str());
        Some(Self {
            present: listed
                .lines()
                .map(str::trim)
                .filter(|line| digest(line))
                .map(str::to_owned)
                .collect(),
            active: active_ingests(active),
        })
    }

    fn held(&self, blob: &str, size: u64) -> u64 {
        if self.present.contains(blob) {
            size
        } else {
            self.active.get(blob).copied().unwrap_or(0).min(size)
        }
    }
}

/**
`ctr content active`: a header, then a ref, a size and an age per ingest, tab separated:
`layer-sha256:<hex>\t14.68MB\t3 minutes\t`. The size is go-units' `HumanSize`, four significant
figures in decimal units, which is all the precision a download needs. The digest is the blob's.
*/
pub fn active_ingests(text: &str) -> HashMap<String, u64> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split('\t').filter(|field| !field.is_empty());
            let reference = fields.next()?;
            let at = reference.find("sha256:")?;
            let blob = &reference[at..];
            digest(blob).then_some(())?;
            Some((blob.to_owned(), human_size(fields.next()?.trim())?))
        })
        .collect()
}

fn human_size(text: &str) -> Option<u64> {
    let split = text.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
    let (number, unit) = text.split_at(split);
    let scale: f64 = match unit {
        "B" => 1.0,
        "kB" | "KB" => 1e3,
        "MB" => 1e6,
        "GB" => 1e9,
        "TB" => 1e12,
        _ => return None,
    };
    Some((number.parse::<f64>().ok()? * scale) as u64)
}

/// The manifest for `architecture` in an image index, as `ctr` picks it for the node's platform.
pub fn platform_manifest(index: &Value, architecture: &str) -> Option<String> {
    index
        .get("manifests")?
        .as_array()?
        .iter()
        .find(|entry| {
            let platform = entry.get("platform");
            let field = |name: &str| platform.and_then(|p| p.get(name)).and_then(Value::as_str);
            field("os") == Some("linux")
                && field("architecture") == Some(architecture)
                && matches!(field("variant"), None | Some("") | Some("v8") | Some("v1"))
        })?
        .get("digest")?
        .as_str()
        .filter(|found| digest(found))
        .map(str::to_owned)
}

/// The blobs an image is made of for the node's platform, by digest and size.
fn blobs_of(
    node: &Node,
    reference: &str,
    known: Option<Vec<u8>>,
    architecture: &str,
    limits: Limits,
) -> Option<Vec<(String, u64)>> {
    let (name, wanted) = reference.split_once('@')?;
    let bytes = match known {
        Some(bytes) => bytes,
        None => node.fetch(reference, limits)?,
    };
    if sha256(&bytes) != wanted {
        return None;
    }
    let mut document: Value = serde_json::from_slice(&bytes).ok()?;
    if document.get("manifests").is_some() {
        let manifest = platform_manifest(&document, architecture)?;
        let bytes = node.fetch(&format!("{name}@{manifest}"), limits)?;
        if sha256(&bytes) != manifest {
            return None;
        }
        document = serde_json::from_slice(&bytes).ok()?;
    }
    let blob = |entry: &Value| -> Option<(String, u64)> {
        let found = entry
            .get("digest")?
            .as_str()
            .filter(|found| digest(found))?;
        Some((found.to_owned(), entry.get("size")?.as_u64()?))
    };
    let mut blobs = vec![blob(document.get("config")?)?];
    for layer in document.get("layers")?.as_array()? {
        blobs.push(blob(layer)?);
    }
    Some(blobs)
}

/**
Download `images` into the stack's node, one at a time, saying how far it has got to `shown`.

A node that is not this stack's, or whose containerd does not answer, is `Done::Unavailable`: the
CLI pulls, as before. A stopped node is started, as `local start` starts it, because the CLI is
about to start it anyway; if the download then stops, the node is stopped again, so the stack is as
it was and the next attempt starts from the same place.
*/
pub fn download(
    node: &Node,
    images: &CliImages,
    limits: Limits,
    cancelled: &dyn Fn() -> bool,
    shown: &mut dyn FnMut(Download),
) -> Result<Done, Stop> {
    let started_node = match node.running(limits) {
        None => return Ok(Done::Unavailable),
        Some(true) => false,
        Some(false) => {
            if !node.start(limits) {
                return Ok(Done::Unavailable);
            }
            true
        }
    };
    let done = download_into(node, images, limits, cancelled, shown);
    if started_node && done.is_err() {
        node.stop(limits);
    }
    done
}

/// Keeps an image from the kubelet's image garbage collection: containerd's CRI reports an image
/// with this label as pinned, and the kubelet never removes a pinned image (containerd
/// `pkg/cri/labels`, `PinnedImageLabelKey`; kubelet `image_gc_manager.go`).
pub const PINNED: &str = "io.cri-containerd.pinned";

/// The OpenBot release an image was downloaded ahead of, on the images `download_ahead` pinned.
pub const READY_FOR: &str = "ai.copilotkit.openbot.ready-for";

/**
Download `images` into the stack's node ahead of an update, while the back end keeps running, and
keep them there for it: OpenBot Desktop's background download of an announced release
(`update_ready`).

Unlike `download`, it never starts or stops the node. A node that is not running is
`Done::Unavailable`, and the next try finds it running. Each image it downloads is labelled
`PINNED`, because the kubelet removes images no container runs once the node's disk is 85% used,
and these run nothing until the update; and `READY_FOR` the release, so a download for any other
release takes the pin off again (`unpin_ready_for_other`).
*/
pub fn download_ahead(
    node: &Node,
    images: &CliImages,
    release: &str,
    limits: Limits,
    cancelled: &dyn Fn() -> bool,
    shown: &mut dyn FnMut(Download),
) -> Result<Done, Stop> {
    if node.running(limits) != Some(true) {
        return Ok(Done::Unavailable);
    }
    let (done, planned) = download_planned(node, images, limits, cancelled, shown)?;
    let ready_for = format!("{READY_FOR}={release}");
    let pinned = format!("{PINNED}=pinned");
    for reference in &planned {
        let labelled = node
            .exec(
                &["ctr", "images", "label", reference, &pinned, &ready_for],
                limits.call,
                4096,
            )
            .is_some_and(|(ok, _)| ok);
        if !labelled {
            log::warn!("[local images] could not keep a downloaded image for the update");
        }
    }
    Ok(done)
}

/**
How many bytes of `images` the running node does not hold yet; `Some(0)` when it holds them all.
None when the node is not running, or what the images are made of cannot be read.
*/
pub fn missing_bytes(node: &Node, images: &CliImages, limits: Limits) -> Option<u64> {
    if node.running(limits) != Some(true) {
        return None;
    }
    let planned = match plan(node, images, limits, &|| Ok(()), true).ok()? {
        Planned::NothingToDo => return Some(0),
        Planned::Unavailable => return None,
        Planned::Images(planned) => planned,
    };
    let content = node.content(limits)?;
    let progress = Progress::of(&planned);
    Some(
        progress
            .blobs
            .iter()
            .map(|(blob, size)| size - content.held(blob, *size))
            .sum(),
    )
}

/**
Take the pin off every image `download_ahead` kept for a release other than `keep`, so the kubelet
may remove it again once nothing runs it: a release the app has since updated to, or one a newer
release replaced before anybody installed it. How many it unpinned; none from a node that does not
answer.
*/
pub fn unpin_ready_for_other(node: &Node, keep: Option<&str>, limits: Limits) -> usize {
    let listed = |filter: &str| -> Option<HashSet<String>> {
        let (ok, out) = node.exec(&["ctr", "images", "ls", "-q", filter], limits.call, 4 << 20)?;
        ok.then(|| lines(&out).map(str::to_owned).collect())
    };
    let Some(mut ours) = listed(&format!("labels.\"{READY_FOR}\"")) else {
        return 0;
    };
    if let Some(keep) = keep {
        match listed(&format!("labels.\"{READY_FOR}\"=={keep}")) {
            Some(kept) => ours.retain(|reference| !kept.contains(reference)),
            None => return 0,
        }
    }
    let cleared = (format!("{PINNED}="), format!("{READY_FOR}="));
    ours.iter()
        .filter(|reference| {
            node.exec(
                &["ctr", "images", "label", reference, &cleared.0, &cleared.1],
                limits.call,
                4096,
            )
            .is_some_and(|(ok, _)| ok)
        })
        .count()
}

fn download_into(
    node: &Node,
    images: &CliImages,
    limits: Limits,
    cancelled: &dyn Fn() -> bool,
    shown: &mut dyn FnMut(Download),
) -> Result<Done, Stop> {
    download_planned(node, images, limits, cancelled, shown).map(|(done, _)| done)
}

/// `download_into`, with the images it downloaded, by the references it pulled them as.
fn download_planned(
    node: &Node,
    images: &CliImages,
    limits: Limits,
    cancelled: &dyn Fn() -> bool,
    shown: &mut dyn FnMut(Download),
) -> Result<(Done, Vec<String>), Stop> {
    let check = || {
        if cancelled() {
            Err(Stop::Cancelled)
        } else {
            Ok(())
        }
    };
    // Through the mirror from here on, the CLI's later pulls included: they find what this put
    // there. A node where it cannot be written downloads from the registry, as before.
    node.apply_mirror(limits);
    let planned = match plan(node, images, limits, &check, true)? {
        Planned::Unavailable => return Ok((Done::Unavailable, Vec::new())),
        Planned::NothingToDo => return Ok((Done::NothingToDo, Vec::new())),
        Planned::Images(planned) => planned,
    };
    let Some(content) = node.content(limits) else {
        return Ok((Done::Unavailable, Vec::new()));
    };
    let mut progress = Progress::of(&planned);
    progress.observe(&content, shown);
    for (reference, blobs) in &planned {
        pull_one(
            node,
            reference,
            blobs,
            &mut progress,
            limits,
            cancelled,
            shown,
        )?;
    }
    if let Some(content) = node.content(limits) {
        progress.observe(&content, shown);
    }
    Ok((
        Done::Downloaded,
        planned
            .into_iter()
            .map(|(reference, _)| reference)
            .collect(),
    ))
}

/// Each image the CLI will pull, with the blobs it is made of for the node, by digest and size.
type Images = Vec<(String, Vec<(String, u64)>)>;

/// What there is to download into a node.
enum Planned {
    /// The node's containerd, or every image's manifests, could not be read.
    Unavailable,
    /// Every image is already in the node.
    NothingToDo,
    Images(Images),
}

/**
The images `images` names, as the node's containerd will pull them, with their blobs. Read through
the node's own containerd, as the CLI's pull reads them: the runtime images by the digest of the
index their release's tag serves, the rest by the digest the CLI names. `skip_present` leaves out an
image the node already lists. One whose manifests cannot be read is left out, for the CLI to pull.
*/
fn plan(
    node: &Node,
    images: &CliImages,
    limits: Limits,
    check: &dyn Fn() -> Result<(), Stop>,
    skip_present: bool,
) -> Result<Planned, Stop> {
    let (Some(names), Some(architecture)) = (node.image_names(limits), node.architecture(limits))
    else {
        return Ok(Planned::Unavailable);
    };
    check()?;
    let indexes = at_once(&images.tagged, |repository| {
        node.fetch(&format!("{repository}:{}", images.release), limits)
            .map(|index| (format!("{repository}@{}", sha256(&index)), Some(index)))
    });
    let mut wanted: Vec<(String, Option<Vec<u8>>)> = indexes.into_iter().flatten().collect();
    wanted.extend(images.fixed.iter().map(|fixed| (fixed.clone(), None)));
    let mut seen = HashSet::new();
    wanted.retain(|(reference, _)| {
        !(skip_present && names.contains(reference)) && seen.insert(reference.clone())
    });
    if wanted.is_empty() {
        return Ok(Planned::NothingToDo);
    }
    check()?;
    let planned: Vec<_> = at_once(&wanted, |(reference, known)| {
        blobs_of(node, reference, known.clone(), architecture, limits)
            .map(|blobs| (reference.clone(), blobs))
    })
    .into_iter()
    .flatten()
    .collect();
    check()?;
    Ok(if planned.is_empty() {
        Planned::Unavailable
    } else {
        Planned::Images(planned)
    })
}

/// How many image lookups run at once.
///
/// Each is an `exec` into the node and a registry round trip, about a second and a half on Windows
/// with Podman. The pinned CLI's release is 16 images, about 34 lookups, and one after another they
/// held back the first figure for close to a minute of a fresh install's download. Six at once is
/// a few seconds, and few enough not to crowd the CLI's own pulls or the registry's limits.
pub const LOOKUPS_AT_ONCE: usize = 6;

/// `look` for each of `items`, at most `LOOKUPS_AT_ONCE` at a time, the answers in `items`' order.
fn at_once<T: Sync, R: Send>(items: &[T], look: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let answers: Mutex<Vec<Option<R>>> = Mutex::new((0..items.len()).map(|_| None).collect());
    std::thread::scope(|scope| {
        for _ in 0..LOOKUPS_AT_ONCE.min(items.len()) {
            scope.spawn(|| loop {
                let at = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let Some(item) = items.get(at) else {
                    return;
                };
                let answer = look(item);
                answers.lock().unwrap_or_else(|p| p.into_inner())[at] = Some(answer);
            });
        }
    });
    answers
        .into_inner()
        .unwrap_or_else(|p| p.into_inner())
        .into_iter()
        .map(|answer| answer.expect("every item was looked at"))
        .collect()
}

/// How long the last figure stays on the row once everything has arrived: long enough for the
/// window, which asks every second, to show the whole download before the row moves on.
pub const SHOWN_WHOLE: Duration = Duration::from_secs(4);

/**
Follow the CLI's own pull into the node of a stack it is creating, and say how far it has got.

A FIRST SETUP CANNOT BE DOWNLOADED FOR FIRST. `local setup` creates the stack's k3d node itself
(Intelligence `apps/cli/src/services/local-install.ts`, `createLocalCluster`) and starts pulling into
it seconds later, so there is no node to download into before the CLI's pulls begin. What can be
done is what the person needs: say how much of the download has arrived. So this waits for a node
that was not there when the setup began (`before`, from `stack_nodes`), confirms it by the label the
CLI gives it, plans the release's images as `download` does, and reports what containerd holds of
them until all of it has arrived or `cancelled`. It pulls nothing and changes nothing in the node.
The node is new, so everything in it arrived during this setup: nothing is left out as present.
*/
pub fn follow_new_stack(
    engine: &(dyn Fn() -> Command + Sync),
    images: &CliImages,
    before: &HashSet<String>,
    limits: Limits,
    cancelled: &dyn Fn() -> bool,
    shown: &mut dyn FnMut(Download),
) {
    let check = || {
        if cancelled() {
            Err(Stop::Cancelled)
        } else {
            Ok(())
        }
    };
    let wait = |for_how_long: Duration| {
        let until = Instant::now() + for_how_long;
        while Instant::now() < until && !cancelled() {
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    // The new stack's node, once its containerd answers.
    let stack = loop {
        if cancelled() {
            return;
        }
        let found = stack_nodes(engine, limits)
            .unwrap_or_default()
            .into_iter()
            .filter(|stack| !before.contains(stack))
            .find(|stack| {
                let node = Node::for_stack(engine, stack);
                node.running(limits) == Some(true) && node.image_names(limits).is_some()
            });
        if let Some(stack) = found {
            break stack;
        }
        wait(limits.poll);
    };
    let node = Node::for_stack(engine, &stack);
    let planned = loop {
        match plan(&node, images, limits, &check, false) {
            Ok(Planned::Images(planned)) => break planned,
            Ok(Planned::NothingToDo) | Err(_) => return,
            // The node's containerd may not reach the registry yet: ask again.
            Ok(Planned::Unavailable) => wait(limits.poll),
        }
        if cancelled() {
            return;
        }
    };
    let mut progress = Progress::of(&planned);
    while !cancelled() {
        if let Some(content) = node.content(limits) {
            progress.observe(&content, shown);
            if progress.best >= progress.total {
                // Whole: said for a moment, so the row shows 100% before it moves on.
                wait(SHOWN_WHOLE);
                return;
            }
        }
        wait(limits.poll);
    }
}

/// The stacks whose k3d node is on the engine now, by the name k3d gives it: `k3d-<stack>-server-0`.
/// None when the engine does not answer.
pub fn stack_nodes(
    engine: &(dyn Fn() -> Command + Sync),
    limits: Limits,
) -> Option<HashSet<String>> {
    let probe = Node {
        engine,
        stack: String::new(),
        name: String::new(),
        mirror: Mirror::standard(),
    };
    let (ok, out) = probe.run(
        &[
            "ps",
            "-a",
            "--filter",
            "name=k3d-",
            "--format",
            "{{.Names}}",
        ],
        limits.call,
        1 << 20,
    )?;
    ok.then(|| {
        lines(&out)
            .filter_map(|name| name.strip_prefix("k3d-")?.strip_suffix("-server-0"))
            .map(str::to_owned)
            .collect()
    })
}

/// The blobs the download is for, and when a new byte of them last arrived.
struct Progress {
    blobs: BTreeMap<String, u64>,
    total: u64,
    best: u64,
    last_new: Instant,
}

impl Progress {
    /// The images being downloaded, whole, shared layers once: what containerd already holds of
    /// them, from an earlier attempt or another image, has arrived. A resumed download goes on
    /// from the figure the stopped one reached.
    fn of(planned: &Images) -> Self {
        let mut blobs: BTreeMap<String, u64> = BTreeMap::new();
        for (_, image) in planned {
            for (blob, size) in image {
                blobs.insert(blob.clone(), *size);
            }
        }
        Self {
            total: blobs.values().sum(),
            blobs,
            best: 0,
            last_new: Instant::now(),
        }
    }

    /// Count what containerd holds. Only more than ever before is progress; it is all that is said.
    fn observe(&mut self, content: &Content, shown: &mut dyn FnMut(Download)) {
        let done = self
            .blobs
            .iter()
            .map(|(blob, size)| content.held(blob, *size))
            .sum::<u64>();
        if done > self.best {
            self.best = done;
            self.last_new = Instant::now();
        }
        shown(Download {
            done: self.best,
            total: self.total,
        });
    }
}

/// One image, pulled again from where it got to for as long as bytes keep arriving.
fn pull_one(
    node: &Node,
    reference: &str,
    blobs: &[(String, u64)],
    progress: &mut Progress,
    limits: Limits,
    cancelled: &dyn Fn() -> bool,
    shown: &mut dyn FnMut(Download),
) -> Result<(), Stop> {
    let started = Instant::now();
    progress.last_new = Instant::now();
    let mut failures: u32 = 0;
    loop {
        let mut pull = node.pull(reference);
        let mut arrived = false;
        let mut next_look = Instant::now();
        loop {
            if cancelled() {
                if let Some(pull) = pull {
                    pull.stop(node, limits);
                }
                return Err(Stop::Cancelled);
            }
            let finished = match pull.as_mut() {
                Some(running) => running.finished(),
                None => Some(false),
            };
            if Instant::now() >= next_look || finished.is_some() {
                next_look = Instant::now() + limits.poll;
                if let Some(content) = node.content(limits) {
                    progress.observe(&content, shown);
                    // Every blob in: what is left is unpacking, which brings no bytes.
                    arrived = blobs.iter().all(|(blob, _)| content.present.contains(blob));
                }
            }
            if let Some(succeeded) = finished {
                if succeeded {
                    return Ok(());
                }
                break;
            }
            let stop = if started.elapsed() >= limits.image {
                Some(Stop::TooLong)
            } else if !arrived && progress.last_new.elapsed() >= limits.stall {
                Some(Stop::Stalled)
            } else {
                None
            };
            if let Some(stop) = stop {
                if let Some(pull) = pull.take() {
                    pull.stop(node, limits);
                }
                return Err(stop);
            }
            std::thread::sleep(Duration::from_millis(50).min(limits.poll));
        }
        // The pull failed: the connection dropped, or the registry did not answer. Wait a little
        // and pull again from what it fetched, until the stall rule says the line has gone.
        failures += 1;
        let pause = Duration::from_secs(1u64 << failures.min(5)).min(limits.stall);
        let until = Instant::now() + pause;
        while Instant::now() < until {
            if cancelled() {
                return Err(Stop::Cancelled);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if started.elapsed() >= limits.image {
            return Err(Stop::TooLong);
        }
        if progress.last_new.elapsed() >= limits.stall {
            return Err(Stop::Stalled);
        }
    }
}

/// How far each running download has got, by the attempt that started it.
static SHOWN: Mutex<Vec<(String, Download)>> = Mutex::new(Vec::new());

fn shown_downloads() -> std::sync::MutexGuard<'static, Vec<(String, Download)>> {
    SHOWN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// How far the download for `attempt` has got, while it runs.
pub fn downloading(attempt: &str) -> Option<Download> {
    shown_downloads()
        .iter()
        .find(|(id, _)| id == attempt)
        .map(|(_, download)| *download)
}

/// An attempt's place in `SHOWN`, removed however its download ends.
pub struct Showing(String);

impl Showing {
    pub fn new(attempt: &str) -> Self {
        Self(attempt.to_owned())
    }

    pub fn show(&self, download: Download) {
        let mut shown = shown_downloads();
        shown.retain(|(id, _)| id != &self.0);
        shown.push((self.0.clone(), download));
    }
}

impl Drop for Showing {
    fn drop(&mut self) {
        shown_downloads().retain(|(id, _)| id != &self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLI_48A3863: &str = include_str!("../test-fixtures/local-images/cli-48a3863-excerpt.txt");

    #[test]
    fn reads_what_the_pinned_cli_pulls_from_its_own_bytes() {
        let images = cli_images(CLI_48A3863).expect("the pinned CLI's images");
        assert_eq!(images.release, "0.16.0-rc.9");
        assert_eq!(
            images.tagged,
            [
                "ghcr.io/copilotkit/intelligence/app-api",
                "ghcr.io/copilotkit/intelligence/app-frontend",
                "ghcr.io/copilotkit/intelligence/db-migrations",
                "ghcr.io/copilotkit/intelligence/postgres-pgvector",
                "ghcr.io/copilotkit/intelligence/realtime-gateway",
            ]
        );
        // The inventory less k3s and k3d's own images, which k3d pulls through the engine, then
        // the Kubernetes system images.
        assert_eq!(
            images.fixed,
            [
                "ghcr.io/copilotkit/intelligence/local-object-storage@sha256:1c2a56bcd21e6ef33b77ddefec998ba09b026c339af1c2827d312ee3df7b7280",
                "ghcr.io/copilotkit/intelligence/local-object-storage-init@sha256:1c2a56bcd21e6ef33b77ddefec998ba09b026c339af1c2827d312ee3df7b7280",
                "docker.io/bitnamilegacy/redis@sha256:a25b5d07a14ec13730022c7cd9bab6308d55ccd86b74af7315553c17be884889",
                "docker.io/rancher/klipper-helm@sha256:73ff7ef399717ba8339559054557bd427bdafb47db112165a8c0c358d1ca0283",
                "docker.io/rancher/klipper-lb@sha256:dd380f5d89a52f2a07853ff17a6048f805c1f8113b50578f3efc3efb9bcf670a",
                "docker.io/rancher/local-path-provisioner@sha256:9b914881170048f80ae9302f36e5b99b4a6b18af73a38adc1c66d12f65d360be",
                "docker.io/rancher/mirrored-coredns-coredns@sha256:82979ddf442c593027a57239ad90616deb874e90c365d1a96ad508c2104bdea5",
                "docker.io/rancher/mirrored-library-busybox@sha256:8a45424ddf949bbe9bb3231b05f9032a45da5cd036eb4867b511b00734756d6f",
                "docker.io/rancher/mirrored-library-traefik@sha256:25df7bff0b414867f16a74c571c0dc84920404e45cc7780976cec77809230e09",
                "docker.io/rancher/mirrored-metrics-server@sha256:dccf8474fb910fef261d31d9483d7e4c1df7b86cf4d638fb6a7d7c88bd51600a",
                "docker.io/rancher/mirrored-pause@sha256:74c4244427b7312c5b901fe0f67cbc53683d06f4f24c6faee65d4182bf0fa893",
            ]
        );
    }

    #[test]
    fn a_cli_that_says_any_part_differently_is_not_guessed_for() {
        for line in [
            "const pinnedVersion = false ? \"\" : \"0.16.0-rc.9\";",
            "define_CLI_LOCAL_EVALUATION_SUPPORT_default = {",
            ".filter(([name]) => !",
            "runtimeServices = {",
            "const repository = `ghcr.io/copilotkit/intelligence/${service}`;",
        ] {
            let changed = CLI_48A3863.replace(line, "");
            assert_eq!(cli_images(&changed), None, "without {line}");
        }
        // A CLI that takes Helm's newest release names none, so its images are not known here.
        let unpinned = CLI_48A3863.replace(
            "const pinnedVersion = false ? \"\" : \"0.16.0-rc.9\";",
            "const pinnedVersion = true ? \"\" : \"\";",
        );
        assert_eq!(cli_images(&unpinned), None);
    }

    #[test]
    fn the_mirror_files_are_what_k3d_and_k3s_wrote_into_a_real_node() {
        // Given to the pinned k3d v5.8.3 as K3D_REGISTRIES_CONFIG, then read back from the node
        // k3s v1.31.5 started: its /etc/rancher/k3s/registries.yaml took this mirror, and the
        // hosts.toml it wrote for ghcr.io was exactly this.
        let mirror = Mirror::standard();
        assert_eq!(
            mirror.registries_yaml(),
            "mirrors:\n  \"ghcr.io\":\n    endpoint:\n      - \"https://downloads.copilotkit.ai\"\n  \"docker.io\":\n    endpoint:\n      - \"https://downloads.copilotkit.ai/v2/docker.io\"\n"
        );
        let [(ghcr, at_root), (hub, under_path)] = mirror.registries.as_slice() else {
            panic!("two registries");
        };
        assert_eq!(
            Mirror::hosts_toml(ghcr, at_root),
            "# File generated by k3s. DO NOT EDIT.\n\nserver = \"https://ghcr.io/v2\"\ncapabilities = [\"pull\", \"resolve\", \"push\"]\n\n\n[host]\n[host.\"https://downloads.copilotkit.ai/v2\"]\n  capabilities = [\"pull\", \"resolve\"]\n"
        );
        assert_eq!(
            Mirror::hosts_toml(hub, under_path),
            "# File generated by k3s. DO NOT EDIT.\n\nserver = \"https://registry-1.docker.io/v2\"\ncapabilities = [\"pull\", \"resolve\", \"push\"]\n\n\n[host]\n[host.\"https://downloads.copilotkit.ai/v2/docker.io\"]\n  capabilities = [\"pull\", \"resolve\"]\n  override_path = true\n"
        );
    }

    #[test]
    fn reads_the_ingests_ctr_content_active_printed() {
        // Captured from k3s v1.32 (containerd v1.7.23-k3s2) after a `ctr images pull` was killed.
        let active = active_ingests(include_str!(
            "../test-fixtures/local-images/ctr-content-active.txt"
        ));
        assert_eq!(
            active,
            HashMap::from([
                (
                    "sha256:298bd28457cc53348790e429307e4c23baa2b2d1162f32164825847bbbe24a69"
                        .to_owned(),
                    14_680_000
                ),
                (
                    "sha256:fc7bec41f6cde1885356600444c5f8e5c10a2e35373dccebc5e4685d2fd91406"
                        .to_owned(),
                    14_680_000
                ),
            ])
        );
        assert_eq!(human_size("122.7kB"), Some(122_700));
        assert_eq!(human_size("75B"), Some(75));
    }

    #[test]
    fn reads_a_fresh_node_whose_store_lists_nothing() {
        // `ctr content ls -q` on a new node prints nothing, so the separator comes first.
        let fresh = Content::parse("-----\nREF\t\t\t\t\t\t\t\t\t\tSIZE\tAGE\t\t\n").unwrap();
        assert_eq!(fresh, Content::default());
        let listed = Content::parse(&format!(
            "sha256:{}\n-----\n{}",
            "1".repeat(64),
            include_str!("../test-fixtures/local-images/ctr-content-active.txt")
        ))
        .unwrap();
        assert_eq!(listed.present.len(), 1);
        assert_eq!(listed.active.len(), 2);
    }

    #[test]
    fn picks_the_manifest_for_the_node_from_a_real_release_index() {
        // ghcr.io/copilotkit/intelligence/app-api:0.16.0-rc.9, as ghcr.io served it.
        let bytes = include_bytes!("../test-fixtures/local-images/app-api-0.16.0-rc.9-index.raw");
        assert_eq!(
            sha256(bytes),
            "sha256:9ee3006d92a656a72be43f9bda0e0738aec910f3b8098aba8e029f28061e85b7"
        );
        let index: Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(
            platform_manifest(&index, "arm64").as_deref(),
            Some("sha256:7a586c51e16004343d7dbab513da2e12cf727fe022f75e5a9b8b36f1eb3c3b8f")
        );
        assert_eq!(
            platform_manifest(&index, "amd64").as_deref(),
            Some("sha256:3a68d8567335f56c168c36b53059c5dd4dfe23c2edbf4d9251e9ed3170dfacd8")
        );
        assert_eq!(platform_manifest(&index, "riscv64"), None);
    }

    /**
    An engine whose every call into the node takes as long as `delay` says, as `podman exec` into a
    k3d node and a registry round trip take on Windows. It answers with real bytes: the
    `app-api:0.16.0-rc.9` index for any tag or index digest, that index's linux/arm64 manifest for
    its digest, and a `ctr content active` captured during that image's pull.
    */
    const SLOW_ENGINE: &str = r#"
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let read = |name: &str| std::fs::read(dir.join(name)).unwrap();
    let delay: u64 = String::from_utf8(read("delay")).unwrap().trim().parse().unwrap();
    let stack = String::from_utf8(read("stack")).unwrap().trim().to_owned();
    let out = |bytes: &[u8]| { use std::io::Write; std::io::stdout().write_all(bytes).unwrap(); };
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    match a.as_slice() {
        ["ps", ..] => out(format!("k3d-{stack}-server-0\n").as_bytes()),
        ["inspect", ..] => out(format!("true {stack}\n").as_bytes()),
        ["exec", _, rest @ ..] => {
            std::thread::sleep(std::time::Duration::from_millis(delay));
            match rest {
                ["ctr", "images", "ls", "-q"] => {}
                ["uname", "-m"] => out(b"aarch64\n"),
                ["ctr", "content", "fetch-object", "--hosts-dir", _, reference] => {
                    if reference.ends_with(&String::from_utf8(read("manifest-digest")).unwrap().trim().to_owned()) {
                        out(&read("manifest"));
                    } else {
                        out(&read("index"));
                    }
                }
                ["sh", "-c", _] => { out(b"-----\n"); out(&read("active")); }
                _ => std::process::exit(2),
            }
        }
        _ => std::process::exit(2),
    }
}
"#;

    /**
    The Windows fresh install: the back end's card did not appear until about 480 of 605 MB had
    arrived. Before saying anything, the release's 16 images were looked up one after another,
    about 34 calls into the node at a second and a half each. Here each call takes a second: one
    after another that is over 36 seconds before the first figure, and at `LOOKUPS_AT_ONCE` about
    eleven. The first figure is the whole release's size, with what the captured ingests hold.
    */
    #[test]
    fn a_first_setups_download_is_shown_within_seconds_of_its_node_appearing() {
        let root = crate::test_support::temp_root("slow-engine");
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("engine.rs");
        std::fs::write(&source, SLOW_ENGINE).unwrap();
        let engine_binary = root.join(format!("engine{}", std::env::consts::EXE_SUFFIX));
        crate::test_support::compile_fixture(&source, &engine_binary);
        let fixtures = concat!(env!("CARGO_MANIFEST_DIR"), "/test-fixtures/local-images/");
        let copy = |from: &str, to: &str| {
            std::fs::copy(format!("{fixtures}{from}"), root.join(to)).unwrap();
        };
        copy("app-api-0.16.0-rc.9-index.raw", "index");
        copy("app-api-0.16.0-rc.9-linux-arm64.raw", "manifest");
        copy("ctr-content-active.txt", "active");
        let manifest_digest =
            "sha256:7a586c51e16004343d7dbab513da2e12cf727fe022f75e5a9b8b36f1eb3c3b8f";
        std::fs::write(root.join("manifest-digest"), manifest_digest).unwrap();
        std::fs::write(root.join("delay"), "1000").unwrap();
        std::fs::write(root.join("stack"), "local-fresh").unwrap();
        // The pinned CLI's release: five images at its tag, eleven by digest.
        let index_digest =
            "sha256:9ee3006d92a656a72be43f9bda0e0738aec910f3b8098aba8e029f28061e85b7";
        let images = CliImages {
            release: "0.16.0-rc.9".into(),
            tagged: (0..5)
                .map(|n| format!("ghcr.io/copilotkit/intelligence/service-{n}"))
                .collect(),
            fixed: (0..11)
                .map(|n| format!("docker.io/example/fixed-{n}@{index_digest}"))
                .collect(),
        };
        let engine = || crate::quiet::command(&engine_binary);
        let limits = Limits {
            stall: Duration::from_secs(60),
            image: Duration::from_secs(60),
            poll: Duration::from_millis(100),
            call: Duration::from_secs(30),
        };
        let started = Instant::now();
        let give_up = started + Duration::from_secs(25);
        let mut first: Option<(Duration, Download)> = None;
        let shown = std::sync::atomic::AtomicBool::new(false);
        follow_new_stack(
            &engine,
            &images,
            &HashSet::new(),
            limits,
            &|| shown.load(std::sync::atomic::Ordering::SeqCst) || Instant::now() >= give_up,
            &mut |download| {
                first.get_or_insert((started.elapsed(), download));
                shown.store(true, std::sync::atomic::Ordering::SeqCst);
            },
        );
        let _ = std::fs::remove_dir_all(&root);
        let (after, download) = first.expect("a figure was shown");
        assert!(
            after < Duration::from_secs(20),
            "first figure after {after:?}"
        );
        // The image's config and twelve layers, once however many images share them.
        let manifest: Value = serde_json::from_slice(
            &std::fs::read(format!("{fixtures}app-api-0.16.0-rc.9-linux-arm64.raw")).unwrap(),
        )
        .unwrap();
        let whole: u64 = manifest["config"]["size"].as_u64().unwrap()
            + manifest["layers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|layer| layer["size"].as_u64().unwrap())
                .sum::<u64>();
        assert_eq!(download.total, whole);
        // The two layers the captured ingests were part way through: 14.68 MB each so far.
        assert_eq!(download.done, 2 * 14_680_000);
    }
}

/**
Downloads against a real containerd: the k3s image the pinned CLI creates its node from, a registry
on the node's loopback, and an nginx in front of it that sends at most `limit_rate` per connection.
containerd talks plain HTTP to a registry on loopback, as it talks HTTPS to ghcr.io; `ctr` is the
node's own. A stall is the proxy paused; an interruption is the pull stopped by its process id.

Run with `cargo test --lib local_images::live -- --ignored --test-threads=1` where Docker runs
privileged containers.
*/
#[cfg(test)]
pub(crate) mod live {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// The k3s image the pinned CLI's built-in inventory names (`images.k3s`).
    const K3S: &str = "docker.io/rancher/k3s@sha256:53cf744fe2fabf140cee240d2db70d13a4f2d98f1a13c98f58f457f423096917";
    const REGISTRY: &str = "docker.io/library/registry:2";
    const NGINX: &str = "docker.io/library/nginx:1.31.6-alpine";

    /// Live tests share Docker. One lab at a time keeps them from competing for its bandwidth.
    static ONE_LAB: Mutex<()> = Mutex::new(());
    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn docker(args: &[&str]) -> (bool, String) {
        let output = Command::new("docker")
            .args(args)
            .stdin(Stdio::null())
            .output()
            .expect("docker should run");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
        )
    }

    fn engine() -> Command {
        Command::new("docker")
    }

    pub(crate) fn test_limits() -> Limits {
        Limits {
            stall: Duration::from_secs(8),
            image: Duration::from_secs(300),
            poll: Duration::from_millis(250),
            call: Duration::from_secs(60),
        }
    }

    /// A k3d-shaped node, a registry and a throttling proxy, removed when dropped.
    pub(crate) struct Lab {
        _one: std::sync::MutexGuard<'static, ()>,
        pub(crate) stack: String,
        pub(crate) node: String,
        registry: String,
        proxy: String,
        port: String,
        architecture: String,
        /// Every blob and manifest pushed, by its path under the registry's root and with the
        /// media type it was pushed as, for a mirror to hold.
        pushed: Mutex<Vec<(String, Vec<u8>, String)>>,
    }

    impl Lab {
        /// `rate` is nginx's `limit_rate`: what one connection may send per second.
        pub(crate) fn new(rate: &str) -> Self {
            let one = ONE_LAB
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let stack = format!("openbot-image-test-{}-{n}", std::process::id());
            let node = format!("k3d-{stack}-server-0");
            let registry = format!("{stack}-registry");
            let proxy = format!("{stack}-proxy");
            let label = format!("copilotkit.local-stack={stack}");
            let mut lab = Self {
                _one: one,
                stack,
                node,
                registry,
                proxy,
                port: String::new(),
                architecture: String::new(),
                pushed: Mutex::new(Vec::new()),
            };
            // The registry holds the network the node and the proxy join, so the node can be
            // stopped and started again without taking the registry's loopback with it.
            assert!(
                docker(&[
                    "run",
                    "-d",
                    "--name",
                    &lab.registry,
                    "-p",
                    "127.0.0.1::5000",
                    "-e",
                    "REGISTRY_HTTP_ADDR=127.0.0.1:5001",
                    REGISTRY,
                ])
                .0
            );
            let netns = format!("container:{}", lab.registry);
            let (started, _) = docker(&[
                "run",
                "-d",
                "--privileged",
                "--name",
                &lab.node,
                "--label",
                &label,
                "--network",
                &netns,
                "--tmpfs",
                "/run",
                "--tmpfs",
                "/var/run",
                K3S,
                "server",
                "--disable=traefik,servicelb,metrics-server,local-storage,coredns",
                "--disable-network-policy",
            ]);
            assert!(started, "the k3s node should start");
            let conf = format!(
                "events {{}}\nhttp {{\n  log_format pulls '$request_method $uri $status $body_bytes_sent range=\"$http_range\"';\n  access_log /dev/stdout pulls;\n  server {{\n    listen 5000;\n    client_max_body_size 0;\n    location / {{\n      proxy_pass http://127.0.0.1:5001;\n      proxy_set_header Host $http_host;\n      proxy_read_timeout 3600s;\n      send_timeout 3600s;\n      limit_rate {rate};\n    }}\n  }}\n}}\n"
            );
            let conf_env = format!("CONF={conf}");
            assert!(
                docker(&[
                    "run",
                    "-d",
                    "--name",
                    &lab.proxy,
                    "--network",
                    &netns,
                    "-e",
                    &conf_env,
                    NGINX,
                    "sh",
                    "-c",
                    "printf '%s' \"$CONF\" > /etc/nginx/nginx.conf && exec nginx -g 'daemon off;'",
                ])
                .0
            );
            lab.port = docker(&["port", &lab.registry, "5000/tcp"])
                .1
                .lines()
                .next()
                .and_then(|line| line.rsplit(':').next())
                .expect("the proxy's published port")
                .trim()
                .to_owned();
            let until = Instant::now() + Duration::from_secs(120);
            loop {
                let containerd = docker(&["exec", &lab.node, "ctr", "images", "ls", "-q"]).0;
                let registry = reqwest::blocking::get(lab.url("/v2/"))
                    .is_ok_and(|answer| answer.status().is_success());
                if containerd && registry {
                    break;
                }
                assert!(Instant::now() < until, "the lab did not come up");
                std::thread::sleep(Duration::from_millis(500));
            }
            let arch = docker(&["exec", &lab.node, "uname", "-m"]).1;
            lab.architecture = if arch.trim() == "aarch64" {
                "arm64"
            } else {
                "amd64"
            }
            .into();
            lab
        }

        fn url(&self, path: &str) -> String {
            format!("http://127.0.0.1:{}{path}", self.port)
        }

        /// Push an image of random layers of these sizes, as an index with one platform, and give
        /// the reference the node pulls it by: `127.0.0.1:5000/<repository>@<index digest>`.
        pub(crate) fn push(&self, repository: &str, tag: &str, layers: &[usize]) -> String {
            use rand::RngCore;
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(120))
                .build()
                .unwrap();
            let upload = |bytes: &[u8]| -> (String, usize) {
                let blob = sha256(bytes);
                let started = client
                    .post(self.url(&format!("/v2/{repository}/blobs/uploads/")))
                    .send()
                    .unwrap();
                assert_eq!(started.status().as_u16(), 202);
                let location = started.headers()["location"].to_str().unwrap().to_owned();
                let location = if location.starts_with("http") {
                    location
                } else {
                    self.url(&location)
                };
                let separator = if location.contains('?') { '&' } else { '?' };
                let put = client
                    .put(format!("{location}{separator}digest={blob}"))
                    .body(bytes.to_vec())
                    .send()
                    .unwrap();
                assert_eq!(put.status().as_u16(), 201, "blob upload");
                self.pushed.lock().unwrap().push((
                    format!("v2/{repository}/blobs/{blob}"),
                    bytes.to_vec(),
                    "application/octet-stream".into(),
                ));
                (blob, bytes.len())
            };
            let mut diff_ids = Vec::new();
            let mut described = Vec::new();
            for (index, size) in layers.iter().enumerate() {
                let mut data = vec![0u8; *size];
                rand::rng().fill_bytes(&mut data);
                let mut archive = tar::Builder::new(Vec::new());
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                archive
                    .append_data(&mut header, format!("data-{index}.bin"), data.as_slice())
                    .unwrap();
                let tarball = archive.into_inner().unwrap();
                diff_ids.push(sha256(&tarball));
                // Random bytes do not compress; stored blocks keep the gzip as large as its data.
                let mut gzip =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::none());
                std::io::Write::write_all(&mut gzip, &tarball).unwrap();
                let (blob, size) = upload(&gzip.finish().unwrap());
                described.push(serde_json::json!({
                    "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                    "digest": blob, "size": size,
                }));
            }
            let config = serde_json::to_vec(&serde_json::json!({
                "architecture": self.architecture, "os": "linux", "config": {},
                "rootfs": { "type": "layers", "diff_ids": diff_ids },
            }))
            .unwrap();
            let (config_digest, config_size) = upload(&config);
            let manifest = serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": {
                    "mediaType": "application/vnd.oci.image.config.v1+json",
                    "digest": config_digest, "size": config_size,
                },
                "layers": described,
            }))
            .unwrap();
            let put = |reference: &str, kind: &str, bytes: &[u8]| {
                let answer = client
                    .put(self.url(&format!("/v2/{repository}/manifests/{reference}")))
                    .header("content-type", kind)
                    .body(bytes.to_vec())
                    .send()
                    .unwrap();
                assert_eq!(answer.status().as_u16(), 201, "manifest upload");
                self.pushed.lock().unwrap().push((
                    format!("v2/{repository}/manifests/{reference}"),
                    bytes.to_vec(),
                    kind.into(),
                ));
            };
            let manifest_digest = sha256(&manifest);
            put(
                &manifest_digest,
                "application/vnd.oci.image.manifest.v1+json",
                &manifest,
            );
            let index = serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "manifests": [{
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": manifest_digest, "size": manifest.len(),
                    "platform": { "architecture": self.architecture, "os": "linux" },
                }],
            }))
            .unwrap();
            let index_digest = sha256(&index);
            put(
                &index_digest,
                "application/vnd.oci.image.index.v1+json",
                &index,
            );
            put(tag, "application/vnd.oci.image.index.v1+json", &index);
            format!("127.0.0.1:5000/{repository}@{index_digest}")
        }

        pub(crate) fn node(&self) -> Node<'static> {
            Node::for_stack(&engine, &self.stack)
        }

        /// The address of the network the node, the registry and the proxy share, on the engine's
        /// bridge: the proxy answers on its port 5000.
        pub(crate) fn bridge_address(&self) -> String {
            docker(&[
                "inspect",
                "--format",
                "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
                &self.registry,
            ])
            .1
            .trim()
            .to_owned()
        }

        /// The node stopped, as Quit leaves a stack, or whether it is running.
        pub(crate) fn stop_node(&self) {
            assert!(docker(&["stop", &self.node]).0);
        }

        pub(crate) fn node_running(&self) -> bool {
            docker(&["inspect", "--format", "{{.State.Running}}", &self.node])
                .1
                .trim()
                == "true"
        }

        pub(crate) fn pause_proxy(&self, paused: bool) {
            let verb = if paused { "pause" } else { "unpause" };
            assert!(docker(&[verb, &self.proxy]).0);
        }

        /// The proxy's access log: method, path, status, bytes sent and the range asked for.
        pub(crate) fn requests(&self) -> Vec<String> {
            let output = Command::new("docker")
                .args(["logs", &self.proxy])
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter(|line| line.starts_with("GET ") || line.starts_with("HEAD "))
                .map(str::to_owned)
                .collect()
        }

        pub(crate) fn images(&self) -> HashSet<String> {
            self.node().image_names(test_limits()).unwrap()
        }

        pub(crate) fn content(&self) -> Content {
            self.node().content(test_limits()).unwrap()
        }

        /// Whether any `ctr` is still running in the node.
        pub(crate) fn ctr_running(&self) -> bool {
            docker(&["exec", &self.node, "ps"]).1.lines().any(|line| {
                line.split_whitespace()
                    .nth(2)
                    .is_some_and(|c| c.ends_with("ctr"))
            })
        }
    }

    impl Drop for Lab {
        fn drop(&mut self) {
            for name in [&self.proxy, &self.node, &self.registry] {
                let _ = docker(&["rm", "-f", "-v", name]);
            }
        }
    }

    /**
    A stand-in for `https://downloads.copilotkit.ai`, as faithful to S3 behind CloudFront as plain
    nginx gets: static files in a v2 tree at the root, each manifest served with the media type it
    was stored with, blobs as octet streams, no `Docker-Content-Digest`, query strings ignored, and
    403 for a key it does not hold. On the node's loopback, port 5002, beside the lab's registry.
    */
    pub(crate) struct StaticMirror {
        name: String,
    }

    impl StaticMirror {
        /// A mirror holding everything pushed to `lab` so far, the repositories in `hub` under
        /// `v2/docker.io/` as Docker Hub's images are held.
        pub(crate) fn of(lab: &Lab, hub: &[&str]) -> Self {
            let name = format!("{}-mirror", lab.stack);
            let netns = format!("container:{}", lab.registry);
            assert!(docker(&["create", "--name", &name, "--network", &netns, NGINX]).0);
            let mirror = Self { name };
            let pushed = lab.pushed.lock().unwrap();
            let mut types = String::new();
            let mut archive = tar::Builder::new(Vec::new());
            for (path, bytes, kind) in pushed.iter() {
                let path = match hub
                    .iter()
                    .find(|repository| path.starts_with(&format!("v2/{repository}/")))
                {
                    Some(_) => path.replacen("v2/", "v2/docker.io/", 1),
                    None => path.clone(),
                };
                if path.contains("/manifests/") {
                    types.push_str(&format!(
                        "    location = /{path} {{ default_type {kind}; try_files $uri =403; }}\n"
                    ));
                }
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                archive
                    .append_data(&mut header, format!("srv/{path}"), bytes.as_slice())
                    .unwrap();
            }
            let conf = format!(
                "events {{}}\nhttp {{\n  log_format pulls '$request_method $uri $status $body_bytes_sent range=\"$http_range\"';\n  access_log /dev/stdout pulls;\n  types {{}}\n  default_type application/octet-stream;\n  server {{\n    listen 127.0.0.1:5002;\n    root /srv;\n    location = /v2/ {{ default_type application/json; return 200 '{{}}'; }}\n    location / {{ try_files $uri =403; }}\n{types}  }}\n}}\n"
            );
            let mut header = tar::Header::new_gnu();
            header.set_size(conf.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            archive
                .append_data(&mut header, "etc/nginx/nginx.conf", conf.as_bytes())
                .unwrap();
            let tarball = archive.into_inner().unwrap();
            let mut copy = Command::new("docker")
                .args(["cp", "-", &format!("{}:/", mirror.name)])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .unwrap();
            std::io::Write::write_all(&mut copy.stdin.take().unwrap(), &tarball).unwrap();
            assert!(copy.wait().unwrap().success());
            assert!(docker(&["start", &mirror.name]).0);
            let until = Instant::now() + Duration::from_secs(30);
            let ping = [
                "exec",
                &mirror.name,
                "wget",
                "-q",
                "-O-",
                "http://127.0.0.1:5002/v2/",
            ];
            while !docker(&ping).0 {
                assert!(Instant::now() < until, "the mirror did not come up");
                std::thread::sleep(Duration::from_millis(200));
            }
            mirror
        }

        /// The lab's registry, pulled through this mirror first.
        pub(crate) fn mirror() -> Mirror {
            Mirror {
                registries: vec![
                    ("127.0.0.1:5000".into(), "http://127.0.0.1:5002".into()),
                    (
                        "docker.io".into(),
                        "http://127.0.0.1:5002/v2/docker.io".into(),
                    ),
                ],
            }
        }

        /// The mirror's access log, in the proxy's format.
        pub(crate) fn requests(&self) -> Vec<String> {
            let output = Command::new("docker")
                .args(["logs", &self.name])
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter(|line| line.starts_with("GET ") || line.starts_with("HEAD "))
                .map(str::to_owned)
                .collect()
        }
    }

    impl Drop for StaticMirror {
        fn drop(&mut self) {
            let _ = docker(&["rm", "-f", "-v", &self.name]);
        }
    }

    /**
    The reason for the mirror: ghcr.io can crawl, or not answer at all. With the registry the
    images are named for stopped dead (its proxy paused, so a connection to it hangs), the download
    is served whole by the mirror, and the image is stored under the registry's name, where the
    CLI's own pull and Kubernetes look for it. The mirror is still in the node's configuration
    after the node restarts, because k3s writes it again from the registries file.
    */
    #[test]
    #[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
    fn the_download_comes_from_the_mirror_while_the_registry_does_not_answer() {
        let lab = Lab::new("2m");
        let image = lab.push("test/mirrored", "1", &[3_000_000]);
        let (layer, size) = layer_of(&lab, &image);
        // An official Docker Hub image, by the name containerd gives it, and Docker Hub itself
        // refusing every connection from the node.
        let pushed_hub = lab.push("library/mirrored-hub", "1", &[1_000_000]);
        let (hub_layer, hub_size) = layer_of(&lab, &pushed_hub);
        let hub = pushed_hub.replacen("127.0.0.1:5000/", "docker.io/", 1);
        assert!(
            docker(&[
                "exec",
                &lab.node,
                "sh",
                "-c",
                "echo '127.0.0.1 registry-1.docker.io auth.docker.io' >> /etc/hosts",
            ])
            .0
        );
        let mirror = StaticMirror::of(&lab, &["library/mirrored-hub"]);
        let before = lab.requests().len();
        lab.pause_proxy(true);
        let node = lab.node().with_mirror(StaticMirror::mirror());
        let done = download(
            &node,
            &only(&[&image, &hub]),
            test_limits(),
            &|| false,
            &mut |_| {},
        );
        lab.pause_proxy(false);
        assert_eq!(done, Ok(Done::Downloaded));
        let images = lab.images();
        assert!(images.contains(&image), "stored under its own name");
        assert!(images.contains(&hub), "stored under its Docker Hub name");
        let (bytes, _) = served(&mirror.requests(), &layer);
        assert!(
            bytes >= size,
            "the mirror sent the layer: {bytes} of {size}"
        );
        let (bytes, _) = served(&mirror.requests(), &hub_layer);
        assert!(
            bytes >= hub_size,
            "the mirror sent Docker Hub's layer: {bytes} of {hub_size}"
        );
        assert!(
            mirror
                .requests()
                .iter()
                .any(|line| line.starts_with(&format!(
                    "GET /v2/docker.io/library/mirrored-hub/blobs/{hub_layer} 200"
                ))),
            "{:?}",
            mirror.requests()
        );
        let upstream = lab.requests();
        assert!(
            upstream[before..]
                .iter()
                .all(|line| !line.contains("/blobs/")),
            "{upstream:?}"
        );

        // A CLI-style pull afterwards (no hosts directory) finds every blob present.
        assert!(docker(&["exec", &lab.node, "ctr", "images", "pull", &image]).0);
        let upstream = lab.requests();
        assert!(
            upstream[before..]
                .iter()
                .all(|line| !line.contains("/blobs/")),
            "{upstream:?}"
        );

        // After a restart, k3s writes the same mirror configuration again from the registries file.
        let hosts = format!("{HOSTS_DIR}/127.0.0.1:5000/hosts.toml");
        let hub_hosts = format!("{HOSTS_DIR}/docker.io/hosts.toml");
        let written = docker(&["exec", &lab.node, "cat", &hosts]).1;
        let hub_written = docker(&["exec", &lab.node, "cat", &hub_hosts]).1;
        assert_eq!(
            written,
            Mirror::hosts_toml("127.0.0.1:5000", "http://127.0.0.1:5002")
        );
        assert_eq!(
            hub_written,
            Mirror::hosts_toml("docker.io", "http://127.0.0.1:5002/v2/docker.io")
        );
        lab.stop_node();
        assert!(docker(&["start", &lab.node]).0);
        let until = Instant::now() + Duration::from_secs(120);
        while lab.node().image_names(test_limits()).is_none() {
            assert!(Instant::now() < until, "the node did not come back");
            std::thread::sleep(Duration::from_millis(500));
        }
        assert_eq!(docker(&["exec", &lab.node, "cat", &hosts]).1, written);
        assert_eq!(
            docker(&["exec", &lab.node, "cat", &hub_hosts]).1,
            hub_written
        );
    }

    pub(crate) fn only(fixed: &[&str]) -> CliImages {
        CliImages {
            release: "9.9.9-test.1".into(),
            fixed: fixed.iter().map(|image| (*image).to_owned()).collect(),
            tagged: Vec::new(),
        }
    }

    /// Bytes the proxy sent for `blob`, and the ranges it was asked for.
    fn served(requests: &[String], blob: &str) -> (u64, Vec<String>) {
        let mut bytes = 0;
        let mut ranges = Vec::new();
        for line in requests.iter().filter(|line| line.contains(blob)) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            bytes += fields[3].parse::<u64>().unwrap_or(0);
            ranges.push(fields[4].to_owned());
        }
        (bytes, ranges)
    }

    /// A request that asked for the layer from somewhere past its start: `Range: bytes=<n>-`.
    fn resumed(ranges: &[String]) -> bool {
        ranges.iter().any(|range| {
            range
                .strip_prefix("range=\"bytes=")
                .and_then(|rest| rest.split('-').next())
                .and_then(|from| from.parse::<u64>().ok())
                .is_some_and(|from| from > 0)
        })
    }

    fn layer_of(lab: &Lab, reference: &str) -> (String, u64) {
        let node = lab.node();
        let blobs = blobs_of(&node, reference, None, &lab.architecture, test_limits()).unwrap();
        blobs.into_iter().max_by_key(|(_, size)| *size).unwrap()
    }

    #[test]
    #[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
    fn a_slow_download_that_keeps_moving_is_never_stopped() {
        let lab = Lab::new("384k");
        // About 16 seconds through the proxy: two stall windows.
        let image = lab.push("test/slow", "1", &[6_000_000]);
        let mut seen = Vec::new();
        let started = Instant::now();
        let done = download(
            &lab.node(),
            &only(&[&image]),
            test_limits(),
            &|| false,
            &mut |d| seen.push(d),
        );
        assert_eq!(done, Ok(Done::Downloaded));
        assert!(
            started.elapsed() > test_limits().stall * 3 / 2,
            "{:?}",
            started.elapsed()
        );
        assert!(lab.images().contains(&image));
        let last = seen.last().unwrap();
        assert!(
            last.total >= 6_000_000 && last.done == last.total,
            "{seen:?}"
        );
        assert!(seen.windows(2).all(|pair| pair[0].done <= pair[1].done));
        assert!(
            seen.iter()
                .filter(|d| d.done > 0 && d.done < d.total)
                .count()
                >= 3,
            "{seen:?}"
        );
    }

    #[test]
    #[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
    fn a_stalled_download_stops_and_the_next_continues_from_what_it_fetched() {
        let lab = Lab::new("384k");
        let image = lab.push("test/stalls", "1", &[6_000_000]);
        let (layer, size) = layer_of(&lab, &image);
        let mut paused = false;
        let mut said = None;
        let started = Instant::now();
        let first = download(
            &lab.node(),
            &only(&[&image]),
            test_limits(),
            &|| false,
            &mut |d| {
                said = Some(d);
                if !paused && d.done >= 1_000_000 {
                    paused = true;
                    lab.pause_proxy(true);
                }
            },
        );
        assert_eq!(first, Err(Stop::Stalled));
        let said = said.unwrap();
        assert!(paused);
        assert!(started.elapsed() < Duration::from_secs(60));
        assert!(
            !lab.ctr_running(),
            "the stalled pull is stopped in the node"
        );
        let kept = lab.content().active.get(&layer).copied().unwrap_or(0);
        assert!(
            kept >= 1_000_000 && kept < size,
            "containerd keeps {kept} of {size}"
        );

        lab.pause_proxy(false);
        let mut seen = Vec::new();
        let second = download(
            &lab.node(),
            &only(&[&image]),
            test_limits(),
            &|| false,
            &mut |d| seen.push(d),
        );
        assert_eq!(second, Ok(Done::Downloaded));
        // The row goes on from the figure it stopped at, of the same total.
        assert!(
            seen[0].done >= said.done && seen[0].total == said.total,
            "it starts from what was kept: {said:?} then {seen:?}"
        );
        assert!(lab.images().contains(&image));
        let (bytes, ranges) = served(&lab.requests(), &layer);
        assert!(resumed(&ranges), "{ranges:?}");
        // Not fetched twice: what the proxy sent for the layer is about its size.
        assert!(bytes < size + size / 5, "{bytes} sent for {size}");
    }

    #[test]
    #[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
    fn a_download_stopped_midway_continues_where_it_stopped() {
        let lab = Lab::new("384k");
        let image = lab.push("test/stopped", "1", &[6_000_000]);
        let (layer, size) = layer_of(&lab, &image);
        let stop = std::sync::atomic::AtomicBool::new(false);
        let first = download(
            &lab.node(),
            &only(&[&image]),
            test_limits(),
            &|| stop.load(Ordering::SeqCst),
            &mut |d| {
                if d.done >= 1_500_000 {
                    stop.store(true, Ordering::SeqCst);
                }
            },
        );
        assert_eq!(first, Err(Stop::Cancelled));
        assert!(
            !lab.ctr_running(),
            "the pull is stopped in the node, not only its client"
        );
        let kept = lab.content().active.get(&layer).copied().unwrap_or(0);
        assert!(
            kept >= 1_500_000 && kept < size,
            "containerd keeps {kept} of {size}"
        );

        let mut seen = Vec::new();
        let second = download(
            &lab.node(),
            &only(&[&image]),
            test_limits(),
            &|| false,
            &mut |d| seen.push(d),
        );
        assert_eq!(second, Ok(Done::Downloaded));
        assert!(seen[0].done >= kept, "{seen:?}");
        assert!(lab.images().contains(&image));
        let (bytes, ranges) = served(&lab.requests(), &layer);
        assert!(resumed(&ranges), "{ranges:?}");
        assert!(bytes < size + size / 5, "{bytes} sent for {size}");
    }

    #[test]
    #[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
    fn images_already_in_the_node_are_skipped() {
        let lab = Lab::new("2m");
        let image = lab.push("test/present", "1", &[200_000]);
        let images = only(&[&image]);
        assert_eq!(
            download(&lab.node(), &images, test_limits(), &|| false, &mut |_| {}),
            Ok(Done::Downloaded)
        );
        let before = lab.requests().len();
        let mut said = Vec::new();
        assert_eq!(
            download(&lab.node(), &images, test_limits(), &|| false, &mut |d| {
                said.push(d)
            }),
            Ok(Done::NothingToDo)
        );
        assert_eq!(
            lab.requests().len(),
            before,
            "nothing was asked of the registry"
        );
        assert!(said.is_empty());
    }

    /**
    A stand-in for the CLI, shaped as the real one ships: a program that runs a script. Its
    `local update` pulls each image as the CLI's install does, `<engine> exec k3d-<stack>-server-0
    ctr images pull <image>`, under a fixed limit per image (the CLI's is ten minutes; `scenario`
    says this one's), then answers with the version-1 envelope. The script is a bundle in the shape
    esbuild writes the real one, naming the same images, for `cli_images` to read.
    */
    const PULLING_CLI: &str = r#"
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--warm") { return; }
    let dir = std::path::PathBuf::from(&args[0]).parent().unwrap().to_path_buf();
    let scenario = std::fs::read_to_string(dir.join("scenario")).unwrap();
    let mut lines = scenario.lines();
    let limit = Duration::from_secs(lines.next().unwrap().trim().parse().unwrap());
    let stack = lines.next().unwrap().trim().to_owned();
    let folder = lines.next().unwrap().trim().replace('\\', "\\\\");
    let command = format!("{} {}", args[1], args[2]);
    std::fs::write(dir.join("ran"), format!("{}{command}\n", std::fs::read_to_string(dir.join("ran")).unwrap_or_default())).unwrap();
    let node = format!("k3d-{stack}-server-0");
    // An update a previous attempt did not finish, to the release `under-way` names, as
    // `local status` and `local list` describe it.
    let update = match std::fs::read_to_string(dir.join("under-way")) {
        Ok(release) => format!("{{\"attemptedRelease\":\"{}\",\"state\":\"prepared\",\"observedSchema\":null,\"recoveryCommand\":\"copilotkit local update\"}}", release.trim()),
        Err(_) => "null".to_owned(),
    };
    let saved = format!("{{\"id\":\"{stack}\",\"appPaths\":[{{\"path\":\"{folder}\",\"missing\":false}}],\"installedRelease\":\"9.9.9-test.1\",\"step\":\"cluster\",\"urls\":{{\"api\":\"http://localhost:8082\",\"dashboard\":\"http://intelligence.localhost:8080\",\"gateway\":\"ws://[::1]:4401\"}},\"failedStep\":\"image-download\",\"update\":{update}}}");
    if command == "local status" {
        print!("{{\"version\":1,\"command\":\"local status\",\"status\":\"completed\",\"stack\":{saved},\"nextAction\":null,\"error\":null,\"diagnostics\":[]}}");
        return;
    }
    // A first setup: no stack is recorded yet, and `local setup` makes the node (the lab's, held
    // under the name `fresh` gives) a moment after it starts, then pulls into it.
    let fresh = std::fs::read_to_string(dir.join("fresh")).ok();
    if command == "local list" {
        let stacks = if fresh.is_some() { String::new() } else { saved };
        print!("{{\"version\":1,\"command\":\"local list\",\"status\":\"completed\",\"stacks\":[{stacks}],\"nextAction\":null,\"error\":null,\"diagnostics\":[]}}");
        return;
    }
    if let (Some(held), "local setup") = (fresh, command.as_str()) {
        std::thread::sleep(Duration::from_secs(1));
        let made = Command::new("docker").args(["rename", held.trim(), &node])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .status().unwrap();
        assert!(made.success());
    }
    let mut pulled = true;
    for image in lines.map(str::trim).filter(|line| !line.is_empty()) {
        let mut child = Command::new("docker")
            .args(["exec", &node, "ctr", "images", "pull", image])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().unwrap();
        let started = Instant::now();
        let finished = loop {
            if let Some(status) = child.try_wait().unwrap() { break status.success(); }
            if started.elapsed() >= limit { let _ = child.kill(); let _ = child.wait(); break false; }
            std::thread::sleep(Duration::from_millis(50));
        };
        if !finished { pulled = false; break; }
    }
    let stack_json = format!("{{\"id\":\"{stack}\",\"installedRelease\":\"9.9.9-test.1\",\"step\":\"ready\",\"urls\":{{\"api\":\"http://localhost:8082\",\"dashboard\":\"http://intelligence.localhost:8080\",\"gateway\":\"ws://[::1]:4401\"}},\"failedStep\":null,\"update\":null}}");
    if pulled {
        print!("{{\"version\":1,\"command\":\"{command}\",\"status\":\"completed\",\"stack\":{stack_json},\"nextAction\":null,\"error\":null,\"diagnostics\":[]}}");
    } else {
        print!("{{\"version\":1,\"command\":\"{command}\",\"status\":\"failed\",\"stack\":{stack_json},\"nextAction\":{{\"reason\":\"local_command_failed\"}},\"error\":null,\"diagnostics\":[]}}");
        std::process::exit(1);
    }
}
"#;

    fn pulling_cli_program() -> &'static std::path::Path {
        static BUILT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
        BUILT.get_or_init(|| {
            let root = crate::test_support::temp_root("pulling-cli-build");
            std::fs::create_dir_all(&root).unwrap();
            let source = root.join("cli.rs");
            std::fs::write(&source, PULLING_CLI).unwrap();
            let binary = root.join(format!("cli{}", std::env::consts::EXE_SUFFIX));
            crate::test_support::compile_fixture(&source, &binary);
            binary
        })
    }

    /// The images split as the bundle names them: `repository` and `digest`.
    fn split(image: &str) -> (&str, &str) {
        image.split_once('@').unwrap()
    }

    /**
    The stand-in CLI, pinned like any CLI. Its bundle names `runtime`'s repository as its one
    runtime image (pulled at `release`'s tag), `fixed` as its inventory beside k3s, and `system`
    as its Kubernetes images. `readable` false leaves out the release, as a CLI that says it
    differently would.
    */
    #[allow(clippy::too_many_arguments)]
    fn pulling_cli(
        label: &str,
        lab: &Lab,
        runtime: &str,
        fixed: &str,
        system: &str,
        pulls: &[&str],
        limit_seconds: u64,
        readable: bool,
    ) -> (crate::local_eval::PinnedCli, std::path::PathBuf) {
        use crate::local_eval::{Pin, PinnedCli};
        let root = crate::test_support::temp_root(label);
        std::fs::create_dir_all(&root).unwrap();
        // The folder a setup runs in, which `local list` says the stack was set up for.
        let installation = root.join("installation");
        std::fs::create_dir_all(&installation).unwrap();
        let program = root.join(format!("cli{}", std::env::consts::EXE_SUFFIX));
        std::fs::copy(pulling_cli_program(), &program).unwrap();
        let (fixed_repository, fixed_digest) = split(fixed);
        let (system_repository, system_digest) = split(system);
        let service = runtime
            .rsplit_once('/')
            .map(|(_, name)| name.split('@').next().unwrap())
            .unwrap();
        let release = if readable {
            "  const pinnedVersion = false ? \"\" : \"9.9.9-test.1\";"
        } else {
            ""
        };
        let bundle = format!(
            r#"var define_CLI_LOCAL_EVALUATION_SUPPORT_default;
var init_define_CLI_LOCAL_EVALUATION_SUPPORT = __esm({{
  "<define:__CLI_LOCAL_EVALUATION_SUPPORT__>"() {{
    define_CLI_LOCAL_EVALUATION_SUPPORT_default = {{
      images: {{
        objectStorage: {{
          repository: "{fixed_repository}",
          digest: "{fixed_digest}"
        }},
        k3s: {{
          repository: "docker.io/rancher/k3s",
          digest: "sha256:53cf744fe2fabf140cee240d2db70d13a4f2d98f1a13c98f58f457f423096917"
        }}
      }},
      kubernetesImages: [
        {{
          repository: "{system_repository}",
          digest: "{system_digest}",
          reference: "{system_repository}:3.6"
        }}
      ],
      platforms: []
    }};
  }}
}});
    const workloadImages = [...new Set(Object.entries(release4.images).filter(([name]) => !["k3s", "k3dProxy", "k3dTools"].includes(name)).map(([, image3]) => `${{image3.repository}}@${{image3.digest}}`))];
{release}
      const repository = `127.0.0.1:5000/test/${{service}}`;
    runtimeServices = {{
      appApi: "{service}"
    }};
"#
        );
        let script = root.join("index.js");
        std::fs::write(&script, bundle).unwrap();
        std::fs::write(
            root.join("scenario"),
            format!(
                "{limit_seconds}\n{}\n{}\n{}\n",
                lab.stack,
                installation.display(),
                pulls.join("\n")
            ),
        )
        .unwrap();
        let warm = Command::new(&program).arg(&script).arg("--warm").status();
        assert!(warm.unwrap().success());
        let pin = |path: &std::path::Path| Pin {
            path: path.to_path_buf(),
            sha256: sha256(&std::fs::read(path).unwrap())
                .trim_start_matches("sha256:")
                .to_owned(),
        };
        (
            PinnedCli::verify(&pin(&program), Some(&pin(&script))).unwrap(),
            installation,
        )
    }

    /// What the stand-in CLI beside `installation` was asked to do, in order.
    fn ran(installation: &std::path::Path) -> Vec<String> {
        std::fs::read_to_string(installation.parent().unwrap().join("ran"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    /// What `local_eval::downloading` says for `attempt` while `call` runs.
    fn watching<T>(attempt: &str, call: impl FnOnce() -> T) -> (T, Vec<Download>) {
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (stop_seen, attempt_seen) = (stop.clone(), attempt.to_owned());
        let watcher = std::thread::spawn(move || {
            let mut seen = Vec::new();
            while !stop_seen.load(Ordering::SeqCst) {
                if let Some(download) = crate::local_eval::downloading(&attempt_seen) {
                    if seen.last() != Some(&download) {
                        seen.push(download);
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            seen
        });
        let answer = call();
        stop.store(true, Ordering::SeqCst);
        (answer, watcher.join().unwrap())
    }

    type Answer = Result<crate::local_eval::Outcome, crate::local_eval::Failure>;

    fn call(
        cli: &crate::local_eval::PinnedCli,
        lab: &Lab,
        action: crate::local_eval::Action,
        attempt: &str,
    ) -> Answer {
        use crate::local_eval::{run_with, Cancel, Limits as CliLimits, StackId};
        let limits = CliLimits::for_action(action);
        run_with(
            cli,
            attempt,
            action,
            &StackId::parse(&lab.stack).unwrap(),
            (limits, limits),
            &Cancel::default(),
            test_limits(),
        )
        .map(|report| report.outcome)
    }

    fn update(cli: &crate::local_eval::PinnedCli, lab: &Lab, attempt: &str) -> Answer {
        call(cli, lab, crate::local_eval::Action::Update, attempt)
    }

    /// The three images a release names: one at its tag, one by digest, one system image.
    fn release_images(lab: &Lab) -> (String, String, String) {
        (
            lab.push("test/app-api", "9.9.9-test.1", &[6_000_000]),
            lab.push("test/object-storage", "1", &[120_000]),
            lab.push("test/pause", "3.6", &[60_000]),
        )
    }

    /**
    The teammate's loop: an update that stopped in its download stays on record, and the next
    Start resumes it with `local update` (#1240), under the same fixed limit. On a stack Quit
    stopped, `local update` starts the stack itself. Here the resuming update downloads that
    release's images first, starting the stopped node for it, and the CLI then finds them present.
    */
    #[test]
    #[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
    fn an_update_that_did_not_finish_is_downloaded_before_local_update_resumes_it() {
        let lab = Lab::new("384k");
        let (runtime, fixed, system) = release_images(&lab);
        let (cli, installation) = pulling_cli(
            "pulling-cli-resumed-update",
            &lab,
            &runtime,
            &fixed,
            &system,
            &[&fixed, &runtime, &system],
            6,
            true,
        );
        std::fs::write(
            installation.parent().unwrap().join("under-way"),
            "9.9.9-test.1",
        )
        .unwrap();
        lab.stop_node();
        let (outcome, seen) = watching("resumed-update", || update(&cli, &lab, "resumed-update"));
        assert_eq!(outcome, Ok(crate::local_eval::Outcome::Completed));
        assert_eq!(ran(&installation), ["local status", "local update"]);
        assert!(lab.node_running());
        assert!(lab.images().contains(&runtime));
        assert!(seen
            .last()
            .is_some_and(|d| d.done == d.total && d.total > 6_000_000));
    }

    /// An update on record to a release other than the one this CLI's images are read for is left
    /// for the CLI to resume and pull, as before: nothing is downloaded for it.
    #[test]
    #[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
    fn an_unfinished_update_to_another_release_is_left_to_the_cli() {
        let lab = Lab::new("2m");
        let (runtime, fixed, system) = release_images(&lab);
        let (cli, installation) = pulling_cli(
            "pulling-cli-other-release",
            &lab,
            &runtime,
            &fixed,
            &system,
            &[],
            6,
            true,
        );
        std::fs::write(
            installation.parent().unwrap().join("under-way"),
            "9.9.8-test.1",
        )
        .unwrap();
        let (outcome, seen) = watching("other-release", || update(&cli, &lab, "other-release"));
        assert_eq!(outcome, Ok(crate::local_eval::Outcome::Completed));
        assert_eq!(ran(&installation), ["local status", "local update"]);
        assert!(seen.is_empty(), "{seen:?}");
        assert!(!lab.images().contains(&runtime));
    }

    /// `local start` pulls nothing (the CLI refuses it while an update is on record), so nothing
    /// is downloaded before it and no status is asked for first.
    #[test]
    #[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
    fn a_start_runs_the_cli_alone() {
        let lab = Lab::new("2m");
        let (runtime, fixed, system) = release_images(&lab);
        let (cli, installation) = pulling_cli(
            "pulling-cli-plain-start",
            &lab,
            &runtime,
            &fixed,
            &system,
            &[],
            6,
            true,
        );
        let (outcome, seen) = watching("plain-start", || {
            call(&cli, &lab, crate::local_eval::Action::Start, "plain-start")
        });
        assert_eq!(outcome, Ok(crate::local_eval::Outcome::Completed));
        assert_eq!(ran(&installation), ["local start"]);
        assert!(seen.is_empty());
        assert!(!lab.images().contains(&runtime));
    }

    /// A first setup that stopped in its download, retried: the stack `local list` records for
    /// the folder has a node now, so its images are downloaded before `local setup` resumes.
    #[test]
    #[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
    fn a_setup_that_resumes_downloads_first_and_finishes() {
        use crate::local_eval::{setup_with, Cancel, Limits as CliLimits};
        let lab = Lab::new("384k");
        let (runtime, fixed, system) = release_images(&lab);
        let (cli, installation) = pulling_cli(
            "pulling-cli-setup",
            &lab,
            &runtime,
            &fixed,
            &system,
            &[&fixed, &runtime, &system],
            6,
            true,
        );
        let limits = CliLimits::for_setup();
        let (report, seen) = watching("resumed-setup", || {
            setup_with(
                &cli,
                "resumed-setup",
                &installation,
                None,
                (limits, limits),
                &Cancel::default(),
                test_limits(),
            )
        });
        assert_eq!(
            report.map(|report| report.outcome),
            Ok(crate::local_eval::Outcome::Completed)
        );
        assert_eq!(ran(&installation), ["local list", "local setup"]);
        assert!(lab.images().contains(&runtime));
        assert!(seen
            .last()
            .is_some_and(|d| d.done == d.total && d.total > 6_000_000));
    }

    /**
    The Windows fresh-install probe: a first setup's row said nothing for minutes while ~690 MB of
    back-end images came down. A first setup has no node until the CLI makes it, so nothing was
    downloaded or followed for it. Here the CLI makes the node after it starts and pulls into it on a
    slow line, and the setup's attempt is told how far that pull has got, out of the whole download,
    until all of it has arrived. Nothing is pulled by OpenBot: the CLI's own pulls finish it.
    */
    #[test]
    #[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
    fn a_first_setup_shows_the_download_the_cli_pulls_into_the_node_it_makes() {
        use crate::local_eval::{setup_with, Cancel, Limits as CliLimits};
        let lab = Lab::new("384k");
        let (runtime, fixed, system) = release_images(&lab);
        let (cli, installation) = pulling_cli(
            "pulling-cli-first-setup",
            &lab,
            &runtime,
            &fixed,
            &system,
            &[&fixed, &runtime, &system],
            120,
            true,
        );
        // The node is not there yet: it is held under another name until the CLI makes it.
        let held = format!("{}-not-yet", lab.stack);
        assert!(docker(&["rename", &lab.node, &held]).0);
        std::fs::write(installation.parent().unwrap().join("fresh"), &held).unwrap();
        let limits = CliLimits::for_setup();
        let (report, seen) = watching("first-setup", || {
            setup_with(
                &cli,
                "first-setup",
                &installation,
                None,
                (limits, limits),
                &Cancel::default(),
                test_limits(),
            )
        });
        assert_eq!(
            report.map(|report| report.outcome),
            Ok(crate::local_eval::Outcome::Completed)
        );
        assert_eq!(ran(&installation), ["local list", "local setup"]);
        assert!(lab.images().contains(&runtime));
        // Seen moving, out of the whole release (three images, shared blobs once), never back.
        assert!(
            seen.iter()
                .filter(|d| d.done < d.total && d.total > 6_000_000)
                .count()
                >= 3,
            "{seen:?}"
        );
        assert!(
            seen.windows(2)
                .all(|w| w[0].done <= w[1].done && w[0].total == w[1].total),
            "{seen:?}"
        );
        // Only the CLI pulled: OpenBot read manifests, and the layer was sent once.
        let (layer, _) = layer_of(&lab, &runtime);
        let gets: Vec<String> = lab
            .requests()
            .into_iter()
            .filter(|line| line.starts_with("GET ") && line.contains(&layer))
            .collect();
        assert_eq!(gets.len(), 1, "{gets:?}");
    }

    /// A node the download started is stopped again when the download stops: Retry then finds the
    /// stack as Quit left it, and starts from the same place.
    #[test]
    #[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
    fn a_node_started_for_a_download_that_stalls_is_stopped_again() {
        let lab = Lab::new("384k");
        let image = lab.push("test/stalls-after-start", "1", &[6_000_000]);
        lab.stop_node();
        let mut paused = false;
        let stopped = download(
            &lab.node(),
            &only(&[&image]),
            test_limits(),
            &|| false,
            &mut |d| {
                if !paused && d.done >= 1_000_000 {
                    paused = true;
                    lab.pause_proxy(true);
                }
            },
        );
        assert_eq!(stopped, Err(Stop::Stalled));
        assert!(!lab.node_running());
        lab.pause_proxy(false);
    }

    /// The bug: the CLI's own pull of a 6 MB image through a 384 KB/s line takes about sixteen
    /// seconds, over its fixed six. OpenBot downloads first, with no fixed limit, and the CLI then
    /// finds all three images present and finishes.
    #[test]
    #[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
    fn an_update_on_a_slow_line_finishes_because_openbot_downloads_its_images_first() {
        let lab = Lab::new("384k");
        let (runtime, fixed, system) = release_images(&lab);
        let (cli, _) = pulling_cli(
            "pulling-cli-update",
            &lab,
            &runtime,
            &fixed,
            &system,
            &[&fixed, &runtime, &system],
            6,
            true,
        );
        let (outcome, seen) = watching("slow-update", || update(&cli, &lab, "slow-update"));
        assert_eq!(outcome, Ok(crate::local_eval::Outcome::Completed));
        let images = lab.images();
        for image in [&runtime, &fixed, &system] {
            assert!(images.contains(image), "{image} is in the node");
        }
        let last = seen
            .last()
            .expect("the row was told how far the download got");
        assert!(
            last.total >= 6_180_000 && last.done == last.total,
            "{seen:?}"
        );
        assert!(
            seen.iter().filter(|d| d.done < d.total).count() >= 3,
            "{seen:?}"
        );
    }

    /// A CLI whose images cannot be read is left to pull them itself, under its own limit: on
    /// this line it fails as it does today, and nothing was downloaded or said before it.
    #[test]
    #[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
    fn an_image_list_openbot_cannot_read_leaves_the_pull_to_the_cli_as_before() {
        let lab = Lab::new("384k");
        let (runtime, fixed, system) = release_images(&lab);
        let (cli, _) = pulling_cli(
            "pulling-cli-unreadable",
            &lab,
            &runtime,
            &fixed,
            &system,
            &[&runtime],
            6,
            false,
        );
        let (outcome, seen) = watching("unreadable", || update(&cli, &lab, "unreadable"));
        assert_eq!(outcome, Ok(crate::local_eval::Outcome::Failed));
        assert!(seen.is_empty(), "{seen:?}");
        // Only the CLI's own pull asked for anything: never the release's tag, never the images
        // the bundle names beside it.
        let asked = lab.requests();
        assert!(
            asked
                .iter()
                .all(|line| !line.contains("/manifests/9.9.9-test.1")
                    && !line.contains("/test/object-storage/")
                    && !line.contains("/test/pause/")),
            "{asked:?}"
        );
        assert!(asked.iter().any(|line| line.contains("/test/app-api/")));
        assert!(!lab.images().contains(&runtime));
    }

    #[test]
    #[ignore = "runs a privileged k3s node, a registry and a proxy on Docker"]
    fn a_node_that_is_not_the_stacks_is_left_alone() {
        let lab = Lab::new("2m");
        let image = lab.push("test/other", "1", &[200_000]);
        // The same node under another stack's name: its label says it is not that stack's.
        let other = Node {
            engine: &engine,
            stack: "local-someone-else".into(),
            name: lab.node.clone(),
            mirror: Mirror::standard(),
        };
        assert_eq!(
            download(
                &other,
                &only(&[&image]),
                test_limits(),
                &|| false,
                &mut |_| {}
            ),
            Ok(Done::Unavailable)
        );
        assert!(!lab.images().contains(&image));
    }
}
