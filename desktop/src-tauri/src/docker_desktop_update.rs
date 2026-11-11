//! Updating Docker Desktop for the person, when it is too old to run OpenBot.
//!
//! Docker documents one way to install Docker Desktop from outside it, and it installs over an
//! existing one: the installer's own command line.
//!
//! - **macOS.** `Docker.app/Contents/MacOS/install` from the release's `Docker.dmg`, run as root
//!   (https://docs.docker.com/desktop/setup/install/mac-install/). OpenBot raises macOS's own
//!   password prompt for it, as it does for Podman. `--user=<name>` does the privileged setup once,
//!   now, so the updated Docker Desktop does not ask for the password again when it starts.
//! - **Windows.** `"Docker Desktop Installer.exe" install --quiet`
//!   (https://docs.docker.com/desktop/setup/install/windows-install/), with `--user` for a per-user
//!   installation, which needs no administrator, and through Windows' approval prompt for an
//!   all-users one. Docker says updates follow the installation's mode, and that changing mode
//!   means uninstalling, so the mode found is the mode kept.
//!
//! **Docker's terms stay the person's.** `--accept-license` would accept Docker's Subscription
//! Service Agreement for them, and it is never passed. Somebody updating a Docker Desktop they have
//! used accepted the terms already; if Docker wants them accepted again, Docker Desktop shows them
//! when it starts, in its own window, and OpenBot says so and waits (`docker_desktop::start`).
//!
//! **Nothing unverified is run.** The release is the newest one in Docker's own update feed
//! (`appcast.xml` on desktop.docker.com, the feed Docker Desktop's updater reads). The installer
//! comes from the same build's folder, is checked against the build's `checksums.txt`, and is
//! then checked against Docker's signature, which does not come from the server: on a Mac,
//! `codesign` must accept `Docker.app` and name Docker's team (`TEAM_ID`); on Windows, Authenticode
//! must call the installer valid and signed by Docker Inc.
//!
//! **Only Docker's own installer touches Docker.** Quitting Docker Desktop stops the containers in
//! it, as Docker's own updater does; images, containers and volumes stay on Docker's disk, which
//! the installer leaves alone. OpenBot never removes or moves any of them.
//!
//! **When it cannot be done unattended** (the installer stopped with an error), the verified
//! installer is opened for the person, one plain line says what to do, and OpenBot carries on by
//! itself once Docker answers with a Compose new enough.

// Linux has no Docker Desktop: only the parsing and the plan are used there, by the tests.
#![cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::engine::{Address, Engine, StepLine};
use crate::engine_versions::{self, Verdict};
use crate::problem::Problem;

/// Docker Inc's Apple Developer team, which signs Docker.app. Read from `codesign -dv` of every
/// Docker Desktop checked here, 4.27.2 and 4.98.0 among them.
pub const TEAM_ID: &str = "9BNSXJN65R";

/// Why Docker Desktop is updating, said first on every line while it does: it is the person's own
/// app, and they see it close and come back.
pub const UPDATING_WHY: &str =
    "The Docker Desktop on this computer is too old for OpenBot, so OpenBot is updating it.";

/// What a person reads while Docker updates. `minutes` is the estimate, when there is one.
pub fn updating_line(minutes: Option<u64>) -> StepLine {
    let said = match minutes {
        Some(0 | 1) => format!("{UPDATING_WHY} About a minute left."),
        Some(minutes) => format!("{UPDATING_WHY} About {minutes} minutes left."),
        None => UPDATING_WHY.to_string(),
    };
    StepLine::here(said).updating()
}

/// How long installing takes once the download is done, for the estimate. Docker says the Mac
/// installer "can take several minutes" because of macOS's security checks.
const INSTALL_ALLOWANCE: Duration = Duration::from_secs(4 * 60);

/// Docker's update feed for this kind of computer.
pub fn appcast_url(os: &str, arch: &str) -> Option<String> {
    let (platform, arch) = match (os, arch) {
        ("macos", "aarch64") => ("mac", "arm64"),
        ("macos", "x86_64") => ("mac", "amd64"),
        ("windows", "x86_64") => ("win", "amd64"),
        ("windows", "aarch64") => ("win", "arm64"),
        _ => return None,
    };
    Some(format!(
        "https://desktop.docker.com/{platform}/main/{arch}/appcast.xml"
    ))
}

/// The newest release in Docker's update feed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    /// "4.98.0".
    pub version: String,
    /// Docker's build number, which names the release's folder: "245422".
    pub build: String,
    /// The full installer, not a delta.
    pub url: String,
    /// What the release needs of the operating system, as Docker writes it: "14.0.0" on a Mac,
    /// "[BuildNumber] >= 19045" on Windows.
    pub minimum_os: Option<String>,
}

impl Release {
    /// The installer's file name, as Docker names it: "Docker.dmg", "Docker Desktop Installer.exe".
    pub fn file(&self) -> String {
        self.url
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .replace("%20", " ")
    }

    /// The build's own checksums, beside the installer.
    pub fn checksums_url(&self) -> String {
        match self.url.rsplit_once('/') {
            Some((folder, _)) => format!("{folder}/checksums.txt"),
            None => String::new(),
        }
    }

    /// The installer's URL with the spaces Docker's feed leaves in it encoded.
    pub fn download_url(&self) -> String {
        self.url.replace(' ', "%20")
    }
}

/// The first `<item>` of Docker's feed, which is the newest release.
pub fn latest(appcast: &str) -> Option<Release> {
    let item = between(appcast, "<item>", "</item>")?;
    // The full installer's enclosure comes before the deltas'.
    let full = item.split("<sparkle:deltas>").next()?;
    let enclosure = between(full, "<enclosure ", ">")?;
    let url = unescape(attribute(enclosure, "url")?);
    if !url.starts_with("https://desktop.docker.com/") {
        return None;
    }
    Some(Release {
        version: unescape(attribute(enclosure, "sparkle:shortVersionString")?),
        build: unescape(attribute(enclosure, "sparkle:version")?),
        url,
        minimum_os: between(
            item,
            "<sparkle:minimumSystemVersion>",
            "</sparkle:minimumSystemVersion>",
        )
        .map(unescape),
    })
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(&text[start..end])
}

/// An attribute's value. Matched after a space, so `url` is not found inside `d4w:url`.
fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    between(tag, &format!(" {name}=\""), "\"").or_else(|| {
        tag.strip_prefix(&format!("{name}=\""))
            .and_then(|rest| rest.split('"').next())
    })
}

fn unescape(text: &str) -> String {
    text.replace("&gt;", ">")
        .replace("&lt;", "<")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// The digest `checksums.txt` gives `file`. Docker has written it two ways: `<hash> *<file>` and,
/// for older builds, `<hash>\t<file>`.
pub fn checksum_for(checksums: &str, file: &str) -> Option<String> {
    checksums.lines().find_map(|line| {
        let line = line.trim();
        let split = line.find(char::is_whitespace)?;
        let (hash, name) = line.split_at(split);
        let name = name.trim().trim_start_matches('*');
        (name == file && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
    })
}

/// Whether this computer can run `release`. `this` is the Mac's `sw_vers -productVersion`, or
/// Windows' build number. A minimum that cannot be read does not stop the update: Docker's
/// installer then says so itself.
pub fn os_supports(os: &str, minimum: Option<&str>, this: Option<&str>) -> bool {
    let (Some(minimum), Some(this)) = (minimum, this) else {
        return true;
    };
    match os {
        "macos" => match (
            engine_versions::Version::find(minimum),
            engine_versions::Version::find(this),
        ) {
            (Some(minimum), Some(this)) => this >= minimum,
            _ => true,
        },
        "windows" => {
            let needed = minimum
                .rsplit(">=")
                .next()
                .and_then(|n| n.trim().parse::<u64>().ok());
            match (needed, this.trim().parse::<u64>().ok()) {
                (Some(needed), Some(build)) => build >= needed,
                _ => true,
            }
        }
        _ => true,
    }
}

/// Windows' build number from `cmd /C ver`: "Microsoft Windows [Version 10.0.26100.4652]".
pub fn windows_build(ver: &str) -> Option<String> {
    let version = between(ver, "Version ", "]")?;
    version.split('.').nth(2).map(str::to_string)
}

/// Whether `codesign -dv` names Docker's team. `codesign` writes it on stderr.
pub fn signed_by_docker_on_mac(codesign_dv: &str) -> bool {
    codesign_dv
        .lines()
        .any(|line| line.trim() == format!("TeamIdentifier={TEAM_ID}"))
}

/*
 * A PATH GOES INTO POWERSHELL IN AN ENVIRONMENT VARIABLE, NEVER AFTER `-Command`.
 *
 * PowerShell joins every argument after `-Command` into the command text, so `$args` is empty and
 * the path becomes code. Docker's installer is downloaded to "...\245422\Docker Desktop
 * Installer.exe": on a live Windows run (Docker Desktop 4.31.1, updating to 4.98.0) the signature
 * check exited 1 on a parse error at that path, with nothing on stdout, and every update stopped
 * with "could not be checked". The same query reading the path from the environment answered
 * "Valid|CN=Docker Inc, O=Docker Inc, ...". A variable is read as it is, spaces and quotes included.
 */

/// The environment variable the signature check reads the installer's path from.
pub const VERIFY_PATH: &str = "OPENBOT_VERIFY_PATH";

/// The environment variable the all-users install reads the installer's path from.
pub const INSTALLER_PATH: &str = "OPENBOT_INSTALLER_PATH";

/// What PowerShell is asked about the installer's Authenticode signature: its status, and the
/// subject of the certificate that signed it, as `<status>|<subject>`. The path is `VERIFY_PATH`.
pub const AUTHENTICODE_QUERY: &str =
    "$s = Get-AuthenticodeSignature -LiteralPath $env:OPENBOT_VERIFY_PATH; \
     '{0}|{1}' -f $s.Status, $s.SignerCertificate.Subject";

/// Windows PowerShell running `script`, with `path` in the environment variable `variable`.
///
/// `PSModulePath` is left for Windows PowerShell to build: a PowerShell 7 parent passes its own
/// down, whose modules Windows PowerShell cannot load (as `provider_oauth` found).
pub fn powershell_with_path(script: &str, variable: &str, path: &Path) -> std::process::Command {
    let mut command = crate::quiet::command("powershell");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env(variable, path)
        .env_remove("PSModulePath");
    command
}

/// The all-users install: Windows' approval prompt, then Docker's installer as an administrator,
/// waited for, its exit code PowerShell's. The installer's path is `INSTALLER_PATH`.
pub fn elevated_install(installer: &Path, arguments: &[String]) -> std::process::Command {
    let quoted: Vec<String> = arguments
        .iter()
        .map(|argument| format!("'{}'", argument.replace('\'', "''")))
        .collect();
    let script = format!(
        "$p = Start-Process -FilePath $env:{INSTALLER_PATH} -ArgumentList {} -Verb RunAs -Wait \
         -PassThru; exit $p.ExitCode",
        quoted.join(",")
    );
    powershell_with_path(&script, INSTALLER_PATH, installer)
}

/// Whether the answer to `AUTHENTICODE_QUERY` is a valid signature by Docker Inc.
pub fn signed_by_docker_on_windows(answer: &str) -> bool {
    let Some((status, subject)) = answer.trim().split_once('|') else {
        return false;
    };
    let parts: Vec<&str> = subject.split(',').map(str::trim).collect();
    status == "Valid" && parts.contains(&"CN=Docker Inc") && parts.contains(&"O=Docker Inc")
}

/// Where Docker Desktop is installed on Windows decides how it is updated: per user, without an
/// administrator, or for all users, with Windows' approval.
pub fn installed_per_user(app: &Path, local_app_data: Option<&Path>) -> bool {
    local_app_data.is_some_and(|local| app.starts_with(local))
}

/// The installer's arguments for an unattended update. `--accept-license` is never one of them.
pub fn install_arguments(os: &str, per_user: bool, user: Option<&str>) -> Vec<String> {
    match os {
        "macos" => user
            .filter(|user| !user.is_empty())
            .map(|user| vec![format!("--user={user}")])
            .unwrap_or_default(),
        _ => {
            let mut arguments = vec!["install".to_string(), "--quiet".to_string()];
            if per_user {
                arguments.push("--user".into());
            }
            arguments
        }
    }
}

/// The update, worked out before anything is downloaded.
#[derive(Clone, Debug)]
pub struct Plan {
    pub release: Release,
    /// Where the installer is downloaded to.
    pub installer: PathBuf,
}

fn this_os_version(os: &str) -> Option<String> {
    let output = match os {
        "macos" => crate::quiet::command("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output(),
        "windows" => crate::quiet::command("cmd").args(["/C", "ver"]).output(),
        _ => return None,
    }
    .ok()
    .filter(|output| output.status.success())?;
    let said = String::from_utf8_lossy(&output.stdout).trim().to_string();
    match os {
        "windows" => windows_build(&said),
        _ => Some(said),
    }
}

/// Which release to install, and whether this computer can run it. Downloads only Docker's feed.
pub fn plan(cache: &Path, os: &str, arch: &str) -> Result<Plan, Problem> {
    let feed = appcast_url(os, arch).ok_or_else(|| {
        Problem::with(
            "Docker on this computer is too old to run OpenBot. Update Docker Desktop, then start \
             OpenBot again.",
            format!("no Docker Desktop update feed for {os} on {arch}"),
        )
    })?;
    let body = crate::deployment::get(&feed).map_err(|error| {
        Problem::with(
            "OpenBot couldn't check for a Docker update. Check the internet connection and try \
             again.",
            format!("{feed}: {error}"),
        )
    })?;
    let release = latest(&String::from_utf8_lossy(&body)).ok_or_else(|| {
        Problem::with(
            "OpenBot couldn't check for a Docker update. Try again.",
            format!("{feed} names no release OpenBot can read"),
        )
    })?;
    let this = this_os_version(os);
    if !os_supports(os, release.minimum_os.as_deref(), this.as_deref()) {
        return Err(Problem::with(
            if os == "macos" {
                "Docker on this Mac is too old to run OpenBot, and the newest Docker needs a newer \
                 macOS. Update macOS, then start OpenBot again."
            } else {
                "Docker on this computer is too old to run OpenBot, and the newest Docker needs a \
                 newer Windows. Update Windows, then start OpenBot again."
            },
            format!(
                "Docker Desktop {} needs {} and this computer has {}",
                release.version,
                release.minimum_os.clone().unwrap_or_default(),
                this.unwrap_or_default()
            ),
        ));
    }
    let installer = crate::acquire::download_dir(cache)
        .join("docker-desktop")
        .join(&release.build)
        .join(release.file());
    Ok(Plan { release, installer })
}

/// Download the installer to `plan.installer` and check it against the build's `checksums.txt`.
///
/// Streamed to disk, not held in memory: the installer is over half a gigabyte. A copy already
/// there with the right digest is kept, so a second try is not a second download.
pub fn download(plan: &Plan, progress: &mut dyn FnMut(StepLine)) -> Result<(), Problem> {
    let checksums_url = plan.release.checksums_url();
    let checksums = crate::deployment::get(&checksums_url).map_err(|error| {
        Problem::with(
            "OpenBot couldn't download the Docker update. Check the internet connection and try \
             again.",
            format!("{checksums_url}: {error}"),
        )
    })?;
    let file = plan.release.file();
    let expected = checksum_for(&String::from_utf8_lossy(&checksums), &file).ok_or_else(|| {
        Problem::with(
            "OpenBot couldn't download the Docker update. Try again.",
            format!("{checksums_url} has no checksum for {file}"),
        )
    })?;
    if digest_of_file(&plan.installer).as_deref() == Some(expected.as_str()) {
        return Ok(());
    }
    if let Some(folder) = plan.installer.parent() {
        std::fs::create_dir_all(folder).map_err(|error| unwritable(folder, &error))?;
    }
    let url = plan.release.download_url();
    let started = Instant::now();
    let mut last_said: Option<u64> = None;
    let mut attempts = 0;
    loop {
        attempts += 1;
        let result = stream_to_file(&url, &plan.installer, &mut |received, total| {
            let minutes = minutes_left(received, total, started.elapsed());
            if minutes != last_said {
                last_said = minutes;
                progress(updating_line(minutes).logged(format!(
                    "Downloading Docker Desktop {} ({received} of {} bytes).",
                    plan.release.version,
                    total.map_or_else(|| "?".into(), |total| total.to_string())
                )));
            }
        });
        match result {
            Ok(()) => break,
            Err(error) if attempts < 3 => {
                log::warn!("[docker update] attempt {attempts} of 3: {error}");
                std::thread::sleep(Duration::from_secs(2 * attempts));
            }
            Err(error) => {
                return Err(Problem::with(
                    "OpenBot couldn't download the Docker update. Check the internet connection \
                     and try again.",
                    format!("{url}: {error} ({attempts} attempts)"),
                ))
            }
        }
    }
    let got = digest_of_file(&plan.installer).unwrap_or_default();
    if got != expected {
        let _ = std::fs::remove_file(&plan.installer);
        return Err(Problem::with(
            "The Docker update OpenBot downloaded is not what Docker published, so it has not \
             been run. Try again.",
            format!("{file} from {url}: expected sha256 {expected}, got {got}"),
        ));
    }
    Ok(())
}

/// Minutes left in the whole update, from how fast the download is going.
pub fn minutes_left(received: u64, total: Option<u64>, elapsed: Duration) -> Option<u64> {
    let total = total?;
    if received == 0 || elapsed.as_secs_f64() < 2.0 {
        return None;
    }
    let rate = received as f64 / elapsed.as_secs_f64();
    let left = (total.saturating_sub(received)) as f64 / rate + INSTALL_ALLOWANCE.as_secs_f64();
    Some((left / 60.0).ceil() as u64)
}

fn unwritable(path: &Path, error: &std::io::Error) -> Problem {
    Problem::with(
        "OpenBot couldn't save the Docker update. Check there is free disk space and try again.",
        format!("{}: {error}", path.display()),
    )
}

fn digest_of_file(path: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).ok()?;
    Some(
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

/// One attempt at downloading `url` into `path`. No limit on the whole download, only on silence,
/// for the reasons `deployment::get` gives.
fn stream_to_file(
    url: &str,
    path: &Path,
    progress: &mut dyn FnMut(u64, Option<u64>),
) -> Result<(), String> {
    use std::io::{Read, Write};
    let mut response = reqwest::blocking::Client::builder()
        .user_agent("openbot-desktop")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?
        .get(url)
        .send()
        .map_err(|error| format!("could not reach {url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("{url} answered {}", response.status()));
    }
    let total = response.content_length();
    let partial = path.with_extension("part");
    let mut file = std::fs::File::create(&partial).map_err(|error| error.to_string())?;
    let mut buffer = vec![0u8; 1 << 20];
    let mut received = 0u64;
    loop {
        let read = response.read(&mut buffer).map_err(|error| {
            format!("the download did not finish after {received} bytes: {error}")
        })?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| error.to_string())?;
        received += read as u64;
        progress(received, total);
    }
    file.flush().map_err(|error| error.to_string())?;
    drop(file);
    if total.is_some_and(|total| total != received) {
        return Err(format!("received {received} of {total:?} bytes"));
    }
    std::fs::rename(&partial, path).map_err(|error| error.to_string())
}

/// Docker's installer, mounted where it can be checked and run. Detached when dropped.
pub struct Mounted {
    pub point: PathBuf,
}

impl Mounted {
    pub fn app(&self) -> PathBuf {
        self.point.join("Docker.app")
    }
}

impl Drop for Mounted {
    fn drop(&mut self) {
        let detached = crate::quiet::command("/usr/bin/hdiutil")
            .args(["detach", "-quiet"])
            .arg(&self.point)
            .status()
            .is_ok_and(|status| status.success());
        if !detached {
            let _ = crate::quiet::command("/usr/bin/hdiutil")
                .args(["detach", "-force", "-quiet"])
                .arg(&self.point)
                .status();
        }
    }
}

/// Mount `Docker.dmg` read-only, without showing it, and check Docker's signature on what is
/// inside: `codesign` must accept the whole app and name Docker's team.
pub fn verify_mac(dmg: &Path) -> Result<Mounted, Problem> {
    let point = dmg.with_file_name("mounted");
    let _ = std::fs::create_dir_all(&point);
    let attached = crate::quiet::command("/usr/bin/hdiutil")
        .args([
            "attach",
            "-nobrowse",
            "-readonly",
            "-noautoopen",
            "-mountpoint",
        ])
        .arg(&point)
        .arg(dmg)
        .output()
        .map_err(|error| not_verified(format!("hdiutil attach: {error}")))?;
    if !attached.status.success() {
        return Err(not_verified(format!(
            "hdiutil attach {}: {}",
            dmg.display(),
            crate::quiet::said(&attached.stderr)
        )));
    }
    let mounted = Mounted { point };
    let app = mounted.app();
    let verify = crate::quiet::command("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(&app)
        .output()
        .map_err(|error| not_verified(format!("codesign --verify: {error}")))?;
    if !verify.status.success() {
        return Err(not_verified(format!(
            "codesign --verify {}: {}",
            app.display(),
            crate::quiet::said(&verify.stderr)
        )));
    }
    let described = crate::quiet::command("/usr/bin/codesign")
        .arg("-dv")
        .arg(&app)
        .output()
        .map_err(|error| not_verified(format!("codesign -dv: {error}")))?;
    let said = String::from_utf8_lossy(&described.stderr);
    if !signed_by_docker_on_mac(&said) {
        return Err(not_verified(format!(
            "{} is not signed by Docker's team {TEAM_ID}: {said}",
            app.display()
        )));
    }
    Ok(mounted)
}

/// The answer to `AUTHENTICODE_QUERY` about the file at `path`, or what PowerShell said instead.
pub fn authenticode(path: &Path) -> Result<String, String> {
    let output = powershell_with_path(AUTHENTICODE_QUERY, VERIFY_PATH, path)
        .output()
        .map_err(|error| format!("Get-AuthenticodeSignature: {error}"))?;
    let answer = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        return Err(format!(
            "Get-AuthenticodeSignature exited with {}: {}{}",
            output.status,
            answer,
            crate::quiet::said(&output.stderr)
        ));
    }
    Ok(answer)
}

/// Check the Windows installer's Authenticode signature: valid, and Docker Inc's.
pub fn verify_windows(installer: &Path) -> Result<(), Problem> {
    let answer = authenticode(installer)
        .map_err(|error| not_verified(format!("{}: {error}", installer.display())))?;
    if !signed_by_docker_on_windows(&answer) {
        return Err(not_verified(format!(
            "{} is not validly signed by Docker Inc: {answer}",
            installer.display()
        )));
    }
    Ok(())
}

fn not_verified(detail: String) -> Problem {
    Problem::with(
        "The Docker update OpenBot downloaded could not be checked, so it has not been run. Try \
         again.",
        detail,
    )
}

/// Whether Docker Desktop's own command line (`docker desktop`, 4.37 and later) is here.
fn has_desktop_cli() -> bool {
    Address::new(Engine::Docker, None)
        .command()
        .args(["desktop", "version"])
        .output()
        .is_ok_and(|output| output.status.success())
}

/// Whether Docker Desktop is still running: Docker answers, or on a Mac its app is still up.
fn docker_desktop_running() -> bool {
    if crate::docker_desktop::answers() {
        return true;
    }
    cfg!(target_os = "macos")
        && crate::quiet::command("/usr/bin/pgrep")
            .args(["-x", "com.docker.backend"])
            .output()
            .is_ok_and(|output| output.status.success())
}

/// Said when Docker Desktop has to be quit by the person.
pub const QUIT_IT: &str =
    "Quit Docker Desktop from its icon in the menu bar. OpenBot updates it once it has closed.";

/// Quit Docker Desktop the way it quits itself, and wait until it has.
///
/// Docker's own command (`docker desktop stop`) where there is one. An older Docker Desktop on a Mac
/// is asked to quit as its menu would (`quit app "Docker"`), which macOS may ask the person to allow.
/// If it is still running after that, the person is asked to quit it, once, and OpenBot carries on
/// when it has. On Windows an older Docker Desktop is left to its installer, which stops it.
fn quit(progress: &mut dyn FnMut(StepLine), cancelled: &dyn Fn() -> bool) -> Result<(), Problem> {
    if !docker_desktop_running() {
        return Ok(());
    }
    progress(
        StepLine::here("Closing Docker so OpenBot can update it.")
            .logged("Quitting Docker Desktop before installing the update."),
    );
    if has_desktop_cli() {
        let _ = Address::new(Engine::Docker, None)
            .command()
            .args(["desktop", "stop", "--timeout", "120"])
            .output();
    } else if cfg!(target_os = "macos") {
        let _ = crate::quiet::command("/usr/bin/osascript")
            .args(["-e", "quit app \"Docker\""])
            .output();
    } else {
        return Ok(());
    }
    if wait_until(Duration::from_secs(120), cancelled, || {
        !docker_desktop_running()
    })? {
        return Ok(());
    }
    progress(StepLine::elsewhere(QUIT_IT).logged("Docker Desktop did not quit when asked."));
    if wait_until(Duration::from_secs(10 * 60), cancelled, || {
        !docker_desktop_running()
    })? {
        return Ok(());
    }
    Err(Problem::with(
        "Docker is still running, so OpenBot couldn't update it. Quit Docker Desktop, then try \
         again.",
        "Docker Desktop was still running 12 minutes after it was asked to quit",
    ))
}

/// Poll `done` every two seconds until it is true (`Ok(true)`), `limit` passes (`Ok(false)`), or
/// Stop or Quit.
fn wait_until(
    limit: Duration,
    cancelled: &dyn Fn() -> bool,
    mut done: impl FnMut() -> bool,
) -> Result<bool, Problem> {
    let until = Instant::now() + limit;
    loop {
        if done() {
            return Ok(true);
        }
        if cancelled() {
            return Err(Problem::with(
                "OpenBot stopped before Docker was updated. Start again when you're ready.",
                "stopped while updating Docker Desktop",
            ));
        }
        if Instant::now() >= until {
            return Ok(false);
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Whether Docker answers now with versions new enough for OpenBot.
fn docker_new_enough() -> bool {
    let address = Address::new(Engine::Docker, None);
    address.responds()
        && engine_versions::decide(
            Engine::Docker,
            &engine_versions::read(&address),
            std::env::consts::OS,
            crate::windows::machine_arch(),
        ) == Verdict::NewEnough
}

/// How running the installer ended.
enum Installed {
    Done,
    /// The person said no to the system's prompt.
    Declined,
    /// It stopped, and the person may be able to finish it in the installer's own window.
    Failed(Problem),
}

/// The password prompt's words, under OpenBot's name.
pub const PASSWORD_PROMPT: &str = "OpenBot needs your password to update Docker.";

#[cfg(target_os = "macos")]
fn run_installer(mounted: &Mounted) -> Installed {
    let install = mounted.app().join("Contents/MacOS/install");
    let user = std::env::var("USER").ok();
    let mut command = crate::install::applescript_shell_arg(&install);
    for argument in install_arguments("macos", false, user.as_deref()) {
        command.push(' ');
        command.push_str(&crate::install::applescript_shell_arg(Path::new(&argument)));
    }
    let script = format!(
        "do shell script \"{command}\" with administrator privileges with prompt {}",
        crate::install::applescript_string(PASSWORD_PROMPT)
    );
    match crate::install::run_administrator_script(&script) {
        crate::install::Prompted::Installed => Installed::Done,
        crate::install::Prompted::Declined => Installed::Declined,
        crate::install::Prompted::Failed(problem) => Installed::Failed(problem),
    }
}

#[cfg(target_os = "windows")]
fn run_installer(installer: &Path, per_user: bool) -> Installed {
    let arguments = install_arguments("windows", per_user, None);
    let output = if per_user {
        crate::quiet::command(installer).args(&arguments).output()
    } else {
        elevated_install(installer, &arguments).output()
    };
    match output {
        Ok(output) if output.status.success() => Installed::Done,
        Ok(output) => {
            let said = crate::quiet::said(&output.stderr);
            if said.contains("canceled by the user") || said.contains("cancelled by the user") {
                return Installed::Declined;
            }
            Installed::Failed(Problem::with(
                "Docker's installer stopped before it finished.",
                format!(
                    "{} {} exited with {}: {said}",
                    installer.display(),
                    arguments.join(" "),
                    output.status
                ),
            ))
        }
        Err(error) => Installed::Failed(Problem::with(
            "Docker's installer stopped before it finished.",
            format!("{}: {error}", installer.display()),
        )),
    }
}

/// Update Docker Desktop to Docker's newest release, and leave it running.
///
/// `back` brings OpenBot's window to the front after the system's prompt or Docker's own window.
pub fn update(
    cache: &Path,
    progress: &mut dyn FnMut(StepLine),
    back: &dyn Fn(),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), Problem> {
    let os = std::env::consts::OS;
    progress(updating_line(None).logged("Checking Docker's newest release."));
    let plan = plan(cache, os, crate::windows::machine_arch())?;
    log::info!(
        "[docker update] installing Docker Desktop {} (build {}) from {}",
        plan.release.version,
        plan.release.build,
        plan.release.download_url()
    );
    download(&plan, progress)?;
    progress(
        updating_line(Some(INSTALL_ALLOWANCE.as_secs() / 60)).logged(format!(
            "Checking Docker's signature on Docker Desktop {}.",
            plan.release.version
        )),
    );
    keeping_containers(
        running_containers,
        || apply(&plan, progress, back, cancelled),
        start_again,
    )?;
    // Over half a gigabyte, and nothing reads it again.
    if let Some(folder) = plan.installer.parent() {
        let _ = std::fs::remove_dir_all(folder);
    }
    Ok(())
}

/**
The update, with the containers running before it running after it.

Quitting Docker Desktop stops every container in it, the person's own included, as Docker's own
updater does: on a Windows tester's computer their `my-web` came back "Exited (255)" after the
update. So the containers running now are recorded before Docker Desktop is quit, and started again
once the new one answers, as a Podman machine's are (`acquire::start_machine_named`). A failed update
starts nothing: Docker may not be running to start them in.
*/
fn keeping_containers(
    running: impl FnOnce() -> Vec<String>,
    update: impl FnOnce() -> Result<(), Problem>,
    start: impl FnOnce(&[String]),
) -> Result<(), Problem> {
    let ids = running();
    log::info!(
        "[docker update] {} container(s) running before the update",
        ids.len()
    );
    update()?;
    if !ids.is_empty() {
        start(&ids);
    }
    Ok(())
}

/// The containers running in Docker now, by id.
fn running_containers() -> Vec<String> {
    Address::new(Engine::Docker, None)
        .command()
        .args(["ps", "--quiet", "--no-trunc"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Start `ids` again in the updated Docker Desktop. One that will not start is the log's: Docker
/// and OpenBot are what setup needs, and the person's container is still there to start.
fn start_again(ids: &[String]) {
    let started = Address::new(Engine::Docker, None)
        .command()
        .arg("start")
        .args(ids)
        .output();
    match started {
        Ok(output) if output.status.success() => log::info!(
            "[docker update] started {} container(s) again after the update",
            ids.len()
        ),
        Ok(output) => log::warn!(
            "[docker update] could not start containers again: {}",
            crate::quiet::said(&output.stderr)
        ),
        Err(error) => log::warn!("[docker update] could not start containers again: {error}"),
    }
}

#[cfg(target_os = "macos")]
fn apply(
    plan: &Plan,
    progress: &mut dyn FnMut(StepLine),
    back: &dyn Fn(),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), Problem> {
    let mounted = verify_mac(&plan.installer)?;
    quit(progress, cancelled)?;
    loop {
        progress(
            StepLine::elsewhere(format!(
                "{UPDATING_WHY} Your Mac will ask for your password."
            ))
            .updating()
            .logged("Installing Docker Desktop; macOS asks for the password."),
        );
        std::thread::sleep(crate::install::BEFORE_PROMPT);
        let installed = run_installer(&mounted);
        back();
        match installed {
            Installed::Done => break,
            Installed::Declined => crate::install::PODMAN_GO_AHEAD_GATE.wait(
                crate::install::ASK_AGAIN_AFTER,
                || progress(declined_line()),
                cancelled,
            )?,
            Installed::Failed(problem) => {
                drop(mounted);
                return finish_by_hand(&plan.installer, problem, progress, back, cancelled);
            }
        }
    }
    drop(mounted);
    started(progress, back)
}

#[cfg(target_os = "windows")]
fn apply(
    plan: &Plan,
    progress: &mut dyn FnMut(StepLine),
    back: &dyn Fn(),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), Problem> {
    verify_windows(&plan.installer)?;
    let per_user = installed_per_user(
        &crate::docker_desktop::installed_app().unwrap_or_default(),
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .as_deref(),
    );
    quit(progress, cancelled)?;
    loop {
        progress(if per_user {
            updating_line(Some(INSTALL_ALLOWANCE.as_secs() / 60))
                .logged("Installing Docker Desktop for this account.")
        } else {
            StepLine::elsewhere(format!(
                "{UPDATING_WHY} Windows will ask for your approval."
            ))
            .updating()
            .logged("Installing Docker Desktop for all users; Windows asks for approval.")
        });
        let installed = run_installer(&plan.installer, per_user);
        back();
        match installed {
            Installed::Done => break,
            Installed::Declined => crate::install::PODMAN_GO_AHEAD_GATE.wait(
                crate::install::ASK_AGAIN_AFTER,
                || progress(declined_line()),
                cancelled,
            )?,
            Installed::Failed(problem) => {
                return finish_by_hand(&plan.installer, problem, progress, back, cancelled)
            }
        }
    }
    started(progress, back)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn apply(
    _plan: &Plan,
    _progress: &mut dyn FnMut(StepLine),
    _back: &dyn Fn(),
    _cancelled: &dyn Fn() -> bool,
) -> Result<(), Problem> {
    Err(Problem::plain(
        "Docker on this computer is too old to run OpenBot. Update Docker, then start OpenBot \
         again.",
    ))
}

#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
fn declined_line() -> StepLine {
    StepLine::asks(
        "OpenBot needs your approval to update Docker. It asks again in a moment, or choose Try \
         again.",
    )
    .logged("The system prompt was closed, so Docker isn't updated yet; asking again.")
}

/// Docker Desktop opened after its update, and answering. Its own window may show updated terms;
/// those are the person's, and `docker_desktop::start` says so and waits.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
fn started(progress: &mut dyn FnMut(StepLine), back: &dyn Fn()) -> Result<(), Problem> {
    crate::docker_desktop::start(progress, back).map(|_| ())
}

/// Said when the unattended update could not finish and the installer is opened for the person.
pub const FINISH_BY_HAND: &str = "Docker couldn't update by itself. Finish the update in Docker's \
                                  window, then open Docker Desktop. OpenBot carries on when Docker \
                                  is ready.";

/// The one plain step: open the verified installer for the person, and carry on by itself once
/// Docker answers with a Compose new enough.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
fn finish_by_hand(
    installer: &Path,
    why: Problem,
    progress: &mut dyn FnMut(StepLine),
    back: &dyn Fn(),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), Problem> {
    log::warn!(
        "[docker update] the unattended install stopped ({}); opening the installer",
        why.detail.as_deref().unwrap_or(&why.said)
    );
    #[cfg(target_os = "macos")]
    let opened = crate::quiet::command("/usr/bin/open")
        .arg(installer)
        .status();
    #[cfg(not(target_os = "macos"))]
    let opened = crate::quiet::command(installer)
        .spawn()
        .map(|_| std::process::ExitStatus::default());
    if !opened.is_ok_and(|status| status.success()) {
        return Err(why);
    }
    progress(StepLine::elsewhere(FINISH_BY_HAND).logged(format!(
        "Opened {} for the person to finish the update.",
        installer.display()
    )));
    let ready = wait_until(Duration::from_secs(30 * 60), cancelled, docker_new_enough)?;
    back();
    if ready {
        Ok(())
    } else {
        Err(Problem::with(
            "Docker wasn't updated. Finish the update in Docker's window, then try again.",
            why.detail.unwrap_or(why.said),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /*
     * Docker's feeds and checksum files as they are, trimmed to their first release. The Mac feed
     * is https://desktop.docker.com/mac/main/arm64/appcast.xml and the Windows one
     * https://desktop.docker.com/win/main/amd64/appcast.xml, read on 2026-11-10.
     */
    const MAC_APPCAST: &str = r#"<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:d4w="http://www.docker.com/docker-for-windows">
  <channel>
    <title>Docker for Mac</title>
    <link>https://desktop.docker.com/mac/main/arm64/229452/Docker.dmg</link>
    <item>
      <title>Version 4.98.0 (245422)</title>
      <sparkle:minimumSystemVersion>14.0.0</sparkle:minimumSystemVersion>
      <pubDate>2026-11-03T10:16:38Z</pubDate>
      <description></description>
      <enclosure url="https://desktop.docker.com/mac/main/arm64/245422/Docker.dmg" sparkle:version="245422" sparkle:shortVersionString="4.98.0" length="572651785" type="application/octet-stream" d4w:url="" previousBuild="244584"></enclosure>
      <sparkle:deltas>
        <enclosure url="https://desktop.docker.com/mac/main/arm64/245422/Docker-244584.delta" sparkle:version="245422" sparkle:shortVersionString="4.98.0" sparkle:deltaFrom="244584" length="63860105" type="application/octet-stream"></enclosure>
      </sparkle:deltas>
    </item>
  </channel>
</rss>"#;

    const WINDOWS_APPCAST: &str = r#"<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:d4w="http://www.docker.com/docker-for-windows">
  <channel>
    <title>Docker for Win</title>
    <link>https://desktop.docker.com/win/main/amd64/228796/DockerDesktop.msi</link>
    <item>
      <title>Version 4.98.0 (245422)</title>
      <sparkle:minimumSystemVersion>[BuildNumber] &gt;= 19045</sparkle:minimumSystemVersion>
      <pubDate>2026-11-03T10:16:34Z</pubDate>
      <description></description>
      <enclosure url="https://desktop.docker.com/win/main/amd64/245422/Docker Desktop Installer.exe" sparkle:version="245422" sparkle:shortVersionString="4.98.0" length="623748528" type="application/octet-stream" d4w:url="" previousBuild="244584"></enclosure>
      <sparkle:deltas>
        <enclosure url="https://desktop.docker.com/win/main/amd64/245422/Docker Desktop Updater-244472.exe" sparkle:version="245422" sparkle:shortVersionString="4.98.0" sparkle:deltaFrom="244472" length="84666288" type="application/octet-stream"></enclosure>
      </sparkle:deltas>
    </item>
  </channel>
</rss>"#;

    /// `checksums.txt` of build 245422 for each, and of 4.27.2 (build 137060) on the Mac, which
    /// Docker wrote with a tab.
    const MAC_CHECKSUMS: &str =
        "9c6f13ce4edda2abf20d801552b6acb96acd3d64b3e91b50c4484353802758b5 *Docker.dmg\n";
    const WINDOWS_CHECKSUMS: &str = "cd6273d9eaa4f07fa7593fc6813d37e1004381cebc3f26047a2554fa5db24388 *Docker Desktop Installer.exe\n";
    const MAC_4_27_2_CHECKSUMS: &str =
        "05df5bafd920f83564766378cf68a974346bba2a5a2beae15015094be1aef8a4\tDocker.dmg\n";

    /// `codesign -dv /Applications/Docker.app` for Docker Desktop 4.76.0, as it prints it (stderr).
    const CODESIGN_DV: &str =
        "Executable=/Applications/Docker.app/Contents/MacOS/com.docker.backend
Identifier=com.docker.docker
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=1596477 flags=0x10000(runtime) hashes=49879+7 location=embedded
Signature size=8969
Timestamp=May 30, 2026 at 04:39:41
Info.plist entries=31
TeamIdentifier=9BNSXJN65R
Runtime Version=14.5.0
Sealed Resources version=2 rules=13 files=92
Internal requirements count=1 size=180
";

    #[test]
    fn reads_the_newest_release_from_dockers_feed() {
        let mac = latest(MAC_APPCAST).unwrap();
        assert_eq!(
            mac,
            Release {
                version: "4.98.0".into(),
                build: "245422".into(),
                url: "https://desktop.docker.com/mac/main/arm64/245422/Docker.dmg".into(),
                minimum_os: Some("14.0.0".into()),
            }
        );
        assert_eq!(mac.file(), "Docker.dmg");
        assert_eq!(
            mac.checksums_url(),
            "https://desktop.docker.com/mac/main/arm64/245422/checksums.txt"
        );

        let windows = latest(WINDOWS_APPCAST).unwrap();
        assert_eq!(windows.version, "4.98.0");
        assert_eq!(windows.file(), "Docker Desktop Installer.exe");
        assert_eq!(
            windows.download_url(),
            "https://desktop.docker.com/win/main/amd64/245422/Docker%20Desktop%20Installer.exe"
        );
        assert_eq!(
            windows.minimum_os.as_deref(),
            Some("[BuildNumber] >= 19045")
        );

        // A feed that points anywhere but Docker's server is not followed.
        assert_eq!(
            latest(&MAC_APPCAST.replace("desktop.docker.com/mac", "example.com/mac")),
            None
        );
        assert_eq!(latest("<rss></rss>"), None);
    }

    #[test]
    fn finds_the_installers_checksum_in_either_of_dockers_formats() {
        assert_eq!(
            checksum_for(MAC_CHECKSUMS, "Docker.dmg").as_deref(),
            Some("9c6f13ce4edda2abf20d801552b6acb96acd3d64b3e91b50c4484353802758b5")
        );
        assert_eq!(
            checksum_for(WINDOWS_CHECKSUMS, "Docker Desktop Installer.exe").as_deref(),
            Some("cd6273d9eaa4f07fa7593fc6813d37e1004381cebc3f26047a2554fa5db24388")
        );
        assert_eq!(
            checksum_for(MAC_4_27_2_CHECKSUMS, "Docker.dmg").as_deref(),
            Some("05df5bafd920f83564766378cf68a974346bba2a5a2beae15015094be1aef8a4")
        );
        assert_eq!(
            checksum_for(MAC_CHECKSUMS, "Docker Desktop Installer.exe"),
            None
        );
    }

    #[test]
    fn checks_the_computer_against_what_the_release_needs() {
        assert!(os_supports("macos", Some("14.0.0"), Some("26.6.2")));
        assert!(os_supports("macos", Some("14.0.0"), Some("14.0")));
        assert!(!os_supports("macos", Some("14.0.0"), Some("13.7.8")));
        assert!(os_supports(
            "windows",
            Some("[BuildNumber] >= 19045"),
            Some("26100")
        ));
        assert!(!os_supports(
            "windows",
            Some("[BuildNumber] >= 19045"),
            Some("19044")
        ));
        // Unknown is not unsupported: Docker's installer says so itself.
        assert!(os_supports("macos", None, Some("13.0")));
        assert_eq!(
            windows_build("\r\nMicrosoft Windows [Version 10.0.26100.4652]\r\n").as_deref(),
            Some("26100")
        );
    }

    #[test]
    fn only_dockers_own_signature_is_accepted() {
        assert!(signed_by_docker_on_mac(CODESIGN_DV));
        assert!(!signed_by_docker_on_mac(
            &CODESIGN_DV.replace("9BNSXJN65R", "ABCDE12345")
        ));
        assert!(!signed_by_docker_on_mac("code object is not signed at all"));

        // The installer's signer, as Authenticode reports it: the certificate DigiCert issued to
        // Docker Inc that signs Docker Desktop Installer.exe 4.98.0.
        let docker = "Valid|CN=Docker Inc, O=Docker Inc, L=Palo Alto, S=California, C=US, \
                      SERIALNUMBER=4817464, OID.2.5.4.15=Private Organization, \
                      OID.1.3.6.1.4.1.311.60.2.1.2=Delaware, OID.1.3.6.1.4.1.311.60.2.1.3=US";
        assert!(signed_by_docker_on_windows(docker));
        assert!(!signed_by_docker_on_windows(
            &docker.replace("Valid|", "HashMismatch|")
        ));
        assert!(!signed_by_docker_on_windows(
            "Valid|CN=Docker Incorporated Lookalike, O=Someone Else"
        ));
        assert!(!signed_by_docker_on_windows("NotSigned|"));
    }

    #[test]
    fn never_accepts_dockers_terms_for_the_person() {
        for arguments in [
            install_arguments("macos", false, Some("sam")),
            install_arguments("windows", true, None),
            install_arguments("windows", false, None),
        ] {
            assert!(!arguments
                .iter()
                .any(|argument| argument.contains("accept-license")));
        }
        assert_eq!(
            install_arguments("macos", false, Some("sam")),
            ["--user=sam"]
        );
        assert_eq!(
            install_arguments("windows", true, None),
            ["install", "--quiet", "--user"]
        );
        assert_eq!(
            install_arguments("windows", false, None),
            ["install", "--quiet"]
        );
    }

    #[test]
    fn keeps_the_installation_mode_docker_desktop_has() {
        let local = Path::new("C:\\Users\\sam\\AppData\\Local");
        assert!(installed_per_user(
            &local.join("Programs\\DockerDesktop\\Docker Desktop.exe"),
            Some(local)
        ));
        assert!(!installed_per_user(
            Path::new("C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"),
            Some(local)
        ));
    }

    #[test]
    fn says_how_long_is_left_in_plain_words() {
        // Half of 570 MB in a minute: another minute to download, and the install's allowance.
        assert_eq!(
            minutes_left(285_000_000, Some(570_000_000), Duration::from_secs(60)),
            Some(5)
        );
        assert_eq!(
            minutes_left(0, Some(570_000_000), Duration::from_secs(60)),
            None
        );
        assert_eq!(minutes_left(10, None, Duration::from_secs(60)), None);
        assert_eq!(
            updating_line(Some(5)).said,
            "The Docker Desktop on this computer is too old for OpenBot, so OpenBot is updating \
             it. About 5 minutes left."
        );
        assert_eq!(
            updating_line(Some(1)).said,
            "The Docker Desktop on this computer is too old for OpenBot, so OpenBot is updating \
             it. About a minute left."
        );
    }

    #[test]
    fn reads_dockers_feed_for_each_kind_of_computer() {
        assert_eq!(
            appcast_url("macos", "aarch64").as_deref(),
            Some("https://desktop.docker.com/mac/main/arm64/appcast.xml")
        );
        assert_eq!(
            appcast_url("windows", "x86_64").as_deref(),
            Some("https://desktop.docker.com/win/main/amd64/appcast.xml")
        );
        assert_eq!(appcast_url("linux", "x86_64"), None);
    }

    /// The path is in the environment, not after `-Command`, for the check and for the install.
    #[test]
    fn a_path_reaches_powershell_in_the_environment_not_after_the_command() {
        let installer = Path::new(
            r"C:\Users\Administrator\OpenBot\openbot-engine\docker-desktop\245422\Docker Desktop Installer.exe",
        );
        let shape = |command: &std::process::Command, variable: &str| {
            let args: Vec<String> = command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            assert_eq!(args.len(), 4, "{args:?}");
            assert_eq!(&args[..3], ["-NoProfile", "-NonInteractive", "-Command"]);
            assert!(args[3].contains(&format!("$env:{variable}")), "{}", args[3]);
            assert!(!args[3].contains("$args"), "{}", args[3]);
            let envs: Vec<_> = command.get_envs().collect();
            assert!(envs.contains(&(std::ffi::OsStr::new(variable), Some(installer.as_os_str()))));
            assert!(envs.contains(&(std::ffi::OsStr::new("PSModulePath"), None)));
        };
        shape(
            &powershell_with_path(AUTHENTICODE_QUERY, VERIFY_PATH, installer),
            VERIFY_PATH,
        );
        let install = elevated_install(installer, &install_arguments("windows", false, None));
        shape(&install, INSTALLER_PATH);
        let script = install
            .get_args()
            .nth(3)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(
            script.contains("-ArgumentList 'install','--quiet' -Verb RunAs"),
            "{script}"
        );
    }

    /*
     * The real call, on Windows. Docker's installer is downloaded to
     * "...\docker-desktop\245422\Docker Desktop Installer.exe", and on a live Windows run the check
     * stopped every update there: the path passed after `-Command` became part of the command text, a
     * parse error, and the answer was empty. A signed Windows file stands in for the installer, in
     * a folder whose name has spaces and a quote.
     */
    #[test]
    #[cfg(windows)]
    fn the_signature_check_reads_a_path_with_spaces_and_quotes() {
        let folder = std::env::temp_dir().join(format!(
            "openbot sig check {} it's here",
            std::process::id()
        ));
        std::fs::create_dir_all(&folder).unwrap();
        let signed = folder.join("Signed Installer.exe");
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        std::fs::copy(&system, &signed).unwrap();
        let answer = authenticode(&signed);
        let _ = std::fs::remove_dir_all(&folder);
        let answer = answer.unwrap();
        let (status, subject) = answer
            .split_once('|')
            .unwrap_or_else(|| panic!("not <status>|<subject>: {answer}"));
        assert_eq!(status, "Valid", "{answer}");
        assert!(subject.contains("O=Microsoft Corporation"), "{answer}");
        // A Microsoft signature is not Docker's.
        assert!(!signed_by_docker_on_windows(&answer));
    }

    /// The person's containers running before Docker Desktop is updated are started again after
    /// it, and only once the update is done: a Windows tester's came back "Exited (255)".
    #[test]
    fn the_containers_running_before_the_update_are_started_after_it() {
        let ids = || {
            vec![
                "af06cb230bc4188cc297c3f25afaa2b63f61d3010ed9c0412ef7b461f8729937".to_string(),
                "8b48835f981b".to_string(),
            ]
        };
        let order = std::cell::RefCell::new(Vec::new());
        keeping_containers(
            || {
                order.borrow_mut().push("recorded".to_string());
                ids()
            },
            || {
                order.borrow_mut().push("updated".to_string());
                Ok(())
            },
            |started| {
                order
                    .borrow_mut()
                    .push(format!("started {}", started.len()))
            },
        )
        .unwrap();
        assert_eq!(*order.borrow(), ["recorded", "updated", "started 2"]);

        // A failed update starts nothing and is the failure.
        let started = std::cell::Cell::new(false);
        let failed = keeping_containers(
            ids,
            || {
                Err(Problem::with(
                    "Docker's installer stopped before it finished.",
                    "1603",
                ))
            },
            |_| started.set(true),
        );
        assert!(failed.is_err());
        assert!(!started.get());

        // Nothing running, nothing started.
        keeping_containers(Vec::new, || Ok(()), |_| panic!("nothing to start")).unwrap();
    }
}
