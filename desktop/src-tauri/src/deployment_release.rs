//! Choose a release for a deployment: the release a deployment already has, otherwise the exact
//! build a pinned app was cut with, otherwise the latest public release. And where releases come
//! from: the distribution this installation follows.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::deployment;

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
/// new deployment, one from before the server and worker were Compose services
/// (`deployment::predates_containers`, which this app cannot run), or one of the other kind
/// (pinned or followed) that never finished laying out gets a fresh release: the one a pinned build
/// was cut with, otherwise the latest the distribution has published. The fetcher records the exact
/// tag after the source and image manifest have both downloaded.
pub fn resolve_version(root: &Path) -> Result<String, String> {
    resolve_version_with(root, deployment::pinned().as_ref(), || {
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
    })
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
/// Otherwise the pin's version when there is one, and `latest` only when there is not.
fn resolve_version_with(
    root: &Path,
    pinned: Option<&deployment::Pin>,
    latest: impl FnOnce() -> Result<String, String>,
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
            None => latest(),
        },
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

    fn scratch(label: &str) -> std::path::PathBuf {
        let root = temp_root(label);
        std::fs::create_dir_all(&root).unwrap();
        root
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
        let version = resolve_version_with(&root, None, || Ok("v0.0.9".into())).unwrap();
        assert_eq!(version, "v0.0.9");
        assert!(deployment::installed(&root).is_none());
        assert!(deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_installed_version_does_not_query_github_or_upgrade() {
        let root = scratch("release-installed");
        deployment::record(&root, "v0.0.7", false).unwrap();
        std::fs::write(deployment::images_path(&root), "{}").unwrap();
        let version = resolve_version_with(&root, None, || panic!("must work offline")).unwrap();
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
        let version = resolve_version_with(&root, None, || Ok("v0.0.16".into())).unwrap();
        assert_eq!(version, "v0.0.16");
        assert!(deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_manifest_repairs_the_pinned_version() {
        let root = scratch("release-repair");
        deployment::record(&root, "v0.0.7", false).unwrap();
        let version =
            resolve_version_with(&root, None, || panic!("keep the installed pin")).unwrap();
        assert_eq!(version, "v0.0.7");
        assert!(deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_lookup_is_reported_without_recording_a_version() {
        let root = scratch("release-lookup-failed");
        let error = resolve_version_with(&root, None, || Err("GitHub answered 403".into()))
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
        let version = resolve_version_with(&root, Some(&pin("internal-abc")), || {
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
        let version =
            resolve_version_with(&root, Some(&pin), || panic!("a pinned build is offline"))
                .unwrap();
        assert_eq!(version, "internal-abc");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_customer_build_moves_a_pinned_deployment_to_the_latest_release() {
        let root = scratch("release-unpin");
        deployment::record(&root, "internal-abc", true).unwrap();
        let version = resolve_version_with(&root, None, || Ok("v0.2.0".into())).unwrap();
        assert_eq!(version, "v0.2.0");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_customer_build_keeps_its_own_release() {
        let root = scratch("release-keep");
        deployment::record(&root, "v0.2.0", false).unwrap();
        let version =
            resolve_version_with(&root, None, || panic!("must keep the followed release")).unwrap();
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
            resolve_version_with(&root, None, || panic!("restart must not need GitHub")).unwrap(),
            version
        );
        assert!(!deployment::needs_fetch(&root, &version));
        println!("Downloaded and pinned {version}; tagged source, image manifest, and offline reuse verified.");
        std::fs::remove_dir_all(root).unwrap();
    }
}
