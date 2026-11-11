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
//!   to want one: it is the same dialog every other installer raises. It is never raised unexplained,
//!   and never behind a click: the package downloads while the person signs in, then the step says
//!   the prompt is coming and why, leaves it a moment to be read, and raises it by itself
//!   (`install_with_password`). A prompt closed without a password is asked again (`GoAhead`). The
//!   prompt itself says why in OpenBot's words (`PODMAN_PASSWORD_PROMPT`).
//! - **Linux.** Podman there is not a binary but a set of them (`conmon`, `crun`, `netavark`,
//!   `slirp4netns`), wired to the distribution's own paths, so downloading one file would produce
//!   something that runs nothing. The distribution's package manager installs it, through
//!   `pkexec`, which raises that desktop's own authorization prompt.

use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use crate::engine::{self, Engine, StepLine};
use crate::problem::Problem;

/// The releases this was tested against.
///
/// Pinned for the reason the deployment pins image digests: a version is what somebody hopes is
/// there, a digest is what was run. Moving these means re-recording the digests below.
pub const PODMAN: &str = "6.1.1";
pub const COMPOSE: &str = "5.5.1";

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
    let (file, sha256) =
        match (std::env::consts::OS, crate::windows::machine_arch()) {
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
            ("macos", _) => return Err(Problem::with(
                "OpenBot can't install the software it runs on on an Intel Mac. Install Docker \
                 Desktop or Podman Desktop, then start OpenBot again.",
                format!("Podman {PODMAN} publishes an arm64 package only"),
            )),
            ("linux", _) => return Err(Problem::with(
                "On Linux, the software OpenBot runs on comes from your system's own packages. \
                 Install the podman package, then start OpenBot again.",
                "on Linux the engine comes from the distribution's own packages",
            )),
            (os, arch) => {
                return Err(Problem::with(
                    "OpenBot can't install the software it runs on on this kind of computer.",
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
    let (file, sha256) = match (std::env::consts::OS, crate::windows::machine_arch()) {
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
                "OpenBot can't install the software it runs on on this kind of computer.",
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
/// download far more often than it is an attack, and either way it must not be run. The download
/// itself is the early downloads' (`early_downloads::fetch`): from downloads.copilotkit.ai first,
/// resumed where an earlier one stopped, and waited for when the first screen already started it.
fn fetch_verified(download: &Download, into: &Path) -> Result<PathBuf, Problem> {
    fetch_pinned(download, into, &()).map_err(|error| {
        Problem::with(
            "OpenBot could not download the software it needs to run. Check the internet \
             connection and try again.",
            format!("{}: {error}", download.url),
        )
    })
}

fn fetch_pinned(
    download: &Download,
    into: &Path,
    progress: &dyn crate::early_downloads::Progress,
) -> Result<PathBuf, String> {
    let pinned = crate::early_downloads::Pinned {
        name: download.file.to_string(),
        sha256: download.sha256.to_string(),
        size: None,
        sources: crate::deployment::mirrored(&download.url)
            .into_iter()
            .chain(std::iter::once(download.url.clone()))
            .collect(),
    };
    crate::early_downloads::fetch(&pinned, into, progress)
}

/// Podman's installer for this computer, into `into`, before Install needs it. Never installed here.
pub fn fetch_podman_installer(
    into: &Path,
    progress: &dyn crate::early_downloads::Progress,
) -> Result<PathBuf, String> {
    fetch_pinned(
        &podman_download().map_err(|problem| problem.said)?,
        into,
        progress,
    )
}

/// Compose for this computer, ready to run on its own, for `config` before any engine is here: the
/// verified download, copied where nothing looks for a provider and made executable.
pub fn runnable_compose(
    into: &Path,
    progress: &dyn crate::early_downloads::Progress,
) -> Result<PathBuf, String> {
    let staged = fetch_compose(into, progress)?;
    let folder = into.join("early-compose");
    std::fs::create_dir_all(&folder)
        .map_err(|error| format!("could not make {}: {error}", folder.display()))?;
    let named = folder.join(compose_provider_name());
    std::fs::copy(&staged, &named)
        .map_err(|error| format!("could not copy Compose to {}: {error}", named.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&named, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("chmod 755 {}: {error}", named.display()))?;
    }
    Ok(named)
}

/// Compose for this computer, into `into`, before Install places it.
pub fn fetch_compose(
    into: &Path,
    progress: &dyn crate::early_downloads::Progress,
) -> Result<PathBuf, String> {
    fetch_pinned(
        &compose_download().map_err(|problem| problem.said)?,
        into,
        progress,
    )
}

/// One sentence for every "could not write here", because the person's fix is the same each time.
fn unwritable(path: &Path, error: &str) -> Problem {
    Problem::with(
        "OpenBot could not save the software it downloaded. Check there is free disk space and \
         try again.",
        format!("{}: {error}", path.display()),
    )
}

#[cfg(test)]
fn digest_of(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Put the engine on this machine, and a Compose it can run.
///
/// Both halves, in that order, because the second is invisible until the first has succeeded and
/// somebody presses Start. Answers with the sentence for the step row, or a failure in both
/// registers. `saved` is the engine the installation was set up on, if it saved one.
pub fn install_engine(cache: &Path, saved: Option<Engine>) -> Result<String, Problem> {
    install_engine_observed(cache, saved, |_, _| {}, &mut |_| {}, &|| {}, &|| false)
        .map(|chosen| chosen.said)
}

/// The engine the install step settled on, and the sentence for its step row.
#[derive(Debug, PartialEq, Eq)]
pub struct EngineChosen {
    pub engine: Engine,
    pub said: String,
}

/// Observe an actual engine install, excluding engines that were already here, starting Docker
/// Desktop and Compose repair; `progress` is each line for the step row.
///
/// `back` brings OpenBot's window to the front again after another app's window took it: Docker
/// Desktop once it answers, or the system's password prompt once Podman's installer is done.
///
/// `cancelled` ends a wait for the person's go-ahead (`GoAhead`): Stop or Quit while it waits.
pub fn install_engine_observed(
    cache: &Path,
    saved: Option<Engine>,
    installed: impl FnMut(Engine, bool),
    progress: &mut dyn FnMut(StepLine),
    back: &dyn Fn(),
    cancelled: &dyn Fn() -> bool,
) -> Result<EngineChosen, Problem> {
    // Only one of the two runs, so they share the step row's lines one at a time.
    let progress = std::cell::RefCell::new(progress);
    install_engine_with(
        cache,
        Found::here(saved),
        saved,
        installed,
        || crate::docker_desktop::start(&mut **progress.borrow_mut(), back),
        |into| install_podman(into, &mut **progress.borrow_mut(), back, cancelled),
        place_compose,
    )
}

/*
 * The person reads "the software OpenBot runs on", never "Podman": a person setting OpenBot up
 * does not know what Podman is, and does not need to. The log names it (`StepLine::logged`).
 */

/// The step row's line while Podman's package downloads, before anything needs the person.
pub fn podman_downloading() -> StepLine {
    StepLine::here("Downloading the software OpenBot runs on.").logged("Downloading Podman.")
}

/// After the person closed macOS's password prompt without a password: said plainly, with Try
/// again in the window, and asked again by itself after `ASK_AGAIN_AFTER`.
pub fn podman_declined() -> StepLine {
    StepLine::asks(
        "OpenBot needs your password to install what it needs to run. It asks again in a moment, \
         or choose Try again.",
    )
    .logged("The password prompt was closed, so Podman isn't installed yet; asking again.")
}

/// What macOS's password prompt says, under the name of the process that raised it.
pub const PODMAN_PASSWORD_PROMPT: &str =
    "OpenBot needs your password to install the software it runs on.";

/// How long the line saying the prompt is coming stays on screen before the prompt covers it.
pub const BEFORE_PROMPT: Duration = Duration::from_millis(2500);

/// How long after a closed prompt OpenBot asks again by itself.
pub const ASK_AGAIN_AFTER: Duration = Duration::from_secs(15);

/**
Asking again, after the person closed the system's password prompt: now, when they choose Try
again in the window, or by itself after a while.

The person is never asked to click before the prompt. The step says what is coming and why, gives
it a moment to be read, and raises the prompt (`install_with_password`). Only a prompt closed without
a password waits here, and not for long. A Try again given while nothing waits counts for nothing,
so a click left over never brings a prompt early.
*/
pub struct GoAhead {
    state: Mutex<Asked>,
    changed: Condvar,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Asked {
    Nothing,
    Waiting,
    Given,
}

impl Default for GoAhead {
    fn default() -> Self {
        Self::new()
    }
}

impl GoAhead {
    pub const fn new() -> Self {
        Self {
            state: Mutex::new(Asked::Nothing),
            changed: Condvar::new(),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, Asked> {
        self.state.lock().unwrap_or_else(|held| held.into_inner())
    }

    /// The person chose Try again. True when a step was waiting to ask again.
    pub fn give(&self) -> bool {
        let mut state = self.state();
        if *state != Asked::Waiting {
            return false;
        }
        *state = Asked::Given;
        self.changed.notify_all();
        true
    }

    /// Say why, then wait until Try again or `limit`, whichever comes first. `cancelled` (Stop or
    /// Quit) ends the wait with nothing asked.
    pub fn wait(
        &self,
        limit: Duration,
        ask: impl FnOnce(),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(), Problem> {
        *self.state() = Asked::Waiting;
        ask();
        let until = std::time::Instant::now() + limit;
        let mut state = self.state();
        loop {
            if *state == Asked::Given || std::time::Instant::now() >= until {
                *state = Asked::Nothing;
                return Ok(());
            }
            if cancelled() {
                *state = Asked::Nothing;
                return Err(stopped_before_installing());
            }
            state = self
                .changed
                .wait_timeout(state, Duration::from_millis(100))
                .unwrap_or_else(|held| held.into_inner())
                .0;
        }
    }
}

fn stopped_before_installing() -> Problem {
    Problem::with(
        "OpenBot stopped before installing the software it runs on. Start again when you're \
         ready.",
        "stopped before the password prompt to install Podman",
    )
}

/// The Try again Install listens for after the password prompt was closed.
pub static PODMAN_GO_AHEAD_GATE: GoAhead = GoAhead::new();

/// The window's Try again. True when Install was waiting to ask again.
pub fn allow_podman_install() -> bool {
    PODMAN_GO_AHEAD_GATE.give()
}

/// How the password prompt and the installer behind it ended.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug)]
pub(crate) enum Prompted {
    Installed,
    /// The person closed the prompt. A decision, not a failure: the step asks again.
    Declined,
    Failed(Problem),
}

/**
Download Podman's package, say the password prompt is coming and why, then raise it.

No click first. The download needs nobody, so it runs while the person signs in. Then the step says
"Your Mac will ask for your password so OpenBot can install what it needs to run." and leaves it
`before_prompt` to be read before the prompt covers it. A prompt closed without a password is said
plainly and asked again, by itself after `ask_again_after` or at once on Try again, rather than
failing Install behind a screen with no way to start it again.
*/
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[allow(clippy::too_many_arguments)]
fn install_with_password(
    fetch: impl FnOnce() -> Result<PathBuf, Problem>,
    progress: &mut dyn FnMut(StepLine),
    again: &GoAhead,
    cancelled: &dyn Fn() -> bool,
    mut prompt: impl FnMut(&str) -> Prompted,
    back: &dyn Fn(),
    before_prompt: Duration,
    ask_again_after: Duration,
) -> Result<(), Problem> {
    progress(podman_downloading());
    let package = fetch()?;
    let script = podman_install_script(&package);
    loop {
        progress(podman_install_said("macos"));
        // Read first: the prompt comes up over everything.
        let until = std::time::Instant::now() + before_prompt;
        while std::time::Instant::now() < until {
            if cancelled() {
                return Err(stopped_before_installing());
            }
            std::thread::sleep(Duration::from_millis(50).min(before_prompt));
        }
        if cancelled() {
            return Err(stopped_before_installing());
        }
        let prompted = prompt(&script);
        // The prompt was in front of OpenBot's window, however it ended.
        back();
        match prompted {
            Prompted::Installed => return Ok(()),
            Prompted::Declined => {
                again.wait(ask_again_after, || progress(podman_declined()), cancelled)?
            }
            Prompted::Failed(problem) => return Err(problem),
        }
    }
}

/// The AppleScript that installs Podman's package as an administrator, with OpenBot's own words in
/// the password prompt. `with prompt` is `do shell script`'s text for that dialog (StandardAdditions).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn podman_install_script(package: &Path) -> String {
    format!(
        "do shell script \"/usr/sbin/installer -pkg {} -target /\" with administrator privileges \
         with prompt {}",
        applescript_shell_arg(package),
        applescript_string(PODMAN_PASSWORD_PROMPT)
    )
}

/// Text as an AppleScript string literal.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn applescript_string(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The step row's line while Podman installs, naming the prompt the platform raises for it.
///
/// macOS asks for the person's password, because the package writes to `/opt/podman`. Windows
/// asks for nothing here: the MSI installs for this account alone. Linux asks through `pkexec`.
/// A prompt is a window of the system's own, in front of OpenBot's, so its line is `elsewhere`.
pub fn podman_install_said(os: &str) -> StepLine {
    match os {
        "macos" => StepLine::elsewhere(
            "Your Mac will ask for your password so OpenBot can install what it needs to run.",
        )
        .logged("Installing Podman's package; macOS asks for the password."),
        "linux" => StepLine::elsewhere(
            "Your computer will ask for your password so OpenBot can install what it needs to run.",
        )
        .logged("Installing Podman with pkexec; the system asks for the password."),
        _ => {
            StepLine::here("Installing the software OpenBot runs on.").logged("Installing Podman.")
        }
    }
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
pub enum Choice {
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

/// What Install would do for an engine on this computer now. The early downloads fetch what it needs.
pub fn choice_here(saved: Option<Engine>) -> Choice {
    choose(Found::here(saved), saved)
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
            "OpenBot installed the software it runs on, but can't find it afterwards. Install \
             Podman Desktop, then start OpenBot again.",
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
/// Nothing is placed when a Compose new enough for OpenBot already answers. Docker Desktop ships a
/// provider, and a Linux machine may have `docker-compose-v2` from its own packages; putting a
/// second one in front of either is a version somebody did not choose. One too old to run OpenBot
/// (an old Docker Desktop's, found on PATH by Podman) is put behind ours: see `engine_versions`.
fn place_compose(into: &Path) -> Result<String, Problem> {
    let address = crate::acquire::address();
    if address.composes() && !compose_too_old(&address) {
        return Ok("Compose is already here.".into());
    }
    place_newer_compose(into)
}

/// Whether the Compose that answers through `address` is older than OpenBot needs. Not on Linux,
/// whose Compose comes from the distribution (see `engine_versions`).
fn compose_too_old(address: &engine::Address) -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
        && crate::engine_versions::read(address)
            .compose
            .is_some_and(|version| version < crate::engine_versions::COMPOSE)
}

/// Place OpenBot's own Compose provider, in front of whatever provider is already there.
///
/// It goes in OpenBot's tools directory, which every engine command OpenBot runs has first on its
/// PATH (`engine::command_at`). Nothing anybody else installed is changed or removed.
pub fn place_newer_compose(into: &Path) -> Result<String, Problem> {
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
                    "OpenBot couldn't finish installing the software it runs on. Try again.",
                    format!("chmod 755 {}: {error}", named.display()),
                )
            },
        )?;
    }

    Ok(format!("Compose {COMPOSE} installed."))
}

/**
Update a Podman that is too old to run OpenBot, by running OpenBot's own pinned installer over it.

The same installer, the same digest check and the same prompt as a first install (`install_podman`):
the package on a Mac, the MSI on Windows. Both upgrade in place. Neither removes Podman's machines,
which live in the person's own folders, so every machine and every container, image and volume in
it are there afterwards. Podman 6 reads the machines Podman 5 made on macOS and Windows (only
machines on Linux had to be made again, and Linux is not updated here).

EVERY MACHINE THAT WAS RUNNING IS RUNNING AFTERWARDS, WITH ITS API ANSWERING: the person's own as
much as OpenBot's. OpenBot runs on its own machine beside the person's `podman-machine-default` on
Windows (see `own_machine`), and the MSI stops the helpers of every machine it finds running. On a live Windows run the 6.1.1 MSI over
5.8.9 left the person's machine up and its `win-sshproxy` gone, and with it the Docker API every
pull uses (see `acquire`). Only OpenBot's own machine used to be stopped and started.

So the machines running are listed first. On Windows they are stopped before the MSI, because their
helpers (`gvproxy`, `win-sshproxy`) run from Podman's folder. Afterwards each one whose API does not
answer is stopped and started (`bring_back`), with the containers that were running in it. On a Mac
the package does not stop them: its `preinstall` removes `/opt/podman` and its `postinstall` installs
`podman-mac-helper`, and a running `vfkit` or `gvproxy` keeps running from the file it opened. A Mac
machine is restarted only if its API does not answer afterwards. A machine is started again even when
the installer failed, so one OpenBot stopped is never left stopped.
*/
pub fn update_podman(
    cache: &Path,
    progress: &mut dyn FnMut(StepLine),
    back: &dyn Fn(),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), Problem> {
    let into = crate::acquire::download_dir(cache);
    update_podman_with(
        &mut ThisComputer::default(),
        cfg!(target_os = "windows"),
        progress,
        &mut |progress| {
            install_podman(&into, progress, back, cancelled)?;
            if engine::program(Engine::Podman).is_none() {
                return Err(Problem::with(
                    "OpenBot updated the software it runs on, but can't find it afterwards. \
                     Start OpenBot again.",
                    format!("the Podman {PODMAN} installer reported success; podman is not found"),
                ));
            }
            Ok(())
        },
    )
}

/// The row's line while Podman updates: why it is updating, since it is the person's own Podman.
pub fn podman_updating() -> StepLine {
    StepLine::here("The Podman on this computer is too old for OpenBot, so OpenBot is updating it.")
        .updating()
}

/// A line the installer says, as the update says it. Work OpenBot does by itself says why it is
/// updating. A system prompt that is coming says why, then the prompt, so it is explained before it
/// comes up. A wait for the person's go-ahead is said as it is. The log keeps the installer's words.
fn while_updating(line: StepLine) -> StepLine {
    if line.asks {
        return line;
    }
    let why = podman_updating().said;
    // The installer's prompt, said short after why: "...so OpenBot is updating it. Your Mac will
    // ask for your password." The whole of both did not fit the background row.
    let said = if line.elsewhere {
        format!(
            "{why} {}",
            line.said
                .split_once(" so OpenBot")
                .map_or(line.said.clone(), |(prompt, _)| format!("{prompt}."))
        )
    } else {
        why
    };
    let detail = line.detail.clone().unwrap_or_else(|| line.said.clone());
    StepLine {
        said,
        detail: Some(detail),
        updating: true,
        ..line
    }
}

/// The Podman machines on this computer, as an update needs them, so the sequence can be tested
/// without one.
pub trait Machines {
    /// The machines running now, by name.
    fn running(&mut self) -> Result<Vec<String>, String>;
    /// Stop one, remembering the containers running in it.
    fn stop(&mut self, name: &str) -> Result<(), String>;
    /// Start one, and the containers `stop` found running in it.
    fn start(&mut self, name: &str) -> Result<(), String>;
    /// It is running and its Docker API answers, or why not.
    fn answers(&mut self, name: &str) -> Result<(), String>;
}

/// `Machines` on this computer.
#[derive(Default)]
struct ThisComputer {
    containers: std::collections::HashMap<String, crate::acquire::Containers>,
}

impl Machines for ThisComputer {
    fn running(&mut self) -> Result<Vec<String>, String> {
        crate::acquire::running_machines()
    }

    fn stop(&mut self, name: &str) -> Result<(), String> {
        // Asked before the stop, and only the first time: a second stop finds nothing running.
        let running = crate::acquire::running_containers(name);
        if !running.is_empty() {
            self.containers.entry(name.to_string()).or_insert(running);
        }
        crate::acquire::stop_machine_named(name)
    }

    fn start(&mut self, name: &str) -> Result<(), String> {
        let containers = self.containers.remove(name).unwrap_or_default();
        crate::acquire::start_machine_named(name, &containers)
    }

    fn answers(&mut self, name: &str) -> Result<(), String> {
        crate::acquire::machine_api_answers(name)
    }
}

/// Running the installer, saying its lines on the row as it goes.
type Installer<'a> = dyn FnMut(&mut dyn FnMut(StepLine)) -> Result<(), Problem> + 'a;

fn update_podman_with(
    machines: &mut dyn Machines,
    stop_first: bool,
    progress: &mut dyn FnMut(StepLine),
    install: &mut Installer<'_>,
) -> Result<(), Problem> {
    progress(podman_updating().logged(format!(
        "Podman is older than {}; installing Podman {PODMAN} over it.",
        crate::engine_versions::PODMAN
    )));
    let running = machines.running().unwrap_or_else(|error| {
        log::warn!(
            "[engine] could not list the machines running before the Podman update: {error}"
        );
        Vec::new()
    });
    log::info!(
        "[engine] machines running before the Podman update: {}",
        if running.is_empty() {
            "none".to_string()
        } else {
            running.join(", ")
        }
    );
    if stop_first {
        for name in &running {
            progress(podman_updating().logged(format!(
                "Stopping {name} before the installer replaces Podman's files (podman machine stop)."
            )));
            if let Err(error) = machines.stop(name) {
                log::warn!("[engine] could not stop {name} before the Podman update: {error}");
            }
        }
    }
    let installed = install(&mut |line| progress(while_updating(line)));
    let brought_back = bring_back(machines, &running, progress);
    if let (Err(_), Err(problem)) = (&installed, &brought_back) {
        log::warn!(
            "[engine] after a failed Podman update: {}",
            problem.detail.as_deref().unwrap_or(&problem.said)
        );
    }
    installed?;
    brought_back
}

/// Every machine in `running` running again with its API answering: one that answers is left as it
/// is, and any other is stopped and started.
fn bring_back(
    machines: &mut dyn Machines,
    running: &[String],
    progress: &mut dyn FnMut(StepLine),
) -> Result<(), Problem> {
    let mut failed = Vec::new();
    for name in running {
        match machines.answers(name) {
            Ok(()) => {
                log::info!("[engine] {name} answers after the Podman update");
                continue;
            }
            Err(why) => log::info!(
                "[engine] {name} does not answer after the Podman update ({why}); stopping and \
                 starting it"
            ),
        }
        progress(podman_updating().logged(format!(
            "Starting {name} again (podman machine stop, then start), so its API answers."
        )));
        if let Err(error) = machines.stop(name) {
            log::info!("[engine] podman machine stop {name}: {error}");
        }
        if let Err(error) = machines.start(name) {
            failed.push(format!("podman machine start {name}: {error}"));
        }
    }
    if failed.is_empty() {
        return Ok(());
    }
    Err(Problem::with(
        "OpenBot updated Podman, but couldn't start it again. Try again.",
        failed.join("; "),
    ))
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
fn install_podman(
    into: &Path,
    progress: &mut dyn FnMut(StepLine),
    _back: &dyn Fn(),
    _cancelled: &dyn Fn() -> bool,
) -> Result<(), Problem> {
    // The MSI installs for this account alone and asks for nothing.
    progress(podman_install_said("windows"));
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
                "Windows policy blocks installing Podman, which OpenBot needs to run. Ask an \
                 administrator to allow the installation or install Podman for your account, \
                 then try again."
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
fn install_podman(
    into: &Path,
    progress: &mut dyn FnMut(StepLine),
    back: &dyn Fn(),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), Problem> {
    install_with_password(
        || fetch_verified(&podman_download()?, into),
        progress,
        &PODMAN_GO_AHEAD_GATE,
        cancelled,
        run_administrator_script,
        back,
        BEFORE_PROMPT,
        ASK_AGAIN_AFTER,
    )
}

/// Run `script` through `osascript`. `do shell script ... with administrator privileges` is how
/// macOS asks for administrator rights: the person sees the standard authorization dialog, and no
/// password passes through this process.
#[cfg(target_os = "macos")]
pub(crate) fn run_administrator_script(script: &str) -> Prompted {
    let output = match crate::quiet::command("osascript")
        .args(["-e", script])
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            return Prompted::Failed(Problem::with(
                "OpenBot could not start the installer for the software it needs.",
                format!("osascript: {error}"),
            ))
        }
    };
    if output.status.success() {
        return Prompted::Installed;
    }
    let said = crate::quiet::said(&output.stderr);
    // -128 is AppleScript's "user cancelled", which is a decision rather than a failure.
    if said.contains("-128") {
        return Prompted::Declined;
    }
    Prompted::Failed(Problem::with(
        "Installing the software OpenBot needs did not finish. Try again.",
        said,
    ))
}

/// A path that has to survive being a shell word inside an AppleScript string.
///
/// Two layers, applied in this order: single-quote it for the shell, then escape what AppleScript
/// treats as special in the double-quoted string that carries it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn applescript_shell_arg(path: &Path) -> String {
    let quoted = format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    quoted.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "linux")]
fn install_podman(
    _into: &Path,
    progress: &mut dyn FnMut(StepLine),
    back: &dyn Fn(),
    _cancelled: &dyn Fn() -> bool,
) -> Result<(), Problem> {
    progress(podman_install_said("linux"));
    let result = install_podman_with_pkexec();
    // pkexec's prompt was in front of OpenBot's window.
    back();
    result
}

#[cfg(target_os = "linux")]
fn install_podman_with_pkexec() -> Result<(), Problem> {
    let (manager, args) = linux_package_manager().ok_or_else(|| {
        Problem::with(
            "OpenBot can't install the software it needs on this system. Install the podman \
             package with your system's package manager, then start OpenBot again.",
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
        for download in [compose_download(), podman_download()]
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

    /// A Podman installer whose download was cut off, by a dropped connection or by quitting the app,
    /// carries on from the bytes already on disk at the next try, and is checked whole before it is
    /// kept. Before the early downloads, every try downloaded the whole file again into memory.
    #[test]
    fn a_download_cut_off_part_way_carries_on_from_where_it_stopped() {
        use crate::early_downloads::tests::{file, ranged, whole, Server};
        let (body, sha256) = file(400_000);
        let served = body.clone();
        let server = Server::start(move |request, index| match index {
            0 => whole(&served, Some(150_000)),
            _ => ranged(request, &served),
        });
        let dir = temp_root("install-resume");
        let download = Download {
            url: server.url("/podman-installer-macos-arm64.pkg"),
            sha256: Box::leak(sha256.into_boxed_str()),
            file: "podman-installer-macos-arm64.pkg",
        };
        let path = fetch_verified(&download, &dir).expect("the installer, carried on");
        assert_eq!(std::fs::read(&path).unwrap(), body);
        let seen = server.seen();
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert_eq!(seen[1].range.as_deref(), Some("bytes=150000-"), "{seen:?}");
        assert_eq!(server.sent(), body.len(), "nothing was downloaded twice");
        let _ = std::fs::remove_dir_all(&dir);
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
            "Windows policy blocks installing Podman, which OpenBot needs to run. Ask an \
             administrator to allow the installation or install Podman for your account, then \
             try again."
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

    /// The prompt is named where there is one, and none is promised where there is not.
    #[test]
    fn the_podman_install_line_names_the_prompt_each_platform_raises() {
        // A prompt is the system's own window in front of OpenBot's: the line says so wherever
        // the person is, and OpenBot comes back once the installer is done.
        for os in ["macos", "linux"] {
            let line = podman_install_said(os);
            assert!(line.said.contains("password"), "{os}");
            assert!(line.elsewhere, "{os}");
        }
        let windows = podman_install_said("windows");
        assert_eq!(windows.said, "Installing the software OpenBot runs on.");
        assert!(!windows.elsewhere);
    }

    /// Words a person setting OpenBot up doesn't know. The screen never says them; the log does.
    const TECHNICAL: &[&str] = &[
        "Podman",
        "WSL",
        "Windows Subsystem for Linux",
        "engine machine",
        "engine",
        "machine",
        "k3s",
        "Helm",
        "Compose",
    ];

    /// A tester read "Preparing the engine machine" and "Installing Podman" for minutes and could
    /// not tell whether setup was stuck. Every line setup shows while it prepares this computer is
    /// in plain words; the log keeps the technical names beside it.
    #[test]
    fn every_line_shown_while_preparing_this_computer_is_plain_and_the_log_keeps_the_detail() {
        let lines = [
            podman_downloading(),
            podman_declined(),
            podman_install_said("macos"),
            podman_install_said("linux"),
            podman_install_said("windows"),
            engine::preparing_machine_line("macos"),
            engine::preparing_machine_line("windows"),
            engine::preparing_machine_line("linux"),
            engine::starting_machine_line(),
            engine::checking_engine_line(),
            engine::engine_ready_line(),
        ];
        let shown = lines
            .iter()
            .map(|line| line.said.as_str())
            .chain([PODMAN_PASSWORD_PROMPT]);
        for said in shown {
            for word in TECHNICAL {
                assert!(
                    !said.to_lowercase().contains(&word.to_lowercase()),
                    "{word:?} is on screen: {said:?}"
                );
            }
        }
        for line in &lines {
            let detail = line.detail.as_deref().expect("the log keeps the detail");
            let entry = line.log_entry();
            assert!(entry.contains(detail), "{entry}");
            assert!(entry.contains(&line.said), "{entry}");
        }
        let log = lines
            .iter()
            .map(StepLine::log_entry)
            .collect::<Vec<_>>()
            .join("\n");
        for kept in [
            "Podman",
            "engine machine",
            "Windows Subsystem for Linux",
            "podman machine init",
            "podman machine start",
            "Waiting for the engine to answer.",
        ] {
            assert!(log.contains(kept), "{kept:?} is not in the log:\n{log}");
        }
    }

    /// Where Podman's package lands: the app's cache, which has a space in its path on macOS.
    const PACKAGE: &str = "/Users/a b/Library/Caches/OpenBot/podman-installer-macos-arm64.pkg";

    /// What happened, in order: the step's lines, the download, the prompt and OpenBot coming back.
    #[derive(Clone, Default)]
    struct Seen(std::sync::Arc<Mutex<Vec<String>>>);

    impl Seen {
        fn add(&self, what: impl Into<String>) {
            self.0.lock().unwrap().push(what.into());
        }

        fn line(&self, line: StepLine) {
            let kind = if line.asks {
                "asks"
            } else if line.elsewhere {
                "elsewhere"
            } else {
                "here"
            };
            self.add(format!("{kind}: {}", line.said));
        }

        fn all(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }

        /// Each time a prompt came up, how long after the line before it.
        fn prompts(&self) -> usize {
            self.all().iter().filter(|seen| *seen == "prompt").count()
        }
    }

    const SAY_FIRST: &str =
        "elsewhere: Your Mac will ask for your password so OpenBot can install what it needs to run.";

    /// David's direction for 1.0.1: no Continue before the password prompt. The person is told what
    /// is coming and why, has a moment to read it, and the prompt comes up by itself. Here nothing
    /// in the window ever gives a go-ahead, and the prompt still comes, after the line and the pause.
    #[test]
    fn the_password_prompt_comes_after_its_explanation_without_a_click() {
        let gate = GoAhead::new();
        let seen = Seen::default();
        let said_at = std::sync::Mutex::new(None);
        let mut scripts = Vec::new();
        let installed = install_with_password(
            || {
                seen.add("downloaded");
                Ok(PathBuf::from(PACKAGE))
            },
            &mut |line| {
                if line.elsewhere {
                    *said_at.lock().unwrap() = Some(std::time::Instant::now());
                }
                seen.line(line)
            },
            &gate,
            &|| false,
            |script| {
                let waited = said_at.lock().unwrap().unwrap().elapsed();
                assert!(waited >= Duration::from_millis(200), "{waited:?}");
                seen.add("prompt");
                scripts.push(script.to_owned());
                Prompted::Installed
            },
            &|| seen.add("back"),
            Duration::from_millis(200),
            Duration::from_secs(60),
        );
        assert!(installed.is_ok(), "{installed:?}");
        assert_eq!(
            seen.all(),
            [
                "here: Downloading the software OpenBot runs on.",
                "downloaded",
                SAY_FIRST,
                "prompt",
                "back",
            ]
        );
        // Nothing asked the person to click: no line asked for their go-ahead.
        assert!(!seen.all().iter().any(|line| line.starts_with("asks: ")));
        assert_eq!(
            scripts,
            [concat!(
                r#"do shell script "/usr/sbin/installer -pkg '/Users/a b/Library/Caches/OpenBot/"#,
                r#"podman-installer-macos-arm64.pkg' -target /" with administrator privileges "#,
                r#"with prompt "OpenBot needs your password to install the software it runs on.""#
            )]
        );
    }

    /// Closing the prompt without a password is a decision, and recoverable: no failure, the step
    /// says plainly that OpenBot needs it, and asks again by itself after a short wait.
    #[test]
    fn a_closed_password_prompt_asks_again_by_itself_without_an_error() {
        let gate = GoAhead::new();
        let seen = Seen::default();
        let mut answers = [Prompted::Declined, Prompted::Installed].into_iter();
        let installed = install_with_password(
            || Ok(PathBuf::from(PACKAGE)),
            &mut |line| seen.line(line),
            &gate,
            &|| false,
            |_| {
                seen.add("prompt");
                answers.next().unwrap()
            },
            &|| seen.add("back"),
            Duration::from_millis(10),
            Duration::from_millis(300),
        );
        assert!(installed.is_ok(), "{installed:?}");
        assert_eq!(
            seen.all(),
            [
                "here: Downloading the software OpenBot runs on.",
                SAY_FIRST,
                "prompt",
                "back",
                "asks: OpenBot needs your password to install what it needs to run. It asks again \
                 in a moment, or choose Try again.",
                SAY_FIRST,
                "prompt",
                "back",
            ]
        );
    }

    /// Try again, in the window after a closed prompt, asks again at once.
    #[test]
    fn try_again_after_a_closed_prompt_asks_at_once() {
        let gate = std::sync::Arc::new(GoAhead::new());
        let seen = Seen::default();
        let window = {
            let (gate, seen) = (gate.clone(), seen.clone());
            std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                while !seen.all().iter().any(|line| line.starts_with("asks: ")) {
                    assert!(std::time::Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(10));
                }
                assert!(gate.give());
            })
        };
        let started = std::time::Instant::now();
        let mut answers = [Prompted::Declined, Prompted::Installed].into_iter();
        let installed = install_with_password(
            || Ok(PathBuf::from(PACKAGE)),
            &mut |line| seen.line(line),
            &gate,
            &|| false,
            |_| {
                seen.add("prompt");
                answers.next().unwrap()
            },
            &|| {},
            Duration::from_millis(10),
            Duration::from_secs(60),
        );
        window.join().unwrap();
        assert!(installed.is_ok(), "{installed:?}");
        assert_eq!(seen.prompts(), 2);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    /// Stop or Quit while the line is being read, or while it waits to ask again, raises no prompt.
    #[test]
    fn stopping_before_the_prompt_raises_none() {
        let seen = Seen::default();
        let stopped = std::sync::atomic::AtomicBool::new(false);
        let failed = install_with_password(
            || Ok(PathBuf::from(PACKAGE)),
            &mut |line| {
                seen.line(line);
                stopped.store(true, std::sync::atomic::Ordering::SeqCst);
            },
            &GoAhead::new(),
            &|| stopped.load(std::sync::atomic::Ordering::SeqCst),
            |_| {
                seen.add("prompt");
                Prompted::Installed
            },
            &|| seen.add("back"),
            Duration::from_millis(200),
            Duration::from_secs(60),
        )
        .unwrap_err();
        assert_eq!(
            failed.said,
            "OpenBot stopped before installing the software it runs on. Start again when you're \
             ready."
        );
        assert_eq!(seen.prompts(), 0, "{:?}", seen.all());
    }

    /// A Try again left over from earlier, or sent twice, never brings a prompt early.
    #[test]
    fn a_try_again_with_nothing_waiting_counts_for_nothing() {
        let gate = GoAhead::new();
        assert!(!gate.give());
        let asked_once = std::sync::atomic::AtomicUsize::new(0);
        // The earlier click is not taken: the wait ends only by the limit or the stop.
        let waited = gate.wait(
            Duration::from_secs(60),
            || {
                asked_once.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            },
            &|| asked_once.load(std::sync::atomic::Ordering::SeqCst) == 1,
        );
        assert!(waited.is_err());
        assert!(!gate.give());
    }

    /*
     * The person's own Podman machine through a Podman update, on a fake that does what the real
     * platform did on a live Windows run (Podman 5.8.9 with `podman-machine-default` running, the
     * person's container and volume in it, updated to 6.1.1 by OpenBot's MSI):
     *
     * - `podman machine list --format json` lists it by its name with "Running": true (the
     *   listing below is the shape Podman 6.1.1 prints on a Mac, `Running` and all).
     * - The MSI leaves a machine it finds running up and its Docker API gone: `win-sshproxy` was
     *   stopped and nothing started it again. Pulls then failed at "failed to connect to the docker
     *   API at npipe:////./pipe/podman-machine-default ... The system cannot find the file
     *   specified."
     * - `podman machine stop` stops it and its API; `podman machine start` starts both.
     */
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct Machine {
        running: bool,
        api: bool,
    }

    #[derive(Default)]
    struct Computer {
        machines: Vec<(&'static str, Machine)>,
        done: Vec<String>,
    }

    impl Computer {
        fn machine(&mut self, name: &str) -> &mut Machine {
            &mut self
                .machines
                .iter_mut()
                .find(|(named, _)| *named == name)
                .expect("a machine Podman lists")
                .1
        }
    }

    /// The machines, shared with the installer, which acts on them between what the update does
    /// before it and after it.
    #[derive(Clone, Default)]
    struct FakeMachines(std::rc::Rc<std::cell::RefCell<Computer>>);

    impl FakeMachines {
        fn running_default() -> Self {
            let fake = Self::default();
            fake.0.borrow_mut().machines.push((
                "podman-machine-default",
                Machine {
                    running: true,
                    api: true,
                },
            ));
            fake
        }

        fn machine(&self, name: &str) -> Machine {
            *self.0.borrow_mut().machine(name)
        }

        fn set(&self, name: &str, machine: Machine) {
            *self.0.borrow_mut().machine(name) = machine;
        }

        fn done(&self) -> Vec<String> {
            self.0.borrow().done.clone()
        }

        /// What the MSI did to every machine it found running.
        fn installer_ran(&self) {
            let mut computer = self.0.borrow_mut();
            computer.done.push("install".into());
            for (_, machine) in &mut computer.machines {
                if machine.running {
                    machine.api = false;
                }
            }
        }
    }

    impl Machines for FakeMachines {
        fn running(&mut self) -> Result<Vec<String>, String> {
            // Read from Podman's own listing, as `acquire::running_machines` does.
            let listing = serde_json::Value::Array(
                self.0
                    .borrow()
                    .machines
                    .iter()
                    .map(|(name, machine)| {
                        serde_json::json!({
                            "Name": name,
                            "Default": true,
                            "Running": machine.running,
                            "Starting": false,
                            "VMType": "wsl",
                        })
                    })
                    .collect(),
            )
            .to_string();
            crate::acquire::running_in(&listing)
        }
        fn stop(&mut self, name: &str) -> Result<(), String> {
            self.0.borrow_mut().done.push(format!("stop {name}"));
            self.set(
                name,
                Machine {
                    running: false,
                    api: false,
                },
            );
            Ok(())
        }
        fn start(&mut self, name: &str) -> Result<(), String> {
            self.0.borrow_mut().done.push(format!("start {name}"));
            self.set(
                name,
                Machine {
                    running: true,
                    api: true,
                },
            );
            Ok(())
        }
        fn answers(&mut self, name: &str) -> Result<(), String> {
            self.0.borrow_mut().done.push(format!("answers {name}"));
            match self.machine(name) {
                Machine { running: false, .. } => Err(format!("{name} is stopped")),
                Machine { api: false, .. } => Err(format!(
                    "npipe:////./pipe/{name}: The system cannot find the file specified. (os error 2)"
                )),
                _ => Ok(()),
            }
        }
    }

    /// `update_podman_with` on `machines`, with an installer that says what the Windows one says
    /// and does what the MSI did; `fails` makes it stop with an error after that.
    fn update(
        machines: &FakeMachines,
        windows: bool,
        fails: bool,
    ) -> (Result<(), Problem>, Vec<StepLine>) {
        let mut said = Vec::new();
        let installer = machines.clone();
        let result = update_podman_with(
            &mut machines.clone(),
            windows,
            &mut |line| said.push(line),
            &mut |progress| {
                progress(podman_install_said("windows"));
                installer.installer_ran();
                if fails {
                    return Err(Problem::with(
                        "Installing the software OpenBot needs did not finish. Try again.",
                        "msiexec /i stopped with exit code 1603",
                    ));
                }
                Ok(())
            },
        );
        (result, said)
    }

    /// On Windows the person's own running machine is stopped before the MSI and started after
    /// it, so its API answers when the update is done. Only OpenBot's own machine used to be.
    #[test]
    fn a_persons_own_running_machine_survives_the_podman_update_with_its_api_answering() {
        let machines = FakeMachines::running_default();
        let (result, said) = update(&machines, true, false);
        result.unwrap();
        assert_eq!(
            machines.done(),
            [
                "stop podman-machine-default",
                "install",
                "answers podman-machine-default",
                "stop podman-machine-default",
                "start podman-machine-default",
            ]
        );
        assert_eq!(
            machines.machine("podman-machine-default"),
            Machine {
                running: true,
                api: true
            }
        );
        // The row says why, the whole time: what the installer says goes to the log.
        let why = "The Podman on this computer is too old for OpenBot, so OpenBot is updating it.";
        assert!(!said.is_empty());
        assert!(said.iter().all(|line| line.said == why), "{said:?}");
        assert!(said
            .iter()
            .any(|line| line.detail.as_deref() == Some("Installing Podman.")));
    }

    /// During an update the Mac's password prompt is said after why, short enough for the row:
    /// "...so OpenBot is updating it. Your Mac will ask for your password." The installer's own
    /// words go to the log, and the line stays one about the engine being updated.
    #[test]
    fn the_password_prompt_during_an_update_says_why_first_and_fits() {
        let line = while_updating(podman_install_said("macos"));
        assert_eq!(
            line.said,
            "The Podman on this computer is too old for OpenBot, so OpenBot is updating it. Your \
             Mac will ask for your password."
        );
        assert!(line.elsewhere && line.updating);
        assert_eq!(
            line.detail.as_deref(),
            Some("Installing Podman's package; macOS asks for the password.")
        );
        // A go-ahead the person gives in OpenBot's own window is said as it is.
        assert_eq!(while_updating(podman_declined()), podman_declined());
    }

    /// A machine the installer took the API from is stopped and started even when it was not
    /// stopped first: a Mac, where it is not, or a stop that failed.
    #[test]
    fn a_machine_whose_api_the_installer_took_is_stopped_and_started_after_it() {
        let machines = FakeMachines::running_default();
        let (result, _) = update(&machines, false, false);
        result.unwrap();
        assert_eq!(
            machines.done(),
            [
                "install",
                "answers podman-machine-default",
                "stop podman-machine-default",
                "start podman-machine-default",
            ]
        );
        assert!(machines.machine("podman-machine-default").api);
    }

    /// A stopped machine stays stopped: only what was running is started again.
    #[test]
    fn a_stopped_machine_is_left_stopped() {
        let machines = FakeMachines::running_default();
        machines.set(
            "podman-machine-default",
            Machine {
                running: false,
                api: false,
            },
        );
        let (result, _) = update(&machines, true, false);
        result.unwrap();
        assert_eq!(machines.done(), ["install"]);
    }

    /// An installer that failed still leaves the machine it stopped running again, and its failure
    /// is the one said.
    #[test]
    fn a_failed_update_still_starts_the_machine_it_stopped() {
        let machines = FakeMachines::running_default();
        let (result, _) = update(&machines, true, true);
        assert_eq!(
            result.unwrap_err().detail.as_deref(),
            Some("msiexec /i stopped with exit code 1603")
        );
        assert_eq!(
            machines.machine("podman-machine-default"),
            Machine {
                running: true,
                api: true
            }
        );
    }

    /// The live run's listing, read: `Running` decides, by name.
    #[test]
    fn the_running_machines_are_read_from_podmans_listing() {
        let listing = r#"[
            {"Name": "openbot-s1", "Default": true, "Running": false, "Starting": false, "VMType": "applehv"},
            {"Name": "podman-machine-default", "Default": false, "Running": true, "Starting": false, "VMType": "wsl"},
            {"Name": "openbot", "Default": false, "Running": true, "Starting": false, "VMType": "wsl"}
        ]"#;
        assert_eq!(
            crate::acquire::running_in(listing).unwrap(),
            ["podman-machine-default", "openbot"]
        );
        assert!(crate::acquire::running_in("not json").is_err());
    }
}
