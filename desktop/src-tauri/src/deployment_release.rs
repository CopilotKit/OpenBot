//! Choose a release for a deployment: the exact build a pinned app was cut with, otherwise the
//! release a deployment already follows, otherwise the latest public release.

use std::path::Path;

use serde::Deserialize;

use crate::deployment;

/// A pinned build always uses the version it was pinned to and never consults GitHub. Any other
/// build keeps the release it already follows, so restarts and repairs retain that version; only a
/// new deployment, or one left behind by a pinned build, asks this distribution for its latest
/// release. The fetcher records the exact tag after the source and image manifest have both
/// downloaded. Uses blocking HTTP, so callers in an async runtime must use a blocking task.
pub fn resolve_version(root: &Path) -> Result<String, String> {
    resolve_version_with(root, deployment::pinned().as_ref(), || {
        let policy = crate::updates::distribution(root)?;
        let body = deployment::get(&crate::updates::latest_url(&policy))
            .map_err(|error| format!("could not find the latest OpenBot release: {error}"))?;
        release_tag(&body)
    })
}

/// With a pin, the pin's version wins and `latest` is never called. Without one, the installed
/// version is kept only when it was followed rather than pinned; a pinned deployment moves to the
/// latest release.
fn resolve_version_with(
    root: &Path,
    pinned: Option<&deployment::Pin>,
    latest: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    if let Some(pin) = pinned {
        return Ok(pin.version.clone());
    }
    match deployment::installed(root) {
        Some(installed) if !installed.pinned => Ok(installed.version),
        _ => latest(),
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
        let package: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("package.json")).unwrap()).unwrap();
        assert_eq!(package["version"], version.trim_start_matches('v'));
        for path in deployment::REQUIRED {
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
