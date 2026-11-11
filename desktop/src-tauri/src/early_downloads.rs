/*!
The big downloads, started when the first setup screen shows, before anybody clicks Install.

Nothing used to download until Install was clicked, and then one item after another. On a new Mac
that was Podman's package, the password, then the 937 MB engine machine image from quay.io with no
progress shown, then 1.1 GB of OpenBot's images. None of those bytes needs an engine, a password, a
sign-in or the licence to download, only to be used. So when Welcome shows, this starts them all at
once, into a cache on disk, and Install finds them there:

- **The engine machine image.** Podman's own `machine init` pulls it from quay.io itself, silently.
  Here it is downloaded by OpenBot, with progress, and the machine is built from the local file
  (`podman machine init --image <path>`, which takes a local path and unpacks a `.zst` itself:
  podman `pkg/machine/shim/diskpull` and `pkg/machine/compression`). Only for an installation that
  will create OpenBot's machine with the Podman 6.1 the pins below belong to.
- **Podman's installer and Compose**, the files `install.rs` installs, through the same `fetch`.
- **The deployment** (`docker-compose.yml` and the image list), laid out as Install lays it out.
- **OpenBot's images**, pulled into an engine that already answers (Docker Desktop, or a Podman
  machine that is running), with Install's own pull. With no engine answering yet, they download
  into the cache instead, and Install loads them into the engine once it does (`early_images`).

Nothing here asks for anything. The Podman package is downloaded, never installed: installing it
needs the person's password, and that waits for Install and the explained Continue
(`install::GoAhead`).

EVERY FILE IS PINNED, AND RESUMES. A download goes to `<name>.partial` and becomes `<name>` only once
its SHA-256 is the pinned one. An app quit part-way leaves the partial file, and the next try asks
for the rest (`Range`, RFC 9110 section 14) and hashes the bytes it already has first. A server that
answers the whole file instead, or a partial file that hashes wrong at the end, starts again from
nothing. downloads.copilotkit.ai is asked first, once, and the original source after it, the way
`deployment::get` does.

ONE DOWNLOAD PER FILE. Install and the early downloads ask for the same files. Each file has a lock,
so Install waits for a download already running rather than starting a second, and then finds the
file verified.

THE DISK IS CHECKED FIRST. The back end's CLI wants 40 GiB free (`local_eval::MIN_ENGINE_FREE_DISK_BYTES`),
and on a Mac or Windows that space is taken from this computer's disk as the engine's virtual disk
grows. k3s's own line (evicting under 5% free) is measured inside that virtual disk, not here. With
less free than the back end needs and the downloads together, nothing starts, the window says so with
both numbers, and the check runs again every few seconds until there is room.
*/

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::engine::{Address, Engine};

/// The `podman/machine-os` release the machine images below come from, which is the minor version
/// of the Podman this app installs (`install::PODMAN`). Podman pulls `machine-os:<its major.minor>`.
pub const MACHINE_OS: &str = "6.1";

/// One engine machine image: the disk artifact `quay.io/podman/machine-os:6.1` names for one
/// platform, read on 2026-11-09. `manifest` is the artifact's manifest, which is what the mirror
/// copies; `blob` is its one layer, the compressed disk, which is what is downloaded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MachineImage {
    /// The file name the artifact gives the disk (`org.opencontainers.image.title`).
    pub file: &'static str,
    pub manifest: &'static str,
    pub blob: &'static str,
    pub size: u64,
}

/// The repository the machine images are in, on quay.io and in downloads.copilotkit.ai's copy.
pub const MACHINE_OS_REPOSITORY: &str = "podman/machine-os";

/// The machine image Podman would pull on this kind of computer, or `None` where OpenBot never
/// creates a machine from one: Linux has no machine, and machine-os has no `applehv` disk for an
/// Intel Mac. Windows machines are WSL distributions, so theirs is the WSL root file system.
pub fn machine_image_for(os: &str, arch: &str) -> Option<MachineImage> {
    match (os, arch) {
        ("macos", "aarch64") => Some(MachineImage {
            file: "podman-machine.aarch64.applehv.raw.zst",
            manifest: "sha256:e4b416b1758cb94b477d0c27e265b9180e8d52ee529df9276d726206ea69b883",
            blob: "sha256:cd711cd582d301f11616281f0b0098de7cad26b050b7317b8bd3f3ac667c0d21",
            size: 937_318_069,
        }),
        ("windows", "x86_64") => Some(MachineImage {
            file: "podman-machine.x86_64.wsl.tar.zst",
            manifest: "sha256:b3f5e2810eecb8778a6dc09283868c1255a06d7c156312c387616d41500d4175",
            blob: "sha256:81ce79567e5aa7a1a122035b7ad14bd8e0dae8be009276427800e2cc62d753c7",
            size: 251_517_341,
        }),
        ("windows", "aarch64") => Some(MachineImage {
            file: "podman-machine.aarch64.wsl.tar.zst",
            manifest: "sha256:80a2eb6bb3345c955d5feea5a43dfa6bfff02b0e54b013c1455ad55b23f4e999",
            blob: "sha256:1e0107fb11ae52c9b5011ed9ec9661cc5e99b15efe22556eec721b5abced7394",
            size: 236_832_353,
        }),
        _ => None,
    }
}

/// This computer's machine image, if it has one.
pub fn machine_image() -> Option<MachineImage> {
    machine_image_for(std::env::consts::OS, crate::windows::machine_arch())
}

/// Every machine image reference downloads.copilotkit.ai copies (`release_images`), by the
/// artifact manifest's digest.
pub fn machine_image_references() -> Vec<String> {
    [
        ("macos", "aarch64"),
        ("windows", "x86_64"),
        ("windows", "aarch64"),
    ]
    .iter()
    .filter_map(|(os, arch)| machine_image_for(os, arch))
    .map(|image| format!("quay.io/{MACHINE_OS_REPOSITORY}@{}", image.manifest))
    .collect()
}

impl MachineImage {
    /// Where to download it from: downloads.copilotkit.ai's copy, then quay.io.
    pub fn sources(&self) -> Vec<String> {
        vec![
            format!(
                "{}/v2/quay.io/{MACHINE_OS_REPOSITORY}/blobs/{}",
                crate::deployment::DOWNLOADS,
                self.blob
            ),
            format!(
                "https://quay.io/v2/{MACHINE_OS_REPOSITORY}/blobs/{}",
                self.blob
            ),
        ]
    }

    pub fn sha256(&self) -> &'static str {
        self.blob.trim_start_matches("sha256:")
    }
}

/// Whether a Podman reporting `version` (`podman version 6.1.1`, `podman.exe version 6.1.1`) pulls
/// the machine-os release the pins are from. Another Podman pulls its own, and is left to.
pub fn podman_takes_pinned_machine_image(version: &str) -> bool {
    version
        .split_whitespace()
        .last()
        .is_some_and(|number| number.starts_with(&format!("{MACHINE_OS}.")))
}

// ---------------------------------------------------------------------------------------------
// Downloading one pinned file.
// ---------------------------------------------------------------------------------------------

/// A file to download and the SHA-256 it must have.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pinned {
    /// Its name on disk. Named, not taken from a URL, so a redirect cannot choose it.
    pub name: String,
    /// Lower-case hex.
    pub sha256: String,
    /// Its size, when it is known before the download answers.
    pub size: Option<u64>,
    /// Asked in order: the first once, the last with `RETRY_DELAYS` between attempts.
    pub sources: Vec<String>,
}

/// What `fetch` is told as the bytes on disk grow, and the size once it is known.
pub trait Progress: Sync {
    fn size(&self, _size: u64) {}
    fn bytes(&self, _bytes: u64) {}
}

impl Progress for () {}

/// The part of a download not yet finished, beside where the file goes.
pub fn partial_path(into: &Path, name: &str) -> PathBuf {
    into.join(format!("{name}.partial"))
}

/// One lock per file, so two downloads of the same file never run at once.
fn file_lock(path: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<BTreeMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|held| held.into_inner())
        .entry(path.to_path_buf())
        .or_default()
        .clone()
}

fn hold(lock: &Mutex<()>) -> MutexGuard<'_, ()> {
    lock.lock().unwrap_or_else(|held| held.into_inner())
}

/// The SHA-256 of a file, read in pieces: a machine image is most of a gigabyte.
pub fn file_sha256(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `pinned` in `into`, downloaded if it is not there already with its pinned digest.
///
/// A file there with the wrong digest is replaced: a half-written download far more often than an
/// attack, and either way never used. Waits for a download of the same file already running.
pub fn fetch(pinned: &Pinned, into: &Path, progress: &dyn Progress) -> Result<PathBuf, String> {
    fetch_waiting(pinned, into, progress, crate::deployment::retry_waits())
}

/// `fetch`, waiting `waits` between attempts at the last source.
pub fn fetch_waiting(
    pinned: &Pinned,
    into: &Path,
    progress: &dyn Progress,
    waits: &[Duration],
) -> Result<PathBuf, String> {
    let path = into.join(&pinned.name);
    let lock = file_lock(&path);
    let _only = hold(&lock);

    if let Some(size) = pinned.size {
        progress.size(size);
    }
    if path.is_file() {
        if file_sha256(&path).ok().as_deref() == Some(pinned.sha256.as_str()) {
            let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            progress.size(size);
            progress.bytes(size);
            return Ok(path);
        }
        log::warn!(
            "[download] {} is not the file pinned, downloading it again",
            path.display()
        );
        let _ = std::fs::remove_file(&path);
    }
    std::fs::create_dir_all(into)
        .map_err(|error| format!("could not make {}: {error}", into.display()))?;

    let partial = partial_path(into, &pinned.name);
    let mut last_error = String::from("there was nowhere to download it from");
    for (index, source) in pinned.sources.iter().enumerate() {
        let last = index + 1 == pinned.sources.len();
        let waits: &[Duration] = if last { waits } else { &[] };
        match download_resuming(source, &partial, pinned, progress, waits) {
            Ok(()) => {
                std::fs::rename(&partial, &path)
                    .map_err(|error| format!("could not keep {}: {error}", path.display()))?;
                return Ok(path);
            }
            Err(error) => {
                if !last {
                    log::warn!(
                        "[download] {error}; downloading {} instead",
                        pinned.sources[index + 1]
                    );
                }
                last_error = error;
            }
        }
    }
    Err(last_error)
}

/// The bytes of a partial file so far, hashed, so a download can carry on from them.
struct Resumed {
    file: File,
    hasher: Sha256,
    bytes: u64,
}

impl Resumed {
    fn open(partial: &Path) -> Result<Self, String> {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(partial)
            .map_err(|error| format!("could not write {}: {error}", partial.display()))?;
        let mut hasher = Sha256::new();
        let mut bytes = 0u64;
        let mut buffer = vec![0u8; 1 << 20];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|error| format!("could not read {}: {error}", partial.display()))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            bytes += read as u64;
        }
        Ok(Self {
            file,
            hasher,
            bytes,
        })
    }

    /// Back to nothing: the server sent the whole file, or what was there was not the file.
    fn restart(&mut self) -> Result<(), String> {
        self.file
            .set_len(0)
            .and_then(|()| self.file.rewind())
            .map_err(|error| format!("could not start the download again: {error}"))?;
        self.hasher = Sha256::new();
        self.bytes = 0;
        Ok(())
    }
}

/// Why one attempt failed, and so whether another could succeed.
enum Failed {
    ForNow(String),
    ForGood(String),
}

/// `source` into `partial`, carrying on from what is there, with an attempt more than `waits`.
/// Done when the whole file is there with the pinned digest.
fn download_resuming(
    source: &str,
    partial: &Path,
    pinned: &Pinned,
    progress: &dyn Progress,
    waits: &[Duration],
) -> Result<(), String> {
    let mut attempts = 1;
    loop {
        let result = attempt(source, partial, pinned, progress);
        match result {
            Ok(()) => return Ok(()),
            Err(Failed::ForGood(error)) => return Err(error),
            Err(Failed::ForNow(error)) => match waits.get(attempts - 1) {
                Some(wait) => {
                    log::warn!(
                        "[download] attempt {attempts} of {}: {error}; trying again",
                        waits.len() + 1
                    );
                    std::thread::sleep(*wait);
                    attempts += 1;
                }
                None if attempts == 1 => return Err(error),
                None => return Err(format!("{error} ({attempts} attempts)")),
            },
        }
    }
}

/// How long connecting may take, and how long a download may go without a byte arriving: the same
/// as `deployment::get`'s, which has no limit on the whole download, only on silence.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const STALL_TIMEOUT: Duration = Duration::from_secs(30);

fn client() -> Result<reqwest::blocking::Client, Failed> {
    reqwest::blocking::Client::builder()
        .user_agent("openbot-desktop")
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(STALL_TIMEOUT)
        .build()
        .map_err(|error| Failed::ForGood(format!("could not prepare the download: {error}")))
}

fn attempt(
    source: &str,
    partial: &Path,
    pinned: &Pinned,
    progress: &dyn Progress,
) -> Result<(), Failed> {
    let mut have = Resumed::open(partial).map_err(Failed::ForGood)?;
    let client = client()?;
    let mut token: Option<String> = None;
    let mut response = loop {
        let mut request = client.get(source);
        if have.bytes > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={}-", have.bytes));
        }
        if let Some(token) = &token {
            request = request.bearer_auth(token);
        }
        let response = request
            .send()
            .map_err(|error| Failed::ForNow(format!("could not reach {source}: {error}")))?;
        // A registry answers an anonymous download with the token to ask for (quay.io does).
        if response.status() == reqwest::StatusCode::UNAUTHORIZED && token.is_none() {
            token = Some(anonymous_token(&client, &response).ok_or_else(|| {
                Failed::ForGood(format!(
                    "{source} asked for credentials OpenBot does not have"
                ))
            })?);
            continue;
        }
        break response;
    };

    let status = response.status();
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        // What is there is as long as the file or longer, and was not the file.
        have.restart().map_err(Failed::ForGood)?;
        return Err(Failed::ForNow(format!(
            "{source} had nothing after the part already downloaded"
        )));
    }
    if !status.is_success() {
        let error = format!("{source} answered {status}");
        return Err(
            if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                Failed::ForNow(error)
            } else {
                Failed::ForGood(error)
            },
        );
    }
    let resumes = status == reqwest::StatusCode::PARTIAL_CONTENT
        && response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|range| range.to_str().ok())
            .is_some_and(|range| range.starts_with(&format!("bytes {}-", have.bytes)));
    if !resumes && have.bytes > 0 {
        // The whole file, from the start: what was there is replaced.
        log::info!(
            "[download] {source} sent the whole file, so {} starts again",
            pinned.name
        );
        have.restart().map_err(Failed::ForGood)?;
    }
    if have.bytes > 0 {
        log::info!(
            "[download] {} from {source}, carrying on after {} bytes",
            pinned.name,
            have.bytes
        );
    } else {
        log::info!("[download] {} from {source}", pinned.name);
    }
    have.file
        .seek(std::io::SeekFrom::Start(have.bytes))
        .map_err(|error| Failed::ForGood(format!("could not write the download: {error}")))?;
    if pinned.size.is_none() {
        if let Some(length) = response.content_length() {
            progress.size(have.bytes + length);
        }
    }
    progress.bytes(have.bytes);

    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read = match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) => {
                let _ = have.file.flush();
                return Err(Failed::ForNow(format!(
                    "the download stopped after {} bytes: {error}",
                    have.bytes
                )));
            }
        };
        have.file
            .write_all(&buffer[..read])
            .map_err(|error| Failed::ForGood(format!("could not write the download: {error}")))?;
        have.hasher.update(&buffer[..read]);
        have.bytes += read as u64;
        progress.bytes(have.bytes);
        if pinned.size.is_some_and(|size| have.bytes > size) {
            have.restart().map_err(Failed::ForGood)?;
            return Err(Failed::ForGood(format!(
                "{source} sent more than the {} bytes {} has",
                pinned.size.unwrap_or_default(),
                pinned.name
            )));
        }
    }
    have.file
        .flush()
        .map_err(|error| Failed::ForGood(format!("could not write the download: {error}")))?;
    let got = hex(&have.hasher.clone().finalize());
    if got == pinned.sha256 {
        log::info!(
            "[download] {}: {} bytes, sha256 {got} as pinned",
            pinned.name,
            have.bytes
        );
    }
    if got != pinned.sha256 {
        have.restart().map_err(Failed::ForGood)?;
        return Err(Failed::ForGood(format!(
            "{} from {source} is not what OpenBot expected: sha256 {got}, expected {}",
            pinned.name, pinned.sha256
        )));
    }
    Ok(())
}

/// The anonymous token a registry's `WWW-Authenticate: Bearer` challenge offers, as an engine asks
/// for it (https://distribution.github.io/distribution/spec/auth/token/). See `registry`.
fn anonymous_token(
    client: &reqwest::blocking::Client,
    response: &reqwest::blocking::Response,
) -> Option<String> {
    let challenge = response
        .headers()
        .get(reqwest::header::WWW_AUTHENTICATE)?
        .to_str()
        .ok()?;
    #[derive(serde::Deserialize)]
    struct Token {
        token: Option<String>,
        access_token: Option<String>,
    }
    let answer: Token = client
        .get(crate::registry::token_url(challenge)?)
        .send()
        .ok()?
        .json()
        .ok()?;
    answer.token.or(answer.access_token)
}

// ---------------------------------------------------------------------------------------------
// What the window shows.
// ---------------------------------------------------------------------------------------------

/// Where the early downloads are, as the setup window says it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub state: State,
    /// Downloaded so far, over every download.
    pub bytes: u64,
    /// Every download together, once each one's size is known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_per_second: Option<u64>,
    /// Free on this computer's disk, and what setup needs, when the disk is short.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needed: Option<u64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    /// Not started, or working out what to download.
    #[default]
    Idle,
    /// Not enough free disk; waiting for some.
    Short,
    Downloading,
    /// Everything planned is on disk, or in the engine.
    Done,
    /// Something did not download. Install downloads it again when it gets there.
    Failed,
    /// There is nothing to download early: this installation has everything already.
    Nothing,
}

/// One download in the table.
#[derive(Clone, Debug, Default)]
struct Entry {
    size: Option<u64>,
    bytes: u64,
    finished: bool,
    failed: bool,
}

/// The table the window's line is made from, and the speed it is measured at.
#[derive(Default)]
struct Table {
    state: State,
    entries: BTreeMap<&'static str, Entry>,
    /// What OpenBot's image pulls report: Install shows the same while it waits for them.
    images: Option<crate::pull_metrics::Downloads>,
    free: Option<u64>,
    needed: Option<u64>,
    speed: Speed,
}

fn table() -> MutexGuard<'static, Table> {
    static TABLE: OnceLock<Mutex<Table>> = OnceLock::new();
    TABLE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|held| held.into_inner())
}

/// Download speed over the last few seconds.
#[derive(Default)]
struct Speed {
    samples: std::collections::VecDeque<(Instant, u64)>,
}

impl Speed {
    const WINDOW: Duration = Duration::from_secs(8);

    fn observe(&mut self, now: Instant, bytes: u64) -> Option<u64> {
        self.samples.push_back((now, bytes));
        while self
            .samples
            .front()
            .is_some_and(|(at, _)| now.saturating_duration_since(*at) > Self::WINDOW)
        {
            self.samples.pop_front();
        }
        let (first_at, first_bytes) = *self.samples.front()?;
        let seconds = now.saturating_duration_since(first_at).as_secs_f64();
        (seconds >= 1.0).then(|| (bytes.saturating_sub(first_bytes) as f64 / seconds) as u64)
    }
}

impl Table {
    fn summary(&mut self, now: Instant) -> Summary {
        let bytes = self.entries.values().map(|entry| entry.bytes).sum::<u64>();
        let size = self
            .entries
            .values()
            .map(|entry| entry.size)
            .sum::<Option<u64>>()
            .filter(|size| *size > 0);
        let bytes_per_second = self.speed.observe(now, bytes);
        Summary {
            state: self.state,
            bytes,
            size,
            bytes_per_second: bytes_per_second.filter(|_| self.state == State::Downloading),
            free: self.free.filter(|_| self.state == State::Short),
            needed: self.needed.filter(|_| self.state == State::Short),
        }
    }

    /// Done or failed once every download has finished.
    fn settle(&mut self) {
        if self.state != State::Downloading || self.entries.values().any(|entry| !entry.finished) {
            return;
        }
        self.state = if self.entries.values().any(|entry| entry.failed) {
            State::Failed
        } else {
            State::Done
        };
    }
}

/// Where the early downloads are now.
pub fn summary() -> Summary {
    table().summary(Instant::now())
}

/// One download's progress, into the table.
pub(crate) struct Tracked(pub(crate) &'static str);

impl Progress for Tracked {
    fn size(&self, size: u64) {
        table().entries.entry(self.0).or_default().size = Some(size);
    }
    fn bytes(&self, bytes: u64) {
        table().entries.entry(self.0).or_default().bytes = bytes;
    }
}

fn track(key: &'static str, size: Option<u64>) {
    let mut table = table();
    let entry = table.entries.entry(key).or_default();
    if entry.size.is_none() {
        entry.size = size;
    }
}

fn finish(key: &'static str, outcome: Result<(), String>) {
    let mut table = table();
    let entry = table.entries.entry(key).or_default();
    entry.finished = true;
    if let Err(error) = outcome {
        log::warn!("[early downloads] {key}: {error}");
        entry.failed = true;
    } else {
        // Done is all of it, whatever the size was thought to be.
        entry.size = Some(entry.size.unwrap_or(entry.bytes).max(entry.bytes));
        entry.bytes = entry.size.unwrap_or(entry.bytes);
        log::info!("[early downloads] {key} is ready");
    }
    table.settle();
}

// ---------------------------------------------------------------------------------------------
// What to download.
// ---------------------------------------------------------------------------------------------

/// What this computer has, read once when the first screen shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Facts {
    pub os: &'static str,
    /// The engine Install will use, as `install::choose` decides it.
    pub choice: crate::install::Choice,
    /// The Podman on this computer answers `--version` with this, when there is one.
    pub podman_version: Option<String>,
    /// OpenBot's Podman machine is already there.
    pub machine_exists: bool,
    /// An engine answers now, so images can go straight into it.
    pub answering: Option<Address>,
    /// This folder has finished an installation or a start before.
    pub installed_before: bool,
    pub machine_image: Option<MachineImage>,
}

/// What to download early.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Plan {
    pub machine_image: Option<MachineImage>,
    pub podman: bool,
    pub compose: bool,
    pub deployment: bool,
    /// The engine to pull OpenBot's images into.
    pub images: Option<Address>,
    /// With no engine answering, OpenBot's images downloaded into the cache, to load once one
    /// does (`early_images`).
    pub offline_images: bool,
}

impl Plan {
    pub fn is_empty(&self) -> bool {
        self == &Plan::default()
    }

    /// About how much these downloads add to the disk, for the free-space check. The images and
    /// Podman's files are estimates measured on 2026-11-09: their sizes are known only once their
    /// downloads answer.
    pub fn disk_bytes(&self) -> u64 {
        const MB: u64 = 1_000_000;
        self.machine_image.map_or(0, |image| image.size)
            + if self.podman { 80 * MB } else { 0 }
            + if self.compose { 35 * MB } else { 0 }
            + if self.images.is_some() || self.offline_images {
                1_200 * MB
            } else {
                0
            }
    }
}

/// What to download early on a computer with these `facts`.
///
/// Nothing for an installation that finished before: its machine and images are there. Otherwise
/// the deployment always, and:
///
/// - Podman's installer and Compose when Install will install Podman (macOS and Windows; Linux's
///   Podman comes from its own packages);
/// - the machine image when Install will create OpenBot's machine with a Podman that pulls the
///   pinned machine-os release;
/// - OpenBot's images: into an engine that answers already, or into the cache to load once one
///   does. Their list comes from OpenBot's own Compose, so that downloads too (`named_images`).
pub fn plan(facts: &Facts) -> Plan {
    use crate::install::Choice;
    if facts.installed_before {
        return Plan::default();
    }
    let desktop = matches!(facts.os, "macos" | "windows");
    // A Podman too old for OpenBot is updated with the same installer (`engine_versions::ensure`).
    let too_old = facts
        .podman_version
        .as_deref()
        .and_then(crate::engine_versions::Version::find)
        .is_some_and(|version| version < crate::engine_versions::PODMAN);
    let installs_podman = desktop
        && (facts.choice == Choice::InstallPodman
            || (facts.choice == Choice::UsePodman && too_old));
    let creates_machine = desktop
        && match facts.choice {
            Choice::InstallPodman => true,
            Choice::UsePodman => {
                !facts.machine_exists
                    && facts
                        .podman_version
                        .as_deref()
                        .is_some_and(podman_takes_pinned_machine_image)
            }
            _ => false,
        };
    // No engine answers: OpenBot's images download now, to load once one does.
    let offline_images = desktop
        && facts.answering.is_none()
        && matches!(
            facts.choice,
            Choice::InstallPodman | Choice::UsePodman | Choice::OpenDockerDesktop
        );
    let images = facts.answering.clone();
    Plan {
        machine_image: facts.machine_image.filter(|_| creates_machine),
        podman: installs_podman,
        // Install's Compose for a new Podman, and the one that names OpenBot's images either way.
        compose: installs_podman || images.is_some() || offline_images,
        deployment: true,
        images,
        offline_images,
    }
}

/// This computer's facts, for the installation in `root`.
fn facts_here(root: &Path) -> Facts {
    let saved = crate::preparation::saved_engine(root);
    let choice = crate::install::choice_here(saved);
    let podman_version = crate::engine::program(Engine::Podman).and_then(|_| {
        let output = crate::engine::tool(Engine::Podman)
            .arg("--version")
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
    });
    let machine_exists = choice == crate::install::Choice::UsePodman
        && crate::acquire::machine_exists().unwrap_or(true);
    let status = crate::engine::detect_saved(saved);
    let answering = status
        .address
        .filter(|_| status.responding)
        .and_then(|address| address.pin().ok());
    Facts {
        os: std::env::consts::OS,
        choice,
        podman_version,
        machine_exists,
        answering,
        installed_before: crate::preparation::installed_before(root),
        machine_image: machine_image(),
    }
}

// ---------------------------------------------------------------------------------------------
// Running them.
// ---------------------------------------------------------------------------------------------

/// Where downloaded engine files are kept: the folder `install.rs` keeps Podman and Compose in.
pub fn cache() -> PathBuf {
    crate::acquire::download_dir(&crate::stack::default_root())
}

/// What the running app does with the early downloads: tell the window, and record a pull.
pub struct Hooks {
    pub said: Box<dyn Fn(Summary) + Send + Sync>,
    pub pulled: Box<dyn Fn(crate::pull_metrics::PullMetrics) + Send + Sync>,
}

/// Held while the deployment is laid out, by the early downloads or by Install.
pub fn hold_deployment() -> MutexGuard<'static, ()> {
    static DEPLOYMENT: Mutex<()> = Mutex::new(());
    hold(&DEPLOYMENT)
}

/// Held while OpenBot's images are pulled early.
fn images_lock() -> &'static Mutex<()> {
    static IMAGES: Mutex<()> = Mutex::new(());
    &IMAGES
}

/// Start the early downloads for the installation in `root`, once per run of the app. Answers at
/// once; the downloads run on threads of their own and say where they are through `hooks`.
pub fn start(root: PathBuf, hooks: Hooks) {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let hooks = Arc::new(hooks);
    std::thread::spawn(move || {
        let facts = facts_here(&root);
        let plan = plan(&facts);
        log::info!("[early downloads] {facts:?} plans {plan:?}");
        let cache = cache();
        if plan.machine_image.is_none() {
            // A machine image that is no longer needed is not kept: it is most of a gigabyte.
            forget_machine_image_in(&cache);
        }
        let needed = needed_for(&plan);
        let jobs = jobs(&root, &plan, &cache, &hooks);
        let said = |summary| (hooks.said)(summary);
        run(jobs, needed, || free_space(&cache), &said, DISK_RECHECK);
    });
}

/// How long between two looks at the free disk, while it is short.
const DISK_RECHECK: Duration = Duration::from_secs(10);

/// The free disk OpenBot needs for `plan`: the back end's 40 GiB, and the downloads themselves.
pub fn needed_for(plan: &Plan) -> u64 {
    crate::local_eval::MIN_ENGINE_FREE_DISK_BYTES + plan.disk_bytes()
}

/// One early download: its row in the table, its size when it is known, and the work.
pub struct Job {
    key: &'static str,
    size: Option<u64>,
    /// Further rows this job finishes itself.
    also: Vec<&'static str>,
    work: Box<dyn FnOnce() -> Result<(), String> + Send>,
}

impl Job {
    /// A download of `pinned` into `into`, in the table as `key`.
    pub fn file(key: &'static str, pinned: Pinned, into: PathBuf) -> Self {
        Self {
            key,
            size: pinned.size,
            also: Vec::new(),
            work: Box::new(move || fetch(&pinned, &into, &Tracked(key)).map(drop)),
        }
    }
}

/// The jobs for `plan`.
fn jobs(root: &Path, plan: &Plan, cache: &Path, hooks: &Arc<Hooks>) -> Vec<Job> {
    let mut jobs = Vec::new();
    if let Some(image) = plan.machine_image {
        jobs.push(Job::file(
            "machine-image",
            machine_pinned(&image),
            cache.to_path_buf(),
        ));
    }
    if plan.podman {
        let cache = cache.to_path_buf();
        jobs.push(Job {
            key: "podman",
            size: None,
            also: Vec::new(),
            work: Box::new(move || {
                crate::install::fetch_podman_installer(&cache, &Tracked("podman")).map(drop)
            }),
        });
    }
    if plan.compose {
        let cache = cache.to_path_buf();
        jobs.push(Job {
            key: "compose",
            size: None,
            also: Vec::new(),
            work: Box::new(move || {
                crate::install::fetch_compose(&cache, &Tracked("compose")).map(drop)
            }),
        });
    }
    if plan.deployment && plan.offline_images {
        let root = root.to_path_buf();
        let cache = cache.to_path_buf();
        jobs.push(Job {
            key: "images",
            size: None,
            also: vec!["deployment"],
            work: Box::new(move || {
                let _only = hold(images_lock());
                let laid_out = lay_out_deployment(&root);
                let ok = laid_out.is_ok();
                finish("deployment", laid_out);
                if !ok {
                    return Err("the deployment did not download".into());
                }
                download_offline_images(&root, &cache)
            }),
        });
        return jobs;
    }
    if plan.deployment {
        let root = root.to_path_buf();
        match plan.images.clone() {
            // The deployment is under a megabyte: a row so "done" waits for it, with no bytes.
            None => jobs.push(Job {
                key: "deployment",
                size: Some(0),
                also: Vec::new(),
                work: Box::new(move || lay_out_deployment(&root)),
            }),
            // The images are named by the deployment's image list, so they come after it, and
            // Install waits for them from the start (`wait_for_images`).
            Some(engine) => {
                let hooks = hooks.clone();
                let cache = cache.to_path_buf();
                jobs.push(Job {
                    key: "images",
                    size: None,
                    also: vec!["deployment"],
                    work: Box::new(move || {
                        let _only = hold(images_lock());
                        let laid_out = lay_out_deployment(&root);
                        let ok = laid_out.is_ok();
                        finish("deployment", laid_out);
                        if !ok {
                            return Err("the deployment did not download".into());
                        }
                        pull_images(&engine, &root, &cache, &hooks)
                    }),
                });
            }
        }
    }
    jobs
}

/// Run `jobs` once `free` says there is `needed` free, all at once, saying where they are through
/// `said` while they run. With less free, nothing starts: the window is told both numbers, and
/// `free` is asked again every `recheck`.
pub fn run(
    jobs: Vec<Job>,
    needed: u64,
    free: impl Fn() -> Option<u64>,
    said: &(dyn Fn(Summary) + Sync),
    recheck: Duration,
) {
    if jobs.is_empty() {
        table().state = State::Nothing;
        said(summary());
        return;
    }
    loop {
        match free() {
            Some(free) if free < needed => {
                {
                    let mut table = table();
                    table.state = State::Short;
                    table.free = Some(free);
                    table.needed = Some(needed);
                }
                log::warn!(
                    "[early downloads] {free} bytes free, {needed} needed: waiting for space"
                );
                said(summary());
                std::thread::sleep(recheck);
            }
            _ => break,
        }
    }

    log::info!(
        "[early downloads] downloading before Install: {}",
        jobs.iter()
            .map(|job| job.key)
            .collect::<Vec<_>>()
            .join(", ")
    );
    {
        let mut table = table();
        table.state = State::Downloading;
        table.free = None;
        table.needed = None;
        for job in &jobs {
            for key in std::iter::once(job.key).chain(job.also.iter().copied()) {
                let entry = table.entries.entry(key).or_default();
                entry.size = entry
                    .size
                    .or(if key == job.key { job.size } else { Some(0) });
            }
        }
    }
    let ticking = std::sync::atomic::AtomicBool::new(true);
    std::thread::scope(|scope| {
        let workers: Vec<_> = jobs
            .into_iter()
            .map(|job| {
                scope.spawn(move || {
                    let key = job.key;
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job.work))
                        .unwrap_or_else(|_| Err("the download stopped unexpectedly".into()));
                    finish(key, outcome);
                })
            })
            .collect();
        let ticking = &ticking;
        scope.spawn(move || {
            while ticking.load(std::sync::atomic::Ordering::SeqCst) {
                said(summary());
                std::thread::sleep(Duration::from_millis(500));
            }
        });
        for worker in workers {
            let _ = worker.join();
        }
        ticking.store(false, std::sync::atomic::Ordering::SeqCst);
    });
    table().settle();
    said(summary());
}

fn machine_pinned(image: &MachineImage) -> Pinned {
    Pinned {
        name: image.file.to_string(),
        sha256: image.sha256().to_string(),
        size: Some(image.size),
        sources: image.sources(),
    }
}

/// Lay the latest deployment out in `root`, as Install's deployment step does, unless it is there.
fn lay_out_deployment(root: &Path) -> Result<(), String> {
    let _only = hold_deployment();
    // An installation on another release is Start's to move (`upgrade`), never this.
    if crate::deployment::installed(root).is_some() {
        return Ok(());
    }
    let version = crate::deployment_release::resolve_version(root)?;
    if crate::deployment::needs_fetch(root, &version) {
        match crate::deployment::pinned().filter(|pin| pin.version == version) {
            Some(pin) => crate::deployment::fetch_pinned(root, &pin)?,
            None => crate::deployment::fetch(root, &version)?,
        }
    }
    Ok(())
}

/// The images Install pulls for the default Bot, from the deployment laid out in `root`, asked of
/// Compose as Install asks it. Compose reads the release from a folder that is not an
/// installation, so nothing is decided or recorded for `root` before Install (`release_images`
/// reads a release the same way).
pub fn default_bot_images(engine: &Address, root: &Path) -> Result<Vec<String>, String> {
    let harness = crate::harness::HarnessChoice {
        id: crate::harness::DEFAULT_HARNESS.into(),
        agent_url: None,
    };
    let nowhere = root.join(".openbot-early-downloads-nowhere");
    crate::preparation::installation_pull_set(engine, &nowhere, root, Some(&harness)).map_err(
        |problem| {
            format!(
                "{}{}",
                problem.said,
                problem
                    .detail
                    .map(|detail| format!(" ({detail})"))
                    .unwrap_or_default()
            )
        },
    )
}

/**
The images Install pulls for the default Bot, from the deployment laid out in `root`, named by
OpenBot's own Compose: `compose` gives its path, waiting for its download when the first screen is
still downloading it.

Never the engine's Compose. On Windows D a person's Podman 5.8.9 answered with no Compose installed,
and `podman compose` failed looking up a provider before OpenBot's own was in place, so the first
screen said its downloads didn't finish. A Docker Desktop's Compose can be one too old to read the
project (`engine_versions`). OpenBot's own is the pinned one Install uses, and `config --images`
needs no engine.
*/
pub fn named_images(
    root: &Path,
    compose: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<Vec<String>, String> {
    let compose = compose()?;
    let harness = crate::harness::HarnessChoice {
        id: crate::harness::DEFAULT_HARNESS.into(),
        agent_url: None,
    };
    let nowhere = root.join(".openbot-early-downloads-nowhere");
    crate::preparation::installation_pull_set_by(
        |settings| crate::stack::standalone_compose_command(&compose, &nowhere, settings),
        &nowhere,
        root,
        Some(&harness),
    )
    .map_err(|problem| {
        format!(
            "{}{}",
            problem.said,
            problem
                .detail
                .map(|detail| format!(" ({detail})"))
                .unwrap_or_default()
        )
    })
}

/// OpenBot's own Compose, from the cache, waiting for the first screen's download of it.
fn own_compose(cache: &Path) -> impl FnOnce() -> Result<PathBuf, String> + '_ {
    move || crate::install::runnable_compose(cache, &())
}

/// OpenBot's images for the default Bot, downloaded into the cache for Install to load once the
/// engine answers (`early_images`).
fn download_offline_images(root: &Path, cache: &Path) -> Result<(), String> {
    let images = named_images(root, own_compose(cache))?;
    log::info!(
        "[early images] downloading {} before any engine answers",
        images.join(", ")
    );
    crate::early_images::download(
        &images,
        &crate::early_images::Registries::openbot(),
        crate::registry::host_architecture(),
        &crate::early_images::folder(cache),
        &Tracked("images"),
    )
    .map(drop)
}

/// Load the images downloaded before the engine answered into `engine`, once their download has
/// finished, saying how far it is through `said`. Install's pull then finds them there.
pub fn load_offline_images(engine: &Address, said: impl Fn(crate::pull_metrics::Downloads)) {
    let _only = hold(images_lock());
    let loaded =
        crate::early_images::load_downloaded(engine, &crate::early_images::folder(&cache()), said);
    if loaded > 0 {
        log::info!("[early images] {loaded} images loaded into the engine");
    }
}

/// OpenBot's images for the default Bot, pulled into `engine` with Install's own pull.
fn pull_images(engine: &Address, root: &Path, cache: &Path, hooks: &Hooks) -> Result<(), String> {
    let images = named_images(root, own_compose(cache))?;
    let present = {
        let engine = engine.clone();
        move |image: &str| crate::preparation::image_present(&engine, image).unwrap_or(false)
    };
    let sizes = crate::pull_metrics::size_images(&images, present);
    crate::pull_metrics::pull_images_limited(
        &images,
        crate::pull_metrics::IMAGE_PULLS_AT_ONCE,
        sizes,
        |_, image, on_layer| {
            crate::pull_metrics::pull_image(engine, image, on_layer, |metrics| {
                (hooks.pulled)(metrics)
            })
        },
        || Ok(()),
        |downloads| {
            let mut table = table();
            let entry = table.entries.entry("images").or_default();
            entry.bytes = downloads.bytes;
            entry.size = downloads.size;
            table.images = Some(downloads.clone());
        },
    )
    .map_err(|problem| problem.said)
}

/// Wait for OpenBot's images to finish pulling early, if they are, saying where they are while it
/// waits. Install's own pull then finds them there.
pub fn wait_for_images(said: impl Fn(&crate::pull_metrics::Downloads)) {
    let lock = images_lock();
    let mut pacer = crate::pull_metrics::Pacer::default();
    loop {
        if let Ok(_done) = lock.try_lock() {
            return;
        }
        // The early pull's own report, or the bytes of images downloading for an engine to come.
        let images = {
            let table = table();
            table.images.clone().or_else(|| {
                table
                    .entries
                    .get("images")
                    .map(|entry| crate::pull_metrics::Downloads {
                        done: 0,
                        total: 0,
                        bytes: entry.bytes,
                        size: entry.size,
                        bytes_per_second: None,
                    })
            })
        };
        if let Some(downloads) = images {
            if let Some(paced) = pacer.offer(Instant::now(), &downloads) {
                said(&paced);
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// The machine image for `podman machine init --image`, downloaded and checked, or `None` when
/// Podman should pull its own: no image for this computer, a Podman that pulls another machine-os
/// release, or a download that failed (said in the log). Waits for the early download if it is
/// running, saying how far it is.
pub fn machine_image_for_init(
    said: impl Fn(crate::pull_metrics::Downloads) + Sync,
) -> Option<PathBuf> {
    let image = machine_image()?;
    let version = crate::engine::tool(Engine::Podman)
        .arg("--version")
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())?;
    if !podman_takes_pinned_machine_image(&version) {
        log::info!("[early downloads] {version} pulls its own machine image");
        return None;
    }
    match machine_image_waiting(&machine_pinned(&image), &cache(), said) {
        Ok(path) => Some(path),
        Err(error) => {
            log::warn!(
                "[early downloads] the machine image did not download: {error}; Podman pulls its own"
            );
            None
        }
    }
}

/// `pinned` into `cache`, saying how far the download is every quarter of a second, whoever runs
/// it: this call, or the early download it waits for.
pub fn machine_image_waiting(
    pinned: &Pinned,
    cache: &Path,
    said: impl Fn(crate::pull_metrics::Downloads) + Sync,
) -> Result<PathBuf, String> {
    let reporting = std::sync::atomic::AtomicBool::new(true);
    track("machine-image", pinned.size);
    std::thread::scope(|scope| {
        let (reporting, said) = (&reporting, &said);
        scope.spawn(move || {
            let mut pacer = crate::pull_metrics::Pacer::default();
            while reporting.load(std::sync::atomic::Ordering::SeqCst) {
                let entry = table().entries.get("machine-image").cloned();
                if let Some(entry) = entry {
                    // One file: its bytes, with no count of items beside them.
                    let downloads = crate::pull_metrics::Downloads {
                        done: 0,
                        total: 0,
                        bytes: entry.bytes,
                        size: entry.size,
                        bytes_per_second: None,
                    };
                    if let Some(paced) = pacer.offer(Instant::now(), &downloads) {
                        said(paced);
                    }
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        });
        let fetched = fetch(pinned, cache, &Tracked("machine-image"));
        reporting.store(false, std::sync::atomic::Ordering::SeqCst);
        fetched
    })
}

/// The machine is created: its image is in the machine now, and the download is not kept.
pub fn forget_machine_image() {
    forget_machine_image_in(&cache());
}

fn forget_machine_image_in(cache: &Path) {
    let Some(image) = machine_image() else {
        return;
    };
    for path in [cache.join(image.file), partial_path(cache, image.file)] {
        match std::fs::remove_file(&path) {
            Ok(()) => log::info!("[early downloads] removed {}", path.display()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => log::warn!(
                "[early downloads] could not remove {}: {error}",
                path.display()
            ),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Free disk.
// ---------------------------------------------------------------------------------------------

/// The bytes free to this account on the disk that holds `path`, or the nearest folder above it
/// that exists. `None` when it cannot be read, which is not judged.
pub fn free_space(path: &Path) -> Option<u64> {
    let existing = path.ancestors().find(|folder| folder.exists())?;
    free_space_at(existing)
}

#[cfg(unix)]
fn free_space_at(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `path` is NUL-terminated and outlives the call; `stats` is a statvfs it may write.
    if unsafe { libc::statvfs(path.as_ptr(), &mut stats) } != 0 {
        return None;
    }
    #[allow(clippy::unnecessary_cast)]
    Some(stats.f_bavail as u64 * stats.f_frsize as u64)
}

#[cfg(windows)]
fn free_space_at(path: &Path) -> Option<u64> {
    crate::windows::free_space(&path.to_string_lossy())
}

#[cfg(test)]
pub(crate) mod tests;
