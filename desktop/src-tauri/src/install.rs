//! Installing an engine, instead of telling somebody to go and get one.
//!
//! The person this app is for does not have a package manager, has never heard of Podman, and is
//! not going to read a release page. Every sentence that begins "install ..." is a step where an
//! install stops for good, so the engine is fetched and installed here.
//!
//! Two things are fetched, not one, and the second is the one that gets forgotten. Podman ships no
//! Compose implementation: `podman compose` looks for an external provider on PATH and, finding
//! none, answers with seven errors naming `docker-compose`. So a machine with a freshly installed
//! Podman still cannot raise the stack. Compose is a single static binary, which is why it can be
//! placed rather than installed.
//!
//! **Nothing fetched here is run unverified.** These files are executed, so each is pinned to the
//! digest of the release this was tested against, and a mismatch is refused rather than run.
//! Fetching a checksum from the same server that served the file would prove nothing.
//!
//! The three platforms install differently and only one of them is unattended:
//!
//! - **Windows.** The MSI is a per-user install, so it needs no elevation and lands in the profile
//!   of whoever runs it. That is also the trap: run from a service or an elevated helper it lands
//!   in `C:\Windows\system32\config\systemprofile`, where the person's own session cannot see it.
//!   Measured, on Windows Server 2022, by installing it from a service and then watching the app
//!   report no engine while `podman.exe` sat on disk. It has to run as them, which is where the app
//!   already runs.
//! - **macOS.** The package writes to `/opt/podman` and needs administrator rights, so the person
//!   sees one standard macOS authorization prompt. There is no way around that prompt and no reason
//!   to want one: it is the same dialog every other installer raises.
//! - **Linux.** Podman there is not a binary but a set of them (`conmon`, `crun`, `netavark`,
//!   `slirp4netns`), wired to the distribution's own paths, so downloading one file would produce
//!   something that runs nothing. The distribution's package manager installs it, through
//!   `pkexec`, which raises that desktop's own authorization prompt.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::engine::{self, Engine};
use crate::problem::Problem;

/// The releases this was tested against.
///
/// Pinned for the reason the deployment pins image digests: a version is what somebody hopes is
/// there, a digest is what was run. Moving these means re-recording the digests below.
pub const PODMAN: &str = "6.1.1";
pub const COMPOSE: &str = "5.5.1";
/// Keep aligned with the repository's packageManager and container runtime.
pub const BUN: &str = "1.3.14";

/// A file to fetch and the digest it has to have.
#[derive(Debug, PartialEq, Eq)]
pub struct Download {
    pub url: String,
    pub sha256: &'static str,
    /// What to call it on disk. Named rather than taken from the URL so a redirect cannot choose
    /// the filename.
    pub file: &'static str,
}

/// The Podman installer for this machine, or why there is not one.
///
/// The Intel Mac case is real and not hypothetical: Podman 6.1.1 publishes `arm64` only. Answering
/// with the arm64 package there would install something that cannot run, so it says so instead.
pub fn podman_download() -> Result<Download, Problem> {
    let (file, sha256) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => (
            "podman-installer-windows-amd64.msi",
            "91d0e8ea0846c0151d531c88c329bb2729387231e4d1e42306a8e3ae9d09fc8a",
        ),
        ("windows", "aarch64") => (
            "podman-installer-windows-arm64.msi",
            "8ededac563c3b96abe55560f3379962ff59fd8bda1a185ed221891cb6ccf5cba",
        ),
        ("macos", "aarch64") => (
            "podman-installer-macos-arm64.pkg",
            "9c7b90b406681e5458d69cdb1164a589f7c9b214cab1ca6705fe375876491c09",
        ),
        ("macos", _) => {
            return Err(Problem::with(
                "OpenBot cannot install the container engine on an Intel Mac. Install Podman \
                 Desktop or Docker Desktop, then start OpenBot again.",
                format!("Podman {PODMAN} publishes an arm64 package only"),
            ))
        }
        ("linux", _) => {
            return Err(Problem::plain(
                "On Linux the engine comes from the distribution's own packages.",
            ))
        }
        (os, arch) => {
            return Err(Problem::with(
                "OpenBot cannot install the container engine on this kind of computer.",
                format!("no Podman installer for {os} on {arch}"),
            ))
        }
    };
    Ok(Download {
        url: format!(
            "https://github.com/podman-container-tools/podman/releases/download/v{PODMAN}/{file}"
        ),
        sha256,
        file,
    })
}

/// The Compose provider for this machine.
///
/// One static binary on every platform, which is the whole reason this can be placed beside the
/// engine rather than installed into the system.
pub fn compose_download() -> Result<Download, Problem> {
    let (file, sha256) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => (
            "docker-compose-windows-x86_64.exe",
            "a3c0c73033eaede90210345d0cc2233edf4fab8fe0282a91dad8fd8436809d2f",
        ),
        ("windows", "aarch64") => (
            "docker-compose-windows-aarch64.exe",
            "4bbb5d1ecc75bde1a9ca4afac43f5907c0d3bd0f88c7f00bf481ee7c8c1737be",
        ),
        ("macos", "x86_64") => (
            "docker-compose-darwin-x86_64",
            "a264d61e824bf08a78867e59cdf32eb09f0aee9ecdf9f6ebfa43f76dc52880f1",
        ),
        ("macos", "aarch64") => (
            "docker-compose-darwin-aarch64",
            "998735c9b6fe68a4f05895e6ea73d71ad06f9fc7046383ad89e47346781b6af5",
        ),
        ("linux", "x86_64") => (
            "docker-compose-linux-x86_64",
            "db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576",
        ),
        ("linux", "aarch64") => (
            "docker-compose-linux-aarch64",
            "732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7",
        ),
        (os, arch) => {
            return Err(Problem::with(
                "OpenBot cannot install the piece that runs the containers on this kind of \
                 computer.",
                format!("no Compose build for {os} on {arch}"),
            ))
        }
    };
    Ok(Download {
        url: format!("https://github.com/docker/compose/releases/download/v{COMPOSE}/{file}"),
        sha256,
        file,
    })
}

/// Fetch to `into`, refusing anything whose digest is not the pinned one.
///
/// A file already there with the right digest is kept, so a retry after a failed install is not a
/// second download. A file already there with the wrong one is replaced: that is a half-written
/// download far more often than it is an attack, and either way it must not be run.
fn fetch_verified(download: &Download, into: &Path) -> Result<PathBuf, Problem> {
    let path = into.join(download.file);
    if let Ok(existing) = std::fs::read(&path) {
        if digest_of(&existing) == download.sha256 {
            return Ok(path);
        }
    }

    let body = crate::deployment::get(&download.url).map_err(|error| {
        Problem::with(
            "OpenBot could not download the software it needs to run. Check the internet \
             connection and try again.",
            format!("{}: {error}", download.url),
        )
    })?;

    let got = digest_of(&body);
    if got != download.sha256 {
        return Err(Problem::with(
            "What OpenBot downloaded is not what it was expecting, so it has not been run. Try \
             again.",
            format!(
                "{} from {}: expected sha256 {}, got {got}",
                download.file, download.url, download.sha256
            ),
        ));
    }

    std::fs::create_dir_all(into).map_err(|error| unwritable(into, &error.to_string()))?;
    std::fs::write(&path, &body).map_err(|error| unwritable(&path, &error.to_string()))?;
    Ok(path)
}

/// One sentence for every "could not write here", because the person's fix is the same each time.
fn unwritable(path: &Path, error: &str) -> Problem {
    Problem::with(
        "OpenBot could not save the software it downloaded. Check there is free disk space and \
         try again.",
        format!("{}: {error}", path.display()),
    )
}

fn digest_of(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A fresh account has no developer tools. Acquire the host runtime as that user,
/// without changing PATH or requiring an administrator. Existing installations remain usable.
pub fn ensure_bun(cache: &Path, existing: Option<PathBuf>) -> Result<PathBuf, Problem> {
    ensure_bun_with(existing, || install_bun(cache))
}

fn ensure_bun_with(
    existing: Option<PathBuf>,
    install: impl FnOnce() -> Result<PathBuf, Problem>,
) -> Result<PathBuf, Problem> {
    match existing {
        Some(path) => Ok(path),
        None => install(),
    }
}

fn bun_download(os: &str, arch: &str) -> Result<Download, Problem> {
    // Official bun-v1.3.14/SHASUMS256.txt. The baseline x64 build also supports older CPUs.
    let (file, sha256) = match (os, arch) {
        ("windows", "x86_64") => (
            "bun-windows-x64-baseline.zip",
            "538f9c846355d9e847b2671bc00c47da4229a0befb24df3282b739770f3b475f",
        ),
        ("windows", "aarch64") => (
            "bun-windows-aarch64.zip",
            "89841f5a57f2348b67ec0839b718f4bf4ea7d07c371c9ba4b77b6c790f918953",
        ),
        ("macos", "x86_64") => (
            "bun-darwin-x64-baseline.zip",
            "3e35ad6f53971a9834bf9e6786e2adf72b5f1921cc9a9c5fde073d2972944076",
        ),
        ("macos", "aarch64") => (
            "bun-darwin-aarch64.zip",
            "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620",
        ),
        ("linux", "x86_64") => (
            "bun-linux-x64-baseline.zip",
            "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7",
        ),
        ("linux", "aarch64") => (
            "bun-linux-aarch64.zip",
            "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b",
        ),
        _ => {
            return Err(Problem::with(
                "OpenBot cannot install its app runtime on this kind of computer.",
                format!("no Bun {BUN} build for {os} on {arch}"),
            ))
        }
    };
    Ok(Download {
        url: format!("https://github.com/oven-sh/bun/releases/download/bun-v{BUN}/{file}"),
        sha256,
        file,
    })
}

fn install_bun(cache: &Path) -> Result<PathBuf, Problem> {
    let download = bun_download(std::env::consts::OS, std::env::consts::ARCH)?;
    let entry = format!(
        "{}/bun{}",
        download.file.trim_end_matches(".zip"),
        std::env::consts::EXE_SUFFIX,
    );
    let into = crate::acquire::download_dir(cache).join(format!("bun-{BUN}"));
    install_bun_with(
        &into,
        &download,
        |archive, target| extract_bun(archive, target, &entry),
        verify_bun,
    )
}

fn install_bun_with(
    into: &Path,
    download: &Download,
    extract: impl FnOnce(&Path, &Path) -> Result<(), Problem>,
    verify: impl Fn(&Path) -> Result<(), Problem>,
) -> Result<PathBuf, Problem> {
    let binary = into.join(format!("bun{}", std::env::consts::EXE_SUFFIX));
    if binary.is_file() {
        verify(&binary)?;
        return Ok(binary);
    }
    let archive = fetch_verified(download, into)?;
    let staged = into.join(format!("bun.download{}", std::env::consts::EXE_SUFFIX));
    let result = extract(&archive, &staged)
        .and_then(|()| verify(&staged))
        .and_then(|()| {
            std::fs::rename(&staged, &binary)
                .map_err(|error| unwritable(&binary, &error.to_string()))
        });
    if let Err(mut problem) = result {
        if let Err(error) = std::fs::remove_file(&staged) {
            if error.kind() != std::io::ErrorKind::NotFound {
                problem.detail = Some(format!(
                    "{}; could not remove incomplete runtime {}: {error}",
                    problem.detail.as_deref().unwrap_or(&problem.said),
                    staged.display(),
                ));
            }
        }
        return Err(problem);
    }
    Ok(binary)
}

fn extract_bun(archive: &Path, target: &Path, entry: &str) -> Result<(), Problem> {
    let unpack_error = |error: &dyn std::fmt::Display| {
        Problem::with(
            "OpenBot could not unpack its app runtime. Try again.",
            format!("{} entry {entry}: {error}", archive.display()),
        )
    };

    // Only the named executable is copied to our chosen staging path. Archive paths never
    // choose output locations, and installation needs no external archive utility or shell.
    let file = std::fs::File::open(archive).map_err(|error| unpack_error(&error))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| unpack_error(&error))?;
    let mut executable = zip.by_name(entry).map_err(|error| unpack_error(&error))?;
    let mut file =
        std::fs::File::create(target).map_err(|error| unwritable(target, &error.to_string()))?;
    std::io::copy(&mut executable, &mut file).map_err(|error| unpack_error(&error))?;
    drop(file);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| unwritable(target, &error.to_string()))?;
    }
    Ok(())
}

fn verify_bun(binary: &Path) -> Result<(), Problem> {
    let output = crate::quiet::command(binary)
        .arg("--version")
        .output()
        .map_err(|error| {
            Problem::with(
                "OpenBot could not start its app runtime.",
                format!("{}: {error}", binary.display()),
            )
        })?;
    if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != BUN {
        return Err(Problem::with(
            "OpenBot could not verify its app runtime.",
            format!(
                "{} --version: {}; expected {BUN}; stdout: {}; stderr: {}",
                binary.display(),
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ),
        ));
    }
    Ok(())
}

/// Put the engine on this machine, and a Compose it can run.
///
/// Both halves, in that order, because the second is invisible until the first has succeeded and
/// somebody presses Start. Answers with the sentence for the step row, or a failure in both
/// registers.
pub fn install_engine(cache: &Path) -> Result<String, Problem> {
    install_engine_observed(cache, |_| {})
}

/// Observe an actual Podman installer invocation, excluding existing engines and Compose repair.
pub fn install_engine_observed(
    cache: &Path,
    installed: impl FnMut(bool),
) -> Result<String, Problem> {
    install_engine_with(cache, installed, install_podman, place_compose)
}

fn install_engine_with(
    cache: &Path,
    mut installed: impl FnMut(bool),
    install_podman: impl FnOnce(&Path) -> Result<(), Problem>,
    place_compose: impl FnOnce(&Path) -> Result<String, Problem>,
) -> Result<String, Problem> {
    let into = crate::acquire::download_dir(cache);

    // engine_ready can start an installed Podman machine, but cannot start Docker. A stopped
    // Docker CLI must not skip installing the Podman that preparation will then try to run.
    if engine::program(Engine::Podman).is_some()
        || engine::Address::new(Engine::Docker, None).responds()
    {
        return place_compose(&into);
    }

    let result = install_podman(&into);
    installed(result.is_ok());
    result?;

    // Installed is not found. The MSI extends the *user's* PATH and this process was started with
    // the old one, so the engine is looked for where the installer puts it rather than on PATH. If
    // that lookup fails the install genuinely did nothing, and saying so beats a later screen
    // reporting no engine on a machine that has just installed one.
    if engine::program(Engine::Podman).is_none() {
        return Err(Problem::with(
            "OpenBot installed the container engine, but cannot find it afterwards. Install \
             Podman Desktop and start OpenBot again.",
            format!(
                "the {PODMAN} installer reported success; podman is on neither PATH nor any \
                 install location this platform uses"
            ),
        ));
    }

    place_compose(&into)?;
    Ok(format!("Podman {PODMAN} and Compose {COMPOSE} installed."))
}

/// Place the Compose provider where the engine will find it, unless something already provides one.
///
/// Nothing is placed when Compose already answers. Docker Desktop ships a provider, and a Linux
/// machine may have `docker-compose-v2` from its own packages; putting a second one in front of
/// either is a version somebody did not choose.
fn place_compose(into: &Path) -> Result<String, Problem> {
    if crate::acquire::address().composes() {
        return Ok("Compose is already here.".into());
    }

    let download = compose_download()?;
    let staged = fetch_verified(&download, into)?;

    let bin = engine::tools_dir_under(into);
    std::fs::create_dir_all(&bin).map_err(|error| unwritable(&bin, &error.to_string()))?;

    // The name matters: Podman looks up a provider called `docker-compose`, so a binary called
    // whatever the release asset was called is a provider nothing finds.
    let named = bin.join(compose_provider_name());
    std::fs::copy(&staged, &named).map_err(|error| unwritable(&named, &error.to_string()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&named, std::fs::Permissions::from_mode(0o755)).map_err(
            |error| {
                Problem::with(
                    "OpenBot could not finish installing the piece that runs the containers.",
                    format!("chmod 755 {}: {error}", named.display()),
                )
            },
        )?;
    }

    Ok(format!("Compose {COMPOSE} installed."))
}

/// The filename Podman looks a provider up by.
pub fn compose_provider_name() -> &'static str {
    if cfg!(windows) {
        "docker-compose.exe"
    } else {
        "docker-compose"
    }
}

#[cfg(target_os = "windows")]
fn install_podman(into: &Path) -> Result<(), Problem> {
    let download = podman_download()?;
    let msi = fetch_verified(&download, into)?;
    let log = into.join("podman-install.log");
    install_podman_msi(&msi, &log, msiexec)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn install_podman_msi(
    msi: &Path,
    log: &Path,
    mut run: impl FnMut(&[&str], &Path, &Path) -> Result<(), MsiexecFailure>,
) -> Result<(), Problem> {
    match run(&["/i"], msi, log) {
        Ok(()) => return Ok(()),
        // 1603 is "fatal error during installation", which is what Windows says when a product it
        // still believes is installed cannot be repaired. Measured on a machine where a previous
        // Podman had been removed by deleting its folder: the registration survived, so `/i`
        // became a reconfigure, and the reconfigure had no source to read from. Somebody who once
        // uninstalled Podman by dragging it to the bin arrives here.
        Err(MsiexecFailure::Exit(1603)) => {}
        Err(error) => return Err(installer_stopped("/i", msi, error, log)),
    }

    // Remove the registration, then install cleanly. `/x` does not need the original source, so
    // it succeeds where the repair could not. If cleanup itself fails, retrying `/i` only hides the
    // step that left the broken registration behind.
    run(&["/x"], msi, log).map_err(|error| installer_stopped("/x", msi, error, log))?;
    run(&["/i"], msi, log).map_err(|error| installer_stopped("/i", msi, error, log))
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
enum MsiexecFailure {
    Exit(i32),
    Start(String),
}

/// Run msiexec quietly and answer with its exit code when it is not success.
///
/// `/qn` and not `/passive`: a progress bar somebody cannot cancel is worse than the app's own
/// step, which says what is happening and can be retried. The log is kept because msiexec's exit
/// code alone does not say which action failed, and it is what turned 1603 into a diagnosis.
#[cfg(target_os = "windows")]
fn msiexec(verb: &[&str], msi: &Path, log: &Path) -> Result<(), MsiexecFailure> {
    let output = crate::quiet::command("msiexec")
        .args(verb)
        .arg(msi)
        .args(["/qn", "/norestart", "/l*v"])
        .arg(log)
        .output()
        .map_err(|error| MsiexecFailure::Start(error.to_string()))?;
    if output.status.success() {
        return Ok(());
    }
    Err(MsiexecFailure::Exit(output.status.code().unwrap_or(-1)))
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn installer_stopped(verb: &str, msi: &Path, failure: MsiexecFailure, log: &Path) -> Problem {
    match failure {
        MsiexecFailure::Start(error) => Problem::with(
            "OpenBot could not start the installer for the software it needs. Try again.",
            format!(
                "msiexec {verb} {} could not start: {error}; intended log path is {}",
                msi.display(),
                log.display()
            ),
        ),
        MsiexecFailure::Exit(code) => Problem::with(
            if code == 1625 {
                // ERROR_INSTALL_PACKAGE_REJECTED requires an administrator to resolve policy.
                // https://learn.microsoft.com/en-us/windows/win32/msi/error-codes
                "Windows policy blocks installing Podman, the container engine OpenBot needs. \
                 Ask an administrator to allow the installation or install Podman for your \
                 account, then try again."
            } else {
                "Installing the software OpenBot needs did not finish. Try again."
            },
            format!(
                "msiexec {verb} {} stopped with exit code {code}; its log is at {}",
                msi.display(),
                log.display()
            ),
        ),
    }
}

#[cfg(target_os = "macos")]
fn install_podman(into: &Path) -> Result<(), Problem> {
    let download = podman_download()?;
    let pkg = fetch_verified(&download, into)?;

    // The package writes to `/opt/podman`, which needs administrator rights. `do shell script ...
    // with administrator privileges` is how macOS asks for them: the person sees the standard
    // authorization dialog, and no password passes through this process.
    let script = format!(
        "do shell script \"/usr/sbin/installer -pkg {} -target /\" with administrator privileges",
        applescript_shell_arg(&pkg)
    );
    let output = crate::quiet::command("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|error| {
            Problem::with(
                "OpenBot could not start the installer for the software it needs.",
                format!("osascript: {error}"),
            )
        })?;

    if output.status.success() {
        return Ok(());
    }
    let said = crate::quiet::said(&output.stderr);
    // -128 is AppleScript's "user cancelled", which is a decision rather than a failure.
    if said.contains("-128") {
        return Err(Problem::plain(
            "The install was cancelled, so OpenBot does not have the software it needs yet. Press \
             Start to try again.",
        ));
    }
    Err(Problem::with(
        "Installing the software OpenBot needs did not finish. Try again.",
        said,
    ))
}

/// A path that has to survive being a shell word inside an AppleScript string.
///
/// Two layers, applied in this order: single-quote it for the shell, then escape what AppleScript
/// treats as special in the double-quoted string that carries it.
#[cfg(target_os = "macos")]
fn applescript_shell_arg(path: &Path) -> String {
    let quoted = format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    quoted.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "linux")]
fn install_podman(_into: &Path) -> Result<(), Problem> {
    let (manager, args) = linux_package_manager().ok_or_else(|| {
        Problem::with(
            "OpenBot cannot install the software it needs on this system. Install the `podman` \
             package, then start OpenBot again.",
            "no apt-get, dnf, zypper or pacman in /usr/bin",
        )
    })?;

    // `pkexec` rather than `sudo`: sudo on a desktop with no terminal has nowhere to ask for a
    // password, and pkexec raises the desktop's own authorization dialog.
    let output = crate::quiet::command("pkexec")
        .arg(manager)
        .args(args)
        .arg("podman")
        .output()
        .map_err(|error| {
            Problem::with(
                "OpenBot could not start the installer for the software it needs.",
                format!("pkexec {manager}: {error}"),
            )
        })?;

    if output.status.success() {
        return Ok(());
    }
    // pkexec's own refusal. 126 is "not authorized", 127 is "dialog dismissed", and neither is a
    // package manager that failed.
    if matches!(output.status.code(), Some(126) | Some(127)) {
        return Err(Problem::plain(
            "The install was not allowed, so OpenBot does not have the software it needs yet. \
             Press Start to try again.",
        ));
    }
    Err(Problem::with(
        "Installing the software OpenBot needs did not finish. Try again.",
        crate::quiet::said(&output.stderr),
    ))
}

/// The package manager this distribution uses, and the words for "install without asking".
#[cfg(target_os = "linux")]
fn linux_package_manager() -> Option<(&'static str, &'static [&'static str])> {
    for (binary, args) in [
        ("apt-get", &["install", "-y"] as &[&str]),
        ("dnf", &["install", "-y"]),
        ("zypper", &["--non-interactive", "install"]),
        ("pacman", &["-S", "--noconfirm"]),
    ] {
        if Path::new("/usr/bin").join(binary).exists() {
            return Some((binary, args));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    #[test]
    #[cfg(windows)]
    fn a_stopped_docker_does_not_skip_the_podman_needed_for_setup() {
        if crate::test_support::isolated_process(
            "install::tests::a_stopped_docker_does_not_skip_the_podman_needed_for_setup",
        ) {
            return;
        }
        let root = temp_root("stopped-docker-install");
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let source = root.join("engine.rs");
        std::fs::write(
            &source,
            r#"fn main() {
                if std::env::var_os("OPENBOT_TEST_DOCKER_RUNNING").is_none() {
                    std::process::exit(1);
                }
                println!("1.44");
            }"#,
        )
        .unwrap();
        crate::test_support::compile_fixture(&source, &bin.join("docker.exe"));
        std::env::set_var("PATH", &bin);
        std::env::set_var("LOCALAPPDATA", root.join("Local"));
        std::env::set_var("ProgramFiles", root.join("Program Files"));
        std::env::remove_var("OPENBOT_TEST_DOCKER_RUNNING");

        let found = engine::detect();
        assert_eq!(found.engine, Some(Engine::Docker));
        assert!(!found.responding);
        assert!(engine::program(Engine::Podman).is_none());
        let mut observed = Vec::new();
        let result = install_engine_with(
            &root,
            |success| observed.push(success),
            |_| {
                // Installation supplies the engine that engine_ready will create/start.
                std::fs::copy(bin.join("docker.exe"), bin.join("podman.exe")).unwrap();
                Ok(())
            },
            |_| Ok("Compose placed".into()),
        );
        result.expect("setup should install its missing Podman");
        assert_eq!(observed, [true], "the Podman installer must run");
        assert!(engine::program(Engine::Podman).is_some());

        // A responding Docker still supplies the engine; never install a replacement.
        std::fs::remove_file(bin.join("podman.exe")).unwrap();
        std::env::set_var("OPENBOT_TEST_DOCKER_RUNNING", "1");
        assert!(engine::detect().responding);
        let result = install_engine_with(
            &root,
            |_| panic!("no Podman installation should be observed"),
            |_| panic!("responding Docker must be reused"),
            |_| Ok("Compose placed".into()),
        );
        assert_eq!(result.unwrap(), "Compose placed");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Every platform this app runs on has a Compose build, or the stack cannot be raised there.
    #[test]
    fn this_platform_has_a_compose_build() {
        let download = compose_download().expect("every supported platform has a Compose build");
        assert!(download.url.ends_with(download.file), "{download:?}");
    }

    #[test]
    fn every_pinned_digest_is_a_lowercase_sha256() {
        // The table is written by hand from each release's own checksums, and a digest with a typo
        // in it fails on somebody else's machine at install time rather than here.
        for download in [
            compose_download(),
            podman_download(),
            bun_download("windows", "x86_64"),
            bun_download("windows", "aarch64"),
            bun_download("macos", "x86_64"),
            bun_download("macos", "aarch64"),
            bun_download("linux", "x86_64"),
            bun_download("linux", "aarch64"),
        ]
        .into_iter()
        .flatten()
        {
            assert_eq!(download.sha256.len(), 64, "{download:?}");
            assert!(
                download
                    .sha256
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "{download:?}"
            );
        }
    }

    /// The digest is compared, not merely computed. This is the check that stops a wrong file being
    /// executed, so it is asserted against a published vector rather than trusted.
    #[test]
    fn the_digest_is_a_real_sha256() {
        assert_eq!(
            digest_of(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn a_file_whose_digest_is_wrong_is_never_returned_to_be_run() {
        let dir = temp_root("digest");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("already-here"), b"not the pinned bytes").unwrap();

        let wrong = Download {
            // Unreachable on purpose: reaching it would mean the file on disk was accepted.
            url: "http://127.0.0.1:1/never-reached".into(),
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            file: "already-here",
        };
        let refused = fetch_verified(&wrong, &dir).expect_err("a wrong digest must be refused");
        // Either half is acceptable here; what is not is a sentence that names a digest at the
        // person, or a detail that has thrown the evidence away.
        assert!(!refused.said.contains("sha256"), "{refused:?}");
        assert!(refused.detail.is_some(), "{refused:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A file already present with the pinned digest is not fetched again. The URL does not
    /// resolve, so a fetch would fail rather than quietly succeed.
    #[test]
    fn a_file_already_here_with_the_right_digest_is_kept() {
        let dir = temp_root("kept");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("kept"), b"abc").unwrap();

        let pinned = Download {
            url: "http://127.0.0.1:1/never-reached".into(),
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            file: "kept",
        };
        let path = fetch_verified(&pinned, &dir).expect("the file already here should be kept");
        assert_eq!(path, dir.join("kept"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn cached_bun_archive(name: &str) -> (PathBuf, Download) {
        let dir = temp_root(name);
        std::fs::create_dir_all(&dir).unwrap();
        let download = Download {
            url: "http://127.0.0.1:1/never-reached".into(),
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            file: "bun.zip",
        };
        std::fs::write(dir.join(download.file), b"abc").unwrap();
        (dir, download)
    }

    fn bun_zip_fixture(name: &str) -> (PathBuf, Download) {
        use base64::Engine as _;

        // A deflated ZIP containing bun-fixture/bun, a /bin/sh script printing 1.3.14,
        // and an unrelated traversal entry that must never be extracted. Fixed bytes keep
        // digest verification and real decompression in this offline regression.
        let bytes = base64::engine::general_purpose::STANDARD.decode(
            "UEsDBBQAAAAIAAAAIVwlsF+1HgAAABwAAAAPAAAAYnVuLWZpeHR1cmUvYnVuU1bUT8rM0y/O4CooyswrSVNQN9Qz1jM0iclT5wIAUEsDBBQAAAAIAAAAIVw6VdAHFwAAABUAAAANAAAALi4vdW5leHBlY3RlZMstLS5RyMsvUUhKVUitKClKTC5JTQEAUEsBAhQDFAAAAAgAAAAhXCWwX7UeAAAAHAAAAA8AAAAAAAAAAAAAAIABAAAAAGJ1bi1maXh0dXJlL2J1blBLAQIUAxQAAAAIAAAAIVw6VdAHFwAAABUAAAANAAAAAAAAAAAAAACAAUsAAAAuLi91bmV4cGVjdGVkUEsFBgAAAAACAAIAeAAAAI0AAAAAAA==",
        ).unwrap();
        let root = temp_root(name);
        std::fs::create_dir_all(&root).unwrap();
        let download = Download {
            url: "http://127.0.0.1:1/never-reached".into(),
            sha256: "afeced1e41e23b9a5a7c63fb917f68ee663a3735f02fe717cf859be06b1e29b6",
            file: "bun-fixture.zip",
        };
        std::fs::write(root.join(download.file), bytes).unwrap();
        (root, download)
    }

    #[test]
    fn linux_runtime_downloads_are_pinned_for_both_supported_architectures() {
        for (arch, file, sha256) in [
            (
                "x86_64",
                "bun-linux-x64-baseline.zip",
                "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7",
            ),
            (
                "aarch64",
                "bun-linux-aarch64.zip",
                "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b",
            ),
        ] {
            let download = bun_download("linux", arch).unwrap();
            assert_eq!(download.file, file);
            assert_eq!(download.sha256, sha256);
            assert_eq!(
                download.url,
                format!("https://github.com/oven-sh/bun/releases/download/bun-v{BUN}/{file}")
            );
        }
        assert!(bun_download("linux", "unsupported").is_err());
    }

    #[test]
    fn macos_runtime_downloads_are_pinned_for_both_supported_architectures() {
        for (arch, file) in [
            ("aarch64", "bun-darwin-aarch64.zip"),
            ("x86_64", "bun-darwin-x64-baseline.zip"),
        ] {
            let download = bun_download("macos", arch).unwrap();
            assert_eq!(download.file, file);
            assert_eq!(
                download.url,
                format!("https://github.com/oven-sh/bun/releases/download/bun-v{BUN}/{file}")
            );
        }
        assert!(bun_download("macos", "unsupported").is_err());
    }

    #[test]
    #[cfg(unix)]
    fn bun_installation_works_without_developer_tools() {
        if crate::test_support::isolated_process(
            "install::tests::bun_installation_works_without_developer_tools",
        ) {
            return;
        }
        std::env::set_var("PATH", "/openbot-no-developer-tools");
        let (root, download) = bun_zip_fixture("bun user's fresh account");
        let binary = ensure_bun_with(None, || {
            install_bun_with(
                &root,
                &download,
                |archive, target| extract_bun(archive, target, "bun-fixture/bun"),
                verify_bun,
            )
        })
        .unwrap();
        assert_eq!(binary, root.join("bun"));
        verify_bun(&binary).unwrap();
        assert!(!root.join("bun.download").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bun_extraction_only_writes_the_expected_file() {
        let (root, download) = bun_zip_fixture("bun extraction paths");
        let into = root.join("installed");
        std::fs::create_dir(&into).unwrap();
        let target = into.join(format!("bun{}", std::env::consts::EXE_SUFFIX));
        let archive = fetch_verified(&download, &root).unwrap();
        extract_bun(&archive, &target, "bun-fixture/bun").unwrap();
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"#!/bin/sh\nprintf '1.3.14\\n'\n"
        );
        assert_eq!(std::fs::read_dir(&into).unwrap().count(), 1);
        assert!(!root.join("unexpected").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(target).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_bun_archive_entry_is_not_published_or_run() {
        let (root, download) = bun_zip_fixture("bun missing entry");
        let failure = install_bun_with(
            &root,
            &download,
            |archive, target| extract_bun(archive, target, "missing/bun"),
            |_| panic!("a missing archive entry must not be run"),
        )
        .unwrap_err();
        assert!(failure.detail.unwrap().contains("missing/bun"));
        assert!(!root
            .join(format!("bun{}", std::env::consts::EXE_SUFFIX))
            .exists());
        assert!(!root
            .join(format!("bun.download{}", std::env::consts::EXE_SUFFIX))
            .exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_fresh_account_acquires_bun_before_returning_its_executable() {
        let (dir, download) = cached_bun_archive("bun-fresh-account");
        let binary = ensure_bun_with(None, || {
            install_bun_with(
                &dir,
                &download,
                |archive, target| {
                    assert_eq!(std::fs::read(archive).unwrap(), b"abc");
                    assert!(!dir
                        .join(format!("bun{}", std::env::consts::EXE_SUFFIX))
                        .exists());
                    std::fs::write(target, b"executable").unwrap();
                    Ok(())
                },
                |target| {
                    assert_eq!(std::fs::read(target).unwrap(), b"executable");
                    assert!(
                        !dir.join(format!("bun{}", std::env::consts::EXE_SUFFIX))
                            .exists(),
                        "verify before publishing"
                    );
                    Ok(())
                },
            )
        })
        .unwrap();
        assert_eq!(
            binary,
            dir.join(format!("bun{}", std::env::consts::EXE_SUFFIX))
        );
        assert_eq!(std::fs::read(binary).unwrap(), b"executable");
        assert!(!dir
            .join(format!("bun.download{}", std::env::consts::EXE_SUFFIX))
            .exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_existing_bun_does_not_trigger_installation() {
        let existing = PathBuf::from("existing user runtime/bun.exe");
        assert_eq!(
            ensure_bun_with(Some(existing.clone()), || panic!("already installed")).unwrap(),
            existing
        );
    }

    #[test]
    fn an_acquired_bun_is_checked_and_reused_without_extracting_again() {
        let (dir, download) = cached_bun_archive("bun-reuse");
        let binary = dir.join(format!("bun{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&binary, b"installed").unwrap();
        std::fs::remove_file(dir.join(download.file)).unwrap();
        let result = install_bun_with(
            &dir,
            &download,
            |_, _| panic!("must not replace the installed runtime"),
            |target| {
                assert_eq!(target, binary);
                Ok(())
            },
        );
        assert_eq!(result.unwrap(), binary);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bun_extraction_failure_keeps_the_diagnostic_and_publishes_nothing() {
        let (dir, download) = cached_bun_archive("bun-extraction-failure");
        let failure = Problem::with("could not unpack", "PowerShell exit 1: access denied");
        let result = install_bun_with(
            &dir,
            &download,
            |_, target| {
                std::fs::write(target, b"partially extracted executable").unwrap();
                Err(failure.clone())
            },
            |_| panic!("failed extraction must not be executed"),
        );
        assert_eq!(result, Err(failure));
        assert!(!dir
            .join(format!("bun{}", std::env::consts::EXE_SUFFIX))
            .exists());
        assert!(!dir
            .join(format!("bun.download{}", std::env::consts::EXE_SUFFIX))
            .exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bun_that_cannot_run_is_not_published_and_its_failure_is_preserved() {
        let (dir, download) = cached_bun_archive("bun-probe-failure");
        let failure = Problem::with("could not start", "bun --version exited 1");
        let result = ensure_bun_with(None, || {
            install_bun_with(
                &dir,
                &download,
                |_, target| {
                    std::fs::write(target, b"broken executable").unwrap();
                    Ok(())
                },
                |_| Err(failure.clone()),
            )
        });
        assert_eq!(result, Err(failure));
        assert!(!dir
            .join(format!("bun{}", std::env::consts::EXE_SUFFIX))
            .exists());
        assert!(!dir
            .join(format!("bun.download{}", std::env::consts::EXE_SUFFIX))
            .exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unverified_bun_archive_is_never_extracted_or_run() {
        let (dir, download) = cached_bun_archive("bun-wrong-digest");
        std::fs::write(dir.join(download.file), b"corrupt archive").unwrap();
        let result = install_bun_with(
            &dir,
            &download,
            |_, _| panic!("an unverified archive must not be extracted"),
            |_| panic!("an unverified runtime must not be run"),
        );
        assert!(result.unwrap_err().detail.is_some());
        assert!(!dir
            .join(format!("bun{}", std::env::consts::EXE_SUFFIX))
            .exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Podman publishes an `arm64` package only, so an Intel Mac has to be told rather than handed
    /// a package that cannot run. The message names what to do instead.
    #[test]
    #[cfg(target_os = "macos")]
    fn an_intel_mac_is_told_rather_than_handed_a_package_that_cannot_run() {
        if std::env::consts::ARCH == "x86_64" {
            let refused = podman_download().expect_err("there is no Intel package");
            assert!(refused.said.contains("Podman Desktop"), "{refused:?}");
            assert!(
                refused.detail.is_some_and(|d| d.contains("arm64")),
                "the developer half should name why"
            );
        } else {
            let download = podman_download().expect("Apple silicon has a package");
            assert!(download.file.contains("arm64"), "{download:?}");
        }
    }

    fn synthetic_msi_paths(name: &str) -> (PathBuf, PathBuf) {
        let dir = temp_root(name);
        std::fs::create_dir_all(&dir).unwrap();
        (dir.join("podman.msi"), dir.join("podman-install.log"))
    }

    #[test]
    fn windows_msi_cleanup_failure_stops_before_retry() {
        let (msi, log) = synthetic_msi_paths("msi-cleanup-fails");
        let mut calls = Vec::new();
        let result = install_podman_msi(&msi, &log, |verb, _msi, _log| {
            calls.push(verb[0].to_string());
            match calls.len() {
                1 => Err(MsiexecFailure::Exit(1603)),
                2 => Err(MsiexecFailure::Exit(1619)),
                _ => panic!("cleanup failure must stop before retrying install"),
            }
        });

        let problem = result.expect_err("cleanup failure must be reported");
        assert_eq!(calls, ["/i", "/x"]);
        let detail = problem
            .detail
            .expect("developer detail keeps msiexec evidence");
        assert!(detail.contains("msiexec /x"), "{detail}");
        assert!(detail.contains("exit code 1619"), "{detail}");
        assert!(detail.contains(&log.display().to_string()), "{detail}");
        let _ = std::fs::remove_dir_all(msi.parent().unwrap());
    }

    #[test]
    fn windows_msi_spawn_failure_is_not_reported_as_exit_code_minus_one() {
        let (msi, log) = synthetic_msi_paths("msi-spawn-fails");
        let result = install_podman_msi(&msi, &log, |_verb, _msi, _log| {
            Err(MsiexecFailure::Start("program not found".into()))
        });

        let problem = result.expect_err("spawn failure must be reported");
        assert!(problem.said.contains("could not start"), "{problem:?}");
        let detail = problem
            .detail
            .expect("developer detail keeps spawn evidence");
        assert!(
            detail.contains("could not start: program not found"),
            "{detail}"
        );
        assert!(!detail.contains("exit code -1"), "{detail}");
        let _ = std::fs::remove_dir_all(msi.parent().unwrap());
    }

    #[test]
    fn windows_msi_1603_recovery_removes_registration_then_retries_install() {
        let (msi, log) = synthetic_msi_paths("msi-recovery-succeeds");
        let mut calls = Vec::new();
        install_podman_msi(&msi, &log, |verb, _msi, _log| {
            calls.push(verb[0].to_string());
            match calls.len() {
                1 => Err(MsiexecFailure::Exit(1603)),
                2 | 3 => Ok(()),
                _ => panic!("unexpected extra msiexec call"),
            }
        })
        .expect("cleanup and retry should recover the broken registration");

        assert_eq!(calls, ["/i", "/x", "/i"]);
        let _ = std::fs::remove_dir_all(msi.parent().unwrap());
    }

    #[test]
    fn windows_msi_non_recovery_install_failure_stops_without_cleanup() {
        let (msi, log) = synthetic_msi_paths("msi-install-fails");
        let mut calls = Vec::new();
        let result = install_podman_msi(&msi, &log, |verb, _msi, _log| {
            calls.push(verb[0].to_string());
            Err(MsiexecFailure::Exit(1619))
        });

        let problem = result.expect_err("non-1603 install failure must be reported");
        assert_eq!(calls, ["/i"]);
        let detail = problem
            .detail
            .expect("developer detail keeps exit evidence");
        assert!(detail.contains("msiexec /i"), "{detail}");
        assert!(detail.contains("exit code 1619"), "{detail}");
        let _ = std::fs::remove_dir_all(msi.parent().unwrap());
    }

    #[test]
    fn windows_msi_policy_rejection_needs_administrator_action_before_retry() {
        let (msi, log) = synthetic_msi_paths("msi-policy-rejected");
        let mut calls = Vec::new();
        let result = install_podman_msi(&msi, &log, |verb, _msi, _log| {
            calls.push(verb[0].to_string());
            Err(MsiexecFailure::Exit(1625))
        });

        let problem = result.expect_err("policy rejection must be reported");
        assert_eq!(
            calls,
            ["/i"],
            "policy rejection must not trigger another attempt"
        );
        assert_eq!(
            problem.said,
            "Windows policy blocks installing Podman, the container engine \
            OpenBot needs. Ask an administrator to allow the installation or install Podman for \
            your account, then try again."
        );
        assert_eq!(
            problem.detail,
            Some(format!(
                "msiexec /i {} stopped with exit code 1625; its log is at {}",
                msi.display(),
                log.display(),
            )),
        );
        let _ = std::fs::remove_dir_all(msi.parent().unwrap());
    }

    #[test]
    #[cfg(unix)]
    fn windows_msi_recovery_uses_actual_child_process_boundary() {
        let (msi, log) = synthetic_msi_paths("msi-process-boundary");
        let fake = msi.parent().unwrap().join("fake-msiexec.sh");
        let calls = msi.parent().unwrap().join("calls.txt");
        let script = format!(
            r#"#!/bin/sh
set -eu
echo "$1|$2|$3|$4|$5|$6" >> '{}'
case "$1" in
  /i)
    count=$(grep -c '^/i|' '{}' 2>/dev/null || true)
    if [ "$count" = 1 ]; then echo MSI_EXIT=1603; exit 67; fi
    exit 0
    ;;
  /x) exit 0 ;;
  *) exit 99 ;;
esac
"#,
            calls.display(),
            calls.display()
        );
        std::fs::write(&fake, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        install_podman_msi(&msi, &log, |verb, msi, log| {
            let output = std::process::Command::new(&fake)
                .args(verb)
                .arg(msi)
                .args(["/qn", "/norestart", "/l*v"])
                .arg(log)
                .output()
                .map_err(|error| MsiexecFailure::Start(error.to_string()))?;
            if output.status.success() {
                Ok(())
            } else {
                let stdout = String::from_utf8_lossy(&output.stdout);
                // Unix test processes cannot return Windows Installer's 1603 directly: exit
                // statuses are truncated to 8 bits. The fake executable writes the intended
                // Windows code so this process-boundary proof can still exercise the production
                // recovery branch.
                let code = stdout
                    .trim()
                    .strip_prefix("MSI_EXIT=")
                    .and_then(|value| value.parse::<i32>().ok())
                    .unwrap_or_else(|| output.status.code().unwrap_or(-1));
                Err(MsiexecFailure::Exit(code))
            }
        })
        .expect("the fake executable should exercise the production recovery order");

        let calls = std::fs::read_to_string(&calls).unwrap();
        assert!(
            calls.contains(&format!(
                "/i|{}|/qn|/norestart|/l*v|{}",
                msi.display(),
                log.display()
            )),
            "{calls}"
        );
        assert!(
            calls.contains(&format!(
                "/x|{}|/qn|/norestart|/l*v|{}",
                msi.display(),
                log.display()
            )),
            "{calls}"
        );
        assert_eq!(calls.lines().count(), 3, "{calls}");
        let _ = std::fs::remove_dir_all(msi.parent().unwrap());
    }

    /// Podman looks a provider up by name, so this one is not negotiable.
    #[test]
    fn the_compose_provider_is_named_what_the_engine_looks_for() {
        assert_eq!(
            compose_provider_name(),
            if cfg!(windows) {
                "docker-compose.exe"
            } else {
                "docker-compose"
            }
        );
    }

    /// A path with a space in it is where naive quoting breaks, and the app's own cache directory
    /// on Windows and macOS both have one.
    #[test]
    #[cfg(target_os = "macos")]
    fn a_path_with_a_space_survives_both_layers_of_quoting() {
        let quoted = applescript_shell_arg(Path::new("/Users/a b/Application Support/x.pkg"));
        assert!(quoted.starts_with('\''), "{quoted}");
        assert!(quoted.contains("Application Support"), "{quoted}");
        assert!(!quoted.contains("\\\""), "{quoted}");
    }
}
