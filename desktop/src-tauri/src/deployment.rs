//! Putting the deployment on disk, which is not what the installer carries.
//!
//! The installer stays small: a Tauri binary and nothing else. What it needs to run a deployment —
//! `docker-compose.yml`, `server`, `app`, `worker`, the tenant package — is fetched on first run and
//! kept beside it, at a version this app records. Two things follow from that split, and both are
//! the reason for it: the download stays a download rather than becoming part of every installer,
//! and the deployment can be moved forward on its own without shipping a new app.
//!
//! What is fetched is the release's own source tarball, at a tag. Not `main`: an app that pulls
//! whatever is on a branch this morning is not a version anybody can be given, and the images the
//! stack runs are pinned per release, so the tree that names them has to be pinned too.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Written beside the deployment so the app can tell what it already put there.
const STAMP: &str = ".openbot-deployment";

/// The release asset that says which images this version runs.
///
/// Kept beside the deployment because the tree does not contain it: `docker-compose.yml` names
/// `openbot-supervisor:latest` and friends as defaults, which are local build names that exist on a
/// developer's machine and nowhere else. A desktop install has never built anything, so without
/// this file Compose asks Docker Hub for images that are not there and reports a denial, which
/// reads as an authentication problem and is not one.
const IMAGES: &str = "container-images.json";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Installed {
    pub version: String,
}

/// The tarball GitHub publishes for a tag.
///
/// A release asset rather than a branch, and https rather than git, so nothing needs a git client
/// or credentials to get a deployment.
pub fn tarball_url(version: &str) -> String {
    format!("https://github.com/CopilotKit/OpenBot/archive/refs/tags/{version}.tar.gz")
}

/// Where the release publishes its image manifest.
pub fn images_url(version: &str) -> String {
    format!("https://github.com/CopilotKit/OpenBot/releases/download/{version}/{IMAGES}")
}

pub fn images_path(root: &Path) -> PathBuf {
    root.join(IMAGES)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Image {
    pub reference: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Images {
    pub version: String,
    pub images: BTreeMap<String, Image>,
}

/// The Compose variable each published image answers to.
///
/// A published name on the left, a Compose variable on the right, because the two vocabularies are
/// different and neither is going to change to suit the other.
pub const IMAGE_VARIABLES: [(&str, &str); 5] = [
    ("server", "SERVER_IMAGE"),
    ("supervisor", "SUPERVISOR_IMAGE"),
    ("agent-computer", "COMPUTER_IMAGE"),
    ("agent-bot", "BOT_IMAGE"),
    ("agent-langgraph", "LANGGRAPH_IMAGE"),
];

/// Read the manifest laid down beside the deployment and turn it into Compose variables.
///
/// Digests, not tags. A tag can be moved to point at a different image after the version that was
/// tested; a digest is the image that was tested.
pub fn image_variables(root: &Path) -> Result<Vec<(String, String)>, String> {
    let text = std::fs::read_to_string(images_path(root))
        .map_err(|error| format!("could not read {}: {error}", images_path(root).display()))?;
    let manifest: Images = serde_json::from_str(&text)
        .map_err(|error| format!("{IMAGES} is not readable: {error}"))?;
    pin(&manifest)
}

/// Every image the stack runs, or a failure that names the one that is missing.
///
/// Refusing a partial manifest rather than filling the gaps from Compose's defaults: a stack that
/// runs four published images and one local build is neither the released version nor a build, and
/// the difference would only show up as behaviour nobody can reproduce.
pub fn pin(manifest: &Images) -> Result<Vec<(String, String)>, String> {
    let mut pinned = Vec::new();
    for (published, variable) in IMAGE_VARIABLES {
        let image = manifest.images.get(published).ok_or_else(|| {
            format!(
                "{IMAGES} for {} names no {published} image.",
                manifest.version
            )
        })?;
        pinned.push((variable.to_string(), image.reference.clone()));
    }
    Ok(pinned)
}

pub fn stamp_path(root: &Path) -> PathBuf {
    root.join(STAMP)
}

/// What version is already there, if any.
pub fn installed(root: &Path) -> Option<Installed> {
    std::fs::read_to_string(stamp_path(root))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

pub fn record(root: &Path, version: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(root)?;
    let stamp = Installed {
        version: version.to_string(),
    };
    std::fs::write(
        stamp_path(root),
        serde_json::to_string(&stamp).unwrap_or_default(),
    )
}

/// Whether anything needs fetching.
///
/// Answered from the stamp rather than by looking for files, so a half-extracted directory from an
/// interrupted download is replaced rather than trusted: the stamp is written last, and its absence
/// means the fetch did not finish.
///
/// The image manifest is the one exception. A deployment laid down by an app that predates it has a
/// stamp that matches and no manifest, and re-fetching is a better answer than an error about a
/// file the person has never heard of.
pub fn needs_fetch(root: &Path, wanted: &str) -> bool {
    if !images_path(root).exists() {
        return true;
    }
    match installed(root) {
        Some(found) => found.version != wanted,
        None => true,
    }
}

/// Everything the three host processes and Compose need from the tree.
///
/// Named rather than "the whole repository" because most of it is not needed to run: the charts, the
/// docs, the tests and the Dockerfiles are not part of a deployment, and copying them makes the
/// directory look like a place to develop rather than a place something runs.
pub const REQUIRED: [&str; 4] = ["docker-compose.yml", "server", "app", "worker"];

/// The rest of what a deployment needs, which is not what it is checked for.
pub const ALSO_COPIED: [&str; 7] = [
    "shared",
    "examples",
    "package.json",
    "bun.lock",
    "scripts",
    // Every package's tsconfig extends this one. Without it vite fails inside `parseExtends`, in a
    // stack trace that names the parser and not the missing file.
    "tsconfig.base.json",
    "bunfig.toml",
];

/// Fetch the tagged tarball and lay the deployment out under `root`.
///
/// The stamp is written last. Anything that fails before that leaves a directory without one, which
/// `needs_fetch` treats as absent, so an interrupted download is retried rather than half-run.
pub fn fetch(root: &Path, version: &str) -> Result<(), String> {
    let body = get(&tarball_url(version)).map_err(|error| {
        format!("could not fetch {version}: {error}. Is that a released version?")
    })?;

    std::fs::create_dir_all(root)
        .map_err(|error| format!("could not make {}: {error}", root.display()))?;

    let decoder = flate2::read::GzDecoder::new(&body[..]);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("the download of {version} is not readable: {error}"))?;

    for entry in entries {
        let mut entry = entry.map_err(|error| format!("could not read the download: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("could not read a path in the download: {error}"))?
            .into_owned();

        // GitHub wraps everything in one directory named for the tag. Strip it, so the deployment
        // lands at `root` rather than at `root/OpenBot-0.0.7`.
        let mut parts = path.components();
        parts.next();
        let relative: PathBuf = parts.collect();
        if relative.as_os_str().is_empty() {
            continue;
        }

        // Only what a deployment needs. The rest of the tree is a place to develop, not to run.
        let wanted = relative
            .components()
            .next()
            .map(|first| {
                let name = first.as_os_str().to_string_lossy().into_owned();
                REQUIRED.contains(&name.as_str()) || ALSO_COPIED.contains(&name.as_str())
            })
            .unwrap_or(false);
        if !wanted {
            continue;
        }

        // Nothing outside `root`, whatever the archive says. A tarball is somebody else's file.
        let destination = root.join(&relative);
        if !destination.starts_with(root) {
            return Err(format!(
                "the download tried to write outside {}",
                root.display()
            ));
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("could not make {}: {error}", parent.display()))?;
        }
        entry
            .unpack(&destination)
            .map_err(|error| format!("could not write {}: {error}", destination.display()))?;
    }

    fetch_images(root, version)?;

    record(root, version).map_err(|error| format!("could not record the version: {error}"))
}

/// Fetch the image manifest and check it before anything depends on it.
///
/// Parsed here rather than at start-up so a release missing an image fails while the person is
/// still looking at a screen that says what is being fetched, not later inside Compose's output.
fn fetch_images(root: &Path, version: &str) -> Result<(), String> {
    let body = get(&images_url(version))
        .map_err(|error| format!("could not fetch the image list for {version}: {error}"))?;
    let manifest: Images = serde_json::from_slice(&body)
        .map_err(|error| format!("the image list for {version} is not readable: {error}"))?;
    pin(&manifest)?;
    std::fs::write(images_path(root), &body)
        .map_err(|error| format!("could not write {IMAGES}: {error}"))
}

fn get(url: &str) -> Result<Vec<u8>, String> {
    let response = reqwest::blocking::Client::builder()
        .user_agent("openbot-desktop")
        .build()
        .map_err(|error| format!("could not prepare the download: {error}"))?
        .get(url)
        .send()
        .map_err(|error| format!("could not reach {url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("{url} answered {}", response.status()));
    }
    response
        .bytes()
        .map(|body| body.to_vec())
        .map_err(|error| format!("the download did not finish: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(names: &[&str]) -> Images {
        Images {
            version: "v0.0.7".into(),
            images: names
                .iter()
                .map(|name| {
                    (
                        (*name).to_string(),
                        Image {
                            reference: format!("ghcr.io/copilotkit/openbot-{name}@sha256:abc"),
                        },
                    )
                })
                .collect(),
        }
    }

    #[test]
    fn a_deployment_without_an_image_manifest_is_fetched_again_rather_than_refused() {
        let dir = std::env::temp_dir().join(format!("openbot-manifest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(images_path(&dir));
        record(&dir, "v0.0.7").unwrap();

        assert!(
            needs_fetch(&dir, "v0.0.7"),
            "a matching stamp is not enough when the images are not named"
        );

        std::fs::write(images_path(&dir), "{}").unwrap();
        assert!(!needs_fetch(&dir, "v0.0.7"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn every_service_compose_can_run_is_pinned_to_a_published_digest() {
        let published: Vec<&str> = IMAGE_VARIABLES.iter().map(|(name, _)| *name).collect();
        let pinned = pin(&manifest(&published)).expect("a complete manifest pins");
        assert_eq!(pinned.len(), IMAGE_VARIABLES.len());
        for (_, reference) in &pinned {
            assert!(
                reference.contains("@sha256:"),
                "a tag is not a version: {reference}"
            );
        }
    }

    #[test]
    fn a_manifest_missing_an_image_is_refused_rather_than_filled_in_from_compose() {
        // Compose's defaults are local build names. Falling back to them would run four published
        // images beside one that does not exist, and say nothing about the difference.
        let missing = pin(&manifest(&[
            "server",
            "supervisor",
            "agent-computer",
            "agent-bot",
        ]));
        let error = missing.expect_err("an incomplete manifest is not a deployment");
        assert!(error.contains("agent-langgraph"), "{error}");
    }

    #[test]
    fn the_image_manifest_is_fetched_from_the_same_version_as_the_tree() {
        let url = images_url("v0.0.7");
        assert!(url.contains("/download/v0.0.7/"), "{url}");
        assert!(url.ends_with("container-images.json"), "{url}");
    }

    #[test]
    fn the_tarball_is_a_tag_rather_than_a_branch() {
        let url = tarball_url("v0.0.7");
        assert!(url.contains("/refs/tags/v0.0.7"), "{url}");
        assert!(!url.contains("/heads/"), "a branch is not a version: {url}");
        assert!(
            url.starts_with("https://"),
            "must not need a git client: {url}"
        );
    }

    #[test]
    fn an_empty_directory_needs_fetching() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-empty-{}", std::process::id()));
        assert!(needs_fetch(&dir, "v0.0.7"));
    }

    #[test]
    fn a_recorded_version_is_not_fetched_again() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-same-{}", std::process::id()));
        record(&dir, "v0.0.7").unwrap();
        std::fs::write(images_path(&dir), "{}").unwrap();
        assert!(!needs_fetch(&dir, "v0.0.7"));
        assert!(
            needs_fetch(&dir, "v0.0.8"),
            "a newer version has to be fetched"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_interrupted_fetch_is_replaced_rather_than_trusted() {
        // Files present, stamp absent: what an interrupted extract leaves behind. The stamp is
        // written last precisely so this case is distinguishable.
        let dir = std::env::temp_dir().join(format!("openbot-dep-partial-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("server")).unwrap();
        std::fs::write(dir.join("docker-compose.yml"), "services: {}\n").unwrap();
        assert!(
            needs_fetch(&dir, "v0.0.7"),
            "a directory with no stamp is not a deployment"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unreadable_stamp_is_treated_as_absent_rather_than_fatal() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(stamp_path(&dir), "{ not json").unwrap();
        assert!(installed(&dir).is_none());
        assert!(needs_fetch(&dir, "v0.0.7"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_shared_tsconfig_is_copied_or_every_package_fails_to_parse_its_own() {
        assert!(
            ALSO_COPIED.contains(&"tsconfig.base.json"),
            "app, server and worker all extend it"
        );
    }

    #[test]
    fn what_is_required_is_what_the_stack_actually_runs() {
        // The check in stack.rs looks for exactly these, so the two cannot drift apart.
        for entry in ["docker-compose.yml", "server", "app", "worker"] {
            assert!(
                REQUIRED.contains(&entry),
                "{entry} is not required but is checked for"
            );
        }
        assert!(
            !REQUIRED.contains(&"charts"),
            "a deployment is not a place to develop"
        );
        assert!(!REQUIRED.contains(&"docs"));
    }
}
