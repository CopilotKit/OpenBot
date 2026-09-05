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
const SERVICES: [&str; 5] = [
    "postgres",
    "supervisor",
    "agent-computer",
    "agent-bot",
    "agent-langgraph",
];

/// The three that are not containers, in the order they are started.
///
/// The server first, because the app serves a page that talks to it and the worker claims routines
/// it owns. Nothing here waits on the others: each is supervised on its own and reports its own
/// state, so a worker that dies does not take the window with it.
pub const HOST_PROCESSES: [HostProcess; 3] = [
    HostProcess {
        name: "server",
        cwd: "server",
        script: "src/index.ts",
    },
    HostProcess {
        name: "app",
        cwd: "app",
        script: "",
    },
    HostProcess {
        name: "worker",
        cwd: "worker",
        script: "src/index.ts",
    },
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
    // No `--no-build` here: `compose run` does not take it, and passing it fails on the flag rather
    // than on anything to do with migrations. Building is prevented the other way, by
    // `IMAGE_PULL_POLICY=missing` in the environment, which makes the service pull instead.
    let output = compose_command(engine, root)
        .args(["run", "--rm", "migrate"])
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

/// Install the deployment's dependencies.
///
/// The three host processes are `bun` processes run from the source, so the source alone is not
/// enough: without this the server stops at `ENOENT while resolving package 'zod'` and the app at
/// `vite: command not found`, and neither says the word `node_modules`. Run after a fetch and
/// skipped when the directory is already there, because it takes minutes.
pub fn install_dependencies(root: &Path, bun: &Path) -> Result<(), String> {
    if root.join("node_modules").exists() {
        return Ok(());
    }
    let output = Command::new(bun)
        .current_dir(root)
        .args(["install", "--frozen-lockfile"])
        .output()
        .map_err(|error| format!("could not run bun install: {error}"))?;

    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "installing the deployment's dependencies failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
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
    command
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .stdin(Stdio::null());
    command.spawn()
}

/// Wait until the API answers, or say why it never did.
///
/// Spawning is not starting. Each of these three can exit in the first second for a reason that has
/// nothing to do with the others, and a shell that reports "running" because it called `spawn`
/// three times is telling somebody the stack is up while nothing is listening. That is worse than
/// an error, because the next thing they do is open a page that will not load and go looking for
/// the fault in the wrong place.
///
/// So: watch the child, and watch the port. Whichever fails first is what gets reported, with the
/// tail of the log that explains it.
pub fn wait_until_answering(
    children: &mut [(&'static str, std::process::Child)],
    logs: &Path,
    port: u16,
    patience: std::time::Duration,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + patience;
    let health = format!("http://127.0.0.1:{port}/api/capabilities");

    while std::time::Instant::now() < deadline {
        for (name, child) in children.iter_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!(
                    "{name} stopped straight away ({status}). {}",
                    tail_of(logs, name)
                ));
            }
        }

        if reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .ok()
            .and_then(|client| client.get(&health).send().ok())
            .map(|response| response.status().is_success())
            .unwrap_or(false)
        {
            return Ok(());
        }

        std::thread::sleep(std::time::Duration::from_millis(750));
    }

    Err(format!(
        "the API never answered on port {port}. {}",
        tail_of(logs, "server")
    ))
}

/// The last few lines of a process's log, which is where the reason is.
fn tail_of(logs: &Path, name: &str) -> String {
    let Ok(text) = std::fs::read_to_string(logs.join(format!("{name}.log"))) else {
        return format!("Nothing was written to {name}.log.");
    };
    let tail: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .rev()
        .take(3)
        .collect();
    if tail.is_empty() {
        return format!("{name}.log is empty.");
    }
    let mut lines = tail;
    lines.reverse();
    format!("Last from {name}.log: {}", lines.join(" / "))
}

/// What a directory has to contain before it can be raised.
///
/// Checked and named rather than discovered by failing: without this the first symptom is
/// `os error 2` from writing `.env`, which says nothing about a missing deployment, and the second
/// is Compose reporting no configuration file. Both are the same fact and neither says it.
pub fn deployment_problem(root: &Path) -> Option<String> {
    if !root.exists() {
        return Some(format!(
            "{} does not exist yet. OpenBot needs a copy of the deployment there before it can \
             start one.",
            root.display()
        ));
    }
    if !root.join("docker-compose.yml").exists() {
        return Some(format!(
            "{} is not an OpenBot deployment: it has no docker-compose.yml.",
            root.display()
        ));
    }
    for directory in ["server", "app", "worker"] {
        if !root.join(directory).exists() {
            return Some(format!(
                "{} is missing its {directory} directory, so that process cannot be started.",
                root.display()
            ));
        }
    }
    None
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
    fn a_missing_root_is_named_rather_than_left_to_errno() {
        let missing = std::env::temp_dir().join("openbot-not-here-at-all");
        let problem = deployment_problem(&missing).expect("a missing root is a problem");
        assert!(problem.contains("does not exist"), "{problem}");
        assert!(!problem.contains("os error"), "leaked an errno: {problem}");
    }

    #[test]
    fn a_directory_that_is_not_a_deployment_says_which_part_is_missing() {
        let dir = std::env::temp_dir().join(format!("openbot-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let problem = deployment_problem(&dir).expect("an empty directory is not a deployment");
        assert!(problem.contains("docker-compose.yml"), "{problem}");

        std::fs::write(dir.join("docker-compose.yml"), "services: {}\n").unwrap();
        let problem = deployment_problem(&dir).expect("still missing the three processes");
        assert!(problem.contains("server"), "{problem}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_complete_deployment_has_no_problem() {
        let dir = std::env::temp_dir().join(format!("openbot-complete-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("docker-compose.yml"), "services: {}\n").unwrap();
        for directory in ["server", "app", "worker"] {
            std::fs::create_dir_all(dir.join(directory)).unwrap();
        }
        assert!(deployment_problem(&dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

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
        let server = HOST_PROCESSES
            .iter()
            .position(|p| p.name == "server")
            .unwrap();
        let app = HOST_PROCESSES.iter().position(|p| p.name == "app").unwrap();
        assert!(server < app);
    }
}
