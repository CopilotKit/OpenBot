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

use crate::quiet::{command, said as command_said};

use serde::{Deserialize, Serialize};

use crate::engine::Address;

/// The services Compose owns. `migrate` is deliberately absent: it is run once, to completion,
/// rather than raised, and treating it as a long-lived service makes it look like a crash loop.
const SERVICES: [&str; 3] = ["postgres", "supervisor", "agent-computer"];

/**
The Bots that ship with OpenBot, which only run on an API key.

BOTH REFUSE TO START WITHOUT ONE, saying so themselves: "OPENAI_API_KEY is not set. This Bot cannot
answer without a model." That is correct of them and wrong of us to ignore. Somebody who signs in
with the ChatGPT or Claude subscription they already pay for has no key by design, so raising these
gave them two containers that died on startup and two red lines on the setup screen, about Bots they
never chose.

Started when a key exists and left alone when it does not. The Bot the person actually picked speaks
its plan and answers either way, which is what the last screen proves.
*/
const BOTS_NEEDING_A_KEY: [&str; 2] = ["agent-bot", "agent-langgraph"];

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
        package_script: "",
    },
    // `serve`, not `dev`. The dev server sets NODE_ENV to development, and the SDK reads that to
    // decide whether to draw its developer inspector, so a desktop install opened its first window
    // on CopilotKit's "What's New" panel covering OpenBot entirely. An installed application should
    // not be running a development server at all: this builds once and serves the build.
    HostProcess {
        name: "app",
        cwd: "app",
        script: "",
        package_script: APP_SCRIPT,
    },
    HostProcess {
        name: "worker",
        cwd: "worker",
        script: "src/index.ts",
        package_script: "",
    },
];

#[derive(Clone, Copy, Debug)]
/// One of the three processes Compose does not run.
///
/// The app is started through the package's own `dev` script, which runs Vite through bun rather
/// than through its shebang. `node_modules/.bin/vite` begins `#!/usr/bin/env node`, so a machine
/// with bun and no Node starts the app, fails with `node: command not found`, and is restarted
/// five more times before this gives up on it. Which is what happened on the Linux machine this
/// was tested on, and would happen to anybody who installed OpenBot without also having Node.
pub struct HostProcess {
    pub name: &'static str,
    pub cwd: &'static str,
    /// Empty means a package script rather than a file, which is how the app is run.
    pub script: &'static str,
    /// The package script to run when `script` is empty.
    pub package_script: &'static str,
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

/**
The credentials a deployment needs, handed to a child process rather than left in its `.env`.

THIS IS WHY THE FILE CAN STOP HOLDING THEM. Compose resolves `${VAR}` from its own environment
before it reads `.env`, so a secret passed here reaches exactly the containers that declare it and
is written down nowhere. The host processes take theirs the same way, alongside the `--env-file`
that still carries the settings.

A `BTreeMap` rather than the vault directly: reading a credential store once per run and passing
what it gave is one prompt and one failure point, where reading it per command is neither.
*/
pub type Secrets = std::collections::BTreeMap<String, String>;

fn compose_command(engine: &Address, root: &Path, secrets: &Secrets) -> Command {
    let mut command = engine.command();
    command.current_dir(root).args(["compose"]).envs(secrets);
    command
}

/// Raise the containers.
///
/// `--no-build` is the point of the whole published-images job: a desktop install has no toolchain,
/// and without it Compose quietly starts compiling Chromium. Failing loudly on a missing image is
/// the better answer, because it names a pull that did not happen.
pub fn up(
    engine: &Address,
    root: &Path,
    harness: bool,
    // Whether the model screen produced a key. Without one the bundled Bots cannot start, and
    // starting them to fail is worse than not starting them: see `BOTS_NEEDING_A_KEY`.
    a_key_exists: bool,
    secrets: &Secrets,
) -> Result<(), crate::problem::Problem> {
    /*
     * The picked harness rides in on its profile.
     *
     * `agent-harness` is profile-gated so a deployment that picked nothing does not try to start
     * it: its image comes from `.env`, and unset that is a request to pull the empty string, which
     * fails the whole `up` rather than the one service nobody asked for. The flag comes before
     * `up`, because `--profile` is an option of `compose` itself and not of the subcommand.
     */
    let mut command = compose_command(engine, root, secrets);
    if harness {
        command.args(["--profile", "harness"]);
    }
    let output = command
        .args(["up", "-d", "--no-build"])
        .args(SERVICES)
        .args(if a_key_exists {
            &BOTS_NEEDING_A_KEY[..]
        } else {
            &[][..]
        })
        .args(if harness {
            &["agent-harness"][..]
        } else {
            &[][..]
        })
        .output()
        .map_err(|error| format!("could not run {} compose: {error}", engine.engine.binary()))?;

    if output.status.success() {
        return Ok(());
    }
    // Both registers: the sentence is chosen from what the engine said, and what it said is kept
    // beside it rather than shown as the headline. See `problem.rs`.
    let raw = command_said(&output.stderr);
    Err(crate::problem::Problem::with(
        crate::problem::said_about(&raw),
        raw,
    ))
}

/// Apply migrations, once, to completion.
///
/// A release step rather than a start step, for the reason `server/Dockerfile` gives: two replicas
/// starting together would race, and a failed migration should stop the start rather than leave a
/// half-migrated database serving.
pub fn migrate(
    engine: &Address,
    root: &Path,
    secrets: &Secrets,
) -> Result<(), crate::problem::Problem> {
    // No `--no-build` here: `compose run` does not take it, and passing it fails on the flag rather
    // than on anything to do with migrations. Building is prevented the other way, by
    // `IMAGE_PULL_POLICY=missing` in the environment, which makes the service pull instead.
    let output = compose_command(engine, root, secrets)
        .args(["run", "--rm", "migrate"])
        .output()
        .map_err(|error| format!("could not run migrations: {error}"))?;

    if output.status.success() {
        return Ok(());
    }
    // Both registers: the sentence is chosen from what the engine said, and what it said is kept
    // beside it rather than shown as the headline. See `problem.rs`.
    let raw = command_said(&output.stderr);
    Err(crate::problem::Problem::with(
        crate::problem::said_about(&raw),
        raw,
    ))
}

/// The label the supervisor stamps on every container it creates.
///
/// Matching on this rather than on a name prefix. `openbot-` is also the prefix of a kind cluster's
/// nodes and of anything else somebody has called openbot, and stopping a person's Kubernetes
/// cluster because it shares six letters with this one would be unforgivable.
/// Written as the whole filter, `label=` and all. Handed to the engine without that prefix it
/// answers `invalid filter`, and it does so at the moment somebody is being told their stack has
/// stopped, so the prefix belongs with the label rather than at the call site.
const SUPERVISOR_FILTER: &str = "label=openbot.supervisor=true";

/// Stop the computers the supervisor made, which Compose does not know about.
///
/// A Bot's computer is created at runtime, not declared in `docker-compose.yml`, so `compose down`
/// leaves it running: an idle Ubuntu container per Bot, with the application gone and nothing on
/// screen to stop it from. Stopped rather than removed, because the supervisor starts an existing
/// owned container back up and the Bot keeps the profile and workspace volumes attached to it.
pub fn stop_computers(engine: &Address) -> Result<(), String> {
    let listed = engine
        .command()
        .args(["ps", "--quiet", "--filter", SUPERVISOR_FILTER])
        .output()
        .map_err(|error| format!("could not list the Bots' computers: {error}"))?;
    if !listed.status.success() {
        return Err(command_said(&listed.stderr));
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
    Err(command_said(&stopped.stderr))
}

pub fn down(engine: &Address, root: &Path) -> Result<(), String> {
    // Before Compose, because the supervisor is what would otherwise start another one while this
    // is happening.
    stop_computers(engine)?;

    /*
     * WITH THE PROFILE, OR THE PICKED BOT KEEPS RUNNING.
     *
     * Measured: after pressing Stop, `compose ps` still listed `agent-harness`. Compose only acts
     * on a profiled service when the profile is named, so Stop was leaving the one container the
     * person actually chose running on their laptop, still holding its port. The next Start then
     * refused because something was listening on it.
     *
     * Named unconditionally rather than only when a harness was picked: this has to stop what an
     * earlier run started, and whether that run picked one is not something a Stop can know.
     */
    let output = compose_command(engine, root, &Secrets::new())
        .args(["--profile", "harness", "down"])
        .output()
        .map_err(|error| format!("could not stop the stack: {error}"))?;

    if output.status.success() {
        return Ok(());
    }
    Err(command_said(&output.stderr))
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
    // `--ignore-scripts`, for two reasons that point the same way.
    //
    // A postinstall script is arbitrary code from somebody else's package, and an installer that
    // runs it on a person's machine while they watch a progress bar is doing something they did not
    // ask for. And they are not all portable: `@scarf/scarf` shells out to `node`, which a machine
    // that has bun need not have, so the install fails at "node: command not found" after the
    // containers are already up. Found on a Linux machine with bun and no node.
    let output = command(bun)
        .current_dir(root)
        .args(["install", "--frozen-lockfile", "--ignore-scripts"])
        .output()
        .map_err(|error| format!("could not run bun install: {error}"))?;

    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "installing the deployment's dependencies failed: {}",
        command_said(&output.stderr)
    ))
}

/// Start one host process, with its output on disk rather than nowhere.
///
/// A window has no console to inherit, so a process whose output is dropped fails invisibly: the
/// symptom is a port that never answers and a log directory that explains why.
/// Where the pids of the host processes are written, so a later window can stop them.
///
/// The handles a window holds die with the window. Everything else about a running stack survives
/// it: the containers are Compose's, and the three host processes just keep going. Without this,
/// Stop from a restarted window had nothing to work with.
pub fn host_pids_path(root: &Path) -> PathBuf {
    root.join(".logs").join("host-pids.json")
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordedHostProcess {
    pub name: String,
    pub pid: u32,
    pub executable_path: String,
    pub command_line: String,
    pub creation_date: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RecordedHostPidFile {
    Records {
        version: u8,
        processes: Vec<RecordedHostProcess>,
    },
    Pids(Vec<u32>),
}

/// Record the pids of the processes this window started.
pub fn record_host_pids(root: &Path, pids: &[u32]) {
    let path = host_pids_path(root);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(
        &path,
        serde_json::to_vec(pids).unwrap_or_else(|_| b"[]".to_vec()),
    );
}

/// Record the host processes this window started.
pub fn record_host_processes(root: &Path, processes: &[(&str, u32)]) {
    #[cfg(windows)]
    {
        let snapshot = windows_processes();
        let records: Vec<RecordedHostProcess> = processes
            .iter()
            .filter_map(|(name, pid)| {
                let live = snapshot.iter().find(|process| process.process_id == *pid)?;
                RecordedHostProcess::from_live(name, live)
            })
            .collect();
        write_host_pid_file(
            root,
            &serde_json::json!({ "version": 1, "processes": records }),
        );
    }
    #[cfg(not(windows))]
    {
        record_host_pids(
            root,
            &processes.iter().map(|(_, pid)| *pid).collect::<Vec<_>>(),
        );
    }
}

/// The pids a previous window recorded, if any.
pub fn recorded_host_pids(root: &Path) -> Vec<u32> {
    match recorded_host_pid_file(root) {
        Some(RecordedHostPidFile::Records {
            version: 1,
            processes,
        }) => processes.into_iter().map(|process| process.pid).collect(),
        Some(RecordedHostPidFile::Pids(pids)) => pids,
        _ => Vec::new(),
    }
}

/// The recorded host processes with enough identity to verify a live Windows process.
pub fn recorded_host_processes(root: &Path) -> Vec<RecordedHostProcess> {
    match recorded_host_pid_file(root) {
        Some(RecordedHostPidFile::Records {
            version: 1,
            processes,
        }) => processes,
        _ => Vec::new(),
    }
}

fn recorded_host_pid_file(root: &Path) -> Option<RecordedHostPidFile> {
    std::fs::read(host_pids_path(root))
        .ok()
        .and_then(|raw| serde_json::from_slice::<RecordedHostPidFile>(&raw).ok())
}

#[cfg_attr(not(windows), allow(dead_code))]
fn write_host_pid_file<T: Serialize>(root: &Path, value: &T) {
    let path = host_pids_path(root);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(
        &path,
        serde_json::to_vec(value).unwrap_or_else(|_| b"[]".to_vec()),
    );
}

pub fn spawn_host_process(
    process: &HostProcess,
    root: &Path,
    logs: &Path,
    bun: &Path,
    secrets: &Secrets,
) -> std::io::Result<std::process::Child> {
    std::fs::create_dir_all(logs)?;
    let out = std::fs::File::create(logs.join(format!("{}.log", process.name)))?;
    let err = out.try_clone()?;

    let mut command = command(bun);
    command.current_dir(root.join(process.cwd));
    /*
     * The credentials, alongside the `--env-file` that carries the settings.
     *
     * They are not in that file any more, and this is where they rejoin. The environment wins over
     * the file either way, so a machine still holding an older run's copy is overridden rather than
     * fought with.
     */
    command.envs(secrets);
    if process.script.is_empty() {
        command.args(["run", process.package_script]);
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
    // One call, not one per process. Asking lsof about every pid in turn is what makes Stop look
    // like a hang: a busy machine has several hundred processes, each invocation costs a fork and a
    // few hundred milliseconds, and the person watching has been given no reason to think anything
    // is happening. `-d cwd` over all processes is a single pass.
    let Ok(listing) = command("/usr/sbin/lsof")
        .args(["-d", "cwd", "-Fpn"])
        .output()
    else {
        return 0;
    };

    let mut stopped = 0;
    let mut pid = None;
    // -F output is one field per line: `p<pid>` starts a process, `n<path>` gives its directory.
    for line in String::from_utf8_lossy(&listing.stdout).lines() {
        if let Some(found) = line.strip_prefix('p') {
            pid = found.parse::<i32>().ok();
            continue;
        }
        let Some(dir) = line.strip_prefix('n') else {
            continue;
        };
        let Some(found) = pid else {
            continue;
        };
        if !Path::new(dir).starts_with(root) {
            continue;
        }
        // Asked first; the caller waits before it insists.
        unsafe {
            libc::kill(found, libc::SIGTERM);
        }
        stopped += 1;
    }
    stopped
}

#[cfg(not(unix))]
pub fn stop_processes_under(_root: &Path) -> usize {
    /*
     * Windows cannot be asked which process is in which directory cheaply, so this used to answer
     * 0 and say the host processes end with the session. They do not, and the case it dismissed is
     * the common one: the handles this window holds are gone the moment the window is restarted,
     * so a window Stopping a stack an earlier one started holds nothing at all.
     *
     * MEASURED ON WINDOWS SERVER 2022. Stop took the five containers down, reported success, and
     * left every host process running: the server on 3001, the worker, and both halves of the app
     * still answering 200 on 3010. Somebody who pressed Stop still had OpenBot serving.
     *
     * So they are found by the ports the deployment publishes, which the shell already owns and
     * already checks for clashes, and each is ended WITH ITS CHILDREN: `bun run serve` starts the
     * real server as a grandchild, so ending only the process holding the port leaves that behind.
     */
    let mut stopped_recorded = 0;
    /*
     * The pids this window or an earlier one recorded, which is the only way to reach the worker.
     *
     * It listens on no port, so the sweep below cannot see it, and its command line is identical to
     * the server's: both are `bun --env-file=../.env src/index.ts`, differing only by working
     * directory, which Windows will not tell you cheaply. Measured: after the port sweep alone,
     * 3001 and 3010 were free and the worker was still running.
     */
    let recorded = recorded_host_processes(_root);
    let processes = windows_processes();
    let roots = verified_openbot_root_pids(&recorded, &processes);
    for pid in &roots {
        let ended = command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
        if ended {
            stopped_recorded += 1;
        }
    }
    let _ = std::fs::remove_file(host_pids_path(_root));

    let ports = crate::env::Ports::default();
    // And a sweep of the two host ports, for a stack whose pidfile is gone. The containers are
    // Compose's to stop, and killing whatever holds a container's published port would reach into
    // the engine's own plumbing.
    let ours = [ports.app, ports.server];
    let Ok(listing) = command("netstat").args(["-ano", "-p", "tcp"]).output() else {
        return stopped_recorded;
    };

    let listed = String::from_utf8_lossy(&listing.stdout);
    let mut stopped = stopped_recorded;
    for pid in verified_openbot_pids_listening_on(&listed, &ours, &recorded, &processes) {
        // With its children: `bun run serve` starts the real server as a grandchild, so ending
        // only the process holding the port leaves that one behind.
        let ended = command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
        if ended {
            stopped += 1;
        }
    }
    stopped
}

/// The processes listening on any of `ports`, from `netstat -ano` output.
///
/// Pure and tested, because the column layout is the thing that goes wrong. Read as four columns
/// rather than five, the foreign address is taken for the state and the state for the pid: nothing
/// matches, and Stop reports success while leaving everything running. That is exactly what
/// happened, and this test is why it did not survive.
pub fn pids_listening_on(listing: &str, ports: &[u16]) -> Vec<u32> {
    let mut found: Vec<u32> = Vec::new();
    for line in listing.lines() {
        // Protocol, local address, foreign address, state, pid.
        let mut fields = line.split_whitespace();
        let (Some(_proto), Some(local), Some(_foreign), Some(state), Some(pid)) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            continue;
        };
        if !state.eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        // `rsplit` rather than `split`, because an IPv6 local address is `[::1]:3010`.
        let Some(port) = local.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) else {
            continue;
        };
        if !ports.contains(&port) {
            continue;
        }
        let Ok(pid) = pid.parse::<u32>() else {
            continue;
        };
        // A port answers on both loopbacks, so one process appears on two lines.
        if !found.contains(&pid) {
            found.push(pid);
        }
    }
    found
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct WindowsProcess {
    pub process_id: u32,
    pub parent_process_id: u32,
    #[serde(default)]
    pub executable_path: Option<String>,
    #[serde(default)]
    pub command_line: Option<String>,
    #[serde(default)]
    pub creation_date: Option<String>,
}

impl RecordedHostProcess {
    #[cfg_attr(not(windows), allow(dead_code))]
    fn from_live(name: &str, live: &WindowsProcess) -> Option<Self> {
        Some(Self {
            name: name.to_string(),
            pid: live.process_id,
            executable_path: live.executable_path.clone()?,
            command_line: live.command_line.clone()?,
            creation_date: live.creation_date.clone()?,
        })
    }

    fn matches(&self, live: &WindowsProcess) -> bool {
        live.process_id == self.pid
            && live.executable_path.as_deref() == Some(self.executable_path.as_str())
            && live.command_line.as_deref() == Some(self.command_line.as_str())
            && live.creation_date.as_deref() == Some(self.creation_date.as_str())
    }
}

#[cfg(windows)]
fn windows_processes() -> Vec<WindowsProcess> {
    let Ok(output) = command("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate) | ConvertTo-Json -Compress",
        ])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    windows_processes_in(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(windows))]
#[allow(dead_code)]
fn windows_processes() -> Vec<WindowsProcess> {
    Vec::new()
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WindowsProcessListing {
    Many(Vec<WindowsProcess>),
    One(WindowsProcess),
}

pub fn windows_processes_in(listing: &str) -> Vec<WindowsProcess> {
    match serde_json::from_str::<WindowsProcessListing>(listing) {
        Ok(WindowsProcessListing::Many(processes)) => processes,
        Ok(WindowsProcessListing::One(process)) => vec![process],
        Err(_) => Vec::new(),
    }
}

/// Recorded OpenBot root processes whose live identity still matches the pid file.
pub fn verified_openbot_root_pids(
    recorded: &[RecordedHostProcess],
    processes: &[WindowsProcess],
) -> Vec<u32> {
    recorded
        .iter()
        .filter_map(|record| {
            let live = processes
                .iter()
                .find(|process| process.process_id == record.pid)?;
            record.matches(live).then_some(record.pid)
        })
        .collect()
}

/// Recorded OpenBot processes, or their live children, listening on one of the host ports.
///
/// A pid file entry is not ownership by itself: the live process must still match the recorded
/// executable, command line and creation time before its tree is eligible for cleanup.
pub fn verified_openbot_pids_listening_on(
    listing: &str,
    ports: &[u16],
    recorded: &[RecordedHostProcess],
    processes: &[WindowsProcess],
) -> Vec<u32> {
    let roots = verified_openbot_root_pids(recorded, processes);
    pids_listening_on(listing, ports)
        .into_iter()
        .filter(|pid| belongs_to_any_root(*pid, &roots, processes))
        .collect()
}

fn belongs_to_any_root(pid: u32, roots: &[u32], processes: &[WindowsProcess]) -> bool {
    if roots.contains(&pid) {
        return true;
    }

    let mut seen = std::collections::HashSet::new();
    let mut current = pid;
    loop {
        if !seen.insert(current) {
            return false;
        }
        let Some(process) = processes
            .iter()
            .find(|process| process.process_id == current)
        else {
            return false;
        };
        let parent = process.parent_process_id;
        if roots.contains(&parent) {
            return true;
        }
        if parent == 0 || parent == current {
            return false;
        }
        current = parent;
    }
}

/**
The tail of one service's log.

For the case where the wire says nothing. A framework that catches its own exception and ends the
stream leaves the cause here and nowhere else, so this is not a debugging convenience: without it
the developer half of that failure would be empty. See `ask::why_nothing_came_back`.

An engine that cannot be asked returns nothing rather than failing. This is only ever called to
explain a failure that has already happened, and a second failure on top of it helps nobody.
*/
pub fn service_log(engine: &Address, root: &Path, service: &str, lines: u16) -> String {
    compose_command(engine, root, &Secrets::new())
        .args(["logs", "--tail", &lines.to_string(), service])
        .output()
        .ok()
        .map(|out| {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            text.trim().to_string()
        })
        .unwrap_or_default()
}

/// Which Compose services are not running, and the last thing each said.
///
/// `compose up` succeeds once it has asked for everything; a service that then exits is not its
/// problem. Both Bots exit immediately without a model key, saying exactly that, and without this
/// the window reports a healthy stack while nothing can answer a question.
pub fn services_that_exited(
    engine: &Address,
    root: &Path,
) -> Result<Vec<(String, String)>, crate::problem::Problem> {
    let operation = format!("{} compose ps -a", engine.engine.binary());
    let output = compose_command(engine, root, &Secrets::new())
        .args(["ps", "-a", "--format", "{{.Service}}\t{{.State}}"])
        .output()
        .map_err(|error| {
            crate::problem::Problem::with(
                "OpenBot could not inspect its Compose services.",
                format!("could not run {operation}: {error}"),
            )
        })?;

    if !output.status.success() {
        let stderr = command_said(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let mut detail = format!("{operation} exited with status {}", output.status);
        if !stderr.is_empty() {
            detail.push_str("\nstderr:\n");
            detail.push_str(&stderr);
        }
        if !stdout.is_empty() {
            detail.push_str("\nstdout:\n");
            detail.push_str(&stdout);
        }
        return Err(crate::problem::Problem::with(
            "OpenBot could not inspect its Compose services.",
            detail,
        ));
    }

    let mut dead = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Some((service, state)) = line.split_once('\t') else {
            return Err(crate::problem::Problem::with(
                "OpenBot could not inspect its Compose services.",
                format!("unusable {operation} row: {line}"),
            ));
        };
        let service = service.trim();
        let state = state.trim();
        if service.is_empty() || state.is_empty() {
            return Err(crate::problem::Problem::with(
                "OpenBot could not inspect its Compose services.",
                format!("unusable {operation} row: {line}"),
            ));
        }
        if !state.trim().eq_ignore_ascii_case("exited") {
            continue;
        }
        // `migrate` is meant to exit: it is run to completion, not raised.
        if service == "migrate" {
            continue;
        }
        let why = compose_command(engine, root, &Secrets::new())
            .args(["logs", "--tail", "3", service])
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
        dead.push((service.to_string(), why));
    }
    Ok(dead)
}

/**
The ports this deployment's own containers already publish.

MEASURED, AND IT LEAVES A PERSON STUCK. A start that fails after `compose up` leaves the containers
it raised running, so the next press of Start finds the harness port held and refuses with
"something is already listening on port 4206, which OpenBot uses for the Bot you picked" — about a
container OpenBot itself started, which the person never saw and cannot find. There is no way
forward from that screen.

Our own containers are not a conflict: `compose up` is idempotent and reuses them. The check exists
to catch somebody ELSE on the port, so what this deployment already publishes is excluded from it.

An engine that cannot be asked returns nothing, which leaves the check exactly as strict as it was.
*/
pub fn ports_we_already_publish(engine: &Address, root: &Path) -> std::collections::HashSet<u16> {
    let Ok(output) = compose_command(engine, root, &Secrets::new())
        .args(["ps", "--format", "{{.Ports}}"])
        .output()
    else {
        return std::collections::HashSet::new();
    };
    let listing = String::from_utf8_lossy(&output.stdout);
    published_in(&listing)
}

/**
The published ports in a `compose ps` listing.

Pure, because the format is the contract and a regex over engine output is exactly the thing that
should be pinned by a test. A row reads `127.0.0.1:4206->4206/tcp, [::1]:4206->4206/tcp`, and it is
the number BEFORE the arrow that is taken: the one after it is the port inside the container, which
nothing on this machine binds.
*/
pub fn published_in(listing: &str) -> std::collections::HashSet<u16> {
    let mut ports = std::collections::HashSet::new();
    for mapping in listing.split(',') {
        let Some((host, _)) = mapping.split_once("->") else {
            continue;
        };
        let Some((_, port)) = host.trim().rsplit_once(':') else {
            continue;
        };
        if let Ok(port) = port.trim().parse::<u16>() {
            ports.insert(port);
        }
    }
    ports
}

/**
Wait for ports we just released to actually be free.

A KILL IS NOT INSTANT AND THE CHECK IS. Reclaiming this deployment's own host processes and then
immediately asking whether their ports are held is a race, and it loses: the socket is still closing
while the check reads it as somebody else's. Measured as "something is already listening on port
3010" naming a process that no longer existed by the time anybody looked.

Bounded, and only worth calling when something was actually stopped. A port a stranger holds stays
held, so this costs the wait once and then reports it.
*/
pub fn wait_for_ports_to_clear(ports: &[u16], patience: std::time::Duration) {
    let deadline = std::time::Instant::now() + patience;
    while std::time::Instant::now() < deadline {
        if ports.iter().all(|port| !something_answers(*port)) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

/// Whether anything accepts a connection on a loopback port right now.
fn something_answers(port: u16) -> bool {
    // A listener on either loopback can conflict, just as either can satisfy readiness below.
    [
        std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::net::SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)),
    ]
    .iter()
    .any(|address| {
        std::net::TcpStream::connect_timeout(address, std::time::Duration::from_millis(300)).is_ok()
    })
}

/// Refuse to start if something already holds a port this deployment needs.
///
/// Found the hard way: another deployment was listening on 3001, so the readiness check below was
/// satisfied by a server this shell had never started. Everything looked green and none of it was
/// ours. Checked before anything is spawned, because afterwards the two are indistinguishable from
/// outside.
pub fn port_already_taken(ports: &[(&'static str, u16)]) -> Option<String> {
    port_already_taken_except(ports, &std::collections::HashSet::new())
}

/// The same check, with the ports this deployment already publishes treated as its own.
pub fn port_already_taken_except(
    ports: &[(&'static str, u16)],
    ours: &std::collections::HashSet<u16>,
) -> Option<String> {
    for (name, port) in ports {
        if ours.contains(port) {
            continue;
        }
        if something_answers(*port) {
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
    missing_script(root)
}

/// Whether the deployment on disk is one this app knows how to start.
///
/// The shell and the deployment are versioned apart: the app is installed once and the deployment
/// is fetched at a tag. So an app can meet a deployment older than the scripts it calls, and the
/// symptom is the worst kind: every step passes, the app process exits 1 on "Script not found",
/// the supervisor restarts it five times, and the sentence a person is finally shown names a
/// process rather than the mismatch.
fn missing_script(root: &Path) -> Option<String> {
    let manifest = root.join("app").join("package.json");
    let Ok(text) = std::fs::read_to_string(&manifest) else {
        return Some(format!("{} cannot be read.", manifest.display()));
    };
    /*
     * An unreadable manifest and one without the script are different things.
     *
     * Read as one, a `package.json` that will not parse was reported as a deployment "older than
     * this version of OpenBot", which sent somebody looking for a newer installer over a file with
     * a byte-order mark in front of it. `serde_json` refuses a document that begins with one, and
     * plenty of Windows tooling writes one: `Set-Content -Encoding UTF8` does.
     */
    let manifest_json =
        match serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')) {
            Ok(json) => json,
            Err(error) => {
                return Some(format!(
                    "{} cannot be read as JSON: {error}. Something has rewritten it.",
                    manifest.display()
                ))
            }
        };
    if manifest_json
        .get("scripts")
        .and_then(|scripts| scripts.get(APP_SCRIPT))
        .is_some()
    {
        return None;
    }
    Some(format!(
        "The deployment in {} is older than this version of OpenBot: its app has no \"{APP_SCRIPT}\" \
         script, so there is no way to serve it. Install a newer OpenBot, or delete that directory \
         and start again to fetch a deployment that matches.",
        root.display()
    ))
}

/// The package script that serves the app. Named once, because two places must agree on it.
const APP_SCRIPT: &str = "serve";

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
    use crate::test_support::temp_root;

    fn ipv6_loopback_listener() -> Option<std::net::TcpListener> {
        match std::net::TcpListener::bind("[::1]:0") {
            Ok(listener) => Some(listener),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::AddrNotAvailable | std::io::ErrorKind::Unsupported
                ) =>
            {
                eprintln!("IPv6 loopback unavailable; skipping IPv6 socket regression: {error}");
                None
            }
            Err(error) => panic!("could not bind the IPv6 regression listener: {error}"),
        }
    }

    fn recorded_process(name: &str, pid: u32, creation_date: &str) -> RecordedHostProcess {
        RecordedHostProcess {
            name: name.to_string(),
            pid,
            executable_path: r"C:\Users\person\.bun\bin\bun.exe".to_string(),
            command_line: r#"bun --env-file=../.env src/index.ts"#.to_string(),
            creation_date: creation_date.to_string(),
        }
    }

    fn live_process(pid: u32, parent: u32, creation_date: &str) -> WindowsProcess {
        WindowsProcess {
            process_id: pid,
            parent_process_id: parent,
            executable_path: Some(r"C:\Users\person\.bun\bin\bun.exe".to_string()),
            command_line: Some(r#"bun --env-file=../.env src/index.ts"#.to_string()),
            creation_date: Some(creation_date.to_string()),
        }
    }

    struct PathFixture {
        previous: Option<std::ffi::OsString>,
        previous_record: Option<std::ffi::OsString>,
        previous_scenario: Option<std::ffi::OsString>,
        bin: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl PathFixture {
        fn with_fake_engine(scenario: &str) -> Self {
            Self::with_fake_engine_and_inherited_path(scenario, true)
        }

        fn with_broken_engine() -> Self {
            Self::with_fake_engine_and_inherited_path("spawn", false)
        }

        fn with_fake_engine_and_inherited_path(scenario: &str, inherit_path: bool) -> Self {
            static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let previous = std::env::var_os("PATH");
            let previous_record = std::env::var_os("OPENBOT_TEST_ENGINE_RECORD");
            let previous_scenario = std::env::var_os("OPENBOT_FAKE_ENGINE_SCENARIO");
            let bin = temp_root("openbot-stack-fake-engine-bin");
            std::fs::create_dir_all(&bin).unwrap();
            let docker = bin.join(if cfg!(windows) {
                "docker.exe"
            } else {
                "docker"
            });
            if scenario == "spawn" {
                std::fs::write(&docker, "not an executable").unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mut permissions = std::fs::metadata(&docker).unwrap().permissions();
                    permissions.set_mode(0o644);
                    std::fs::set_permissions(&docker, permissions).unwrap();
                }
            } else {
                let source = bin.join("fake_engine.rs");
                std::fs::write(&source, FAKE_ENGINE_SOURCE).unwrap();
                let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
                let output = Command::new(rustc)
                    .arg(&source)
                    .arg("-o")
                    .arg(&docker)
                    .output()
                    .expect("rustc should run for the fake engine");
                assert!(
                    output.status.success(),
                    "fake engine did not compile: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            let mut path = std::ffi::OsString::from(&bin);
            if inherit_path {
                if let Some(previous) = previous.as_ref().filter(|previous| !previous.is_empty()) {
                    path.push(if cfg!(windows) { ";" } else { ":" });
                    path.push(previous);
                }
            }
            if !inherit_path && cfg!(windows) {
                path.push(if cfg!(windows) { ";" } else { ":" });
                path.push(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()));
            }
            std::env::set_var("PATH", path);
            std::env::set_var("OPENBOT_FAKE_ENGINE_SCENARIO", scenario);
            Self {
                previous,
                previous_record,
                previous_scenario,
                bin,
                _guard: guard,
            }
        }
    }

    impl Drop for PathFixture {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                std::env::set_var("PATH", previous);
            } else {
                std::env::remove_var("PATH");
            }
            if let Some(previous) = &self.previous_record {
                std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", previous);
            } else {
                std::env::remove_var("OPENBOT_TEST_ENGINE_RECORD");
            }
            if let Some(previous) = &self.previous_scenario {
                std::env::set_var("OPENBOT_FAKE_ENGINE_SCENARIO", previous);
            } else {
                std::env::remove_var("OPENBOT_FAKE_ENGINE_SCENARIO");
            }
            std::fs::remove_dir_all(&self.bin).ok();
        }
    }

    const FAKE_ENGINE_SOURCE: &str = r#"
use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let joined = args.join(" ");
    if let Ok(path) = std::env::var("OPENBOT_TEST_ENGINE_RECORD") {
        let cwd = std::env::current_dir().unwrap();
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        writeln!(file, "{}\t{}", cwd.display(), joined).unwrap();
    }
    match (std::env::var("OPENBOT_FAKE_ENGINE_SCENARIO").unwrap().as_str(), joined.as_str()) {
        ("exit17", args) if args.starts_with("compose ps ") => {
            print!("agent-computer\tUp\n");
            eprint!("compose ps refused\n");
            std::process::exit(17);
        }
        ("empty", args) if args.starts_with("compose ps ") => {}
        ("blank-lines", args) if args.starts_with("compose ps ") => {
            print!("\n  \n\t\n");
        }
        ("empty-service", args) if args.starts_with("compose ps ") => {
            print!("\tExited\n");
        }
        ("empty-state", args) if args.starts_with("compose ps ") => {
            print!("agent-computer\t \n");
        }
        ("mixed", args) if args.starts_with("compose ps ") => {
            print!("agent-computer\tUp\nmigrate\tExited\nserver\tExited\n");
        }
        ("mixed", args) if args == "compose logs --tail 3 server" => {
            print!("line one\nlast reason\n");
        }
        _ => {
            eprintln!("unexpected: {joined}");
            std::process::exit(2);
        }
    }
}
"#;

    #[test]
    fn service_inspection_spawn_failure_is_a_problem() {
        let _fixture = PathFixture::with_broken_engine();
        let root = temp_root("openbot-service-inspection-spawn");
        std::fs::create_dir_all(&root).unwrap();

        let problem =
            services_that_exited(&Address::new(crate::engine::Engine::Docker, None), &root)
                .expect_err("a failed inspection command must stop startup");

        assert_eq!(
            problem.said,
            "OpenBot could not inspect its Compose services."
        );
        assert!(
            problem
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("could not run docker compose ps -a")),
            "{problem:?}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn service_inspection_nonzero_status_is_a_problem() {
        let _fixture = PathFixture::with_fake_engine("exit17");
        let root = temp_root("openbot-service-inspection-status");
        std::fs::create_dir_all(&root).unwrap();

        let problem =
            services_that_exited(&Address::new(crate::engine::Engine::Docker, None), &root)
                .expect_err("a nonzero inspection status must stop startup");

        assert_eq!(
            problem.said,
            "OpenBot could not inspect its Compose services."
        );
        let detail = problem.detail.as_deref().unwrap_or_default();
        assert!(
            detail.contains("docker compose ps -a exited with status"),
            "{detail}"
        );
        assert!(detail.contains("compose ps refused"), "{detail}");
        assert!(detail.contains("agent-computer\tUp"), "{detail}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn service_inspection_empty_success_is_healthy() {
        let _fixture = PathFixture::with_fake_engine("empty");
        let root = temp_root("openbot-service-inspection-empty");
        std::fs::create_dir_all(&root).unwrap();

        let dead = services_that_exited(&Address::new(crate::engine::Engine::Docker, None), &root)
            .expect("a successful empty listing is healthy");

        assert!(dead.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn service_inspection_blank_lines_are_healthy_empty_output() {
        let _fixture = PathFixture::with_fake_engine("blank-lines");
        let root = temp_root("openbot-service-inspection-blank-lines");
        std::fs::create_dir_all(&root).unwrap();

        let dead = services_that_exited(&Address::new(crate::engine::Engine::Docker, None), &root)
            .expect("blank service inspection output is empty health evidence");

        assert!(dead.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_service_inspection_rows_are_a_problem() {
        let root = temp_root("openbot-service-inspection-malformed");
        std::fs::create_dir_all(&root).unwrap();

        for scenario in ["empty-service", "empty-state"] {
            let _fixture = PathFixture::with_fake_engine(scenario);
            let problem =
                services_that_exited(&Address::new(crate::engine::Engine::Docker, None), &root)
                    .expect_err("a malformed nonempty row cannot prove health");

            assert_eq!(
                problem.said,
                "OpenBot could not inspect its Compose services."
            );
            assert!(
                problem
                    .detail
                    .as_deref()
                    .is_some_and(|detail| detail.contains("unusable docker compose ps -a row")),
                "{problem:?}"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn service_inspection_reports_only_unexpected_exited_services() {
        let _fixture = PathFixture::with_fake_engine("mixed");
        let root = temp_root("openbot-service-inspection-rows");
        std::fs::create_dir_all(&root).unwrap();

        let dead = services_that_exited(&Address::new(crate::engine::Engine::Docker, None), &root)
            .expect("service inspection should succeed");

        assert_eq!(
            dead,
            vec![("server".to_string(), "last reason".to_string())]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Real `netstat -ano` output, because the column layout is what went wrong.
    ///
    /// Stop reported success and left the server and the app serving, because this was read as four
    /// columns: the foreign address was taken for the state, the state for the pid, and nothing
    /// ever matched.
    #[test]
    #[cfg(not(unix))]
    fn the_processes_holding_our_ports_are_found_in_netstat_output() {
        let listing = "\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044\r\n  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       8748\r\n  TCP    127.0.0.1:3010         0.0.0.0:0              LISTENING       8636\r\n  TCP    127.0.0.1:3010         127.0.0.1:51888        ESTABLISHED     8636\r\n  TCP    [::1]:3010             [::]:0                 LISTENING       8636\r\n  TCP    127.0.0.1:5432         0.0.0.0:0              LISTENING       9999\r\n";
        let found = super::pids_listening_on(listing, &[3010, 3001]);
        // Both host processes, each once, and nothing else: not the established connection, not
        // Postgres on a published container port, not RPC on 135.
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found.contains(&8748), "{found:?}");
        assert!(found.contains(&8636), "{found:?}");
        assert!(
            !found.contains(&9999),
            "a container's port is not ours to kill: {found:?}"
        );
        assert!(!found.contains(&1044), "{found:?}");
    }

    #[test]
    fn only_recorded_openbot_pids_are_selected_from_netstat_output() {
        let listing = "\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       424242\r\n  TCP    127.0.0.1:3010         0.0.0.0:0              LISTENING       8636\r\n  TCP    [::1]:3010             [::]:0                 LISTENING       8636\r\n";
        let recorded = [recorded_process(
            "server",
            8636,
            "20260909010101.000000-420",
        )];
        let processes = [live_process(8636, 7000, "20260909010101.000000-420")];

        let found = super::verified_openbot_pids_listening_on(
            listing,
            &[3010, 3001],
            &recorded,
            &processes,
        );

        assert_eq!(found, vec![8636]);
    }

    #[test]
    fn a_reused_recorded_pid_is_not_selected_without_matching_identity() {
        let listing = "\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       424242\r\n";
        let recorded = [recorded_process(
            "server",
            424242,
            "20260909010101.000000-420",
        )];
        let processes = [live_process(424242, 7000, "20260909020202.000000-420")];

        let found =
            super::verified_openbot_pids_listening_on(listing, &[3001], &recorded, &processes);

        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn a_verified_recorded_host_keeps_its_listening_child_eligible_for_cleanup() {
        let listing = "\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    127.0.0.1:3010         0.0.0.0:0              LISTENING       9000\r\n";
        let recorded = [recorded_process("app", 8636, "20260909010101.000000-420")];
        let processes = [
            live_process(8636, 7000, "20260909010101.000000-420"),
            live_process(9000, 8636, "20260909010102.000000-420"),
        ];

        let roots = super::verified_openbot_root_pids(&recorded, &processes);
        let found =
            super::verified_openbot_pids_listening_on(listing, &[3010], &recorded, &processes);

        assert_eq!(roots, vec![8636]);
        assert_eq!(found, vec![9000]);
    }

    /// The pids survive the window that started them, which is the whole point of writing them.
    #[test]
    fn recorded_pids_are_read_back_and_a_missing_file_is_not_an_error() {
        let dir = temp_root("pids");
        std::fs::create_dir_all(&dir).unwrap();

        // Nothing recorded is an empty list, not a panic: a deployment somebody started by hand
        // has no pidfile at all.
        assert!(recorded_host_pids(&dir).is_empty());

        record_host_pids(&dir, &[4242, 4243, 4244]);
        assert_eq!(recorded_host_pids(&dir), vec![4242, 4243, 4244]);

        // And rubbish in the file reads as nothing rather than stopping Stop.
        std::fs::write(host_pids_path(&dir), "not json").unwrap();
        assert!(recorded_host_pids(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A manifest with a byte-order mark in front of it is still a manifest.
    ///
    /// Windows tooling writes one freely (`Set-Content -Encoding UTF8` does), `serde_json` refuses
    /// a document that begins with one, and the refusal was reported as a deployment older than
    /// this version of OpenBot. That sent somebody looking for a newer installer over three bytes.
    #[test]
    fn a_byte_order_mark_does_not_make_a_deployment_look_old() {
        let dir = temp_root("bom");
        let app = dir.join("app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(
            app.join("package.json"),
            "\u{feff}{\"scripts\":{\"serve\":\"bun serve.ts\"}}",
        )
        .unwrap();
        assert_eq!(missing_script(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// And a manifest that is genuinely broken says so, rather than blaming the version.
    #[test]
    fn an_unreadable_manifest_is_not_reported_as_an_old_deployment() {
        let dir = temp_root("broken");
        let app = dir.join("app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("package.json"), "{ this is not json").unwrap();
        let problem = missing_script(&dir).expect("a broken manifest is a problem");
        assert!(problem.contains("cannot be read as JSON"), "{problem}");
        assert!(!problem.contains("older than"), "{problem}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_root_is_named_rather_than_left_to_errno() {
        let missing = std::env::temp_dir().join("openbot-not-here-at-all");
        let problem = deployment_problem(&missing).expect("a missing root is a problem");
        assert!(problem.contains("does not exist"), "{problem}");
        assert!(!problem.contains("os error"), "leaked an errno: {problem}");
    }

    #[test]
    fn a_directory_that_is_not_a_deployment_says_which_part_is_missing() {
        let dir = temp_root("empty");
        std::fs::create_dir_all(&dir).unwrap();

        let problem = deployment_problem(&dir).expect("an empty directory is not a deployment");
        assert!(problem.contains("docker-compose.yml"), "{problem}");

        std::fs::write(dir.join("docker-compose.yml"), "services: {}\n").unwrap();
        let problem = deployment_problem(&dir).expect("still missing the three processes");
        assert!(problem.contains("server"), "{problem}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_deployment_older_than_this_app_is_named_as_that_rather_than_left_to_fail() {
        let dir = temp_root("old");
        for part in ["server", "app", "worker"] {
            std::fs::create_dir_all(dir.join(part)).unwrap();
        }
        std::fs::write(dir.join("docker-compose.yml"), "services: {}\n").unwrap();
        // What v0.0.7 shipped: a dev script and nothing to serve a build with.
        std::fs::write(
            dir.join("app").join("package.json"),
            r#"{"scripts":{"dev":"vite","build":"vite build"}}"#,
        )
        .unwrap();

        let problem = deployment_problem(&dir).expect("an older deployment is a problem");
        assert!(problem.contains(APP_SCRIPT), "{problem}");
        assert!(problem.to_lowercase().contains("older"), "{problem}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_complete_deployment_has_no_problem() {
        let dir = temp_root("complete");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("docker-compose.yml"), "services: {}\n").unwrap();
        for directory in ["server", "app", "worker"] {
            std::fs::create_dir_all(dir.join(directory)).unwrap();
        }
        std::fs::write(
            dir.join("app").join("package.json"),
            r#"{"scripts":{"serve":"vite preview"}}"#,
        )
        .unwrap();
        assert!(deployment_problem(&dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_port_nobody_holds_is_not_reported_as_taken() {
        // 0 is never listening; this asserts the check does not invent a problem.
        assert!(port_already_taken(&[("nothing", 1)]).is_none());
    }

    /// The published side of a mapping, which is the only side anything on this machine binds.
    /// A plan is not a key, and the Bots that need one are not raised to fail.
    #[test]
    fn the_bundled_bots_are_not_started_without_a_key() {
        // Both say it themselves in their own source; this is the shell agreeing rather than
        // starting them and reporting their refusal as a failure of the install.
        assert_eq!(BOTS_NEEDING_A_KEY.len(), 2);
        assert!(BOTS_NEEDING_A_KEY.contains(&"agent-bot"));
        assert!(BOTS_NEEDING_A_KEY.contains(&"agent-langgraph"));
        for bot in BOTS_NEEDING_A_KEY {
            assert!(
                !SERVICES.contains(&bot),
                "{bot} is started unconditionally as well"
            );
        }
    }

    /// Stop has to name the profile, or the one Bot the person picked keeps running.
    #[test]
    fn stopping_names_the_harness_profile() {
        let source = include_str!("stack.rs");
        assert!(
            source.contains(r#".args(["--profile", "harness", "down"])"#),
            "compose down without the profile leaves agent-harness running"
        );
    }

    #[test]
    fn the_published_ports_are_read_off_a_real_listing() {
        // Verbatim from `compose ps --format '{{.Ports}}'` against a running deployment.
        let listing = "127.0.0.1:4200->4200/tcp, [::1]:4200->4200/tcp\n\
                       127.0.0.1:4206->4206/tcp, [::1]:4206->4206/tcp\n\
                       127.0.0.1:5544->5432/tcp, [::1]:5544->5432/tcp\n";
        let found = published_in(listing);
        assert!(found.contains(&4200) && found.contains(&4206));
        // The published port, not the one inside the container: nothing on this machine binds 5432.
        assert!(found.contains(&5544), "the published side was missed");
        assert!(
            !found.contains(&5432),
            "the container's own port was taken as published"
        );
    }

    /// A service with no published ports says nothing rather than confusing the parser.
    #[test]
    fn a_listing_with_nothing_published_yields_nothing() {
        assert!(published_in("").is_empty());
        assert!(published_in("4206/tcp").is_empty());
    }

    /**
    A port this deployment already publishes is not a stranger on the port.

    The measured failure: a start that fell over after `compose up` left the harness container
    running, and the next attempt refused because of it, naming a port the person never chose.
    */
    #[test]
    fn our_own_published_port_is_not_a_conflict() {
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = held.local_addr().unwrap().port();
        assert!(port_already_taken(&[("Bot you picked", port)]).is_some());
        let ours = std::collections::HashSet::from([port]);
        assert_eq!(
            port_already_taken_except(&[("Bot you picked", port)], &ours),
            None,
            "a container this deployment started was treated as somebody else"
        );
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
    fn an_ipv6_only_port_is_named_unless_this_deployment_already_publishes_it() {
        let Some(listener) = ipv6_loopback_listener() else {
            return;
        };
        let port = listener.local_addr().unwrap().port();
        let ports = [("API server", port)];

        let problem = port_already_taken(&ports).expect("an IPv6-only listener is a conflict");
        assert!(problem.contains(&port.to_string()), "{problem}");
        assert!(problem.contains("API server"), "{problem}");
        assert_eq!(
            port_already_taken_except(&ports, &std::collections::HashSet::from([port])),
            None
        );

        drop(listener);
        wait_for_ports_to_clear(&[port], std::time::Duration::from_secs(3));
        assert_eq!(port_already_taken(&ports), None);
    }

    #[test]
    fn an_ipv6_only_port_is_not_clear_while_its_listener_is_held() {
        let Some(listener) = ipv6_loopback_listener() else {
            return;
        };
        let port = listener.local_addr().unwrap().port();
        let patience = std::time::Duration::from_millis(250);
        let started = std::time::Instant::now();

        wait_for_ports_to_clear(&[port], patience);

        assert!(
            started.elapsed() >= patience,
            "the wait returned while the IPv6 listener still held the port"
        );
        drop(listener);
        let started = std::time::Instant::now();
        let patience = std::time::Duration::from_secs(3);
        wait_for_ports_to_clear(&[port], patience);
        assert!(started.elapsed() < patience, "a released port kept waiting");
    }

    #[test]
    fn migrate_is_not_raised_as_a_service() {
        // Raised alongside the others it exits immediately, and Compose reports a service that will
        // not stay up. It is run to completion instead, by `migrate`.
        assert!(!SERVICES.contains(&"migrate"));
    }

    #[test]
    fn the_bots_computers_are_found_by_label_rather_than_by_a_name_that_starts_with_openbot() {
        // A name filter would also match a kind cluster's nodes, which are called
        // openbot-control-plane and openbot-worker and belong to somebody else.
        assert!(
            SUPERVISOR_FILTER.starts_with("label="),
            "without this the engine answers `invalid filter`: {SUPERVISOR_FILTER}"
        );
        assert!(SUPERVISOR_FILTER.contains("openbot.supervisor=true"));
        assert!(!SUPERVISOR_FILTER.contains("name="));
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
    fn the_app_is_served_as_a_build_rather_than_by_a_development_server() {
        let app = HOST_PROCESSES
            .iter()
            .find(|process| process.name == "app")
            .expect("the app is one of the three");
        assert_eq!(
            app.package_script, "serve",
            "`dev` sets NODE_ENV=development, and the SDK draws its developer inspector over the \
             application when it reads that"
        );
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
