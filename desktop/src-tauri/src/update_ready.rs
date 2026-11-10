/*!
Getting an announced OpenBot release ready while this version keeps running.

THE PROBLEM. An update did all its work after the Update click, with OpenBot down: the back end's
update, then OpenBot's own image pulls (up to 1.1 GB when every image changed, see `upgrade`), then
the start. Measured on Windows, 0.3.4 to 1.0.0 took 3 min 34 s from the click to OpenBot.

WHAT THIS DOES. As soon as the update feed names a newer release (`app_update`), it downloads that
release's images into the engines they will run on, in the background: OpenBot's own into the
container engine, where the upgrade's pull finds them (`pull_metrics::pull_image` skips an image the
engine has), and the back end's into its k3d node, where `local update` and OpenBot's download
before it find them (`local_images`). The Update click then costs the stop, the backup, the
migrations and the start. Desktop updaters stage an update this way: Sparkle downloads it silently
and installs it when the person says (`SUAutomaticallyUpdate`), and Tauri's updater splits
`download` from `install` for the same reason.

WHICH IMAGES. Each release publishes every image the app may pull for it as `desktop-images.json`
(`release_images`), with the back end release its CLI installs. Of those, only the ones this
installation runs: for each image its last install pulled (`preparation::installed_images`), the
release's image of the same repository; and, when the back end's release changes, for each
repository the bundled CLI pulls into the node (`local_eval::bundled_cli_images`), the release's.
An image the release adds under a new repository is left to the update, as before.

WHAT IT NEVER DOES. It never starts, stops or restarts anything: it pulls into an engine and a node
that are running, and only adds images, so nothing that runs changes. It pulls one image at a time,
and stops before the next whenever something the person started needs the engine (a Start, a Stop,
the Update click, Quit). A build that does not update itself never gets here
(`app_update::Feed::of`). A person who never updates keeps unused images, and the next release's
download takes the back end's pin off them (`local_images::unpin_ready_for_other`).

DISK. Before anything downloads, the engine's disk is measured as the back end's setup measures it
(`local_eval::engine_disk`), and the computer's own drive under the engine's disk (`computer_free`).
An image takes about `ON_DISK` times its download. After it, the engine keeps `KEEP_FREE_PERCENT`
of its disk free, the line where the kubelet starts removing images no container runs, and the
download takes at most half of what the computer's drive has free. Short of either, nothing
downloads, the log says why, and the update downloads the images as it always did.

KEPT FOR THE UPDATE. A container engine never removes an image by itself. The back end's kubelet
does, from 85% used, so the node's images are pinned (`local_images::download_ahead`).
*/

use semver::Version;
use serde::Deserialize;

use crate::engine::Address;
use crate::local_eval::Disk;
use crate::local_images::{self, CliImages, Limits, Node};

/// The release asset that names every image the app may pull for it (`release_images`).
pub const LIST: &str = "desktop-images.json";

/// An image takes about this many times its download on disk: its layers unpacked are two to three
/// times their compressed size, and containerd keeps the compressed download beside them.
pub const ON_DISK: u64 = 4;

/// The share of the engine's disk that stays free after the download: below 15% free the kubelet
/// removes the images no container runs (`imageGCHighThresholdPercent` 85), the line
/// `local_eval` checks a back end's start against too.
pub const KEEP_FREE_PERCENT: u64 = 15;

/// What an image counts as when its registry does not say its size: more than any image OpenBot
/// or the back end pulls (the largest, the computer's, is 451 MB).
pub const UNKNOWN_SIZE: u64 = 1 << 30;

/// A release's `desktop-images.json`.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Announced {
    /// The OpenBot release, `v1.0.1`.
    pub openbot: String,
    /// The back end release its CLI installs.
    pub intelligence: String,
    /// Every image the app may pull for the release.
    pub images: Vec<String>,
}

/// Where `repository` publishes the list for `version`. `deployment::get` asks
/// downloads.copilotkit.ai's copy first, and GitHub when that fails.
pub fn list_url(repository: &str, version: &Version) -> String {
    format!("https://github.com/{repository}/releases/download/v{version}/{LIST}")
}

/// The list `body` says, when it is the list for `version`.
pub fn read_list(body: &[u8], version: &Version) -> Result<Announced, String> {
    let list: Announced = serde_json::from_slice(body)
        .map_err(|error| format!("{LIST} for v{version} is not readable: {error}"))?;
    if list.openbot != format!("v{version}") {
        return Err(format!(
            "{LIST} for v{version} is the list for {}",
            list.openbot
        ));
    }
    Ok(list)
}

/// A test feed's list (`app_update::TEST_FEED`): its folder's `desktop-images.json`, for whichever
/// build it was made from. An internal build's names its commit's images, not a release tag.
pub fn read_test_list(folder: &std::path::Path) -> Result<Announced, String> {
    let file = folder.join(LIST);
    let body = std::fs::read(&file)
        .map_err(|error| format!("could not read {}: {error}", file.display()))?;
    serde_json::from_slice(&body)
        .map_err(|error| format!("{} is not readable: {error}", file.display()))
}

/// An image's registry and repository, as an engine reads its name.
fn repository(image: &str) -> Option<(String, String)> {
    let reference = crate::registry::parse_reference(image)?;
    Some((reference.host, reference.repository))
}

/// OpenBot's images in `list` that this installation runs: for each image it pulled last
/// (`installed`), the list's image of the same repository.
pub fn openbot_images(installed: &[String], list: &Announced) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for image in installed {
        let Some(wanted) = repository(image) else {
            continue;
        };
        for next in &list.images {
            if repository(next).as_ref() == Some(&wanted) && !found.contains(next) {
                found.push(next.clone());
            }
        }
    }
    found
}

/// The back end images in `list` that the update pulls into the node, by the repositories the CLI
/// this app runs pulls (`current`). None when the list's back end release is the one `current`
/// installs, since the update then changes no back end image.
pub fn back_end_images(current: &CliImages, list: &Announced) -> Option<CliImages> {
    if list.intelligence == current.release {
        return None;
    }
    let tagged: Vec<String> = current
        .tagged
        .iter()
        .filter(|named| {
            list.images
                .contains(&format!("{named}:{}", list.intelligence))
        })
        .cloned()
        .collect();
    let repositories: Vec<_> = current.fixed.iter().filter_map(|f| repository(f)).collect();
    let fixed: Vec<String> = list
        .images
        .iter()
        .filter(|image| {
            image.contains('@') && repository(image).is_some_and(|r| repositories.contains(&r))
        })
        .cloned()
        .collect();
    (!tagged.is_empty() || !fixed.is_empty()).then(|| CliImages {
        release: list.intelligence.clone(),
        fixed,
        tagged,
    })
}

/// Bytes as GB to one decimal, for the log.
fn gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1e9)
}

/**
Whether a download of `download` bytes fits: `ON_DISK` times it leaves `KEEP_FREE_PERCENT` of the
engine's disk free, and takes at most half of what the computer's drive under it has free, when
that is a separate drive (`computer_free`). Why not, for the log.
*/
pub fn room(download: u64, engine: Disk, computer_free: Option<u64>) -> Result<(), String> {
    if download == 0 {
        return Ok(());
    }
    let needed = download.saturating_mul(ON_DISK);
    let left = engine.free.checked_sub(needed);
    let engine_fits = left.is_some_and(|left| {
        u128::from(left) * 100 >= u128::from(engine.size) * u128::from(KEEP_FREE_PERCENT)
    });
    if !engine_fits {
        return Err(format!(
            "it takes about {} on disk, and the engine has {} free of {}, of which it keeps {KEEP_FREE_PERCENT}% free",
            gb(needed),
            gb(engine.free),
            gb(engine.size)
        ));
    }
    if let Some(free) = computer_free.filter(|free| needed > free / 2) {
        return Err(format!(
            "it takes about {} on disk, more than half of the {} this computer's drive has free",
            gb(needed),
            gb(free)
        ));
    }
    Ok(())
}

/**
Free space on the computer's own drive under the engine's disk, when the engine keeps its disk in a
file there that grows as images arrive: on Windows the drive WSL keeps Podman's machine disk on
(`windows::podman_machine_drive`, as the back end's start checks it), and on a Mac the volume of the
home folder, where Docker Desktop and Podman keep their machine's disk. A machine disk of a terabyte
says nothing of the drive it lives on. None elsewhere, or when it cannot be read.
*/
pub fn computer_free(address: &Address) -> Option<u64> {
    #[cfg(target_os = "windows")]
    {
        if address.engine != crate::engine::Engine::Podman {
            return None;
        }
        let connection = address
            .connection
            .clone()
            .or_else(|| address.pin().ok().and_then(|pinned| pinned.connection))?;
        crate::windows::podman_machine_drive(crate::acquire::machine_of(&connection))
            .map(|drive| drive.free)
    }
    #[cfg(target_os = "macos")]
    {
        let _ = address;
        let home = std::env::var_os("HOME")?;
        let path = std::ffi::CString::new(std::os::unix::ffi::OsStrExt::as_bytes(home.as_os_str()))
            .ok()?;
        // SAFETY: `path` is a valid C string, and `statvfs` only writes the struct it is given.
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        let read = unsafe { libc::statvfs(path.as_ptr(), &mut stat) };
        (read == 0).then(|| u64::from(stat.f_bavail) * stat.f_frsize)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = address;
        None
    }
}

/// What getting a release ready needs from the app around it.
pub struct Ahead<'a> {
    /// The release being got ready.
    pub version: &'a Version,
    /// Its `desktop-images.json`.
    pub list: &'a Announced,
    /// The engine OpenBot runs on.
    pub engine: &'a Address,
    /// The images this installation's last install pulled.
    pub installed: &'a [String],
    /// The back end's node, and what the CLI this app runs pulls into it, when the installation
    /// has a local back end.
    pub back_end: Option<(&'a Node<'a>, &'a CliImages)>,
    /// The engine's disk (`local_eval::engine_disk`).
    pub disk: &'a dyn Fn() -> Option<Disk>,
    /// The computer's drive under it (`computer_free`).
    pub computer_free: &'a dyn Fn() -> Option<u64>,
    pub limits: Limits,
}

/// How a try at getting a release ready ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Every image the update pulls is here.
    Ready,
    /// The disk is short, or could not be measured, and nothing was downloaded. Why, for the log.
    Skipped(String),
    /// Something the person started needs the engine: stopped before the next image.
    Stopped,
    /// Something could not be downloaded or read. What arrived is kept; the next try goes on.
    NotYet(String),
}

/**
Download what `ahead`'s release needs that is not here yet, one image at a time, OpenBot's first.
`stop` is asked before each image and while the back end's download runs. `progress` hears the bytes
arrived of the bytes there are to download, after each image and as the back end's arrive.
*/
pub fn get_ready(
    ahead: &Ahead,
    stop: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(u64, u64),
) -> Outcome {
    let present =
        |image: &str| crate::preparation::image_present(ahead.engine, image).unwrap_or(false);
    let openbot: Vec<String> = openbot_images(ahead.installed, ahead.list)
        .into_iter()
        .filter(|image| !present(image))
        .collect();
    let release = ahead.version.to_string();
    let back_end = ahead.back_end.map(|(node, current)| {
        let images = back_end_images(current, ahead.list);
        // Only this release's images keep their pin: one the app has since updated to runs, and
        // one a newer release replaced never will.
        local_images::unpin_ready_for_other(
            node,
            images.as_ref().map(|_| release.as_str()),
            ahead.limits,
        );
        (node, images)
    });
    let back_end = back_end.and_then(|(node, images)| Some((node, images?)));

    let sizes: Vec<u64> = openbot
        .iter()
        .map(|image| {
            crate::registry::image_layers(image, crate::registry::host_architecture())
                .map_or(UNKNOWN_SIZE, |layers| {
                    layers.iter().map(|layer| layer.size).sum()
                })
        })
        .collect();
    let back_end_bytes = match &back_end {
        Some((node, images)) => match local_images::missing_bytes(node, images, ahead.limits) {
            Some(bytes) => bytes,
            None => {
                return Outcome::NotYet(
                    "the backend is not running, or its new images could not be read".into(),
                )
            }
        },
        None => 0,
    };
    let total = sizes.iter().sum::<u64>() + back_end_bytes;
    if total > 0 {
        let Some(disk) = (ahead.disk)() else {
            return Outcome::Skipped("the engine's free disk could not be measured".into());
        };
        if let Err(why) = room(total, disk, (ahead.computer_free)()) {
            return Outcome::Skipped(why);
        }
        progress(0, total);
    }

    let mut done = 0;
    for (image, size) in openbot.iter().zip(&sizes) {
        if stop() {
            return Outcome::Stopped;
        }
        log::info!("[update ready] downloading {image} for {release}");
        if let Err(problem) = crate::pull_metrics::pull_image(ahead.engine, image, |_| {}, |_| {}) {
            return Outcome::NotYet(format!(
                "{image} did not download: {}",
                problem.detail.unwrap_or(problem.said)
            ));
        }
        done += size;
        progress(done, total);
    }
    if let Some((node, images)) = &back_end {
        if stop() {
            return Outcome::Stopped;
        }
        let before = done;
        let downloaded = local_images::download_ahead(
            node,
            images,
            &release,
            ahead.limits,
            stop,
            &mut |download| {
                // What the node held of these images before this try is not this try's progress.
                let held = download.total.saturating_sub(back_end_bytes);
                let arrived = download.done.saturating_sub(held).min(back_end_bytes);
                progress(before + arrived, total);
            },
        );
        match downloaded {
            Ok(local_images::Done::Downloaded | local_images::Done::NothingToDo) => {}
            Ok(local_images::Done::Unavailable) => {
                return Outcome::NotYet("the backend's node could not be reached".into())
            }
            Err(local_images::Stop::Cancelled) => return Outcome::Stopped,
            Err(local_images::Stop::Stalled) => {
                return Outcome::NotYet("the backend's images stopped arriving".into())
            }
            Err(local_images::Stop::TooLong) => {
                return Outcome::NotYet("the backend's images took too long".into())
            }
        }
    }

    if let Some(missing) = openbot.iter().find(|image| !present(image)) {
        return Outcome::NotYet(format!("{missing} is still missing"));
    }
    if let Some((node, images)) = &back_end {
        if local_images::missing_bytes(node, images, ahead.limits) != Some(0) {
            return Outcome::NotYet("some of the backend's images are still missing".into());
        }
    }
    Outcome::Ready
}

/// A wake-up for the thread that gets releases ready: the feed named one just now.
#[derive(Default)]
pub struct Nudge {
    nudged: std::sync::Mutex<bool>,
    woken: std::sync::Condvar,
}

impl Nudge {
    pub fn nudge(&self) {
        *self.nudged.lock().unwrap_or_else(|p| p.into_inner()) = true;
        self.woken.notify_all();
    }

    /// Until nudged, or `at_most` has passed.
    pub fn wait(&self, at_most: std::time::Duration) {
        let nudged = self.nudged.lock().unwrap_or_else(|p| p.into_inner());
        let (mut nudged, _) = self
            .woken
            .wait_timeout_while(nudged, at_most, |nudged| !*nudged)
            .unwrap_or_else(|p| p.into_inner());
        *nudged = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const V0_3_4: &str = include_str!("../test-fixtures/update-ready/desktop-images-v0.3.4.json");
    const V1_0_0: &str = include_str!("../test-fixtures/update-ready/desktop-images-v1.0.0.json");
    /// The CLI 0.3.4 bundled, installing back end 0.16.0-rc.9.
    const CLI_0_3_4: &str = include_str!("../test-fixtures/local-images/cli-48a3863-excerpt.txt");

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    /// What a 0.3.4 install of the default Bot recorded it pulled: the services, the database and
    /// the two sign-in images, as `installation_pull_set` names them.
    fn installed_on_0_3_4() -> Vec<String> {
        let list = read_list(V0_3_4.as_bytes(), &v("0.3.4")).unwrap();
        list.images
            .into_iter()
            .filter(|image| {
                [
                    "/openbot-server@",
                    "/openbot-agent-computer@",
                    "/openbot-agent-claude-sdk@",
                    "/openbot-agent-langgraph-agui@",
                    "pgvector/pgvector:",
                ]
                .iter()
                .any(|part| image.contains(part))
            })
            .collect()
    }

    #[test]
    fn the_releases_list_is_read_and_one_for_another_release_is_refused() {
        let list = read_list(V1_0_0.as_bytes(), &v("1.0.0")).unwrap();
        assert_eq!(list.intelligence, "0.16.0-rc.10");
        assert_eq!(list.images.len(), 35);
        assert!(read_list(V1_0_0.as_bytes(), &v("1.0.1"))
            .unwrap_err()
            .contains("is the list for v1.0.0"));
        assert!(read_list(b"<html>403</html>", &v("1.0.0")).is_err());
        assert_eq!(
            list_url("CopilotKit/OpenBot", &v("1.0.1")),
            "https://github.com/CopilotKit/OpenBot/releases/download/v1.0.1/desktop-images.json"
        );
        // downloads.copilotkit.ai's copy is asked first.
        assert_eq!(
            crate::deployment::mirrored(&list_url("CopilotKit/OpenBot", &v("1.0.1"))).as_deref(),
            Some("https://downloads.copilotkit.ai/releases/v1.0.1/desktop-images.json")
        );
    }

    /// 0.3.4 to 1.0.0 as it shipped: the default Bot's five images, each the 1.0.0 one of the same
    /// repository, and none of the other 30 any Bot could need.
    #[test]
    fn of_the_releases_images_only_those_this_installation_runs_are_downloaded() {
        let installed = installed_on_0_3_4();
        assert_eq!(installed.len(), 5);
        let next = read_list(V1_0_0.as_bytes(), &v("1.0.0")).unwrap();
        let mut found = openbot_images(&installed, &next);
        found.sort();
        assert_eq!(
            found,
            [
                "ghcr.io/copilotkit/openbot-agent-claude-sdk@sha256:a43f203f3c303c7d3e024ef87a0740ff84136e4ccc59e9e8d7fd0b845d284c6c",
                "ghcr.io/copilotkit/openbot-agent-computer@sha256:820858d55fe9d40c4736a4c6305a5857aec95eb3179cb38898b4017b7ac98de5",
                "ghcr.io/copilotkit/openbot-agent-langgraph-agui@sha256:e009e9813c97a3a818f231e7dbe9dedb6e5a7daa32f2286c687b04ed9078732b",
                "ghcr.io/copilotkit/openbot-server@sha256:06ac2bbb9e061bab61be14c4ee46aaa8ca52396337210dd509a31ec8f9472b95",
                "pgvector/pgvector:pg17",
            ]
        );
    }

    /// The back end 0.3.4's CLI runs, moved to 1.0.0's release: its runtime images at the new tag,
    /// and its pinned images by the new list's digests, but never the cluster's own images, which
    /// k3d pulls only when it creates a cluster, nor OpenBot's.
    #[test]
    fn the_back_ends_images_are_the_new_releases_by_the_repositories_the_cli_pulls() {
        let current = crate::local_images::cli_images(CLI_0_3_4).unwrap();
        assert_eq!(current.release, "0.16.0-rc.9");
        let next = read_list(V1_0_0.as_bytes(), &v("1.0.0")).unwrap();
        let images = back_end_images(&current, &next).unwrap();
        assert_eq!(images.release, "0.16.0-rc.10");
        assert_eq!(images.tagged, current.tagged);
        assert!(images
            .tagged
            .contains(&"ghcr.io/copilotkit/intelligence/app-api".to_string()));
        assert!(images.fixed.contains(
            &"docker.io/bitnamilegacy/redis@sha256:a25b5d07a14ec13730022c7cd9bab6308d55ccd86b74af7315553c17be884889"
                .to_string()
        ));
        for image in &images.fixed {
            assert!(
                !image.contains("rancher/k3s@")
                    && !image.contains("k3d-io/")
                    && !image.contains("/openbot-"),
                "{image}"
            );
        }
        // The same back end release changes no back end image.
        let mut same = next.clone();
        same.intelligence = current.release.clone();
        assert_eq!(back_end_images(&current, &same), None);
    }

    #[test]
    fn a_download_fits_when_the_engine_keeps_its_line_and_the_computer_its_half() {
        const GB: u64 = 1_000_000_000;
        let engine = |free: u64| Disk {
            size: 100 * GB,
            free: free * GB,
        };
        // 1.7 GB, the most an update downloads, is about 6.8 GB on disk.
        assert_eq!(room(17 * GB / 10, engine(60), None), Ok(()));
        assert_eq!(room(17 * GB / 10, engine(60), Some(14 * GB)), Ok(()));
        // The engine would fall under 15% free, where the kubelet removes unused images.
        let short = room(17 * GB / 10, engine(20), None).unwrap_err();
        assert!(
            short.contains("6.8 GB") && short.contains("20.0 GB free of 100.0 GB"),
            "{short}"
        );
        assert!(room(GB, engine(3), None).is_err());
        // A Mac whose drive has 10 GB free: the machine's disk says nothing of it.
        let drive = room(17 * GB / 10, engine(900), Some(10 * GB)).unwrap_err();
        assert!(drive.contains("this computer's drive has free"), "{drive}");
        // Nothing to download always fits.
        assert_eq!(room(0, engine(0), Some(0)), Ok(()));
    }

    #[test]
    fn a_nudge_wakes_the_wait_and_is_used_up() {
        let nudge = std::sync::Arc::new(Nudge::default());
        let started = std::time::Instant::now();
        let waking = nudge.clone();
        let woken = std::thread::spawn(move || waking.wait(std::time::Duration::from_secs(30)));
        std::thread::sleep(std::time::Duration::from_millis(50));
        nudge.nudge();
        woken.join().unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        let started = std::time::Instant::now();
        nudge.wait(std::time::Duration::from_millis(100));
        assert!(started.elapsed() >= std::time::Duration::from_millis(100));
    }
}

#[cfg(test)]
#[path = "update_ready_live_tests.rs"]
mod live;
