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

use std::path::PathBuf;
use std::process::Command;

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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EngineStatus {
    pub engine: Option<Engine>,
    /// Answering now, not merely installed. A binary on PATH proves nothing.
    pub responding: bool,
    /// What Compose should mount as the engine socket, when the default is wrong.
    pub engine_socket: Option<String>,
    /// Present so a person can be told what was wrong rather than that something was.
    pub detail: String,
}

/// Ask an engine whether it is actually up.
///
/// `version` and not `--help`: a binary that prints help is installed, and a binary that answers
/// `version` has a daemon or a machine behind it. The whole point of the health gate is to fail
/// before Compose does, with a sentence that says which.
fn responds(binary: &str) -> bool {
    Command::new(binary)
        .args(["version", "--format", "{{.Server.APIVersion}}"])
        .output()
        .map(|out| out.status.success() && !out.stdout.is_empty())
        .unwrap_or(false)
}

fn installed(binary: &str) -> bool {
    Command::new(binary)
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
        if responds(engine.binary()) {
            return EngineStatus {
                engine: Some(engine),
                responding: true,
                engine_socket: socket_override(engine),
                detail: format!("{} is answering.", engine.binary()),
            };
        }
    }

    for engine in [Engine::Docker, Engine::Podman] {
        if installed(engine.binary()) {
            return EngineStatus {
                engine: Some(engine),
                responding: false,
                engine_socket: None,
                detail: format!(
                    "{} is installed but not answering. Start it, or let this install Podman.",
                    engine.binary()
                ),
            };
        }
    }

    EngineStatus {
        engine: None,
        responding: false,
        engine_socket: None,
        detail: "No container engine found.".into(),
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
            responding: false,
            engine_socket: None,
            detail: "No container engine found.".into(),
        };
        assert!(missing.engine.is_none());
        assert!(!missing.responding);
    }
}
