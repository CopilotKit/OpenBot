//! Choose a release for a deployment: the release a deployment already has, otherwise the exact
//! build a pinned app was cut with, otherwise the latest public release, or the app's own when the
//! app is newer or when the latest needs a newer app to start it. And where releases come from: the
//! distribution this installation follows.
//!
//! WHAT STARTS A RELEASE IS A CONTRACT WITH A NUMBER. This app starts the back end from the
//! release's Compose file, with settings it writes into `.env` and secrets it hands Compose: the
//! launcher's side of the contract, numbered `compatibility.launcherApi` in `release-policy.json`
//! and in every release's `release-manifest.json`. A release whose number is above the one this app
//! was built with needs something this app does not write. It is never laid out for a first install
//! (the app's own release is) and never started (the window says "Update OpenBot"); see
//! [`launcher_api`]. A release one number behind starts as it always has: the app still writes
//! what that release reads (`install_token`, for one, is read back from a server that predates it).

use std::path::Path;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::deployment;
use crate::problem::Problem;

/// Where an installation's releases come from, when it names a distributor of its own.
pub const DISTRIBUTION: &str = ".openbot-distribution.json";

/// The distributor whose releases an installation follows: the repository its source tarballs,
/// image lists and latest release come from, and the channel and identity the signed app updater
/// checks its own updates against.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Distribution {
    pub distribution_id: String,
    pub repository: String,
    pub channel: String,
    /// Read so a file written for the earlier staged updater, which checked a release's required
    /// Intelligence capabilities against it, still parses. Nothing uses it now.
    #[serde(default)]
    pub intelligence_capabilities: Vec<String>,
}

fn repository(value: &str) -> bool {
    let parts: Vec<_> = value.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        })
}

pub fn distribution_defaults(
    id: Option<&str>,
    repository: Option<&str>,
    channel: Option<&str>,
) -> Distribution {
    let repository = repository
        .filter(|v| !v.is_empty())
        .unwrap_or("CopilotKit/OpenBot");
    Distribution {
        distribution_id: id.filter(|v| !v.is_empty()).unwrap_or(repository).into(),
        repository: repository.into(),
        channel: channel.filter(|v| !v.is_empty()).unwrap_or("stable").into(),
        intelligence_capabilities: Vec::new(),
    }
}

/// The distributor this app was built for.
pub fn compiled_distribution() -> Distribution {
    distribution_defaults(
        option_env!("OPENBOT_DISTRIBUTION_ID"),
        option_env!("OPENBOT_RELEASE_REPOSITORY"),
        option_env!("OPENBOT_RELEASE_CHANNEL"),
    )
}

/// The distributor `root` follows: its own `.openbot-distribution.json`, or the one this app was
/// built for.
pub fn distribution(root: &Path) -> Result<Distribution, String> {
    let policy = match std::fs::read(root.join(DISTRIBUTION)) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("invalid {DISTRIBUTION}: {e}"))?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => compiled_distribution(),
        Err(e) => return Err(e.to_string()),
    };
    if policy.distribution_id.trim().is_empty()
        || policy.channel.trim().is_empty()
        || !repository(&policy.repository)
    {
        return Err("invalid configured distribution".into());
    }
    Ok(policy)
}

pub fn latest_url(policy: &Distribution) -> String {
    format!(
        "https://api.github.com/repos/{}/releases/latest",
        policy.repository
    )
}

/// The release Install lays out in `root`. Uses blocking HTTP, so callers in an async runtime must
/// use a blocking task.
///
/// A deployment that is there keeps its release: Install and Repair never change it. Moving it to
/// this app's own release is Start's job (see `upgrade`), with its backup and its way back. Only a
/// new deployment, one from before the server was a Compose service
/// (`deployment::predates_containers`, which this app cannot run), or one of the other kind
/// (pinned or followed) that never finished laying out gets a fresh release: the one a pinned build
/// was cut with, otherwise the latest the distribution has published, or this app's own release
/// when the app is newer (`newer`) or the latest needs a newer app ([`launcher_api`]). The fetcher
/// records the exact tag after the source and image manifest have both downloaded.
pub fn resolve_version(root: &Path) -> Result<String, String> {
    let own = crate::upgrade::app_release();
    resolve_version_with(
        root,
        deployment::pinned().as_ref(),
        &own,
        || {
            let policy = distribution(root)?;
            // OpenBot's own releases: the app update feed on downloads.copilotkit.ai names the same
            // Latest release, and GitHub is asked only when it cannot be read.
            if policy.repository == "CopilotKit/OpenBot" {
                match deployment::get_from_mirror(LATEST_FEED).and_then(|body| feed_tag(&body)) {
                    Ok(tag) => return Ok(tag),
                    Err(error) => {
                        log::warn!("[download] {error}; asking GitHub for the latest release")
                    }
                }
            }
            let body = deployment::get(&latest_url(&policy))
                .map_err(|error| format!("could not find the latest OpenBot release: {error}"))?;
            release_tag(&body)
        },
        launcher_api(),
        |version| release_launcher_api(root, version, &deployment::get),
    )
}

/// What this app writes and hands the back end it starts: `compatibility.launcherApi` of the
/// `release-policy.json` it was built from, which its own release publishes too.
pub fn launcher_api() -> u32 {
    static SPOKEN: OnceLock<u32> = OnceLock::new();
    *SPOKEN.get_or_init(|| {
        launcher_api_of(include_bytes!("../../../release-policy.json"))
            .expect("release-policy.json names compatibility.launcherApi")
    })
}

/// The release asset that says what a release is compatible with, `launcherApi` among it.
pub const RELEASE_MANIFEST: &str = "release-manifest.json";

/// Where `version` of `policy`'s distribution publishes its [`RELEASE_MANIFEST`].
pub fn release_manifest_url(policy: &Distribution, version: &str) -> String {
    format!(
        "https://github.com/{}/releases/download/{version}/{RELEASE_MANIFEST}",
        policy.repository
    )
}

/// `compatibility.launcherApi` of a release manifest, or of `release-policy.json`, which carries it
/// in the same place. Everything else in either is not read here.
pub fn launcher_api_of(body: &[u8]) -> Result<u32, String> {
    #[derive(Deserialize)]
    struct Compatibility {
        #[serde(rename = "launcherApi")]
        launcher_api: u32,
    }
    #[derive(Deserialize)]
    struct Manifest {
        compatibility: Compatibility,
    }
    let read: Manifest = serde_json::from_slice(body)
        .map_err(|error| format!("names no compatibility.launcherApi: {error}"))?;
    if read.compatibility.launcher_api == 0 {
        return Err("names launcherApi 0, which no release is".into());
    }
    Ok(read.compatibility.launcher_api)
}

/// The launcher contract `version` of the distribution `root` follows needs, from the manifest it
/// published, downloaded through `get`.
pub fn release_launcher_api(
    root: &Path,
    version: &str,
    get: deployment::Download,
) -> Result<u32, String> {
    let url = release_manifest_url(&distribution(root)?, version);
    let body = get(&url).map_err(|error| format!("could not read {url}: {error}"))?;
    launcher_api_of(&body).map_err(|error| format!("{url} {error}"))
}

/// Whether this app, speaking launcher contract `speaks`, can start a release that needs `needs`.
/// The same number starts. A lower one starts too: the app keeps writing what an older release
/// reads, and Start moves a release older than the app to the app's own anyway. Only a higher one
/// needs a newer app.
pub fn starts(needs: u32, speaks: u32) -> bool {
    needs <= speaks
}

/**
Whether the release laid out in `root` needs a newer app than this one to start: a release newer
than the app (one an earlier, newer app laid out, or one a first install from an app that did not
read this number took), whose manifest names a launcher contract above this app's. Then Start
leaves it as it is, stopped, and the window says "Update OpenBot" with this app's update: never moved
back to the app's own, whose database it is already past (`upgrade`).

Only a release newer than the app is asked about, since the number never goes down from one release
to the next, and asked once, with no retries: offline, or with no answer, it starts as it did before
this check, and a server too new for this app then says so itself. Blocking HTTP: from a blocking task.
*/
pub fn start_problem(root: &Path) -> Option<Problem> {
    start_problem_with(
        root,
        &crate::upgrade::app_release(),
        launcher_api(),
        &get_once,
    )
}

/// [`start_problem`] for an app of release `own` speaking `speaks`, downloading through `get`.
pub fn start_problem_with(
    root: &Path,
    own: &str,
    speaks: u32,
    get: deployment::Download,
) -> Option<Problem> {
    let installed = deployment::installed(root)?;
    let version = |tag: &str| semver::Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok();
    match (version(&installed.version), version(own)) {
        (Some(laid_out), Some(app)) if laid_out > app => {}
        _ => return None,
    }
    match release_launcher_api(root, &installed.version, get) {
        Ok(needs) if !starts(needs, speaks) => Some(crate::client_version::local_app_too_old(
            format!(
                "OpenBot {} needs launcherApi {needs}; this app is {own} and speaks launcherApi {speaks}",
                installed.version
            ),
        )),
        Ok(_) => None,
        Err(error) => {
            log::warn!(
                "[start] could not tell which launcher contract {} needs, so it starts as before: {error}",
                installed.version
            );
            None
        }
    }
}

/// One try at each copy of a download, downloads.copilotkit.ai's and then GitHub's, with no retries.
fn get_once(url: &str) -> Result<Vec<u8>, String> {
    if let Some(copy) = deployment::mirrored(url) {
        match deployment::get_from_mirror(&copy) {
            Ok(body) => return Ok(body),
            Err(error) => log::warn!("[download] {error}; asking for {url} instead"),
        }
    }
    deployment::get_from_mirror(url)
}

/// The app update feed for the Latest release, copied to downloads.copilotkit.ai as each stable
/// release becomes Latest.
const LATEST_FEED: &str = "https://downloads.copilotkit.ai/latest/latest.json";

/// The release tag the update feed names: its `version` is the tag without its `v`.
fn feed_tag(body: &[u8]) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Feed {
        version: String,
    }
    let feed: Feed = serde_json::from_slice(body)
        .map_err(|error| format!("{LATEST_FEED} is not readable: {error}"))?;
    let version = feed.version.trim().trim_start_matches('v');
    if version.is_empty() {
        return Err(format!("{LATEST_FEED} names no version"));
    }
    Ok(format!("v{version}"))
}

/// With an installed deployment of this build's kind, or one laid out completely, its own version.
/// Otherwise the pin's version when there is one, and the newer of `latest` and `own` (the app's
/// own release) only when there is not, as long as this app, speaking launcher contract `speaks`,
/// can start it: a latest release that needs a newer app, or whose need cannot be read
/// (`launcher_api_of`), gives way to `own`, which this app always can. The person is offered the
/// newer app as every launch offers it (`app_update`), and Start moves the installation on once
/// they take it.
fn resolve_version_with(
    root: &Path,
    pinned: Option<&deployment::Pin>,
    own: &str,
    latest: impl FnOnce() -> Result<String, String>,
    speaks: u32,
    launcher_api_of: impl FnOnce(&str) -> Result<u32, String>,
) -> Result<String, String> {
    match deployment::installed(root) {
        Some(installed)
            if !deployment::predates_containers(root)
                && (installed.pinned == pinned.is_some()
                    || deployment::images_path(root).is_file()) =>
        {
            Ok(installed.version)
        }
        _ => match pinned {
            Some(pin) => Ok(pin.version.clone()),
            None => {
                let chosen = newer(latest()?, own);
                if chosen == own {
                    return Ok(chosen);
                }
                match launcher_api_of(&chosen) {
                    Ok(needs) if starts(needs, speaks) => Ok(chosen),
                    Ok(needs) => {
                        log::warn!(
                            "[download] OpenBot {chosen} needs launcherApi {needs} and this app speaks {speaks}: laying out this app's own {own}, and offering the app's update"
                        );
                        Ok(own.to_string())
                    }
                    Err(error) => {
                        log::warn!(
                            "[download] could not tell which launcher contract OpenBot {chosen} needs ({error}): laying out this app's own {own}"
                        );
                        Ok(own.to_string())
                    }
                }
            }
        },
    }
}

/// The latest release, or `own` when the app is newer than it.
///
/// A release laid out older than the app is moved to the app's own at the first Start
/// (`upgrade::due`), which downloads every image a second time straight after setup. The latest
/// release can be older than the app that asks: v1.0.1's installers were on GitHub's Latest release
/// at 18:17 UTC on 2026-11-10, and the update feed named v1.0.0 until 18:25, and for its five-minute
/// cache after. A tag that is not a version leaves the latest release as it is.
fn newer(latest: String, own: &str) -> String {
    let version = |tag: &str| semver::Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok();
    match (version(&latest), version(own)) {
        (Some(found), Some(app)) if app > found => own.to_string(),
        _ => latest,
    }
}

fn release_tag(body: &[u8]) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Release {
        tag_name: String,
    }

    let release: Release = serde_json::from_slice(body)
        .map_err(|error| format!("the latest OpenBot release is not readable: {error}"))?;
    if release.tag_name.trim().is_empty() {
        return Err("the latest OpenBot release has no version tag".into());
    }
    Ok(release.tag_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    /// An app older than every release these tests name, so the latest release is what they get.
    const OLDER: &str = "v0.0.1";

    fn scratch(label: &str) -> std::path::PathBuf {
        let root = temp_root(label);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// [`resolve_version_with`] where every release needs the launcher contract this app speaks,
    /// for the choices that are not about that.
    fn resolve(
        root: &Path,
        pinned: Option<&deployment::Pin>,
        own: &str,
        latest: impl FnOnce() -> Result<String, String>,
    ) -> Result<String, String> {
        resolve_version_with(root, pinned, own, latest, launcher_api(), |_| {
            Ok(launcher_api())
        })
    }

    /// v1.1.0's own release manifest, as GitHub serves it, and the same with another launcherApi:
    /// what a later release that raised it would publish.
    const V1_1_0_MANIFEST: &[u8] = include_bytes!("../test-fixtures/release-manifest-v1.1.0.json");
    fn manifest_needing(launcher_api: u32) -> Vec<u8> {
        let mut manifest: serde_json::Value = serde_json::from_slice(V1_1_0_MANIFEST).unwrap();
        manifest["compatibility"]["launcherApi"] = launcher_api.into();
        serde_json::to_vec(&manifest).unwrap()
    }

    /// The distribution's releases, as a download: each version's manifest by its address, and
    /// every address asked for, in order.
    struct Releases {
        manifests: Vec<(&'static str, Vec<u8>)>,
        asked: std::cell::RefCell<Vec<String>>,
    }
    impl Releases {
        fn get(&self, url: &str) -> Result<Vec<u8>, String> {
            self.asked.borrow_mut().push(url.to_string());
            self.manifests
                .iter()
                .find(|(version, _)| {
                    url == format!(
                        "https://github.com/CopilotKit/OpenBot/releases/download/{version}/release-manifest.json"
                    )
                })
                .map(|(_, body)| body.clone())
                .ok_or_else(|| format!("{url} answered 404"))
        }
    }

    #[test]
    fn this_app_speaks_the_launcher_contract_its_release_policy_names() {
        let policy: serde_json::Value =
            serde_json::from_slice(include_bytes!("../../../release-policy.json")).unwrap();
        assert_eq!(
            u64::from(launcher_api()),
            policy["compatibility"]["launcherApi"].as_u64().unwrap()
        );
        // And reads it out of a real release's manifest the same way.
        assert_eq!(launcher_api_of(V1_1_0_MANIFEST), Ok(1));
        assert!(launcher_api_of(b"{}").is_err());
        assert!(launcher_api_of(br#"{"compatibility":{"launcherApi":0}}"#).is_err());
        assert_eq!(
            release_manifest_url(&distribution_defaults(None, None, None), "v1.1.0"),
            "https://github.com/CopilotKit/OpenBot/releases/download/v1.1.0/release-manifest.json"
        );
    }

    /// Design 6.5, step 2: an app meeting a latest release whose launcher contract is above its own
    /// lays out its own release for a first install, and the latest one only once it is updated.
    #[test]
    fn a_first_install_lays_out_the_apps_own_release_when_the_latest_needs_a_newer_app() {
        let root = scratch("release-launcher-ahead");
        let releases = Releases {
            manifests: vec![
                ("v1.3.0", manifest_needing(2)),
                ("v1.2.0", manifest_needing(1)),
            ],
            asked: Default::default(),
        };
        let get = |url: &str| releases.get(url);
        let from = |latest: &'static str, speaks: u32| {
            resolve_version_with(
                &root,
                None,
                "v1.1.1",
                || Ok(latest.into()),
                speaks,
                |version| release_launcher_api(&root, version, &get),
            )
            .unwrap()
        };
        // Beyond this app: its own release, which it can start.
        assert_eq!(from("v1.3.0", 1), "v1.1.1");
        // The same contract: the latest, as before.
        assert_eq!(from("v1.2.0", 1), "v1.2.0");
        // An app of the newer contract takes the latest.
        assert_eq!(from("v1.3.0", 2), "v1.3.0");
        // A latest release whose manifest cannot be read: the app's own, which it knows it can start.
        assert_eq!(from("v1.4.0", 1), "v1.1.1");
        // Nothing was laid out or recorded by choosing.
        assert!(deployment::installed(&root).is_none());
        assert_eq!(
            releases.asked.borrow().as_slice(),
            [
                "https://github.com/CopilotKit/OpenBot/releases/download/v1.3.0/release-manifest.json",
                "https://github.com/CopilotKit/OpenBot/releases/download/v1.2.0/release-manifest.json",
                "https://github.com/CopilotKit/OpenBot/releases/download/v1.3.0/release-manifest.json",
                "https://github.com/CopilotKit/OpenBot/releases/download/v1.4.0/release-manifest.json",
            ]
        );
        // An app newer than the latest never asks: its own release is the one it takes.
        assert_eq!(
            resolve_version_with(
                &root,
                None,
                "v1.5.0",
                || Ok("v1.3.0".into()),
                1,
                |_| panic!("the app's own release needs no question"),
            )
            .unwrap(),
            "v1.5.0"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Design 7.1: an installation whose release needs a newer app is not started, and is never
    /// moved back. Start says "Update OpenBot", the window's sentence, with this app's update.
    #[test]
    fn a_release_that_needs_a_newer_app_is_not_started_and_says_update_openbot() {
        let releases = Releases {
            manifests: vec![
                ("v1.3.0", manifest_needing(2)),
                ("v1.2.0", manifest_needing(1)),
                ("v1.1.0", V1_1_0_MANIFEST.to_vec()),
            ],
            asked: Default::default(),
        };
        let get = |url: &str| releases.get(url);
        let laid_out = |label: &str, version: &str| {
            let root = scratch(label);
            std::fs::write(root.join("docker-compose.yml"), "services:\n  server: {}\n").unwrap();
            std::fs::write(deployment::images_path(&root), "{}").unwrap();
            deployment::record(&root, version, false).unwrap();
            root
        };

        // A release beyond this app's contract: not started, with the sentence and the update.
        let ahead = laid_out("start-launcher-ahead", "v1.3.0");
        let problem = start_problem_with(&ahead, "v1.1.1", 1, &get)
            .expect("a release that needs a newer app is not started");
        assert_eq!(problem.kind, Some(crate::client_version::APP_TOO_OLD));
        assert_eq!(
            problem.said,
            "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going."
        );
        assert!(
            problem.detail.as_deref().is_some_and(|detail| detail
                .contains("OpenBot v1.3.0 needs launcherApi 2; this app is v1.1.1 and speaks launcherApi 1")),
            "{problem:?}"
        );
        // Never moved back: Start has no upgrade to make, and the release is as it was laid out.
        let own = crate::upgrade::Own {
            version: "v1.1.1".into(),
            pinned: false,
        };
        assert_eq!(crate::upgrade::due(&ahead, &own), None);
        assert_eq!(deployment::installed(&ahead).unwrap().version, "v1.3.0");

        // Newer, at this app's contract: starts as before.
        let same = laid_out("start-launcher-same", "v1.2.0");
        assert!(start_problem_with(&same, "v1.1.1", 1, &get).is_none());
        // An app of the newer contract starts the release that needs it.
        assert!(start_problem_with(&ahead, "v1.3.0", 2, &get).is_none());

        // A release older than this app is never asked about: Start moves it to the app's own.
        let older = laid_out("start-launcher-older", "v1.1.0");
        let asked = releases.asked.borrow().len();
        assert!(start_problem_with(&older, "v1.1.1", 1, &get).is_none());
        assert!(start_problem_with(&older, "v1.1.1", 1, &|_| panic!("offline")).is_none());
        assert_eq!(releases.asked.borrow().len(), asked);

        // Newer, and no answer about it: it starts as it did before this check.
        let unknown = laid_out("start-launcher-unknown", "v1.4.0");
        assert!(start_problem_with(&unknown, "v1.1.1", 1, &get).is_none());
        // Nothing laid out, or a pinned build's tag: nothing to ask.
        let empty = scratch("start-launcher-empty");
        assert!(start_problem_with(&empty, "v1.1.1", 1, &|_| panic!("nothing laid out")).is_none());
        let internal = laid_out("start-launcher-internal", "internal-abc");
        assert!(
            start_problem_with(&internal, "v1.1.1", 1, &|_| panic!("a pinned build")).is_none()
        );

        for root in [ahead, same, older, unknown, empty, internal] {
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    /// The rule itself: the same contract starts, one behind starts (1.1.0 keeps starting a server
    /// from before the install token, `install_token`), and only a higher one needs a newer app.
    #[test]
    fn only_a_higher_launcher_contract_needs_a_newer_app() {
        assert!(starts(1, 1));
        assert!(starts(1, 2));
        assert!(!starts(2, 1));
        assert!(!starts(3, 1));
    }

    #[test]
    fn reads_the_latest_release_from_the_update_feed() {
        // The shape downloads.copilotkit.ai/latest/latest.json had for v0.3.3.
        let feed = br#"{"version":"0.3.3","notes":"...","pub_date":"2026-11-07T00:00:00Z","platforms":{}}"#;
        assert_eq!(feed_tag(feed).unwrap(), "v0.3.3");
        assert!(feed_tag(br#"{"version":""}"#).is_err());
        assert!(feed_tag(b"<Error><Code>AccessDenied</Code></Error>").is_err());
    }

    #[test]
    fn a_fresh_install_selects_latest_without_recording_an_unfinished_download() {
        let root = scratch("release-fresh");
        let version = resolve(&root, None, OLDER, || Ok("v0.0.9".into())).unwrap();
        assert_eq!(version, "v0.0.9");
        assert!(deployment::installed(&root).is_none());
        assert!(deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    /// v1.0.1's signed installers were on GitHub's Latest release from 18:17 UTC on 2026-11-10, and
    /// the update feed went on naming v1.0.0 until its mirror sync finished at 18:25 (and its
    /// five-minute cache after that). A 1.0.1 app installed in that window laid out v1.0.0 and
    /// pulled its images, and Start then moved it to v1.0.1 and pulled a second set: "Downloading
    /// the update · 284.5 MB of 949.1 MB" straight after setup.
    #[test]
    fn a_fresh_install_never_lays_out_a_release_older_than_the_app() {
        let root = scratch("release-feed-behind");
        let own = crate::upgrade::Own {
            version: "v1.0.1".into(),
            pinned: false,
        };
        let version = resolve(&root, None, &own.version, || Ok("v1.0.0".into())).unwrap();
        assert_eq!(version, "v1.0.1");
        // Laid out as Install lays it out, Start has nothing to move.
        std::fs::write(root.join("docker-compose.yml"), "services:\n  server: {}\n").unwrap();
        std::fs::write(deployment::images_path(&root), "{}").unwrap();
        deployment::record(&root, &version, false).unwrap();
        assert_eq!(crate::upgrade::due(&root, &own), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_fresh_install_still_takes_a_latest_release_newer_than_the_app() {
        let root = scratch("release-app-behind");
        let version = resolve(&root, None, "v1.0.0", || Ok("v1.0.1".into())).unwrap();
        assert_eq!(version, "v1.0.1");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_installed_version_does_not_query_github_or_upgrade() {
        let root = scratch("release-installed");
        deployment::record(&root, "v0.0.7", false).unwrap();
        std::fs::write(deployment::images_path(&root), "{}").unwrap();
        let version = resolve(&root, None, OLDER, || panic!("must work offline")).unwrap();
        assert_eq!(version, "v0.0.7");
        assert!(!deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_pinned_release_whose_server_ran_on_the_host_is_upgraded_to_latest() {
        let root = scratch("release-host-server");
        std::fs::write(
            root.join("docker-compose.yml"),
            "services:\n  postgres: {}\n  supervisor: {}\n",
        )
        .unwrap();
        std::fs::write(deployment::images_path(&root), "{}").unwrap();
        deployment::record(&root, "v0.0.15", false).unwrap();
        let version = resolve(&root, None, OLDER, || Ok("v0.0.16".into())).unwrap();
        assert_eq!(version, "v0.0.16");
        assert!(deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_manifest_repairs_the_pinned_version() {
        let root = scratch("release-repair");
        deployment::record(&root, "v0.0.7", false).unwrap();
        let version = resolve(&root, None, OLDER, || panic!("keep the installed pin")).unwrap();
        assert_eq!(version, "v0.0.7");
        assert!(deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_lookup_is_reported_without_recording_a_version() {
        let root = scratch("release-lookup-failed");
        let error = resolve(&root, None, OLDER, || Err("GitHub answered 403".into()))
            .expect_err("a failed lookup must not fall back to an old release");
        assert!(error.contains("403"));
        assert!(deployment::installed(&root).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    fn pin(version: &str) -> deployment::Pin {
        deployment::Pin {
            version: version.into(),
            commit: "abc".into(),
            images: "{}",
        }
    }

    #[test]
    fn a_pinned_build_keeps_a_laid_out_deployment_of_another_release_for_start_to_upgrade() {
        let root = scratch("release-pinned-keeps");
        deployment::record(&root, "v0.3.0", false).unwrap();
        std::fs::write(deployment::images_path(&root), "{}").unwrap();
        let version = resolve(&root, Some(&pin("internal-abc")), OLDER, || {
            panic!("a pinned build is offline")
        })
        .unwrap();
        assert_eq!(version, "v0.3.0");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_distribution_defaults_conform_to_publisher() {
        let vectors: Vec<serde_json::Value> = serde_json::from_slice(include_bytes!(
            "../test-fixtures/publisher-distribution.json"
        ))
        .unwrap();
        for vector in vectors {
            let actual = distribution_defaults(
                vector["distributionId"].as_str(),
                vector["repository"].as_str(),
                vector["channel"].as_str(),
            );
            assert_eq!(
                serde_json::json!({"id":actual.distribution_id,"repository":actual.repository,"channel":actual.channel}),
                vector["expected"],
                "{}",
                vector["name"]
            );
        }
    }

    #[test]
    fn a_pinned_build_never_asks_for_the_latest_release() {
        let root = scratch("release-pinned-build");
        deployment::record(&root, "v0.0.7", false).unwrap();
        let pin = pin("internal-abc");
        let version = resolve(&root, Some(&pin), OLDER, || {
            panic!("a pinned build is offline")
        })
        .unwrap();
        assert_eq!(version, "internal-abc");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_customer_build_moves_a_pinned_deployment_to_the_latest_release() {
        let root = scratch("release-unpin");
        deployment::record(&root, "internal-abc", true).unwrap();
        let version = resolve(&root, None, OLDER, || Ok("v0.2.0".into())).unwrap();
        assert_eq!(version, "v0.2.0");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_customer_build_keeps_its_own_release() {
        let root = scratch("release-keep");
        deployment::record(&root, "v0.2.0", false).unwrap();
        let version = resolve(&root, None, OLDER, || {
            panic!("must keep the followed release")
        })
        .unwrap();
        assert_eq!(version, "v0.2.0");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn githubs_exact_tag_is_used_instead_of_the_release_title() {
        assert_eq!(
            release_tag(br#"{"name":"OpenBot September release","tag_name":"v0.0.9"}"#).unwrap(),
            "v0.0.9"
        );
    }

    #[test]
    fn missing_or_unreadable_release_metadata_is_refused() {
        for body in [b"not json".as_slice(), b"{}", br#"{"tag_name":" "}"#] {
            assert!(release_tag(body).is_err());
        }
    }

    /// Exercises the production resolver and downloader against GitHub in an empty directory.
    #[test]
    #[ignore = "downloads the latest public release from GitHub"]
    fn live_latest_release_is_downloaded_and_pinned() {
        let root = scratch("release-live");
        let version = resolve_version(&root).expect("resolve the public release");
        assert!(deployment::installed(&root).is_none());
        deployment::fetch(&root, &version).expect("download the tagged deployment and manifest");
        assert_eq!(deployment::installed(&root).unwrap().version, version);
        let images: deployment::Images =
            serde_json::from_slice(&std::fs::read(deployment::images_path(&root)).unwrap())
                .unwrap();
        assert_eq!(images.version, version);
        for path in deployment::LAYOUT {
            assert!(root.join(path).exists(), "missing {path}");
        }
        assert_eq!(
            resolve(&root, None, OLDER, || panic!(
                "restart must not need GitHub"
            ))
            .unwrap(),
            version
        );
        assert!(!deployment::needs_fetch(&root, &version));
        println!("Downloaded and pinned {version}; tagged source, image manifest, and offline reuse verified.");
        std::fs::remove_dir_all(root).unwrap();
    }
}
