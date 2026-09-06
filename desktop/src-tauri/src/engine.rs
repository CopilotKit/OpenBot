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
//! One rule cuts across all three: **never address Podman through its ambient default connection.**
//! `podman` sends every command to whichever machine is marked default, and that machine belongs to
//! whoever made it. A person with a stopped machine of their own gets `Cannot connect to Podman`
//! from a machine of ours that is running perfectly well, which reads as our bug and is unfixable
//! from the error. So the engine is carried as an `Address` and every invocation names its
//! connection. Docker has one daemon and needs none of this.

use std::path::PathBuf;
use std::process::Command;

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

    /// A command aimed at this engine, and the only way one should be built.
    pub fn command(&self) -> Command {
        let mut command = command(self.engine.binary());
        if let Some(connection) = &self.connection {
            command.args(["--connection", connection]);
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
    let output = command("podman")
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

fn installed(binary: &str) -> bool {
    command(binary)
        .arg("--version")
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
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
        if installed(engine.binary()) {
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
        detail: "No container engine found. Install Podman Desktop or Docker Desktop first.".into(),
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
    fn docker_is_addressed_bare_because_it_has_one_daemon_and_no_connections() {
        let command = Address::new(Engine::Docker, None).command();
        assert_eq!(command.get_args().count(), 0);
        assert_eq!(command.get_program(), "docker");
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
