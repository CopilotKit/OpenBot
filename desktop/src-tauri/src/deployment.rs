//! Putting the deployment on disk, which is not what the installer carries.
//!
//! The installer stays small: a Tauri binary and nothing else. What it needs to run a deployment is
//! fetched on first run and kept beside it, at a version this app records: `docker-compose.yml` and
//! the image list for the containers (see `LAYOUT`). Everything else runs from the release's images,
//! the server, the app, the worker, the computer, their migrations and the tenant package included.
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
/// So is a stamp that laid out less than this app needs. An app that left a file out wrote a stamp
/// that still matches its version, and Repair would otherwise keep the gap forever. A stamp that
/// laid out more (an app that copied whole folders, `agent-computer` and `shared` among them) covers
/// what this app needs, and is not fetched again for that.
pub fn needs_fetch(root: &Path, wanted: &str) -> bool {
    if !images_path(root).exists() {
        return true;
    }
    match installed(root) {
        Some(found) => {
            found.version != wanted || !covers(&found.layout) || predates_containers(root)
        }
        None => true,
    }
}

/// Whether a stamp's recorded layout includes every path this app lays out: the path itself, or a
/// folder it is in.
fn covers(recorded: &[String]) -> bool {
    LAYOUT.iter().all(|path| {
        recorded
            .iter()
            .any(|entry| *path == entry || path.starts_with(&format!("{entry}/")))
    })
}

/// Whether the deployment on disk is a release from before OpenBot's server and worker were
/// Compose services.
///
/// Such a release ran both as Bun processes on the host, and this app no longer starts those. Its
/// Compose file has no `server` or `worker` to raise, and its server image has no worker in it, so
/// keeping its pin would leave an installation that used to start unable to. Answered from the
/// Compose file because that is what is missing; an unreadable or absent file is a damaged
/// deployment, not an old one, and the ordinary repair of the pinned version covers it.
pub fn predates_containers(root: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(root.join("docker-compose.yml")) else {
        return false;
    };
    let services = compose_services(&text);
    !(services.contains(&"server") && services.contains(&"worker"))
}

/// The service names in a Compose file, read line by line.
///
/// Not a YAML parser, and not meant to be one: it reads the shape `docker-compose.yml` in this
/// repository has always had, a top-level `services:` with each service two spaces in. That is the
/// only file this is ever pointed at, and it is enough to tell whether a service is declared.
fn compose_services(text: &str) -> Vec<&str> {
    let mut in_services = false;
    let mut services = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if !line.starts_with(' ') {
            in_services = line.starts_with("services:");
            continue;
        }
        let Some(entry) = line.strip_prefix("  ").filter(|_| in_services) else {
            continue;
        };
        if entry.starts_with(' ') {
            continue;
        }
        if let Some((name, _)) = entry.split_once(':') {
            services.push(name.trim().trim_matches(|c| c == '"' || c == '\''));
        }
    }
    services
}

/// What this app lays out, in a fixed order, as recorded in the stamp.
fn layout() -> Vec<String> {
    let mut entries: Vec<String> = LAYOUT.iter().map(|entry| entry.to_string()).collect();
    entries.sort();
    entries
}

/// Everything a deployment runs from on this machine, out of the release's source tarball.
///
/// The containers need only the Compose file (and `.env`, `.openbot/` and `.langchain/`, which are
/// the installation's own): every container runs from an image the release pins by digest, the
/// server's migrations and the tenant package (`examples/`) included. So no `server`, `app`,
/// `worker`, `toolkit`, `scripts` or `patches` is laid out, and nothing installs their packages.
///
/// Nothing runs from source on the host either. Earlier versions laid out `agent-computer` and the
/// `shared` files it imports, for a browser of the person's own they ran on the desktop beside the
/// server; the person's browser is on the one computer now, shown in the OpenBot window. A stamp that
/// laid those out still covers this layout ([`needs_fetch`]), and Start's upgrade takes the files
/// away with the previous version (`upgrade::KEPT`).
pub const LAYOUT: [&str; 1] = ["docker-compose.yml"];

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
/// An installed release is never changed here: moving it to another one is Start's upgrade (see
/// `upgrade`), which keeps the previous version and a database backup to go back to, and lays the
/// new one out only once the previous one is out of the way. At the same version this still lays
/// the deployment out again when the stamp shows an app that laid out less, or a path is gone,
/// which is what Install has always done.
pub fn fetch_with(root: &Path, version: &str, get: Download) -> Result<(), String> {
    let policy = crate::deployment_release::distribution(root)?;
    // A release from before the server and worker were Compose services cannot run in this app,
    // so `deployment_release` moves it to the latest release: the whole layout again, as for a new
    // deployment.
    let installed = installed(root).filter(|_| !predates_containers(root));
    if let Some(installed) = installed {
        if installed.version != version {
            return Err(format!(
                "{} is installed here, and only Start moves it to {version}",
                installed.version
            ));
        }
        if covers(&installed.layout) && LAYOUT.iter().all(|path| root.join(path).exists()) {
            return fetch_images(root, version, get);
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
    let path = names.join("/");
    let wanted = LAYOUT
        .iter()
        .any(|kept| path == *kept || path.starts_with(&format!("{kept}/")));
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
    let policy = crate::deployment_release::distribution(root)?;
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

/**
Fetch a URL into memory, trying again when the connection fails or the download stalls.

Shared with `install.rs`, which fetches the engine's installers through it and then checks their
digests, and with the release lookup. One client, one user agent, one set of TLS defaults, one way
to download.

NO LIMIT ON THE WHOLE DOWNLOAD, ONLY ON SILENCE. A download that keeps arriving is never cut off,
however slow the line. One that stops is: connecting may take `CONNECT_TIMEOUT`, and after that
nothing may go `STALL_TIMEOUT` without a byte arriving, whether that is the server's answer or the
next piece of the body. Without that, a download GitHub stops sending would wait forever.

TRIED AGAIN, WAITING LONGER EACH TIME. One connection cut part-way through Bun's download used to
fail the whole Start, though the same download finished in under three seconds a minute later. And
on 2026-11-08 the Desktop's first update after an install asked GitHub for the commit's archive and
got no answer for 30 seconds, three times running; it gave up after its third attempt, about a
minute and a half in, and the update was put back. Opening OpenBot again two minutes later
downloaded the same archive in two seconds. So a failure that says nothing about the file is tried
again, `RETRY_DELAYS` apart, for about four minutes at worst: the server could not be reached, sent
nothing for the stall window, did not send the whole body, or answered 5xx or 429. Any other
answer, a 404 in particular, means the file is not there, and is reported at once: the release
lookups depend on seeing that promptly.

A later attempt downloads the whole file again. GitHub answers a byte range of a commit's archive
with the whole archive (200, no Accept-Ranges), so there is nothing to resume from, and `install.rs`
still checks the digest of the copy that is kept.

FROM downloads.copilotkit.ai FIRST. A GitHub download that downloads.copilotkit.ai keeps a copy of
(`mirrored`) is asked of it first, once, and of GitHub, as above, only when that fails.
*/
pub fn get(url: &str) -> Result<Vec<u8>, String> {
    if let Some(copy) = mirrored(url) {
        match get_from_mirror(&copy) {
            Ok(body) => return Ok(body),
            Err(error) => log::warn!("[download] {error}; downloading {url} instead"),
        }
    }
    get_with(url, STALL_TIMEOUT, WAITS)
}

/// The host that keeps a copy of what this app downloads from GitHub: CloudFront over an S3 bucket,
/// which answers 403 for a file it does not have. See `image_mirror` for the images.
pub const DOWNLOADS: &str = "https://downloads.copilotkit.ai";

/// Where downloads.copilotkit.ai keeps its copy of a GitHub download, for the downloads it copies:
/// OpenBot's release assets and a tag's source archive (kept with the release, as
/// `releases/<tag>/<tag>.tar.gz`), and the Podman and Compose builds `install.rs` installs, each
/// under the same version and file name. `None` for anything else, a commit's archive included.
pub fn mirrored(url: &str) -> Option<String> {
    if let Some(tag) = url
        .strip_prefix("https://github.com/CopilotKit/OpenBot/archive/refs/tags/")
        .and_then(|rest| rest.strip_suffix(".tar.gz"))
    {
        return (!tag.is_empty() && !tag.contains('/'))
            .then(|| format!("{DOWNLOADS}/releases/{tag}/{tag}.tar.gz"));
    }
    const COPIES: [(&str, &str); 3] = [
        (
            "https://github.com/CopilotKit/OpenBot/releases/download/",
            "releases/",
        ),
        (
            "https://github.com/podman-container-tools/podman/releases/download/",
            "tools/podman/",
        ),
        (
            "https://github.com/docker/compose/releases/download/",
            "tools/compose/",
        ),
    ];
    COPIES.iter().find_map(|(github, copy)| {
        let rest = url.strip_prefix(github)?;
        (rest.contains('/') && !rest.ends_with('/')).then(|| format!("{DOWNLOADS}/{copy}{rest}"))
    })
}

/// One try at a copy on downloads.copilotkit.ai, with no retries: when it fails, GitHub is asked.
pub fn get_from_mirror(url: &str) -> Result<Vec<u8>, String> {
    get_waiting(url, STALL_TIMEOUT)
        .map_err(|(Failed::ForNow(error) | Failed::ForGood(error))| error)
}

/// The waits `get` makes between attempts: `RETRY_DELAYS`, and in this crate's tests the same
/// number of attempts with no wait, since a test that downloads from an address nobody answers on
/// would otherwise sit through a minute of them.
#[cfg(not(test))]
const WAITS: &[std::time::Duration] = &RETRY_DELAYS;
#[cfg(test)]
const WAITS: &[std::time::Duration] = &[std::time::Duration::ZERO; RETRY_DELAYS.len()];

/// The waits between attempts at a download: `RETRY_DELAYS`, or none in this crate's tests.
pub fn retry_waits() -> &'static [std::time::Duration] {
    WAITS
}

/// How long connecting to the server may take, before anything is asked of it.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// How long a download may go without receiving anything, its answer included, before this attempt
/// is given up.
const STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The waits before each attempt after the first, doubling: six attempts in all. A server that
/// never answers is given up after 6 x 30 s of silence and 62 s of waiting, a little over four
/// minutes. On 2026-11-08 the download that worked came 3 minutes 38 seconds after the first
/// attempt; these attempts reach past that.
const RETRY_DELAYS: [std::time::Duration; 5] = [
    std::time::Duration::from_secs(2),
    std::time::Duration::from_secs(4),
    std::time::Duration::from_secs(8),
    std::time::Duration::from_secs(16),
    std::time::Duration::from_secs(32),
];

/// `get`, with one attempt more than there are `delays`, waiting each delay in turn before trying
/// again. Each retry is written to the log, and the last error says how many attempts were made,
/// so Technical details shows it tried again.
fn get_with(
    url: &str,
    stall: std::time::Duration,
    delays: &[std::time::Duration],
) -> Result<Vec<u8>, String> {
    let mut attempts = 1;
    loop {
        match get_waiting(url, stall) {
            Ok(body) => return Ok(body),
            Err(Failed::ForGood(error)) => return Err(error),
            Err(Failed::ForNow(error)) => match delays.get(attempts - 1) {
                Some(delay) => {
                    log::warn!(
                        "[download] attempt {attempts} of {}: {error}; trying again in {}",
                        delays.len() + 1,
                        said(*delay)
                    );
                    std::thread::sleep(*delay);
                    attempts += 1;
                }
                None if attempts == 1 => return Err(error),
                None => return Err(format!("{error} ({attempts} attempts)")),
            },
        }
    }
}

/// Why one attempt at a download failed, and so whether another could succeed.
enum Failed {
    /// The connection or the server failed; the same request may work in a moment.
    ForNow(String),
    /// The server answered that it will not give the file.
    ForGood(String),
}

/// A duration as Technical details says it: "30 s", "300 ms".
fn said(duration: std::time::Duration) -> String {
    if duration.as_millis().is_multiple_of(1000) {
        format!("{} s", duration.as_secs())
    } else {
        format!("{} ms", duration.as_millis())
    }
}

/// Whether an error from the client is its timeout, said or carried inside an `io::Error`.
fn timed_out(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut source = Some(error);
    while let Some(error) = source {
        if error
            .downcast_ref::<reqwest::Error>()
            .is_some_and(reqwest::Error::is_timeout)
        {
            return true;
        }
        // An `io::Error`'s `source()` skips the error it carries, so that one is looked at here.
        if let Some(error) = error.downcast_ref::<std::io::Error>() {
            if error.kind() == std::io::ErrorKind::TimedOut {
                return true;
            }
            if let Some(inner) = error.get_ref() {
                if timed_out(inner) {
                    return true;
                }
            }
        }
        source = error.source();
    }
    false
}

/**
One attempt at `get`, giving up when connecting takes longer than `CONNECT_TIMEOUT` or nothing
arrives for `stall`.

READ AS A STREAM, NOT WITH `bytes()`. The blocking client's timeout bounds waiting for the answer and
each read on a stream, but `bytes()` waits for the whole body within it, and reports running out of
time as "error decoding response body". So any download that took longer than 30 seconds failed,
however steadily it was arriving: Bun's 30 MB on a connection under about 1 MB/s, every time. Read
as a stream, the timeout is the stall window and nothing else.
*/
fn get_waiting(url: &str, stall: std::time::Duration) -> Result<Vec<u8>, Failed> {
    use std::io::Read;
    let mut response = reqwest::blocking::Client::builder()
        .user_agent("openbot-desktop")
        .connect_timeout(CONNECT_TIMEOUT.min(stall))
        .timeout(stall)
        .build()
        .map_err(|error| Failed::ForGood(format!("could not prepare the download: {error}")))?
        .get(url)
        .send()
        .map_err(|error| {
            Failed::ForNow(if timed_out(&error) && !error.is_connect() {
                format!("{url} sent nothing for {}", said(stall))
            } else {
                format!("could not reach {url}: {error}")
            })
        })?;
    let status = response.status();
    if !status.is_success() {
        let error = format!("{url} answered {status}");
        return Err(
            if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                Failed::ForNow(error)
            } else {
                Failed::ForGood(error)
            },
        );
    }
    let mut body = Vec::new();
    response.read_to_end(&mut body).map_err(|error| {
        Failed::ForNow(if timed_out(&error) {
            format!(
                "the download did not finish: nothing arrived for {} after {} bytes",
                said(stall),
                body.len()
            )
        } else {
            format!("the download did not finish: {error}")
        })
    })?;
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_copy_downloads_copilotkit_ai_keeps_of_each_github_download() {
        assert_eq!(
            mirrored(&images_url("v0.3.4")).as_deref(),
            Some("https://downloads.copilotkit.ai/releases/v0.3.4/container-images.json")
        );
        for (download, tool) in [
            (crate::install::podman_download(), "podman"),
            (crate::install::compose_download(), "compose"),
        ] {
            // Only the builds for this kind of computer are named.
            let Ok(download) = download else { continue };
            let version = download.url.split('/').rev().nth(1).unwrap().to_string();
            assert_eq!(
                mirrored(&download.url),
                Some(format!(
                    "https://downloads.copilotkit.ai/tools/{tool}/{version}/{}",
                    download.file
                ))
            );
        }
        // A tag's source archive is kept with its release.
        assert_eq!(
            mirrored(&tarball_url("v0.3.3")).as_deref(),
            Some("https://downloads.copilotkit.ai/releases/v0.3.3/v0.3.3.tar.gz")
        );
        // A commit's archive, the release lookup and other repositories stay on GitHub.
        for github in [
            commit_tarball_url("0123456789abcdef"),
            "https://github.com/CopilotKit/OpenBot/archive/refs/tags/.tar.gz".to_string(),
            "https://github.com/someone/OpenBot/archive/refs/tags/v0.3.4.tar.gz".to_string(),
            "https://api.github.com/repos/CopilotKit/OpenBot/releases/latest".to_string(),
            "https://github.com/someone/OpenBot/releases/download/v0.3.4/container-images.json"
                .to_string(),
            "https://github.com/CopilotKit/OpenBot/releases/download/".to_string(),
        ] {
            assert_eq!(mirrored(&github), None, "{github}");
        }
    }

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
        let body = get_with(&url, std::time::Duration::from_secs(1), &[]).unwrap();
        assert_eq!(body, b"data".repeat(6));
        served.join().unwrap();
    }

    #[test]
    fn a_download_that_stalls_is_given_up() {
        let (url, served) = dripping(2, std::time::Duration::from_millis(1500));
        let error = get_with(&url, std::time::Duration::from_millis(500), &[]).unwrap_err();
        assert!(error.starts_with("the download did not finish"), "{error}");
        served.join().unwrap();
    }

    /// What one connection to `scripted` gets.
    #[derive(Clone, Copy)]
    enum Reply {
        /// The whole body.
        Whole,
        /// Half the promised body, then the connection is closed.
        Cut,
        /// This status and nothing else.
        Status(u16),
        /// The headers and half the body, then nothing more, with the connection left open: a
        /// download that stops arriving.
        StallPartWay,
        /// Nothing at all, not even the headers, with the connection left open: GitHub's archive
        /// for a commit when it does not answer.
        StallBeforeAnswering,
    }

    /// A server that answers its connections with `replies` in order, repeating the last one, and
    /// counts them. It is left running; the test process ends it.
    fn scripted(replies: Vec<Reply>) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::{Read, Write};
        use std::sync::atomic::Ordering;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/file", listener.local_addr().unwrap());
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = count.clone();
        std::thread::spawn(move || {
            // Stalled connections are kept open here, so the client sees silence and not a close.
            let mut stalled = Vec::new();
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let index = counted.fetch_add(1, Ordering::SeqCst);
                let reply = replies[index.min(replies.len() - 1)];
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let (status, sent) = match reply {
                    Reply::Whole => (200, &b"datadata"[..]),
                    Reply::Cut | Reply::StallPartWay => (200, &b"data"[..]),
                    Reply::Status(code) => (code, &b"datadata"[..]),
                    Reply::StallBeforeAnswering => {
                        stalled.push(stream);
                        continue;
                    }
                };
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 {status} X\r\ncontent-length: 8\r\nconnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                );
                let _ = stream.write_all(sent);
                let _ = stream.flush();
                if matches!(reply, Reply::StallPartWay) {
                    stalled.push(stream);
                }
            }
        });
        (url, count)
    }

    const NO_WAIT: [std::time::Duration; 2] = [std::time::Duration::ZERO; 2];

    fn get_quickly(url: &str) -> Result<Vec<u8>, String> {
        get_with(url, std::time::Duration::from_secs(5), &NO_WAIT)
    }

    fn connections(count: &std::sync::atomic::AtomicUsize) -> usize {
        count.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[test]
    fn a_download_cut_off_once_is_tried_again() {
        let (url, count) = scripted(vec![Reply::Cut, Reply::Whole]);
        assert_eq!(get_quickly(&url).unwrap(), b"datadata");
        assert_eq!(connections(&count), 2);
    }

    #[test]
    fn a_download_cut_off_every_time_is_given_up_after_every_attempt() {
        let (url, count) = scripted(vec![Reply::Cut]);
        let error = get_patiently(&url, std::time::Duration::from_secs(5)).unwrap_err();
        let attempts = RETRY_DELAYS.len() + 1;
        assert!(error.starts_with("the download did not finish"), "{error}");
        assert!(
            error.ends_with(&format!("({attempts} attempts)")),
            "{error}"
        );
        assert_eq!(connections(&count), attempts);
    }

    /// `get` with every wait between attempts cut to nothing, but as many attempts as it makes for
    /// real, and `stall` as the time it waits for the next byte.
    fn get_patiently(url: &str, stall: std::time::Duration) -> Result<Vec<u8>, String> {
        get_with(url, stall, &[std::time::Duration::ZERO; RETRY_DELAYS.len()])
    }

    /// The Desktop's first update after an install, 2026-11-08: GitHub sent nothing for the
    /// commit's archive for 30 seconds three times running, the download gave up after its third
    /// attempt, and the update was put back. Opening OpenBot again two minutes later downloaded it
    /// in two seconds. A download that stalls is given up after the stall window and tried again,
    /// for long enough to outlast that.
    #[test]
    fn a_download_that_stalls_part_way_is_tried_again_until_it_arrives() {
        let stall = std::time::Duration::from_millis(300);
        let (url, count) = scripted(vec![
            Reply::StallPartWay,
            Reply::StallPartWay,
            Reply::StallPartWay,
            Reply::Whole,
        ]);
        let started = std::time::Instant::now();
        assert_eq!(get_patiently(&url, stall).unwrap(), b"datadata");
        assert_eq!(connections(&count), 4);
        // Each stalled attempt was given up after the stall window, not left hanging.
        let took = started.elapsed();
        assert!(took < std::time::Duration::from_secs(5), "{took:?}");
    }

    #[test]
    fn a_server_that_sends_nothing_is_tried_again_until_it_answers() {
        let (url, count) = scripted(vec![
            Reply::StallBeforeAnswering,
            Reply::StallBeforeAnswering,
            Reply::StallBeforeAnswering,
            Reply::Whole,
        ]);
        let body = get_patiently(&url, std::time::Duration::from_millis(300)).unwrap();
        assert_eq!(body, b"datadata");
        assert_eq!(connections(&count), 4);
    }

    #[test]
    fn a_server_that_never_answers_is_given_up_with_what_happened() {
        let (url, count) = scripted(vec![Reply::StallBeforeAnswering]);
        let error = get_patiently(&url, std::time::Duration::from_millis(200)).unwrap_err();
        let attempts = RETRY_DELAYS.len() + 1;
        assert_eq!(
            error,
            format!("{url} sent nothing for 200 ms ({attempts} attempts)")
        );
        assert_eq!(connections(&count), attempts);
    }

    #[test]
    fn a_download_that_stalls_every_time_is_given_up() {
        let (url, count) = scripted(vec![Reply::StallPartWay]);
        let error = get_patiently(&url, std::time::Duration::from_millis(200)).unwrap_err();
        let attempts = RETRY_DELAYS.len() + 1;
        assert_eq!(
            error,
            format!(
                "the download did not finish: nothing arrived for 200 ms after 4 bytes \
                 ({attempts} attempts)"
            )
        );
        assert_eq!(connections(&count), attempts);
    }

    #[test]
    fn a_missing_file_is_reported_at_once() {
        let (url, count) = scripted(vec![Reply::Status(404), Reply::Whole]);
        let error = get_quickly(&url).unwrap_err();
        assert_eq!(error, format!("{url} answered 404 Not Found"));
        assert_eq!(connections(&count), 1);
    }

    #[test]
    fn a_server_error_is_tried_again() {
        let (url, count) = scripted(vec![Reply::Status(503), Reply::Whole]);
        assert_eq!(get_quickly(&url).unwrap(), b"datadata");
        assert_eq!(connections(&count), 2);
    }

    #[test]
    fn being_asked_to_slow_down_is_tried_again() {
        let (url, count) = scripted(vec![Reply::Status(429), Reply::Whole]);
        assert_eq!(get_quickly(&url).unwrap(), b"datadata");
        assert_eq!(connections(&count), 2);
    }

    #[test]
    fn this_repositorys_compose_file_runs_the_server_and_worker_as_services() {
        let text = include_str!("../../../docker-compose.yml");
        let services = compose_services(text);
        for name in ["postgres", "supervisor", "server", "worker"] {
            assert!(services.contains(&name), "{name} not in {services:?}");
        }
    }

    #[test]
    fn a_release_whose_server_ran_on_the_host_is_fetched_again_at_its_own_version() {
        let root = crate::test_support::temp_root("deployment-host-server");
        std::fs::create_dir_all(&root).unwrap();
        // The shape of every release before the server moved into Compose: services, none of them
        // OpenBot's own, and one commented-out line that must not count.
        std::fs::write(
            root.join("docker-compose.yml"),
            "services:\n  postgres:\n    image: postgres\n  # server: on the host\n  supervisor:\n    \
             environment:\n      server: x\nvolumes:\n  worker:\n",
        )
        .unwrap();
        std::fs::write(images_path(&root), "{}").unwrap();
        record(&root, "v0.0.15", false).unwrap();
        assert!(predates_containers(&root));
        assert!(needs_fetch(&root, "v0.0.15"));

        std::fs::write(
            root.join("docker-compose.yml"),
            "services:\n  postgres: {}\n  server:\n    profiles: [\"openbot\"]\n  worker:\n    \
             profiles: [\"openbot\"]\n",
        )
        .unwrap();
        assert!(!predates_containers(&root));
        assert!(!needs_fetch(&root, "v0.0.15"));

        std::fs::remove_file(root.join("docker-compose.yml")).unwrap();
        assert!(
            !predates_containers(&root),
            "a missing file is damage, not age"
        );
        std::fs::remove_dir_all(root).unwrap();
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

    /// A GitHub tag tarball, with every path given its own body.
    fn release_tarball(top: &str, paths: &[(&str, &str)]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut tarball = tar::Builder::new(encoder);
        for (path, body) in paths {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tarball
                .append_data(&mut header, format!("{top}/{path}"), body.as_bytes())
                .unwrap();
        }
        tarball.into_inner().unwrap().finish().unwrap()
    }

    /// Every path in `LAYOUT` as a file in a tarball, and the rest of a release's tree beside them.
    fn whole_release(top: &str) -> Vec<u8> {
        let mut paths: Vec<(String, String)> = LAYOUT
            .iter()
            .map(|entry| match *entry {
                "docker-compose.yml" => (
                    entry.to_string(),
                    "services:\n  server: {}\n  worker: {}\n".to_string(),
                ),
                _ => (entry.to_string(), format!("release {entry}")),
            })
            .collect();
        for rest in [
            "server/src/index.ts",
            "app/package.json",
            "worker/src/index.ts",
            "toolkit/package.json",
            "examples/fintech/package.json",
            "scripts/start.sh",
            "patches/x.patch",
            "package.json",
            "bun.lock",
            "shared/harnesses.json",
            "shared/openbot-browser.ts",
            "agent-computer/package.json",
            "agent-computer/src/index.ts",
            "extension/package.json",
        ] {
            paths.push((rest.into(), format!("release {rest}")));
        }
        let borrowed: Vec<(&str, &str)> = paths
            .iter()
            .map(|(path, body)| (path.as_str(), body.as_str()))
            .collect();
        release_tarball(top, &borrowed)
    }

    /// The containers run from images, so a deployment lays out the Compose file and nothing of the
    /// server, the app, the worker, the computer or the root workspace. Nor the browser earlier
    /// versions ran on the person's desktop: the person's browser is on the one computer now.
    #[test]
    fn only_the_compose_file_is_laid_out() {
        let root = crate::test_support::temp_root("deployment-layout");
        std::fs::create_dir_all(&root).unwrap();
        unpack(&root, &whole_release("OpenBot-0.3.1")).unwrap();
        for entry in LAYOUT {
            assert!(root.join(entry).exists(), "{entry} is not laid out");
        }
        for left in [
            "server",
            "app",
            "worker",
            "toolkit",
            "examples",
            "scripts",
            "patches",
            "package.json",
            "bun.lock",
            "shared",
            "agent-computer",
            "extension",
        ] {
            assert!(!root.join(left).exists(), "{left} is laid out");
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// An installation laid out by an app that copied whole folders (`agent-computer`, `shared`)
    /// already has everything this app lays out, so it is not fetched again for the new layout.
    #[test]
    fn an_installation_laid_out_with_whole_folders_is_not_laid_out_again() {
        let root = crate::test_support::temp_root("deployment-whole-folders");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(images_path(&root), "{}").unwrap();
        let earlier = [
            "agent-computer",
            "app",
            "bun.lock",
            "bunfig.toml",
            "docker-compose.yml",
            "examples",
            "extension",
            "package.json",
            "patches",
            "scripts",
            "server",
            "shared",
            "toolkit",
            "tsconfig.base.json",
            "worker",
        ];
        std::fs::write(
            stamp_path(&root),
            serde_json::json!({ "version": "v0.3.0", "layout": earlier }).to_string(),
        )
        .unwrap();
        assert!(!needs_fetch(&root, "v0.3.0"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// Install lays the same release out again when its stamp laid out less than this app needs,
    /// from GitHub's own tarball shape, and leaves the installation's own files alone. It never
    /// changes the release: only Start's upgrade does.
    #[test]
    fn an_installation_laid_out_before_a_layout_change_is_laid_out_again_at_its_version() {
        let root = crate::test_support::temp_root("deployment-older-layout");
        std::fs::create_dir_all(&root).unwrap();
        let tarball = whole_release("OpenBot-0.0.7");
        unpack(&root, &tarball).unwrap();
        std::fs::remove_file(root.join("docker-compose.yml")).unwrap();
        // Laid out by an app that left the Compose file out.
        std::fs::write(
            stamp_path(&root),
            serde_json::to_string(&Installed {
                version: "v0.0.7".into(),
                layout: vec!["shared".into()],
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
        assert_eq!(
            std::fs::read_to_string(root.join("docker-compose.yml")).unwrap(),
            "services:\n  server: {}\n  worker: {}\n"
        );
        assert!(!needs_fetch(&root, "v0.0.7"));
        assert_eq!(
            std::fs::read_to_string(root.join(".env")).unwrap(),
            "KEY_ENCRYPTION_KEY=customer-key\n"
        );
        // A different version is Start's upgrade, never Install's.
        assert!(fetch_with(&root, "v0.0.8", &get).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A release from before the server was a container is moved to the latest release by
    /// `deployment_release`. The guard that leaves version changes to Start must not refuse that
    /// move, or such an installation could never Install or Start again.
    #[test]
    fn a_release_whose_server_ran_on_the_host_is_laid_out_at_the_latest_version() {
        let root = crate::test_support::temp_root("deployment-host-server-move");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("docker-compose.yml"),
            "services:\n  postgres: {}\n  supervisor: {}\n",
        )
        .unwrap();
        std::fs::write(images_path(&root), "{}").unwrap();
        record(&root, "v0.0.15", false).unwrap();
        assert!(predates_containers(&root));

        // The latest release's Compose file has the server and worker in it.
        let tarball = release_tarball(
            "OpenBot-0.0.16",
            &[(
                "docker-compose.yml",
                "services:\n  server: {}\n  worker: {}\n",
            )],
        );
        let published: Vec<&str> = IMAGE_VARIABLES.iter().map(|(name, _)| *name).collect();
        let images = serde_json::to_vec(&manifest(&published)).unwrap();
        let get = |url: &str| -> Result<Vec<u8>, String> {
            match url {
                "https://github.com/CopilotKit/OpenBot/archive/refs/tags/v0.0.16.tar.gz" => {
                    Ok(tarball.clone())
                }
                "https://github.com/CopilotKit/OpenBot/releases/download/v0.0.16/container-images.json" => {
                    Ok(images.clone())
                }
                other => Err(format!("unexpected download {other}")),
            }
        };
        fetch_with(&root, "v0.0.16", &get).expect("a host-server release moves to latest");
        assert_eq!(installed(&root).unwrap().version, "v0.0.16");
        assert!(!predates_containers(&root));
        assert!(!needs_fetch(&root, "v0.0.16"));
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
        let archive = tarball(&[(
            "OpenBot-0.0.8/agent-computer/src/../../../escaped.txt",
            b"owned",
        )]);
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
        assert_eq!(
            paths,
            ["OpenBot-0.0.8/agent-computer/src/../../../escaped.txt"]
        );
    }

    #[test]
    fn a_download_that_climbs_out_of_the_root_is_refused() {
        // `root.join("agent-computer/src/../../../x")` starts with `root` --
        // `Path::starts_with` compares components and does not resolve `..` -- so
        // asking where the path landed cannot answer this. Refused before the
        // wanted-list is asked, so it is refused whatever a deployment lays out.
        let dir = scratch("escape");
        let root = dir.join("deployment");
        std::fs::create_dir_all(&root).expect("the root is made");

        let archive = tarball(&[(
            "OpenBot-0.0.8/agent-computer/src/../../../escaped.txt",
            b"owned",
        )]);
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
            ("OpenBot-0.0.8/docker-compose.yml", b"services: {}"),
            // Not part of a deployment: skipped, not refused.
            ("OpenBot-0.0.8/agent-computer/src/index.ts", b"export {}"),
            ("OpenBot-0.0.8/docs/readme.md", b"# hi"),
        ]);
        unpack(&dir, &archive).expect("an ordinary download is laid out");

        let compose = std::fs::read_to_string(dir.join("docker-compose.yml")).ok();
        let computer = dir.join("agent-computer").exists();
        let docs = dir.join("docs").exists();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(compose.as_deref(), Some("services: {}"));
        assert!(!computer, "the computer runs from its image");
        assert!(!docs, "the rest of the tree is not part of a deployment");
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
    /// matches the version they run, so Repair never fetched again. A stamp says what it laid out;
    /// one that laid out less than this app needs is fetched once.
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

    /// The containers' Compose file is the one thing a deployment cannot run without.
    #[test]
    fn the_compose_file_is_laid_out_and_nothing_a_container_runs_from_is() {
        assert!(LAYOUT.contains(&"docker-compose.yml"));
        for entry in LAYOUT {
            for container_source in ["server", "app", "worker", "toolkit", "examples", "scripts"] {
                assert!(
                    !entry.starts_with(container_source),
                    "{entry}: the containers run that from their images"
                );
            }
        }
    }
}
