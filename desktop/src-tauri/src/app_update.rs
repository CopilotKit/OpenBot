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
/// The builds the updater serves: a stable release that is not pinned. Internal builds
/// (`0.3.1-internal.<commits>.g…`) and candidates (`-rc.N`, `-beta.N`) are pinned to the release they were
/// made from and carry no updater, so an offer there could never be installed.
pub fn offered_against(version: &Version, pinned: bool) -> Option<Version> {
    (!pinned && version.pre.is_empty()).then(|| version.clone())
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

/// An update on its way in: how much of the archive has arrived, and whether it is restarting.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installing {
    pub downloaded: u64,
    pub total: Option<u64>,
    pub restarting: bool,
}

/// What the shell knows: the last good answer from the feed, and an install under way.
#[derive(Default)]
pub struct Known {
    newer: Mutex<Option<Version>>,
    installing: Mutex<Option<Installing>>,
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
}

/// What to offer, given what the feed said and what this person closed.
pub fn to_offer(newer: Option<&Version>, dismissed: Option<&Version>) -> Option<Version> {
    let newer = newer?;
    match dismissed {
        Some(dismissed) if dismissed >= newer => None,
        _ => Some(newer.clone()),
    }
}

pub fn status(known: &Known, current: &Version, config: Option<&Path>) -> Status {
    let installing = known.installing.lock().unwrap().clone();
    let newer = known.newer();
    // An install under way keeps its version on screen whatever was closed before.
    let version = if installing.is_some() {
        newer
    } else {
        to_offer(newer.as_ref(), config.and_then(dismissed).as_ref())
    };
    Status {
        version: version.map(|v| v.to_string()),
        current: current.to_string(),
        installing,
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
        for build in ["0.3.1-internal.729.g14212047", "0.3.2-rc.1", "0.3.2-beta.1"] {
            assert_eq!(offered_against(&v(build), false), None, "{build}");
        }
    }

    /// The Windows installer's SemverCompare and this app order versions with this same `semver`
    /// crate. Two internal builds named only after their commits ordered by hash, so the later
    /// 4400ba02 read as older than d298debe and the installer warned against installing it. With
    /// the commit count `desktop-version.ts` puts first, the later commit is the newer build, and
    /// the release still orders after every internal build of it.
    #[test]
    fn internal_builds_order_by_their_commit_count_not_their_hash() {
        let earlier = v("0.3.1-internal.729.gd298debe26f2");
        let later = v("0.3.1-internal.730.g4400ba023e0c");
        assert!(later > earlier);
        assert!(v("0.3.1-internal.1000.g0123456789ab") > later);
        assert!(v("0.3.1") > later);
        assert!(
            v("0.3.0-rc.1-internal.730.g4400ba023e0c") > v("0.3.0-rc.1-internal.729.gd298debe26f2")
        );
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
        let shown = |known: &Known| status(known, &v("0.3.1"), Some(&config)).version;
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
        let shown = status(&known, &v("0.3.1"), Some(&config));
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
        assert!(status(&known, &v("0.3.1"), Some(&config))
            .installing
            .is_some_and(|i| i.restarting));
        known.end_install();
        assert_eq!(status(&known, &v("0.3.1"), Some(&config)).version, None);
        let _ = std::fs::remove_dir_all(&config);
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
}
