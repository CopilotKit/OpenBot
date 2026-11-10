//! A back end update (`local update`) that stopped partway: where it is while it runs, and putting
//! the stack back so the next one can finish.
//!
//! THE FAILURE. `local update` scales the old release's services to zero (`update-quiesce`), then
//! `helm upgrade`s the release with a values file that turns Learning off (`dependencies-install`).
//! That upgrade deletes the `cpki-learning-reconciler` and `cpki-learning-agent` Deployments. The
//! databases, the migration and bootstrap Jobs and the final `helm upgrade --wait`
//! (`services-start`) follow, each allowed up to ten minutes. An update stopped anywhere after
//! `dependencies-install` (Quit stopped it) leaves those two Deployments deleted, and every later
//! `local update` begins by scaling them, by name, and fails with NotFound in under a second:
//! "Local update-quiesce failed (exit 1)" on every Start, for good. Quit that stops Helm itself
//! leaves the release `pending-upgrade` ("another operation is in progress") the same way.
//!
//! THE REPAIR, only after an update failed or when one is on record past its first step: roll a
//! release Helm left pending back to its last deployed revision, then, when the Learning
//! Deployments are gone, apply the chart the update was installing (its `install.json`) with the
//! stack's own values and `--no-hooks`. That puts them back, the CLI's next quiesce scales them to
//! zero again, and the update resumes. Reproduced and verified by hand on 0.16.0-rc.9 to rc.10.
//!
//! THE CLI OWNS INTELLIGENCE (`local_eval`). This is the one place OpenBot runs the CLI's private
//! Helm against its stack, because the CLI cannot get past this on its own. It runs the CLI's own
//! Helm binary (checked against the digest in its folder name, as the CLI checks it), with the
//! stack's own kubeconfig, chart and values files, and reads nothing else the CLI keeps. Every
//! step is logged.
//!
//! WHERE IT IS. The CLI logs each step it finishes to `cli.log` (`local.step`), and nothing when a
//! step begins. `StepLog` reads the lines an update adds, so the window can say which step it is in
//! and for how long, and Quit can tell an update it can still stop from one it must let finish
//! (`committed`).

use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// The Helm release every local stack installs.
const RELEASE: &str = "cpki";

/// The Deployments a stopped update leaves deleted, which `update-quiesce` scales by name.
pub const LEARNING_DEPLOYMENTS: [&str; 2] = ["cpki-learning-reconciler", "cpki-learning-agent"];

/// The CLI's configuration folder, as `conf` names it for `copilotkit-config` (`env-paths`).
///
/// `COPILOTKIT_CONFIG_DIR` would move it, but the CLI OpenBot runs never inherits that variable
/// (`local_eval::INHERITED`), so it is not read here either.
pub fn cli_config_dir() -> Option<PathBuf> {
    config_dir_with(|name| std::env::var_os(name), std::env::consts::OS)
}

fn config_dir_with(var: impl Fn(&str) -> Option<std::ffi::OsString>, os: &str) -> Option<PathBuf> {
    const NAME: &str = "copilotkit-config-nodejs";
    let set = |name: &str| {
        var(name)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    match os {
        "macos" => Some(set("HOME")?.join("Library").join("Preferences").join(NAME)),
        "windows" => {
            let app_data = set("APPDATA")
                .or_else(|| Some(set("USERPROFILE")?.join("AppData").join("Roaming")))?;
            Some(app_data.join(NAME).join("Config"))
        }
        _ => Some(
            set("XDG_CONFIG_HOME")
                .or_else(|| Some(set("HOME")?.join(".config")))?
                .join(NAME),
        ),
    }
}

/// The folder the CLI keeps one stack's files in: its kubeconfig, chart and values.
pub fn stack_dir(stack: &str) -> Option<PathBuf> {
    Some(cli_config_dir()?.join("local-evaluation").join(stack))
}

/// The CLI's log: `~/.copilotkit/cli.log` (`services/cli-logs.ts`). The CLI OpenBot runs inherits
/// neither `XDG_STATE_HOME` nor `COPILOTKIT_CONFIG_DIR`, so this is where it writes.
pub fn cli_log() -> Option<PathBuf> {
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE")
    } else {
        std::env::var_os("HOME")
    }
    .filter(|home| !home.is_empty())?;
    Some(PathBuf::from(home).join(".copilotkit").join("cli.log"))
}

/**
The Helm the CLI downloaded for its stacks: `tools/helm-<version>-<os>-<arch>-<sha256>/helm`, whose
`download` beside it hashes to the digest in the folder's name (`local-tools.ts` checks the same).
The newest version for this platform, when there are several. None when there is none.
*/
pub fn cli_helm(tools: &Path) -> Option<PathBuf> {
    let (os, arch) = platform();
    helm_in(tools, os, arch)
}

/// This computer as the CLI names platforms in its tool folders: Node's `process.platform` and
/// `process.arch`.
pub(crate) fn platform() -> (&'static str, &'static str) {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    (os, arch)
}

fn helm_in(tools: &Path, os: &str, arch: &str) -> Option<PathBuf> {
    let executable = if os == "win32" { "helm.exe" } else { "helm" };
    let mut found: Vec<(semver::Version, PathBuf)> = std::fs::read_dir(tools)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let rest = name.strip_prefix("helm-")?;
            let (version, rest) = rest.split_once('-')?;
            let digest = rest.strip_prefix(&format!("{os}-{arch}-"))?;
            let version = semver::Version::parse(version).ok()?;
            let folder = entry.path();
            let helm = folder.join(executable);
            (helm.is_file() && sha256_of(&folder.join("download")).as_deref() == Some(digest))
                .then_some((version, helm))
        })
        .collect();
    found.sort_by(|left, right| left.0.cmp(&right.0));
    found.pop().map(|(_, helm)| helm)
}

fn sha256_of(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).ok()?;
    Some(
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

/// What a bounded tool call said. Its output stays here and in the log; none of it crosses IPC.
struct Ran {
    success: bool,
    stdout: String,
    stderr: String,
}

/// Run `command` to its end, or stop it at `timeout`. Its output is read on threads of its own, so
/// a large answer cannot block it, and only the first megabytes of each are kept.
fn bounded(mut command: Command, timeout: Duration) -> Result<Ran, String> {
    use std::process::Stdio;
    const CAP: u64 = 4 << 20;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start: {error}"))?;
    let read = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(pipe) = pipe {
                let _ = pipe.take(CAP).read_to_end(&mut bytes);
            }
            String::from_utf8_lossy(&bytes).into_owned()
        })
    };
    let stdout = read(child.stdout.take().map(|pipe| Box::new(pipe) as _));
    let stderr = read(child.stderr.take().map(|pipe| Box::new(pipe) as _));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("did not finish within {}s", timeout.as_secs()));
            }
            Err(error) => return Err(format!("could not be waited on: {error}")),
        }
    };
    Ok(Ran {
        success: status.success(),
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// The last characters of what a tool printed, for the log.
fn tail(text: &str) -> &str {
    let text = text.trim();
    let start = text
        .char_indices()
        .rev()
        .nth(1500)
        .map_or(0, |(index, _)| index);
    &text[start..]
}

/**
How to reach one stack, for `repair`: the CLI's Helm and the stack's folder, and how to start a
program with the CLI's environment (`local_eval::tool_command`), including the container engine
whose `exec` reaches the stack's node, as the CLI's own `kubectl` calls do.
*/
pub struct Reach<'a> {
    pub stack: &'a str,
    pub directory: PathBuf,
    pub helm: PathBuf,
    /// A program, with the CLI's environment.
    pub command: &'a dyn Fn(&std::ffi::OsStr) -> Command,
    /// The container engine the CLI runs on (`docker` or `podman`), with the CLI's environment.
    pub engine: &'a dyn Fn() -> Command,
}

/// What `repair` changed. Nothing changed means there was nothing it knew how to repair.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Repaired {
    /// A release Helm left pending was rolled back to this revision.
    pub rolled_back_to: Option<u64>,
    /// The Learning Deployments were missing and the update's chart put them back.
    pub restored: bool,
}

impl Repaired {
    pub fn changed(&self) -> bool {
        self.rolled_back_to.is_some() || self.restored
    }
}

impl Reach<'_> {
    fn kubeconfig(&self) -> PathBuf {
        self.directory.join("kubeconfig")
    }

    fn helm(&self, arguments: &[&str], timeout: Duration) -> Result<Ran, String> {
        let mut command = (self.command)(self.helm.as_os_str());
        command
            .args(arguments)
            .arg("--kubeconfig")
            .arg(self.kubeconfig());
        bounded(command, timeout)
    }

    /// `kubectl` inside the stack's node, as the CLI runs it.
    fn kubectl(&self, arguments: &[&str]) -> Result<Ran, String> {
        let mut command = (self.engine)();
        command
            .args(["exec", &format!("k3d-{}-server-0", self.stack), "kubectl"])
            .args(arguments);
        bounded(command, Duration::from_secs(60))
    }
}

/**
Put a stack an update left half done back where `local update` can resume it. See the module.

Each step is skipped when there is nothing for it to do, so this is safe to run on a stack that
needs nothing: it then changes nothing and says so. An `Err` is a step that could not be done or
could not be checked; the update is then left to fail as it would have.
*/
pub fn repair(reach: &Reach) -> Result<Repaired, String> {
    let mut repaired = Repaired::default();
    if !reach.kubeconfig().is_file() {
        return Err("the stack has no kubeconfig".into());
    }
    let status = release_status(reach)?;
    log::info!(
        "[update repair] Helm release {RELEASE} is {}",
        status.as_deref().unwrap_or("not installed")
    );
    if status
        .as_deref()
        .is_some_and(|status| status.starts_with("pending-"))
    {
        let revision = last_deployed(reach)?
            .ok_or_else(|| "the release has no deployed revision to roll back to".to_owned())?;
        log::info!("[update repair] rolling {RELEASE} back to revision {revision}");
        let ran = reach.helm(
            &[
                "rollback",
                RELEASE,
                &revision.to_string(),
                "--no-hooks",
                "--timeout",
                "5m0s",
            ],
            Duration::from_secs(6 * 60),
        )?;
        if !ran.success {
            return Err(format!("helm rollback failed: {}", tail(&ran.stderr)));
        }
        log::info!("[update repair] rolled {RELEASE} back to revision {revision}");
        repaired.rolled_back_to = Some(revision);
    }
    let missing = missing_learning(reach)?;
    if missing.is_empty() {
        log::info!("[update repair] the Learning Deployments are in place");
        return Ok(repaired);
    }
    log::info!("[update repair] missing: {}", missing.join(", "));
    let (chart, profile) = update_chart(&reach.directory)?;
    let values = reach.directory.join("values.yaml");
    if !values.is_file() {
        return Err("the stack has no values.yaml".into());
    }
    log::info!(
        "[update repair] applying {} to {RELEASE} without hooks",
        chart.file_name().unwrap_or_default().to_string_lossy()
    );
    let (chart, profile, values) = (
        path_text(&chart)?,
        path_text(&profile)?,
        path_text(&values)?,
    );
    let ran = reach.helm(
        &[
            "upgrade",
            RELEASE,
            chart,
            "-f",
            profile,
            "-f",
            values,
            "--no-hooks",
            "--timeout",
            "10m0s",
        ],
        Duration::from_secs(11 * 60),
    )?;
    if !ran.success {
        return Err(format!("helm upgrade failed: {}", tail(&ran.stderr)));
    }
    let still = missing_learning(reach)?;
    if !still.is_empty() {
        return Err(format!(
            "still missing after the upgrade: {}",
            still.join(", ")
        ));
    }
    log::info!("[update repair] the Learning Deployments are back");
    repaired.restored = true;
    Ok(repaired)
}

fn path_text(path: &Path) -> Result<&str, String> {
    path.to_str()
        .filter(|text| !text.starts_with('-'))
        .ok_or_else(|| format!("{} is not a usable path", path.display()))
}

/// The release's status (`deployed`, `pending-upgrade`, ...), or None when it is not installed.
/// `helm list`, not `helm status`: status prints the release's values, which hold its keys.
fn release_status(reach: &Reach) -> Result<Option<String>, String> {
    let ran = reach.helm(
        &[
            "list",
            "--all",
            "--filter",
            &format!("^{RELEASE}$"),
            "-o",
            "json",
        ],
        Duration::from_secs(60),
    )?;
    if !ran.success {
        return Err(format!("helm list failed: {}", tail(&ran.stderr)));
    }
    let listed: serde_json::Value =
        serde_json::from_str(ran.stdout.trim()).map_err(|_| "helm list did not answer JSON")?;
    Ok(listed
        .as_array()
        .into_iter()
        .flatten()
        .find(|release| release.get("name").and_then(|name| name.as_str()) == Some(RELEASE))
        .and_then(|release| release.get("status")?.as_str().map(str::to_owned)))
}

/// The newest revision Helm still calls `deployed`, else the newest `superseded` one.
fn last_deployed(reach: &Reach) -> Result<Option<u64>, String> {
    let ran = reach.helm(
        &["history", RELEASE, "--max", "256", "-o", "json"],
        Duration::from_secs(60),
    )?;
    if !ran.success {
        return Err(format!("helm history failed: {}", tail(&ran.stderr)));
    }
    let history: serde_json::Value =
        serde_json::from_str(ran.stdout.trim()).map_err(|_| "helm history did not answer JSON")?;
    let revisions: Vec<(u64, String)> = history
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let revision = match entry.get("revision")? {
                serde_json::Value::Number(number) => number.as_u64()?,
                serde_json::Value::String(text) => text.parse().ok()?,
                _ => return None,
            };
            Some((revision, entry.get("status")?.as_str()?.to_owned()))
        })
        .collect();
    let newest = |wanted: &str| {
        revisions
            .iter()
            .filter(|(_, status)| status == wanted)
            .map(|(revision, _)| *revision)
            .max()
    };
    Ok(newest("deployed").or_else(|| newest("superseded")))
}

/// `kubectl get jobs -o json` in `stack`'s node, through `engine` (the container engine with the
/// CLI's environment), for `jobs` and `job_names`. None when the cluster did not answer in time.
pub fn cluster_jobs(mut engine: Command, stack: &str) -> Option<String> {
    engine.args([
        "exec",
        &format!("k3d-{stack}-server-0"),
        "kubectl",
        "get",
        "jobs",
        "-o",
        "json",
    ]);
    bounded(engine, Duration::from_secs(15))
        .ok()
        .filter(|ran| ran.success)
        .map(|ran| ran.stdout)
}

/**
Uncordon the stack's node when it is cordoned (`spec.unschedulable`). True when it was.

Found on a Mac whose update hung for minutes in `dependencies-wait`: the database, Redis and object
storage pods sat in `FailedScheduling: 0/1 nodes are available: 1 node(s) were unschedulable`,
and `kubectl rollout status` waits up to ten minutes for each. Nothing in the CLI (48a3863 or
647a03b) or in OpenBot cordons a node. k3s marks its node `NodeNotSchedulable` as it shuts down,
which is what `local stop` (`docker stop` of the node) does, and clears it once it is back up; a
node that comes back still cordoned leaves every new pod unscheduled. A local stack has one node
and nothing that cordons it on purpose, so a cordon there is always a leftover.
*/
pub fn uncordon_if_cordoned(
    mut engine: impl FnMut() -> Command,
    stack: &str,
) -> Result<bool, String> {
    let node = format!("k3d-{stack}-server-0");
    let mut asked = engine();
    asked.args([
        "exec",
        &node,
        "kubectl",
        "get",
        "node",
        &node,
        "-o",
        "jsonpath={.spec.unschedulable}",
    ]);
    let ran = bounded(asked, Duration::from_secs(15))?;
    if !ran.success {
        return Err(format!("the node did not answer: {}", tail(&ran.stderr)));
    }
    if ran.stdout.trim() != "true" {
        return Ok(false);
    }
    log::warn!("[local update] the backend's node {node} is cordoned, so nothing new can start on it; uncordoning it");
    let mut uncordon = engine();
    uncordon.args(["exec", &node, "kubectl", "uncordon", &node]);
    let ran = bounded(uncordon, Duration::from_secs(15))?;
    if !ran.success {
        return Err(format!("kubectl uncordon failed: {}", tail(&ran.stderr)));
    }
    log::info!("[local update] uncordoned {node}");
    Ok(true)
}

/// The Learning Deployments the stack's cluster does not have.
fn missing_learning(reach: &Reach) -> Result<Vec<&'static str>, String> {
    let mut arguments = vec!["get", "deployment"];
    arguments.extend(LEARNING_DEPLOYMENTS);
    arguments.extend(["--ignore-not-found", "-o", "name"]);
    let ran = reach.kubectl(&arguments)?;
    if !ran.success {
        return Err(format!(
            "the stack's cluster did not answer: {}",
            tail(&ran.stderr)
        ));
    }
    let present: Vec<&str> = ran
        .stdout
        .lines()
        .filter_map(|line| line.trim().rsplit('/').next())
        .collect();
    Ok(LEARNING_DEPLOYMENTS
        .into_iter()
        .filter(|name| !present.contains(name))
        .collect())
}

/// The chart and profile the update was installing, as the CLI recorded them for this stack in
/// `install.json`. Only those two fields are read, and only files in the stack's own folder used.
fn update_chart(directory: &Path) -> Result<(PathBuf, PathBuf), String> {
    #[derive(serde::Deserialize)]
    struct Recorded {
        chart: PathBuf,
        profile: PathBuf,
    }
    let text = std::fs::read_to_string(directory.join("install.json"))
        .map_err(|_| "the stack has no install.json")?;
    let recorded: Recorded =
        serde_json::from_str(&text).map_err(|_| "install.json does not name a chart")?;
    let folder = directory
        .canonicalize()
        .map_err(|_| "the stack's folder is gone")?;
    let inside = |path: &Path| {
        path.canonicalize()
            .ok()
            .filter(|path| path.parent() == Some(folder.as_path()) && path.is_file())
            .ok_or_else(|| format!("{} is not a file in the stack's folder", path.display()))
    };
    Ok((inside(&recorded.chart)?, inside(&recorded.profile)?))
}

/// Which step a running update is in, as the window says it. The CLI logs steps as they end, so
/// this is the step after the last one it logged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStep {
    /// `update-quiesce`, `dependencies-install`, `dependencies-wait`, `jobs` or `services-start`.
    pub step: &'static str,
    /// How long it has been in it.
    pub seconds: u64,
    /// In `jobs`: the Job the update is waiting on, by its name in the cluster.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job: Option<String>,
    /// A Job this update started that failed. The CLI waits out its full ten minutes on one
    /// (`kubectl wait --for=condition=complete`), so the window says so as soon as it fails.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_job: Option<String>,
}

/// What the Jobs an update started are doing, from `kubectl get jobs -o json`. Jobs in `before`,
/// there when it began changing the release, are an earlier attempt's, and are left out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Jobs {
    /// The newest new Job not yet complete or failed.
    pub running: Option<String>,
    /// A new Job that failed.
    pub failed: Option<String>,
    /// How many new Jobs there are.
    pub started: usize,
}

/// The Jobs' names in a `kubectl get jobs -o json` answer, for `before`.
pub fn job_names(answer: &str) -> Option<Vec<String>> {
    let listed: serde_json::Value = serde_json::from_str(answer).ok()?;
    Some(
        listed
            .get("items")?
            .as_array()?
            .iter()
            .filter_map(|job| identifier(job.pointer("/metadata/name")?.as_str()?))
            .collect(),
    )
}

/// See `Jobs`.
pub fn jobs(answer: &str, before: &[String]) -> Option<Jobs> {
    let listed: serde_json::Value = serde_json::from_str(answer).ok()?;
    let mut found = Jobs {
        running: None,
        failed: None,
        started: 0,
    };
    let mut newest = String::new();
    for job in listed.get("items")?.as_array()? {
        let Some(name) = job
            .pointer("/metadata/name")
            .and_then(|name| name.as_str())
            .and_then(identifier)
        else {
            continue;
        };
        if before.contains(&name) {
            continue;
        }
        found.started += 1;
        let condition = |wanted: &str| {
            job.pointer("/status/conditions")
                .and_then(|conditions| conditions.as_array())
                .is_some_and(|conditions| {
                    conditions.iter().any(|condition| {
                        condition.get("type").and_then(|kind| kind.as_str()) == Some(wanted)
                            && condition.get("status").and_then(|status| status.as_str())
                                == Some("True")
                    })
                })
        };
        if condition("Failed") {
            found.failed.get_or_insert(name);
        } else if !condition("Complete") {
            let created = job
                .pointer("/metadata/creationTimestamp")
                .and_then(|created| created.as_str())
                .unwrap_or_default()
                .to_owned();
            // RFC 3339 in UTC, as Kubernetes writes it, sorts as text.
            if found.running.is_none() || created >= newest {
                newest = created;
                found.running = Some(name);
            }
        }
    }
    Some(found)
}

/// A Kubernetes object name, and nothing that could carry more.
fn identifier(name: &str) -> Option<String> {
    (!name.is_empty()
        && name.len() <= 253
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'.')
        }))
    .then(|| name.to_owned())
}

/// The steps after which the update has begun changing the release with Helm: from here on
/// stopping it is what wedges the stack, so it is let finish. `update-agent-wait` is the last
/// step before `dependencies-install`, the first `helm upgrade`.
const COMMITTED: [&str; 9] = [
    "update-agent-wait",
    "dependencies-install",
    "dependencies-wait",
    "hook-apply",
    "migration-apply",
    "migration-wait",
    "hook-wait",
    "bootstrap-result",
    "services-start",
];

/// The step running after `last`, for the steps that wait long enough to need saying.
fn running_after(last: &str) -> Option<&'static str> {
    Some(match last {
        "secrets-apply"
        | "update-schedules"
        | "update-suspend"
        | "update-quiesce"
        | "update-quiesce-wait"
        | "update-jobs"
        | "update-agent-stop" => "update-quiesce",
        "update-agent-wait" => "dependencies-install",
        "dependencies-install" | "dependencies-wait" => "dependencies-wait",
        // The chart's Jobs, then `services-start`, whose start the log does not mark: the Jobs
        // themselves tell them apart (`StepLog::now`).
        "hook-apply" | "migration-apply" | "migration-wait" | "hook-wait" | "bootstrap-result" => {
            "jobs"
        }
        _ => return None,
    })
}

/**
The `local.step` lines one update adds to `cli.log`, read from where the file ended when it began.

Other CLI processes write the same file, but OpenBot runs one CLI call at a time
(`local_eval::one_at_a_time`), so while its update runs the lines are the update's.
*/
pub struct StepLog {
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
    last: Option<String>,
    since: Instant,
    committed: bool,
    /// When the cluster first said every Job this update started was done (`saw_jobs`).
    jobs_done: Option<Instant>,
}

impl StepLog {
    /// From the end of `path` as it is now. A log not written yet is read from its start.
    pub fn at_end_of(path: PathBuf) -> Self {
        let offset = std::fs::metadata(&path).map_or(0, |metadata| metadata.len());
        Self {
            path,
            offset,
            partial: Vec::new(),
            last: None,
            since: Instant::now(),
            committed: false,
            jobs_done: None,
        }
    }

    /// Read what was added. The steps that ended since the last read, in order.
    pub fn poll(&mut self) -> Vec<String> {
        let Ok(mut file) = std::fs::File::open(&self.path) else {
            return Vec::new();
        };
        let length = file.metadata().map_or(0, |metadata| metadata.len());
        if length < self.offset {
            // Rotated or truncated: what is there now is all new.
            self.offset = 0;
            self.partial.clear();
        }
        if length == self.offset || file.seek(std::io::SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }
        let mut added = Vec::new();
        if file.take(1 << 20).read_to_end(&mut added).is_err() {
            return Vec::new();
        }
        self.offset += added.len() as u64;
        self.partial.extend_from_slice(&added);
        let mut ended = Vec::new();
        while let Some(newline) = self.partial.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.partial.drain(..=newline).collect();
            if let Some(step) = ended_step(&line) {
                if COMMITTED.contains(&step.as_str()) {
                    self.committed = true;
                }
                self.last = Some(step.clone());
                self.since = Instant::now();
                self.jobs_done = None;
                ended.push(step);
            }
        }
        ended
    }

    /// The update has begun changing the release with Helm (`COMMITTED`).
    pub fn committed(&self) -> bool {
        self.committed
    }

    /// Whether the update is in the chart's Jobs, as far as the log says. Their state is then worth
    /// asking the cluster for (`now`).
    pub fn in_jobs(&self) -> bool {
        self.last.as_deref().and_then(running_after) == Some("jobs")
    }

    /// The step it is in now, when it is one that waits. `jobs` is what the cluster says the Jobs
    /// this update started are doing, when it was asked: with every one complete and none
    /// running, the update has gone on to `services-start`.
    pub fn now(&self, jobs: Option<&Jobs>) -> Option<UpdateStep> {
        let mut step = running_after(self.last.as_deref()?)?;
        let mut since = self.since;
        let mut job = None;
        if step == "jobs" {
            match jobs {
                Some(jobs) if jobs.running.is_some() => job = jobs.running.clone(),
                Some(jobs) if jobs.started > 0 && jobs.failed.is_none() => {
                    step = "services-start";
                    since = self.jobs_done.unwrap_or(since);
                }
                _ => {}
            }
        }
        Some(UpdateStep {
            step,
            seconds: since.elapsed().as_secs(),
            job,
            failed_job: jobs.and_then(|jobs| jobs.failed.clone()),
        })
    }

    /// What the cluster said of the Jobs this update started. Every one done, and none running:
    /// `services-start` began about now.
    pub fn saw_jobs(&mut self, jobs: &Jobs) {
        if jobs.running.is_none() && jobs.started > 0 {
            self.jobs_done.get_or_insert_with(Instant::now);
        } else {
            self.jobs_done = None;
        }
    }
}

/// A step that ended well, from one `cli.log` line: `{"event":"local.step","step":...,
/// "outcome":"succeeded"}`. Only the step's name, and only an identifier.
fn ended_step(line: &[u8]) -> Option<String> {
    let entry: serde_json::Value = serde_json::from_slice(line).ok()?;
    if entry.get("event")?.as_str()? != "local.step"
        || entry.get("outcome")?.as_str()? != "succeeded"
    {
        return None;
    }
    let step = entry.get("step")?.as_str()?;
    (!step.is_empty()
        && step.len() <= 64
        && step
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'))
    .then(|| step.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cli_config_folder_is_where_conf_puts_it_on_each_platform() {
        let vars = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| std::ffi::OsString::from(value))
            }
        };
        assert_eq!(
            config_dir_with(vars(&[("HOME", "/Users/a")]), "macos"),
            Some(PathBuf::from(
                "/Users/a/Library/Preferences/copilotkit-config-nodejs"
            ))
        );
        assert_eq!(
            config_dir_with(vars(&[("HOME", "/home/a")]), "linux"),
            Some(PathBuf::from("/home/a/.config/copilotkit-config-nodejs"))
        );
        assert_eq!(
            config_dir_with(
                vars(&[("HOME", "/home/a"), ("XDG_CONFIG_HOME", "/x")]),
                "linux"
            ),
            Some(PathBuf::from("/x/copilotkit-config-nodejs"))
        );
        assert_eq!(
            config_dir_with(
                vars(&[("APPDATA", "C:/Users/a/AppData/Roaming")]),
                "windows"
            ),
            Some(
                PathBuf::from("C:/Users/a/AppData/Roaming")
                    .join("copilotkit-config-nodejs")
                    .join("Config")
            )
        );
        assert_eq!(config_dir_with(vars(&[]), "macos"), None);
    }

    #[test]
    fn only_a_helm_whose_download_matches_its_folder_digest_is_used() {
        let root = crate::test_support::temp_root("cli-helm");
        let tool = |version: &str, bytes: &[u8], honest: bool| {
            let digest = if honest {
                Sha256::digest(bytes)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect()
            } else {
                "0".repeat(64)
            };
            let folder = root.join(format!("helm-{version}-darwin-arm64-{digest}"));
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("download"), bytes).unwrap();
            std::fs::write(folder.join("helm"), b"helm").unwrap();
            folder.join("helm")
        };
        let older = tool("3.17.3", b"a", true);
        assert_eq!(helm_in(&root, "darwin", "arm64"), Some(older.clone()));
        let newer = tool("3.18.4", b"b", true);
        assert_eq!(helm_in(&root, "darwin", "arm64"), Some(newer.clone()));
        // A newer one whose download does not hash to its name is not run.
        tool("3.19.0", b"c", false);
        assert_eq!(helm_in(&root, "darwin", "arm64"), Some(newer));
        assert_eq!(helm_in(&root, "linux", "x64"), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The lines a real update wrote to `cli.log` (0.16.0-rc.9 to rc.10, 2026-11-09), from the
    /// quiesce to the end, with a failed line and another event between them.
    const UPDATE_LINES: &str = r#"{"level":30,"time":"2026-11-09T00:46:23.277Z","event":"local.step","step":"secrets-apply","outcome":"succeeded","exitCode":0,"durationMs":419}
{"level":30,"time":"2026-11-09T00:46:23.572Z","event":"local.step","step":"update-quiesce","outcome":"succeeded","exitCode":0,"durationMs":111}
{"level":30,"time":"2026-11-09T00:46:55.594Z","event":"local.step","step":"update-agent-wait","outcome":"succeeded","exitCode":0,"durationMs":793}
{"level":30,"time":"2026-11-09T00:46:56.997Z","event":"local.step","step":"dependencies-install","outcome":"succeeded","exitCode":0,"durationMs":1364}
{"level":50,"time":"2026-11-09T00:47:08.278Z","event":"local.step","step":"dependencies-wait","outcome":"failed","exitCode":1,"durationMs":11281}
{"level":30,"time":"2026-11-09T00:47:08.300Z","event":"cli.other","step":"hook-apply","outcome":"succeeded"}
{"level":30,"time":"2026-11-09T00:47:08.722Z","event":"local.step","step":"migration-apply","outcome":"succeeded","exitCode":0,"durationMs":102}
"#;

    #[test]
    fn an_update_is_followed_through_the_cli_log_from_where_it_began() {
        let root = crate::test_support::temp_root("cli-log-steps");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("cli.log");
        // An earlier update's lines are not this one's.
        std::fs::write(&path, UPDATE_LINES).unwrap();
        let mut log = StepLog::at_end_of(path.clone());
        assert!(log.poll().is_empty());
        assert!(!log.committed());
        assert_eq!(log.now(None), None);
        let mut lines = UPDATE_LINES.lines();
        let mut append = |count: usize, partial: &str| {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            for line in lines.by_ref().take(count) {
                writeln!(file, "{line}").unwrap();
            }
            write!(file, "{partial}").unwrap();
        };
        append(2, "");
        assert_eq!(log.poll(), ["secrets-apply", "update-quiesce"]);
        assert!(!log.committed(), "Quit can still stop it before Helm runs");
        assert_eq!(log.now(None).unwrap().step, "update-quiesce");
        // Half a line is kept until the rest arrives.
        append(
            0,
            r#"{"level":30,"event":"local.step","step":"update-agent-wait","#,
        );
        assert!(log.poll().is_empty());
        append(0, "\"outcome\":\"succeeded\"}\n");
        assert_eq!(log.poll(), ["update-agent-wait"]);
        assert!(
            log.committed(),
            "from here Helm runs, and Quit lets it finish"
        );
        assert_eq!(log.now(None).unwrap().step, "dependencies-install");
        append(5, "");
        // The failed step and the other event are not steps that ended.
        assert_eq!(
            log.poll(),
            [
                "update-agent-wait",
                "dependencies-install",
                "migration-apply"
            ]
        );
        assert_eq!(log.now(None).unwrap().step, "jobs");
        assert!(log.in_jobs());

        // In the Jobs, the cluster says which: the one this update is waiting on by name, and a
        // failed one at once, not after the CLI's ten minutes.
        let before = job_names(&jobs_answer(&[("cpki-migrations-old", "Failed", "")])).unwrap();
        assert_eq!(before, ["cpki-migrations-old"]);
        let running = jobs(
            &jobs_answer(&[
                ("cpki-migrations-old", "Failed", ""),
                (
                    "cpki-migrations-ab12cd34",
                    "Complete",
                    "2026-11-09T00:47:08Z",
                ),
                ("cpki-bootstrap-ef56ab78", "", "2026-11-09T00:47:13Z"),
            ]),
            &before,
        )
        .unwrap();
        log.saw_jobs(&running);
        let now = log.now(Some(&running)).unwrap();
        assert_eq!(
            (now.step, now.job.as_deref()),
            ("jobs", Some("cpki-bootstrap-ef56ab78"))
        );
        assert_eq!(
            now.failed_job, None,
            "an earlier attempt's failed Job is not this one's"
        );
        let failed = jobs(
            &jobs_answer(&[
                ("cpki-migrations-old", "Failed", ""),
                ("cpki-migrations-ab12cd34", "Complete", ""),
                ("cpki-bootstrap-ef56ab78", "Failed", ""),
            ]),
            &before,
        )
        .unwrap();
        assert_eq!(
            log.now(Some(&failed)).unwrap().failed_job.as_deref(),
            Some("cpki-bootstrap-ef56ab78")
        );
        // Every Job done and none running: the update has gone on to start the services.
        let done = jobs(
            &jobs_answer(&[
                ("cpki-migrations-ab12cd34", "Complete", ""),
                ("cpki-bootstrap-ef56ab78", "Complete", ""),
            ]),
            &before,
        )
        .unwrap();
        log.saw_jobs(&done);
        assert_eq!(log.now(Some(&done)).unwrap().step, "services-start");
        // Nothing that is not a name comes through.
        assert_eq!(
            jobs(&jobs_answer(&[("Bad Name; rm", "", "")]), &before)
                .unwrap()
                .running,
            None
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// `kubectl get jobs -o json`, with each Job's name, its finished condition, if any, and when
    /// it was made.
    fn jobs_answer(jobs: &[(&str, &str, &str)]) -> String {
        let items: Vec<serde_json::Value> = jobs
            .iter()
            .map(|(name, condition, created)| {
                let conditions: Vec<serde_json::Value> = if condition.is_empty() {
                    Vec::new()
                } else {
                    vec![serde_json::json!({ "type": condition, "status": "True" })]
                };
                serde_json::json!({
                    "metadata": { "name": name, "creationTimestamp": created },
                    "status": { "conditions": conditions },
                })
            })
            .collect();
        serde_json::json!({ "items": items }).to_string()
    }
}
