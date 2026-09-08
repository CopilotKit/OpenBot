//! The container engine: find one, install one, and prove it answers.
//!
//! Everything here was learned by running the stack on all three platforms rather than from the
//! documentation, and the three differ more than they look:
//!
//! - **macOS.** `podman machine` puts a Linux VM behind a socket. Inside that VM
//!   `/var/run/docker.sock` is already a symlink to the rootless socket, so Compose's mount needs no
//!   help and `ENGINE_SOCKET` stays unset. `applehv` is the default on Apple silicon as of Podman
//!   6.1, so no `--provider` is passed.
//! - **Linux.** Podman is native and rootless and there is no VM. `/var/run/docker.sock` is either
//!   absent or, with `podman-docker` installed, a symlink to the *rootful* socket, which is not the
//!   one running. `ENGINE_SOCKET` has to name `$XDG_RUNTIME_DIR/podman/podman.sock` or the
//!   supervisor is handed a dead socket and reports that it cannot reach Docker.
//! - **Windows.** `podman machine` again, on WSL2, and the same in-VM symlink as macOS. WSL refuses
//!   to run as LocalSystem, so none of this can be done from a service; see `windows.rs`.
//!
//! A second rule was learned the same way: **never assume the engine is on this process's PATH.**
//! When OpenBot installs Podman itself, the installer extends the *user's* PATH, and this process
//! was started with the old one. `podman` then cannot be run for the rest of the session, so the
//! app reports no engine while `podman.exe` sits on disk where it was just put. Every engine
//! command is therefore built from a resolved path, and the Compose provider OpenBot placed is put
//! on the child's PATH. See `install.rs`.
//!
//! One rule cuts across all three: **never address Podman through its ambient default connection.**
//! `podman` sends every command to whichever machine is marked default, and that machine belongs to
//! whoever made it. A person with a stopped machine of their own gets `Cannot connect to Podman`
//! from a machine of ours that is running perfectly well, which reads as our bug and is unfixable
//! from the error. So the engine is carried as an `Address` and every invocation names its
//! connection. Docker has one daemon and needs none of this.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use crate::quiet::command;

use serde::{Deserialize, Serialize};

/// Which engine is in use, because the answer changes what is mounted and what is reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Engine {
    /// Docker Desktop, OrbStack, Colima, or a Docker daemon by any other name.
    Docker,
    Podman,
}

impl Engine {
    pub fn binary(self) -> &'static str {
        match self {
            Engine::Docker => "docker",
            Engine::Podman => "podman",
        }
    }
}

/// How to talk to the engine: which binary, and which connection when the default is not ours.
///
/// `--connection` and not `DOCKER_HOST`: Podman ignores `DOCKER_HOST` when choosing its own
/// connection, and the flag is the only form that also reaches the Compose provider, which is where
/// most of the work happens.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Address {
    pub engine: Engine,
    /// A Podman machine by name. `None` means the default connection is already the right one.
    pub connection: Option<String>,
}

impl Address {
    pub fn new(engine: Engine, connection: Option<String>) -> Self {
        Self { engine, connection }
    }

    /// The binary and the arguments that name this engine, and the one place that decides them.
    ///
    /// Split out because not every caller can use a `std::process::Command`: the plan sign-in runs
    /// under a pty and has to build the pty crate's own command type. Both go through here, so a
    /// machine addressed by name cannot be addressed by name on one path and not the other.
    ///
    /// The binary is a resolved path rather than a name, for the PATH reason at the top of this
    /// file. The pty path needs that as much as this one: a sign-in that cannot find `podman` is
    /// the same failure wearing a terminal.
    pub fn parts(&self) -> (PathBuf, Vec<String>) {
        let mut arguments = Vec::new();
        if let Some(connection) = &self.connection {
            arguments.push("--connection".to_string());
            arguments.push(connection.clone());
        }
        (
            program(self.engine).unwrap_or_else(|| PathBuf::from(self.engine.binary())),
            arguments,
        )
    }

    /// A command aimed at this engine, and the only way one should be built.
    ///
    /// The provider directory goes in front of the child's PATH rather than into `containers.conf`,
    /// because that file belongs to whoever else may have configured it.
    pub fn command(&self) -> Command {
        let (binary, arguments) = self.parts();
        let mut command = command(binary);
        command.args(arguments);
        if let Some(dir) = tools_dir() {
            command.env("PATH", path_with(dir));
        }
        command
    }

    /// Whether Compose can actually run through this engine.
    ///
    /// Podman ships no compose implementation. `podman compose` looks for an external provider on
    /// PATH and, finding none, answers with seven errors naming `docker-compose`, which is a
    /// baffling thing to read on a machine where Docker was deliberately not installed. Docker
    /// Desktop puts a provider on PATH, which is why this went unnoticed until the stack was
    /// started on a Linux machine that had only Podman.
    pub fn composes(&self) -> bool {
        self.command()
            .args(["compose", "version"])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }

    /// Answering now, not merely installed. A binary that prints help proves nothing.
    pub fn responds(&self) -> bool {
        self.command()
            .args(["version", "--format", "{{.Server.APIVersion}}"])
            .output()
            .map(|out| out.status.success() && !out.stdout.is_empty())
            .unwrap_or(false)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EngineStatus {
    pub engine: Option<Engine>,
    /// How to reach it, carried so no later call has to guess again.
    pub address: Option<Address>,
    /// Answering now, not merely installed. A binary on PATH proves nothing.
    pub responding: bool,
    /// What Compose should mount as the engine socket, when the default is wrong.
    pub engine_socket: Option<String>,
    /// Present so a person can be told what was wrong rather than that something was.
    pub detail: String,
}

/// A Podman machine that is running now, preferred over starting a second one.
///
/// Somebody who already has a machine up is handed it rather than made to wait while a duplicate
/// boots beside it. Ours is preferred among running machines only so that repeat launches settle on
/// the same one.
fn running_machine(preferred: &str) -> Option<String> {
    let output = tool(Engine::Podman)
        .args(["machine", "list", "--format", "json"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let machines: Vec<MachineListing> = serde_json::from_slice(&output.stdout).ok()?;
    let running = || machines.iter().filter(|machine| machine.running);
    running()
        .find(|machine| machine.name == preferred)
        .or_else(|| running().next())
        .map(|machine| machine.name.clone())
}

#[derive(Deserialize)]
struct MachineListing {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Running")]
    running: bool,
}

/// Where OpenBot keeps the engine tools it installed itself.
///
/// Set once, at start-up, because the app knows its own cache directory and this module is called
/// from places that do not. Unset in tests and in any caller that never installed anything, which
/// is why every read tolerates its absence.
static TOOLS: OnceLock<PathBuf> = OnceLock::new();

/// Tell this module where the tools OpenBot installed live.
pub fn tools_live_in(dir: PathBuf) {
    let _ = TOOLS.set(dir);
}

/// The directory holding OpenBot's own copy of the Compose provider, under a download directory.
pub fn tools_dir_under(downloads: &Path) -> PathBuf {
    downloads.join("bin")
}

fn tools_dir() -> Option<&'static PathBuf> {
    TOOLS.get()
}

/// A command that runs this engine's binary, wherever it actually is.
pub fn tool(engine: Engine) -> Command {
    let mut built = command(program(engine).unwrap_or_else(|| PathBuf::from(engine.binary())));
    if let Some(dir) = tools_dir() {
        built.env("PATH", path_with(dir));
    }
    built
}

/// This process's PATH with `first` in front of it.
///
/// In front, so the provider OpenBot placed is the one found; appended, a broken `docker-compose`
/// earlier on PATH would still win.
fn path_with(first: &Path) -> OsString {
    let mut joined = OsString::from(first);
    if let Some(existing) = std::env::var_os("PATH") {
        if !existing.is_empty() {
            joined.push(if cfg!(windows) { ";" } else { ":" });
            joined.push(existing);
        }
    }
    joined
}

/// Where this engine's binary is, looking on PATH first and then where installers put it.
///
/// PATH first, because somebody who installed it themselves may have put it anywhere and that
/// choice is theirs. The fixed places are the fallback for the session in which OpenBot installed
/// it, when this process's PATH is the one it started with.
pub fn program(engine: Engine) -> Option<PathBuf> {
    on_path(engine.binary()).or_else(|| where_installers_put(engine))
}

/// A PATH lookup done by looking, rather than by starting the program to see whether it runs.
///
/// `command(...).output()` would answer this too, and is what this replaced. It also spawns a
/// process every time a command is built, and commands are built inside polling loops.
fn on_path(binary: &str) -> Option<PathBuf> {
    let filename = if cfg!(windows) {
        format!("{binary}.exe")
    } else {
        binary.to_string()
    };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(&filename))
        .find(|candidate| candidate.is_file())
}

/// The fixed places each platform's installers use.
fn where_installers_put(engine: Engine) -> Option<PathBuf> {
    let places: Vec<PathBuf> = match engine {
        #[cfg(target_os = "windows")]
        Engine::Podman => {
            // The per-user MSI first: it is the one OpenBot runs. A machine-wide install left by
            // somebody else is still found by the second.
            [
                std::env::var_os("LOCALAPPDATA")
                    .map(|local| PathBuf::from(local).join("Programs\\Podman\\podman.exe")),
                std::env::var_os("ProgramFiles")
                    .map(|files| PathBuf::from(files).join("RedHat\\Podman\\podman.exe")),
            ]
            .into_iter()
            .flatten()
            .collect()
        }
        #[cfg(target_os = "windows")]
        Engine::Docker => std::env::var_os("ProgramFiles")
            .map(|files| PathBuf::from(files).join("Docker\\Docker\\resources\\bin\\docker.exe"))
            .into_iter()
            .collect(),
        #[cfg(target_os = "macos")]
        Engine::Podman => [
            "/opt/podman/bin/podman",
            "/opt/homebrew/bin/podman",
            "/usr/local/bin/podman",
        ]
        .iter()
        .map(PathBuf::from)
        .collect(),
        #[cfg(target_os = "macos")]
        Engine::Docker => [
            "/usr/local/bin/docker",
            "/opt/homebrew/bin/docker",
            "/Applications/Docker.app/Contents/Resources/bin/docker",
        ]
        .iter()
        .map(PathBuf::from)
        .collect(),
        #[cfg(target_os = "linux")]
        Engine::Podman => ["/usr/bin/podman", "/usr/local/bin/podman"]
            .iter()
            .map(PathBuf::from)
            .collect(),
        #[cfg(target_os = "linux")]
        Engine::Docker => ["/usr/bin/docker", "/usr/local/bin/docker"]
            .iter()
            .map(PathBuf::from)
            .collect(),
    };
    places.into_iter().find(|candidate| candidate.is_file())
}

/// The rootless socket on Linux, which is the one Compose must mount.
///
/// Returned as a path rather than assumed, because `$XDG_RUNTIME_DIR` is not always `/run/user/$UID`
/// and a wrong guess here is the failure that looks like a network fault.
#[cfg(target_os = "linux")]
pub fn rootless_socket() -> Option<PathBuf> {
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            let uid = unsafe { libc::getuid() };
            Some(PathBuf::from(format!("/run/user/{uid}")))
        })?;
    let socket = runtime_dir.join("podman/podman.sock");
    socket.exists().then_some(socket)
}

#[cfg(not(target_os = "linux"))]
pub fn rootless_socket() -> Option<PathBuf> {
    // macOS and Windows run the engine in a virtual machine, and inside it `/var/run/docker.sock`
    // is already the rootless socket. Compose mounts that path, so there is nothing to override.
    None
}

/// What is here, before anything is installed.
pub fn detect() -> EngineStatus {
    for engine in [Engine::Docker, Engine::Podman] {
        let address = Address::new(engine, None);
        if address.responds() {
            return answering(address);
        }
    }

    // Podman's default connection can name a machine that is not running while another one is. That
    // is not "no engine", and creating a second machine in answer to it is the wrong repair.
    if let Some(machine) = running_machine(crate::acquire::MACHINE) {
        let address = Address::new(Engine::Podman, Some(machine));
        if address.responds() {
            return answering(address);
        }
    }

    for engine in [Engine::Docker, Engine::Podman] {
        if program(engine).is_some() {
            return EngineStatus {
                engine: Some(engine),
                address: None,
                responding: false,
                engine_socket: None,
                detail: format!(
                    "{} is installed but not answering. Start it and try again.",
                    engine.binary()
                ),
            };
        }
    }

    EngineStatus {
        engine: None,
        address: None,
        responding: false,
        engine_socket: None,
        // Not an instruction any more: OpenBot installs one. See `install.rs`.
        detail: "No container engine yet.".into(),
    }
}

fn answering(address: Address) -> EngineStatus {
    let engine = address.engine;
    let detail = match &address.connection {
        Some(machine) => format!("{} is answering on {machine}.", engine.binary()),
        None => format!("{} is answering.", engine.binary()),
    };
    EngineStatus {
        engine: Some(engine),
        engine_socket: socket_override(engine),
        address: Some(address),
        responding: true,
        detail,
    }
}

/// The socket Compose should mount, or `None` when the default is already right.
///
/// Only rootless Podman on Linux needs this. Docker owns `/var/run/docker.sock` outright, and a
/// Podman machine supplies the same path inside its VM.
fn socket_override(engine: Engine) -> Option<String> {
    match engine {
        Engine::Docker => None,
        Engine::Podman => rootless_socket().map(|path| path.to_string_lossy().into_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docker_never_overrides_the_socket_because_it_owns_the_default_path() {
        assert_eq!(socket_override(Engine::Docker), None);
    }

    #[test]
    fn a_missing_engine_is_reported_as_missing_rather_than_as_not_responding() {
        // Not a call to `detect`: this asserts the shape a caller has to distinguish. "Installed but
        // not answering" tells somebody to start it; "none found" tells them to install one, and
        // the wrong one of those sends them looking for a menu bar icon that is not there.
        let missing = EngineStatus {
            engine: None,
            address: None,
            responding: false,
            engine_socket: None,
            detail: "No container engine found. Install Podman Desktop or Docker Desktop first."
                .into(),
        };
        assert!(missing.engine.is_none());
        assert!(!missing.responding);
    }

    #[test]
    fn a_podman_machine_is_named_on_every_command_it_is_addressed_with() {
        let address = Address::new(Engine::Podman, Some("openbot".into()));
        let command = address.command();
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy())
            .collect();
        assert_eq!(args, ["--connection", "openbot"]);
    }

    #[test]
    fn docker_is_addressed_with_no_connection_because_it_has_one_daemon() {
        let command = Address::new(Engine::Docker, None).command();
        assert_eq!(command.get_args().count(), 0);
    }

    /// The program is a path, not a name. This is the fix for an engine OpenBot has just installed
    /// but this process's PATH does not know about, and asserting it here is the only place it is
    /// visible without a machine that has no engine on it.
    #[test]
    fn an_engine_command_names_a_binary_rather_than_hoping_for_one_on_path() {
        let (named, _) = Address::new(Engine::Podman, None).parts();
        let named = named.to_string_lossy().into_owned();
        assert_eq!(
            named != "podman",
            program(Engine::Podman).is_some(),
            "addressed {named}, which does not match whether one was found"
        );
        assert!(
            named.ends_with("podman") || named.ends_with("podman.exe"),
            "{named}"
        );
    }

    /// A name that is nowhere still produces a runnable command, which is what keeps the "no engine
    /// yet" screen reachable rather than a panic.
    #[test]
    fn a_binary_that_is_nowhere_is_absent_rather_than_guessed_at() {
        assert_eq!(on_path("openbot-not-a-real-binary"), None);
    }

    /// The provider directory has to be in *front* of PATH: a broken `docker-compose` earlier on
    /// somebody's PATH would otherwise be the one Podman runs.
    #[test]
    fn the_provider_directory_goes_in_front_of_the_inherited_path() {
        let ours = Path::new("/tmp/openbot-tools");
        let joined = path_with(ours);
        let text = joined.to_string_lossy();
        assert!(text.starts_with("/tmp/openbot-tools"), "{text}");
        if let Some(existing) = std::env::var_os("PATH") {
            assert!(text.ends_with(&*existing.to_string_lossy()), "{text}");
        }
    }

    /// The tools live under the downloads they came from, so one install of the app has one place
    /// for both and a retry finds what it already fetched.
    #[test]
    fn the_tools_live_under_the_downloads_they_came_from() {
        let downloads = Path::new("/tmp/openbot-engine");
        assert_eq!(tools_dir_under(downloads), downloads.join("bin"));
    }

    #[test]
    fn an_answering_engine_says_which_machine_answered() {
        let status = answering(Address::new(Engine::Podman, Some("openbot".into())));
        assert!(status.responding);
        assert!(status.detail.contains("openbot"), "{}", status.detail);
        assert_eq!(
            status.address.unwrap().connection.as_deref(),
            Some("openbot")
        );
    }
}
