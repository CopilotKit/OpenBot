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

use crate::engine::Address;

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

fn compose_command(engine: &Address, root: &Path) -> Command {
    let mut command = engine.command();
    command.current_dir(root).args(["compose"]);
    command
}

/// Raise the containers.
///
/// `--no-build` is the point of the whole published-images job: a desktop install has no toolchain,
/// and without it Compose quietly starts compiling Chromium. Failing loudly on a missing image is
/// the better answer, because it names a pull that did not happen.
pub fn up(engine: &Address, root: &Path) -> Result<(), String> {
    let output = compose_command(engine, root)
        .args(["up", "-d", "--no-build"])
        .args(SERVICES)
        .output()
        .map_err(|error| format!("could not run {} compose: {error}", engine.engine.binary()))?;

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
pub fn migrate(engine: &Address, root: &Path) -> Result<(), String> {
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

/// The label the supervisor stamps on every container it creates.
///
/// Matching on this rather than on a name prefix. `openbot-` is also the prefix of a kind cluster's
/// nodes and of anything else somebody has called openbot, and stopping a person's Kubernetes
/// cluster because it shares six letters with this one would be unforgivable.
const SUPERVISOR_LABEL: &str = "openbot.supervisor=true";

/// Stop the computers the supervisor made, which Compose does not know about.
///
/// A Bot's computer is created at runtime, not declared in `docker-compose.yml`, so `compose down`
/// leaves it running: an idle Ubuntu container per Bot, with the application gone and nothing on
/// screen to stop it from. Stopped rather than removed, because the supervisor starts an existing
/// owned container back up and the Bot keeps the profile and workspace volumes attached to it.
pub fn stop_computers(engine: &Address) -> Result<(), String> {
    let listed = engine
        .command()
        .args(["ps", "--quiet", "--filter", SUPERVISOR_LABEL])
        .output()
        .map_err(|error| format!("could not list the Bots' computers: {error}"))?;
    if !listed.status.success() {
        return Err(String::from_utf8_lossy(&listed.stderr).trim().to_string());
    }

    let running: Vec<String> = String::from_utf8_lossy(&listed.stdout)
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if running.is_empty() {
        return Ok(());
    }

    let stopped = engine
        .command()
        .arg("stop")
        .args(&running)
        .output()
        .map_err(|error| format!("could not stop the Bots' computers: {error}"))?;
    if stopped.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&stopped.stderr).trim().to_string())
}

pub fn down(engine: &Address, root: &Path) -> Result<(), String> {
    // Before Compose, because the supervisor is what would otherwise start another one while this
    // is happening.
    stop_computers(engine)?;

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

/// Stop the host processes belonging to a deployment, whoever started them.
///
/// Handles are not enough. A window opened a second time recognises a stack that is still up but
/// holds nothing to stop it with, so a Stop button that only kills its own children is a button
/// that does nothing and says it worked.
///
/// Found by their working directory, not their command line: all three run as
/// `bun … src/index.ts`, and the only thing that says which deployment they belong to is where they
/// are running. That is also how this session's own orphans hid twice.
#[cfg(unix)]
pub fn stop_processes_under(root: &Path) -> usize {
    let Ok(listing) = Command::new("/bin/ps").args(["-ax", "-o", "pid="]).output() else {
        return 0;
    };

    let mut stopped = 0;
    for pid in String::from_utf8_lossy(&listing.stdout)
        .split_whitespace()
        .filter_map(|pid| pid.parse::<i32>().ok())
    {
        let Ok(cwd) = Command::new("/usr/sbin/lsof")
            .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
            .output()
        else {
            continue;
        };
        let cwd = String::from_utf8_lossy(&cwd.stdout);
        let Some(dir) = cwd.lines().find_map(|line| line.strip_prefix('n')) else {
            continue;
        };
        if !Path::new(dir).starts_with(root) {
            continue;
        }
        // Asked first; the caller waits before it insists.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        stopped += 1;
    }
    stopped
}

#[cfg(not(unix))]
pub fn stop_processes_under(_root: &Path) -> usize {
    // Windows has no cheap equivalent of asking by working directory. The children this window
    // started are stopped by their handles; a stack left by an earlier window is stopped by
    // Compose, and its host processes end with the session.
    0
}

/// Which Compose services are not running, and the last thing each said.
///
/// `compose up` succeeds once it has asked for everything; a service that then exits is not its
/// problem. Both Bots exit immediately without a model key, saying exactly that, and without this
/// the window reports a healthy stack while nothing can answer a question.
pub fn services_that_exited(engine: &Address, root: &Path) -> Vec<(String, String)> {
    let Ok(output) = compose_command(engine, root)
        .args(["ps", "-a", "--format", "{{.Service}}\t{{.State}}"])
        .output()
    else {
        return Vec::new();
    };

    let mut dead = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Some((service, state)) = line.split_once('\t') else {
            continue;
        };
        if !state.trim().eq_ignore_ascii_case("exited") {
            continue;
        }
        // `migrate` is meant to exit: it is run to completion, not raised.
        if service.trim() == "migrate" {
            continue;
        }
        let why = compose_command(engine, root)
            .args(["logs", "--tail", "3", service.trim()])
            .output()
            .ok()
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .unwrap_or_default();
        let why = why
            .lines()
            .rfind(|line| !line.trim().is_empty())
            .unwrap_or("no reason in its log")
            .trim()
            .to_string();
        dead.push((service.trim().to_string(), why));
    }
    dead
}

/// Refuse to start if something already holds a port this deployment needs.
///
/// Found the hard way: another deployment was listening on 3001, so the readiness check below was
/// satisfied by a server this shell had never started. Everything looked green and none of it was
/// ours. Checked before anything is spawned, because afterwards the two are indistinguishable from
/// outside.
pub fn port_already_taken(ports: &[(&'static str, u16)]) -> Option<String> {
    for (name, port) in ports {
        if std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], *port)),
            std::time::Duration::from_millis(300),
        )
        .is_ok()
        {
            return Some(format!(
                "Something is already listening on port {port}, which OpenBot uses for the {name}. \
                 Stop it, or change the port, and start again."
            ));
        }
    }
    None
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
/// The two things that have to answer before anybody is told the stack is up.
///
/// The API alone is not enough. The window navigates to the app, so a person told "running" who
/// then gets a blank window has been told something that is not true, and the API was answering the
/// whole time.
pub struct Ready {
    pub api: u16,
    pub app: u16,
}

/// Both loopbacks, in the order a person is most likely to type.
///
/// A process that binds one and not the other is normal rather than broken: Node resolves
/// `localhost` to `::1` and bun to `127.0.0.1`, so which one a service ends up on depends on what
/// started it. Asking both is how a check stays true either way.
const LOOPBACKS: [&str; 2] = ["127.0.0.1", "[::1]"];

/// Where a port is answering, or `None`.
///
/// Returns the address that worked rather than a boolean, so a caller that has to send somebody
/// there can use the one that answered instead of guessing again.
pub fn answering_at(port: u16, path: &str) -> Option<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()?;
    LOOPBACKS.iter().find_map(|host| {
        let base = format!("http://{host}:{port}");
        client
            .get(format!("{base}{path}"))
            .send()
            .ok()
            .filter(|response| response.status().is_success())
            .map(|_| base)
    })
}

/// Where the app is answering, for the window to be pointed at.
pub fn app_url(port: u16) -> Option<String> {
    answering_at(port, "/")
}

/// Wait until the stack is genuinely usable, or say which part is not.
///
/// Watches the children as well as the ports, because three processes that died leave a port
/// unanswered for the same length of time as three that are still starting, and only one of those
/// is worth waiting out.
pub fn wait_until_answering(
    children: &mut [(&'static str, std::process::Child)],
    logs: &Path,
    ready: &Ready,
    patience: std::time::Duration,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + patience;
    let mut api_up = false;

    while std::time::Instant::now() < deadline {
        for (name, child) in children.iter_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!(
                    "{name} stopped straight away ({status}). {}",
                    tail_of(logs, name)
                ));
            }
        }

        api_up = api_up || answering_at(ready.api, "/api/capabilities").is_some();
        if api_up && app_url(ready.app).is_some() {
            return Ok(());
        }

        std::thread::sleep(std::time::Duration::from_millis(750));
    }

    if api_up {
        return Err(format!(
            "the API is answering, but the app never did on port {}. {}",
            ready.app,
            tail_of(logs, "app")
        ));
    }
    Err(format!(
        "the API never answered on port {}. {}",
        ready.api,
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
    fn a_port_nobody_holds_is_not_reported_as_taken() {
        // 0 is never listening; this asserts the check does not invent a problem.
        assert!(port_already_taken(&[("nothing", 1)]).is_none());
    }

    #[test]
    fn a_held_port_is_named_along_with_what_uses_it() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let problem =
            port_already_taken(&[("API server", port)]).expect("a held port is a problem");
        assert!(problem.contains(&port.to_string()), "{problem}");
        assert!(
            problem.contains("API server"),
            "must say what it is for: {problem}"
        );
    }

    #[test]
    fn migrate_is_not_raised_as_a_service() {
        // Raised alongside the others it exits immediately, and Compose reports a service that will
        // not stay up. It is run to completion instead, by `migrate`.
        assert!(!SERVICES.contains(&"migrate"));
    }

    #[test]
    fn the_bots_computers_are_found_by_label_rather_than_by_a_name_that_starts_with_openbot() {
        assert!(SUPERVISOR_LABEL.starts_with("openbot.supervisor="));
        assert!(
            !SUPERVISOR_LABEL.contains("name"),
            "a kind cluster's nodes are also called openbot-something"
        );
    }

    #[test]
    fn readiness_asks_both_loopbacks_because_a_runtime_picks_one() {
        assert!(LOOPBACKS.contains(&"127.0.0.1"));
        assert!(
            LOOPBACKS.contains(&"[::1]"),
            "an IPv6-only bind still counts as answering"
        );
    }

    #[test]
    fn nothing_is_answering_on_a_port_nothing_is_listening_on() {
        // Port 1 needs privilege to bind, so this asks about a port that cannot quietly be
        // somebody else's server.
        assert_eq!(answering_at(1, "/"), None);
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
