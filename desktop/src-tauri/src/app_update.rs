//! Whether a newer OpenBot Desktop is out, read from the feed its updater installs from.
//!
//! The shell reads that feed at launch and every six hours while it runs, and keeps the last good
//! answer. OpenBot's own page (the banner) and the setup window (its update offer) both ask the
//! shell what to offer; neither reaches the network itself. A browser showing a self-hosted
//! OpenBot has no shell to ask, so it never asks the feed anything.
//!
//! Offered only where the updater can install it: a stable, unpinned build whose configuration
//! carries `plugins.updater` (the signed Mac and Windows releases). The feed is that block's own
//! `endpoints`, read in the updater's order, so the banner and the install read the same file.
//!
//! The person can close the banner. That is kept per version in the app's config directory, and
//! a newer version than the one they closed brings it back.

use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How often a running app reads the feed again after the read at launch.
///
/// Sparkle, the usual Mac updater, checks once a day by default and refuses anything under an
/// hour. Six hours is the cadence the downloads mirror is refreshed at.
pub const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// How often the schedule looks at the wall clock. A timer does not run while a Mac sleeps, so one
/// six-hour sleep would put a laptop's next check off by however long the lid was shut. A short
/// tick against the wall clock makes it up within minutes of waking.
pub const TICK: Duration = Duration::from_secs(5 * 60);

/// One read's time limit. A feed that hangs is a failed check, not a stuck thread.
const TIMEOUT: Duration = Duration::from_secs(30);

/// The largest feed read. The real one is about 20 KB, nearly all of it release notes.
const LARGEST: u64 = 1024 * 1024;

/// The version this person closed the banner on, in the app's config directory.
pub const DISMISSED_FILE: &str = "app-update.json";

/// The version this build is offered newer ones against, or `None` when it is offered none.
///
/// The builds the updater serves: a stable release that is not pinned. Candidates (`-rc.N`,
/// `-beta.N`) are pinned to the release they were made from and carry no updater, so an offer there
/// could never be installed. Internal builds (`0.3.4-internal.<commits>.g…` after 0.3.3) are made from
/// any branch, so no release is sure to contain what one runs; the next internal build replaces it.
pub fn offered_against(version: &Version, pinned: bool) -> Option<Version> {
    (!pinned && version.pre.is_empty()).then(|| version.clone())
}

/**
The variable that points an internal build at a test feed, so the background download of an update
(`update_ready`) can be tried on a test machine before any release names one: a folder holding a
`latest.json`, of which only `version` is read, and that version's `desktop-images.json`.

Only an internal build reads it (`internal`). A stable or candidate build never does, whatever its
environment says. It installs nothing: an internal build has no updater, so Update and restart
refuses, and the next build is installed by hand.
*/
pub const TEST_FEED: &str = "OPENBOT_TEST_UPDATE_FEED";

/// An internal build: `X.Y.Z-internal.<commits>.g<commit>`, or `X.Y.Z-rc.N.internal.…` when it was
/// built after a candidate.
pub fn internal(version: &Version) -> bool {
    version
        .pre
        .as_str()
        .split('.')
        .any(|part| part == "internal")
}

/// The test feed folder `TEST_FEED` names, read through `var`, for an internal build only. None for
/// a stable or candidate build, and when it is not set.
pub fn test_feed(
    version: &Version,
    var: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    if !internal(version) {
        return None;
    }
    let folder = std::path::PathBuf::from(var(TEST_FEED)?);
    (!folder.as_os_str().is_empty()).then_some(folder)
}

/// What a test feed in `folder` offers `current`: the version its `latest.json` names, when it is
/// newer by its whole version, so a later internal build is newer than an earlier one.
pub fn test_newer(current: &Version, folder: &Path) -> Result<Option<Version>, String> {
    let file = folder.join("latest.json");
    let text = std::fs::read(&file)
        .map_err(|error| format!("could not read {}: {error}", file.display()))?;
    let feed: Value = serde_json::from_slice(&text)
        .map_err(|error| format!("{} is not JSON: {error}", file.display()))?;
    let named = feed
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{} names no version", file.display()))?;
    let version = Version::parse(named.strip_prefix('v').unwrap_or(named))
        .map_err(|error| format!("{named:?} in {} is not a version: {error}", file.display()))?;
    Ok((version > *current).then_some(version))
}

/// The feed's addresses, in the updater's order, from its `plugins.updater` block. `None` when the
/// build has no updater, since nothing could install what a banner offered.
///
/// HTTPS only, as the updater requires, unless the block itself says
/// `dangerousInsecureTransportProtocol`, the updater's own switch for a local test feed.
pub fn endpoints(updater: Option<&Value>) -> Option<Vec<reqwest::Url>> {
    let block = updater.filter(|block| !block.is_null())?;
    let insecure = block["dangerousInsecureTransportProtocol"].as_bool() == Some(true);
    let found: Vec<reqwest::Url> = block["endpoints"]
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .filter_map(|address| reqwest::Url::parse(address).ok())
        .filter(|url| url.scheme() == "https" || (insecure && url.scheme() == "http"))
        .collect();
    (!found.is_empty()).then_some(found)
}

/// The feed to download an update from again when the download from `failed` did not finish: the
/// next feed in `endpoints` after the one on `failed`'s host, on another host. The first feed,
/// downloads.copilotkit.ai, names its own copy of the archive, and the updater moves on to the next
/// feed only when reading a feed fails, never when a download does; so a download from the mirror
/// that fails is tried once more from GitHub's feed. A download from GitHub, the last feed, is not.
pub fn feed_after(failed: &reqwest::Url, endpoints: &[reqwest::Url]) -> Option<reqwest::Url> {
    let from = endpoints
        .iter()
        .position(|feed| feed.origin() == failed.origin())?;
    endpoints[from + 1..]
        .iter()
        .find(|feed| feed.origin() != failed.origin())
        .cloned()
}

/// The `platforms` key the updater looks for on this machine, `{os}-{arch}`, spelled its way
/// (`darwin-aarch64`, `windows-x86_64`). A bundle may also be listed as `{os}-{arch}-{installer}`.
pub fn platform() -> Option<String> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        "linux" => "linux",
        _ => return None,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        "x86" => "i686",
        "arm" => "armv7",
        "riscv64" => "riscv64",
        _ => return None,
    };
    Some(format!("{os}-{arch}"))
}

/// What a feed offers this build: its version, when that is a stable release strictly newer than
/// `current` with a signed archive for `platform`. `Ok(None)` when there is nothing to install
/// here. `Err` when the feed is not one at all, which is a failed check.
pub fn newer(current: &Version, feed: &[u8], platform: &str) -> Result<Option<Version>, String> {
    let feed: Value =
        serde_json::from_slice(feed).map_err(|error| format!("the feed is not JSON: {error}"))?;
    let text = feed
        .get("version")
        .and_then(Value::as_str)
        .ok_or("the feed names no version")?;
    let version = Version::parse(text.strip_prefix('v').unwrap_or(text))
        .map_err(|error| format!("the feed's version {text:?} is not a version: {error}"))?;
    let platforms = feed
        .get("platforms")
        .and_then(Value::as_object)
        .ok_or("the feed lists no platforms")?;
    // Build metadata never makes a release newer, and a candidate is never offered to a stable app.
    let release = |v: &Version| (v.major, v.minor, v.patch);
    if !version.pre.is_empty() || release(&version) <= release(current) {
        return Ok(None);
    }
    let prefix = format!("{platform}-");
    let signed = platforms.iter().any(|(key, entry)| {
        (key == platform || key.starts_with(&prefix))
            && entry["url"].as_str().is_some_and(|url| !url.is_empty())
            && entry["signature"]
                .as_str()
                .is_some_and(|signature| !signature.is_empty())
    });
    Ok(signed.then_some(version))
}

/// Read the feed and say what it offers, from the first address that answers with a feed, as the
/// updater does: an address that fails, answers with an error status, or serves something that is
/// not a feed gives way to the next.
pub fn check(
    current: &Version,
    endpoints: &[reqwest::Url],
    platform: &str,
) -> Result<Option<Version>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let mut last = String::from("no feed address");
    for url in endpoints {
        let answer = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .map_err(|error| error.to_string())
            .and_then(|response| {
                if !response.status().is_success() {
                    return Err(format!("answered {}", response.status()));
                }
                let mut body = Vec::new();
                response
                    .take(LARGEST + 1)
                    .read_to_end(&mut body)
                    .map_err(|error| error.to_string())?;
                if body.len() as u64 > LARGEST {
                    return Err("the feed is larger than any feed".into());
                }
                Ok(body)
            })
            .and_then(|body| newer(current, &body, platform));
        match answer {
            Ok(found) => return Ok(found),
            Err(error) => last = format!("{url}: {error}"),
        }
    }
    Err(last)
}

/// Where a build that is offered updates reads its feed, and the version it asks about.
#[derive(Clone, Debug, PartialEq)]
pub struct Feed {
    pub current: Version,
    pub endpoints: Vec<reqwest::Url>,
    pub platform: String,
}

impl Feed {
    /// This build's feed, or `None` for a build offered no updates: an internal, candidate or
    /// pinned build (`offered_against`), one without the updater (`endpoints`), or a machine the
    /// updater has no name for (`platform`). The schedule and a check somebody asks for both start
    /// here, so they agree on which builds are offered anything.
    pub fn of(version: &Version, pinned: bool, updater: Option<&Value>) -> Option<Self> {
        Some(Self {
            current: offered_against(version, pinned)?,
            endpoints: endpoints(updater)?,
            platform: platform()?,
        })
    }

    pub fn read(&self) -> Result<Option<Version>, String> {
        check(&self.current, &self.endpoints, &self.platform)
    }
}

/// What a check somebody asked for found: Check for Updates… in a menu, or Check for updates in a
/// window. Tagged `found` for the page.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "found", rename_all = "camelCase")]
pub enum Asked {
    /// A newer version. Named even when this person closed the banner on it, because they asked.
    Available {
        version: String,
        current: String,
        /// How far it is from installing quickly (`Readiness`), when OpenBot has started on it.
        ready: Option<Readiness>,
    },
    UpToDate {
        current: String,
    },
    /// An update is already on its way in.
    Installing {
        version: String,
        current: String,
    },
    /// This build never updates itself: an internal or candidate build, or one without the updater.
    NotOffered {
        current: String,
    },
}

/// Read the feed now, for somebody who asked, and keep the answer as a scheduled read's is, so the
/// banner says the same. A feed that can't be read is `Err`: unlike the schedule's, this check has
/// somebody waiting for its answer.
pub fn ask(feed: Option<&Feed>, current: &Version, known: &Known) -> Result<Asked, String> {
    let current_text = current.to_string();
    if known.installing.lock().unwrap().is_some() {
        if let Some(version) = known.newer() {
            return Ok(Asked::Installing {
                version: version.to_string(),
                current: current_text,
            });
        }
    }
    let Some(feed) = feed else {
        return Ok(Asked::NotOffered {
            current: current_text,
        });
    };
    let answer = feed.read();
    known.record(&answer);
    Ok(match answer? {
        Some(version) => Asked::Available {
            ready: known.readiness(&version),
            version: version.to_string(),
            current: current_text,
        },
        None => Asked::UpToDate {
            current: current_text,
        },
    })
}

/// The menu item that asks, in the tray and in the OpenBot menu.
pub const MENU_ID: &str = "check-updates";
pub const MENU_LABEL: &str = "Check for Updates…";
pub const UPDATE: &str = "Update and restart";
pub const NOT_NOW: &str = "Not now";

/// A native dialog: its title, its text, and its two buttons when it asks something.
#[derive(Debug, PartialEq)]
pub struct Prompt {
    pub title: String,
    pub message: String,
    pub buttons: Option<(&'static str, &'static str)>,
}

/// What Check for Updates… says, whatever it found. The words are the setup window's.
pub fn prompt(asked: &Result<Asked, String>) -> Prompt {
    let say = |title: String, message: String| Prompt {
        title,
        message,
        buttons: None,
    };
    match asked {
        Ok(Asked::Available {
            version, current, ..
        }) => Prompt {
            title: format!("OpenBot {version} is available"),
            message: format!(
                "You are running {current}. Updating downloads the new version and restarts OpenBot."
            ),
            buttons: Some((UPDATE, NOT_NOW)),
        },
        Ok(Asked::UpToDate { current }) => say(
            "OpenBot is up to date".into(),
            format!("OpenBot {current} is up to date."),
        ),
        Ok(Asked::Installing { version, .. }) => say(
            "OpenBot is updating".into(),
            format!("OpenBot is downloading {version} and restarts when it's done."),
        ),
        Ok(Asked::NotOffered { .. }) => say(
            "This version of OpenBot doesn't update itself".into(),
            "Install a released version of OpenBot to get updates.".into(),
        ),
        Err(_) => say(
            "OpenBot couldn't check for updates".into(),
            "Check your internet connection and try again.".into(),
        ),
    }
}

/// An install somebody asked for that did not happen. By then they are waiting, so it is said.
pub fn install_failed(said: &str) -> Prompt {
    Prompt {
        title: "OpenBot couldn't install the update".into(),
        message: format!("{said}\n\nTry again with {MENU_LABEL}"),
        buttons: None,
    }
}

/// When the feed is next read: at launch, then once `every` has passed since the last read.
pub struct Schedule {
    every: Duration,
    last: Option<SystemTime>,
}

impl Schedule {
    pub fn new(every: Duration) -> Self {
        Self { every, last: None }
    }

    /// Whether to read the feed at `now`, by the wall clock. Asked the first time, yes. A clock set
    /// back since the last read also says yes, so a clock change never puts a read off for longer
    /// than one interval.
    pub fn due(&mut self, now: SystemTime) -> bool {
        let due = match self.last {
            None => true,
            Some(last) => now
                .duration_since(last)
                .map_or(true, |since| since >= self.every),
        };
        if due {
            self.last = Some(now);
        }
        due
    }
}

/// Read the feed on `schedule` for as long as `sleep` says to keep going: at once, then every
/// `TICK` asking the clock whether a read is due. `now` and `sleep` are the clock, so a test can
/// run a day of it in no time.
pub fn watch(
    mut schedule: Schedule,
    now: impl Fn() -> SystemTime,
    mut sleep: impl FnMut(Duration) -> bool,
    mut read: impl FnMut(),
) {
    loop {
        if schedule.due(now()) {
            read();
        }
        if !sleep(TICK) {
            return;
        }
    }
}

/**
How far the newer version is from installing in a few minutes: its images downloading in the
background while this version runs, or all of them here (`update_ready`). Tagged `state` for the
page.
*/
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Readiness {
    /// `done` of `total` bytes have arrived.
    Preparing { done: u64, total: u64 },
    /// Everything it downloads before it starts is here.
    Ready,
}

/// An update on its way in: how much of the archive has arrived, and whether it is restarting.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installing {
    pub downloaded: u64,
    pub total: Option<u64>,
    pub restarting: bool,
}

/// What the shell knows: the last good answer from the feed, an install under way, and how ready
/// the newer version is.
#[derive(Default)]
pub struct Known {
    newer: Mutex<Option<Version>>,
    installing: Mutex<Option<Installing>>,
    ready: Mutex<Option<(Version, Readiness)>>,
}

impl Known {
    /// Keep a check's answer. A failed check changes nothing: the last good answer stands, so a
    /// laptop that goes offline keeps offering what it last saw rather than forgetting it.
    pub fn record(&self, answer: &Result<Option<Version>, String>) {
        if let Ok(found) = answer {
            *self.newer.lock().unwrap() = found.clone();
        }
    }

    pub fn newer(&self) -> Option<Version> {
        self.newer.lock().unwrap().clone()
    }

    pub fn begin_install(&self) {
        *self.installing.lock().unwrap() = Some(Installing::default());
    }

    pub fn downloaded(&self, chunk: usize, total: Option<u64>) {
        if let Some(installing) = self.installing.lock().unwrap().as_mut() {
            installing.downloaded += chunk as u64;
            installing.total = total.or(installing.total);
        }
    }

    pub fn restarting(&self) {
        if let Some(installing) = self.installing.lock().unwrap().as_mut() {
            installing.restarting = true;
        }
    }

    pub fn end_install(&self) {
        *self.installing.lock().unwrap() = None;
    }

    /// Whether an install is under way, from the click on Update and restart.
    pub fn installing(&self) -> bool {
        self.installing.lock().unwrap().is_some()
    }

    /// How ready `version` is now. Replaces what was said of any other version.
    pub fn readying(&self, version: &Version, readiness: Readiness) {
        *self.ready.lock().unwrap() = Some((version.clone(), readiness));
    }

    /// Nothing is being got ready, or what was is no longer there.
    pub fn not_ready(&self) {
        *self.ready.lock().unwrap() = None;
    }

    /// How ready `version` is, when it is the version being got ready.
    pub fn readiness(&self, version: &Version) -> Option<Readiness> {
        self.ready
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(ready, _)| ready == version)
            .map(|(_, readiness)| readiness.clone())
    }
}

/// What a page shows.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The version to offer; `None` when there is none, or this person closed the offer on it.
    pub version: Option<String>,
    /// This app's own version.
    pub current: String,
    pub installing: Option<Installing>,
    /// Whether this build updates itself (`Feed::of` finds it a feed). An internal or candidate
    /// build, or one without the updater, never does, and a window says so up front.
    pub updates_itself: bool,
    /// How ready the offered version is to install (`Readiness`), when OpenBot has started on it.
    pub ready: Option<Readiness>,
}

/// What to offer, given what the feed said and what this person closed.
pub fn to_offer(newer: Option<&Version>, dismissed: Option<&Version>) -> Option<Version> {
    let newer = newer?;
    match dismissed {
        Some(dismissed) if dismissed >= newer => None,
        _ => Some(newer.clone()),
    }
}

pub fn status(
    known: &Known,
    current: &Version,
    config: Option<&Path>,
    updates_itself: bool,
) -> Status {
    let installing = known.installing.lock().unwrap().clone();
    let newer = known.newer();
    // An install under way keeps its version on screen whatever was closed before.
    let version = if installing.is_some() {
        newer
    } else {
        to_offer(newer.as_ref(), config.and_then(dismissed).as_ref())
    };
    Status {
        ready: version.as_ref().and_then(|v| known.readiness(v)),
        version: version.map(|v| v.to_string()),
        current: current.to_string(),
        installing,
        updates_itself,
    }
}

#[derive(Serialize, Deserialize)]
struct Dismissed {
    dismissed: String,
}

/// The version this person closed the offer on, if they did.
pub fn dismissed(config: &Path) -> Option<Version> {
    let text = std::fs::read_to_string(config.join(DISMISSED_FILE)).ok()?;
    let record: Dismissed = serde_json::from_str(&text).ok()?;
    Version::parse(&record.dismissed).ok()
}

/// Close the offer on `version`. The newest version closed is kept, so closing a page that had not
/// caught up yet never brings back a newer offer this person already closed.
pub fn dismiss(config: &Path, version: &Version) -> std::io::Result<()> {
    let keep = match dismissed(config) {
        Some(earlier) if earlier > *version => earlier,
        _ => version.clone(),
    };
    std::fs::create_dir_all(config)?;
    let target = config.join(DISMISSED_FILE);
    let partial = config.join(format!("{DISMISSED_FILE}.partial"));
    std::fs::write(
        &partial,
        serde_json::to_vec(&Dismissed {
            dismissed: keep.to_string(),
        })
        .map_err(std::io::Error::other)?,
    )?;
    std::fs::rename(partial, target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// The real `latest.json` downloads.copilotkit.ai served for 0.3.1 on 2026-11-06, byte for
    /// byte the same file as the GitHub release's.
    const REAL_0_3_1: &str = include_str!("../test-fixtures/app-update/latest-0.3.1.json");

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    /// The real feed with only its version changed, as the next release will publish it.
    fn real_feed_at(version: &str) -> String {
        let mut feed: Value = serde_json::from_str(REAL_0_3_1).unwrap();
        feed["version"] = Value::String(version.into());
        feed.to_string()
    }

    #[test]
    fn the_real_feed_offers_nothing_to_the_release_it_describes() {
        for platform in ["darwin-aarch64", "darwin-x86_64"] {
            assert_eq!(
                newer(&v("0.3.1"), REAL_0_3_1.as_bytes(), platform),
                Ok(None)
            );
        }
    }

    #[test]
    fn the_real_feed_offers_its_release_to_every_older_one() {
        for current in ["0.3.0", "0.2.9", "0.0.8"] {
            for platform in ["darwin-aarch64", "darwin-x86_64"] {
                assert_eq!(
                    newer(&v(current), REAL_0_3_1.as_bytes(), platform),
                    Ok(Some(v("0.3.1"))),
                    "{current} on {platform}"
                );
            }
        }
    }

    #[test]
    fn a_newer_release_of_the_real_feed_is_offered_and_an_older_one_is_not() {
        let next = real_feed_at("0.3.2");
        assert_eq!(
            newer(&v("0.3.1"), next.as_bytes(), "darwin-aarch64"),
            Ok(Some(v("0.3.2")))
        );
        // Real semver, not string order: 0.10.0 is newer than 0.9.0, 0.3.10 than 0.3.9.
        assert_eq!(
            newer(
                &v("0.9.0"),
                real_feed_at("0.10.0").as_bytes(),
                "darwin-aarch64"
            ),
            Ok(Some(v("0.10.0")))
        );
        assert_eq!(
            newer(
                &v("0.3.10"),
                real_feed_at("0.3.9").as_bytes(),
                "darwin-aarch64"
            ),
            Ok(None)
        );
        // A feed rolled back to an older release offers nothing; the updater would refuse it too.
        assert_eq!(
            newer(&v("0.3.2"), REAL_0_3_1.as_bytes(), "darwin-aarch64"),
            Ok(None)
        );
        // Tauri accepts a leading `v`, and so does this.
        assert_eq!(
            newer(
                &v("0.3.1"),
                real_feed_at("v0.3.2").as_bytes(),
                "darwin-x86_64"
            ),
            Ok(Some(v("0.3.2")))
        );
    }

    #[test]
    fn only_a_stable_release_counts() {
        for candidate in ["0.3.2-rc.1", "0.3.2-beta.2", "0.3.2-internal.731.gabc1234"] {
            assert_eq!(
                newer(
                    &v("0.3.1"),
                    real_feed_at(candidate).as_bytes(),
                    "darwin-aarch64"
                ),
                Ok(None),
                "{candidate}"
            );
        }
        // Build metadata is not a newer release.
        assert_eq!(
            newer(
                &v("0.3.1"),
                real_feed_at("0.3.1+mac").as_bytes(),
                "darwin-aarch64"
            ),
            Ok(None)
        );
    }

    /// The feed as the signing runs now write it (scripts/release-update-feed.sh): the real Mac
    /// entries Desktop macOS signing wrote, with the signed Windows installer that Desktop Windows
    /// signing added beside them, signed by `tauri signer sign` with a test key and installed from a
    /// test feed on Windows Server 2022.
    const NEXT_WITH_WINDOWS: &str =
        include_str!("../test-fixtures/app-update/latest-0.3.2-with-windows.json");

    #[test]
    fn a_release_that_lists_the_windows_installer_is_offered_on_windows_and_on_both_macs() {
        for platform in ["windows-x86_64", "darwin-aarch64", "darwin-x86_64"] {
            assert_eq!(
                newer(&v("0.3.1"), NEXT_WITH_WINDOWS.as_bytes(), platform),
                Ok(Some(v("0.3.2"))),
                "{platform}"
            );
        }
        // The key this machine's updater looks for is `{os}-{arch}`, spelled its way.
        if cfg!(all(windows, target_arch = "x86_64")) {
            assert_eq!(platform().as_deref(), Some("windows-x86_64"));
        }
        assert_eq!(
            newer(&v("0.3.2"), NEXT_WITH_WINDOWS.as_bytes(), "windows-x86_64"),
            Ok(None)
        );
    }

    #[test]
    fn a_release_with_no_signed_archive_for_this_machine_is_not_offered() {
        let next = real_feed_at("0.3.2");
        // The real feed is Mac only: Windows and Linux have nothing the updater could install.
        for platform in ["windows-x86_64", "linux-x86_64"] {
            assert_eq!(newer(&v("0.3.1"), next.as_bytes(), platform), Ok(None));
        }
        let mut unsigned: Value = serde_json::from_str(&next).unwrap();
        unsigned["platforms"]["darwin-aarch64"]["signature"] = Value::String(String::new());
        assert_eq!(
            newer(
                &v("0.3.1"),
                unsigned.to_string().as_bytes(),
                "darwin-aarch64"
            ),
            Ok(None)
        );
        // An installer-specific key, as the updater also looks for, is enough.
        let mut by_installer: Value = serde_json::from_str(&next).unwrap();
        let entry = by_installer["platforms"]["darwin-aarch64"].take();
        by_installer["platforms"] = serde_json::json!({ "darwin-aarch64-app": entry });
        assert_eq!(
            newer(
                &v("0.3.1"),
                by_installer.to_string().as_bytes(),
                "darwin-aarch64"
            ),
            Ok(Some(v("0.3.2")))
        );
    }

    #[test]
    fn something_that_is_not_a_feed_is_a_failed_check() {
        for broken in [
            "",
            "<html>Service Unavailable</html>",
            "{}",
            r#"{"version": 3}"#,
            r#"{"version": "latest", "platforms": {}}"#,
            r#"{"version": "0.3.2"}"#,
        ] {
            assert!(
                newer(&v("0.3.1"), broken.as_bytes(), "darwin-aarch64").is_err(),
                "{broken:?}"
            );
        }
    }

    #[test]
    fn a_failed_check_keeps_the_last_good_answer() {
        let known = Known::default();
        known.record(&Ok(Some(v("0.3.2"))));
        known.record(&Err("offline".into()));
        assert_eq!(known.newer(), Some(v("0.3.2")));
        // A good answer of "nothing newer" does replace it: the release was pulled.
        known.record(&Ok(None));
        assert_eq!(known.newer(), None);
    }

    #[test]
    fn internal_candidate_and_pinned_builds_are_never_offered_anything() {
        assert_eq!(offered_against(&v("0.3.1"), false), Some(v("0.3.1")));
        assert_eq!(offered_against(&v("0.3.1"), true), None);
        for build in [
            "0.3.1-internal.729.g14212047",
            "0.3.4-internal.860.g3b400d2c1abc",
            "0.3.2-rc.1",
            "0.3.2-beta.1",
        ] {
            assert_eq!(offered_against(&v(build), false), None, "{build}");
        }
    }

    /// The Windows installer's SemverCompare and this app order versions with this same `semver`
    /// crate. Two internal builds named only after their commits ordered by hash, so the later
    /// 4400ba02 read as older than d298debe and the installer warned against installing it. With
    /// the commit count `desktop-version.ts` puts first, the later commit is the newer build.
    #[test]
    fn internal_builds_order_by_their_commit_count_not_their_hash() {
        let earlier = v("0.3.2-internal.729.gd298debe26f2");
        let later = v("0.3.2-internal.730.g4400ba023e0c");
        assert!(later > earlier);
        assert!(v("0.3.2-internal.1000.g0123456789ab") > later);
        assert!(
            v("0.3.0-rc.1.internal.730.g4400ba023e0c") > v("0.3.0-rc.1.internal.729.gd298debe26f2")
        );
    }

    /// Built from main after 0.3.3 was released, `0.3.3-internal.860.g3b400d2c…` was a prerelease of
    /// 0.3.3 and ordered before it, so the Windows installer took the released 0.3.3 for the newer
    /// one. `desktop-version.ts` now makes it a prerelease of the next patch, which orders after the
    /// release it was built from and before every later one, here and in the installer alike.
    #[test]
    fn an_internal_build_orders_after_the_release_it_was_built_from() {
        assert!(v("0.3.3-internal.860.g3b400d2c1abc") < v("0.3.3"));
        let internal = v("0.3.4-internal.860.g3b400d2c1abc");
        assert!(internal > v("0.3.3"));
        assert!(internal > v("0.3.3-internal.860.g3b400d2c1abc"));
        for next in ["0.3.4", "0.4.0", "1.0.0"] {
            assert!(internal < v(next), "{next}");
        }
        // A candidate's internal build orders after it and before the next candidate.
        let candidate = v("0.3.0-rc.1.internal.731.gabc123456789");
        assert!(candidate > v("0.3.0-rc.1"));
        for next in ["0.3.0-rc.2", "0.3.0-rc.10", "0.3.0"] {
            assert!(candidate < v(next), "{next}");
        }
    }

    #[test]
    fn a_download_from_the_mirror_that_fails_is_tried_from_githubs_feed_and_githubs_is_not() {
        let signed: Value = serde_json::from_str(include_str!("../tauri.macos-signing.conf.json"))
            .expect("the signing overlay is JSON");
        let feeds = endpoints(Some(&signed["plugins"]["updater"])).unwrap();
        let url = |address: &str| reqwest::Url::parse(address).unwrap();
        assert_eq!(
            feed_after(
                &url("https://downloads.copilotkit.ai/releases/v1.0.0/OpenBot.app.tar.gz"),
                &feeds
            ),
            Some(url(
                "https://github.com/CopilotKit/OpenBot/releases/latest/download/latest.json"
            ))
        );
        for failed in [
            "https://github.com/CopilotKit/OpenBot/releases/download/v1.0.0/OpenBot.app.tar.gz",
            "https://example.com/OpenBot.app.tar.gz",
        ] {
            assert_eq!(feed_after(&url(failed), &feeds), None, "{failed}");
        }
    }

    #[test]
    fn the_feed_is_the_updaters_own_and_absent_without_one() {
        assert_eq!(endpoints(None), None);
        assert_eq!(endpoints(Some(&Value::Null)), None);
        let signed: Value = serde_json::from_str(include_str!("../tauri.macos-signing.conf.json"))
            .expect("the signing overlay is JSON");
        let found = endpoints(Some(&signed["plugins"]["updater"])).unwrap();
        assert_eq!(
            found.first().map(reqwest::Url::as_str),
            Some("https://downloads.copilotkit.ai/latest/latest.json")
        );
        // Plain HTTP only where the updater would also take it.
        let local = serde_json::json!({ "endpoints": ["http://127.0.0.1:9/latest.json"] });
        assert_eq!(endpoints(Some(&local)), None);
        let test_feed = serde_json::json!({
            "endpoints": ["http://127.0.0.1:9/latest.json"],
            "dangerousInsecureTransportProtocol": true
        });
        assert_eq!(endpoints(Some(&test_feed)).map(|f| f.len()), Some(1));
    }

    /// A day of the schedule on a pretend clock, five minutes a tick: a read at launch and one every
    /// six hours after, never more.
    #[test]
    fn the_feed_is_read_at_launch_and_every_six_hours() {
        let start = SystemTime::UNIX_EPOCH + Duration::from_secs(1_793_900_000);
        let clock = Arc::new(Mutex::new(start));
        let reads = Arc::new(Mutex::new(Vec::new()));
        let day = Duration::from_secs(24 * 60 * 60);
        watch(
            Schedule::new(EVERY),
            {
                let clock = clock.clone();
                move || *clock.lock().unwrap()
            },
            {
                let clock = clock.clone();
                move |tick| {
                    let mut now = clock.lock().unwrap();
                    *now += tick;
                    now.duration_since(start).unwrap() <= day
                }
            },
            {
                let clock = clock.clone();
                let reads = reads.clone();
                move || {
                    let at = clock.lock().unwrap().duration_since(start).unwrap();
                    reads.lock().unwrap().push(at.as_secs() / 3600);
                }
            },
        );
        assert_eq!(*reads.lock().unwrap(), vec![0, 6, 12, 18, 24]);
    }

    /// The lid shut for a day and a half: one read on waking, not four to catch up, and the next
    /// six hours after that.
    #[test]
    fn a_mac_that_slept_through_a_read_makes_it_up_once_on_waking() {
        let start = SystemTime::UNIX_EPOCH + Duration::from_secs(1_793_900_000);
        let hours = |h: u64| start + Duration::from_secs(h * 3600);
        let mut schedule = Schedule::new(EVERY);
        assert!(schedule.due(hours(0)));
        assert!(!schedule.due(hours(1)));
        assert!(schedule.due(hours(37)));
        assert!(!schedule.due(hours(37) + TICK));
        assert!(!schedule.due(hours(42)));
        assert!(schedule.due(hours(43)));
        // A clock set back reads at once rather than waiting for the old time to come round again.
        assert!(schedule.due(hours(20)));
        assert!(!schedule.due(hours(21)));
    }

    #[test]
    fn closing_the_offer_lasts_until_a_newer_version_comes_out() {
        let config = crate::test_support::temp_root("app-update-dismissed");
        let known = Known::default();
        known.record(&Ok(Some(v("0.3.2"))));
        let shown = |known: &Known| status(known, &v("0.3.1"), Some(&config), true).version;
        assert_eq!(shown(&known).as_deref(), Some("0.3.2"));

        dismiss(&config, &v("0.3.2")).unwrap();
        assert_eq!(shown(&known), None);
        // Kept on disk, so a reload or a restart reads the same answer.
        assert_eq!(dismissed(&config), Some(v("0.3.2")));
        let restarted = Known::default();
        restarted.record(&Ok(Some(v("0.3.2"))));
        assert_eq!(shown(&restarted), None);

        known.record(&Ok(Some(v("0.3.3"))));
        assert_eq!(shown(&known).as_deref(), Some("0.3.3"));

        // A page that had not caught up closing 0.3.2 again does not undo closing 0.3.3.
        dismiss(&config, &v("0.3.3")).unwrap();
        dismiss(&config, &v("0.3.2")).unwrap();
        assert_eq!(dismissed(&config), Some(v("0.3.3")));
        assert_eq!(shown(&known), None);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn an_install_under_way_stays_on_screen_and_reports_progress() {
        let config = crate::test_support::temp_root("app-update-installing");
        let known = Known::default();
        known.record(&Ok(Some(v("0.3.2"))));
        dismiss(&config, &v("0.3.2")).unwrap();
        known.begin_install();
        known.downloaded(50, Some(200));
        known.downloaded(50, None);
        let shown = status(&known, &v("0.3.1"), Some(&config), true);
        assert_eq!(shown.version.as_deref(), Some("0.3.2"));
        assert_eq!(
            shown.installing,
            Some(Installing {
                downloaded: 100,
                total: Some(200),
                restarting: false
            })
        );
        known.restarting();
        assert!(status(&known, &v("0.3.1"), Some(&config), true)
            .installing
            .is_some_and(|i| i.restarting));
        known.end_install();
        assert_eq!(
            status(&known, &v("0.3.1"), Some(&config), true).version,
            None
        );
        let _ = std::fs::remove_dir_all(&config);
    }

    /// The page says how ready the offered version is, and only of that version: a newer one the
    /// feed names since starts again from nothing.
    #[test]
    fn the_offer_says_how_ready_the_offered_version_is() {
        let known = Known::default();
        known.record(&Ok(Some(v("0.3.2"))));
        assert_eq!(status(&known, &v("0.3.1"), None, true).ready, None);
        known.readying(
            &v("0.3.2"),
            Readiness::Preparing {
                done: 40,
                total: 100,
            },
        );
        let shown = status(&known, &v("0.3.1"), None, true);
        assert_eq!(
            shown.ready,
            Some(Readiness::Preparing {
                done: 40,
                total: 100
            })
        );
        assert_eq!(
            serde_json::to_value(&shown).unwrap()["ready"],
            serde_json::json!({"state": "preparing", "done": 40, "total": 100})
        );
        known.readying(&v("0.3.2"), Readiness::Ready);
        assert_eq!(
            serde_json::to_value(status(&known, &v("0.3.1"), None, true)).unwrap()["ready"],
            serde_json::json!({"state": "ready"})
        );
        known.record(&Ok(Some(v("0.3.3"))));
        assert_eq!(status(&known, &v("0.3.1"), None, true).ready, None);
        known.not_ready();
        assert_eq!(known.readiness(&v("0.3.2")), None);
    }

    /// The test feed is for internal builds only: a stable or candidate build never reads it,
    /// whatever its environment says, and an internal build reads it only when it is set.
    #[test]
    fn only_an_internal_build_reads_the_test_feed() {
        let set = |name: &str| (name == TEST_FEED).then(|| "C:\\OpenBotTestFeed".into());
        for build in ["1.0.1", "1.0.0", "1.0.1-rc.2", "1.0.1-beta.1"] {
            assert_eq!(test_feed(&v(build), set), None, "{build}");
        }
        for build in [
            "1.0.1-internal.731.gabc123456789",
            "1.0.1-rc.2.internal.731.gabc123456789",
        ] {
            assert_eq!(
                test_feed(&v(build), set),
                Some(std::path::PathBuf::from("C:\\OpenBotTestFeed")),
                "{build}"
            );
        }
        let internal = v("1.0.1-internal.731.gabc123456789");
        assert_eq!(test_feed(&internal, |_| None), None);
        assert_eq!(test_feed(&internal, |_| Some("".into())), None);
    }

    /// A test feed offers the build its `latest.json` names when it is a later build, by the
    /// commit count an internal version carries, and says what is wrong with one it cannot read.
    #[test]
    fn a_test_feed_offers_a_later_internal_build() {
        let folder = crate::test_support::temp_root("app-update-test-feed");
        std::fs::create_dir_all(&folder).unwrap();
        let running = v("1.0.1-internal.731.gabc123456789");
        assert!(test_newer(&running, &folder)
            .unwrap_err()
            .contains("could not read"));
        std::fs::write(
            folder.join("latest.json"),
            r#"{"version": "1.0.1-internal.735.gdef123456789"}"#,
        )
        .unwrap();
        assert_eq!(
            test_newer(&running, &folder),
            Ok(Some(v("1.0.1-internal.735.gdef123456789")))
        );
        assert_eq!(
            test_newer(&v("1.0.1-internal.735.gdef123456789"), &folder),
            Ok(None)
        );
        assert_eq!(
            test_newer(&v("1.0.1-internal.740.g0123456789ab"), &folder),
            Ok(None)
        );
        std::fs::write(folder.join("latest.json"), "{}").unwrap();
        assert!(test_newer(&running, &folder)
            .unwrap_err()
            .contains("names no version"));
        std::fs::remove_dir_all(folder).unwrap();
    }

    /// A one-shot HTTP server on 127.0.0.1 answering each request with the next of `answers`.
    fn serve(answers: Vec<(u16, String)>) -> (reqwest::Url, std::thread::JoinHandle<usize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = reqwest::Url::parse(&format!(
            "http://127.0.0.1:{}/latest/latest.json",
            listener.local_addr().unwrap().port()
        ))
        .unwrap();
        let server = std::thread::spawn(move || {
            let mut served = 0;
            for (status, body) in answers {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0u8; 4096];
                let _ = std::io::Read::read(&mut stream, &mut request);
                write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
                served += 1;
            }
            served
        });
        (url, server)
    }

    /// The real read, over real HTTP, of the real feed with a newer version.
    #[test]
    fn reading_a_feed_over_http_finds_the_newer_release() {
        let (url, server) = serve(vec![(200, real_feed_at("0.3.2"))]);
        assert_eq!(
            check(&v("0.3.1"), &[url], "darwin-aarch64"),
            Ok(Some(v("0.3.2")))
        );
        assert_eq!(server.join().unwrap(), 1);
    }

    /// As the updater does: an address that answers with an error, or with something that is not a
    /// feed, gives way to the next; with none left the check fails and changes nothing.
    #[test]
    fn a_failing_address_gives_way_to_the_next() {
        let (down, down_server) = serve(vec![(503, "<html>down</html>".into())]);
        let (broken, broken_server) = serve(vec![(200, "<html>captive portal</html>".into())]);
        let (good, good_server) = serve(vec![(200, real_feed_at("0.3.2"))]);
        assert_eq!(
            check(&v("0.3.1"), &[down, broken, good], "darwin-aarch64"),
            Ok(Some(v("0.3.2")))
        );
        for server in [down_server, broken_server, good_server] {
            assert_eq!(server.join().unwrap(), 1);
        }
        let (only, only_server) = serve(vec![(404, "not found".into())]);
        assert!(check(&v("0.3.1"), &[only], "darwin-aarch64").is_err());
        only_server.join().unwrap();
    }

    /// The updater block a signed Windows release ships (`tauri.windows-signing.conf.json`), read
    /// from `url` instead, as the updater's own local test feed switch allows.
    fn release_updater(url: &reqwest::Url) -> Value {
        let mut overlay: Value =
            serde_json::from_str(include_str!("../tauri.windows-signing.conf.json")).unwrap();
        let mut block = overlay["plugins"]["updater"].take();
        block["endpoints"] = serde_json::json!([url.as_str()]);
        block["dangerousInsecureTransportProtocol"] = Value::Bool(true);
        block
    }

    /// A release's feed at `version` with a signed archive for the machine running the test.
    fn feed_for_this_machine(version: &str) -> String {
        let mut feed: Value = serde_json::from_str(NEXT_WITH_WINDOWS).unwrap();
        feed["version"] = Value::String(version.into());
        let entry = feed["platforms"]["windows-x86_64"].clone();
        feed["platforms"][platform().unwrap()] = entry;
        feed.to_string()
    }

    /// The signed releases carry the updater, so a check asked for on one reads the real feed, the
    /// downloads mirror first. The setup window's check used to ask a separate mechanism that
    /// release builds do not carry, and said updates were not configured.
    #[test]
    fn a_signed_release_is_offered_updates_from_the_downloads_mirror() {
        for overlay in [
            include_str!("../tauri.windows-signing.conf.json"),
            include_str!("../tauri.macos-signing.conf.json"),
        ] {
            let overlay: Value = serde_json::from_str(overlay).unwrap();
            let feed = Feed::of(&v("0.3.2"), false, Some(&overlay["plugins"]["updater"]))
                .expect("a signed release is offered updates");
            assert_eq!(feed.current, v("0.3.2"));
            assert_eq!(
                feed.endpoints.first().map(reqwest::Url::as_str),
                Some("https://downloads.copilotkit.ai/latest/latest.json")
            );
            assert_eq!(Some(feed.platform), platform());
        }
    }

    #[test]
    fn asked_on_the_newest_release_it_says_it_is_up_to_date() {
        let (url, server) = serve(vec![(200, feed_for_this_machine("0.3.2"))]);
        let known = Known::default();
        let feed = Feed::of(&v("0.3.2"), false, Some(&release_updater(&url)));
        assert_eq!(
            ask(feed.as_ref(), &v("0.3.2"), &known),
            Ok(Asked::UpToDate {
                current: "0.3.2".into()
            })
        );
        assert_eq!(server.join().unwrap(), 1);
        assert_eq!(known.newer(), None);
    }

    /// Asked for, a newer version is named even after this person closed the banner on it. The
    /// answer is kept, so the banner agrees from then on.
    #[test]
    fn asked_on_an_older_release_it_offers_the_newer_one_even_if_closed_before() {
        let config = crate::test_support::temp_root("app-update-asked");
        dismiss(&config, &v("0.3.3")).unwrap();
        let (url, server) = serve(vec![(200, feed_for_this_machine("0.3.3"))]);
        let known = Known::default();
        let feed = Feed::of(&v("0.3.2"), false, Some(&release_updater(&url)));
        assert_eq!(
            ask(feed.as_ref(), &v("0.3.2"), &known),
            Ok(Asked::Available {
                version: "0.3.3".into(),
                current: "0.3.2".into(),
                ready: None,
            })
        );
        server.join().unwrap();
        assert_eq!(known.newer(), Some(v("0.3.3")));
        // The banner still keeps the person's close.
        assert_eq!(
            status(&known, &v("0.3.2"), Some(&config), true).version,
            None
        );
        let _ = std::fs::remove_dir_all(&config);
    }

    /// Internal and candidate builds, and builds without the updater, say so, and never read a feed.
    #[test]
    fn a_build_offered_no_updates_says_so_without_reading_anything() {
        let url = reqwest::Url::parse("http://127.0.0.1:9/latest.json").unwrap();
        let release = release_updater(&url);
        assert_eq!(Feed::of(&v("0.3.2"), false, None), None);
        assert_eq!(Feed::of(&v("0.3.2"), true, Some(&release)), None);
        for build in ["0.3.2-internal.731.gabc1234", "0.3.3-rc.1"] {
            assert_eq!(Feed::of(&v(build), false, Some(&release)), None, "{build}");
        }
        assert_eq!(
            ask(None, &v("0.3.2-internal.731.gabc1234"), &Known::default()),
            Ok(Asked::NotOffered {
                current: "0.3.2-internal.731.gabc1234".into()
            })
        );
    }

    /// The setup window reads `updatesItself` before anybody checks, so a build that never updates
    /// itself says so up front and never promises updates.
    #[test]
    fn the_status_says_whether_this_build_updates_itself() {
        let internal = v("0.3.2-internal.731.gabc1234");
        let fixed = status(&Known::default(), &internal, None, false);
        assert_eq!(
            serde_json::to_value(&fixed).unwrap(),
            serde_json::json!({
                "version": null,
                "current": "0.3.2-internal.731.gabc1234",
                "installing": null,
                "updatesItself": false,
                "ready": null,
            })
        );
        let release = status(&Known::default(), &v("0.3.2"), None, true);
        assert_eq!(
            serde_json::to_value(&release).unwrap()["updatesItself"],
            serde_json::json!(true)
        );
    }

    /// A feed that can't be read is said to whoever asked, and the last good answer stands.
    #[test]
    fn a_check_that_fails_says_so_and_keeps_the_last_answer() {
        let (url, server) = serve(vec![(503, "<html>down</html>".into())]);
        let known = Known::default();
        known.record(&Ok(Some(v("0.3.3"))));
        let feed = Feed::of(&v("0.3.2"), false, Some(&release_updater(&url)));
        let asked = ask(feed.as_ref(), &v("0.3.2"), &known);
        assert!(asked.is_err());
        server.join().unwrap();
        assert_eq!(known.newer(), Some(v("0.3.3")));
        assert_eq!(prompt(&asked).title, "OpenBot couldn't check for updates");
    }

    #[test]
    fn asked_while_an_update_downloads_it_says_so() {
        let known = Known::default();
        known.record(&Ok(Some(v("0.3.3"))));
        known.begin_install();
        // No feed is read: the address answers nothing.
        let url = reqwest::Url::parse("http://127.0.0.1:9/latest.json").unwrap();
        let feed = Feed::of(&v("0.3.2"), false, Some(&release_updater(&url)));
        assert_eq!(
            ask(feed.as_ref(), &v("0.3.2"), &known),
            Ok(Asked::Installing {
                version: "0.3.3".into(),
                current: "0.3.2".into()
            })
        );
    }

    /// The page reads `found`, in the words the setup window's TypeScript names.
    #[test]
    fn a_check_reads_as_the_page_expects() {
        let as_json = |asked: Asked| serde_json::to_value(asked).unwrap();
        assert_eq!(
            as_json(Asked::Available {
                version: "0.3.3".into(),
                current: "0.3.2".into(),
                ready: None,
            }),
            serde_json::json!({"found": "available", "version": "0.3.3", "current": "0.3.2", "ready": null})
        );
        assert_eq!(
            as_json(Asked::UpToDate {
                current: "0.3.2".into()
            }),
            serde_json::json!({"found": "upToDate", "current": "0.3.2"})
        );
        assert_eq!(
            as_json(Asked::NotOffered {
                current: "0.3.2".into()
            }),
            serde_json::json!({"found": "notOffered", "current": "0.3.2"})
        );
    }

    #[test]
    fn check_for_updates_says_what_it_found() {
        assert_eq!(
            prompt(&Ok(Asked::Available {
                version: "0.3.3".into(),
                current: "0.3.2".into(),
                ready: None,
            })),
            Prompt {
                title: "OpenBot 0.3.3 is available".into(),
                message:
                    "You are running 0.3.2. Updating downloads the new version and restarts OpenBot."
                        .into(),
                buttons: Some(("Update and restart", "Not now")),
            }
        );
        let up_to_date = prompt(&Ok(Asked::UpToDate {
            current: "0.3.2".into(),
        }));
        assert_eq!(up_to_date.title, "OpenBot is up to date");
        assert_eq!(up_to_date.message, "OpenBot 0.3.2 is up to date.");
        assert_eq!(up_to_date.buttons, None);
        let not_offered = prompt(&Ok(Asked::NotOffered {
            current: "0.3.2-internal.1.gabc".into(),
        }));
        assert!(!not_offered.message.contains("configured"));
        assert!(install_failed("The download didn't finish.")
            .message
            .ends_with("Try again with Check for Updates…"));
    }
}
