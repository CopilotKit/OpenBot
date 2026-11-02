//! Installing an engine, instead of telling somebody to go and get one.
//!
//! **Which engine.** A new installation uses, in this order:
//!
//! 1. a Docker that answers;
//! 2. on macOS and Windows, a stopped Docker Desktop that has run before, which is opened (see
//!    `docker_desktop`);
//! 3. Podman: the one somebody already has, or one installed here.
//!
//! The engine chosen is saved with the installation (`preparation::saved_engine`), and every later
//! install and start uses it and only it.
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
pub const BUN: &str = "1.4.3";

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
        Some(path) if verify_bun(&path).is_ok() => Ok(path),
        _ => install(),
    }
}

fn bun_download(os: &str, arch: &str) -> Result<Download, Problem> {
    // Official bun-v1.4.3/SHASUMS256.txt. The baseline x64 build also supports older CPUs.
    let (file, sha256) = match (os, arch) {
        ("windows", "x86_64") => (
            "bun-windows-x64-baseline.zip",
            "d7a7d3eb216614544aab0cde2d8d9f2e4e87839bf5a30a1cd11d077f02d84e0c",
        ),
        ("windows", "aarch64") => (
            "bun-windows-aarch64.zip",
            "5e8f142ef722cbc9f67dc068a166e46ee72be8307b38cac7186589d2face668f",
        ),
        ("macos", "x86_64") => (
            "bun-darwin-x64-baseline.zip",
            "0fde04e8b092156b97fe6432e899baf16d9ed6ce52cbb4218d2d9c07a2f827ef",
        ),
        ("macos", "aarch64") => (
            "bun-darwin-aarch64.zip",
            "80afd4c069b46a6fa8f3ec520bebc750a7843e4a8d5b9583d29ad436c00a3403",
        ),
        ("linux", "x86_64") => (
            "bun-linux-x64-baseline.zip",
            "1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b",
        ),
        ("linux", "aarch64") => (
            "bun-linux-aarch64.zip",
            "efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21",
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

pub(crate) fn verify_bun(binary: &Path) -> Result<(), Problem> {
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
/// registers. `saved` is the engine the installation was set up on, if it saved one.
pub fn install_engine(cache: &Path, saved: Option<Engine>) -> Result<String, Problem> {
    install_engine_observed(cache, saved, |_, _| {}, &mut |_| {}).map(|chosen| chosen.said)
}

/// The engine the install step settled on, and the sentence for its step row.
#[derive(Debug, PartialEq, Eq)]
pub struct EngineChosen {
    pub engine: Engine,
    pub said: String,
}

/// Observe an actual engine install, excluding engines that were already here, starting Docker
/// Desktop and Compose repair; `progress` is each line for the step row.
pub fn install_engine_observed(
    cache: &Path,
    saved: Option<Engine>,
    installed: impl FnMut(Engine, bool),
    progress: &mut dyn FnMut(String),
) -> Result<EngineChosen, Problem> {
    install_engine_with(
        cache,
        Found::here(saved),
        saved,
        installed,
        || crate::docker_desktop::start(progress),
        install_podman,
        place_compose,
    )
}

/// What engines this machine has, read once so the choice below can be tested on any machine.
///
/// Nothing here asks what product is behind a `docker` command. A Docker that answers is used, a
/// Docker Desktop that is safe to open is opened, and anything else is a machine without Docker.
#[derive(Debug, Clone, Copy)]
struct Found {
    /// Docker Desktop is how this platform gets Docker: macOS and Windows, not Linux.
    docker_desktop_platform: bool,
    docker_answers: bool,
    docker_app_installed: bool,
    /// Docker Desktop has run on this machine before, so it opens without its terms. See
    /// `docker_desktop::used_before`.
    docker_desktop_used_before: bool,
    podman_installed: bool,
}

impl Found {
    fn here(saved: Option<Engine>) -> Self {
        // An installation on Podman never looks at Docker, and so never runs `docker` either.
        let docker = saved != Some(Engine::Podman);
        let docker_app_installed = docker && crate::docker_desktop::installed_app().is_some();
        Self {
            docker_desktop_platform: cfg!(any(target_os = "macos", target_os = "windows")),
            docker_answers: docker && engine::Address::new(Engine::Docker, None).responds(),
            docker_app_installed,
            docker_desktop_used_before: docker_app_installed
                && crate::docker_desktop::used_before(),
            podman_installed: engine::program(Engine::Podman).is_some(),
        }
    }
}

/// What the install step does to have an engine answering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Choice {
    /// Docker answers now.
    UseDocker,
    /// Docker Desktop is installed and stopped, and opening it shows nothing that needs the person.
    OpenDockerDesktop,
    /// This installation is on Docker, Docker does not answer, and there is no Docker Desktop to
    /// open. Only the person can start it.
    DockerNotRunning,
    UsePodman,
    InstallPodman,
}

/*
 * DOCKER WHEN IT IS READY, PODMAN OTHERWISE, AND NEVER A MOVE BETWEEN THEM.
 *
 * A new installation uses a Docker that answers, then a stopped Docker Desktop that has run before,
 * then Podman. A Docker Desktop that has never run is not opened: its first window is Docker's
 * terms, and OpenBot must never put a person in front of them or wait on them. A `docker` command
 * that does not answer is not a reason to stop either. That machine gets Podman too.
 *
 * An installation that saved its engine keeps it. Its images and its database are there, and
 * the other engine would start it empty. A saved Docker Desktop that is stopped is opened: it
 * answered for this installation before.
 *
 * Linux has no Docker Desktop. An answering Docker is used there, and anything else gets Podman.
 */
fn choose(found: Found, saved: Option<Engine>) -> Choice {
    let can_open_docker_desktop = found.docker_desktop_platform && found.docker_app_installed;
    let podman = if found.podman_installed {
        Choice::UsePodman
    } else {
        Choice::InstallPodman
    };
    match saved {
        Some(Engine::Podman) => podman,
        Some(Engine::Docker) if found.docker_answers => Choice::UseDocker,
        Some(Engine::Docker) if can_open_docker_desktop => Choice::OpenDockerDesktop,
        Some(Engine::Docker) => Choice::DockerNotRunning,
        None if found.docker_answers => Choice::UseDocker,
        None if can_open_docker_desktop && found.docker_desktop_used_before => {
            Choice::OpenDockerDesktop
        }
        None => podman,
    }
}

fn install_engine_with(
    cache: &Path,
    found: Found,
    saved: Option<Engine>,
    mut installed: impl FnMut(Engine, bool),
    start_docker: impl FnOnce() -> Result<String, Problem>,
    install_podman: impl FnOnce(&Path) -> Result<(), Problem>,
    place_compose: impl FnOnce(&Path) -> Result<String, Problem>,
) -> Result<EngineChosen, Problem> {
    let into = crate::acquire::download_dir(cache);
    let chosen = |engine, said| EngineChosen { engine, said };

    match choose(found, saved) {
        Choice::UseDocker => return place_compose(&into).map(|said| chosen(Engine::Docker, said)),
        // Nothing is placed: Docker Desktop ships Compose as a CLI plugin, and `docker compose`
        // never looks on PATH, where a placed provider goes. `place_compose` asks Podman, which a
        // Docker-only machine does not have, so it downloaded a provider nothing used. The caller
        // checks Docker's own Compose once Docker answers.
        Choice::OpenDockerDesktop => {
            return start_docker().map(|said| chosen(Engine::Docker, said))
        }
        Choice::DockerNotRunning => {
            return Err(Problem::with(
                "OpenBot was installed with Docker, and Docker isn't running. Start Docker, then \
                 try again.",
                "this installation saved Docker as its engine; docker does not answer and there \
                 is no Docker Desktop to open",
            ))
        }
        Choice::UsePodman => return place_compose(&into).map(|said| chosen(Engine::Podman, said)),
        Choice::InstallPodman => {}
    }

    let result = install_podman(&into);
    installed(Engine::Podman, result.is_ok());
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
    Ok(chosen(
        Engine::Podman,
        format!("Podman {PODMAN} and Compose {COMPOSE} installed."),
    ))
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

    /// A Mac or a PC. `docker_app` is a Docker Desktop that is installed; `used` is one that has
    /// run before.
    fn found(docker_answers: bool, docker_app: bool, used: bool, podman: bool) -> Found {
        Found {
            docker_desktop_platform: true,
            docker_answers,
            docker_app_installed: docker_app,
            docker_desktop_used_before: used,
            podman_installed: podman,
        }
    }

    fn linux(found: Found) -> Found {
        Found {
            docker_desktop_platform: false,
            ..found
        }
    }

    const NOTHING: Found = Found {
        docker_desktop_platform: true,
        docker_answers: false,
        docker_app_installed: false,
        docker_desktop_used_before: false,
        podman_installed: false,
    };

    /// The whole table, for a new installation and for one that saved its engine.
    #[test]
    fn the_engine_is_chosen_by_this_table() {
        use Choice::*;
        let docker = Some(Engine::Docker);
        let podman = Some(Engine::Podman);
        let rows: [(&str, Found, Option<Engine>, Choice); 18] = [
            // A new installation.
            (
                "answering Docker",
                found(true, false, false, false),
                None,
                UseDocker,
            ),
            (
                "answering Docker Desktop beside Podman",
                found(true, true, true, true),
                None,
                UseDocker,
            ),
            (
                "stopped Docker Desktop, used before",
                found(false, true, true, false),
                None,
                OpenDockerDesktop,
            ),
            (
                "stopped Docker Desktop, used before, Podman too",
                found(false, true, true, true),
                None,
                OpenDockerDesktop,
            ),
            (
                "Docker Desktop never used",
                found(false, true, false, false),
                None,
                InstallPodman,
            ),
            (
                "Docker Desktop never used, Podman here",
                found(false, true, false, true),
                None,
                UsePodman,
            ),
            // A `docker` command that does not answer, with no Docker Desktop behind it, is no
            // Docker at all: nothing in `Found` even records that the command is there.
            (
                "stopped docker without Docker Desktop",
                NOTHING,
                None,
                InstallPodman,
            ),
            (
                "existing Podman",
                found(false, false, false, true),
                None,
                UsePodman,
            ),
            ("nothing", NOTHING, None, InstallPodman),
            // An installation saved on Docker.
            (
                "saved Docker, answering",
                found(true, true, true, false),
                docker,
                UseDocker,
            ),
            (
                "saved Docker, Docker Desktop stopped",
                found(false, true, true, true),
                docker,
                OpenDockerDesktop,
            ),
            // It answered for this installation, so it opens even with no disk where Docker
            // documents it (moved in Docker's settings, say).
            (
                "saved Docker, disk moved",
                found(false, true, false, true),
                docker,
                OpenDockerDesktop,
            ),
            (
                "saved Docker, none to open",
                found(false, false, false, true),
                docker,
                DockerNotRunning,
            ),
            // An installation saved on Podman never moves to Docker.
            (
                "saved Podman, Docker answering",
                found(true, true, true, true),
                podman,
                UsePodman,
            ),
            (
                "saved Podman, Docker Desktop used before",
                found(false, true, true, true),
                podman,
                UsePodman,
            ),
            (
                "saved Podman, Podman removed",
                found(true, true, true, false),
                podman,
                InstallPodman,
            ),
            // Linux: unchanged, and no Docker Desktop to open.
            (
                "Linux, answering Docker",
                linux(found(true, false, false, false)),
                None,
                UseDocker,
            ),
            (
                "Linux, saved Docker stopped",
                linux(found(false, true, true, true)),
                docker,
                DockerNotRunning,
            ),
        ];
        for (row, found, saved, expected) in rows {
            assert_eq!(choose(found, saved), expected, "{row}");
        }
    }

    #[test]
    fn a_stopped_docker_desktop_that_has_run_before_is_opened_and_podman_is_never_installed_beside_it(
    ) {
        let root = temp_root("stopped-docker-desktop");
        let mut observed = Vec::new();
        // Used before, or saved by this installation: Docker Desktop is opened.
        for (found, saved) in [
            (found(false, true, true, false), None),
            (found(false, true, true, true), None),
            (found(false, true, false, false), Some(Engine::Docker)),
        ] {
            let chosen = install_engine_with(
                &root,
                found,
                saved,
                |engine, ok| observed.push((engine, ok)),
                || Ok("started".into()),
                |_| panic!("Podman is never installed beside Docker"),
                |_| panic!("Docker Desktop ships its own Compose"),
            )
            .unwrap();
            assert_eq!(
                chosen,
                EngineChosen {
                    engine: Engine::Docker,
                    said: "started".into()
                }
            );
        }
        assert!(observed.is_empty(), "starting is not an install");
        // A Docker Desktop that does not start is reported as that, and Podman is not tried.
        let problem = install_engine_with(
            &root,
            found(false, true, true, false),
            None,
            |_, _| panic!("nothing is installed"),
            || Err(Problem::plain("no")),
            |_| panic!("no Podman in Docker's place"),
            |_| panic!("no Compose without an engine"),
        )
        .unwrap_err();
        assert_eq!(problem.said, "no");
    }

    /// Run on every desktop platform, and on Linux, where the old behaviour is kept.
    fn podman_is_installed(found: Found, saved: Option<Engine>) {
        let root = temp_root("no-engine");
        let mut observed = Vec::new();
        // Whether it then finds a podman program depends on the machine running the test: hosted
        // Ubuntu runners ship one. What matters is that the engine installed was Podman.
        let _ = install_engine_with(
            &root,
            found,
            saved,
            |engine, ok| observed.push((engine, ok)),
            || panic!("no Docker Desktop is opened"),
            |_| Ok(()),
            |_| Ok("Compose placed".into()),
        );
        assert_eq!(observed, [(Engine::Podman, true)]);
    }

    #[test]
    fn a_machine_with_no_docker_gets_podman() {
        podman_is_installed(NOTHING, None);
    }

    #[test]
    fn a_docker_desktop_that_has_never_run_is_not_opened_and_podman_is_installed() {
        podman_is_installed(found(false, true, false, false), None);
    }

    #[test]
    fn linux_keeps_installing_podman() {
        podman_is_installed(linux(NOTHING), None);
        // Linux has no Docker Desktop to open, whatever the flags say.
        podman_is_installed(linux(found(false, true, true, false)), None);
    }

    #[test]
    fn an_installation_saved_on_podman_never_moves_to_an_answering_docker() {
        let root = temp_root("saved-podman");
        let chosen = install_engine_with(
            &root,
            found(true, true, true, true),
            Some(Engine::Podman),
            |_, _| panic!("nothing is installed"),
            || panic!("Docker Desktop is not opened for a Podman installation"),
            |_| panic!("no install"),
            |_| Ok("Compose placed".into()),
        )
        .unwrap();
        assert_eq!(chosen.engine, Engine::Podman);
        // And a Podman that has gone is installed again, not swapped for Docker.
        podman_is_installed(found(true, true, true, false), Some(Engine::Podman));
    }

    #[test]
    fn an_installation_saved_on_docker_with_none_to_open_asks_for_docker() {
        let root = temp_root("saved-docker-stopped");
        let problem = install_engine_with(
            &root,
            found(false, false, false, true),
            Some(Engine::Docker),
            |_, _| panic!("nothing is installed"),
            || panic!("there is no Docker Desktop to open"),
            |_| panic!("no Podman in Docker's place"),
            |_| panic!("no Compose without an engine"),
        )
        .unwrap_err();
        assert!(problem.said.contains("Start Docker"), "{}", problem.said);
    }

    #[test]
    fn a_podman_somebody_already_has_is_theirs_and_is_used() {
        let root = temp_root("existing-podman");
        let chosen = install_engine_with(
            &root,
            found(false, false, false, true),
            None,
            |_, _| panic!("nothing is installed"),
            || panic!("no Docker Desktop to open"),
            |_| panic!("no install"),
            |_| Ok("Compose placed".into()),
        )
        .unwrap();
        assert_eq!(
            chosen,
            EngineChosen {
                engine: Engine::Podman,
                said: "Compose placed".into()
            }
        );
    }

    #[test]
    fn an_answering_docker_is_used_as_it_is() {
        let root = temp_root("answering-docker");
        let chosen = install_engine_with(
            &root,
            found(true, false, false, true),
            None,
            |_, _| panic!("nothing is installed"),
            || panic!("an answering Docker is not started again"),
            |_| panic!("no install"),
            |_| Ok("Compose placed".into()),
        )
        .unwrap();
        assert_eq!(chosen.engine, Engine::Docker);
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

        // A deflated ZIP containing bun-fixture/bun, a /bin/sh script printing 1.4.3,
        // and an unrelated traversal entry that must never be extracted. Fixed bytes keep
        // digest verification and real decompression in this offline regression.
        let bytes = base64::engine::general_purpose::STANDARD.decode(
            "UEsDBBQAAAAIAAAAIVxUT2uCHQAAABsAAAAPAAAAYnVuLWZpeHR1cmUvYnVuU1bUT8rM0y/O4CooyswrSVNQN9Qz0TOOyVPnAgBQSwMEFAAAAAgAAAAhXDpV0AcXAAAAFQAAAA0AAAAuLi91bmV4cGVjdGVkyy0tLlHIyy9RSEpVSK0oKUpMLklNAQBQSwECFAMUAAAACAAAACFcVE9rgh0AAAAbAAAADwAAAAAAAAAAAAAAgAEAAAAAYnVuLWZpeHR1cmUvYnVuUEsBAhQDFAAAAAgAAAAhXDpV0AcXAAAAFQAAAA0AAAAAAAAAAAAAAIABSgAAAC4uL3VuZXhwZWN0ZWRQSwUGAAAAAAIAAgB4AAAAjAAAAAAA",
        ).unwrap();
        let root = temp_root(name);
        std::fs::create_dir_all(&root).unwrap();
        let download = Download {
            url: "http://127.0.0.1:1/never-reached".into(),
            sha256: "2620378dbeb5b75aa500d3402928732c4e9f800a4546e609f2ff99be95470a29",
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
                "1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b",
            ),
            (
                "aarch64",
                "bun-linux-aarch64.zip",
                "efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21",
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
            b"#!/bin/sh\nprintf '1.4.3\\n'\n"
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
        let root = temp_root("existing-pinned-bun");
        let existing = runtime_version_fixture(&root, BUN);
        assert_eq!(
            ensure_bun_with(Some(existing.clone()), || panic!("already installed")).unwrap(),
            existing
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    fn runtime_version_fixture(root: &Path, version: &str) -> PathBuf {
        std::fs::create_dir_all(root).unwrap();
        let source = root.join("runtime.rs");
        std::fs::write(&source, format!("fn main() {{ assert_eq!(std::env::args().nth(1).as_deref(), Some(\"--version\")); println!({version:?}); }}")).unwrap();
        let binary = root.join(format!("bun{}", std::env::consts::EXE_SUFFIX));
        crate::test_support::compile_fixture(&source, &binary);
        binary
    }

    #[test]
    fn unsupported_existing_bun_acquires_pinned_runtime_without_changing_user_binary() {
        let root = temp_root("unsupported-existing-bun");
        let existing = runtime_version_fixture(&root.join("user"), "1.2.15");
        let pinned = runtime_version_fixture(&root.join("openbot"), BUN);
        let before = std::fs::read(&existing).unwrap();
        let chosen = ensure_bun_with(Some(existing.clone()), || Ok(pinned.clone())).unwrap();
        assert_eq!(
            chosen, pinned,
            "an incompatible user runtime must not be selected"
        );
        assert_eq!(
            std::fs::read(existing).unwrap(),
            before,
            "the user's runtime is untouched"
        );
        std::fs::remove_dir_all(root).unwrap();
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
