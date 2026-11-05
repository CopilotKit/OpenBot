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
    /// The top-level entries this app laid out. A stamp written before this existed reads as
    /// empty, which never matches, so that deployment is laid out again.
    #[serde(default)]
    pub layout: Vec<String>,
    /// Whether the version was chosen on purpose rather than followed. A stamp written before
    /// pinning existed reads as unpinned.
    #[serde(default)]
    pub pinned: bool,
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

/// One published image's reference, digest-pinned, from the manifest beside the deployment.
///
/// Every image reference comes from here, whether Compose reads it or the shell runs it directly.
/// The alternative was a name built from a version, and an engine given an unqualified name looks
/// it up on Docker Hub: `openbot-agent-langgraph-agui:v0.0.8` became
/// `docker.io/library/openbot-agent-langgraph-agui`, and the person was shown "requested access to
/// the resource is denied", which reads as a credentials problem and is not one.
///
/// An image this release does not publish is named as that. It is the honest answer and the
/// actionable one: the alternative is somebody debugging registry permissions for an image that
/// was never pushed.
pub fn reference(root: &Path, published: &str) -> Result<String, String> {
    let text = std::fs::read_to_string(images_path(root))
        .map_err(|error| format!("could not read {}: {error}", images_path(root).display()))?;
    let manifest: Images = serde_json::from_str(&text)
        .map_err(|error| format!("{IMAGES} is not readable: {error}"))?;
    manifest
        .images
        .get(published)
        .map(|image| image.reference.clone())
        .ok_or_else(|| format!("OpenBot {} does not include {published}.", manifest.version))
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

/// The release a build was pinned to, compiled into the binary.
///
/// `images` is the manifest text exactly as it was at build time, so what gets laid down on disk
/// is the manifest that was tested and not a re-serialisation of it. `commit` is the source the
/// release was cut from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pin {
    pub version: String,
    pub commit: String,
    pub images: &'static str,
}

/// Build a [`Pin`] from manifest text and a commit, taking the version from the manifest.
///
/// Unreadable text is an error rather than a pin with no version: a build that cannot say which
/// release it is has nothing to be pinned to.
pub fn pin_from(images: &'static str, commit: &str) -> Result<Pin, String> {
    let manifest: Images = serde_json::from_str(images)
        .map_err(|error| format!("{IMAGES} is not readable: {error}"))?;
    Ok(Pin {
        version: manifest.version,
        commit: commit.to_string(),
        images,
    })
}

/// The release this build was pinned to, or `None` for an ordinary build.
///
/// Only a build made with `OPENBOT_PINNED_DEPLOYMENT` set carries a pin; build.rs decides that and
/// the compiler removes the other branch, so an ordinary build has no manifest inside it.
#[cfg(openbot_pinned)]
pub fn pinned() -> Option<Pin> {
    Some(
        pin_from(
            include_str!(concat!(env!("OUT_DIR"), "/pinned-images.json")),
            env!("OPENBOT_PINNED_COMMIT"),
        )
        .expect("the manifest this build was pinned to is readable; rebuild with a valid OPENBOT_PINNED_DEPLOYMENT"),
    )
}

/// The release this build was pinned to, or `None` for an ordinary build.
#[cfg(not(openbot_pinned))]
pub fn pinned() -> Option<Pin> {
    None
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

pub fn record(root: &Path, version: &str, pinned: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(root)?;
    let stamp = Installed {
        version: version.to_string(),
        layout: layout(),
        pinned,
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
///
/// So is a stamp that laid out less than this app copies. An app that left a folder out wrote a
/// stamp that still matches its version, and Repair would otherwise keep the gap forever.
pub fn needs_fetch(root: &Path, wanted: &str) -> bool {
    if !images_path(root).exists() {
        return true;
    }
    match installed(root) {
        // A deployment laid out by an app that copied less is missing something this one runs.
        Some(found) => found.version != wanted || found.layout != layout(),
        None => true,
    }
}

/// What this app lays out, in a fixed order, as recorded in the stamp.
fn layout() -> Vec<String> {
    let mut entries: Vec<String> = REQUIRED
        .iter()
        .chain(ALSO_COPIED.iter())
        .map(|entry| entry.to_string())
        .collect();
    entries.sort();
    entries
}

/// Everything the three host processes and Compose need from the tree.
///
/// Named rather than "the whole repository" because most of it is not needed to run: the charts, the
/// docs, the tests and the Dockerfiles are not part of a deployment, and copying them makes the
/// directory look like a place to develop rather than a place something runs.
pub const REQUIRED: [&str; 4] = ["docker-compose.yml", "server", "app", "worker"];

/// The rest of what a deployment needs, which is not what it is checked for.
pub const ALSO_COPIED: [&str; 11] = [
    "shared",
    // The dependency patches `package.json` names in `patchedDependencies`. Without them `bun install
    // --frozen-lockfile` stops with `Couldn't find patch file`.
    "patches",
    // Not a workspace, but the server imports its egress rules from `agent-computer/src` and
    // `scripts/start-local-chrome-computer.ts` its browser runtime. Without it the server exits at
    // start with `Cannot find module '../../../agent-computer/src/egress'`.
    "agent-computer",
    // A root workspace the server imports as `@openbot/toolkit`. Without it, `bun install
    // --frozen-lockfile` stops with `Workspace not found "toolkit"`.
    "toolkit",
    "examples",
    "package.json",
    "bun.lock",
    "scripts",
    // Every package's tsconfig extends this one. Without it vite fails inside `parseExtends`, in a
    // stack trace that names the parser and not the missing file.
    "tsconfig.base.json",
    "bunfig.toml",
    // The Recorder, whole. Installation builds it into `extension/dist` (see
    // `preparation::build_recorder`), and the person's browser loads that build. Its build reads
    // its source, its public assets and its public key, and `bun install --frozen-lockfile` needs
    // its manifest as a workspace.
    "extension",
];

/// Single files copied from a directory that is otherwise left behind. None now: the Recorder's
/// manifest was the one, before Desktop built the Recorder.
pub const ALSO_COPIED_FILES: [&str; 0] = [];

/// Fetch the tagged tarball and lay the deployment out under `root`.
///
/// The stamp is written last. Anything that fails before that leaves a directory without one, which
/// `needs_fetch` treats as absent, so an interrupted download is retried rather than half-run.
pub fn fetch(root: &Path, version: &str) -> Result<(), String> {
    fetch_with(root, version, &get)
}

/// Downloads the URL it is given. A parameter so laying out real archives can run without a network.
pub type Download<'a> = &'a dyn Fn(&str) -> Result<Vec<u8>, String>;

/// [`fetch`], downloading through `get`.
///
/// An installed release changes only through the explicit runtime update controls. At the same
/// version this still lays the deployment out again when the stamp shows an app that copied less
/// (#858 grew `ALSO_COPIED`) or a required path is gone, which is what Install has always done:
/// refusing it left every installation laid out before a layout change unable to Start or Install.
pub fn fetch_with(root: &Path, version: &str, get: Download) -> Result<(), String> {
    crate::updates::require_no_interruption(root)?;
    let policy = crate::updates::distribution(root)?;
    if let Some(installed) = installed(root) {
        if installed.version != version {
            return Err(
                "Use the explicit runtime update controls to change an installed release".into(),
            );
        }
        let laid_out =
            installed.layout == layout() && REQUIRED.iter().all(|path| root.join(path).exists());
        if laid_out {
            return fetch_images(root, version, get);
        }
        // An installation the updater has a verified baseline for is laid out again from that
        // release's checksum-verified source artifact, and its baseline grows to match. A plain
        // installation takes the tag's tarball again, as it always has.
        if root.join(crate::updates::BASELINE).exists() {
            crate::updates::relay_accepted_release(root, get)?;
            return record(root, version, false)
                .map_err(|error| format!("could not record the version: {error}"));
        }
    }
    let source_url = format!(
        "https://github.com/{}/archive/refs/tags/{version}.tar.gz",
        policy.repository
    );
    let body = get(&source_url).map_err(|error| {
        format!("could not fetch {version}: {error}. Is that a released version?")
    })?;

    std::fs::create_dir_all(root)
        .map_err(|error| format!("could not make {}: {error}", root.display()))?;

    unpack(root, &body)?;

    fetch_images(root, version, get)?;

    record(root, version, false).map_err(|error| format!("could not record the version: {error}"))
}

/// The tarball GitHub publishes for a commit.
///
/// A pinned build lays out the commit its release was cut from, not a tag that could be moved.
pub fn commit_tarball_url(commit: &str) -> String {
    format!("https://github.com/CopilotKit/OpenBot/archive/{commit}.tar.gz")
}

/// Lay out the commit a pinned build was cut from, with the images the build was compiled with.
///
/// Nothing is fetched for the image list: the manifest inside the binary is the one that was
/// tested, so it is written as it is. The stamp is still written last, so an interrupted fetch is
/// retried rather than half-run.
pub fn fetch_pinned(root: &Path, pin: &Pin) -> Result<(), String> {
    fetch_pinned_with(root, pin, get)
}

/// `fetch_pinned` with the download passed in, so a test can stand in for the network.
///
/// The manifest is checked before anything is fetched: a pin that names no image for a service is
/// refused while it costs nothing, not after a tarball has been downloaded and unpacked.
fn fetch_pinned_with(
    root: &Path,
    pin: &Pin,
    get: impl Fn(&str) -> Result<Vec<u8>, String>,
) -> Result<(), String> {
    let manifest: Images = serde_json::from_str(pin.images)
        .map_err(|error| format!("{IMAGES} is not readable: {error}"))?;
    self::pin(&manifest)?;

    let body = get(&commit_tarball_url(&pin.commit))
        .map_err(|error| format!("could not fetch {} ({}): {error}", pin.version, pin.commit))?;

    std::fs::create_dir_all(root)
        .map_err(|error| format!("could not make {}: {error}", root.display()))?;

    unpack(root, &body)?;

    std::fs::write(images_path(root), pin.images)
        .map_err(|error| format!("could not write {IMAGES}: {error}"))?;

    record(root, &pin.version, true)
        .map_err(|error| format!("could not record the version: {error}"))
}

/// Where an archive entry may be written under `root`, or `None` when it is not
/// part of a deployment.
///
/// The traversal is refused here rather than after the fact. `Path::join`
/// followed by `starts_with` compares components and does not resolve `..`, so
/// `root.join("app/../../elsewhere")` starts with `root` and still lands outside
/// it -- which made the check that was there read as a guard without being one.
/// Every component of a path inside the tree is an ordinary name, so anything
/// else (`..`, an absolute path, a Windows drive prefix) is refused outright.
fn destination_in(root: &Path, path: &Path) -> Result<Option<PathBuf>, String> {
    // GitHub wraps everything in one directory named for the tag. Strip it, so the deployment
    // lands at `root` rather than at `root/OpenBot-0.0.7`.
    let mut parts = path.components();
    parts.next();
    let relative: PathBuf = parts.collect();
    if relative.as_os_str().is_empty() {
        return Ok(None);
    }

    // Nothing outside `root`, whatever the archive says. A tarball is somebody else's file.
    if relative
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(format!(
            "the download tried to write outside {}: {}",
            root.display(),
            path.display()
        ));
    }

    // Only what a deployment needs. The rest of the tree is a place to develop, not to run.
    let names: Vec<String> = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    let wanted = names.first().is_some_and(|first| {
        REQUIRED.contains(&first.as_str()) || ALSO_COPIED.contains(&first.as_str())
    }) || ALSO_COPIED_FILES.contains(&names.join("/").as_str());
    if !wanted {
        return Ok(None);
    }

    Ok(Some(root.join(&relative)))
}

/// Lay the tarball's deployment files out under `root`.
///
/// Split from [`fetch`] so the part that decides where somebody else's archive
/// is allowed to write can be exercised without a network.
pub fn unpack(root: &Path, body: &[u8]) -> Result<(), String> {
    let decoder = flate2::read::GzDecoder::new(body);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("the download is not readable: {error}"))?;

    for entry in entries {
        let mut entry = entry.map_err(|error| format!("could not read the download: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("could not read a path in the download: {error}"))?
            .into_owned();

        let Some(destination) = destination_in(root, &path)? else {
            continue;
        };
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("could not make {}: {error}", parent.display()))?;
        }
        entry
            .unpack(&destination)
            .map_err(|error| format!("could not write {}: {error}", destination.display()))?;
    }

    Ok(())
}

/// Fetch the image manifest and check it before anything depends on it.
///
/// Parsed here rather than at start-up so a release missing an image fails while the person is
/// still looking at a screen that says what is being fetched, not later inside Compose's output.
fn fetch_images(root: &Path, version: &str, get: Download) -> Result<(), String> {
    let policy = crate::updates::distribution(root)?;
    let url = format!(
        "https://github.com/{}/releases/download/{version}/{IMAGES}",
        policy.repository
    );
    let body = get(&url)
        .map_err(|error| format!("could not fetch the image list for {version}: {error}"))?;
    let manifest: Images = serde_json::from_slice(&body)
        .map_err(|error| format!("the image list for {version} is not readable: {error}"))?;
    pin(&manifest)?;
    std::fs::write(images_path(root), &body)
        .map_err(|error| format!("could not write {IMAGES}: {error}"))
}

/// Fetch a URL into memory.
///
/// Shared with `install.rs`, which fetches the engine's installers through it and then checks their
/// digests. One client, one user agent, one set of TLS defaults.
pub fn get(url: &str) -> Result<Vec<u8>, String> {
    get_waiting(url, IDLE_TIMEOUT)
}

/// How long a download may go without receiving anything before it is given up.
const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/**
`get`, giving up only when nothing arrives for `idle`.

READ AS A STREAM, NOT WITH `bytes()`. The blocking client's timeout (30 s by default) bounds each
read on a stream, but `bytes()` waits for the whole body within it, and reports running out of time
as "error decoding response body". So any download that took longer than 30 seconds failed, however
steadily it was arriving: Bun's 30 MB on a connection under about 1 MB/s, every time.
*/
fn get_waiting(url: &str, idle: std::time::Duration) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut response = reqwest::blocking::Client::builder()
        .user_agent("openbot-desktop")
        .timeout(idle)
        .build()
        .map_err(|error| format!("could not prepare the download: {error}"))?
        .get(url)
        .send()
        .map_err(|error| format!("could not reach {url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("{url} answered {}", response.status()));
    }
    let mut body = Vec::new();
    response
        .read_to_end(&mut body)
        .map_err(|error| format!("the download did not finish: {error}"))?;
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A server that sends `chunks` pieces of `body`, `gap` apart, then closes.
    fn dripping(chunks: usize, gap: std::time::Duration) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/file", listener.local_addr().unwrap());
        let served = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            let length = chunks * 4;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {length}\r\nconnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .unwrap();
            for _ in 0..chunks {
                std::thread::sleep(gap);
                if stream.write_all(b"data").is_err() {
                    return;
                }
                let _ = stream.flush();
            }
        });
        (url, served)
    }

    #[test]
    fn a_download_that_keeps_arriving_finishes_however_long_it_takes() {
        // Six pieces 300 ms apart take 1.8 s in all, longer than the 1 s allowed between pieces.
        // `bytes()` gave up here with "error decoding response body"; a stream does not.
        let (url, served) = dripping(6, std::time::Duration::from_millis(300));
        let body = get_waiting(&url, std::time::Duration::from_secs(1)).unwrap();
        assert_eq!(body, b"data".repeat(6));
        served.join().unwrap();
    }

    #[test]
    fn a_download_that_stalls_is_given_up() {
        let (url, served) = dripping(2, std::time::Duration::from_millis(1500));
        let error = get_waiting(&url, std::time::Duration::from_millis(500)).unwrap_err();
        assert!(error.starts_with("the download did not finish"), "{error}");
        served.join().unwrap();
    }

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
    fn a_pin_takes_its_version_from_the_manifest_and_keeps_the_text_as_it_was() {
        let text: &'static str = r#"{ "version": "v0.0.9",  "images": {} }"#;
        let pin = pin_from(text, "0123456789abcdef0123456789abcdef01234567").unwrap();
        assert_eq!(pin.version, "v0.0.9");
        assert_eq!(pin.commit, "0123456789abcdef0123456789abcdef01234567");
        assert_eq!(pin.images, text);
    }

    #[test]
    fn a_manifest_that_cannot_be_read_is_not_a_pin() {
        let error = pin_from("not json", "abc").unwrap_err();
        assert!(error.contains("is not readable"), "{error}");
    }

    #[cfg(not(openbot_pinned))]
    #[test]
    fn an_ordinary_build_is_not_pinned() {
        assert_eq!(pinned(), None);
    }

    #[test]
    fn a_deployment_without_an_image_manifest_is_fetched_again_rather_than_refused() {
        let dir = std::env::temp_dir().join(format!("openbot-manifest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(images_path(&dir));
        record(&dir, "v0.0.7", false).unwrap();

        assert!(
            needs_fetch(&dir, "v0.0.7"),
            "a matching stamp is not enough when the images are not named"
        );

        std::fs::write(images_path(&dir), "{}").unwrap();
        assert!(!needs_fetch(&dir, "v0.0.7"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Finding: #858 grew `ALSO_COPIED` from 9 to 11 entries, and `fetch` then refused every
    /// installation whose stamp recorded the older layout, so none of them could Start or Install.
    /// Install lays the same release out again, from GitHub's own tarball shape.
    #[test]
    fn an_installation_laid_out_before_a_layout_change_is_laid_out_again_at_its_version() {
        let root = crate::test_support::temp_root("deployment-older-layout");
        std::fs::create_dir_all(&root).unwrap();
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut tarball = tar::Builder::new(encoder);
        for entry in REQUIRED.iter().chain(ALSO_COPIED.iter()) {
            let body = format!("release {entry}");
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tarball
                .append_data(
                    &mut header,
                    format!("OpenBot-0.0.7/{entry}/release.txt"),
                    body.as_bytes(),
                )
                .unwrap();
        }
        let tarball = tarball.into_inner().unwrap().finish().unwrap();
        unpack(&root, &tarball).unwrap();
        // Laid out by the app before #858, which copied neither of these.
        for added in ["patches", "extension"] {
            std::fs::remove_dir_all(root.join(added)).unwrap();
        }
        let older: Vec<String> = layout()
            .into_iter()
            .filter(|entry| entry != "patches" && entry != "extension")
            .collect();
        std::fs::write(
            stamp_path(&root),
            serde_json::to_string(&Installed {
                version: "v0.0.7".into(),
                layout: older,
                pinned: false,
            })
            .unwrap(),
        )
        .unwrap();
        std::fs::write(root.join(".env"), "KEY_ENCRYPTION_KEY=customer-key\n").unwrap();
        let published: Vec<&str> = IMAGE_VARIABLES.iter().map(|(name, _)| *name).collect();
        let images = serde_json::to_vec(&manifest(&published)).unwrap();
        std::fs::write(images_path(&root), &images).unwrap();
        assert!(needs_fetch(&root, "v0.0.7"));

        let get = |url: &str| -> Result<Vec<u8>, String> {
            match url {
                "https://github.com/CopilotKit/OpenBot/archive/refs/tags/v0.0.7.tar.gz" => {
                    Ok(tarball.clone())
                }
                "https://github.com/CopilotKit/OpenBot/releases/download/v0.0.7/container-images.json" => {
                    Ok(images.clone())
                }
                other => Err(format!("unexpected download {other}")),
            }
        };
        fetch_with(&root, "v0.0.7", &get).expect("Install lays the same release out again");
        for added in ["patches", "extension"] {
            assert_eq!(
                std::fs::read_to_string(root.join(added).join("release.txt")).unwrap(),
                format!("release {added}")
            );
        }
        assert!(!needs_fetch(&root, "v0.0.7"));
        assert_eq!(
            std::fs::read_to_string(root.join(".env")).unwrap(),
            "KEY_ENCRYPTION_KEY=customer-key\n"
        );
        // A different version still goes through the explicit update controls.
        assert!(fetch_with(&root, "v0.0.8", &get).is_err());
        std::fs::remove_dir_all(&root).unwrap();
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

    /// One tarball, written as bytes rather than through `tar::Builder`.
    ///
    /// The builder refuses a path holding `..` outright ("paths in archives must
    /// not have `..`"), which is the right thing for it to do and makes it the
    /// wrong tool for this: an archive that climbs out of its root is not
    /// produced by a careful writer, it is produced by somebody writing the
    /// bytes. A ustar header is a name, a size, a checksum and padding.
    fn tarball(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar: Vec<u8> = Vec::new();
        for (name, body) in entries {
            let mut header = [0u8; 512];
            let bytes = name.as_bytes();
            assert!(bytes.len() < 100, "the test uses short names");
            header[..bytes.len()].copy_from_slice(bytes);
            header[100..107].copy_from_slice(b"0000644"); // mode
            header[108..115].copy_from_slice(b"0000000"); // uid
            header[116..123].copy_from_slice(b"0000000"); // gid
            let size = format!("{:011o}", body.len());
            header[124..135].copy_from_slice(size.as_bytes());
            header[136..147].copy_from_slice(b"00000000000"); // mtime
            header[156] = b'0'; // a regular file
            header[257..263].copy_from_slice(b"ustar ");
            header[263..265].copy_from_slice(b"00");
            // The checksum is computed with its own field read as spaces.
            header[148..156].copy_from_slice(b"        ");
            let sum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
            let checksum = format!("{sum:06o}  ");
            header[148..156].copy_from_slice(checksum.as_bytes());

            tar.extend_from_slice(&header);
            tar.extend_from_slice(body);
            tar.resize(tar.len().div_ceil(512) * 512, 0); // pad to a block
        }
        tar.extend_from_slice(&[0u8; 1024]); // two empty blocks end an archive

        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut encoder, &tar).expect("the test archive is compressed");
        encoder.finish().expect("the test archive is compressed")
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("openbot-unpack-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("the scratch directory is made");
        dir
    }

    fn full_pin_text() -> &'static str {
        let images: Vec<String> = IMAGE_VARIABLES
            .iter()
            .map(|(name, _)| {
                format!(r#""{name}": {{ "reference": "ghcr.io/x/{name}@sha256:abc" }}"#)
            })
            .collect();
        let text = format!(
            r#"{{ "version": "v0.3.0-rc.1", "images": {{ {} }} }}"#,
            images.join(", ")
        );
        Box::leak(text.into_boxed_str())
    }

    #[test]
    fn a_pinned_fetch_lays_out_the_commit_with_the_compiled_in_images() {
        let dir = scratch("pinned-fetch");
        std::fs::write(dir.join(".env"), "KEEP=1").unwrap();
        let pin = pin_from(full_pin_text(), "0123456789abcdef").unwrap();
        let archive = tarball(&[(
            "OpenBot-0123456789abcdef/docker-compose.yml",
            b"services: {}",
        )]);
        fetch_pinned_with(&dir, &pin, |url| {
            assert_eq!(url, commit_tarball_url("0123456789abcdef"));
            Ok(archive.clone())
        })
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(images_path(&dir)).unwrap(),
            pin.images
        );
        let installed = installed(&dir).unwrap();
        assert!(installed.pinned);
        assert_eq!(installed.version, "v0.3.0-rc.1");
        assert_eq!(std::fs::read_to_string(dir.join(".env")).unwrap(), "KEEP=1");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_incomplete_pin_is_refused_before_anything_is_fetched() {
        let dir = scratch("pinned-incomplete");
        let pin = pin_from(r#"{ "version": "v0.3.0", "images": {} }"#, "abc").unwrap();
        let error = fetch_pinned_with(&dir, &pin, |_| panic!("nothing is fetched")).unwrap_err();
        assert!(error.contains("names no"), "{error}");
        assert!(installed(&dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_test_archive_really_carries_the_traversal() {
        // Guards the guard: if the archive did not hold `..` the next test would
        // pass for the wrong reason.
        let archive = tarball(&[("OpenBot-0.0.8/app/../../escaped.txt", b"owned")]);
        let decoder = flate2::read::GzDecoder::new(&archive[..]);
        let mut tar = tar::Archive::new(decoder);
        let paths: Vec<String> = tar
            .entries()
            .expect("the test archive is readable")
            .map(|entry| {
                entry
                    .expect("an entry")
                    .path()
                    .expect("a path")
                    .display()
                    .to_string()
            })
            .collect();
        assert_eq!(paths, ["OpenBot-0.0.8/app/../../escaped.txt"]);
    }

    #[test]
    fn a_download_that_climbs_out_of_the_root_is_refused() {
        // `root.join("app/../../x")` starts with `root` -- `Path::starts_with`
        // compares components and does not resolve `..` -- so asking where the
        // path landed cannot answer this. The entry sits under `app`, which is a
        // directory a deployment wants, so the wanted-list does not stop it
        // either.
        let dir = scratch("escape");
        let root = dir.join("deployment");
        std::fs::create_dir_all(&root).expect("the root is made");

        let archive = tarball(&[("OpenBot-0.0.8/app/../../escaped.txt", b"owned")]);
        let outcome = unpack(&root, &archive);

        let climbed = dir.join("escaped.txt");
        let written = climbed.exists();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(!written, "a file was written above the root");
        assert!(outcome.is_err(), "the traversal was accepted: {outcome:?}");
        assert!(
            outcome.unwrap_err().contains("outside"),
            "the refusal should say what it refused"
        );
    }

    #[test]
    fn an_ordinary_download_still_lands_where_it_should() {
        let dir = scratch("ordinary");

        let archive = tarball(&[
            ("OpenBot-0.0.8/app/index.ts", b"export {}"),
            ("OpenBot-0.0.8/docker-compose.yml", b"services: {}"),
            // Not part of a deployment: skipped, not refused.
            ("OpenBot-0.0.8/docs/readme.md", b"# hi"),
        ]);
        unpack(&dir, &archive).expect("an ordinary download is laid out");

        let app = std::fs::read_to_string(dir.join("app/index.ts")).ok();
        let compose = std::fs::read_to_string(dir.join("docker-compose.yml")).ok();
        let docs = dir.join("docs").exists();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(app.as_deref(), Some("export {}"));
        assert_eq!(compose.as_deref(), Some("services: {}"));
        assert!(!docs, "the rest of the tree is not part of a deployment");
    }

    /// Relative module specifiers in one source file: `from "..."`, `import("...")` and
    /// `require("...")`, with either quote. Package names are not relative and are skipped.
    fn relative_imports(source: &str) -> Vec<String> {
        let mut found = Vec::new();
        for opener in [
            "from \"",
            "from '",
            "import(\"",
            "import('",
            "require(\"",
            "require('",
        ] {
            let quote = opener.chars().last().unwrap();
            for (at, _) in source.match_indices(opener) {
                let rest = &source[at + opener.len()..];
                if let Some(end) = rest.find(quote) {
                    let specifier = &rest[..end];
                    if specifier.starts_with("./") || specifier.starts_with("../") {
                        found.push(specifier.to_owned());
                    }
                }
            }
        }
        found
    }

    fn sources_under(dir: &Path, into: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                // Tests and build output run from a checkout, never from a deployment.
                if !matches!(
                    name.as_str(),
                    "node_modules" | "dist" | "tests" | "test" | "__tests__"
                ) {
                    sources_under(&path, into);
                }
            } else if [".ts", ".tsx", ".js", ".mjs", ".cjs"]
                .iter()
                .any(|suffix| name.ends_with(suffix))
                && !name.contains(".test.")
                && !name.contains(".spec.")
            {
                into.push(path);
            }
        }
    }

    /// `#673` made the server import `../../../agent-computer/src/egress`, and the unpacker kept
    /// copying only the folders listed here, so every new Desktop install of v0.2.0 had a server
    /// that exited at start with `Cannot find module`. A checkout has every folder, which is why
    /// nothing caught it. This walks the real tree: whatever the unpacked code imports by a
    /// relative path has to be something the unpacker keeps.
    #[test]
    fn everything_the_unpacked_code_imports_is_unpacked_too() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .unwrap();
        let kept: Vec<&str> = REQUIRED.iter().chain(ALSO_COPIED.iter()).copied().collect();
        let mut files = Vec::new();
        for top in &kept {
            sources_under(&repo.join(top), &mut files);
        }
        assert!(
            files
                .iter()
                .any(|file| file.starts_with(repo.join("server"))),
            "the walk found no server sources, so it proves nothing"
        );

        let mut missing = Vec::new();
        for file in &files {
            let Ok(source) = std::fs::read_to_string(file) else {
                continue;
            };
            for specifier in relative_imports(&source) {
                let mut resolved = file.parent().unwrap().to_path_buf();
                for part in Path::new(&specifier).components() {
                    match part {
                        std::path::Component::ParentDir => {
                            resolved.pop();
                        }
                        std::path::Component::Normal(name) => resolved.push(name),
                        _ => {}
                    }
                }
                let top = resolved
                    .strip_prefix(&repo)
                    .ok()
                    .and_then(|inside| inside.components().next())
                    .map(|first| first.as_os_str().to_string_lossy().into_owned());
                if !top.as_deref().is_some_and(|top| kept.contains(&top)) {
                    missing.push(format!(
                        "{} imports {specifier}",
                        file.strip_prefix(&repo).unwrap_or(file).display()
                    ));
                }
            }
        }
        assert!(
            missing.is_empty(),
            "a deployment would not contain what these import:\n{}",
            missing.join("\n")
        );
    }

    /// Installation builds the Recorder in the deployment, so everything its build reads is laid
    /// out: its source, its public assets, its public key and its build script, as well as the
    /// manifest the frozen install needs. `tests/desktop-release-tree.test.ts` runs that build in a
    /// tree laid out from these lists.
    #[test]
    fn the_recorder_is_copied_whole_so_installation_can_build_it() {
        let dir = scratch("extension");

        let files = [
            "extension/package.json",
            "extension/src/background/index.ts",
            "extension/public/icons/16.png",
            "extension/keys/public-key.txt",
            "extension/scripts/build.ts",
            "shared/openbot-browser.ts",
        ];
        let entries: Vec<(String, &[u8])> = files
            .iter()
            .map(|file| (format!("OpenBot-0.0.8/{file}"), b"x".as_slice()))
            .collect();
        let archive = tarball(
            &entries
                .iter()
                .map(|(name, body)| (name.as_str(), *body))
                .collect::<Vec<_>>(),
        );
        unpack(&dir, &archive).expect("the download is laid out");

        let missing: Vec<&str> = files
            .iter()
            .copied()
            .filter(|file| !dir.join(file).is_file())
            .collect();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(missing.is_empty(), "not laid out: {missing:?}");
    }

    /// An app that copied only the Recorder's manifest laid out a deployment that cannot build it,
    /// and its stamp still matches its version. It is fetched again once, like any deployment laid
    /// out by an app that copied less.
    #[test]
    fn a_deployment_without_the_recorders_source_is_fetched_again() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-recorder-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(images_path(&dir), "{}").unwrap();
        let before: Vec<String> = layout()
            .into_iter()
            .filter(|entry| entry != "extension")
            .collect();
        std::fs::write(
            stamp_path(&dir),
            serde_json::json!({ "version": "v0.2.0", "layout": before }).to_string(),
        )
        .unwrap();
        assert!(needs_fetch(&dir, "v0.2.0"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_recorded_version_is_not_fetched_again() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-same-{}", std::process::id()));
        record(&dir, "v0.0.7", false).unwrap();
        std::fs::write(images_path(&dir), "{}").unwrap();
        assert!(!needs_fetch(&dir, "v0.0.7"));
        assert!(
            needs_fetch(&dir, "v0.0.8"),
            "a newer version has to be fetched"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// v0.2.0 installs were laid out by an app that did not copy `agent-computer`, and their stamp
    /// matches the version they run, so Repair never fetched again and the server never started.
    /// A stamp says what it laid out; one that laid out less than this app copies is fetched once.
    #[test]
    fn a_deployment_laid_out_by_an_app_that_copied_less_is_fetched_again() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-layout-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(images_path(&dir), "{}").unwrap();
        // Exactly what an earlier app wrote.
        std::fs::write(stamp_path(&dir), r#"{"version":"v0.2.0"}"#).unwrap();
        assert!(needs_fetch(&dir, "v0.2.0"));
        assert_eq!(installed(&dir).unwrap().version, "v0.2.0");

        record(&dir, "v0.2.0", false).unwrap();
        assert!(!needs_fetch(&dir, "v0.2.0"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_stamp_written_before_pinning_reads_as_unpinned() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-unpinned-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(stamp_path(&dir), r#"{"version":"v0.2.0","layout":["app"]}"#).unwrap();
        assert!(!installed(&dir).unwrap().pinned);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_pinned_stamp_reads_back_as_pinned() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-pinned-{}", std::process::id()));
        record(&dir, "v0.2.0", true).unwrap();
        assert!(installed(&dir).unwrap().pinned);
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

    #[test]
    fn every_root_workspace_is_copied() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../package.json")).unwrap();
        for workspace in manifest["workspaces"].as_array().unwrap() {
            let workspace = workspace.as_str().unwrap();
            assert!(
                REQUIRED.contains(&workspace)
                    || ALSO_COPIED.contains(&workspace)
                    || ALSO_COPIED_FILES.contains(&format!("{workspace}/package.json").as_str()),
                "{workspace} is a root workspace that a frozen install needs, but is not copied"
            );
        }
    }
}
