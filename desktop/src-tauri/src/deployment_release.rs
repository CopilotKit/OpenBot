//! Choose a release for a new deployment and retain an existing deployment's exact version.

use std::path::Path;

use serde::Deserialize;

use crate::deployment;

const LATEST_RELEASE: &str = "https://api.github.com/repos/CopilotKit/OpenBot/releases/latest";

/// Only new deployments consult GitHub. The fetcher records the exact tag after the source and
/// image manifest have both downloaded successfully; restarts and repairs retain that pin.
/// Uses blocking HTTP, so callers in an async runtime must use a blocking task.
pub fn resolve_version(root: &Path) -> Result<String, String> {
    resolve_version_with(root, || {
        let body = deployment::get(LATEST_RELEASE)
            .map_err(|error| format!("could not find the latest OpenBot release: {error}"))?;
        release_tag(&body)
    })
}

fn resolve_version_with(
    root: &Path,
    latest: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    match deployment::installed(root) {
        Some(installed) => Ok(installed.version),
        None => latest(),
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
    fn a_fresh_install_selects_latest_without_recording_an_unfinished_download() {
        let root = scratch("release-fresh");
        let version = resolve_version_with(&root, || Ok("v0.0.9".into())).unwrap();
        assert_eq!(version, "v0.0.9");
        assert!(deployment::installed(&root).is_none());
        assert!(deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_installed_version_does_not_query_github_or_upgrade() {
        let root = scratch("release-installed");
        deployment::record(&root, "v0.0.7").unwrap();
        std::fs::write(deployment::images_path(&root), "{}").unwrap();
        let version = resolve_version_with(&root, || panic!("must work offline")).unwrap();
        assert_eq!(version, "v0.0.7");
        assert!(!deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_manifest_repairs_the_pinned_version() {
        let root = scratch("release-repair");
        deployment::record(&root, "v0.0.7").unwrap();
        let version = resolve_version_with(&root, || panic!("keep the installed pin")).unwrap();
        assert_eq!(version, "v0.0.7");
        assert!(deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_lookup_is_reported_without_recording_a_version() {
        let root = scratch("release-lookup-failed");
        let error = resolve_version_with(&root, || Err("GitHub answered 403".into()))
            .expect_err("a failed lookup must not fall back to an old release");
        assert!(error.contains("403"));
        assert!(deployment::installed(&root).is_none());
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
        let package: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("package.json")).unwrap()).unwrap();
        assert_eq!(package["version"], version.trim_start_matches('v'));
        for path in deployment::REQUIRED {
            assert!(root.join(path).exists(), "missing {path}");
        }
        assert_eq!(
            resolve_version_with(&root, || panic!("restart must not need GitHub")).unwrap(),
            version
        );
        assert!(!deployment::needs_fetch(&root, &version));
        println!("Downloaded and pinned {version}; tagged source, image manifest, and offline reuse verified.");
        std::fs::remove_dir_all(root).unwrap();
    }
}
