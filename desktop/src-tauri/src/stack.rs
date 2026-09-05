//! Raising the stack: the Compose services, then the three processes that are not containers.
//!
//! `docker-compose.yml` has no `app`, `server` or `worker` service, and the root `Dockerfile` leaves
//! out the supervisor because it needs a socket no serverless platform grants. So the shape is not a
//! choice: containers for postgres, the supervisor, `agent-computer`, the Bots and a one-shot
//! `migrate`, and three host processes for the rest. `scripts/start.sh` does exactly this for a
//! developer. This does it for somebody who double-clicked.
//!
//! The shell also becomes the restart policy those three do not have. `worker/src/index.ts` names
//! the gap itself: "this process has no restart policy watching it; it is somebody's laptop, left
//! running".

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::engine::Engine;

/// The services Compose owns. `migrate` is deliberately absent: it is run once, to completion,
/// rather than raised, and treating it as a long-lived service makes it look like a crash loop.
const SERVICES: [&str; 5] = ["postgres", "supervisor", "agent-computer", "agent-bot", "agent-langgraph"];

/// The three that are not containers, in the order they are started.
///
/// The server first, because the app serves a page that talks to it and the worker claims routines
/// it owns. Nothing here waits on the others: each is supervised on its own and reports its own
/// state, so a worker that dies does not take the window with it.
pub const HOST_PROCESSES: [HostProcess; 3] = [
    HostProcess { name: "server", cwd: "server", script: "src/index.ts" },
    HostProcess { name: "app", cwd: "app", script: "" },
    HostProcess { name: "worker", cwd: "worker", script: "src/index.ts" },
];

#[derive(Clone, Copy, Debug)]
pub struct HostProcess {
    pub name: &'static str,
    pub cwd: &'static str,
    /// Empty means the package's own `dev` script rather than a file, which is how the app is run.
    pub script: &'static str,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    EngineMissing,
    Starting,
    Migrating,
    WaitingForServices,
    Running,
    Stopped,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StackStatus {
    pub phase: Phase,
    pub detail: String,
}

fn compose_command(engine: Engine, root: &Path) -> Command {
    let mut command = Command::new(engine.binary());
    command.current_dir(root).args(["compose"]);
    command
}

/// Raise the containers.
///
/// `--no-build` is the point of the whole published-images job: a desktop install has no toolchain,
/// and without it Compose quietly starts compiling Chromium. Failing loudly on a missing image is
/// the better answer, because it names a pull that did not happen.
pub fn up(engine: Engine, root: &Path) -> Result<(), String> {
    let output = compose_command(engine, root)
        .args(["up", "-d", "--no-build"])
        .args(SERVICES)
        .output()
        .map_err(|error| format!("could not run {} compose: {error}", engine.binary()))?;

    if output.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

/// Apply migrations, once, to completion.
///
/// A release step rather than a start step, for the reason `server/Dockerfile` gives: two replicas
/// starting together would race, and a failed migration should stop the start rather than leave a
/// half-migrated database serving.
pub fn migrate(engine: Engine, root: &Path) -> Result<(), String> {
    let output = compose_command(engine, root)
        .args(["run", "--rm", "--no-build", "migrate"])
        .output()
        .map_err(|error| format!("could not run migrations: {error}"))?;

    if output.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

pub fn down(engine: Engine, root: &Path) -> Result<(), String> {
    let output = compose_command(engine, root)
        .args(["down"])
        .output()
        .map_err(|error| format!("could not stop the stack: {error}"))?;

    if output.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

/// Start one host process, with its output on disk rather than nowhere.
///
/// A window has no console to inherit, so a process whose output is dropped fails invisibly: the
/// symptom is a port that never answers and a log directory that explains why.
pub fn spawn_host_process(
    process: &HostProcess,
    root: &Path,
    logs: &Path,
    bun: &Path,
) -> std::io::Result<std::process::Child> {
    std::fs::create_dir_all(logs)?;
    let out = std::fs::File::create(logs.join(format!("{}.log", process.name)))?;
    let err = out.try_clone()?;

    let mut command = Command::new(bun);
    command.current_dir(root.join(process.cwd));
    if process.script.is_empty() {
        command.args(["run", "dev"]);
    } else {
        command.args(["--env-file=../.env", process.script]);
    }
    command.stdout(Stdio::from(out)).stderr(Stdio::from(err)).stdin(Stdio::null());
    command.spawn()
}

/// Where the shell keeps the deployment it manages.
pub fn default_root() -> PathBuf {
    dirs_home().join("OpenBot")
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_is_not_raised_as_a_service() {
        // Raised alongside the others it exits immediately, and Compose reports a service that will
        // not stay up. It is run to completion instead, by `migrate`.
        assert!(!SERVICES.contains(&"migrate"));
    }

    #[test]
    fn the_three_host_processes_are_the_three_that_are_not_containers() {
        let names: Vec<_> = HOST_PROCESSES.iter().map(|p| p.name).collect();
        assert_eq!(names, vec!["server", "app", "worker"]);
    }

    #[test]
    fn the_server_starts_before_the_app_that_talks_to_it() {
        let server = HOST_PROCESSES.iter().position(|p| p.name == "server").unwrap();
        let app = HOST_PROCESSES.iter().position(|p| p.name == "app").unwrap();
        assert!(server < app);
    }
}
