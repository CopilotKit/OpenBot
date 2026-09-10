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
use crate::problem::Problem;

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
const AGENT_BOT: &str = "agent-bot";
const AGENT_LANGGRAPH: &str = "agent-langgraph";
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BundledBots {
    pub agent_bot: bool,
    pub agent_langgraph: bool,
}

impl BundledBots {
    /// One provider decision for both service selection and the advertised package endpoint.
    pub fn for_credential(credential: &crate::env::ModelCredential) -> Self {
        use crate::env::ModelCredential;
        match credential {
            ModelCredential::OpenAi { .. } | ModelCredential::Compatible { .. } => {
                Self::openai_compatible()
            }
            ModelCredential::Anthropic { .. } => Self::anthropic(),
            ModelCredential::None
            | ModelCredential::ClaudePlan { .. }
            | ModelCredential::ChatGptPlan { .. } => Self::none(),
        }
    }

    pub const fn none() -> Self {
        Self {
            agent_bot: false,
            agent_langgraph: false,
        }
    }

    pub const fn openai_compatible() -> Self {
        Self {
            agent_bot: true,
            agent_langgraph: true,
        }
    }

    pub const fn anthropic() -> Self {
        Self {
            agent_bot: false,
            agent_langgraph: true,
        }
    }
}

pub fn selected_services(harness: bool, bots: BundledBots) -> Vec<&'static str> {
    let mut services = SERVICES.to_vec();
    if bots.agent_bot {
        services.push(AGENT_BOT);
    }
    if bots.agent_langgraph {
        services.push(AGENT_LANGGRAPH);
    }
    if harness {
        services.push("agent-harness");
    }
    services
}

/// The three that are not containers, in the order they are started.
///
/// The server first, because the app serves a page that talks to it and the worker claims routines
/// it owns. Nothing here waits on the others: each is supervised on its own and reports its own
/// state, so a worker that dies does not take the window with it.
pub const HOST_PROCESSES: [HostProcess; 3] = [
    HostProcess {
        name: "server",
        cwd: "server",
        script: "src/production-entry.ts",
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
    // Which bundled Bots can read the provider the model screen selected.
    bots: BundledBots,
    secrets: &Secrets,
) -> Result<Vec<&'static str>, crate::problem::Problem> {
    /*
     * The picked harness rides in on its profile.
     *
     * `agent-harness` is profile-gated so a deployment that picked nothing does not try to start
     * it: its image comes from `.env`, and unset that is a request to pull the empty string, which
     * fails the whole `up` rather than the one service nobody asked for. The flag comes before
     * `up`, because `--profile` is an option of `compose` itself and not of the subcommand.
     */
    let requested = selected_services(harness, bots);
    let mut command = compose_command(engine, root, secrets);
    if harness {
        command.args(["--profile", "harness"]);
    }
    let output = command
        .args(["up", "-d", "--no-build"])
        .args(&requested)
        .output()
        .map_err(|error| format!("could not run {} compose: {error}", engine.engine.binary()))?;

    if output.status.success() {
        return Ok(requested);
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

/// Resolve the same namespace the selected deployment gives its supervisor. Compose owns
/// interpolation, env-file quoting and defaults; parsing .env independently can select a different
/// deployment. Never include the resolved configuration (which can contain secrets) in an error.
fn computer_namespace(engine: &Address, root: &Path) -> Result<Option<String>, String> {
    let config = root.join("docker-compose.yml");
    match std::fs::metadata(&config) {
        Ok(metadata) if metadata.is_file() => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !crate::deployment::stamp_path(root)
                .try_exists()
                .map_err(|error| format!("could not verify computer namespace ownership: {error}"))?
            {
                // Welcome/setup has no deployment yet. In particular, do not let Compose search
                // a parent directory for a file belonging to another installation.
                return Ok(None);
            }
            return Err("could not resolve computer namespace: installed deployment is missing docker-compose.yml".into());
        }
        _ => return Err("could not resolve computer namespace: selected deployment configuration is not readable".into()),
    }
    let output = compose_command(engine, root, &Secrets::new())
        .args(["-f", "docker-compose.yml", "config", "--format", "json"])
        .output()
        .map_err(|error| format!("could not resolve computer namespace: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "could not resolve computer namespace: Compose configuration failed ({})",
            output.status
        ));
    }
    let config: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!("could not resolve computer namespace: unreadable Compose response ({error})")
    })?;
    let configured = config
        .pointer("/services/supervisor/environment/COMPUTER_NAMESPACE")
        .and_then(serde_json::Value::as_str)
        .ok_or("could not resolve computer namespace: supervisor configuration has no namespace")?;
    // Match supervisor/src/names.ts: trim, default only an empty value, then the same 64-character
    // ASCII identifier grammar. A malformed/missing response never becomes an unscoped filter.
    let namespace = match configured.trim() {
        "" => "openbot",
        value => value,
    };
    if namespace.len() > 64
        || !namespace.as_bytes()[0].is_ascii_alphanumeric()
        || !namespace
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("could not resolve computer namespace: supervisor namespace is invalid".into());
    }
    Ok(Some(namespace.to_string()))
}

/// Stop the computers the supervisor made, which Compose does not know about.
///
/// A Bot's computer is created at runtime, not declared in `docker-compose.yml`, so `compose down`
/// leaves it running: an idle Ubuntu container per Bot, with the application gone and nothing on
/// screen to stop it from. Stopped rather than removed, because the supervisor starts an existing
/// owned container back up and the Bot keeps the profile and workspace volumes attached to it.
/// Returns false only when the selected root has no installed deployment to take down.
pub fn stop_computers(engine: &Address, root: &Path) -> Result<bool, String> {
    let Some(namespace) = computer_namespace(engine, root)? else {
        return Ok(false);
    };
    let namespace_filter = format!("label=openbot.namespace={namespace}");
    let listed = engine
        .command()
        .args([
            "ps",
            "--quiet",
            "--filter",
            SUPERVISOR_FILTER,
            "--filter",
            &namespace_filter,
        ])
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
        return Ok(true);
    }

    let stopped = engine
        .command()
        .arg("stop")
        .args(&running)
        .output()
        .map_err(|error| format!("could not stop the Bots' computers: {error}"))?;
    if stopped.status.success() {
        return Ok(true);
    }
    Err(command_said(&stopped.stderr))
}

pub fn down(engine: &Address, root: &Path) -> Result<(), String> {
    // Before Compose, because the supervisor is what would otherwise start another one while this
    // is happening.
    if !stop_computers(engine, root)? {
        return Ok(());
    }

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
        .args(["-f", "docker-compose.yml", "--profile", "harness", "down"])
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

/// Unix v2 evidence binds a process instance to the deployment and named launch.
/// Unlike the legacy PID list, this survives reopening without trusting PID reuse or cwd.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct UnixHostProcess {
    name: String,
    deployment: PathBuf,
    pid: u32,
    start: String,
}

#[cfg(unix)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct UnixProcess {
    pid: u32,
    parent: u32,
    start: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RecordedHostPidFile {
    UnixRecords {
        version: u8,
        unix_processes: Vec<UnixHostProcess>,
    },
    Records {
        version: u8,
        processes: Vec<RecordedHostProcess>,
    },
    Pids(Vec<u32>),
}

/// Record the pids of the processes this window started.
pub fn record_host_pids(root: &Path, pids: &[u32]) -> Result<(), Problem> {
    write_host_pid_file(root, &pids)
}

/// Record the host processes this window started.
pub fn record_host_processes(root: &Path, processes: &[(&str, u32)]) -> Result<(), Problem> {
    #[cfg(windows)]
    record_windows_host_processes_with(root, processes, Path::new("powershell"))?;
    #[cfg(not(windows))]
    {
        let records = unix_host_records(root, processes)?;
        write_host_pid_file(
            root,
            &serde_json::json!({"version": 2, "unix_processes": records}),
        )?;
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn record_windows_host_processes_with(
    root: &Path,
    processes: &[(&str, u32)],
    powershell: &Path,
) -> Result<(), Problem> {
    let problem = |detail| {
        Problem::with(
            "OpenBot could not verify its Windows host process ownership.",
            format!(
                "{}: {detail}; ownership records retained",
                host_pids_path(root).display()
            ),
        )
    };
    let mut seen_names = std::collections::HashSet::new();
    let mut seen_pids = std::collections::HashSet::new();
    for (name, pid) in processes {
        if !HOST_PROCESSES.iter().any(|process| process.name == *name) {
            return Err(problem(format!("unknown host launch {name}, pid {pid}")));
        }
        if !seen_names.insert(*name) || !seen_pids.insert(*pid) {
            return Err(problem(format!("duplicate host launch {name}, pid {pid}")));
        }
    }

    let snapshot = windows_processes_with(powershell)?;
    let mut records = Vec::with_capacity(processes.len());
    for (name, pid) in processes {
        let matches: Vec<_> = snapshot
            .iter()
            .filter(|process| process.process_id == *pid)
            .collect();
        let live = match matches.as_slice() {
            [] => {
                return Err(problem(format!(
                    "host {name}, pid {pid} is missing from the process inventory"
                )));
            }
            [live] => *live,
            _ => {
                return Err(problem(format!(
                    "host {name}, pid {pid} appeared more than once in the process inventory"
                )));
            }
        };
        let record = RecordedHostProcess::from_live(name, live)
            .filter(|record| {
                !record.executable_path.is_empty()
                    && !record.command_line.is_empty()
                    && !record.creation_date.is_empty()
            })
            .ok_or_else(|| {
                problem(format!(
                    "host {name}, pid {pid} has incomplete process identity metadata"
                ))
            })?;
        records.push(record);
    }
    write_host_pid_file(
        root,
        &serde_json::json!({ "version": 1, "processes": records }),
    )?;
    Ok(())
}

/// The pids a previous window recorded, if any.
pub fn recorded_host_pids(root: &Path) -> Result<Vec<u32>, Problem> {
    Ok(match recorded_host_pid_file(root)? {
        Some(RecordedHostPidFile::Records {
            version: 1,
            processes,
        }) => processes.into_iter().map(|process| process.pid).collect(),
        Some(RecordedHostPidFile::UnixRecords {
            version: 2,
            unix_processes,
        }) => unix_processes
            .into_iter()
            .map(|process| process.pid)
            .collect(),
        Some(RecordedHostPidFile::Pids(pids)) => pids,
        _ => Vec::new(),
    })
}

/// The recorded host processes with enough identity to verify a live Windows process.
pub fn recorded_host_processes(root: &Path) -> Result<Vec<RecordedHostProcess>, Problem> {
    Ok(match recorded_host_pid_file(root)? {
        Some(RecordedHostPidFile::Records {
            version: 1,
            processes,
        }) => processes,
        _ => Vec::new(),
    })
}

fn recorded_host_pid_file(root: &Path) -> Result<Option<RecordedHostPidFile>, Problem> {
    let path = host_pids_path(root);
    let problem = |detail| {
        Problem::with(
            "OpenBot could not read its recorded host processes.",
            format!("{}: {detail}", path.display()),
        )
    };
    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(problem(format!("could not read pidfile: {error}"))),
    };
    let recorded = serde_json::from_slice::<RecordedHostPidFile>(&raw)
        .map_err(|error| problem(format!("could not decode pidfile JSON: {error}")))?;
    let (version, supported) = match &recorded {
        RecordedHostPidFile::Records { version, .. } => (*version, 1),
        RecordedHostPidFile::UnixRecords { version, .. } => (*version, 2),
        RecordedHostPidFile::Pids(_) => (0, 0),
    };
    if version != supported {
        return Err(problem(format!("unsupported pidfile version {version}")));
    }
    Ok(Some(recorded))
}

/// Commit a complete pidfile with one replacement. Every fallible preparation step happens
/// before the rename, so an error leaves the previous ownership evidence available for retry.
fn write_host_pid_file<T: Serialize>(root: &Path, value: &T) -> Result<(), Problem> {
    use std::io::Write;

    let path = host_pids_path(root);
    let problem = |operation: &str, error: &dyn std::fmt::Display| {
        Problem::with(
            "OpenBot could not record its host processes.",
            format!("{}: {operation}: {error}", path.display()),
        )
    };
    let bytes = serde_json::to_vec(value)
        .map_err(|error| problem("could not serialize pidfile", &error))?;
    let parent = path.parent().expect("host pidfile has a .logs parent");
    std::fs::create_dir_all(parent)
        .map_err(|error| problem("could not create pidfile parent directory", &error))?;
    let temporary = parent.join(format!(".host-pids-{:016x}.tmp", rand::random::<u64>()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    // Only clean up a temporary file this call created, including on a name collision.
    let mut file = options
        .open(&temporary)
        .map_err(|error| problem("could not create temporary pidfile", &error))?;
    let prepared = file
        .write_all(&bytes)
        .map_err(|error| problem("could not write temporary pidfile", &error))
        .and_then(|()| {
            file.sync_all()
                .map_err(|error| problem("could not sync temporary pidfile", &error))
        });
    drop(file);
    let result = prepared.and_then(|()| {
        std::fs::rename(&temporary, &path)
            .map_err(|error| problem("could not replace pidfile", &error))
    });
    if let Err(mut failure) = result {
        if let Err(error) = std::fs::remove_file(&temporary) {
            failure.detail = Some(format!(
                "{}; could not remove temporary pidfile {}: {error}",
                failure.detail.as_deref().unwrap_or_default(),
                temporary.display(),
            ));
        }
        return Err(failure);
    }
    Ok(())
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

/// Keep a replacement handle even if refreshing durable ownership fails. The caller must
/// report success only after this Result succeeds; Stop still has the handle on failure.
#[cfg(unix)]
pub fn replace_host_process(
    root: &Path,
    children: &mut Vec<(&'static str, std::process::Child)>,
    name: &'static str,
    child: std::process::Child,
) -> Result<(), Problem> {
    children.retain(|(held, _)| *held != name);
    children.push((name, child));
    let mut live = Vec::new();
    for (name, child) in children.iter_mut() {
        if child
            .try_wait()
            .map_err(|error| {
                unix_ownership_problem(format!("could not inspect held {name}: {error}"))
            })?
            .is_none()
        {
            live.push((*name, child.id()));
        }
    }
    record_host_processes(root, &live)
}

#[cfg(unix)]
fn unix_ownership_problem(detail: impl Into<String>) -> Problem {
    Problem::with(
        "OpenBot could not verify its host process ownership.",
        detail,
    )
}

#[cfg(unix)]
fn safe_unix_pid(pid: u32) -> bool {
    pid > 1
        && pid <= i32::MAX as u32
        && pid != std::process::id()
        && pid != unsafe { libc::getppid() } as u32
}

#[cfg(unix)]
fn unix_host_records(
    root: &Path,
    processes: &[(&str, u32)],
) -> Result<Vec<UnixHostProcess>, Problem> {
    let deployment = std::fs::canonicalize(root).map_err(|error| {
        unix_ownership_problem(format!(
            "{}: could not resolve deployment: {error}",
            root.display()
        ))
    })?;
    processes
        .iter()
        .map(|(name, pid)| {
            if !safe_unix_pid(*pid) || !HOST_PROCESSES.iter().any(|host| host.name == *name) {
                return Err(unix_ownership_problem(format!(
                    "invalid host launch {name}, pid {pid}"
                )));
            }
            let live = unix_process(*pid)?.ok_or_else(|| {
                unix_ownership_problem(format!("host {name}, pid {pid} is no longer running"))
            })?;
            if live.parent != std::process::id() {
                return Err(unix_ownership_problem(format!(
                    "host {name}, pid {pid} is not a child of this window"
                )));
            }
            Ok(UnixHostProcess {
                name: name.to_string(),
                deployment: deployment.clone(),
                pid: *pid,
                start: live.start,
            })
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn unix_process(pid: u32) -> Result<Option<UnixProcess>, Problem> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if read != size {
        let error = std::io::Error::last_os_error();
        if read == 0 && error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        return Err(unix_ownership_problem(format!(
            "proc_pidinfo({pid}) returned {read}/{size} bytes: {error}"
        )));
    }
    let info = unsafe { info.assume_init() };
    if info.pbi_status == libc::SZOMB {
        return Ok(None);
    }
    if info.pbi_pid != pid || info.pbi_start_tvsec == 0 {
        return Err(unix_ownership_problem(format!(
            "proc_pidinfo({pid}) returned invalid identity"
        )));
    }
    Ok(Some(UnixProcess {
        pid,
        parent: info.pbi_ppid,
        start: format!("macos:{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
    }))
}

#[cfg(target_os = "linux")]
fn unix_process(pid: u32) -> Result<Option<UnixProcess>, Problem> {
    let path = format!("/proc/{pid}/stat");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(unix_ownership_problem(format!("{path}: {error}"))),
    };
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(|error| {
        unix_ownership_problem(format!("could not read Linux boot identity: {error}"))
    })?;
    parse_linux_process(pid, &raw, boot.trim())
}

#[cfg(all(unix, any(target_os = "linux", test)))]
fn parse_linux_process(pid: u32, raw: &str, boot: &str) -> Result<Option<UnixProcess>, Problem> {
    let invalid =
        || unix_ownership_problem(format!("invalid Linux process inventory for pid {pid}"));
    let (head, tail) = raw.rsplit_once(')').ok_or_else(invalid)?;
    let (listed, _) = head.split_once('(').ok_or_else(invalid)?;
    if listed.trim().parse::<u32>().ok() != Some(pid) || boot.is_empty() {
        return Err(invalid());
    }
    let fields: Vec<_> = tail.split_whitespace().collect();
    let parent = fields
        .get(1)
        .and_then(|s| s.parse::<u32>().ok())
        .ok_or_else(invalid)?;
    let start = fields
        .get(19)
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)
        .ok_or_else(invalid)?;
    if fields.first() == Some(&"Z") {
        return Ok(None);
    }
    Ok(Some(UnixProcess {
        pid,
        parent,
        start: format!("linux:{boot}:{start}"),
    }))
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn unix_process(_pid: u32) -> Result<Option<UnixProcess>, Problem> {
    Err(unix_ownership_problem(
        "process-instance verification is unsupported on this Unix platform",
    ))
}

#[cfg(unix)]
fn unix_inventory() -> Result<Vec<(u32, u32)>, Problem> {
    unix_inventory_with(Path::new("/bin/ps"))
}

#[cfg(unix)]
fn unix_inventory_with(ps: &Path) -> Result<Vec<(u32, u32)>, Problem> {
    let operation = format!("{} -axo pid=,ppid=", ps.display());
    let listing = command(ps)
        .args(["-axo", "pid=,ppid="])
        .output()
        .map_err(|error| cleanup_spawn_problem(&operation, error))?;
    if !listing.status.success() {
        return Err(cleanup_status_problem(&operation, &listing));
    }
    let raw = std::str::from_utf8(&listing.stdout).map_err(|error| {
        unix_ownership_problem(format!("invalid process inventory encoding: {error}"))
    })?;
    let mut rows = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in raw.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        let invalid = || unix_ownership_problem("malformed Unix process inventory");
        if fields.len() != 2 {
            return Err(invalid());
        }
        let pid = fields[0].parse::<u32>().map_err(|_| invalid())?;
        let parent = fields[1].parse::<u32>().map_err(|_| invalid())?;
        if pid == 0 || !seen.insert(pid) {
            return Err(invalid());
        }
        rows.push((pid, parent));
    }
    if rows.is_empty() {
        return Err(unix_ownership_problem("empty Unix process inventory"));
    }
    Ok(rows)
}

/// Stop only recorded Unix instances and descendants whose ancestry is verified while the
/// recorded parent is still alive. Cwd, command names and legacy PIDs never authorize a signal.
#[cfg(unix)]
pub fn stop_processes_under(root: &Path) -> Result<usize, Problem> {
    let records = match recorded_host_pid_file(root)? {
        None => return Ok(0),
        Some(RecordedHostPidFile::UnixRecords { version: 2, unix_processes }) => unix_processes,
        _ => return Err(unix_ownership_problem(format!("{}: legacy ownership evidence has no Unix process-instance identity; cleanup unresolved", host_pids_path(root).display()))),
    };
    stop_unix_records(root, &records)
}

/// Held children also provide ownership when durable recording failed. Call before killing
/// their parents so descendants remain verifiable. Exited Child handles never authorize a PID.
#[cfg(unix)]
pub fn stop_host_children(
    root: &Path,
    children: &mut [(&str, std::process::Child)],
) -> Result<usize, Problem> {
    let mut live = Vec::new();
    for (name, child) in children {
        if child
            .try_wait()
            .map_err(|error| {
                unix_ownership_problem(format!("could not inspect held {name}: {error}"))
            })?
            .is_none()
        {
            live.push((*name, child.id()));
        }
    }
    if live.is_empty() {
        return Ok(0);
    }
    stop_unix_records(root, &unix_host_records(root, &live)?)
}

/// Windows replacements may not be in the initial pidfile. A live Child plus its current direct
/// parent and complete instance identity authorizes adding it to the existing verified inventory.
#[cfg(not(unix))]
pub fn stop_host_children(
    root: &Path,
    children: &mut [(&str, std::process::Child)],
) -> Result<usize, Problem> {
    stop_windows_host_children_with(
        root,
        children,
        Path::new("powershell"),
        Path::new("netstat"),
        Path::new("taskkill"),
    )
}

#[cfg(any(not(unix), test))]
fn stop_windows_host_children_with(
    root: &Path,
    children: &mut [(&str, std::process::Child)],
    powershell: &Path,
    netstat: &Path,
    taskkill: &Path,
) -> Result<usize, Problem> {
    let mut held = Vec::new();
    for (name, child) in children.iter_mut() {
        if child
            .try_wait()
            .map_err(|error| {
                Problem::with(
                    "OpenBot could not inspect a held host process.",
                    format!("{name}: {error}"),
                )
            })?
            .is_none()
        {
            held.push((*name, child.id()));
        }
    }
    if held.is_empty() {
        return Ok(0);
    }
    let snapshot = windows_processes_with(powershell)?;
    let mut records = recorded_host_processes(root)?;
    for (name, pid) in held {
        let live = snapshot.iter().find(|live| {
            live.process_id == pid
                && live.parent_process_id == std::process::id()
                && HOST_PROCESSES.iter().any(|process| process.name == name)
        });
        let record = live.and_then(|live| RecordedHostProcess::from_live(name, live))
            .filter(|record| !record.executable_path.is_empty() && !record.command_line.is_empty() && !record.creation_date.is_empty())
            .ok_or_else(|| Problem::with(
                "OpenBot could not verify a held host process.",
                format!("{name}, pid {pid}: current direct-child identity is unavailable; ownership retained"),
            ))?;
        // Preserve any earlier instance too. Each is independently verified before termination.
        if !records.contains(&record) {
            records.push(record);
        }
    }
    write_host_pid_file(root, &serde_json::json!({"version":1,"processes":records}))?;
    stop_windows_processes_under_with(root, &records, &snapshot, netstat, taskkill)
}

#[cfg(unix)]
fn stop_unix_records(root: &Path, records: &[UnixHostProcess]) -> Result<usize, Problem> {
    if records.is_empty() {
        return Ok(0);
    }
    let deployment = std::fs::canonicalize(root).map_err(|error| {
        unix_ownership_problem(format!(
            "{}: could not resolve deployment: {error}",
            root.display()
        ))
    })?;
    let inventory = unix_inventory()?;
    stop_unix_records_with(
        &deployment,
        records,
        &inventory,
        unix_process,
        terminate_unix_process,
    )
}

#[cfg(unix)]
fn stop_unix_records_with<I, T>(
    deployment: &Path,
    records: &[UnixHostProcess],
    inventory: &[(u32, u32)],
    mut inspect: I,
    mut terminate: T,
) -> Result<usize, Problem>
where
    I: FnMut(u32) -> Result<Option<UnixProcess>, Problem>,
    T: FnMut(i32) -> Result<bool, Problem>,
{
    let mut stopped = 0;
    let mut failures = Vec::new();
    for record in records {
        let result = (|| {
            if record.deployment != deployment
                || record.start.is_empty()
                || !safe_unix_pid(record.pid)
                || !HOST_PROCESSES.iter().any(|host| host.name == record.name)
            {
                return Err(unix_ownership_problem(format!(
                    "invalid Unix ownership record for pid {}",
                    record.pid
                )));
            }
            let Some(live) = inspect(record.pid)? else {
                return Ok(0);
            };
            if live.start != record.start {
                return Ok(0);
            }
            if !inventory.contains(&(live.pid, live.parent)) {
                return Err(unix_ownership_problem(format!(
                    "process inventory lost the owned root pid {}",
                    live.pid
                )));
            }
            let mut tree = vec![(live, None)];
            let mut seen = std::collections::HashSet::from([record.pid]);
            let mut index = 0;
            while index < tree.len() {
                let parent = tree[index].0.pid;
                for (pid, ppid) in inventory.iter().filter(|(_, ppid)| *ppid == parent) {
                    if !safe_unix_pid(*pid) || !seen.insert(*pid) {
                        return Err(unix_ownership_problem(
                            "unsafe or cyclic owned process ancestry",
                        ));
                    }
                    if let Some(child) = inspect(*pid)? {
                        if child.parent != *ppid {
                            return Err(unix_ownership_problem(format!(
                                "process ancestry changed for pid {pid}"
                            )));
                        }
                        tree.push((child, Some(index)));
                    }
                }
                index += 1;
            }
            let mut count = 0;
            // Descendants first. Verify the complete live chain immediately before each signal.
            // On failure leave the parent alive and retain durable evidence for a retry.
            for index in (0..tree.len()).rev() {
                let mut ancestor = Some(index);
                let mut present = true;
                while let Some(at) = ancestor {
                    match inspect(tree[at].0.pid)? {
                        Some(now) if now == tree[at].0 => {}
                        None if at == index => {
                            present = false;
                            break;
                        }
                        _ => {
                            return Err(unix_ownership_problem(format!(
                                "process identity or ancestry changed for pid {}",
                                tree[at].0.pid
                            )))
                        }
                    }
                    ancestor = tree[at].1;
                }
                if present && terminate(tree[index].0.pid as i32)? {
                    count += 1;
                }
            }
            Ok(count)
        })();
        match result {
            Ok(count) => stopped += count,
            Err(problem) => failures.push(problem),
        }
    }
    cleanup_result(stopped, failures)
}

#[cfg(unix)]
fn terminate_unix_process(pid: i32) -> Result<bool, Problem> {
    if pid <= 1 || !safe_unix_pid(pid as u32) {
        return Err(unix_ownership_problem("refused unsafe process target"));
    }
    let killed = unsafe { libc::kill(pid, libc::SIGTERM) };
    if killed == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(false);
    }
    Err(Problem::with(
        "OpenBot could not stop one of its host processes.",
        format!("could not send SIGTERM to pid {pid}: {error}"),
    ))
}

#[cfg(not(unix))]
pub fn stop_processes_under(_root: &Path) -> Result<usize, Problem> {
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
    /*
     * The pids this window or an earlier one recorded, which is the only way to reach the worker.
     *
     * It listens on no port, so the sweep below cannot see it. The server has its own loader entry,
     * but that does not make the worker visible to the port sweep: after the port sweep alone, 3001
     * and 3010 were free and the worker was still running.
     */
    stop_windows_processes_with_inventory(
        _root,
        Path::new("powershell"),
        Path::new("netstat"),
        Path::new("taskkill"),
    )
}

#[cfg(any(not(unix), test))]
fn stop_windows_processes_with_inventory(
    root: &Path,
    powershell: &Path,
    netstat: &Path,
    taskkill: &Path,
) -> Result<usize, Problem> {
    let recorded = recorded_host_processes(root)?;
    let processes = windows_processes_with(powershell)?;
    stop_windows_processes_under_with(root, &recorded, &processes, netstat, taskkill)
}

#[cfg(any(not(unix), test))]
fn stop_windows_processes_under_with(
    root: &Path,
    recorded: &[RecordedHostProcess],
    processes: &[WindowsProcess],
    netstat: &Path,
    taskkill: &Path,
) -> Result<usize, Problem> {
    // A same-PID row without usable identity metadata is unresolved, not proof of PID reuse.
    // Keep the original evidence for a later inventory that can positively verify or reject it.
    if let Some(record) = recorded.iter().find(|record| {
        processes.iter().any(|live| {
            live.process_id == record.pid
                && ([&live.executable_path, &live.command_line]
                    .iter()
                    .any(|field| matches!(field.as_deref(), None | Some("")))
                    || live
                        .creation_date
                        .as_deref()
                        .and_then(windows_creation_time)
                        .is_none()
                    || windows_creation_time(&record.creation_date).is_none())
        })
    }) {
        return Err(Problem::with(
            "OpenBot could not verify one of its recorded host processes.",
            format!(
                "{}: process inventory lacks usable identity metadata for pid {}; ownership records retained",
                host_pids_path(root).display(),
                record.pid
            ),
        ));
    }
    let mut stopped_recorded = 0;
    let roots = verified_openbot_root_pids(recorded, processes);
    let mut failures = Vec::new();
    for pid in &roots {
        match taskkill_process_tree_with(taskkill, *pid) {
            Ok(true) => stopped_recorded += 1,
            Ok(false) => {}
            Err(problem) => failures.push(problem),
        }
    }
    // And a sweep of the two host ports, for a stack whose pidfile is gone. The containers are
    // Compose's to stop, and killing whatever holds a container's published port would reach into
    // the engine's own plumbing.
    let operation = format!("{} -ano -p tcp", netstat.display());
    let listing = command(netstat)
        .args(["-ano", "-p", "tcp"])
        .output()
        .map_err(|error| cleanup_spawn_problem(&operation, error))?;
    let stopped_listening = if listing.status.success() {
        let listed = String::from_utf8_lossy(&listing.stdout);
        match stop_windows_processes_in(recorded, processes, &listed, |pid| {
            taskkill_process_tree_with(taskkill, pid)
        }) {
            Ok(stopped) => stopped,
            Err(problem) => {
                failures.push(problem);
                0
            }
        }
    } else {
        failures.push(cleanup_status_problem(&operation, &listing));
        0
    };

    // Keep the complete ownership record until every cleanup phase has succeeded. A retry
    // re-verifies each identity, so records for processes already stopped are safe to retain.
    let stopped = cleanup_result(stopped_recorded + stopped_listening, failures)?;
    let path = host_pids_path(root);
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(Problem::with(
                "OpenBot could not remove its recorded host processes.",
                format!("{}: could not remove pidfile: {error}", path.display()),
            ));
        }
    }
    Ok(stopped)
}

fn cleanup_result(stopped: usize, failures: Vec<Problem>) -> Result<usize, Problem> {
    if failures.is_empty() {
        return Ok(stopped);
    }
    Err(combined_cleanup_problem(failures))
}

#[cfg(not(unix))]
fn taskkill_process_tree(pid: u32) -> Result<bool, Problem> {
    taskkill_process_tree_with(Path::new("taskkill"), pid)
}

#[cfg(any(not(unix), test))]
fn taskkill_process_tree_with(taskkill: &Path, pid: u32) -> Result<bool, Problem> {
    let operation = format!("{} /PID {pid} /T /F", taskkill.display());
    let output = command(taskkill)
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output()
        .map_err(|error| cleanup_spawn_problem(&operation, error))?;
    if output.status.success() {
        return Ok(true);
    }
    Err(cleanup_status_problem(&operation, &output))
}

#[cfg(any(not(unix), test))]
fn stop_windows_processes_in<F>(
    recorded: &[RecordedHostProcess],
    processes: &[WindowsProcess],
    listing: &str,
    mut taskkill: F,
) -> Result<usize, Problem>
where
    F: FnMut(u32) -> Result<bool, Problem>,
{
    let ports = crate::env::Ports::default();
    let ours = [ports.app, ports.server];
    let mut stopped = 0;
    let mut failures = Vec::new();
    for pid in verified_openbot_pids_listening_on(listing, &ours, recorded, processes) {
        // With its children: `bun run serve` starts the real server as a grandchild, so ending
        // only the process holding the port leaves that one behind.
        match taskkill(pid) {
            Ok(true) => stopped += 1,
            Ok(false) => {}
            Err(problem) => failures.push(problem),
        }
    }
    cleanup_result(stopped, failures)
}

fn cleanup_spawn_problem(operation: &str, error: std::io::Error) -> Problem {
    Problem::with(
        "OpenBot could not inspect or stop its host processes.",
        format!("could not run {operation}: {error}"),
    )
}

fn cleanup_status_problem(operation: &str, output: &std::process::Output) -> Problem {
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
    Problem::with(
        "OpenBot could not inspect or stop its host processes.",
        detail,
    )
}

fn combined_cleanup_problem(failures: Vec<Problem>) -> Problem {
    Problem::with(
        "OpenBot could not inspect or stop its host processes.",
        failures
            .into_iter()
            .map(problem_detail)
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn problem_detail(problem: Problem) -> String {
    match problem.detail {
        Some(detail) => format!("{}\n{}", problem.said, detail),
        None => problem.said,
    }
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

#[cfg(any(windows, test))]
fn windows_processes_with(powershell: &Path) -> Result<Vec<WindowsProcess>, Problem> {
    let operation = format!("{} Get-CimInstance Win32_Process", powershell.display());
    let output = command(powershell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate)",
        ])
        .output()
        .map_err(|error| cleanup_spawn_problem(&operation, error))?;
    if !output.status.success() {
        // The inventory includes other processes' command lines. Never echo a partial snapshot.
        return Err(Problem::with(
            "OpenBot could not inspect its Windows host processes.",
            format!("{operation} exited with status {}", output.status),
        ));
    }
    windows_process_output(&output.stdout)
}

#[cfg(any(windows, test))]
fn windows_process_output(output: &[u8]) -> Result<Vec<WindowsProcess>, Problem> {
    let invalid_encoding = || {
        Problem::with(
            "OpenBot could not inspect its Windows host processes.",
            "powershell Get-CimInstance Win32_Process returned invalid UTF-8 or UTF-16LE",
        )
    };
    // Windows PowerShell redirection can produce UTF-16LE, even though the script requests UTF-8.
    if output.starts_with(&[0xff, 0xfe]) || output.get(1) == Some(&0) {
        let bytes = output.strip_prefix(&[0xff, 0xfe]).unwrap_or(output);
        if bytes.len() % 2 != 0 {
            return Err(invalid_encoding());
        }
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let text = String::from_utf16(&units).map_err(|_| invalid_encoding())?;
        windows_processes_in(&text)
    } else {
        let bytes = output.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(output);
        let text = std::str::from_utf8(bytes).map_err(|_| invalid_encoding())?;
        windows_processes_in(text)
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WindowsProcessListing {
    Many(Vec<WindowsProcess>),
    One(WindowsProcess),
}

pub fn windows_processes_in(listing: &str) -> Result<Vec<WindowsProcess>, Problem> {
    let listing = serde_json::from_str::<WindowsProcessListing>(listing).map_err(|error| {
        Problem::with(
            "OpenBot could not inspect its Windows host processes.",
            format!(
                "powershell Get-CimInstance Win32_Process returned invalid process JSON: {error}"
            ),
        )
    })?;
    Ok(match listing {
        WindowsProcessListing::Many(processes) => processes,
        WindowsProcessListing::One(process) => vec![process],
    })
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
            (record.matches(live) && windows_creation_time(&record.creation_date).is_some())
                .then_some(record.pid)
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

/// A UTC instant in microseconds, preserving both Windows PowerShell's JSON date format
/// and the CIM datetime format. Unknown fields or malformed timestamps cannot prove ancestry.
fn windows_creation_time(value: &str) -> Option<i64> {
    fn digits(value: &str) -> Option<i64> {
        (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| value.parse().ok())?
    }

    // ConvertTo-Json in Windows PowerShell emits /Date(milliseconds[+/-HHmm])/.
    // The number is already UTC; the optional offset describes its local DateTime kind.
    if let Some(value) = value
        .strip_prefix("/Date(")
        .and_then(|s| s.strip_suffix(")/"))
    {
        let offset_index = value
            .char_indices()
            .skip(1)
            .find(|(_, ch)| matches!(ch, '+' | '-'))
            .map(|(index, _)| index);
        let milliseconds = if let Some(index) = offset_index {
            let offset = value.get(index + 1..)?;
            if offset.len() != 4 || digits(offset.get(..2)?)? > 23 || digits(offset.get(2..)?)? > 59
            {
                return None;
            }
            value.get(..index)?
        } else {
            value
        };
        digits(milliseconds.strip_prefix('-').unwrap_or(milliseconds))?;
        let milliseconds: i64 = milliseconds.parse().ok()?;
        // The .NET DateTime range is 0001-01-01 through 9999-12-31.
        return (-62_135_596_800_000..=253_402_300_799_999)
            .contains(&milliseconds)
            .then(|| milliseconds * 1_000);
    }

    // CIM: yyyymmddHHMMSS.mmmmmm+/-UUU, with a signed UTC offset in minutes.
    // https://learn.microsoft.com/en-us/windows/win32/wmisdk/cim-datetime
    if value.len() != 25 || value.get(14..15)? != "." {
        return None;
    }
    let year = digits(value.get(..4)?)?;
    let month = digits(value.get(4..6)?)?;
    let day = digits(value.get(6..8)?)?;
    let hour = digits(value.get(8..10)?)?;
    let minute = digits(value.get(10..12)?)?;
    let second = digits(value.get(12..14)?)?;
    let micros = digits(value.get(15..21)?)?;
    let offset = digits(value.get(22..)?)?
        * match value.get(21..22)? {
            "+" => 1,
            "-" => -1,
            _ => return None,
        };
    if year == 0 || !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let month_index = usize::try_from(month - 1).ok()?;
    if !(1..=month_days[month_index]).contains(&day) {
        return None;
    }
    let prior_year = year - 1;
    let days = 365 * prior_year + prior_year / 4 - prior_year / 100
        + prior_year / 400
        + month_days[..month_index].iter().sum::<i64>()
        + day
        - 1
        - 719_162;
    Some((((days * 24 + hour) * 60 + minute - offset) * 60 + second) * 1_000_000 + micros)
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
        if parent == 0 || parent == current {
            return false;
        }
        let Some(parent_process) = processes
            .iter()
            .find(|process| process.process_id == parent)
        else {
            return false;
        };
        let times = process
            .creation_date
            .as_deref()
            .and_then(windows_creation_time)
            .zip(
                parent_process
                    .creation_date
                    .as_deref()
                    .and_then(windows_creation_time),
            );
        // ParentProcessId can refer to a reused PID. A newer parent instance cannot have
        // created this child. Validate every link, including the final link to an owned root.
        // https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process
        if !times.is_some_and(|(child, parent)| parent <= child) {
            return false;
        }
        if roots.contains(&parent) {
            return true;
        }
        current = parent;
    }
}

/// Whether this deployment has recorded ownership for the server answering `port`.
///
/// Used by the passive startup probe. Absence of current, root-scoped ownership is not fatal
/// there; it means the app must show setup instead of adopting a process on the shared port.
pub fn recorded_server_owns_port(root: &Path, port: u16) -> Result<bool, Problem> {
    recorded_process_owns_port(root, "server", port)
}

/// Every listener on the port must belong to the requested recorded host role. This also rejects
/// ambiguous IPv4/IPv6 ownership rather than showing whichever unrelated address answers first.
pub fn recorded_process_owns_port(root: &Path, name: &str, port: u16) -> Result<bool, Problem> {
    if !HOST_PROCESSES.iter().any(|host| host.name == name) {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        recorded_process_owns_port_unix(root, name, port)
    }
    #[cfg(not(unix))]
    {
        recorded_process_owns_port_windows_with(
            root,
            name,
            port,
            Path::new("powershell"),
            Path::new("netstat"),
        )
    }
}

#[cfg(unix)]
fn recorded_process_owns_port_unix(root: &Path, name: &str, port: u16) -> Result<bool, Problem> {
    let deployment = std::fs::canonicalize(root).map_err(|error| {
        unix_ownership_problem(format!(
            "{}: could not resolve deployment: {error}",
            root.display()
        ))
    })?;
    let records = match recorded_host_pid_file(root)? {
        Some(RecordedHostPidFile::UnixRecords {
            version: 2,
            unix_processes,
        }) => unix_processes,
        _ => return Ok(false),
    };
    let listening = unix_pids_listening_on(port)?;
    if listening.is_empty() {
        return Ok(false);
    }
    let records: Vec<_> = records
        .iter()
        .filter(|record| record.name == name && record.deployment == deployment)
        .collect();
    for pid in listening {
        let mut owned = false;
        for record in &records {
            if unix_listener_belongs_to_record(pid, record, unix_process)? {
                owned = true;
                break;
            }
        }
        if !owned {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(unix)]
fn unix_listener_belongs_to_record<I>(
    pid: u32,
    record: &UnixHostProcess,
    mut inspect: I,
) -> Result<bool, Problem>
where
    I: FnMut(u32) -> Result<Option<UnixProcess>, Problem>,
{
    let mut seen = std::collections::HashSet::new();
    let mut chain = Vec::new();
    let mut current = pid;
    loop {
        if !safe_unix_pid(current) || !seen.insert(current) {
            return Ok(false);
        }
        let Some(live) = inspect(current)? else {
            return Ok(false);
        };
        let parent = live.parent;
        let at_root = current == record.pid;
        if at_root && (record.start.is_empty() || live.start != record.start) {
            return Ok(false);
        }
        chain.push(live);
        if at_root {
            // The app launcher may own a Vite child. Recheck every instance and parent link so a
            // dead/reused anchor or a changed ancestry cannot authorize an unrelated listener.
            for process in chain {
                if inspect(process.pid)?.as_ref() != Some(&process) {
                    return Ok(false);
                }
            }
            return Ok(true);
        }
        current = parent;
    }
}

#[cfg(unix)]
fn unix_pids_listening_on(port: u16) -> Result<Vec<u32>, Problem> {
    let operation = format!("lsof -nP -iTCP:{port} -sTCP:LISTEN -Fp");
    let output = command("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fp"])
        .output()
        .map_err(|error| cleanup_spawn_problem(&operation, error))?;
    if !output.status.success() {
        if output.status.code() == Some(1) {
            return Ok(Vec::new());
        }
        return Err(cleanup_status_problem(&operation, &output));
    }
    let listed = String::from_utf8_lossy(&output.stdout);
    Ok(parse_lsof_pid_fields(&listed))
}

#[cfg(unix)]
fn parse_lsof_pid_fields(listing: &str) -> Vec<u32> {
    let mut found = Vec::new();
    for line in listing.lines() {
        let Some(pid) = line
            .strip_prefix('p')
            .and_then(|pid| pid.parse::<u32>().ok())
        else {
            continue;
        };
        if !found.contains(&pid) {
            found.push(pid);
        }
    }
    found
}

#[cfg(any(not(unix), test))]
fn recorded_process_owns_port_windows_with(
    root: &Path,
    name: &str,
    port: u16,
    powershell: &Path,
    netstat: &Path,
) -> Result<bool, Problem> {
    let recorded: Vec<_> = recorded_host_processes(root)?
        .into_iter()
        .filter(|record| record.name == name)
        .collect();
    if recorded.is_empty() {
        return Ok(false);
    }
    let processes = windows_processes_with(powershell)?;
    let operation = format!("{} -ano -p tcp", netstat.display());
    let listing = command(netstat)
        .args(["-ano", "-p", "tcp"])
        .output()
        .map_err(|error| cleanup_spawn_problem(&operation, error))?;
    if !listing.status.success() {
        return Err(cleanup_status_problem(&operation, &listing));
    }
    let listed = String::from_utf8_lossy(&listing.stdout);
    let listening = pids_listening_on(&listed, &[port]);
    let verified = verified_openbot_pids_listening_on(&listed, &[port], &recorded, &processes);
    Ok(!listening.is_empty() && listening.iter().all(|pid| verified.contains(pid)))
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
    services_that_exited_among(engine, root, None)
}

pub fn services_that_exited_among(
    engine: &Address,
    root: &Path,
    requested_services: Option<&std::collections::HashSet<&str>>,
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
        if requested_services.is_some_and(|requested| !requested.contains(service)) {
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

/// The deployment directory somebody typed, as a path.
///
/// Trimmed, the way the four settings entered beside it on the same screen already are. That screen
/// enables Start on `root.trim() !== ""` and then sends the untrimmed string, so a path pasted with
/// the space the selection picked up, or with the newline a copied line carries, arrives here whole
/// -- and this is the one of the five values that is not a credential but a place on disk.
///
/// A trailing space makes a second directory beside the one everything else means: the tray's Stop
/// and the next launch both ask `default_root`, which has no space in it, so a person is left with
/// a deployment nothing on screen can reach. A leading one is worse, because a path that begins
/// with a space does not begin with a separator: it stops being absolute, and the whole deployment
/// is laid out relative to wherever the window happens to be running from.
///
/// Only the ends. A space inside a path is part of a directory's name and stays where it is.
pub fn root_from(typed: &str) -> PathBuf {
    PathBuf::from(typed.trim())
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

    #[cfg(unix)]
    fn unix_fixture(pid: u32, parent: u32) -> UnixProcess {
        UnixProcess {
            pid,
            parent,
            start: format!("instance-{pid}"),
        }
    }

    #[cfg(unix)]
    fn unix_record(pid: u32) -> UnixHostProcess {
        UnixHostProcess {
            name: "app".into(),
            deployment: PathBuf::from("/owned"),
            pid,
            start: format!("instance-{pid}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_ownership_selects_only_recorded_instance_and_verified_descendants() {
        let live = [
            unix_fixture(101, 100),
            unix_fixture(102, 101),
            unix_fixture(103, 102),
            unix_fixture(201, 100),
            unix_fixture(202, 201),
        ];
        // The other root may have the same cwd/command: neither is an ownership input.
        let rows: Vec<_> = live.iter().map(|p| (p.pid, p.parent)).collect();
        let mut attempted = Vec::new();
        let count = stop_unix_records_with(
            Path::new("/owned"),
            &[unix_record(101)],
            &rows,
            |pid| Ok(live.iter().find(|p| p.pid == pid).cloned()),
            |pid| {
                attempted.push(pid);
                Ok(true)
            },
        )
        .unwrap();
        assert_eq!(count, 3);
        assert_eq!(attempted, [103, 102, 101]);
        for root in ["/other", "/owned-sibling"] {
            assert!(stop_unix_records_with(
                Path::new(root),
                &[unix_record(101)],
                &rows,
                |_| panic!("a different deployment is not inspected"),
                |_| panic!("a different deployment is not signaled")
            )
            .is_err());
        }
        assert_eq!(
            stop_unix_records_with(
                Path::new("/owned"),
                &[],
                &rows,
                |_| panic!("an unrecorded process is not inspected"),
                |_| panic!("an unrecorded process is not signaled")
            )
            .unwrap(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_reused_pids_and_changed_ancestry_never_authorize_a_signal() {
        let changed = UnixProcess {
            start: "reused".into(),
            ..unix_fixture(101, 100)
        };
        assert_eq!(
            stop_unix_records_with(
                Path::new("/owned"),
                &[unix_record(101)],
                &[(101, 100)],
                |_| Ok(Some(changed.clone())),
                |_| panic!("reused PID")
            )
            .unwrap(),
            0
        );
        let mut reads = 0;
        assert!(stop_unix_records_with(
            Path::new("/owned"),
            &[unix_record(101)],
            &[(101, 100), (102, 101)],
            |pid| {
                reads += 1;
                Ok(Some(if reads > 2 {
                    UnixProcess {
                        start: "changed-after-inventory".into(),
                        ..unix_fixture(pid, 100)
                    }
                } else {
                    unix_fixture(pid, if pid == 102 { 101 } else { 100 })
                }))
            },
            |_| panic!("changed instance must be revalidated")
        )
        .is_err());
        assert!(stop_unix_records_with(
            Path::new("/owned"),
            &[unix_record(101)],
            &[(101, 100), (102, 101)],
            |pid| Ok(Some(unix_fixture(pid, 100))),
            |_| panic!("changed parent")
        )
        .is_err());
        for pid in [
            0,
            1,
            std::process::id(),
            unsafe { libc::getppid() } as u32,
            u32::MAX,
        ] {
            assert!(stop_unix_records_with(
                Path::new("/owned"),
                &[unix_record(pid)],
                &[],
                |_| panic!("unsafe PID"),
                |_| panic!("unsafe PID")
            )
            .is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_cleanup_reports_failure_keeps_parent_and_attempts_other_owned_roots() {
        let live = [
            unix_fixture(101, 100),
            unix_fixture(102, 101),
            unix_fixture(201, 100),
        ];
        let mut attempted = Vec::new();
        let problem = stop_unix_records_with(
            Path::new("/owned"),
            &[unix_record(101), unix_record(201)],
            &[(101, 100), (102, 101), (201, 100)],
            |pid| Ok(live.iter().find(|p| p.pid == pid).cloned()),
            |pid| {
                attempted.push(pid);
                if pid == 102 {
                    Err(unix_ownership_problem(
                        "synthetic signal refusal for pid 102",
                    ))
                } else {
                    Ok(true)
                }
            },
        )
        .unwrap_err();
        assert_eq!(attempted, [102, 201]);
        assert!(problem.detail.unwrap().contains("synthetic signal refusal"));
        assert_eq!(
            stop_unix_records_with(
                Path::new("/owned"),
                &[unix_record(101)],
                &[(101, 100)],
                |_| Ok(Some(unix_fixture(101, 100))),
                |_| Ok(false)
            )
            .unwrap(),
            0
        );
        assert!(stop_unix_records_with(
            Path::new("/owned"),
            &[unix_record(101)],
            &[],
            |_| Err(unix_ownership_problem("inventory denied")),
            |_| panic!("lost inventory")
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn unix_inventory_command_failures_and_malformed_output_are_errors() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_root("unix-inventory");
        std::fs::create_dir_all(&root).unwrap();
        let ps = root.join("ps");
        assert!(unix_inventory_with(&ps)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("could not run"));
        for body in [
            "echo synthetic-ps-failure >&2; exit 9",
            "echo malformed",
            "exit 0",
            "printf '101 100\\n101 100\\n'",
        ] {
            std::fs::write(&ps, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&ps, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert!(unix_inventory_with(&ps).is_err(), "{body}");
        }
        std::fs::write(&ps, "#!/bin/sh\nprintf '101 100\\n102 101\\n'\n").unwrap();
        assert_eq!(unix_inventory_with(&ps).unwrap(), [(101, 100), (102, 101)]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unix_missing_legacy_corrupt_and_versioned_records_fail_closed() {
        let root = temp_root("unix-records");
        assert_eq!(stop_processes_under(&root).unwrap(), 0);
        record_host_pids(&root, &[42]).unwrap();
        assert!(stop_processes_under(&root)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("legacy"));
        assert_eq!(std::fs::read(host_pids_path(&root)).unwrap(), b"[42]");
        for raw in [
            "broken",
            "{\"version\":2,\"unix_processes\":[{\"pid\":42}]}",
            "{\"version\":3,\"unix_processes\":[]}",
        ] {
            std::fs::write(host_pids_path(&root), raw).unwrap();
            assert!(stop_processes_under(&root).is_err());
            assert_eq!(std::fs::read_to_string(host_pids_path(&root)).unwrap(), raw);
        }
        write_host_pid_file(
            &root,
            &serde_json::json!({"version":2,"unix_processes":[unix_record(101)]}),
        )
        .unwrap();
        assert_eq!(recorded_host_pids(&root).unwrap(), [101]);
        assert!(
            recorded_host_processes(&root).unwrap().is_empty(),
            "Windows v1 reader must not treat Unix records as Windows evidence"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn linux_identity_parser_uses_boot_and_start_ticks_and_rejects_malformed_inventory() {
        let raw = "101 (command with ) spaces) S 100 101 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 999 0";
        let first = parse_linux_process(101, raw, "boot-one").unwrap().unwrap();
        assert_eq!(first.parent, 100);
        assert_eq!(first.start, "linux:boot-one:999");
        assert_ne!(
            first.start,
            parse_linux_process(101, raw, "boot-two")
                .unwrap()
                .unwrap()
                .start
        );
        for bad in [
            "",
            "101 malformed",
            "101 (name) S 100",
            "102 (wrong-pid) S 100",
        ] {
            assert!(parse_linux_process(101, bad, "boot-one").is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_restart_refreshes_identity_and_retains_new_handle_on_persistence_failure() {
        let root = temp_root("unix-restart");
        std::fs::create_dir_all(&root).unwrap();
        let first = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let mut children = Vec::new();
        replace_host_process(&root, &mut children, "app", first).unwrap();
        let prior = std::fs::read(host_pids_path(&root)).unwrap();
        children[0].1.kill().unwrap();
        children[0].1.wait().unwrap();
        let replacement = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let replacement_pid = replacement.id();
        replace_host_process(&root, &mut children, "app", replacement).unwrap();
        assert_eq!(recorded_host_pids(&root).unwrap(), [replacement_pid]);
        assert_ne!(std::fs::read(host_pids_path(&root)).unwrap(), prior);
        children[0].1.kill().unwrap();
        children[0].1.wait().unwrap();
        std::fs::remove_file(host_pids_path(&root)).unwrap();
        std::fs::create_dir(host_pids_path(&root)).unwrap();
        let replacement = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let replacement_pid = replacement.id();
        let result = replace_host_process(&root, &mut children, "app", replacement);
        assert_eq!(children[0].1.id(), replacement_pid);
        let still_alive = children[0].1.try_wait().unwrap().is_none();
        children[0].1.kill().unwrap();
        children[0].1.wait().unwrap();
        assert!(still_alive);
        assert!(result
            .unwrap_err()
            .detail
            .unwrap()
            .contains("replace pidfile"));
        assert_eq!(std::fs::read_dir(root.join(".logs")).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_initial_inventory_does_not_own_a_direct_sibling_replacement() {
        let original = recorded_process("server", 9000, "/Date(1000)/");
        let rows = [
            live_process(9000, 7000, "/Date(1000)/"),
            live_process(9001, 7000, "/Date(2000)/"),
            live_process(9002, 8000, "/Date(3000)/"),
        ];
        let listing = "TCP 127.0.0.1:3001 0.0.0.0:0 LISTENING 9001\nTCP 127.0.0.1:3010 0.0.0.0:0 LISTENING 9002\n";
        assert_eq!(
            verified_openbot_root_pids(std::slice::from_ref(&original), &rows),
            [9000]
        );
        assert!(verified_openbot_pids_listening_on(
            listing,
            &[3001, 3010],
            std::slice::from_ref(&original),
            &rows
        )
        .is_empty());
        let replacement = recorded_process("server", 9001, "/Date(2000)/");
        assert_eq!(
            verified_openbot_pids_listening_on(
                listing,
                &[3001, 3010],
                &[original, replacement],
                &rows
            ),
            [9001]
        );
    }

    #[cfg(unix)]
    #[test]
    fn windows_held_replacement_cleanup_keeps_evidence_on_refusal() {
        let root = temp_root("windows-held-replacement-refusal");
        std::fs::create_dir_all(&root).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("held-refusal");
        let replacement = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let pid = replacement.id();
        let mut children = vec![("server", replacement)];
        let old = recorded_process("server", 9000, "/Date(1000)/");
        write_host_pid_file(
            &root,
            &serde_json::json!({"version":1,"processes":[old.clone()]}),
        )
        .unwrap();
        let row = live_process(pid, std::process::id(), "/Date(2000)/");
        std::fs::write(root.join("synthetic-inventory.json"), serde_json::to_vec(&serde_json::json!([{
            "ProcessId":pid,"ParentProcessId":row.parent_process_id,"ExecutablePath":row.executable_path,"CommandLine":row.command_line,"CreationDate":row.creation_date
        }])).unwrap()).unwrap();
        let result = stop_windows_host_children_with(
            &root,
            &mut children,
            &fixture.command("powershell"),
            &fixture.command("netstat"),
            &fixture.command("taskkill"),
        );
        let alive = children[0].1.try_wait().unwrap().is_none();
        children[0].1.kill().unwrap();
        children[0].1.wait().unwrap();
        let problem = result.unwrap_err();
        assert!(
            problem
                .detail
                .as_deref()
                .unwrap()
                .contains("synthetic held cleanup refused"),
            "{problem:?}"
        );
        assert!(alive);
        assert_eq!(
            recorded_host_processes(&root).unwrap(),
            [old, recorded_process("server", pid, "/Date(2000)/")]
        );
        assert!(fixture
            .log()
            .contains(&format!("taskkill\t/PID {pid} /T /F")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn windows_held_cleanup_refuses_missing_or_wrong_parent_identity_without_killing() {
        for parent in [0, std::process::id()] {
            let root = temp_root("windows-held-identity-refusal");
            std::fs::create_dir_all(&root).unwrap();
            let fixture = CleanupCommandFixture::new(&root);
            fixture.scenario("held-refusal");
            let replacement = Command::new("/bin/sleep").arg("60").spawn().unwrap();
            let pid = replacement.id();
            let mut children = vec![("server", replacement)];
            let original = serde_json::to_vec(&serde_json::json!({"version":1,"processes":[recorded_process("server",9000,"original")]})).unwrap();
            std::fs::create_dir_all(root.join(".logs")).unwrap();
            std::fs::write(host_pids_path(&root), &original).unwrap();
            std::fs::write(root.join("synthetic-inventory.json"),serde_json::to_vec(&serde_json::json!([{"ProcessId":pid,"ParentProcessId":parent,"ExecutablePath":"synthetic","CommandLine":"synthetic","CreationDate":if parent==0 {"instance"} else {""}}])).unwrap()).unwrap();
            let result = stop_windows_host_children_with(
                &root,
                &mut children,
                &fixture.command("powershell"),
                &fixture.command("netstat"),
                &fixture.command("taskkill"),
            );
            let alive = children[0].1.try_wait().unwrap().is_none();
            children[0].1.kill().unwrap();
            children[0].1.wait().unwrap();
            assert!(result.unwrap_err().said.contains("verify"));
            assert!(alive);
            assert_eq!(std::fs::read(host_pids_path(&root)).unwrap(), original);
            assert!(!fixture.log().contains("taskkill\t"));
            std::fs::remove_dir_all(root).unwrap();
        }
    }

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

    fn host_command_line(name: &str) -> &'static str {
        match name {
            "worker" => r#"bun --env-file=../.env src/index.ts"#,
            _ => r#"bun --env-file=../.env src/production-entry.ts"#,
        }
    }

    fn recorded_process(name: &str, pid: u32, creation_date: &str) -> RecordedHostProcess {
        RecordedHostProcess {
            name: name.to_string(),
            pid,
            executable_path: r"C:\Users\person\.bun\bin\bun.exe".to_string(),
            command_line: host_command_line(name).to_string(),
            creation_date: creation_date.to_string(),
        }
    }

    fn live_host_process(name: &str, pid: u32, parent: u32, creation_date: &str) -> WindowsProcess {
        WindowsProcess {
            process_id: pid,
            parent_process_id: parent,
            executable_path: Some(r"C:\Users\person\.bun\bin\bun.exe".to_string()),
            command_line: Some(host_command_line(name).to_string()),
            creation_date: Some(creation_date.to_string()),
        }
    }

    fn live_process(pid: u32, parent: u32, creation_date: &str) -> WindowsProcess {
        live_host_process("server", pid, parent, creation_date)
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
    let scenario = std::env::var("OPENBOT_FAKE_ENGINE_SCENARIO").unwrap();
    if scenario == "computer-stop" {
        let actual = if args.first().map(String::as_str) == Some("--connection") { &args[2..] } else { &args[..] };
        let without_file;
        let actual = if actual.get(1).map(String::as_str) == Some("-f") {
            without_file = std::iter::once(actual[0].clone()).chain(actual[3..].iter().cloned()).collect::<Vec<_>>();
            &without_file[..]
        } else { actual };
        match actual.first().map(String::as_str) {
            Some("compose") if actual.get(1).map(String::as_str) == Some("config") => {
                if std::path::Path::new(".fixture-config-failure").exists() { std::process::exit(17); }
                print!("{}", std::fs::read_to_string(".fixture-config").unwrap());
            }
            Some("ps") => {
                // Model the engine's AND-label filtering over owned, other-namespace, and
                // non-supervisor rows. The connected proof separately exercises the real daemon.
                let labels = [
                    ("current", "true", "fixture-selected"),
                    ("other", "true", "fixture-other"),
                    ("unowned", "false", "fixture-selected"),
                    ("default", "true", "openbot"),
                ];
                for (id, supervisor, namespace) in labels {
                    let matches = actual.windows(2).filter(|pair| pair[0] == "--filter").all(|pair| {
                        pair[1] == format!("label=openbot.supervisor={supervisor}")
                            || pair[1] == format!("label=openbot.namespace={namespace}")
                    });
                    if matches { println!("{id}"); }
                }
            }
            Some("stop") => {}
            Some("compose") if actual == ["compose", "--profile", "harness", "down"] => {}
            _ => std::process::exit(2),
        }
        return;
    }
    match (scenario.as_str(), joined.as_str()) {
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

    struct CleanupCommandFixture {
        previous_scenario: Option<std::ffi::OsString>,
        previous_root: Option<std::ffi::OsString>,
        previous_log: Option<std::ffi::OsString>,
        bin: PathBuf,
        log: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl CleanupCommandFixture {
        fn new(root: &Path) -> Self {
            static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let previous_scenario = std::env::var_os("DTA028_CLEANUP_SCENARIO");
            let previous_root = std::env::var_os("DTA028_CLEANUP_ROOT");
            let previous_log = std::env::var_os("DTA028_CLEANUP_LOG");
            let bin = temp_root("openbot-cleanup-command-bin");
            std::fs::create_dir_all(&bin).unwrap();
            let source = bin.join("cleanup_command.rs");
            std::fs::write(&source, CLEANUP_COMMAND_SOURCE).unwrap();
            let compiled = bin.join(if cfg!(windows) {
                "cleanup-command.exe"
            } else {
                "cleanup-command"
            });
            let rustc = std::env::var_os("RUSTC")
                .unwrap_or_else(|| "/Users/dmckay/.cargo/bin/rustc".into());
            let output = Command::new(rustc)
                .arg(&source)
                .arg("-o")
                .arg(&compiled)
                .output()
                .expect("rustc should run for cleanup command fixture");
            assert!(
                output.status.success(),
                "cleanup command fixture did not compile: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            for name in ["lsof", "netstat", "taskkill", "powershell"] {
                std::fs::copy(
                    &compiled,
                    bin.join(if cfg!(windows) {
                        format!("{name}.exe")
                    } else {
                        name.to_string()
                    }),
                )
                .unwrap();
            }
            let log = bin.join("commands.log");
            std::env::set_var("DTA028_CLEANUP_ROOT", root);
            std::env::set_var("DTA028_CLEANUP_LOG", &log);
            Self {
                previous_scenario,
                previous_root,
                previous_log,
                bin,
                log,
                _guard: guard,
            }
        }

        fn command(&self, name: &str) -> PathBuf {
            self.bin.join(if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.to_string()
            })
        }

        fn scenario(&self, scenario: &str) {
            std::env::set_var("DTA028_CLEANUP_SCENARIO", scenario);
            let _ = std::fs::remove_file(&self.log);
        }

        fn log(&self) -> String {
            std::fs::read_to_string(&self.log).unwrap_or_default()
        }
    }

    impl Drop for CleanupCommandFixture {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous_scenario {
                std::env::set_var("DTA028_CLEANUP_SCENARIO", previous);
            } else {
                std::env::remove_var("DTA028_CLEANUP_SCENARIO");
            }
            if let Some(previous) = &self.previous_root {
                std::env::set_var("DTA028_CLEANUP_ROOT", previous);
            } else {
                std::env::remove_var("DTA028_CLEANUP_ROOT");
            }
            if let Some(previous) = &self.previous_log {
                std::env::set_var("DTA028_CLEANUP_LOG", previous);
            } else {
                std::env::remove_var("DTA028_CLEANUP_LOG");
            }
            std::fs::remove_dir_all(&self.bin).ok();
        }
    }

    const CLEANUP_COMMAND_SOURCE: &str = r#"
use std::io::Write;

fn log(program: &str, args: &[String]) {
    if let Ok(path) = std::env::var("DTA028_CLEANUP_LOG") {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        writeln!(file, "{program}\t{}", args.join(" ")).unwrap();
    }
}

fn main() {
    let exe = std::env::current_exe().unwrap();
    let program = exe.file_stem().unwrap().to_string_lossy().into_owned();
    let args: Vec<String> = std::env::args().skip(1).collect();
    log(&program, &args);
    let scenario = std::env::var("DTA028_CLEANUP_SCENARIO").unwrap();
    let root = std::env::var("DTA028_CLEANUP_ROOT").unwrap_or_default();
    match (program.as_str(), scenario.as_str()) {
        ("powershell", "held-refusal") => print!("{}", std::fs::read_to_string(std::path::Path::new(&root).join("synthetic-inventory.json")).unwrap()),
        ("netstat", "held-refusal") => {},
        ("powershell", "already-running") => print!("{}", std::fs::read_to_string(std::path::Path::new(&root).join("synthetic-inventory.json")).unwrap()),
        ("netstat", "already-running") => {
            println!("  Proto  Local Address          Foreign Address        State           PID");
            println!("  TCP    127.0.0.1:45123        0.0.0.0:0              LISTENING       9000");
            println!("  TCP    127.0.0.1:45124        0.0.0.0:0              LISTENING       9002");
        },
        ("taskkill", "held-refusal") => { eprintln!("synthetic held cleanup refused"); std::process::exit(5); },
        ("powershell", "inventory-fail") => {
            print!("synthetic partial inventory that must not be trusted");
            std::process::exit(17);
        }
        ("powershell", "inventory-empty") => print!("[]"),
        ("powershell", "inventory-malformed") => print!("[{{"),
        ("powershell", "inventory-blank") => {},
        ("netstat", "inventory-empty")
        | ("netstat", "pidfile-mixed")
        | ("netstat", "pidfile-ok") => {},
        ("taskkill", "pidfile-mixed") => {
            if args.iter().any(|arg| arg == "9000") {
                eprintln!("synthetic taskkill status failure");
                std::process::exit(17);
            }
        }
        ("taskkill", "pidfile-ok") => {},
        ("lsof", "lsof-ok") => {
            println!("p101\nn{root}/server\np202\nn{root}\np303\nn{root}/worker");
        }
        ("lsof", "lsof-empty") => {}
        ("lsof", "lsof-fail") => {
            eprintln!("synthetic lsof status failure");
            std::process::exit(17);
        }
        ("netstat", "windows-ok") | ("netstat", "windows-taskkill-fail") => {
            println!("  Proto  Local Address          Foreign Address        State           PID");
            println!("  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       9000");
            println!("  TCP    127.0.0.1:3010         0.0.0.0:0              LISTENING       9001");
        }
        ("netstat", "windows-netstat-fail") => {
            eprintln!("synthetic netstat status failure");
            std::process::exit(19);
        }
        ("taskkill", "windows-ok") => {}
        ("taskkill", "windows-taskkill-fail") => {
            if args.iter().any(|arg| arg == "9000") {
                eprintln!("synthetic taskkill status failure");
                std::process::exit(5);
            }
        }
        _ => {
            eprintln!("unexpected cleanup command scenario: {program} {scenario}");
            std::process::exit(44);
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

    #[cfg(test)]
    #[test]
    fn windows_cleanup_returns_taskkill_failures_after_attempting_later_targets() {
        let listing = "\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       9000\r\n  TCP    127.0.0.1:3010         0.0.0.0:0              LISTENING       9001\r\n";
        let recorded = [recorded_process("app", 8636, "20260909010101.000000-420")];
        let processes = [
            live_process(8636, 7000, "20260909010101.000000-420"),
            live_process(9000, 8636, "20260909010102.000000-420"),
            live_process(9001, 8636, "20260909010103.000000-420"),
        ];
        let mut attempted = Vec::new();

        let problem = stop_windows_processes_in(&recorded, &processes, listing, |pid| {
            attempted.push(pid);
            if pid == 9000 {
                Err(Problem::with(
                    "OpenBot could not inspect or stop its host processes.",
                    format!("taskkill /PID {pid} /T /F exited with status 5"),
                ))
            } else {
                Ok(true)
            }
        })
        .expect_err("taskkill failure must be reported");

        assert_eq!(attempted, vec![9000, 9001]);
        assert_eq!(
            problem.said,
            "OpenBot could not inspect or stop its host processes."
        );
        assert!(
            problem
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("taskkill /PID 9000")),
            "{problem:?}"
        );
    }

    #[test]
    fn source_bound_windows_command_failures_use_disposable_commands() {
        let root = temp_root("openbot-source-bound-windows-cleanup");
        std::fs::create_dir_all(&root).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        let netstat = fixture.command("netstat");
        let taskkill = fixture.command("taskkill");
        let recorded = [recorded_process("app", 8636, "20260909010101.000000-420")];
        let processes = [
            live_process(8636, 7000, "20260909010101.000000-420"),
            live_process(9000, 8636, "20260909010102.000000-420"),
            live_process(9001, 8636, "20260909010103.000000-420"),
        ];

        fixture.scenario("windows-netstat-fail");
        let problem =
            stop_windows_processes_under_with(&root, &recorded, &processes, &netstat, &taskkill)
                .expect_err("netstat status failure must cross the production helper");
        assert!(
            problem
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("synthetic netstat status failure")),
            "{problem:?}"
        );

        fixture.scenario("windows-taskkill-fail");
        let problem =
            stop_windows_processes_under_with(&root, &recorded, &processes, &netstat, &taskkill)
                .expect_err("taskkill status failure must cross the production helper");
        let log = fixture.log();
        assert!(log.contains("netstat\t-ano -p tcp"), "{log}");
        assert!(log.contains("taskkill\t/PID 9000 /T /F"), "{log}");
        assert!(
            log.contains("taskkill\t/PID 9001 /T /F"),
            "later owned target was not attempted: {log}"
        );
        assert!(
            problem
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("synthetic taskkill status failure")),
            "{problem:?}"
        );

        fixture.scenario("windows-ok");
        let stopped =
            stop_windows_processes_under_with(&root, &recorded, &processes, &netstat, &taskkill)
                .expect("all synthetic Windows cleanup commands should succeed");
        assert_eq!(stopped, 3);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn windows_pidfile_preserves_all_records_on_partial_failure_and_retries() {
        let root = temp_root("windows-pidfile-retry");
        let recorded = [
            recorded_process("server", 9000, "/Date(1000)/"),
            recorded_process("worker", 9001, "/Date(2000)/"),
        ];
        let processes = [
            live_host_process("server", 9000, 0, "/Date(1000)/"),
            live_host_process("worker", 9001, 0, "/Date(2000)/"),
        ];
        write_host_pid_file(
            &root,
            &serde_json::json!({"version": 1, "processes": recorded}),
        )
        .unwrap();
        let path = host_pids_path(&root);
        let before = std::fs::read(&path).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("pidfile-mixed");
        let problem = stop_windows_processes_under_with(
            &root,
            &recorded,
            &processes,
            &fixture.command("netstat"),
            &fixture.command("taskkill"),
        )
        .expect_err("a failed root must retain ownership evidence for retry");
        assert!(problem.detail.unwrap().contains("17"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let log = fixture.log();
        assert!(log.contains("taskkill\t/PID 9000 /T /F"), "{log}");
        assert!(log.contains("taskkill\t/PID 9001 /T /F"), "{log}");

        fixture.scenario("pidfile-ok");
        let retry_records = recorded_host_processes(&root).unwrap();
        assert_eq!(
            stop_windows_processes_under_with(
                &root,
                &retry_records,
                &processes[..1],
                &fixture.command("netstat"),
                &fixture.command("taskkill"),
            )
            .unwrap(),
            1
        );
        assert!(!path.exists());
        assert!(!fixture.log().contains("/PID 9001"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_pidfile_unknown_identity_is_preserved_without_killing_any_process() {
        let root = temp_root("windows-pidfile-unknown-identity");
        let recorded = [recorded_process("server", 9000, "/Date(1000)/")];
        write_host_pid_file(
            &root,
            &serde_json::json!({"version": 1, "processes": recorded}),
        )
        .unwrap();
        let path = host_pids_path(&root);
        let before = std::fs::read(&path).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        let mut cases: Vec<_> = [None, Some(String::new())]
            .into_iter()
            .flat_map(|missing| (0..3).map(move |field| (field, missing.clone())))
            .collect();
        cases.extend([
            (2, Some("invalid-date".to_string())),
            (2, Some("20260931010101.000000+000".to_string())),
        ]);
        for (field, missing) in cases {
            let mut live = live_process(9000, 0, "/Date(1000)/");
            match field {
                0 => live.executable_path = missing.clone(),
                1 => live.command_line = missing.clone(),
                _ => live.creation_date = missing.clone(),
            }
            fixture.scenario("pidfile-ok");
            let problem = stop_windows_processes_under_with(
                &root,
                &recorded,
                &[live],
                &fixture.command("netstat"),
                &fixture.command("taskkill"),
            )
            .expect_err("an unresolved identity field does not prove PID reuse or exit");
            let detail = problem.detail.unwrap();
            assert!(detail.contains("9000"), "{detail}");
            assert!(detail.contains(&path.display().to_string()), "{detail}");
            assert_eq!(std::fs::read(&path).unwrap(), before);
            assert_eq!(fixture.log(), "");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_pidfile_removal_requires_successful_cleanup_and_reports_remove_errors() {
        let root = temp_root("windows-pidfile-remove");
        let recorded = [recorded_process("server", 9000, "/Date(1000)/")];
        let fixture = CleanupCommandFixture::new(&root);
        let path = host_pids_path(&root);
        for processes in [vec![], vec![live_process(9000, 0, "/Date(2000)/")]] {
            write_host_pid_file(
                &root,
                &serde_json::json!({"version": 1, "processes": recorded}),
            )
            .unwrap();
            fixture.scenario("pidfile-ok");
            assert_eq!(
                stop_windows_processes_under_with(
                    &root,
                    &recorded,
                    &processes,
                    &fixture.command("netstat"),
                    &fixture.command("taskkill"),
                )
                .unwrap(),
                0
            );
            assert!(!path.exists());
            assert!(!fixture.log().contains("taskkill\t"));
        }
        std::fs::create_dir(&path).unwrap();
        let problem = stop_windows_processes_under_with(
            &root,
            &[],
            &[],
            &fixture.command("netstat"),
            &fixture.command("taskkill"),
        )
        .expect_err("a required pidfile removal failure must be reported");
        let detail = problem.detail.unwrap();
        assert!(detail.contains("could not remove pidfile"), "{detail}");
        assert!(detail.contains(&path.display().to_string()), "{detail}");
        assert!(path.is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(test)]
    #[test]
    fn windows_cleanup_success_counts_verified_listening_children() {
        let listing = "\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       424242\r\n  TCP    127.0.0.1:3010         0.0.0.0:0              LISTENING       9000\r\n";
        let recorded = [recorded_process("app", 8636, "20260909010101.000000-420")];
        let processes = [
            live_process(8636, 7000, "20260909010101.000000-420"),
            live_process(9000, 8636, "20260909010102.000000-420"),
        ];
        let mut attempted = Vec::new();

        let stopped = stop_windows_processes_in(&recorded, &processes, listing, |pid| {
            attempted.push(pid);
            Ok(true)
        })
        .expect("verified child cleanup should succeed");

        assert_eq!(stopped, 1);
        assert_eq!(attempted, vec![9000]);
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

    #[cfg(unix)]
    fn spawn_owned_listener(label: &str) -> (std::process::Child, u16) {
        let dir = temp_root(label);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("listener.rs");
        std::fs::write(
            &source,
            r#"
use std::io::Write;
use std::net::TcpListener;
fn main() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    println!("{}", listener.local_addr().unwrap().port());
    std::io::stdout().flush().unwrap();
    std::thread::sleep(std::time::Duration::from_secs(60));
}
"#,
        )
        .unwrap();
        let binary = dir.join("listener");
        let rustc =
            std::env::var_os("RUSTC").unwrap_or_else(|| "/Users/dmckay/.cargo/bin/rustc".into());
        let output = Command::new(rustc)
            .arg(&source)
            .arg("-o")
            .arg(&binary)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "listener helper did not compile: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut child = Command::new(&binary)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut port = String::new();
        use std::io::BufRead;
        std::io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut port)
            .unwrap();
        let port = port.trim().parse().unwrap();
        (child, port)
    }

    #[cfg(unix)]
    #[test]
    fn unix_lsof_pid_parser_keeps_only_pid_fields_once() {
        let listing = "p111\nf3\nnTCP 127.0.0.1:3010 (LISTEN)\np222\nf4\np111\nnot-a-pid\npbad\n";
        assert_eq!(parse_lsof_pid_fields(listing), vec![111, 222]);
    }

    #[cfg(unix)]
    #[test]
    fn unix_recorded_server_ownership_requires_the_recorded_process_to_own_the_port() {
        let root_a = temp_root("unix-already-running-root-a");
        let root_b = temp_root("unix-already-running-root-b");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();
        let mut inert = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let (mut listener, port) = spawn_owned_listener("unix-already-running-listener-b");
        record_host_processes(&root_a, &[("server", inert.id())]).unwrap();
        record_host_processes(&root_b, &[("server", listener.id())]).unwrap();

        assert!(
            !recorded_server_owns_port(&root_a, port).unwrap(),
            "root A recorded a live server PID, but a different process owns the answering port"
        );
        assert!(
            recorded_server_owns_port(&root_b, port).unwrap(),
            "root B recorded the process that owns the answering port"
        );

        let _ = inert.kill();
        let _ = inert.wait();
        let _ = listener.kill();
        let _ = listener.wait();
        std::fs::remove_dir_all(root_a).unwrap();
        std::fs::remove_dir_all(root_b).unwrap();
    }

    #[test]
    fn recorded_server_ownership_requires_matching_identity_on_listening_port() {
        let root = temp_root("openbot-already-running-windows-owner");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("already-running");
        let recorded = recorded_process("server", 9000, "20260909010101.000000-420");
        write_host_pid_file(
            &root,
            &serde_json::json!({"version":1,"processes":[recorded]}),
        )
        .unwrap();
        std::fs::write(
            root.join("synthetic-inventory.json"),
            serde_json::to_vec(&serde_json::json!([
                {"ProcessId":9000,"ParentProcessId":7000,"ExecutablePath":r"C:\Users\person\.bun\bin\bun.exe","CommandLine":host_command_line("server"),"CreationDate":"20260909010101.000000-420"},
                {"ProcessId":9002,"ParentProcessId":7000,"ExecutablePath":r"C:\Users\person\.bun\bin\bun.exe","CommandLine":host_command_line("server"),"CreationDate":"20260909020202.000000-420"}
            ]))
            .unwrap(),
        )
        .unwrap();

        assert!(recorded_process_owns_port_windows_with(
            &root,
            "server",
            45123,
            &fixture.command("powershell"),
            &fixture.command("netstat")
        )
        .unwrap());
        assert!(!recorded_process_owns_port_windows_with(
            &root,
            "server",
            45124,
            &fixture.command("powershell"),
            &fixture.command("netstat")
        )
        .unwrap());
        let log = fixture.log();
        assert!(log.contains("powershell\t"), "{log}");
        assert!(log.contains("netstat\t-ano -p tcp"), "{log}");
        assert!(!log.contains("taskkill\t"), "{log}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recorded_server_ownership_is_false_without_current_records() {
        let root = temp_root("openbot-already-running-no-owner");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("already-running");
        assert!(!recorded_process_owns_port_windows_with(
            &root,
            "server",
            45123,
            &fixture.command("powershell"),
            &fixture.command("netstat")
        )
        .unwrap());
        assert!(fixture.log().is_empty(), "{}", fixture.log());
        std::fs::remove_dir_all(root).unwrap();
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

    struct UnserializablePidfile;

    impl Serialize for UnserializablePidfile {
        fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("synthetic serializer refusal"))
        }
    }

    #[test]
    fn pidfile_serialization_failure_preserves_prior_evidence() {
        let root = temp_root("pidfile-serialization");
        let path = host_pids_path(&root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"[42]").unwrap();
        let problem = write_host_pid_file(&root, &UnserializablePidfile).unwrap_err();
        let detail = problem.detail.unwrap();
        assert!(
            detail.contains("serialize pidfile") && detail.contains("synthetic serializer refusal")
        );
        assert!(detail.contains(&path.display().to_string()));
        assert_eq!(std::fs::read(&path).unwrap(), b"[42]");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pidfile_writes_report_filesystem_obstructions_without_partial_files() {
        let root = temp_root("pidfile-obstruction");
        std::fs::create_dir_all(&root).unwrap();
        let path = host_pids_path(&root);
        let logs = root.join(".logs");
        std::fs::write(&logs, b"prior obstruction").unwrap();
        let problem = record_host_pids(&root, &[42]).unwrap_err();
        let detail = problem.detail.unwrap();
        assert!(detail.contains(&path.display().to_string()));
        assert!(detail.contains("parent directory"));
        assert_eq!(std::fs::read(&logs).unwrap(), b"prior obstruction");
        std::fs::remove_file(&logs).unwrap();
        std::fs::create_dir_all(&path).unwrap();
        let problem = record_host_pids(&root, &[42]).unwrap_err();
        let detail = problem.detail.unwrap();
        assert!(detail.contains(&path.display().to_string()));
        assert!(detail.contains("replace pidfile"));
        assert!(path.is_dir());
        assert_eq!(std::fs::read_dir(&logs).unwrap().count(), 1);
        std::fs::remove_dir(&path).unwrap();
        record_host_pids(&root, &[42]).unwrap();
        record_host_pids(&root, &[43, 44]).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"[43,44]");
        assert_eq!(recorded_host_pids(&root).unwrap(), [43, 44]);
        assert_eq!(std::fs::read_dir(&logs).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn pidfile_denied_replacement_preserves_previous_record_and_removes_temporary() {
        let root = temp_root("pidfile-denied-replacement");
        record_host_pids(&root, &[42]).unwrap();
        let path = host_pids_path(&root);
        assert!(Command::new("/usr/bin/chflags")
            .arg("uchg")
            .arg(&path)
            .status()
            .unwrap()
            .success());
        let result = record_host_pids(&root, &[43]);
        // Release the fixture's immutable flag before assertions, including on a writer failure.
        assert!(Command::new("/usr/bin/chflags")
            .arg("nouchg")
            .arg(&path)
            .status()
            .unwrap()
            .success());
        let detail = result.unwrap_err().detail.unwrap();
        assert!(detail.contains("replace pidfile"), "{detail}");
        assert!(detail.contains(&path.display().to_string()));
        assert_eq!(std::fs::read(&path).unwrap(), b"[42]");
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The pids survive the window that started them, which is the whole point of writing them.
    #[test]
    fn recorded_pids_are_read_back_and_a_missing_file_is_not_an_error() {
        let dir = temp_root("pids");
        std::fs::create_dir_all(&dir).unwrap();

        // Nothing recorded is an empty list, not a panic: a deployment somebody started by hand
        // has no pidfile at all.
        assert!(recorded_host_pids(&dir).unwrap().is_empty());

        record_host_pids(&dir, &[4242, 4243, 4244]).unwrap();
        assert_eq!(recorded_host_pids(&dir).unwrap(), vec![4242, 4243, 4244]);

        // Corrupt evidence must stop cleanup before any process is selected.
        std::fs::write(host_pids_path(&dir), "not json").unwrap();
        assert!(recorded_host_pids(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pidfile_readers_distinguish_missing_legacy_records_and_untrusted_evidence() {
        let root = temp_root("pidfile-evidence");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let path = host_pids_path(&root);
        assert!(recorded_host_pids(&root).unwrap().is_empty());
        assert!(recorded_host_processes(&root).unwrap().is_empty());
        record_host_pids(&root, &[42]).unwrap();
        assert_eq!(recorded_host_pids(&root).unwrap(), [42]);
        let legacy = recorded_host_processes(&root).unwrap();
        assert!(verified_openbot_root_pids(&legacy, &[live_process(42, 0, "created")]).is_empty());
        let recorded = recorded_process("server", 42, "created");
        write_host_pid_file(
            &root,
            &serde_json::json!({"version": 1, "processes": [recorded]}),
        )
        .unwrap();
        assert_eq!(recorded_host_pids(&root).unwrap(), [42]);
        assert_eq!(recorded_host_processes(&root).unwrap(), [recorded]);
        for bytes in [
            b"not json".as_slice(),
            b"\xff",
            br#"{"version":2,"processes":[]}"#,
            br#"{"version":1,"processes":[{}]}"#,
        ] {
            std::fs::write(&path, bytes).unwrap();
            for problem in [
                recorded_host_pids(&root).unwrap_err(),
                recorded_host_processes(&root).unwrap_err(),
            ] {
                assert!(problem
                    .detail
                    .unwrap()
                    .contains(&path.display().to_string()));
            }
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(recorded_host_pids(&root)
            .unwrap_err()
            .detail
            .unwrap()
            .contains(&path.display().to_string()));
        assert!(recorded_host_processes(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_inventory_requires_a_complete_typed_json_result() {
        assert!(windows_processes_in("[]").unwrap().is_empty());
        let one = r#"{"ProcessId":42,"ParentProcessId":0,"ExecutablePath":"bun.exe","CommandLine":"bun serve","CreationDate":"created"}"#;
        assert_eq!(windows_processes_in(one).unwrap().len(), 1);
        assert_eq!(
            windows_processes_in(&format!("[{one},{one}]"))
                .unwrap()
                .len(),
            2
        );
        for text in [
            "",
            "  ",
            "null",
            "{}",
            "[{}]",
            "[",
            "[42]",
            r#"{"ProcessId":"42","ParentProcessId":0}"#,
        ] {
            assert!(windows_processes_in(text).is_err(), "{text}");
        }
        assert!(windows_processes_in(&format!("[{one},{{}}]")).is_err());
        for text in ["[]", one] {
            let expected = windows_processes_in(text).unwrap();
            let utf16: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
            assert_eq!(windows_process_output(&utf16).unwrap(), expected);
            assert_eq!(
                windows_process_output(&[&[0xff, 0xfe], utf16.as_slice()].concat()).unwrap(),
                expected
            );
            assert_eq!(
                windows_process_output(&[&[0xef, 0xbb, 0xbf], text.as_bytes()].concat()).unwrap(),
                expected
            );
        }
        for bytes in [b"\xff".as_slice(), b"\xff\xfe[", b"\xff\xfe\x00\xd8"] {
            assert!(windows_process_output(bytes).is_err());
        }
        let recorded = recorded_process("server", 42, "created");
        for live in [
            WindowsProcess {
                process_id: 43,
                ..live_process(42, 0, "created")
            },
            WindowsProcess {
                executable_path: Some("other.exe".into()),
                ..live_process(42, 0, "created")
            },
            WindowsProcess {
                command_line: Some("other args".into()),
                ..live_process(42, 0, "created")
            },
            live_process(42, 0, "reused"),
        ] {
            assert!(
                verified_openbot_root_pids(std::slice::from_ref(&recorded), &[live]).is_empty()
            );
        }
    }

    #[test]
    fn windows_recording_refuses_partial_inventory_without_replacing_pidfile() {
        let root = temp_root("windows-record-partial-inventory");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("held-refusal");
        let path = host_pids_path(&root);
        let prior = br#"{"version":1,"processes":[{"name":"server","pid":7000,"executable_path":"prior.exe","command_line":"prior","creation_date":"prior-created"}]}"#;
        std::fs::write(&path, prior).unwrap();
        std::fs::write(
            root.join("synthetic-inventory.json"),
            serde_json::to_vec(&serde_json::json!([
                {"ProcessId":42,"ParentProcessId":0,"ExecutablePath":"bun.exe","CommandLine":"bun src/index.ts","CreationDate":"created-server"},
                {"ProcessId":44,"ParentProcessId":0,"ExecutablePath":"bun.exe","CommandLine":"bun src/index.ts","CreationDate":"created-worker"},
                {"ProcessId":999,"ParentProcessId":0,"ExecutablePath":"other.exe","CommandLine":"other","CreationDate":"created-other"}
            ])).unwrap(),
        )
        .unwrap();

        let problem = record_windows_host_processes_with(
            &root,
            &[("server", 42), ("app", 43), ("worker", 44)],
            &fixture.command("powershell"),
        )
        .expect_err("a missing requested live pid must not produce partial ownership evidence");

        let detail = problem.detail.as_deref().unwrap_or_default();
        assert!(detail.contains("app") && detail.contains("43"), "{detail}");
        assert_eq!(std::fs::read(&path).unwrap(), prior);
        let log = fixture.log();
        assert!(
            log.contains("powershell\t-NoProfile -NonInteractive -Command"),
            "{log}"
        );
        assert!(
            !log.contains("taskkill\t") && !log.contains("netstat\t"),
            "{log}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_recording_refuses_incomplete_identity_without_replacing_pidfile() {
        for (field, value) in [
            ("ExecutablePath", serde_json::Value::Null),
            ("CommandLine", serde_json::Value::Null),
            ("CreationDate", serde_json::Value::String(String::new())),
        ] {
            let root = temp_root("windows-record-incomplete-identity");
            std::fs::create_dir_all(root.join(".logs")).unwrap();
            let fixture = CleanupCommandFixture::new(&root);
            fixture.scenario("held-refusal");
            let path = host_pids_path(&root);
            let prior = b"[]";
            std::fs::write(&path, prior).unwrap();
            let mut row = serde_json::json!({
                "ProcessId":42,
                "ParentProcessId":0,
                "ExecutablePath":"bun.exe",
                "CommandLine":"bun src/index.ts",
                "CreationDate":"created-server"
            });
            row.as_object_mut()
                .unwrap()
                .insert(field.to_string(), value);
            std::fs::write(
                root.join("synthetic-inventory.json"),
                serde_json::to_vec(&serde_json::json!([row])).unwrap(),
            )
            .unwrap();

            let problem = record_windows_host_processes_with(
                &root,
                &[("server", 42)],
                &fixture.command("powershell"),
            )
            .expect_err("a requested pid with incomplete identity must not be omitted");

            let detail = problem.detail.as_deref().unwrap_or_default();
            assert!(
                detail.contains("server") && detail.contains("42"),
                "{detail}"
            );
            assert!(detail.contains("identity"), "{detail}");
            assert_eq!(std::fs::read(&path).unwrap(), prior);
            assert!(!fixture.log().contains("taskkill\t"));
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn windows_recording_refuses_duplicate_inventory_rows_without_replacing_pidfile() {
        let root = temp_root("windows-record-duplicate-inventory");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("held-refusal");
        let path = host_pids_path(&root);
        let prior = b"[]";
        std::fs::write(&path, prior).unwrap();
        std::fs::write(
            root.join("synthetic-inventory.json"),
            serde_json::to_vec(&serde_json::json!([
                {"ProcessId":42,"ParentProcessId":0,"ExecutablePath":"first.exe","CommandLine":"first","CreationDate":"created-first"},
                {"ProcessId":42,"ParentProcessId":0,"ExecutablePath":"second.exe","CommandLine":"second","CreationDate":"created-second"}
            ]))
            .unwrap(),
        )
        .unwrap();

        let problem = record_windows_host_processes_with(
            &root,
            &[("server", 42)],
            &fixture.command("powershell"),
        )
        .expect_err("duplicate inventory rows for one pid cannot identify one process instance");

        let detail = problem.detail.as_deref().unwrap_or_default();
        assert!(
            detail.contains("more than once") && detail.contains("42"),
            "{detail}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), prior);
        let log = fixture.log();
        assert!(
            log.contains("powershell\t-NoProfile -NonInteractive -Command"),
            "{log}"
        );
        assert!(
            !log.contains("taskkill\t") && !log.contains("netstat\t"),
            "{log}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_recording_refuses_duplicate_requested_hosts_without_inventory_or_replacement() {
        let root = temp_root("windows-record-duplicate-request");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("held-refusal");
        let path = host_pids_path(&root);
        let prior = b"[]";
        std::fs::write(&path, prior).unwrap();

        let problem = record_windows_host_processes_with(
            &root,
            &[("server", 42), ("server", 43)],
            &fixture.command("powershell"),
        )
        .expect_err("duplicate requested host names must not replace ownership evidence");

        let detail = problem.detail.as_deref().unwrap_or_default();
        assert!(
            detail.contains("duplicate") && detail.contains("server"),
            "{detail}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), prior);
        assert_eq!(fixture.log(), "");

        let problem = record_windows_host_processes_with(
            &root,
            &[("server", 42), ("app", 42)],
            &fixture.command("powershell"),
        )
        .expect_err("duplicate requested pids must not replace ownership evidence");
        let detail = problem.detail.as_deref().unwrap_or_default();
        assert!(
            detail.contains("duplicate") && detail.contains("42"),
            "{detail}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), prior);
        assert_eq!(fixture.log(), "");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_recording_writes_all_requested_records_and_ignores_extra_rows() {
        let root = temp_root("windows-record-complete-inventory");
        std::fs::create_dir_all(&root).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("held-refusal");
        std::fs::write(
            root.join("synthetic-inventory.json"),
            serde_json::to_vec(&serde_json::json!([
                {"ProcessId":42,"ParentProcessId":0,"ExecutablePath":"server.exe","CommandLine":"server args","CreationDate":"created-server"},
                {"ProcessId":43,"ParentProcessId":0,"ExecutablePath":"app.exe","CommandLine":"app args","CreationDate":"created-app"},
                {"ProcessId":44,"ParentProcessId":0,"ExecutablePath":"worker.exe","CommandLine":"worker args","CreationDate":"created-worker"},
                {"ProcessId":999,"ParentProcessId":0,"ExecutablePath":"other.exe","CommandLine":"other args","CreationDate":"created-other"}
            ])).unwrap(),
        )
        .unwrap();

        record_windows_host_processes_with(
            &root,
            &[("server", 42), ("app", 43), ("worker", 44)],
            &fixture.command("powershell"),
        )
        .unwrap();

        let records = recorded_host_processes(&root).unwrap();
        assert_eq!(records.len(), 3);
        assert_eq!(
            records[0],
            RecordedHostProcess {
                name: "server".to_string(),
                pid: 42,
                executable_path: "server.exe".to_string(),
                command_line: "server args".to_string(),
                creation_date: "created-server".to_string(),
            }
        );
        assert_eq!(
            records[1],
            RecordedHostProcess {
                name: "app".to_string(),
                pid: 43,
                executable_path: "app.exe".to_string(),
                command_line: "app args".to_string(),
                creation_date: "created-app".to_string(),
            }
        );
        assert_eq!(
            records[2],
            RecordedHostProcess {
                name: "worker".to_string(),
                pid: 44,
                executable_path: "worker.exe".to_string(),
                command_line: "worker args".to_string(),
                creation_date: "created-worker".to_string(),
            }
        );
        assert!(!records.iter().any(|record| record.pid == 999));
        let log = fixture.log();
        assert!(
            log.contains("powershell\t-NoProfile -NonInteractive -Command"),
            "{log}"
        );
        assert!(
            !log.contains("taskkill\t") && !log.contains("netstat\t"),
            "{log}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_inventory_command_errors_preserve_pidfiles_and_select_no_processes() {
        let root = temp_root("inventory-command-evidence");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        let powershell = fixture.command("powershell");
        let netstat = fixture.command("netstat");
        let taskkill = fixture.command("taskkill");
        let path = host_pids_path(&root);
        for scenario in ["inventory-fail", "inventory-malformed", "inventory-blank"] {
            fixture.scenario(scenario);
            std::fs::write(&path, "[]").unwrap();
            assert!(windows_processes_with(&powershell).is_err());
            assert!(
                stop_windows_processes_with_inventory(&root, &powershell, &netstat, &taskkill)
                    .is_err()
            );
            assert!(
                record_windows_host_processes_with(&root, &[("server", 42)], &powershell).is_err()
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "[]");
            let log = fixture.log();
            assert!(
                log.contains("powershell\t-NoProfile -NonInteractive -Command"),
                "{log}"
            );
            assert!(log.contains("$ErrorActionPreference = 'Stop'"), "{log}");
            assert!(log.contains("-InputObject @("), "{log}");
            assert!(
                !log.contains("taskkill\t") && !log.contains("netstat\t"),
                "{log}"
            );
        }
        let missing = root.join("no-powershell");
        assert!(windows_processes_with(&missing).is_err());
        assert!(
            stop_windows_processes_with_inventory(&root, &missing, &netstat, &taskkill).is_err()
        );
        assert!(record_windows_host_processes_with(&root, &[("server", 42)], &missing).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[]");
        fixture.scenario("inventory-empty");
        std::fs::write(&path, "invalid").unwrap();
        assert!(
            stop_windows_processes_with_inventory(&root, &powershell, &netstat, &taskkill).is_err()
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "invalid");
        assert_eq!(fixture.log(), "");
        std::fs::write(&path, "[]").unwrap();
        assert_eq!(
            stop_windows_processes_with_inventory(&root, &powershell, &netstat, &taskkill).unwrap(),
            0
        );
        assert!(!fixture.log().contains("taskkill\t"));
        std::fs::remove_dir_all(root).unwrap();
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
    fn a_deployment_directory_pasted_with_a_stray_space_is_the_one_it_names() {
        // The fifth value on the setup screen that trimming missed. The screen enables Start on
        // `root.trim() !== ""` and then sends the untrimmed string, which is exactly what the API
        // URL, the gateway URL, the intelligence key and the model key were rescued from.
        //
        // A trailing space is a second directory beside the one everything else means: the tray's
        // Stop and the next launch both ask `default_root`, which has no space in it. A leading one
        // is worse, because a path that begins with a space does not begin with a separator: the
        // whole deployment stops being absolute and lands under wherever the window is running
        // from.
        assert_eq!(
            root_from("  /home/me/OpenBot  "),
            PathBuf::from("/home/me/OpenBot")
        );
        assert_eq!(
            root_from("/home/me/OpenBot\n"),
            PathBuf::from("/home/me/OpenBot")
        );
        assert!(
            root_from(" /home/me/OpenBot").has_root(),
            "a leading space turned an absolute path into a relative one"
        );
    }

    #[test]
    fn a_space_inside_the_path_is_part_of_the_path() {
        // Only the ends. "Documents and Settings" is a directory, and a person whose home has a
        // space in it must still be able to say where OpenBot lives.
        assert_eq!(
            root_from("/home/me/My Files/OpenBot"),
            PathBuf::from("/home/me/My Files/OpenBot")
        );
        assert_eq!(
            root_from(r"C:\Users\me\Open Bot"),
            PathBuf::from(r"C:\Users\me\Open Bot")
        );
        // And an ordinary path is handed back exactly as it was.
        assert_eq!(
            root_from("/home/me/OpenBot"),
            PathBuf::from("/home/me/OpenBot")
        );
    }

    #[test]
    fn a_port_nobody_holds_is_not_reported_as_taken() {
        // 0 is never listening; this asserts the check does not invent a problem.
        assert!(port_already_taken(&[("nothing", 1)]).is_none());
    }

    /// The published side of a mapping, which is the only side anything on this machine binds.
    /// A plan is not a key, and provider-specific Bots are not raised to fail.
    #[test]
    fn bundled_bot_service_selection_follows_the_selected_provider() {
        for bot in [AGENT_BOT, AGENT_LANGGRAPH] {
            assert!(
                !SERVICES.contains(&bot),
                "{bot} is started unconditionally as well"
            );
        }

        let no_key = selected_services(false, BundledBots::none());
        assert!(!no_key.contains(&AGENT_BOT));
        assert!(!no_key.contains(&AGENT_LANGGRAPH));

        let openai = selected_services(false, BundledBots::openai_compatible());
        assert!(openai.contains(&AGENT_BOT));
        assert!(openai.contains(&AGENT_LANGGRAPH));

        let anthropic = selected_services(false, BundledBots::anthropic());
        assert!(
            !anthropic.contains(&AGENT_BOT),
            "Anthropic credentials must not start the OpenAI-only managed Bot"
        );
        assert!(anthropic.contains(&AGENT_LANGGRAPH));

        let picked = selected_services(true, BundledBots::none());
        assert!(picked.contains(&"agent-harness"));
    }

    /// Stop has to name the profile, or the one Bot the person picked keeps running.
    #[test]
    fn stopping_names_the_harness_profile() {
        let source = include_str!("stack.rs");
        assert!(
            source
                .contains(r#".args(["-f", "docker-compose.yml", "--profile", "harness", "down"])"#),
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

    fn computer_stop_root(path: &PathFixture, label: &str, config: &str) -> (PathBuf, PathBuf) {
        let root = path.bin.join(label);
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("docker-compose.yml"), "services: {}\n").unwrap();
        std::fs::write(root.join(".fixture-config"), config).unwrap();
        let record = path.bin.join(format!("{label}.log"));
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        (root, record)
    }

    fn resolved_namespace_fixture(namespace: &str) -> String {
        serde_json::json!({"services":{"supervisor":{"environment":{"COMPUTER_NAMESPACE":namespace}}}}).to_string()
    }

    #[test]
    fn computer_stop_filters_both_ownership_and_selected_namespace_for_each_engine() {
        let path = PathFixture::with_fake_engine("computer-stop");
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        std::fs::copy(
            path.bin.join(format!("docker{suffix}")),
            path.bin.join(format!("podman{suffix}")),
        )
        .unwrap();
        for (engine, connection, prefix) in [
            (crate::engine::Engine::Docker, None, ""),
            (
                crate::engine::Engine::Podman,
                Some("fixture-machine".into()),
                "--connection fixture-machine ",
            ),
        ] {
            let (root, record) = computer_stop_root(
                &path,
                &format!("root-{}", engine.binary()),
                &resolved_namespace_fixture("fixture-selected"),
            );
            down(&Address::new(engine, connection), &root).unwrap();
            let log = std::fs::read_to_string(record).unwrap();
            assert!(
                log.contains(&format!(
                    "{prefix}compose -f docker-compose.yml config --format json"
                )),
                "{log}"
            );
            assert!(log.contains(&format!("{prefix}ps --quiet --filter label=openbot.supervisor=true --filter label=openbot.namespace=fixture-selected")), "{log}");
            assert!(
                log.lines()
                    .any(|line| line.ends_with(&format!("\t{prefix}stop current"))),
                "{log}"
            );
            assert!(
                !log.contains("stop current other") && !log.contains("stop unowned"),
                "{log}"
            );
            assert!(
                log.contains(&format!(
                    "{prefix}compose -f docker-compose.yml --profile harness down"
                )),
                "{log}"
            );
        }
    }

    #[test]
    fn computer_stop_preserves_supervisor_default_and_trim_rules() {
        let path = PathFixture::with_fake_engine("computer-stop");
        for (index, namespace) in ["openbot", "", "  ", " fixture-selected "]
            .iter()
            .enumerate()
        {
            let (root, record) = computer_stop_root(
                &path,
                &format!("case-{index}"),
                &resolved_namespace_fixture(namespace),
            );
            down(&Address::new(crate::engine::Engine::Docker, None), &root).unwrap();
            let expected = if index == 3 { "current" } else { "default" };
            assert!(std::fs::read_to_string(record)
                .unwrap()
                .lines()
                .any(|line| line.ends_with(&format!("\tstop {expected}"))));
        }
        for (index, namespace) in ["9Mixed_Case-namespace".to_string(), "a".repeat(64)]
            .iter()
            .enumerate()
        {
            let (root, record) = computer_stop_root(
                &path,
                &format!("valid-{index}"),
                &resolved_namespace_fixture(namespace),
            );
            down(&Address::new(crate::engine::Engine::Docker, None), &root).unwrap();
            let log = std::fs::read_to_string(record).unwrap();
            assert!(
                log.contains(&format!("label=openbot.namespace={namespace}")),
                "{log}"
            );
            assert!(!log.contains("\tstop "), "{log}");
        }
    }

    #[test]
    fn computer_stop_refuses_unresolved_namespace_before_listing_or_stopping() {
        let path = PathFixture::with_fake_engine("computer-stop");
        let configs = [
            "not json".to_string(),
            "{\"services\":{}}".to_string(),
            "{\"services\":{\"supervisor\":{\"environment\":{\"COMPUTER_NAMESPACE\":12}}}}"
                .to_string(),
            resolved_namespace_fixture("_invalid"),
            resolved_namespace_fixture("bad/value"),
            resolved_namespace_fixture(&"a".repeat(65)),
        ];
        for (index, config) in configs.iter().enumerate() {
            let (root, record) = computer_stop_root(&path, &format!("invalid-{index}"), config);
            let error =
                down(&Address::new(crate::engine::Engine::Docker, None), &root).unwrap_err();
            assert!(error.contains("namespace"), "{error}");
            let log = std::fs::read_to_string(record).unwrap();
            assert!(
                !log.contains("\tps ") && !log.contains("\tstop ") && !log.contains("harness down"),
                "{log}"
            );
        }
        let (root, record) = computer_stop_root(&path, "provider-failure", "{}");
        std::fs::write(root.join(".fixture-config-failure"), "").unwrap();
        assert!(down(&Address::new(crate::engine::Engine::Docker, None), &root).is_err());
        assert!(!std::fs::read_to_string(record).unwrap().contains("\tps "));
    }

    #[test]
    fn computer_stop_without_installed_config_never_searches_parent_or_lists_globally() {
        let path = PathFixture::with_fake_engine("computer-stop");
        let record = path.bin.join("no-stack.log");
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        let absent = path.bin.join("absent");
        let empty = path.bin.join("empty");
        std::fs::create_dir(&empty).unwrap();
        for root in [&absent, &empty] {
            down(&Address::new(crate::engine::Engine::Docker, None), root).unwrap();
            assert!(!record.exists());
        }
        crate::deployment::record(&empty, "fixture").unwrap();
        assert!(down(&Address::new(crate::engine::Engine::Docker, None), &empty).is_err());
        assert!(!record.exists());
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
    fn the_server_uses_the_production_loader_entry() {
        let server = HOST_PROCESSES
            .iter()
            .find(|process| process.name == "server")
            .expect("the server is one of the three");
        assert_eq!(server.script, "src/production-entry.ts");
    }

    #[test]
    fn the_worker_keeps_its_own_index_entry() {
        let worker = HOST_PROCESSES
            .iter()
            .find(|process| process.name == "worker")
            .expect("the worker is one of the three");
        assert_eq!(worker.script, "src/index.ts");
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
    #[cfg(unix)]
    #[test]
    fn unix_app_listener_requires_stable_recorded_ancestry() {
        let live = [
            unix_fixture(401, 400),
            unix_fixture(402, 401),
            unix_fixture(403, 402),
        ];
        let inspect = |pid| Ok(live.iter().find(|row| row.pid == pid).cloned());
        assert!(unix_listener_belongs_to_record(403, &unix_record(401), inspect).unwrap());
        assert!(!unix_listener_belongs_to_record(403, &unix_record(501), inspect).unwrap());
        let mut reused = unix_record(401);
        reused.start = "earlier-instance".into();
        assert!(!unix_listener_belongs_to_record(403, &reused, inspect).unwrap());
        let mut seen = std::collections::HashMap::new();
        assert!(
            !unix_listener_belongs_to_record(403, &unix_record(401), |pid| {
                let count = seen.entry(pid).or_insert(0);
                *count += 1;
                let mut row = live.iter().find(|row| row.pid == pid).cloned();
                if pid == 402 && *count > 1 {
                    row.as_mut().unwrap().parent = 999;
                }
                Ok(row)
            })
            .unwrap()
        );
        assert!(
            !unix_listener_belongs_to_record(403, &unix_record(401), |pid| {
                Ok(Some(unix_fixture(pid, if pid == 403 { 402 } else { 403 })))
            })
            .unwrap()
        );
    }

    fn ancestry_listeners(pids: &[u32]) -> String {
        pids.iter()
            .map(|pid| format!("TCP 127.0.0.1:3010 0.0.0.0:0 LISTENING {pid}\n"))
            .collect()
    }

    fn assert_windows_ancestry_selection(
        recorded: &[RecordedHostProcess],
        processes: &[WindowsProcess],
        listeners: &[u32],
        expected: &[u32],
    ) {
        let listing = ancestry_listeners(listeners);
        assert_eq!(
            verified_openbot_pids_listening_on(&listing, &[3010], recorded, processes),
            expected,
            "listener ownership: {processes:?}"
        );
        let mut killed = Vec::new();
        let stopped = stop_windows_processes_in(recorded, processes, &listing, |pid| {
            killed.push(pid);
            Ok(true)
        })
        .unwrap();
        assert_eq!(killed, expected, "cleanup ownership: {processes:?}");
        assert_eq!(stopped, expected.len());
    }

    #[test]
    fn windows_ancestry_rejects_a_reused_newer_parent_pid() {
        let recorded = [recorded_process("app", 9001, "20260910010101.000000-420")];
        let processes = [
            live_host_process("app", 9001, 7000, "20260910010101.000000-420"),
            live_host_process("app", 9000, 9001, "20260909010101.000000-420"),
        ];
        assert_windows_ancestry_selection(&recorded, &processes, &[9000], &[]);
    }

    #[test]
    fn windows_ancestry_checks_intermediate_parent_instances() {
        let recorded = [recorded_process("app", 9001, "/Date(1000)/")];
        let processes = [
            live_host_process("app", 9001, 7000, "/Date(1000)/"),
            live_host_process("app", 9002, 9001, "/Date(3000)/"),
            live_host_process("app", 9003, 9002, "/Date(2000)/"),
        ];
        assert_windows_ancestry_selection(
            &recorded,
            &processes,
            &[9001, 9002, 9003],
            &[9001, 9002],
        );
    }

    #[test]
    fn windows_ancestry_compares_instants_and_preserves_direct_and_descendant_ownership() {
        for (parent, child, owned) in [
            (
                "20260910010101.000000-420",
                "20260910010101.000001-420",
                true,
            ),
            (
                "20260910010101.000001-420",
                "20260910010101.000000-420",
                false,
            ),
            (
                "20260910010101.000000-420",
                "20260910010101.000000-420",
                true,
            ),
            // Local date order reverses at a timezone boundary; compare UTC instants.
            (
                "20260910003000.000000+060",
                "20260909234500.000000+000",
                true,
            ),
            (
                "20260909234500.000000+000",
                "20260910003000.000000+060",
                false,
            ),
            ("/Date(1000)/", "/Date(1001)/", true),
            ("/Date(1001)/", "/Date(1000)/", false),
            ("/Date(1000+0700)/", "/Date(1001-0800)/", true),
            ("/Date(-1)/", "/Date(0)/", true),
            ("19700101010000.000000+060", "/Date(0)/", true),
            ("19700101000000.000001+000", "/Date(0)/", false),
        ] {
            let recorded = [recorded_process("app", 9001, parent)];
            let processes = [
                live_host_process("app", 9001, 7000, parent),
                live_host_process("app", 9002, 9001, child),
            ];
            let expected: &[u32] = if owned { &[9001, 9002] } else { &[9001] };
            assert_windows_ancestry_selection(&recorded, &processes, &[9001, 9002], expected);
        }
    }

    #[test]
    fn windows_ancestry_refuses_missing_or_invalid_times_at_every_link() {
        for invalid in [
            None,
            Some(""),
            Some("unknown"),
            Some("20260910010101.000000+***"),
            Some("20260931010101.000000+000"),
            Some("20260229010101.000000+000"),
            Some("20260910240101.000000+000"),
            Some("20260910010160.000000+000"),
            Some("20260910010101.00000x+000"),
            Some("/Date()/"),
            Some("/Date(9223372036854775807)/"),
            Some("/Date(0+2400)/"),
            Some("/Date(0+0060)/"),
            Some("/Date(0+000)/"),
            Some("/Date(0)"),
        ] {
            for index in 0..3 {
                let mut recorded = [recorded_process("app", 9001, "/Date(1000)/")];
                let mut processes = [
                    live_host_process("app", 9001, 7000, "/Date(1000)/"),
                    live_host_process("app", 9002, 9001, "/Date(2000)/"),
                    live_host_process("app", 9003, 9002, "/Date(3000)/"),
                ];
                processes[index].creation_date = invalid.map(str::to_string);
                if index == 0 {
                    recorded[0].creation_date = invalid.unwrap_or("").to_string();
                }
                assert_windows_ancestry_selection(&recorded, &processes, &[9003], &[]);
                if index == 0 {
                    assert_windows_ancestry_selection(&recorded, &processes, &[9001], &[]);
                }
            }
        }
    }

    #[test]
    fn windows_app_port_requires_the_app_role_and_its_verified_descendant() {
        let root = temp_root("windows-app-role-port");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("already-running");
        let app = recorded_process("app", 9001, "20260909010101.000000-420");
        let server = recorded_process("server", 9002, "20260909010101.000000-420");
        write_host_pid_file(
            &root,
            &serde_json::json!({"version":1,"processes":[app,server]}),
        )
        .unwrap();
        std::fs::write(root.join("synthetic-inventory.json"), serde_json::to_vec(&serde_json::json!([
            {"ProcessId":9001,"ParentProcessId":7000,"ExecutablePath":r"C:\Users\person\.bun\bin\bun.exe","CommandLine":host_command_line("app"),"CreationDate":"20260909010101.000000-420"},
            {"ProcessId":9000,"ParentProcessId":9001,"ExecutablePath":"synthetic-child.exe","CommandLine":"synthetic child","CreationDate":"20260909010102.000000-420"},
            {"ProcessId":9002,"ParentProcessId":7000,"ExecutablePath":r"C:\Users\person\.bun\bin\bun.exe","CommandLine":host_command_line("server"),"CreationDate":"20260909010101.000000-420"}
        ])).unwrap()).unwrap();
        let owns = |name, port| {
            recorded_process_owns_port_windows_with(
                &root,
                name,
                port,
                &fixture.command("powershell"),
                &fixture.command("netstat"),
            )
            .unwrap()
        };
        assert!(owns("app", 45123));
        assert!(!owns("server", 45123));
        assert!(!owns("app", 45124));
        assert!(owns("server", 45124));
        assert!(!owns("worker", 45123));
        let log = fixture.log();
        assert!(!log.contains("taskkill"), "{log}");
        std::fs::remove_dir_all(root).unwrap();
    }
}
