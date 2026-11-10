//! The Intelligence CLI's local evaluation commands, run as a bounded child process.
//!
//! THE CLI OWNS INTELLIGENCE. Its topology, sign-in, licence and readiness belong to it, so this
//! module never reads its credential files or probes its containers to fill a gap. What it does
//! own is the process boundary: which program runs, with which arguments, for how long, and which
//! of its words are allowed into the app.
//!
//! Three rules hold that boundary:
//!
//! - **Nothing unverified runs.** The CLI is pinned by SHA-256, like every other program this app
//!   fetches (`install.rs`). There is no fallback to `PATH`, `npx` or a global install.
//! - **Arguments are fixed.** Only `status`, `start`, `stop` and `login`, a validated stack id and
//!   `--json`, plus the constant `list`, `setup`, `connect` and `login --help` lists and the sign-in's
//!   `--mode openbot`, and `integrations composio provision` with a validated installation id and
//!   a file OpenBot made, `local setup --model-config` with a model file OpenBot made, and
//!   `telemetry link` with validated installation and account IDs, as separate arguments with
//!   no shell. The CLI's `resumeCommand` strings
//!   are text for a terminal user; they are dropped here and never executed.
//! - **Only allowlisted facts leave.** Raw stdout, stderr, error messages and recovery text never
//!   cross IPC. Failures are static categories with no payload. The one place CLI words go is the
//!   log, scrubbed, when a call that sets up, starts, updates or stops the stack ends: its exit,
//!   its report's error and the end of its stderr (`ending_entry`), so a setup that stops can be
//!   told apart from one OpenBot stopped. The account
//!   sign-in's approval page and code are the one CLI-printed text the window shows, checked
//!   first (`sign_in_page`).
//!
//! One exception to leaving the CLI's work to it: the images `local update` (a new update, or the
//! retry of one that did not finish) and a resumed `local setup` pull. The CLI pulls each under a
//! fixed limit that a slow line cannot meet, so OpenBot downloads the same images into the same
//! node first (`local_images`, `run_with`, `setup_installed`) and the CLI finds them there.
//!
//! And one more: a `local update` stopped partway leaves a stack no later update can get past, so
//! Cancel and Quit let an update finish once it has begun changing the release with Helm, and a
//! failed update is repaired and tried once more (`local_update`, `update_repairing`).
//!
//! A command that *completed* is not Intelligence that is ready or licensed. Those two facts come
//! only from the additive v1 `readiness` and `license` fields of `local status`, read by exact
//! value. A CLI that does not publish them, or publishes something else, reads as `unknown`, and
//! unknown keeps chat closed.
//!
//! Source: Intelligence `apps/cli/src/commands/local.ts`, `services/local-manager.ts` and
//! `services/local-errors.ts` at 3935afbfe3cda88dfeabfd0250db08ff0ad51000; `local connect` and
//! `local login` (`commands/local-login.ts`) at 780313e4edf6fc5f038c3cf5e4612ac668446c45.

use std::io::{Read, Seek};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// Larger output than this is not a status report, and is not read further.
pub const MAX_OUTPUT: usize = 1024 * 1024;

/// The CLI commands this app may run. Anything else is not representable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Status,
    Start,
    Stop,
    /// `local update`: the release the CLI installs, over a stack an older app set up, with its data
    /// kept (see `update_due`).
    Update,
}

impl Action {
    fn as_str(self) -> &'static str {
        match self {
            Action::Status => "status",
            Action::Start => "start",
            Action::Stop => "stop",
            Action::Update => "update",
        }
    }
}

/// A stack id the CLI could have made: one leading letter or digit, then letters, digits, `_`
/// and `-`, at most 128 characters. Nothing that could read as a flag, a path or a second word.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StackId(String);

impl StackId {
    pub fn parse(value: &str) -> Result<Self, Failure> {
        let bytes = value.as_bytes();
        let valid = !bytes.is_empty()
            && bytes.len() <= 128
            && bytes[0].is_ascii_alphanumeric()
            && bytes
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-');
        if valid {
            Ok(Self(value.to_owned()))
        } else {
            Err(Failure::InvalidStack)
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Why a CLI call produced no report. Static on purpose: none of these carries CLI output.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Failure {
    /// This build has no pinned CLI to run.
    Unavailable,
    /// The CLI on disk is not the file that was pinned.
    Unverified,
    InvalidStack,
    Spawn,
    Timeout,
    Cancelled,
    OutputLimit,
    InvalidJson,
    UnsupportedVersion,
    UnexpectedCommand,
    InvalidStatus,
    MissingStack,
    UnsafeEndpoint,
    /// The exit code and the reported status disagree, so neither is believed.
    ContractMismatch,
    /// An exit code `local` does not use: the CLI failed before it could report.
    UnexpectedExit,
    /// An accepted agreement version that is not one `terms` could have reported.
    InvalidAcceptance,
    /// OpenBot runs on a rootless Podman machine, and local Intelligence needs rootful Podman.
    /// Refused here, before `setup` or `start`, so the window can name the switch; the CLI would
    /// refuse it too, as an engine it does not support. See `acquire::create_machine` for why the
    /// switch is the person's to make.
    RootlessPodman,
    /// The back end's images stopped downloading: no new bytes for `local_images::Limits::stall`.
    /// What arrived is kept, and the next attempt continues from there. See `local_images`.
    DownloadStalled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Completed,
    Blocked,
    Failed,
}

/// Whether Intelligence answers, by the CLI's own end-to-end check. Running pods are not this.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Readiness {
    Ready,
    Starting,
    Stopped,
    Degraded,
    /// Not reported, not understood, or reported as unknown. Never treated as ready.
    Unknown,
}

/// The evaluation licence, as the CLI verified it. Never the licence itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Licence {
    Valid,
    Expired,
    Missing,
    Invalid,
    OrganizationMismatch,
    /// Not reported or not understood. Never treated as valid.
    Unknown,
}

/// The CLI's own reason for stopping, from its closed set. Only the reason survives; its summary,
/// instructions and resume command do not.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    AuthenticationRequired,
    EulaAcceptanceRequired,
    EulaUnavailable,
    EulaDeclined,
    ReleaseUnavailable,
    FeatureDisabled,
    UnsupportedPlatform,
    UnsupportedEngine,
    PortUnavailable,
    DockerUnavailable,
    UpdateRecoveryRequired,
    IncompatibleRelease,
    LocalCommandBusy,
    LocalCommandFailed,
    /// `connect` asked for its approval flag. Desktop always sends it, so this is a contract gap.
    ConfirmationRequired,
    /// `login`: the dashboard did not answer within the CLI's own wait.
    DashboardUnavailable,
    /// `login`: the CLI could not open the browser. Its fallback is a code approved in a terminal.
    BrowserOpenFailed,
    /// The CLI's own resource check: the engine has too few free CPUs, or too little free memory
    /// or disk. Read from `error.code`, since its `nextAction.reason` is only
    /// `local_command_failed`. Which of them is short is the report's `shortfall`.
    ResourcesShort,
    /// A reason this build does not know. Treated as blocking, never as success.
    Unrecognized,
}

impl Reason {
    fn from_wire(reason: &str) -> Self {
        match reason {
            "authentication_required" => Reason::AuthenticationRequired,
            "eula_acceptance_required" => Reason::EulaAcceptanceRequired,
            "eula_unavailable" => Reason::EulaUnavailable,
            "eula_declined" => Reason::EulaDeclined,
            "release_unavailable" => Reason::ReleaseUnavailable,
            "feature_disabled" => Reason::FeatureDisabled,
            "unsupported_platform" => Reason::UnsupportedPlatform,
            "unsupported_engine" => Reason::UnsupportedEngine,
            "port_unavailable" => Reason::PortUnavailable,
            "docker_unavailable" => Reason::DockerUnavailable,
            "update_recovery_required" => Reason::UpdateRecoveryRequired,
            "incompatible_release" => Reason::IncompatibleRelease,
            "local_command_busy" => Reason::LocalCommandBusy,
            "local_command_failed" => Reason::LocalCommandFailed,
            "confirmation_required" => Reason::ConfirmationRequired,
            "dashboard_unavailable" => Reason::DashboardUnavailable,
            "browser_open_failed" => Reason::BrowserOpenFailed,
            _ => Reason::Unrecognized,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub outcome: Outcome,
    pub stack: Option<Stack>,
    pub reason: Option<Reason>,
    pub readiness: Readiness,
    pub licence: Licence,
    /// When the licence expires, as a strict ISO-8601 instant, so the window can warn ahead of it.
    pub licence_expires_at: Option<String>,
    /// On `status`: the release this app's CLI installs, when the stack runs an older one, or the
    /// release an update the CLI did not finish was moving to. The window runs `update` once,
    /// before it starts OpenBot on that stack (see `update_due`).
    pub update_to: Option<String>,
    /// Every check the CLI made from this computer passed: the back end's API, its gateway and its
    /// dashboard each answered (`readiness.checks`). Only the result is kept.
    ///
    /// Not readiness. The CLI says `degraded` for as long as it keeps an update it did not finish
    /// on record, however well the release it has answers. This is how the window tells that apart
    /// from a back end that is down (see `UnfinishedUpdate`).
    pub checks_passed: bool,
    /// With `Reason::ResourcesShort`: which resources the CLI found short, and on which engine.
    /// With `Readiness::Degraded`: a disk OpenBot found short, or recovering, behind a back end that
    /// runs but does not answer (`checked_when_unhealthy`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortfall: Option<Shortfall>,
}

/// Which of the engine's resources are below what local setup needs, and whether the engine is
/// Podman, so the window names the right resource and the right settings.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortfall {
    pub podman: bool,
    pub cpu: bool,
    pub memory: bool,
    pub disk: bool,
    /// What the CLI measured free, as it said it, to one decimal: CPUs, and GiB of memory and of
    /// disk. Absent when its error did not say.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpus: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_gb: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_gb: Option<String>,
    /// The back end's own disk is nearly full: its node reports `DiskPressure`, or so little is
    /// free that k3s removes the back end's images (`EngineCheck::nearly_full`). OpenBot's own
    /// check after a start that failed, never the CLI's.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub nearly_full: bool,
    /// How large that disk is, in GiB to one decimal, beside `disk_gb`, when it is nearly full.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_size_gb: Option<String>,
    /// The node still reports `DiskPressure` with the disk above both lines: k3s keeps the
    /// condition for five minutes after space is freed, and the back end recovers by itself.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub recovering: bool,
    /// Podman on Windows, whose machine runs in WSL: `podman machine set` changes none of its
    /// resources there, and its disk is freed on the drive that holds it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub wsl: bool,
    /// That drive, `C:`, when WSL says where the machine's disk is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drive: Option<String>,
}

/// A number the CLI printed, to one decimal and rounded down as it rounds, without a trailing `.0`.
fn shown(value: f64) -> String {
    let tenths = (value.max(0.0) * 10.0).floor() / 10.0;
    let said = format!("{tenths:.1}");
    said.strip_suffix(".0").map(str::to_owned).unwrap_or(said)
}

impl Shortfall {
    fn named(&self) -> bool {
        self.cpu || self.memory || self.disk || self.recovering
    }
}

/// What `local connect` answered. The settings it wrote stay in the installation's `.env`; their
/// names and values are not part of this.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub outcome: Outcome,
    pub stack: Option<Stack>,
    pub reason: Option<Reason>,
    /// The CLI found settings it wrote earlier changed since, and kept them.
    pub conflicted: bool,
}

/// What `local login` did. The single-use sign-in link it opens is a bearer credential, and the CLI
/// never prints it; of the rest, only the outcome and the reason are kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignIn {
    pub outcome: Outcome,
    pub reason: Option<Reason>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stack {
    pub id: String,
    pub installed_release: String,
    pub step: String,
    pub urls: Urls,
    pub has_failed_step: bool,
    pub update_in_progress: bool,
    /// The update the CLI keeps on record because it did not finish, when its record names it.
    pub unfinished_update: Option<UnfinishedUpdate>,
    pub observed: Option<Observed>,
    /// The app folders the CLI records the stack for (`appPaths`), as it reported them. Kept only
    /// to tell OpenBot's own stack from another app's (`lists_folder`); never sent to the window.
    #[serde(skip)]
    pub app_paths: Vec<String>,
}

impl Stack {
    /// Whether the CLI records this stack for `folder`, compared as real paths, as the CLI keeps
    /// them. A folder that is not there lists nothing.
    pub fn lists_folder(&self, folder: &std::path::Path) -> bool {
        let Ok(folder) = folder.canonicalize() else {
            return false;
        };
        self.app_paths.iter().any(|path| {
            std::path::Path::new(path)
                .canonicalize()
                .is_ok_and(|path| path == folder)
        })
    }
}

/**
An update `local update` started and did not finish, as `local status` reports its record.

Found on a slow connection: the CLI stopped downloading one of 0.16.0-rc.9's images at its own
ten-minute limit and recorded `failedStep: "image-download"`, with the update still `prepared`.
Nothing in the cluster had changed and every check passed, yet the CLI reports `degraded` for as
long as the record stays, and the window said the back end was not healthy and stopped.

Only facts the window turns into its own sentences: the release (an identifier, like
`installedRelease`), whether the update was still `prepared`, and whether it stopped downloading.
The recovery command and the schema are not kept.
*/
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnfinishedUpdate {
    /// The release the update was moving to.
    pub to: String,
    /// The CLI's update state is still `prepared`: no migration has started, so the release that
    /// answers is the one installed (`installedRelease`).
    pub prepared: bool,
    /// The step that failed was one of the image downloads.
    pub stopped_downloading: bool,
    /// The step the CLI recorded as failed (`failedStep`), an identifier such as `update-quiesce`,
    /// so the window can say where the update stopped. Absent when none is recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_step: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Urls {
    pub api: String,
    pub dashboard: String,
    pub gateway: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Observed {
    pub running: bool,
    pub services: Vec<Service>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Service {
    pub name: String,
    pub phase: String,
    pub ready: bool,
}

/// One `local status` answer as the log says it while Start waits for the back end: its readiness
/// and licence, whether the CLI's checks of the addresses below passed, and which services are not
/// ready yet. Service names and loopback addresses only; nothing secret is in a report.
pub fn status_said(report: &Report) -> String {
    let name = |value: serde_json::Value| value.as_str().unwrap_or("unknown").to_string();
    let mut said = format!(
        "readiness {}, licence {}, checks {}",
        name(serde_json::json!(report.readiness)),
        name(serde_json::json!(report.licence)),
        if report.checks_passed {
            "passed"
        } else {
            "not passed"
        }
    );
    if let Some(reason) = report.reason {
        said.push_str(&format!(", reason {}", name(serde_json::json!(reason))));
    }
    let Some(stack) = &report.stack else {
        said.push_str(", no stack");
        return said;
    };
    if let Some(observed) = &stack.observed {
        let waiting: Vec<String> = observed
            .services
            .iter()
            .filter(|service| !service.ready)
            .map(|service| format!("{} {}", service.name, service.phase))
            .collect();
        said.push_str(&format!(
            ", services {} of {} ready",
            observed.services.len() - waiting.len(),
            observed.services.len()
        ));
        if !waiting.is_empty() {
            said.push_str(&format!(" (not ready: {})", waiting.join(", ")));
        }
    }
    said.push_str(&format!(
        "; API {}, gateway {}, dashboard {}",
        stack.urls.api, stack.urls.gateway, stack.urls.dashboard
    ));
    said
}

/// A wait for the back end nobody ended (Stop, Quit, a window reloaded) is over after this long
/// without a status, so the next one starts its own.
pub const WAIT_FORGOTTEN: std::time::Duration = std::time::Duration::from_secs(120);

/// The lines one `local status` answer adds to Start's wait for the back end
/// (`logging::WaitLog`): what it answered, when that is new or a minute has passed, and that the
/// wait ended once the back end is ready with a valid licence. The window ends a wait that gives up
/// (`back_end_wait_ended`).
pub fn status_waited(
    wait: &mut Option<crate::logging::WaitLog>,
    now: std::time::Instant,
    answer: &Result<Report, Failure>,
) -> Vec<String> {
    if wait
        .as_ref()
        .is_some_and(|wait| wait.quiet_for(now) >= WAIT_FORGOTTEN)
    {
        *wait = None;
    }
    let waiting = wait.get_or_insert_with(|| {
        crate::logging::WaitLog::new(
            "the backend, `local status` until it is ready with a valid licence",
            now,
        )
    });
    let said = match answer {
        Ok(report) => status_said(report),
        Err(failure) => format!("the status call failed: {failure:?}"),
    };
    let mut lines: Vec<String> = waiting.answered(now, &said).into_iter().collect();
    let ready = answer.as_ref().is_ok_and(|report| {
        report.readiness == Readiness::Ready && report.licence == Licence::Valid
    });
    if ready {
        lines.push(waiting.ended(now, "ready"));
        *wait = None;
    }
    lines
}

/// The fixed argument list for one call. Built only from validated types.
pub fn arguments(action: Action, stack: &StackId) -> [&str; 5] {
    [
        "local",
        action.as_str(),
        "--stack",
        stack.as_str(),
        "--json",
    ]
}

/// `local list` takes no stack: it is how a stack id is found in the first place.
pub const LIST_ARGUMENTS: [&str; 3] = ["local", "list", "--json"];

/**
`local setup` creates the stack for the folder it runs in, or resumes one it left unfinished.

The model is deferred: OpenBot's own setup chooses the model, and asking twice would be two answers
to keep in step.

`--accept-eula-version` is passed only with a version the person accepted in the window, after
reading the agreement `terms` reported (`EulaVersion`). Their click in OpenBot is their acceptance:
a product decision of 2026-10-22, recorded in the local evaluation policy. The CLI still refuses
an acceptance from a coding agent, and OpenBot's Bots never reach the CLI.
*/
pub const SETUP_ARGUMENTS: [&str; 4] = ["local", "setup", "--defer-model", "--json"];

/// `SETUP_ARGUMENTS`, with the version the person accepted when they accepted one.
pub fn setup_arguments(accepted: Option<&EulaVersion>) -> Vec<&str> {
    match accepted {
        None => SETUP_ARGUMENTS.to_vec(),
        Some(version) => vec![
            "local",
            "setup",
            "--defer-model",
            "--accept-eula-version",
            version.as_str(),
            "--json",
        ],
    }
}

/**
`local setup` again on the stack OpenBot already made, to give its Learning agent the model the
person signed in to (`learning_model`): `--model-config` with a file OpenBot wrote, or
`--defer-model` to take a model an earlier sign-in gave it away.

On a stack that is running and ready, the CLI changes the Learning agent alone, and a choice it
already has changes nothing (Intelligence `apps/cli/src/services/local-setup.ts`, in the CLI pinned
since `desktop/intelligence-cli.json` named 48a3863). It asks for no licence or agreement there:
those belong to a stack's first setup. The file is an absolute path OpenBot made, never anything
that reads as a flag.
*/
pub fn learning_model_arguments(file: Option<&str>) -> Vec<&str> {
    match file {
        None => SETUP_ARGUMENTS.to_vec(),
        Some(file) => vec!["local", "setup", "--model-config", file, "--json"],
    }
}

/// The evaluation agreement version a person accepted, as `terms` reported it: an identifier such
/// as `developer-edition-2026-10-01-web`, never prose and never anything that reads as a flag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EulaVersion(String);

impl EulaVersion {
    pub fn parse(value: &str) -> Result<Self, Failure> {
        let version =
            text(Some(&Value::String(value.to_owned()))).map_err(|_| Failure::InvalidAcceptance)?;
        if version.starts_with('-') {
            return Err(Failure::InvalidAcceptance);
        }
        Ok(Self(version))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// `copilotkit login --json`: the CopilotKit account sign-in local evaluation needs for its
/// licence. A device authorization grant; the CLI opens the approval page itself.
pub const ACCOUNT_SIGN_IN_ARGUMENTS: [&str; 2] = ["login", "--json"];

/// What `login` adds so the hosted sign-in page explains OpenBot's setup instead of the generic
/// CopilotKit pitch (`source=cli&mode=openbot`, Intelligence#2214 and #2240). Display only: who
/// signs in, what is approved and the token are the same either way.
pub const OPENBOT_SIGN_IN_MODE: [&str; 2] = ["--mode", "openbot"];

/// `copilotkit login --help`, read only, to learn whether this CLI takes `OPENBOT_SIGN_IN_MODE`.
pub const LOGIN_HELP_ARGUMENTS: [&str; 2] = ["login", "--help"];

/// The account sign-in's arguments: with `OPENBOT_SIGN_IN_MODE` only for a CLI that takes it. A
/// CLI from before the flag refuses it with a usage error and signs nobody in.
pub fn account_sign_in_arguments(takes_mode: bool) -> Vec<&'static str> {
    let mut arguments = ACCOUNT_SIGN_IN_ARGUMENTS.to_vec();
    if takes_mode {
        arguments.extend(OPENBOT_SIGN_IN_MODE);
    }
    arguments
}

/// Whether `login --help` lists `--mode openbot`. Help is the CLI's own fixed text, read here and
/// never passed on.
pub fn help_lists_openbot_mode(exit_code: i32, stdout: &[u8]) -> bool {
    exit_code == 0
        && stdout.len() <= MAX_OUTPUT
        && std::str::from_utf8(stdout).is_ok_and(|help| help.contains("--mode openbot"))
}

/// The evaluation agreement, read only: `onboard local-terms --json`.
pub const TERMS_ARGUMENTS: [&str; 3] = ["onboard", "local-terms", "--json"];

/**
This installation's Composio project, from CopilotKit, for the account `login` signed in:
`integrations composio provision --installation-id <UUID> --env-path <file> --json`.

The CLI posts the installation id to Ops with its own session, which never leaves the CLI, writes
the project key it gets back into `env_file` as `COMPOSIO_API_KEY`, and prints only metadata. Ops
makes one project per installation and replays the same key for it after a lost answer
(`reused`). The contract is Intelligence's `docs/contracts/openbot-composio-provisioning.md`; the
command is `apps/cli/src/commands/integrations.ts`, in the CLI pinned since
`desktop/intelligence-cli.json` named 256cc68.
*/
pub fn apps_arguments<'a>(installation: &'a Installation, env_file: &'a str) -> [&'a str; 8] {
    [
        "integrations",
        "composio",
        "provision",
        "--installation-id",
        installation.as_str(),
        "--env-path",
        env_file,
        "--json",
    ]
}

/// An installation id, as OpenBot keeps it: a lowercase UUID, and nothing that could be another
/// argument.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Installation(String);

impl Installation {
    pub fn parse(value: &str) -> Result<Self, Failure> {
        let bytes = value.as_bytes();
        let canonical = bytes.len() == 36
            && bytes.iter().enumerate().all(|(index, byte)| {
                if [8, 13, 18, 23].contains(&index) {
                    *byte == b'-'
                } else {
                    byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
                }
            });
        if canonical {
            Ok(Self(value.to_owned()))
        } else {
            // Refused before anything runs.
            Err(Failure::Spawn)
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What `integrations composio provision` reported. Metadata only: the key is in the file it
/// was given, and the CLI never prints it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppsProvisioned {
    pub installation_id: String,
    pub project_id: String,
    /// Ops replayed the key it made for this installation before.
    pub reused: bool,
}

/**
`integrations composio provision`'s one line of JSON on success, exit 0.

Any failure exits 1 with a sentence on stderr, which is never read: a missing or expired session,
another account's installation, provisioning not set up on Ops, or a repair. Only `completed`, for
the installation asked about, with the file written, is believed. `already_configured` means the
file already held a key, and the file OpenBot hands over never does.
*/
pub fn normalize_apps(
    installation: &Installation,
    exit_code: i32,
    stdout: &[u8],
) -> Result<AppsProvisioned, Failure> {
    if exit_code != 0 {
        return Err(Failure::UnexpectedExit);
    }
    if stdout.len() > MAX_OUTPUT {
        return Err(Failure::OutputLimit);
    }
    let text_out = std::str::from_utf8(stdout).map_err(|_| Failure::InvalidJson)?;
    let wire: Value = serde_json::from_str(text_out.trim()).map_err(|_| Failure::InvalidJson)?;
    let wire = object(&wire)?;
    if wire.get("type").and_then(Value::as_str) != Some("completed")
        || wire.get("installation_id").and_then(Value::as_str) != Some(installation.as_str())
        || wire
            .get("environment_file_written")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err(Failure::ContractMismatch);
    }
    let project_id = wire
        .get("project_id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty() && id.len() <= 256)
        .ok_or(Failure::ContractMismatch)?;
    let reused = wire
        .get("reused")
        .and_then(Value::as_bool)
        .ok_or(Failure::ContractMismatch)?;
    Ok(AppsProvisioned {
        installation_id: installation.as_str().to_owned(),
        project_id: project_id.to_owned(),
        reused,
    })
}

/**
`local connect` connects the folder it runs in, the installation `local setup` was run in, to that
folder's stack.

Approved in the arguments because the person approved it in the window: the CLI's own
confirmation step only prints which settings it will write. It writes `INTELLIGENCE_API_URL`,
`INTELLIGENCE_GATEWAY_WS_URL`, `CPK_INTELLIGENCE_API_KEY`, `SL_ENABLED` and
`.copilotkit/project.json` into the folder. Interim, until the CLI issues OpenBot a credential of
its own (contract request 8).
*/
pub const CONNECT_ARGUMENTS: [&str; 4] = ["local", "connect", "--approve-connection", "--json"];

/**
`local login` signs the browser in to the stack's dashboard with no code to approve.

The CLI waits for the dashboard, mints a single-use link and opens the browser itself, so the app
opens nothing of its own. The browser lands on the dashboard's `/login?autoSignIn=1`; the command
takes no return path.
*/
pub fn login_arguments(stack: &StackId) -> [&str; 5] {
    ["local", "login", "--stack", stack.as_str(), "--json"]
}

/**
Turn what the CLI printed, and how it exited, into the facts this app keeps.

`local` exits 0 with `completed`, 2 with `blocked` and 1 with `failed`. Any other code means it
failed before it could report, so its output is not read. A status that disagrees with its exit
code is a contract this build does not understand, and neither half is believed.
*/
pub fn normalize(action: Action, exit_code: i32, stdout: &[u8]) -> Result<Report, Failure> {
    report(&format!("local {}", action.as_str()), exit_code, stdout)
}

/// `local setup`, held to the same rules as `status`, `start` and `stop`.
pub fn normalize_setup(exit_code: i32, stdout: &[u8]) -> Result<Report, Failure> {
    report("local setup", exit_code, stdout)
}

fn report(command: &str, exit_code: i32, stdout: &[u8]) -> Result<Report, Failure> {
    let wire = parse_envelope(command, exit_code, stdout)?;
    let (outcome, wire) = (wire.0, &wire.1);
    // Only a completed report states how things are now; a refusal's leftovers are not believed.
    let (readiness, (licence, licence_expires_at)) = if outcome == Outcome::Completed {
        (
            readiness(wire.get("readiness")),
            licence(wire.get("license")),
        )
    } else {
        (Readiness::Unknown, (Licence::Unknown, None))
    };
    // Believed with the readiness they came with: a malformed `readiness` carries no checks either.
    let checks_passed = readiness != Readiness::Unknown && checks_passed(wire.get("readiness"));
    let reason = reason(outcome, wire)?;
    // Which resource is short, from the CLI's error, or measured when its error does not say.
    let shortfall = (reason == Some(Reason::ResourcesShort))
        .then(|| shortfall_of(wire, on_podman()))
        .flatten()
        .map(|said| {
            if said.named() {
                said
            } else {
                measured_shortfall(said)
            }
        });
    Ok(Report {
        outcome,
        stack: reported_stack(outcome, wire)?,
        reason,
        readiness,
        licence,
        licence_expires_at,
        update_to: None,
        checks_passed,
        shortfall,
    })
}

/// The stack a report names. A completed command always names one.
fn reported_stack(outcome: Outcome, wire: &Map<String, Value>) -> Result<Option<Stack>, Failure> {
    match wire.get("stack") {
        None | Some(Value::Null) if outcome == Outcome::Completed => Err(Failure::MissingStack),
        None | Some(Value::Null) => Ok(None),
        Some(saved) => Ok(Some(stack(saved)?)),
    }
}

/// `local connect`, held to the same rules. Its `conflicts` are setting names; only whether there
/// were any is kept.
pub fn normalize_connect(exit_code: i32, stdout: &[u8]) -> Result<Connection, Failure> {
    let wire = parse_envelope("local connect", exit_code, stdout)?;
    let (outcome, wire) = (wire.0, &wire.1);
    let conflicted = match wire.get("conflicts") {
        None | Some(Value::Null) => false,
        Some(Value::Array(conflicts)) => !conflicts.is_empty(),
        Some(_) => return Err(Failure::InvalidStatus),
    };
    Ok(Connection {
        outcome,
        stack: reported_stack(outcome, wire)?,
        reason: reason(outcome, wire)?,
        conflicted,
    })
}

/**
`local login`, held to the same rules. A completed login counts only when it says it opened the
browser for the stack it was asked about; its summary, dashboard address and terminal commands are
not kept.
*/
pub fn normalize_login(stack: &StackId, exit_code: i32, stdout: &[u8]) -> Result<SignIn, Failure> {
    let wire = parse_envelope("local login", exit_code, stdout)?;
    let (outcome, wire) = (wire.0, &wire.1);
    if outcome == Outcome::Completed
        && (wire.get("browserOpened") != Some(&Value::Bool(true))
            || wire.get("stackId").and_then(Value::as_str) != Some(stack.as_str()))
    {
        return Err(Failure::InvalidStatus);
    }
    Ok(SignIn {
        outcome,
        reason: reason(outcome, wire)?,
    })
}

/// Whether the CopilotKit account sign-in finished. Only the outcome is kept; the page and code
/// the person approves are shown while it waits (`SignInPage`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSignIn {
    pub signed_in: bool,
}

/**
The approval page `login --json` opened, and the code it shows, for the window to show while the
sign-in waits.

The window needs both. An account in several organizations can land on the CopilotKit dashboard
instead of the approval, and the CLI then waits until its code expires; the person finishes by
opening the same page again, and checks the code before approving. Neither is a secret: the CLI
prints both for whoever runs it, and approving the code signs in this computer's CLI only.
*/
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInPage {
    pub url: String,
    pub user_code: String,
}

/// The longest approval page address taken from the CLI.
const MAX_SIGN_IN_URL: usize = 2048;

/**
The approval page the CLI has printed so far, from its `authentication_url` records: the last
one, since a code that expires unapproved is replaced by a new one (`renewed`). Only complete
lines are read, and a record is taken only when it is the page for its own code: `https`, or
`http` on this computer, with no credentials, carrying `user_code` as the code it names. Anything
else is not shown.
*/
pub fn sign_in_page(stdout: &[u8]) -> Option<SignInPage> {
    let complete = &stdout[..stdout.iter().rposition(|byte| *byte == b'\n')? + 1];
    std::str::from_utf8(complete)
        .ok()?
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|record| record.get("type").and_then(Value::as_str) == Some("authentication_url"))
        .find_map(|record| {
            let url = record.get("url")?.as_str()?;
            let code = record.get("user_code")?.as_str()?;
            checked_sign_in_page(url, code)
        })
}

fn checked_sign_in_page(url: &str, code: &str) -> Option<SignInPage> {
    let code_ok = (1..=32).contains(&code.len())
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if !code_ok || url.len() > MAX_SIGN_IN_URL {
        return None;
    }
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    let on_this_computer = host == "localhost"
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    let scheme_ok = parsed.scheme() == "https" || (parsed.scheme() == "http" && on_this_computer);
    let carries_code = parsed
        .query_pairs()
        .any(|(name, value)| name == "user_code" && value == code);
    let no_credentials = parsed.username().is_empty() && parsed.password().is_none();
    (scheme_ok && no_credentials && carries_code).then(|| SignInPage {
        url: parsed.into(),
        user_code: code.to_owned(),
    })
}

/**
`login --json`'s JSON Lines, ending `completed` or `failed`.

The last `completed` or `failed` line decides, and it has to agree with the exit code. Lines before
it (`action_required`, with the approval page and code) are not kept.
*/
pub fn normalize_account_sign_in(exit_code: i32, stdout: &[u8]) -> Result<AccountSignIn, Failure> {
    if stdout.len() > MAX_OUTPUT {
        return Err(Failure::OutputLimit);
    }
    let text = std::str::from_utf8(stdout).map_err(|_| Failure::InvalidJson)?;
    let last = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str::<Value>(line).map_err(|_| Failure::InvalidJson))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter_map(|event| event.get("type").and_then(Value::as_str).map(str::to_owned))
        .rfind(|kind| kind == "completed" || kind == "failed")
        .ok_or(Failure::InvalidStatus)?;
    let signed_in = last == "completed";
    if signed_in != (exit_code == 0) {
        return Err(Failure::ContractMismatch);
    }
    Ok(AccountSignIn { signed_in })
}

/// The evaluation agreement the licence needs, as the window shows it. No CLI prose is kept but
/// the one sentence of a preflight that blocked (`Blocked`).
///
/// The window reads the CLI's own status words (`signed-out`) and camelCase fields
/// (`organizationName`). A variant named in camelCase reaches it as `signedOut`, which it does not
/// know, and an unknown status is taken as nothing to accept.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum Terms {
    Required {
        accepted: bool,
        version: String,
        url: String,
        organization_name: String,
    },
    NotRequired,
    Unavailable,
    SignedOut,
    /// The CLI answers nothing about the agreement until a container engine answers it. On a new
    /// computer Install is still putting Podman in while the person signs in.
    EngineNotReady {
        /// What the CLI's preflight said, for the log only (`AccountWait`): `docker_unavailable`,
        /// or `engine_mismatch`. The window is told only that the engine is not ready.
        #[serde(skip)]
        cause: &'static str,
    },
    /// The CLI's preflight refused this computer for a reason waiting does not change: an engine
    /// local setup does not run on, such as OrbStack on a Mac, or too few CPUs. `said` is the CLI's
    /// own sentence for it, when it is one plain line.
    Blocked {
        reason: Reason,
        #[serde(skip_serializing_if = "Option::is_none")]
        said: Option<String>,
        /// The engine itself is refused: the fix is Docker Desktop or Podman instead.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        switch_engine: bool,
    },
    /// The engine has fewer CPUs or less memory than local setup needs (`engine_size_terms`).
    /// Not a CLI answer: OpenBot's own check, so a small engine is caught before Start.
    EngineTooSmall {
        podman: bool,
        cpu: bool,
        memory: bool,
        disk: bool,
        /// Podman on Windows, in WSL (`Shortfall::wsl`), and the drive that holds its disk.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        wsl: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        drive: Option<String>,
        /// What was measured, for the desktop's usage data only. Never sent to the window.
        #[serde(skip)]
        measured: EngineMeasure,
    },
}

/// The engine's CPUs, memory and free disk as OpenBot measured them (`EngineCheck`), in counts and
/// bytes. Free disk that could not be measured is absent.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EngineMeasure {
    pub cpus: u64,
    pub memory_bytes: u64,
    pub free_disk_bytes: Option<u64>,
}

/// `onboard local-terms --json`: one object, exit 0. The address must be https; the organization
/// name is shown as text, so it is bounded and has no control characters.
pub fn normalize_terms(exit_code: i32, stdout: &[u8]) -> Result<Terms, Failure> {
    if exit_code != 0 {
        return Err(Failure::UnexpectedExit);
    }
    if stdout.len() > MAX_OUTPUT {
        return Err(Failure::OutputLimit);
    }
    let text_out = std::str::from_utf8(stdout).map_err(|_| Failure::InvalidJson)?;
    let wire: Value = serde_json::from_str(text_out.trim()).map_err(|_| Failure::InvalidJson)?;
    let wire = object(&wire)?;
    if wire.get("command").and_then(Value::as_str) != Some("onboard local-terms") {
        return Err(Failure::UnexpectedCommand);
    }
    match wire.get("status").and_then(Value::as_str) {
        Some("not-required") => Ok(Terms::NotRequired),
        Some("unavailable") => Ok(Terms::Unavailable),
        Some("signed-out") => Ok(Terms::SignedOut),
        Some("blocked") => preflight_terms(wire.get("preflight")),
        Some("required") => {
            let url = wire
                .get("url")
                .and_then(Value::as_str)
                .filter(|url| {
                    url.len() <= 2048
                        && reqwest::Url::parse(url).is_ok_and(|parsed| parsed.scheme() == "https")
                })
                .ok_or(Failure::InvalidStatus)?;
            let organization_name = wire
                .get("organizationName")
                .and_then(Value::as_str)
                .filter(|name| {
                    !name.is_empty()
                        && name.chars().count() <= 200
                        && !name.chars().any(char::is_control)
                })
                .ok_or(Failure::InvalidStatus)?;
            Ok(Terms::Required {
                accepted: wire
                    .get("accepted")
                    .and_then(Value::as_bool)
                    .ok_or(Failure::InvalidStatus)?,
                version: EulaVersion::parse(
                    wire.get("version").and_then(Value::as_str).unwrap_or(""),
                )
                .map_err(|_| Failure::InvalidStatus)?
                .0,
                url: url.to_owned(),
                organization_name: organization_name.to_owned(),
            })
        }
        _ => Err(Failure::InvalidStatus),
    }
}

/**
`onboard local-terms` blocked by its preflight (`preflight.status` "fail").

Only an engine that is not there yet is waited for: one that does not answer (`docker_unavailable`),
or, while Install is still choosing the engine, a Docker address that answers with Podman
(`engine_mismatch`). Anything else is said at once, since trying again every few seconds cannot
change it.
*/
fn preflight_terms(preflight: Option<&Value>) -> Result<Terms, Failure> {
    let field = |name: &str| {
        preflight
            .and_then(|preflight| preflight.get(name))
            .and_then(Value::as_str)
    };
    if field("status") != Some("fail") {
        return Err(Failure::InvalidStatus);
    }
    let reason = field("reason").unwrap_or("");
    let detail = field("failureDetail");
    if reason == "docker_unavailable" {
        return Ok(Terms::EngineNotReady {
            cause: "docker_unavailable",
        });
    }
    if reason == "unsupported_engine" && detail == Some("engine_mismatch") {
        return Ok(Terms::EngineNotReady {
            cause: "engine_mismatch",
        });
    }
    Ok(Terms::Blocked {
        reason: Reason::from_wire(reason),
        // Shown as the CLI wrote it, so only as one bounded line of plain text.
        said: field("detail")
            .map(str::trim)
            .filter(|said| {
                !said.is_empty()
                    && said.chars().count() <= 400
                    && !said.chars().any(char::is_control)
            })
            .map(str::to_owned),
        switch_engine: reason == "unsupported_engine"
            && detail == Some("engine_not_docker_desktop"),
    })
}

/**
What the Account step's sign-in check is waiting on, kept from one check to the next so the desktop
log says each change once. The window asks every 2 seconds while no engine answers.

On a new Mac the step said "Checking your CopilotKit account…" for minutes while Install put Podman
in, and only the CLI's own log, a failed preflight every few seconds, said why.
*/
#[derive(Debug, Default)]
pub struct AccountWait {
    engine: Option<EngineWait>,
}

#[derive(Debug)]
struct EngineWait {
    since: Instant,
    checks: u32,
    step: Option<String>,
}

impl AccountWait {
    pub const fn new() -> Self {
        Self { engine: None }
    }

    /**
    The log entry for one sign-in check that ended at `now` after `took`, or None when it changes
    nothing the log has said. `step` is the setup step running now, if any, such as
    `create-machine`.
    */
    pub fn heard(
        &mut self,
        now: Instant,
        took: Duration,
        answer: &Result<Terms, Failure>,
        step: Option<&str>,
    ) -> Option<String> {
        let step_said = step.unwrap_or("none running");
        if let Ok(Terms::EngineNotReady { cause }) = answer {
            let Some(wait) = &mut self.engine else {
                self.engine = Some(EngineWait {
                    since: now.checked_sub(took).unwrap_or(now),
                    checks: 1,
                    step: step.map(str::to_owned),
                });
                return Some(format!(
                    "[account] waiting for the engine before the sign-in check: the CLI's \
                     preflight says {cause}; install step: {step_said}"
                ));
            };
            wait.checks += 1;
            if wait.step.as_deref() == step {
                return None;
            }
            wait.step = step.map(str::to_owned);
            return Some(format!(
                "[account] still waiting for the engine after {}s ({} checks); install step: \
                 {step_said}",
                now.saturating_duration_since(wait.since).as_secs(),
                wait.checks,
            ));
        }
        let took = took.as_secs_f32();
        let checked = match answer {
            Ok(terms) => format!(
                "sign-in check answered {} after {took:.1}s",
                terms_said(terms)
            ),
            Err(failure) => format!("sign-in check failed after {took:.1}s: {failure:?}"),
        };
        Some(match self.engine.take() {
            Some(wait) => format!(
                "[account] {} after {}s ({} checks); {checked}",
                if answer.is_ok() {
                    "engine answering"
                } else {
                    "stopped waiting for the engine"
                },
                now.saturating_duration_since(wait.since).as_secs(),
                wait.checks + 1,
            ),
            None => format!("[account] {checked}"),
        })
    }
}

/// An answer as the log says it, in the CLI's own status words.
fn terms_said(terms: &Terms) -> String {
    match terms {
        Terms::Required { accepted: true, .. } => "required, accepted".to_owned(),
        Terms::Required {
            accepted: false, ..
        } => "required, not accepted".to_owned(),
        Terms::NotRequired => "not-required".to_owned(),
        Terms::Unavailable => "unavailable".to_owned(),
        Terms::SignedOut => "signed-out".to_owned(),
        Terms::EngineNotReady { cause } => format!("engine-not-ready ({cause})"),
        // The CLI's own sentence for it: the window says OpenBot's, and the log keeps this one.
        Terms::Blocked { reason, said, .. } => match said {
            Some(said) => format!("blocked ({reason:?}): {said}"),
            None => format!("blocked ({reason:?})"),
        },
        Terms::EngineTooSmall { .. } => "engine-too-small".to_owned(),
    }
}

/**
`readiness.state`, believed only as one of its exact wire values and with a strict `checkedAt`.

Anything else, including a missing or malformed field, is `Unknown`. That is how a CLI that
predates the field reads, and it is not an error: the rest of the report still stands. The check
names in `checks` are not kept.
*/
fn readiness(value: Option<&Value>) -> Readiness {
    let Some(Value::Object(readiness)) = value else {
        return Readiness::Unknown;
    };
    if !readiness
        .get("checkedAt")
        .and_then(Value::as_str)
        .is_some_and(instant)
    {
        return Readiness::Unknown;
    }
    match readiness.get("state").and_then(Value::as_str) {
        Some("ready") => Readiness::Ready,
        Some("starting") => Readiness::Starting,
        Some("stopped") => Readiness::Stopped,
        Some("degraded") => Readiness::Degraded,
        _ => Readiness::Unknown,
    }
}

/**
Whether `readiness.checks` names the CLI's three checks, `api`, `gateway` and `dashboard`, and every
check it lists passed. Anything else is false, an empty list, a missing check or one in another
shape included, and the rest of the report still stands: an older CLI publishes no checks at all.
*/
fn checks_passed(value: Option<&Value>) -> bool {
    let Some(Value::Array(checks)) = value.and_then(|readiness| readiness.get("checks")) else {
        return false;
    };
    let passed = |check: &Value| check.get("ok") == Some(&Value::Bool(true));
    let listed = |name: &str| {
        checks
            .iter()
            .any(|check| check.get("name").and_then(Value::as_str) == Some(name))
    };
    checks.iter().all(passed) && ["api", "gateway", "dashboard"].into_iter().all(listed)
}

/**
`license.state` and `license.expiresAt`, by the same rule. `expiresAt` must be present, as `null`
or a strict instant; anything else makes the whole licence `Unknown`, so a valid state never
travels with an expiry nobody could read. The organization and renewal fields are not kept.
*/
fn licence(value: Option<&Value>) -> (Licence, Option<String>) {
    const UNKNOWN: (Licence, Option<String>) = (Licence::Unknown, None);
    let Some(Value::Object(licence)) = value else {
        return UNKNOWN;
    };
    let expires_at = match licence.get("expiresAt") {
        Some(Value::Null) => None,
        Some(Value::String(at)) if instant(at) => Some(at.clone()),
        _ => return UNKNOWN,
    };
    let state = match licence.get("state").and_then(Value::as_str) {
        Some("valid") => Licence::Valid,
        Some("expired") => Licence::Expired,
        Some("missing") => Licence::Missing,
        Some("invalid") => Licence::Invalid,
        Some("organization_mismatch") => Licence::OrganizationMismatch,
        _ => return UNKNOWN,
    };
    (state, expires_at)
}

/**
An ISO-8601 instant in the one form a JavaScript CLI prints: `YYYY-MM-DDTHH:MM:SS`, an optional
fraction of one to nine digits, then `Z` or `±HH:MM`. Every field is range-checked against the
calendar. Nothing else is copied, so no prose or token can ride through as a date.
*/
fn instant(text: &str) -> bool {
    let bytes = text.as_bytes();
    let digits = |from: usize, to: usize| -> Option<u32> {
        let part = bytes.get(from..to)?;
        part.iter().all(u8::is_ascii_digit).then(|| {
            part.iter()
                .fold(0, |sum, byte| sum * 10 + u32::from(byte - b'0'))
        })
    };
    let at = |index: usize, byte: u8| bytes.get(index) == Some(&byte);
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        digits(0, 4),
        digits(5, 7),
        digits(8, 10),
        digits(11, 13),
        digits(14, 16),
        digits(17, 19),
    ) else {
        return false;
    };
    if !(at(4, b'-') && at(7, b'-') && at(10, b'T') && at(13, b':') && at(16, b':')) {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    if !((1..=days).contains(&day) && hour < 24 && minute < 60 && second < 60) {
        return false;
    }
    let mut rest = 19;
    if at(rest, b'.') {
        let fraction = bytes[rest + 1..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        if !(1..=9).contains(&fraction) {
            return false;
        }
        rest += 1 + fraction;
    }
    match &bytes[rest..] {
        b"Z" => true,
        [b'+' | b'-', ..] if bytes.len() == rest + 6 && at(rest + 3, b':') => {
            digits(rest + 1, rest + 3).is_some_and(|hours| hours < 24)
                && digits(rest + 4, rest + 6).is_some_and(|minutes| minutes < 60)
        }
        _ => false,
    }
}

/// The stacks the CLI has recorded on this machine, from `local list`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Listing {
    pub outcome: Outcome,
    pub stacks: Vec<Stack>,
    pub reason: Option<Reason>,
}

/// More recorded stacks than this is not a listing this app can present.
const MAX_STACKS: usize = 64;

/// `local list`: every recorded stack, each held to the same rules as a status report. One stack
/// that fails them fails the listing, rather than leaving a partial one. The app folders each
/// stack is connected to are paths on this machine, and are not kept.
pub fn normalize_list(exit_code: i32, stdout: &[u8]) -> Result<Listing, Failure> {
    let wire = parse_envelope("local list", exit_code, stdout)?;
    let (outcome, wire) = (wire.0, &wire.1);
    let stacks = match (outcome, wire.get("stacks")) {
        (Outcome::Completed, Some(Value::Array(stacks))) if stacks.len() <= MAX_STACKS => {
            stacks.iter().map(stack).collect::<Result<_, _>>()?
        }
        (Outcome::Completed, _) => return Err(Failure::InvalidStatus),
        _ => Vec::new(),
    };
    Ok(Listing {
        outcome,
        stacks,
        reason: reason(outcome, wire)?,
    })
}

/// Only the CLI's reason for stopping, never its summary, instructions or resume command.
fn reason(outcome: Outcome, wire: &Map<String, Value>) -> Result<Option<Reason>, Failure> {
    if outcome != Outcome::Completed && resource_shortfall_code(wire).is_some() {
        return Ok(Some(Reason::ResourcesShort));
    }
    match (outcome, wire.get("nextAction")) {
        (Outcome::Completed, _) | (_, None | Some(Value::Null)) => Ok(None),
        (_, Some(next)) => match object(next)?.get("reason") {
            Some(Value::String(reason)) => Ok(Some(Reason::from_wire(reason))),
            None | Some(Value::Null) => Ok(None),
            Some(_) => Err(Failure::InvalidStatus),
        },
    }
}

/**
The `error.code` the CLI gives when its resource check fails (`LocalResourceShortfallError`): too
few free CPUs, too little free memory or too little free storage in the engine. A probe that could
not measure (`LOCAL_DOCKER_RESOURCES_UNMEASURABLE`) is not a shortfall and stays a plain failure.
*/
const RESOURCES_SHORT: &str = "LOCAL_DOCKER_RESOURCES_SHORT";
const MEMORY_SHORT: &str = "LOCAL_DOCKER_MEMORY_SHORT";

fn resource_shortfall_code(wire: &Map<String, Value>) -> Option<&str> {
    wire.get("error")
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        .filter(|code| [RESOURCES_SHORT, MEMORY_SHORT].contains(code))
}

/**
Which resources the CLI found short, from its own error. `LOCAL_DOCKER_MEMORY_SHORT` is memory
alone. `LOCAL_DOCKER_RESOURCES_SHORT` says each measure beside what it requires: "Docker available
resources: 9.8 CPUs (requires 4), 18.9 GiB RAM available (requires 4), 0 GiB free storage (requires
40)." Only these numbers are read; the rest of the message is not kept.
*/
fn shortfall_of(wire: &Map<String, Value>, podman: bool) -> Option<Shortfall> {
    let code = resource_shortfall_code(wire)?;
    let mut shortfall = Shortfall {
        podman,
        ..Shortfall::default()
    };
    let message = wire
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if code == MEMORY_SHORT {
        shortfall.memory = true;
        let available = regex::Regex::new(r"([\d.]+) GiB available to new containers")
            .expect("a valid pattern");
        shortfall.memory_gb = available
            .captures(message)
            .and_then(|found| found[1].parse::<f64>().ok())
            .map(shown);
        return Some(shortfall);
    }
    let measures = regex::Regex::new(
        r"(-?[\d.]+) CPUs \(requires ([\d.]+)\), (-?[\d.]+) GiB RAM available \(requires ([\d.]+)\), (-?[\d.]+) GiB free storage \(requires ([\d.]+)\)",
    )
    .expect("a valid pattern");
    if let Some(found) = measures.captures(message) {
        let number = |at: usize| found[at].parse::<f64>().ok();
        let below = |have: usize, need: usize| match (number(have), number(need)) {
            (Some(have), Some(need)) => have < need,
            _ => false,
        };
        shortfall.cpu = below(1, 2);
        shortfall.memory = below(3, 4);
        shortfall.disk = below(5, 6);
        shortfall.cpus = number(1).map(shown);
        shortfall.memory_gb = number(3).map(shown);
        shortfall.disk_gb = number(5).map(shown);
    }
    Some(shortfall)
}

/// The engine the CLI runs on, when the app has said.
fn cli_engine() -> Option<crate::engine::Address> {
    ENGINE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn on_podman() -> bool {
    cli_engine().is_some_and(|address| address.engine == crate::engine::Engine::Podman)
}

const GIB: u64 = 1024 * 1024 * 1024;

/**
The smallest engine OpenBot lets through before local setup: 4 CPUs, 4 GiB of memory and 40 GiB of
free disk.

The CLI's own check wants 4 free CPUs and 4 GiB of free memory inside a container, so an engine
below those totals can never pass it. Anything larger is left to the CLI at Start: OpenBot's own
Podman machine is 4 CPUs and 6 GiB and passes there, so a stricter total here would stop every
Podman install. Free disk is the CLI's own 40 GiB, measured as it measures it, inside a container.
*/
pub const MIN_ENGINE_CPUS: u64 = 4;
pub const MIN_ENGINE_MEMORY_BYTES: u64 = 4 * GIB;
pub const MIN_ENGINE_FREE_DISK_BYTES: u64 = 40 * GIB;

/// What an engine of this size is short of for local setup. Free disk that could not be measured
/// is not judged.
pub fn engine_shortfall(cpus: u64, memory_bytes: u64, free_disk_bytes: Option<u64>) -> Shortfall {
    Shortfall {
        cpu: cpus < MIN_ENGINE_CPUS,
        memory: memory_bytes < MIN_ENGINE_MEMORY_BYTES,
        disk: free_disk_bytes.is_some_and(|free| free < MIN_ENGINE_FREE_DISK_BYTES),
        ..Shortfall::default()
    }
}

/// The engine's CPUs and memory as its `info` reports them: `NCPU MemTotal` on Docker,
/// `Host.CPUs Host.MemTotal` on Podman. Anything else is no answer.
pub fn parse_engine_size(output: &str) -> Option<(u64, u64)> {
    let mut fields = output.split_whitespace();
    let cpus = fields.next()?.parse().ok()?;
    let memory = fields.next()?.parse().ok()?;
    fields.next().is_none().then_some((cpus, memory))
}

/// A filesystem as `df -Pk` reports it, in bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Disk {
    pub size: u64,
    pub free: u64,
}

/// Size and free bytes from `df -Pk /`: the second and fourth fields of its last line, in KiB, as
/// the CLI reads them.
pub fn parse_disk(output: &str) -> Option<Disk> {
    let mut fields = output.trim().lines().last()?.split_whitespace();
    let size: u64 = fields.nth(1)?.parse().ok()?;
    let free: u64 = fields.nth(1)?.parse().ok()?;
    Some(Disk {
        size: size * 1024,
        free: free * 1024,
    })
}

/// Free bytes from `df -Pk /`, as the CLI reads them.
pub fn parse_free_disk(output: &str) -> Option<u64> {
    parse_disk(output).map(|disk| disk.free)
}

/**
How long each engine command of the check may take: `info` and `image ls`, and the `run` that
measures disk, which starts a container. An engine that does not answer within it is not measured,
as one that fails is, so a hung engine never holds the account step or a Start.
*/
const ENGINE_QUERY_LIMIT: Duration = Duration::from_secs(15);
const ENGINE_RUN_LIMIT: Duration = Duration::from_secs(20);
/// The most of an engine command's output the check reads: a long image list, at most.
const ENGINE_OUTPUT_CAP: usize = 1024 * 1024;

/// What a test sets the engine check's limits to.
#[cfg(test)]
static ENGINE_CHECK_LIMIT_FOR_TESTS: std::sync::Mutex<Option<Duration>> =
    std::sync::Mutex::new(None);

/// `args` on the engine, within `limit`: whether it succeeded, and its stdout. Nothing when it did
/// not finish in time or could not run.
fn engine_answer(
    address: &crate::engine::Address,
    args: &[&str],
    limit: Duration,
) -> Option<(bool, String)> {
    #[cfg(test)]
    let limit = ENGINE_CHECK_LIMIT_FOR_TESTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .unwrap_or(limit);
    let mut command = address.command();
    command.args(args);
    let (succeeded, stdout) = crate::local_images::run_within(command, limit, ENGINE_OUTPUT_CAP)?;
    Some((succeeded, String::from_utf8_lossy(&stdout).into_owned()))
}

/// `args` on the engine, within `limit`: its stdout when it succeeded, or nothing.
fn engine_output(
    address: &crate::engine::Address,
    args: &[&str],
    limit: Duration,
) -> Option<String> {
    engine_answer(address, args, limit).and_then(|(succeeded, stdout)| succeeded.then_some(stdout))
}

/// The engine's CPUs and memory from its `info`.
fn engine_size(address: &crate::engine::Address) -> Option<(u64, u64)> {
    let format = if address.engine == crate::engine::Engine::Podman {
        "{{.Host.CPUs}} {{.Host.MemTotal}}"
    } else {
        "{{.NCPU}} {{.MemTotal}}"
    };
    parse_engine_size(&engine_output(
        address,
        &["info", "--format", format],
        ENGINE_QUERY_LIMIT,
    )?)
}

/**
The engine's disk inside a container, the way the CLI measures it: `df -Pk /` in a container of an
image the engine already has, so nothing is downloaded. An engine with no image that has a shell
gives no answer, and disk is then not judged. Also what `update_ready` measures before it downloads
an update's images ahead of time.
*/
pub fn engine_disk(address: &crate::engine::Address) -> Option<Disk> {
    let images = engine_output(
        address,
        &["image", "ls", "--quiet", "--no-trunc"],
        ENGINE_QUERY_LIMIT,
    )?;
    let mut tried = Vec::new();
    for image in images.lines().map(str::trim).filter(|id| !id.is_empty()) {
        if tried.contains(&image) {
            continue;
        }
        if tried.len() == 3 {
            break;
        }
        tried.push(image);
        // No answer in time is an engine that hangs: another image would only hang too.
        let (succeeded, measured) = engine_answer(
            address,
            &[
                "run",
                "--rm",
                "--pull=never",
                "--network=none",
                "--entrypoint",
                "/bin/sh",
                image,
                "-c",
                "df -Pk /",
            ],
            ENGINE_RUN_LIMIT,
        )?;
        if let Some(disk) = succeeded.then(|| parse_disk(&measured)).flatten() {
            return Some(disk);
        }
    }
    None
}

#[cfg(test)]
thread_local! {
    /// What Windows says of the drive that holds the Podman machine's disk, for the tests: Some
    /// stands in for `windows::podman_machine_drive` on this thread.
    static MACHINE_DRIVE: std::cell::RefCell<Option<Option<crate::windows::MachineDrive>>> =
        const { std::cell::RefCell::new(None) };
}

/// The drive that holds the Podman machine `address` names, on Windows (`podman_machine_drive`).
fn machine_drive(address: &crate::engine::Address) -> Option<crate::windows::MachineDrive> {
    if address.engine != crate::engine::Engine::Podman {
        return None;
    }
    #[cfg(test)]
    if let Some(said) = MACHINE_DRIVE.with(|drive| drive.borrow().clone()) {
        return said;
    }
    let connection = address
        .connection
        .clone()
        .or_else(|| address.pin().ok().and_then(|pinned| pinned.connection))?;
    crate::windows::podman_machine_drive(crate::acquire::machine_of(&connection))
}

/**
What OpenBot measured of the engine the back end runs on (`[local check]` in the log): its CPUs and
memory, its disk as a container sees it, on Windows the drive that holds a Podman machine's disk, and
after a call that failed, whether the back end's node says it is short of disk.
*/
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct EngineCheck {
    podman: bool,
    /// CPUs and bytes of memory, from the engine's `info`.
    size: Option<(u64, u64)>,
    disk: Option<Disk>,
    drive: Option<crate::windows::MachineDrive>,
    /// `DiskPressure` on the back end's node (`local_images::Node::disk_pressure`).
    pressure: Option<bool>,
}

/// Bytes as GiB to one decimal, as the CLI rounds them.
fn gib(bytes: u64) -> String {
    shown(bytes as f64 / GIB as f64)
}

impl EngineCheck {
    fn of(address: &crate::engine::Address) -> Self {
        Self {
            podman: address.engine == crate::engine::Engine::Podman,
            size: engine_size(address),
            disk: engine_disk(address),
            drive: machine_drive(address),
            pressure: None,
        }
    }

    /// The free disk that counts: the smaller of what a container sees and what the drive under
    /// the machine's disk has. Either can run out first.
    fn free_disk(&self) -> Option<u64> {
        [
            self.disk.map(|disk| disk.free),
            self.drive.as_ref().map(|drive| drive.free),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    /**
    The back end's own disk is nearly full, by k3s's lines rather than the CLI's 40 GiB: its node
    says `DiskPressure`, which k3s raises below 5% free (`evictionHard`), or less than 15% is free,
    where the kubelet starts removing the images it is not running (`imageGCHighThresholdPercent`
    85). A relaunched back end runs none yet, so that is when it loses them.
    */
    fn nearly_full(&self) -> bool {
        self.pressure == Some(true) && !self.recovering() || self.below_image_line()
    }

    /// Less than 15% of the node's disk free: the kubelet removes images it is not running.
    fn below_image_line(&self) -> bool {
        self.disk
            .is_some_and(|disk| u128::from(disk.free) * 100 < u128::from(disk.size) * 15)
    }

    /// Below the CLI's 40 GiB, or below the kubelet's image line.
    fn low_on_disk(&self) -> bool {
        self.free_disk()
            .is_some_and(|free| free < MIN_ENGINE_FREE_DISK_BYTES)
            || self.below_image_line()
    }

    /**
    The node still says `DiskPressure`, but the disk is above both lines: space was freed, and k3s
    keeps the condition for five minutes after (`evictionPressureTransitionPeriod`). The back end
    recovers by itself, and a Retry in those minutes only fails again.
    */
    fn recovering(&self) -> bool {
        self.pressure == Some(true) && self.free_disk().is_some() && !self.low_on_disk()
    }

    /// Podman on Windows, whose machine runs in WSL.
    fn wsl(&self) -> bool {
        self.podman && (cfg!(target_os = "windows") || self.drive.is_some())
    }

    /// What is short, with the numbers. Anything not measured is not judged.
    fn shortfall(&self) -> Shortfall {
        let (cpus, memory) = self.size.unwrap_or((u64::MAX, u64::MAX));
        let free = self.free_disk();
        let mut short = engine_shortfall(cpus, memory, free);
        short.podman = self.podman;
        short.wsl = self.wsl();
        short.recovering = self.recovering();
        short.nearly_full = self.nearly_full();
        short.disk |= short.nearly_full;
        if short.disk {
            short.disk_gb = free.map(gib);
            short.disk_size_gb = self
                .disk
                .filter(|_| short.nearly_full)
                .map(|disk| gib(disk.size));
        }
        short.drive = self.drive.as_ref().and_then(|drive| drive.drive.clone());
        short
    }

    /// `4 CPUs and 5.8 GiB of memory, 30.5 GiB free of 983.2 GiB in a container, 120.0 GiB free on
    /// C:, no disk pressure`, then what is short.
    fn said(&self) -> String {
        let mut said = vec![match self.size {
            Some((cpus, memory)) => format!("{cpus} CPUs and {} GiB of memory", gib(memory)),
            None => "CPUs and memory not measured".to_owned(),
        }];
        said.push(match self.disk {
            Some(disk) => format!(
                "{} GiB free of {} GiB in a container",
                gib(disk.free),
                gib(disk.size)
            ),
            None => "free disk not measured".to_owned(),
        });
        if let Some(drive) = &self.drive {
            let on = drive
                .drive
                .as_deref()
                .unwrap_or("the drive that holds its disk");
            said.push(format!("{} GiB free on {on}", gib(drive.free)));
        }
        match self.pressure {
            Some(true) => said.push("the node reports disk pressure".to_owned()),
            Some(false) => said.push("no disk pressure".to_owned()),
            None => {}
        }
        let short = self.shortfall();
        let mut verdict: Vec<&str> = Vec::new();
        if short.cpu {
            verdict.push("CPUs");
        }
        if short.memory {
            verdict.push("memory");
        }
        if short.disk {
            verdict.push(if short.nearly_full {
                "disk (nearly full)"
            } else {
                "disk (OpenBot needs 40 GiB free)"
            });
        }
        let verdict = if short.recovering && verdict.is_empty() {
            "recovering: the node still reports disk pressure with the disk above both lines"
                .to_owned()
        } else if !verdict.is_empty() {
            format!("short of {}", verdict.join(", "))
        } else if self.size.is_none() && self.free_disk().is_none() {
            "not measured".to_owned()
        } else {
            "enough".to_owned()
        };
        format!("{}; {verdict}", said.join(", "))
    }
}

/// The engine the back end runs on, when the app has said: the one troubleshooting logs measure.
pub fn engine_in_use() -> Option<crate::engine::Address> {
    cli_engine()
}

/// The engine measured as `[local check]` logs it (`EngineCheck::said`): CPUs and memory, free disk
/// inside a container and on the drive under a Podman machine, and what is short.
pub fn measured_engine(address: &crate::engine::Address) -> String {
    EngineCheck::of(address).said()
}

/// `args` on the engine within the check's limit for a query: its stdout when it succeeded.
pub fn engine_query(address: &crate::engine::Address, args: &[&str]) -> Option<String> {
    engine_output(address, args, ENGINE_QUERY_LIMIT)
}

/// Log a check: `[local check] before local start: ...`. A shortfall is a warning.
fn log_check(when: &str, check: &EngineCheck) {
    let level = if check.shortfall().named() {
        log::Level::Warn
    } else {
        log::Level::Info
    };
    log::log!(level, "[local check] {when}: {}", check.said());
}

/**
The onboarding check of the engine, before the account screen asks about the agreement:
`Some(Terms::EngineTooSmall)` for an engine below `MIN_ENGINE_CPUS`, `MIN_ENGINE_MEMORY_BYTES` or
`MIN_ENGINE_FREE_DISK_BYTES` free. An engine that is not known yet or does not answer is not judged
here; the CLI's own check still runs at Start.
*/
pub fn engine_size_terms() -> Option<Terms> {
    let address = cli_engine()?;
    let check = EngineCheck::of(&address);
    let (cpus, memory) = check.size?;
    let short = engine_shortfall(cpus, memory, check.free_disk());
    if !short.named() {
        return None;
    }
    log_check("before local setup", &check);
    Some(Terms::EngineTooSmall {
        podman: check.podman,
        cpu: short.cpu,
        memory: short.memory,
        disk: short.disk,
        wsl: check.wsl(),
        measured: EngineMeasure {
            cpus,
            memory_bytes: memory,
            free_disk_bytes: check.free_disk(),
        },
        drive: check.drive.and_then(|drive| drive.drive),
    })
}

/**
A shortfall whose CLI error did not say which resource, measured here instead: CPUs and memory from
the engine's `info` against the CLI's 4 and 4 GiB, and free disk inside a container, and on the drive
under a Podman machine's disk, against its 40 GiB.
*/
fn measured_shortfall(shortfall: Shortfall) -> Shortfall {
    let Some(address) = cli_engine() else {
        return shortfall;
    };
    let measured = EngineCheck::of(&address).shortfall();
    Shortfall {
        podman: shortfall.podman,
        ..measured
    }
}

/**
The engine checked around a call that starts the back end, `local start`, `local update` or `local
setup`.

Before it, the check is only logged: an existing back end can run on less than the CLI's 40 GiB, and
the CLI enforces that only at a first setup. After a call that failed, it is checked again, with the
back end's node asked whether it is short of disk, and anything short becomes the report's reason
with its numbers, so the card names it and says where to raise or free it. A failure the CLI already
named, or one OpenBot stopped, keeps its own words.
*/
fn checked_call(
    command: &str,
    stack: Option<&StackId>,
    call: impl FnOnce() -> Result<Report, Failure>,
) -> Result<Report, Failure> {
    let Some(address) = cli_engine() else {
        return call();
    };
    log_check(&format!("before {command}"), &EngineCheck::of(&address));
    let result = call();
    let unexplained = match &result {
        Ok(report) => {
            report.outcome == Outcome::Failed
                && matches!(
                    report.reason,
                    None | Some(Reason::LocalCommandFailed | Reason::Unrecognized)
                )
        }
        // The back end ran and stopped without a report OpenBot can use. One OpenBot stopped, or
        // that never ran, is not about the engine.
        Err(failure) => matches!(
            failure,
            Failure::Timeout
                | Failure::OutputLimit
                | Failure::InvalidJson
                | Failure::UnexpectedExit
        ),
    };
    if !unexplained {
        return result;
    }
    let mut check = EngineCheck::of(&address);
    check.pressure = node_disk_pressure(stack);
    log_check(&format!("after {command} failed"), &check);
    let short = check.shortfall();
    match result {
        Ok(mut report) if short.named() => {
            report.reason = Some(Reason::ResourcesShort);
            report.shortfall = Some(short);
            Ok(report)
        }
        other => other,
    }
}

/// `DiskPressure` on `stack`'s node, or on any back end node on the engine when no stack is named
/// (a setup's failed report names none).
fn node_disk_pressure(stack: Option<&StackId>) -> Option<bool> {
    let engine = recorded_engine();
    let command = || engine_command(engine.as_ref());
    let limits = crate::local_images::Limits {
        call: Duration::from_secs(20),
        ..crate::local_images::Limits::standard()
    };
    match stack {
        Some(stack) => crate::local_images::Node::for_stack(&command, stack.as_str())
            .disk_pressure(limits.call),
        None => crate::local_images::any_disk_pressure(&command, limits),
    }
}

/// The version-1 envelope every `local` command shares: version, command, and a status that
/// agrees with the exit code.
fn parse_envelope(
    command: &str,
    exit_code: i32,
    stdout: &[u8],
) -> Result<(Outcome, Map<String, Value>), Failure> {
    let expected = match exit_code {
        0 => Outcome::Completed,
        1 => Outcome::Failed,
        2 => Outcome::Blocked,
        _ => return Err(Failure::UnexpectedExit),
    };
    if stdout.len() > MAX_OUTPUT {
        return Err(Failure::OutputLimit);
    }
    let text = std::str::from_utf8(stdout).map_err(|_| Failure::InvalidJson)?;
    let wire: Value = serde_json::from_str(text).map_err(|_| Failure::InvalidJson)?;
    let Value::Object(wire) = wire else {
        return Err(Failure::InvalidStatus);
    };
    if wire.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(Failure::UnsupportedVersion);
    }
    if wire.get("command").and_then(Value::as_str) != Some(command) {
        return Err(Failure::UnexpectedCommand);
    }
    let outcome = match wire.get("status").and_then(Value::as_str) {
        Some("completed") => Outcome::Completed,
        Some("blocked") => Outcome::Blocked,
        Some("failed") => Outcome::Failed,
        _ => return Err(Failure::InvalidStatus),
    };
    if outcome != expected {
        return Err(Failure::ContractMismatch);
    }
    Ok((outcome, wire))
}

fn object(value: &Value) -> Result<&Map<String, Value>, Failure> {
    value.as_object().ok_or(Failure::InvalidStatus)
}

/// A release, step, service name or phase: an identifier, never prose. Anything longer or
/// with other characters is refused, so a message or a token cannot ride through in one.
fn text(value: Option<&Value>) -> Result<String, Failure> {
    match value {
        Some(Value::String(text))
            if !text.is_empty()
                && text.len() <= 128
                && text.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'+')
                }) =>
        {
            Ok(text.clone())
        }
        _ => Err(Failure::InvalidStatus),
    }
}

/// More services than any release runs is not an observation.
const MAX_SERVICES: usize = 256;

fn stack(value: &Value) -> Result<Stack, Failure> {
    let saved = object(value)?;
    let id = match saved.get("id") {
        Some(Value::String(id)) => StackId::parse(id)?,
        _ => return Err(Failure::InvalidStack),
    };
    let urls = object(saved.get("urls").unwrap_or(&Value::Null))?;
    let has_failed_step = match saved.get("failedStep") {
        None | Some(Value::Null) => false,
        Some(Value::String(step)) => !step.is_empty(),
        Some(_) => return Err(Failure::InvalidStatus),
    };
    let update_in_progress = match saved.get("update") {
        None | Some(Value::Null) => false,
        Some(update) => {
            object(update)?;
            true
        }
    };
    let unfinished_update = match saved.get("update") {
        Some(Value::Object(update))
            if update.get("attemptedRelease").is_some_and(Value::is_string) =>
        {
            Some(UnfinishedUpdate {
                to: text(update.get("attemptedRelease"))?,
                prepared: update.get("state").and_then(Value::as_str) == Some("prepared"),
                // The steps the CLI's own progress calls downloading the release's images.
                stopped_downloading: matches!(
                    saved.get("failedStep").and_then(Value::as_str),
                    Some("image-download" | "system-image-download" | "system-image-tag")
                ),
                failed_step: text(saved.get("failedStep")).ok(),
            })
        }
        _ => None,
    };
    Ok(Stack {
        id: id.0,
        installed_release: text(saved.get("installedRelease"))?,
        step: text(saved.get("step"))?,
        urls: Urls {
            api: endpoint(urls.get("api"), Endpoint::Api)?,
            dashboard: endpoint(urls.get("dashboard"), Endpoint::Dashboard)?,
            gateway: endpoint(urls.get("gateway"), Endpoint::Gateway)?,
        },
        has_failed_step,
        update_in_progress,
        unfinished_update,
        observed: observation(saved.get("observed"))?,
        app_paths: app_paths(saved.get("appPaths")),
    })
}

/// More app folders than anyone shares one stack with is not a listing.
const MAX_APP_PATHS: usize = 256;

/// `appPaths` as `local list`, `status`, `setup` and `connect` report it: `[{path, missing}]`. Only
/// the paths are kept. Anything else lists no folder, so a stack it describes is never OpenBot's.
fn app_paths(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_APP_PATHS)
        .filter_map(|path| path.get("path").and_then(Value::as_str))
        .filter(|path| !path.is_empty() && path.len() <= 4096)
        .map(str::to_owned)
        .collect()
}

fn observation(value: Option<&Value>) -> Result<Option<Observed>, Failure> {
    let observed = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(observed) => object(observed)?,
    };
    let (Some(Value::Bool(running)), Some(Value::Array(services))) =
        (observed.get("running"), observed.get("services"))
    else {
        return Err(Failure::InvalidStatus);
    };
    if services.len() > MAX_SERVICES {
        return Err(Failure::InvalidStatus);
    }
    let services = services
        .iter()
        .map(|service| {
            let service = object(service)?;
            let Some(Value::Bool(ready)) = service.get("ready") else {
                return Err(Failure::InvalidStatus);
            };
            Ok(Service {
                name: text(service.get("name"))?,
                phase: text(service.get("phase"))?,
                ready: *ready,
            })
        })
        .collect::<Result<_, _>>()?;
    Ok(Some(Observed {
        running: *running,
        services,
    }))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Endpoint {
    Api,
    Dashboard,
    Gateway,
}

/**
A loopback endpoint in exactly the form the CLI writes: `scheme://host:port`, optionally `/`.

Stricter than a URL parser on purpose. No userinfo, path, query or fragment; lowercase only; the
host is `localhost`, a dotted-decimal `127.x.y.z`, `[::1]`, or for the dashboard alone one DNS
label under `.localhost`, which browsers resolve to loopback (RFC 6761). `localhost.evil.test`
and `a.b.localhost` are refused.
*/
fn endpoint(value: Option<&Value>, kind: Endpoint) -> Result<String, Failure> {
    let Some(Value::String(url)) = value else {
        return Err(Failure::UnsafeEndpoint);
    };
    let scheme = if kind == Endpoint::Gateway {
        "ws://"
    } else {
        "http://"
    };
    let rest = url.strip_prefix(scheme).ok_or(Failure::UnsafeEndpoint)?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let (host, port) = rest.rsplit_once(':').ok_or(Failure::UnsafeEndpoint)?;
    let port_valid = !port.is_empty()
        && port.len() <= 5
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && port
            .parse::<u32>()
            .is_ok_and(|port| (1..=65535).contains(&port));
    let host_valid = host == "localhost"
        || host == "[::1]"
        || loopback_ipv4(host)
        || (kind == Endpoint::Dashboard && dashboard_host(host));
    if port_valid && host_valid {
        Ok(url.clone())
    } else {
        Err(Failure::UnsafeEndpoint)
    }
}

fn loopback_ipv4(host: &str) -> bool {
    let octets: Vec<&str> = host.split('.').collect();
    octets.len() == 4
        && octets[0] == "127"
        && octets.iter().all(|octet| {
            !octet.is_empty()
                && octet.len() <= 3
                && octet.bytes().all(|byte| byte.is_ascii_digit())
                && (octet.len() == 1 || !octet.starts_with('0'))
                && octet.parse::<u16>().is_ok_and(|value| value <= 255)
        })
}

/// The CLI's own rule: `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.localhost$`.
fn dashboard_host(host: &str) -> bool {
    let Some(label) = host.strip_suffix(".localhost") else {
        return false;
    };
    let bytes = label.as_bytes();
    let allowed = |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    !bytes.is_empty()
        && bytes.len() <= 63
        && allowed(&bytes[0])
        && allowed(&bytes[bytes.len() - 1])
        && bytes.iter().all(|byte| allowed(byte) || *byte == b'-')
}

/// A file and the digest it has to have.
#[derive(Clone, Debug)]
pub struct Pin {
    pub path: PathBuf,
    pub sha256: String,
}

/**
The CLI, checked against its pins.

`entry` exists because the CLI is published today as an npm package (`copilotkit`, `bin:
index.js`) rather than a single executable. Whether the release ships a native build or a script
run by a pinned runtime is still to be agreed with the CLI owners, so both shapes are verified the
same way and neither is assumed. A script's own imports are not covered by its pin; that is part of
the same agreement.

The files are checked when this is built and run by path afterwards, so they belong in a directory
only this app writes to.
*/
#[derive(Clone, Debug)]
pub struct PinnedCli {
    program: PathBuf,
    entry: Option<PathBuf>,
    sha256: String,
}

impl PinnedCli {
    pub fn verify(program: &Pin, entry: Option<&Pin>) -> Result<Self, Failure> {
        Ok(Self {
            program: verified(program)?,
            entry: entry.map(verified).transpose()?,
            sha256: entry.unwrap_or(program).sha256.clone(),
        })
    }

    /// Which CLI this is, as a local evaluation record keeps it: the script's digest when a
    /// runtime runs one, since the runtime runs many.
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}

/// A regular file, not a link to one, whose bytes hash to the pin. Hashed in chunks: a pinned
/// runtime can be a hundred megabytes.
fn verified(pin: &Pin) -> Result<PathBuf, Failure> {
    let metadata = std::fs::symlink_metadata(&pin.path).map_err(|_| Failure::Unverified)?;
    if !metadata.file_type().is_file() {
        return Err(Failure::Unverified);
    }
    let mut file = std::fs::File::open(&pin.path).map_err(|_| Failure::Unverified)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|_| Failure::Unverified)?;
    let digest: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if digest == pin.sha256 {
        Ok(pin.path.clone())
    } else {
        Err(Failure::Unverified)
    }
}

/// How long a call may take and how much it may say.
///
/// The per-action timeouts are initial bounds, not measurements: `start` waits for a k3d cluster,
/// which has not been timed on a clean machine yet.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub timeout: Duration,
    /// Between asking the process tree to stop and forcing it.
    pub grace: Duration,
    pub output: usize,
}

impl Limits {
    pub fn for_action(action: Action) -> Self {
        let timeout = match action {
            Action::Status => Duration::from_secs(120),
            Action::Start => Duration::from_secs(15 * 60),
            Action::Stop => Duration::from_secs(10 * 60),
            // A new release's images, then its migrations and its start: as long as setup's.
            Action::Update => Duration::from_secs(60 * 60),
        };
        Self {
            timeout,
            grace: Duration::from_secs(5),
            output: MAX_OUTPUT,
        }
    }

    /// `local setup` downloads a release and creates the cluster. 88 seconds on a warm machine
    /// with a fast connection; a first pull of every image is what this allows for. An hour, not
    /// half of one: a fresh Windows VM ran out the 30 minutes this used to allow while it was also
    /// installing OpenBot's packages, and a timeout throws away a setup that was getting there.
    pub fn for_setup() -> Self {
        Self {
            timeout: Duration::from_secs(60 * 60),
            ..Self::for_action(Action::Start)
        }
    }

    /// The Learning agent's model on a running stack: the Learning agent restarts with it, and
    /// nothing else does. As long as a start allows.
    pub fn for_learning_model() -> Self {
        Self::for_action(Action::Start)
    }

    /// The CopilotKit account sign-in waits on a person approving it in their browser.
    pub fn for_account_sign_in() -> Self {
        Self {
            timeout: Duration::from_secs(15 * 60),
            ..Self::for_action(Action::Status)
        }
    }

    /// Composio provisioning: one request to Ops, which gives Composio ten seconds. Start waits on
    /// it when an installation has no key yet, so it is bounded well under `status`.
    pub fn for_apps() -> Self {
        Self {
            timeout: Duration::from_secs(60),
            ..Self::for_action(Action::Status)
        }
    }

    /// `stop` while OpenBot quits. Somebody is waiting for the app to close, so the stop gets two
    /// minutes rather than ten; a stack that has not stopped by then is reported, not waited on.
    pub fn for_quit() -> Self {
        Self {
            timeout: Duration::from_secs(120),
            ..Self::for_action(Action::Stop)
        }
    }
}

/// Asks a running call to stop. Cloning shares the request.
#[derive(Clone, Debug, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    fn requested(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// The CLI this build runs, if it has one.
///
/// None yet: the CLI's release artifact and its digest are not agreed, so there is nothing to pin.
/// Saying so is the honest answer; finding something on `PATH` would run whatever is there.
///
/// A debug build also runs a CLI the developer pinned (`developer_cli`), so the flow can be tried
/// against a real release before one is pinned here. A release build never reads those settings.
/**
The Intelligence release this app's CLI installs, when it was built pinned to one.

Read from the bundled CLI when the app was built (`build.rs`, `cli_release::pinned_release_in`). A
debug build running a developer's CLI names it with `OPENBOT_DEV_LOCAL_EVAL_INTELLIGENCE`. `None`
for a CLI that takes Helm's newest stable release: then which release it would install is not
known here, and no stack is updated.
*/
pub fn bundled_release() -> Option<String> {
    #[cfg(debug_assertions)]
    if let Ok(release) = std::env::var("OPENBOT_DEV_LOCAL_EVAL_INTELLIGENCE") {
        return Some(release).filter(|release| !release.is_empty());
    }
    option_env!("OPENBOT_BUNDLED_CLI_INTELLIGENCE").map(str::to_owned)
}

/**
Whether a local Intelligence must be updated before OpenBot starts on it, and to what.

THE PROBLEM. The app installs Intelligence once, at setup, and only ever starts it after that. So a
person whose stack an older app set up kept that release however many apps came after: a stack on
0.16.0-rc.8 refuses every recording with `TRAJECTORIES_UNAVAILABLE`, which rc.9, the release this
app's CLI installs, does not.

THE RULE. Due when the stack's installed release is older, by semantic version, than `target`, the
release this app's CLI installs (`bundled_release`). Never when it is the same or newer: a stack is
not moved back. Never when either version cannot be read. The CLI's own `local update` does the
work, keeping the stack's data and app connections, and leaves the stack as it was when it fails.

AN UPDATE THAT DID NOT FINISH is due again, to the release it was moving to: `local update` with no
candidate resumes the one on record. The window promises that retry ("OpenBot tries again the next
time it starts") and nothing else makes it. The window opens OpenBot on a running stack without
calling `start`, and on a stopped one the CLI refuses `start` while a `prepared` update is on record
(`update_recovery_required`, naming `local update`). A record that does not name its release is
left alone.
*/
pub fn update_due(report: &Report, target: Option<&str>) -> Option<String> {
    let target = target?;
    let stack = report.stack.as_ref()?;
    if report.outcome != Outcome::Completed {
        return None;
    }
    let version = |text: &str| semver::Version::parse(text.trim().trim_start_matches('v')).ok();
    let to = if stack.update_in_progress {
        &stack.unfinished_update.as_ref()?.to
    } else {
        target
    };
    (version(to)? > version(&stack.installed_release)?).then(|| to.to_owned())
}

pub fn installed() -> Result<PinnedCli, Failure> {
    #[cfg(debug_assertions)]
    if let Some(cli) = developer_cli() {
        return cli;
    }
    if let Some(cli) = bundled_cli() {
        return cli;
    }
    Err(Failure::Unavailable)
}

/**
A CLI this build carries inside the app: a pinned Node runtime and the CLI it runs, in the app's
resources, with the digests `build.rs` recorded when the app was built.

Present only in a build made with `OPENBOT_BUNDLED_CLI=1` (see `build.rs`); every other build has
none and answers as before. The files are checked against those digests on every call, like any
pin, so an app whose resources were changed after it was built runs nothing.
*/
fn bundled_cli() -> Option<Result<PinnedCli, Failure>> {
    let program_sha256 = option_env!("OPENBOT_BUNDLED_CLI_PROGRAM_SHA256")?;
    let entry_sha256 = option_env!("OPENBOT_BUNDLED_CLI_ENTRY_SHA256")?;
    let root = bundled_cli_root()?;
    Some(PinnedCli::verify(
        &Pin {
            path: root
                .join("runtime")
                .join(format!("node{}", std::env::consts::EXE_SUFFIX)),
            sha256: program_sha256.to_owned(),
        },
        Some(&Pin {
            path: root.join("cli").join("index.js"),
            sha256: entry_sha256.to_owned(),
        }),
    ))
}

/// Where the bundled CLI is: `Contents/Resources/cli-bundle` in a Mac app, beside the program
/// elsewhere.
fn bundled_cli_root() -> Option<PathBuf> {
    let program = std::env::current_exe().ok()?;
    let directory = program.parent()?;
    if cfg!(target_os = "macos") {
        Some(directory.parent()?.join("Resources").join("cli-bundle"))
    } else {
        Some(directory.join("cli-bundle"))
    }
}

/// The program a developer pinned: a native CLI, or the runtime that runs `DEVELOPER_ENTRY`.
#[cfg(debug_assertions)]
const DEVELOPER_PROGRAM: &str = "OPENBOT_DEV_LOCAL_EVAL_PROGRAM";
#[cfg(debug_assertions)]
const DEVELOPER_PROGRAM_SHA256: &str = "OPENBOT_DEV_LOCAL_EVAL_PROGRAM_SHA256";
/// The script the program runs, for a CLI published as one, like `copilotkit`'s `index.js`.
#[cfg(debug_assertions)]
const DEVELOPER_ENTRY: &str = "OPENBOT_DEV_LOCAL_EVAL_ENTRY";
#[cfg(debug_assertions)]
const DEVELOPER_ENTRY_SHA256: &str = "OPENBOT_DEV_LOCAL_EVAL_ENTRY_SHA256";

/**
Debug builds only: a CLI named by path *and* digest, checked exactly like a built-in pin.

A path without its digest is refused, not trusted, so the boundary is the same one a release has:
the developer chose the bytes and said so. None when no program is named.
*/
#[cfg(debug_assertions)]
fn developer_cli() -> Option<Result<PinnedCli, Failure>> {
    let pin = |path: std::ffi::OsString, digest: &str| -> Result<Pin, Failure> {
        Ok(Pin {
            path: PathBuf::from(path),
            sha256: std::env::var(digest).map_err(|_| Failure::Unverified)?,
        })
    };
    let program = std::env::var_os(DEVELOPER_PROGRAM)?;
    Some((|| {
        let program = pin(program, DEVELOPER_PROGRAM_SHA256)?;
        let entry = std::env::var_os(DEVELOPER_ENTRY)
            .map(|entry| pin(entry, DEVELOPER_ENTRY_SHA256))
            .transpose()?;
        PinnedCli::verify(&program, entry.as_ref())
    })())
}

/// What the CLI inherits. Everything else, `NODE_OPTIONS` and `NODE_PATH` included, is dropped:
/// either could load code the pin never saw. The CLI needs a home for its configuration, `PATH`
/// for Docker and k3d, a temporary directory, the proxy settings of a managed network, and the
/// person's telemetry choice.
const INHERITED: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    // The CLI's telemetry opt-outs (`services/consent/gate.ts`). Dropping them would turn
    // telemetry back on for somebody who turned it off.
    "DO_NOT_TRACK",
    "COPILOTKIT_TELEMETRY_DISABLED",
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATHEXT",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "TEMP",
    "TMP",
];

/*
 * ONE ENGINE FOR OPENBOT AND INTELLIGENCE.
 *
 * Left to itself the CLI picks Docker when Docker answers and Podman otherwise. That is not always
 * the engine OpenBot is running on: Docker Desktop started after OpenBot settled on Podman, or a
 * Podman machine of the person's own that is running beside ours. Two engines on one computer is
 * two VMs' worth of memory, and an Intelligence that OpenBot's containers reach through a host
 * port of a different VM. So every CLI process is told the engine OpenBot uses, by the variable
 * the CLI reads for exactly this (`COPILOTKIT_LOCAL_ENGINE`), and for Podman the API of the
 * machine OpenBot uses: the CLI would otherwise take the first running machine, and it looks
 * `podman` up on a PATH that, in the session OpenBot installed Podman, does not have it.
 *
 * Recorded by the app when it knows its engine (`use_engine`), and read for every call, because
 * the machine's mode can change between calls and asking costs one `podman machine inspect`.
 */
static ENGINE: std::sync::Mutex<Option<crate::engine::Address>> = std::sync::Mutex::new(None);

/// Run the CLI on the engine OpenBot runs on.
pub fn use_engine(address: &crate::engine::Address) {
    *ENGINE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(address.clone());
}

/// Whether the app has said which engine OpenBot runs on.
pub fn engine_known() -> bool {
    ENGINE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_some()
}

/// What the CLI is told about its engine. Addresses and a name; nothing here is a secret.
#[derive(Clone, Debug, PartialEq, Eq)]
struct CliEngine {
    engine: crate::engine::Engine,
    /// The Podman API OpenBot's machine forwards to this computer, when it could be found.
    api: Option<String>,
    /// The machine's rootful connection, for the `podman` the CLI runs, when `api` is a named pipe
    /// that `podman` cannot open itself (Windows).
    connection: Option<String>,
    /// A Podman machine running rootless, which local Intelligence does not run on.
    rootless: bool,
}

impl CliEngine {
    fn of(address: &crate::engine::Address) -> Self {
        Self::of_with(address, crate::acquire::machine_behind)
    }

    /// The machine's mode and API, not the connection's.
    ///
    /// A rootful machine whose OpenBot is still in its rootless storage keeps OpenBot on the
    /// machine's bare connection (see `acquire::connection_keeping_openbot`). Intelligence then
    /// runs on that same machine's rootful engine, the one its forwarded API reaches: one VM, so
    /// none of the cost of two engines above, and the only engine there Intelligence runs on.
    /// Only a rootless machine has no rootful engine to offer, and is declined.
    fn of_with(
        address: &crate::engine::Address,
        machine_behind: impl FnOnce(&str) -> Result<crate::acquire::MachineFacts, String>,
    ) -> Self {
        use crate::engine::Engine;
        let named_only = || Self {
            engine: address.engine,
            api: None,
            connection: None,
            rootless: false,
        };
        // Linux runs OpenBot's containers without local Intelligence for now, and its Podman has
        // no machine: the CLI finds the rootful socket itself, or declines a rootless one.
        if address.engine == Engine::Docker || cfg!(target_os = "linux") {
            return named_only();
        }
        let connection = address
            .connection
            .clone()
            .or_else(|| address.pin().ok().and_then(|pinned| pinned.connection));
        let Some(connection) = connection else {
            return named_only();
        };
        match machine_behind(&connection) {
            Ok(facts) => Self {
                engine: Engine::Podman,
                // Podman names a machine's rootful connection `<machine>-root`, the engine its
                // forwarded API reaches.
                connection: facts
                    .api
                    .as_deref()
                    .is_some_and(|api| api.starts_with("npipe:"))
                    .then(|| format!("{}-root", crate::acquire::machine_of(&connection))),
                api: facts.api,
                rootless: facts.rootful == Some(false),
            },
            // Not a machine this computer can inspect: the CLI finds its own way, and judges it.
            _ => named_only(),
        }
    }
}

fn recorded_engine() -> Option<CliEngine> {
    let address = ENGINE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()?;
    Some(CliEngine::of(&address))
}

/// The variables that name the engine, and those the CLI must not inherit beside them.
///
/// For Podman, `CONTAINER_HOST` is what the CLI and the Podman CLI read and `DOCKER_HOST` is what
/// k3d reads, so both name the machine's API. On Windows that API is a named pipe, which the Podman
/// CLI refuses (`"npipe" is not a supported schema`), so it is also given the machine's connection
/// by name in `CONTAINER_CONNECTION`, which it prefers to `CONTAINER_HOST`. An inherited `DOCKER_HOST` or `DOCKER_CONTEXT` names
/// a Docker, and is dropped rather than handed to k3d beside a Podman. For Docker nothing else is
/// set: the CLI finds Docker as Docker's own CLI does, through what it inherits.
fn engine_environment(engine: Option<&CliEngine>) -> Vec<(&'static str, Option<String>)> {
    use crate::engine::Engine;
    let Some(engine) = engine else {
        return Vec::new();
    };
    let mut environment = vec![(
        "COPILOTKIT_LOCAL_ENGINE",
        Some(engine.engine.binary().to_string()),
    )];
    if engine.engine == Engine::Podman {
        environment.push(("CONTAINER_HOST", engine.api.clone()));
        environment.push(("CONTAINER_CONNECTION", engine.connection.clone()));
        environment.push(("DOCKER_HOST", engine.api.clone()));
        environment.push(("DOCKER_CONTEXT", None));
    }
    environment
}

/// Decline the calls that create or start Intelligence's cluster on a rootless Podman machine.
/// Everything else runs: `status`, `stop` and the account calls work on any engine.
fn refuse_rootless(arguments: &[&str], engine: Option<&CliEngine>) -> Result<(), Failure> {
    let runs_workloads = matches!(
        arguments,
        ["local", "setup", ..] | ["local", "start", ..] | ["local", "update", ..]
    );
    if runs_workloads && engine.is_some_and(|engine| engine.rootless) {
        return Err(Failure::RootlessPodman);
    }
    Ok(())
}

/// The CLI process for one call: its program, its environment and its folder, not yet started.
fn command_for(
    cli: &PinnedCli,
    arguments: &[&str],
    folder: Option<&std::path::Path>,
    engine: Option<&CliEngine>,
) -> std::process::Command {
    let mut command = command_inheriting(
        cli,
        arguments,
        folder,
        engine,
        |name| std::env::var_os(name),
        crate::docker_config::owned(),
    );
    // The registry mirror, for the node `local setup` creates: the CLI hands its environment to
    // `k3d cluster create`, which writes the file into the node before it first starts. See
    // `local_images::Mirror`.
    if let Some(file) = crate::local_images::registries_file() {
        command.env("K3D_REGISTRIES_CONFIG", file);
    }
    command
}

/// `command_for`, with this process's environment read through `var` and OpenBot's Docker
/// configuration kept in `docker_config`.
fn command_inheriting(
    cli: &PinnedCli,
    arguments: &[&str],
    folder: Option<&std::path::Path>,
    engine: Option<&CliEngine>,
    var: impl Fn(&str) -> Option<std::ffi::OsString>,
    docker_config: Option<&std::path::Path>,
) -> std::process::Command {
    let mut command = crate::quiet::command(&cli.program);
    if let Some(entry) = &cli.entry {
        command.arg(entry);
    }
    cli_environment(&mut command, engine, var, docker_config);
    if let Some(folder) = folder {
        command.current_dir(folder);
    }
    command.args(arguments);
    if let (Some(folder), ["local", ..]) = (folder, arguments) {
        // Absolute, as `current_dir` reads it: the CLI resolves a relative one inside the folder.
        let folder = std::path::absolute(folder).unwrap_or_else(|_| folder.to_path_buf());
        command.arg(APP_PATH).arg(folder);
    }
    command
}

/**
`--app-path <folder>`, added to every `local` call that runs in OpenBot's folder (`local setup` and
`local connect`): the CLI acts for exactly that folder.

Without it the CLI finds a folder's stack through `.copilotkit/local.json` in the folder or in any
folder above it. Someone who once ran `copilotkit local setup` in their home folder had that stack
resumed for `~/OpenBot`, and `local connect` wrote the home folder's `.env`, so Start found
`~/OpenBot/.env` naming no stack it set up. With it, setup creates or resumes the stack the CLI
records for OpenBot's folder, and connect writes OpenBot's `.env` (Intelligence
`apps/cli/src/commands/local.ts`, in the CLI pinned since `desktop/intelligence-cli.json` named
f5c45eb).
*/
pub const APP_PATH: &str = "--app-path";

/// The container engine the CLI runs on, with the environment the CLI itself gets: for
/// `local_images`, which pulls into the same k3d node the CLI pulls into.
fn engine_command(engine: Option<&CliEngine>) -> std::process::Command {
    let binary = engine.map_or(crate::engine::Engine::Docker, |engine| engine.engine);
    let mut command = crate::quiet::command(binary.binary());
    cli_environment(
        &mut command,
        engine,
        |name| std::env::var_os(name),
        crate::docker_config::owned(),
    );
    command
}

/// `engine_command` on the engine the app last named, for `update_ready`, which downloads into
/// the back end's node as `local update` does.
pub fn node_engine() -> impl Fn() -> std::process::Command + Send + Sync + 'static {
    let engine = recorded_engine();
    move || engine_command(engine.as_ref())
}

/// Only `INHERITED`, OpenBot's Docker configuration, the engines' directories on `PATH` and the
/// variables that name the engine.
fn cli_environment(
    command: &mut std::process::Command,
    engine: Option<&CliEngine>,
    var: impl Fn(&str) -> Option<std::ffi::OsString>,
    docker_config: Option<&std::path::Path>,
) {
    command.env_clear();
    for name in INHERITED {
        if let Some(value) = var(name) {
            command.env(name, value);
        }
    }
    // Share usage data turned off in Settings is the same opt-out as the variable.
    if crate::usage_data::off() {
        command.env("COPILOTKIT_TELEMETRY_DISABLED", "1");
    }
    // Docker's configuration without the person's credential helper, which macOS stops to ask
    // about when OpenBot runs it, so the chart and image downloads never wait on a dialog. See
    // `docker_config`. The person's own configuration is what it mirrors.
    if let Some(dir) =
        docker_config.and_then(|owned| crate::docker_config::for_commands_in(owned, &var))
    {
        command.env("DOCKER_CONFIG", dir);
    }
    // The CLI looks `docker` and `podman` up by name. Opened from Finder, this app has the system's
    // minimal PATH, which reaches neither Docker Desktop's `/usr/local/bin` nor `/opt/podman/bin`;
    // the CLI gets the engine's own directory added.
    let engines: &[crate::engine::Engine] = match engine.map(|engine| engine.engine) {
        Some(crate::engine::Engine::Podman) => {
            &[crate::engine::Engine::Docker, crate::engine::Engine::Podman]
        }
        _ => &[crate::engine::Engine::Docker],
    };
    if let Some(path) = crate::engine::path_with_engines(engines) {
        command.env("PATH", path);
    }
    for (name, value) in engine_environment(engine) {
        match value {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
}

/**
Run one CLI call to completion, within its limits.

stdout goes to a private file, not a pipe. The call is finished when the CLI exits; anything it
left running with that file open cannot hold the call, and a normally exiting CLI keeps whatever it
deliberately detached. A deadline, a cancellation or too much output stops the whole process tree,
not only the CLI: it starts Docker and k3d, and leaving those running after a timeout is how a
retry collides with its own leftovers.
*/
pub fn run(
    cli: &PinnedCli,
    action: Action,
    stack: &StackId,
    limits: Limits,
    cancel: &Cancel,
) -> Result<Report, Failure> {
    let (code, bytes) = execute(cli, &arguments(action, stack), None, limits, cancel)?;
    normalize(action, code, &bytes)
}

/// `local setup` in `installation`, the folder the stack is created for.
pub fn setup(
    cli: &PinnedCli,
    installation: &std::path::Path,
    accepted: Option<&EulaVersion>,
    limits: Limits,
    cancel: &Cancel,
) -> Result<Report, Failure> {
    let (code, bytes) = execute(
        cli,
        &setup_arguments(accepted),
        Some(installation),
        limits,
        cancel,
    )?;
    normalize_setup(code, &bytes)
}

/// `local setup` in `installation` with the Learning agent's model (`learning_model_arguments`).
pub fn configure_learning_model(
    cli: &PinnedCli,
    installation: &std::path::Path,
    file: Option<&std::path::Path>,
    limits: Limits,
    cancel: &Cancel,
) -> Result<Report, Failure> {
    let file = match file {
        None => None,
        Some(file) => Some(model_file(file)?),
    };
    let (code, bytes) = execute(
        cli,
        &learning_model_arguments(file),
        Some(installation),
        limits,
        cancel,
    )?;
    normalize_setup(code, &bytes)
}

/// The model file as an argument: absolute, and nothing that reads as a flag.
pub fn model_file(file: &std::path::Path) -> Result<&str, Failure> {
    file.is_absolute()
        .then(|| file.to_str())
        .flatten()
        .filter(|file| !file.starts_with('-'))
        .ok_or(Failure::Spawn)
}

/// `login --json`: the CopilotKit account sign-in. `shown` hears each new approval page the CLI
/// prints while it waits, so the window can show it (`sign_in_page`).
pub fn account_sign_in(
    cli: &PinnedCli,
    limits: Limits,
    cancel: &Cancel,
    shown: &mut dyn FnMut(SignInPage),
) -> Result<AccountSignIn, Failure> {
    let arguments = account_sign_in_arguments(login_takes_mode(cli, cancel)?);
    let mut last: Option<SignInPage> = None;
    let mut watch = |so_far: &[u8]| {
        if let Some(page) = sign_in_page(so_far).filter(|page| last.as_ref() != Some(page)) {
            last = Some(page.clone());
            shown(page);
        }
    };
    let (code, bytes) = execute_watching(
        cli,
        &arguments,
        None,
        limits,
        cancel,
        Some(&mut watch),
        None,
    )?;
    normalize_account_sign_in(code, &bytes)
}

/**
Whether this CLI takes `OPENBOT_SIGN_IN_MODE`, asked of its own `login --help` once per CLI.

The CLI is pinned by digest, so the answer holds for as long as those bytes run from that path. A help call that
fails or times out reads as no: the sign-in then runs as it always did, with the generic page. A
cancelled one is the sign-in cancelled.
*/
fn login_takes_mode(cli: &PinnedCli, cancel: &Cancel) -> Result<bool, Failure> {
    type Seen = (PathBuf, String, bool);
    static KNOWN: std::sync::Mutex<Vec<Seen>> = std::sync::Mutex::new(Vec::new());
    let seen = |found: &Seen| found.0 == cli.program && found.1 == cli.sha256;
    if let Some((_, _, takes)) = KNOWN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .find(|found| seen(found))
    {
        return Ok(*takes);
    }
    let limits = Limits {
        timeout: Duration::from_secs(30),
        grace: Duration::from_secs(2),
        output: 64 * 1024,
    };
    let takes = match execute(cli, &LOGIN_HELP_ARGUMENTS, None, limits, cancel) {
        Ok((code, bytes)) => help_lists_openbot_mode(code, &bytes),
        Err(Failure::Cancelled) => return Err(Failure::Cancelled),
        Err(_) => return Ok(false),
    };
    KNOWN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push((cli.program.clone(), cli.sha256.clone(), takes));
    Ok(takes)
}

/// `onboard local-terms --json`, within the limits of `status`.
pub fn terms(cli: &PinnedCli, limits: Limits, cancel: &Cancel) -> Result<Terms, Failure> {
    let (code, bytes) = execute(cli, &TERMS_ARGUMENTS, None, limits, cancel)?;
    normalize_terms(code, &bytes)
}

/// `local connect` in `installation`, the folder `local setup` created the stack for.
pub fn connect(
    cli: &PinnedCli,
    installation: &std::path::Path,
    limits: Limits,
    cancel: &Cancel,
) -> Result<Connection, Failure> {
    let (code, bytes) = execute(cli, &CONNECT_ARGUMENTS, Some(installation), limits, cancel)?;
    normalize_connect(code, &bytes)
}

/// `local login` for `stack`.
pub fn login(
    cli: &PinnedCli,
    stack: &StackId,
    limits: Limits,
    cancel: &Cancel,
) -> Result<SignIn, Failure> {
    let (code, bytes) = execute(cli, &login_arguments(stack), None, limits, cancel)?;
    normalize_login(stack, code, &bytes)
}

/// `local list`, within the same limits as `status`.
pub fn list(cli: &PinnedCli, limits: Limits, cancel: &Cancel) -> Result<Listing, Failure> {
    let (code, bytes) = execute(cli, &LIST_ARGUMENTS, None, limits, cancel)?;
    normalize_list(code, &bytes)
}

/// `integrations composio provision` for `installation`, writing the key into `env_file`.
pub fn provision_apps(
    cli: &PinnedCli,
    installation: &Installation,
    env_file: &std::path::Path,
    limits: Limits,
    cancel: &Cancel,
) -> Result<AppsProvisioned, Failure> {
    // The CLI takes an absolute path in a folder that exists; OpenBot makes both.
    let env_file = env_file
        .is_absolute()
        .then(|| env_file.to_str())
        .flatten()
        .ok_or(Failure::Spawn)?;
    let (code, bytes) = execute(
        cli,
        &apps_arguments(installation, env_file),
        None,
        limits,
        cancel,
    )?;
    normalize_apps(installation, code, &bytes)
}

/// The exit code and stdout of one bounded CLI process. Arguments come only from `arguments`,
/// `login_arguments`, `LIST_ARGUMENTS`, `setup_arguments`, `learning_model_arguments`,
/// `CONNECT_ARGUMENTS`,
/// `ACCOUNT_SIGN_IN_ARGUMENTS`, `TERMS_ARGUMENTS` and `apps_arguments`; only setup and connect
/// run somewhere other than inherited.
fn execute(
    cli: &PinnedCli,
    arguments: &[&str],
    folder: Option<&std::path::Path>,
    limits: Limits,
    cancel: &Cancel,
) -> Result<(i32, Vec<u8>), Failure> {
    execute_watching(cli, arguments, folder, limits, cancel, None, None)
}

/// Hears the stdout a running CLI has written so far. See `execute_watching`.
type Watch<'a> = &'a mut dyn FnMut(&[u8]);

/// `execute`, with `watch` given the stdout written so far each time it grows while the CLI runs.
/// What `watch` reads stays inside this module: only what it chooses to keep leaves.
///
/// How a call that sets up, starts, updates or stops the stack ended goes to the log
/// (`ending_entry`), so a setup that stops is never a blank in it.
///
/// `update` follows a `local update` through the CLI's log (`UpdateWatch`).
fn execute_watching(
    cli: &PinnedCli,
    arguments: &[&str],
    folder: Option<&std::path::Path>,
    limits: Limits,
    cancel: &Cancel,
    watch: Option<Watch>,
    update: Option<&mut UpdateWatch>,
) -> Result<(i32, Vec<u8>), Failure> {
    let started = Instant::now();
    let logged = logs_its_ending(arguments);
    // Kept only for a call whose ending is logged, and only its tail is read.
    let errors = logged.then(|| Output::create().ok()).flatten();
    let mut status = None;
    let result = execute_child(
        cli,
        arguments,
        folder,
        limits,
        cancel,
        watch,
        update,
        errors.as_ref(),
        &mut status,
    );
    if logged {
        let stderr = errors
            .as_ref()
            .and_then(|errors| errors.tail(ERROR_TAIL))
            .unwrap_or_default();
        let (level, entry) = ending_entry(arguments, started.elapsed(), status, &result, &stderr);
        log::log!(level, "{entry}");
        #[cfg(test)]
        LAST_ENDING.with(|last| *last.borrow_mut() = Some(entry));
    }
    result
}

/// How much of the end of a failed call's stderr goes to the log.
const ERROR_TAIL: usize = 2048;

#[cfg(test)]
thread_local! {
    /// The last ending this thread logged, for the tests.
    static LAST_ENDING: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// The calls whose ending is logged: the ones that change the stack. `status`, `list` and the
/// account, connection and apps calls are not, since their stdout can carry a sign-in code or a key
/// and a polled `status` would fill the log.
fn logs_its_ending(arguments: &[&str]) -> bool {
    matches!(
        arguments,
        [
            "local",
            "setup" | "start" | "update" | "stop" | "delete",
            ..
        ]
    )
}

/**
The log entry for how a call ended: `[local setup] finished in 88.1s`, or that it failed, after how
long, with its exit code, what its JSON report says went wrong (`error.code`, `error.message`,
`nextAction.reason`) and the end of its stderr. The log scrubs every entry (`logging::line`).
*/
fn ending_entry(
    arguments: &[&str],
    took: Duration,
    status: Option<std::process::ExitStatus>,
    result: &Result<(i32, Vec<u8>), Failure>,
    stderr: &str,
) -> (log::Level, String) {
    let command = arguments
        .iter()
        .take_while(|argument| !argument.starts_with('-'))
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    let took = took.as_secs_f32();
    let mut entry = match result {
        Ok((0, _)) => {
            return (
                log::Level::Info,
                format!("[{command}] finished in {took:.1}s"),
            )
        }
        Ok((code, _)) => format!("[{command}] failed after {took:.1}s: exit {code}"),
        Err(failure) => {
            let ended = match (status, failure) {
                (Some(status), _) => format!(", {}", exit_described(status)),
                (None, Failure::Timeout | Failure::Cancelled | Failure::OutputLimit) => {
                    ", stopped by OpenBot".to_owned()
                }
                (None, _) => String::new(),
            };
            format!("[{command}] failed after {took:.1}s: {failure:?}{ended}")
        }
    };
    if let Ok((_, stdout)) = result {
        if let Ok(Value::Object(wire)) = serde_json::from_slice::<Value>(stdout) {
            let said = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
            let error = wire.get("error");
            let next = wire.get("nextAction");
            for (name, value) in [
                ("status", said(wire.get("status"))),
                ("error", said(error.and_then(|error| error.get("code")))),
                ("reason", said(next.and_then(|next| next.get("reason")))),
                (
                    "message",
                    said(error.and_then(|error| error.get("message"))),
                ),
            ] {
                if let Some(value) = value {
                    entry.push_str(&format!(", {name} {value:?}"));
                }
            }
        } else {
            entry.push_str(", no JSON report");
        }
    }
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        entry.push_str(&format!("\nstderr ends: {stderr}"));
    }
    (log::Level::Error, entry)
}

/// `exit 1`, or the signal or Windows status that ended a process with no exit code of its own.
fn exit_described(status: std::process::ExitStatus) -> String {
    if let Some(code) = status.code() {
        return format!("exit {code}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return format!("ended by signal {signal}");
        }
    }
    "no exit code".to_owned()
}

/// `execute_watching`'s process: the CLI's stderr goes to `errors`, when there is one, and how it
/// exited to `status`.
///
/// A cancel stops the process tree, except an update's once it has begun changing the release with
/// Helm (`UpdateWatch::committed`): stopping it there is what leaves a stack no later update can
/// get past (`local_update`), so it is let finish, within its deadline.
#[allow(clippy::too_many_arguments)]
fn execute_child(
    cli: &PinnedCli,
    arguments: &[&str],
    folder: Option<&std::path::Path>,
    limits: Limits,
    cancel: &Cancel,
    mut watch: Option<Watch>,
    mut update: Option<&mut UpdateWatch>,
    errors: Option<&Output>,
    status: &mut Option<std::process::ExitStatus>,
) -> Result<(i32, Vec<u8>), Failure> {
    let engine = recorded_engine();
    refuse_rootless(arguments, engine.as_ref())?;
    let output = Output::create()?;
    let mut command = command_for(cli, arguments, folder, engine.as_ref());
    // stderr can carry anything a dependency prints. It is read only for the log, and only for a
    // call that changes the stack (`logs_its_ending`).
    let stderr = match errors.and_then(|errors| errors.file.try_clone().ok()) {
        Some(file) => Stdio::from(file),
        None => Stdio::null(),
    };
    command
        .stdin(Stdio::null())
        .stdout(output.file.try_clone().map_err(|_| Failure::Spawn)?)
        .stderr(stderr);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|_| Failure::Spawn)?;
    // Until this call has reaped the tree, by its own end or by `stop_tree`.
    let _running = Running::start();
    // Only the child holds the file for writing now.
    drop(command);

    let deadline = Instant::now() + limits.timeout;
    let mut watched = 0;
    let mut letting_finish = false;
    loop {
        if let Some(update) = update.as_deref_mut() {
            update.poll_now_and_then();
        }
        if exited(&mut child)? {
            let exit = child.wait().map_err(|_| Failure::Spawn)?;
            *status = Some(exit);
            let code = exit.code();
            let bytes = output.read(limits.output)?;
            // A signal-terminated CLI has no code and no report.
            return Ok((code.ok_or(Failure::UnexpectedExit)?, bytes));
        }
        let written = output.len();
        if written > limits.output as u64 {
            return Err(stop_tree(&mut child, limits.grace, Failure::OutputLimit));
        }
        if let Some(watch) = watch.as_mut().filter(|_| written > watched) {
            if let Some(so_far) = output.peek(limits.output) {
                watched = so_far.len() as u64;
                watch(&so_far);
            }
        }
        if cancel.requested() {
            let committed = update.as_deref_mut().is_some_and(|update| {
                update.poll();
                update.committed()
            });
            if !committed {
                return Err(stop_tree(&mut child, limits.grace, Failure::Cancelled));
            }
            if !letting_finish {
                letting_finish = true;
                log::warn!(
                    "[local update] asked to stop after it began changing the backend with Helm: \
                     letting it finish, since stopping it there leaves the backend half updated"
                );
            }
        }
        if Instant::now() >= deadline {
            return Err(stop_tree(&mut child, limits.grace, Failure::Timeout));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/**
A running `local update`, followed through the CLI's log (`local_update::StepLog`).

While it runs, `update_step` answers for its attempt with the step it is in, and each step it ends
is logged. Once it has begun changing the release with Helm (`committed`), it counts as finishing
(`Finishing`): Cancel and Quit let it end on its own rather than stop it there.
*/
struct UpdateWatch {
    attempt: String,
    stack: StackId,
    engine: Option<CliEngine>,
    log: crate::local_update::StepLog,
    finishing: Option<Finishing>,
    read: Option<Instant>,
    /// The Jobs in the cluster when the update began changing the release: an earlier attempt's.
    jobs_before: Option<Vec<String>>,
    /// What the update's own Jobs were doing when last asked, while it is in them.
    jobs: Option<crate::local_update::Jobs>,
    jobs_read: Option<Instant>,
    node_read: Option<Instant>,
}

impl UpdateWatch {
    /// None when there is no home to find the CLI's log in: the update then runs as before.
    fn new(attempt: &str, stack: &StackId) -> Option<Self> {
        let path = crate::local_update::cli_log()?;
        Some(Self {
            attempt: attempt.to_owned(),
            stack: stack.clone(),
            engine: recorded_engine(),
            log: crate::local_update::StepLog::at_end_of(path),
            finishing: None,
            read: None,
            jobs_before: None,
            jobs: None,
            jobs_read: None,
            node_read: None,
        })
    }

    /// From the first Helm step on, every few seconds: a cordoned node, uncordoned
    /// (`local_update::uncordon_if_cordoned`). The CLI starts a stopped node itself, inside the
    /// update, and the databases it then waits on cannot be scheduled on a cordoned one.
    fn watch_node(&mut self) {
        let due = self
            .node_read
            .is_none_or(|read| read.elapsed() >= Duration::from_secs(5));
        if !self.log.committed() || !due {
            return;
        }
        self.node_read = Some(Instant::now());
        if let Err(why) = crate::local_update::uncordon_if_cordoned(
            || engine_command(self.engine.as_ref()),
            self.stack.as_str(),
        ) {
            log::info!("[local update] node not checked: {why}");
        }
    }

    /// The cluster's Jobs, as `kubectl get jobs -o json` in the stack's node answers.
    fn cluster_jobs(&self) -> Option<String> {
        crate::local_update::cluster_jobs(engine_command(self.engine.as_ref()), self.stack.as_str())
    }

    /**
    While the update waits on the chart's Jobs, what they are doing, every few seconds: which one
    it waits on, and a failed one as soon as it fails. The CLI waits a failed Job's full ten
    minutes (`kubectl wait --for=condition=complete`) and says nothing until then.
    */
    fn watch_jobs(&mut self) {
        if self.log.committed() && self.jobs_before.is_none() {
            self.jobs_before = self
                .cluster_jobs()
                .and_then(|answer| crate::local_update::job_names(&answer));
        }
        let due = self
            .jobs_read
            .is_none_or(|read| read.elapsed() >= Duration::from_secs(3));
        if !self.log.in_jobs() || !due {
            return;
        }
        let Some(before) = self.jobs_before.as_ref() else {
            return;
        };
        self.jobs_read = Some(Instant::now());
        let Some(jobs) = self
            .cluster_jobs()
            .and_then(|answer| crate::local_update::jobs(&answer, before))
        else {
            return;
        };
        if jobs.failed.is_some()
            && jobs.failed != self.jobs.as_ref().and_then(|seen| seen.failed.clone())
        {
            log::error!(
                "[local update] Job {} failed; the CLI waits up to ten minutes for it before the update stops",
                jobs.failed.as_deref().unwrap_or_default()
            );
        }
        if jobs.running.is_some()
            && jobs.running != self.jobs.as_ref().and_then(|seen| seen.running.clone())
        {
            log::info!(
                "[local update] waiting on Job {}",
                jobs.running.as_deref().unwrap_or_default()
            );
        }
        self.log.saw_jobs(&jobs);
        self.jobs = Some(jobs);
    }

    /// `poll`, at most four times a second.
    fn poll_now_and_then(&mut self) {
        if self
            .read
            .is_none_or(|read| read.elapsed() >= Duration::from_millis(250))
        {
            self.poll();
        }
    }

    fn poll(&mut self) {
        self.read = Some(Instant::now());
        for step in self.log.poll() {
            log::info!("[local update] {step} finished");
        }
        if self.log.committed() && self.finishing.is_none() {
            log::info!(
                "[local update] it is changing the backend with Helm now; Cancel and Quit let it finish"
            );
            self.finishing = Some(Finishing::begin());
        }
        self.watch_node();
        self.watch_jobs();
        let jobs = self.jobs.as_ref().filter(|_| self.log.in_jobs());
        let mut steps = update_steps();
        steps.retain(|(attempt, _)| attempt != &self.attempt);
        if let Some(now) = self.log.now(jobs) {
            steps.push((self.attempt.clone(), now));
        }
    }

    fn committed(&self) -> bool {
        self.log.committed()
    }
}

impl Drop for UpdateWatch {
    fn drop(&mut self) {
        update_steps().retain(|(attempt, _)| attempt != &self.attempt);
    }
}

type ShownStep = (String, crate::local_update::UpdateStep);

/// The step each running update is in, by attempt id. See `update_step`.
static UPDATE_STEPS: std::sync::Mutex<Vec<ShownStep>> = std::sync::Mutex::new(Vec::new());

fn update_steps() -> std::sync::MutexGuard<'static, Vec<ShownStep>> {
    UPDATE_STEPS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The step the update `attempt` is in, once it is in one that waits: so a step that takes minutes
/// shows which one it is, and for how long, rather than nothing.
pub fn update_step(attempt: &str) -> Option<crate::local_update::UpdateStep> {
    update_steps()
        .iter()
        .find(|(id, _)| id == attempt)
        .map(|(_, step)| step.clone())
}

/// Updates, and repairs of one, that must not be stopped partway. See `close_for_quit_reporting`.
static FINISHING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Counts one update or repair as finishing for as long as it is held.
struct Finishing;

impl Finishing {
    fn begin() -> Self {
        FINISHING.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for Finishing {
    fn drop(&mut self) {
        FINISHING.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Whether an update past the point it can safely stop, or a repair of one, is running now.
pub fn update_finishing() -> bool {
    FINISHING.load(Ordering::SeqCst) > 0
}

/// The owner-only file the CLI writes its report to, removed when the call ends.
struct Output {
    path: PathBuf,
    file: std::fs::File,
}

impl Output {
    fn create() -> Result<Self, Failure> {
        let path = std::env::temp_dir().join(format!(
            "openbot-local-eval-{}-{:016x}.json",
            std::process::id(),
            rand::random::<u64>()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path).map_err(|_| Failure::Spawn)?;
        Ok(Self { path, file })
    }

    fn len(&self) -> u64 {
        self.file
            .metadata()
            .map(|metadata| metadata.len())
            .unwrap_or(0)
    }

    /// What the CLI has written so far, while it is still writing. Read through a handle of its
    /// own: seeking the shared one would move where the CLI writes next.
    fn peek(&self, cap: usize) -> Option<Vec<u8>> {
        let mut bytes = Vec::new();
        std::fs::File::open(&self.path)
            .ok()?
            .take(cap as u64)
            .read_to_end(&mut bytes)
            .ok()?;
        Some(bytes)
    }

    /// The last `cap` bytes the process wrote, as text.
    fn tail(&self, cap: usize) -> Option<String> {
        let mut file = std::fs::File::open(&self.path).ok()?;
        let length = file.metadata().ok()?.len();
        file.seek(std::io::SeekFrom::Start(length.saturating_sub(cap as u64)))
            .ok()?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).ok()?;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }

    fn read(&self, cap: usize) -> Result<Vec<u8>, Failure> {
        // The CLI wrote through a clone of this handle, which shares its offset.
        (&self.file)
            .seek(std::io::SeekFrom::Start(0))
            .map_err(|_| Failure::InvalidJson)?;
        let mut bytes = Vec::new();
        (&self.file)
            .take(cap as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Failure::InvalidJson)?;
        if bytes.len() > cap {
            return Err(Failure::OutputLimit);
        }
        Ok(bytes)
    }
}

impl Drop for Output {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/**
Whether the CLI has exited, without reaping it.

The CLI's process id is also its process group id. While it is unreaped, neither can be given to
another process, so `stop_tree` can only ever signal the group this call created.
*/
#[cfg(unix)]
fn exited(child: &mut Child) -> Result<bool, Failure> {
    // SAFETY: an all-zero siginfo_t is a valid out-parameter for waitid.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    // SAFETY: waits on this call's own child; WNOWAIT leaves it unreaped.
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id() as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result != 0 {
        return Err(Failure::Spawn);
    }
    // SAFETY: waitid filled `info`; with WNOHANG and no state change the pid stays zero.
    Ok(unsafe { info.si_pid() } != 0)
}

#[cfg(not(unix))]
fn exited(child: &mut Child) -> Result<bool, Failure> {
    child
        .try_wait()
        .map(|status| status.is_some())
        .map_err(|_| Failure::Spawn)
}

/**
Stop the CLI and everything it started, then reap it. Returns `failure` for the caller.

Unix: the CLI leads its own process group, which is asked to stop, given `grace`, then killed. The
CLI is reaped only after the last signal, so the group id cannot have been reused. Windows:
`taskkill /T /F` on the CLI's tree, which reaches what the CLI still parents; a Job Object would
also reach orphans, and is not used yet.
*/
fn stop_tree(child: &mut Child, grace: Duration, failure: Failure) -> Failure {
    #[cfg(unix)]
    {
        let group = child.id() as libc::pid_t;
        // SAFETY: signalling the unreaped group this call created; no memory is shared.
        unsafe { libc::killpg(group, libc::SIGTERM) };
        let until = Instant::now() + grace;
        while Instant::now() < until && !matches!(exited(child), Ok(true)) {
            std::thread::sleep(Duration::from_millis(20));
        }
        // SAFETY: as above. The leader is still unreaped, so the id is still this group's.
        unsafe { libc::killpg(group, libc::SIGKILL) };
    }
    #[cfg(windows)]
    {
        let _ = grace;
        let _ = crate::quiet::command("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
    failure
}

/// Calls in progress by attempt id, so the window can stop the one it means.
///
/// A cancel can arrive before its call has registered: the window sends both, and nothing orders
/// them. So a cancel for an unknown attempt is kept, and the call finds itself already cancelled.
static IN_FLIGHT: std::sync::Mutex<Vec<(String, Cancel)>> = std::sync::Mutex::new(Vec::new());

/// At most this many attempts are remembered, so cancels for calls that never come cannot grow
/// the list without bound.
const REMEMBERED: usize = 64;

fn in_flight() -> std::sync::MutexGuard<'static, Vec<(String, Cancel)>> {
    IN_FLIGHT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// How many Stops are shutting the stack down right now.
static STOPPING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Set once OpenBot is quitting, and never cleared: nothing the window asks for after that should
/// start.
static QUITTING: AtomicBool = AtomicBool::new(false);

fn closed() -> bool {
    QUITTING.load(Ordering::SeqCst) || STOPPING.load(Ordering::SeqCst) > 0
}

/// A Stop in progress. Calls are refused until it is dropped.
#[must_use = "calls are allowed again as soon as this is dropped"]
pub struct Closing(());

impl Drop for Closing {
    fn drop(&mut self) {
        STOPPING.fetch_sub(1, Ordering::SeqCst);
    }
}

/**
Refuse new calls and cancel the running ones, until the returned guard is dropped.

Cancelling once is not enough. A status or start the window sends while Stop is taking OpenBot's
containers down would otherwise take its turn ahead of the shutdown's own stop, or start after it
and leave the stack running. So every call registered while closing is cancelled before it begins,
except the shutdown's own (`stop_for_shutdown`).
*/
pub fn closing_for_stop() -> Closing {
    STOPPING.fetch_add(1, Ordering::SeqCst);
    cancel_all();
    Closing(())
}

/// As `closing_for_stop`, for good. Quitting also cancels a Stop's own stop, so Quit never waits
/// behind it; Quit runs its own.
pub fn close_for_quit() {
    close_for_quit_reporting(|| {});
}

/**
`close_for_quit`, telling `finishing` once when it waits for a back end update to finish.

Cancelling only asks: each call stops its CLI's process tree on its own thread, and the CLI forwards
SIGTERM to its children rather than exiting, so the tree goes at SIGKILL, after the grace. An app
that exits before then leaves it running with nobody to stop it. So this waits, up to ten seconds,
until no CLI is running.

Except an update that has begun changing the release with Helm, or a repair of one
(`update_finishing`). Stopping either partway is what left stacks no later update could get past
(`local_update`), so Quit waits for it to end on its own, within its own deadline, and says so.
True when it waited for one.
*/
pub fn close_for_quit_reporting(finishing: impl FnOnce()) -> bool {
    QUITTING.store(true, Ordering::SeqCst);
    cancel_all();
    let mut finishing = Some(finishing);
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if update_finishing() {
            if let Some(say) = finishing.take() {
                log::info!("[quit] letting the backend update finish before OpenBot quits");
                say();
            }
        } else if RUNNING.load(Ordering::SeqCst) == 0 || Instant::now() >= until {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let waited = finishing.is_none();
    if waited {
        log::info!("[quit] the backend update ended");
    }
    waited
}

/// CLI process trees started and not yet stopped or finished, across every call.
static RUNNING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Counts one CLI process tree as running for as long as it is held.
struct Running;

impl Running {
    fn start() -> Self {
        RUNNING.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.fetch_sub(1, Ordering::SeqCst);
    }
}

/// An attempt's place in `IN_FLIGHT`, removed however the call ends.
struct Attempt(Cancel);

impl Attempt {
    /// Read under the same lock `cancel_all` takes, so a call registering as closing begins is
    /// either refused here or cancelled there.
    fn register(id: &str) -> Self {
        Self::enter(id, true)
    }

    fn register_for_shutdown(id: &str) -> Self {
        Self::enter(id, false)
    }

    fn enter(id: &str, refused_while_closing: bool) -> Self {
        let mut held = in_flight();
        let cancel = match held.iter().position(|(attempt, _)| attempt == id) {
            Some(index) => held.remove(index).1,
            None => Cancel::default(),
        };
        if refused_while_closing && closed() {
            cancel.cancel();
        }
        held.push((id.to_owned(), cancel.clone()));
        Self(cancel)
    }
}

impl Drop for Attempt {
    fn drop(&mut self) {
        in_flight().retain(|(_, cancel)| !Arc::ptr_eq(&cancel.0, &self.0 .0));
    }
}

/// Held by the one call that is running. The CLI refuses a second `local` command while one is in
/// progress (`local_command_busy`), so a start racing a stop would fail one of them for nothing.
static CALLS: std::sync::Mutex<()> = std::sync::Mutex::new(());
static REQUIRED_CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static BACKGROUND_TELEMETRY: std::sync::Mutex<Option<Cancel>> = std::sync::Mutex::new(None);

/// Required CLI work cancels optional attribution before waiting for the process slot.
struct RequiredCliCall;

impl RequiredCliCall {
    fn begin() -> Self {
        REQUIRED_CALLS.fetch_add(1, Ordering::SeqCst);
        cancel_background_telemetry();
        Self
    }
}

impl Drop for RequiredCliCall {
    fn drop(&mut self) {
        REQUIRED_CALLS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Start may also need the native identity lock held by the background handshake.
pub fn cancel_background_telemetry() {
    let active = BACKGROUND_TELEMETRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(cancel) = active.as_ref() {
        cancel.cancel();
    }
}

/// Clear the optional process before releasing its CLI slot, including after an error.
struct BackgroundTelemetryCall;

impl Drop for BackgroundTelemetryCall {
    fn drop(&mut self) {
        *BACKGROUND_TELEMETRY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}

/**
Run `call` once every earlier call has finished, with what is left of `limits.timeout`.

The wait counts against the deadline, because the person waiting does not care which half of the
time went where. A cancel is honoured while waiting, and checked again once the turn comes, so a
call cancelled in the queue never starts a process.
*/
fn one_at_a_time<T>(
    cancel: &Cancel,
    limits: Limits,
    call: impl FnOnce(Limits) -> Result<T, Failure>,
) -> Result<T, Failure> {
    let _priority = RequiredCliCall::begin();
    let deadline = Instant::now() + limits.timeout;
    let _turn = loop {
        if cancel.requested() {
            return Err(Failure::Cancelled);
        }
        match CALLS.try_lock() {
            Ok(turn) => break turn,
            // A call that panicked held nothing the next one depends on.
            Err(std::sync::TryLockError::Poisoned(poisoned)) => break poisoned.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => {}
        }
        if Instant::now() >= deadline {
            return Err(Failure::Timeout);
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    if cancel.requested() {
        return Err(Failure::Cancelled);
    }
    let timeout = deadline.saturating_duration_since(Instant::now());
    if timeout.is_zero() {
        return Err(Failure::Timeout);
    }
    call(Limits { timeout, ..limits })
}

/// Run against the CLI this build has installed, with the default limits for `action`.
pub fn run_installed(attempt: &str, action: Action, stack: &StackId) -> Result<Report, Failure> {
    run_installed_with(attempt, action, stack, Limits::for_action(action))
}

/// Run against the installed CLI within `limits`, after any call already running has finished.
pub fn run_installed_with(
    attempt: &str,
    action: Action,
    stack: &StackId,
    limits: Limits,
) -> Result<Report, Failure> {
    run_attempt(attempt, Attempt::register(attempt), action, stack, limits)
}

/// `stop` for Stop or Quit itself: the one call let through while closing. A later Quit still
/// cancels it.
pub fn stop_for_shutdown(
    attempt: &str,
    stack: &StackId,
    limits: Limits,
) -> Result<Report, Failure> {
    run_attempt(
        attempt,
        Attempt::register_for_shutdown(attempt),
        Action::Stop,
        stack,
        limits,
    )
}

fn run_attempt(
    id: &str,
    attempt: Attempt,
    action: Action,
    stack: &StackId,
    limits: Limits,
) -> Result<Report, Failure> {
    one_at_a_time(&attempt.0, limits, |remaining| {
        // Its turn: the CLI's log from here on is this call's (`Trail`).
        let _trail = Trail::begin(id, action.into());
        let cli = installed()?;
        run_with(
            &cli,
            id,
            action,
            stack,
            (limits, remaining),
            &attempt.0,
            crate::local_images::Limits::standard(),
        )
    })
}

/**
`run`, after downloading the images the call is about to pull (`local_images`).

Only `local update` pulls. A new update pulls the release this CLI installs. One that did not finish
is resumed by `local update` (`update_due`), to the release on record, so that release's images are
downloaded when it is this CLI's, and left to the CLI when it is not. `local start` pulls nothing:
the CLI refuses it while an update is on record (`localStartRelease`, `update_recovery_required`).
A download has its own limits, so a CLI call that followed one gets its whole limit (`limits.0`)
rather than what was left of it after the wait for its turn (`limits.1`).
*/
pub(crate) fn run_with(
    cli: &PinnedCli,
    attempt: &str,
    action: Action,
    stack: &StackId,
    limits: (Limits, Limits),
    cancel: &Cancel,
    images_limits: crate::local_images::Limits,
) -> Result<Report, Failure> {
    let call = || run_downloading(cli, attempt, action, stack, limits, cancel, images_limits);
    match action {
        // The calls that start the back end: the engine is checked around them.
        Action::Start => checked_call("local start", Some(stack), call),
        Action::Update => checked_call("local update", Some(stack), || {
            update_repairing(stack, cancel, call)
        }),
        Action::Status => call().map(|report| checked_when_unhealthy(report, stack)),
        Action::Stop => call(),
    }
}

/**
A back end that runs but does not answer (`local status` says `degraded`), checked as a failed start
is. After a start that failed on a full disk the node stays up, so Retry reads its status rather
than starting it again, and k3s keeps its `DiskPressure` for minutes after space is freed. A disk
that is short, or a node recovering from one, becomes the report's `shortfall`, and the card says
which; anything else leaves the report as it was. Not when every check passed: an update the CLI
keeps on record is `degraded` too, with the back end answering.
*/
fn checked_when_unhealthy(mut report: Report, stack: &StackId) -> Report {
    if report.outcome != Outcome::Completed
        || report.readiness != Readiness::Degraded
        || report.checks_passed
    {
        return report;
    }
    let Some(address) = cli_engine() else {
        return report;
    };
    let mut check = EngineCheck::of(&address);
    check.pressure = node_disk_pressure(Some(stack));
    log_check("local status, running but not healthy", &check);
    let short = check.shortfall();
    if short.disk || short.recovering {
        report.shortfall = Some(short);
    }
    report
}

/**
`local update`, and once more after repairing the stack when it failed on something a repair puts
right (`local_update`): an update stopped partway earlier, which every later one fails on at once.

Only after a failure the CLI reported. Not after one OpenBot stopped, or while closing: the next
Start repairs then (`repaired_before`), and Quit is not held behind a second update.
*/
fn update_repairing(
    stack: &StackId,
    cancel: &Cancel,
    update: impl Fn() -> Result<Report, Failure>,
) -> Result<Report, Failure> {
    uncordoned(stack, "before the update");
    let first = update();
    let failed = match &first {
        Ok(report) => report.outcome == Outcome::Failed,
        Err(failure) => *failure == Failure::UnexpectedExit,
    };
    if !failed || cancel.requested() || closed() {
        return first;
    }
    log::warn!(
        "[local update] failed; checking whether an update stopped earlier left the backend needing repair"
    );
    match repair_stack(stack) {
        Ok(repaired) if repaired.changed() => {
            log::info!("[local update] repaired ({repaired:?}); trying the update once more");
            uncordoned(stack, "before the retry");
            update()
        }
        Ok(_) => {
            log::info!("[update repair] nothing to repair");
            first
        }
        Err(why) => {
            log::warn!("[update repair] not repaired: {why}");
            first
        }
    }
}

/// `local_update::uncordon_if_cordoned` on `stack`'s node, when it is running. A node that does
/// not answer is stopped, and the CLI starts it; the update's own watch looks again then
/// (`UpdateWatch::watch_node`).
fn uncordoned(stack: &StackId, when: &str) {
    let engine = recorded_engine();
    match crate::local_update::uncordon_if_cordoned(
        || engine_command(engine.as_ref()),
        stack.as_str(),
    ) {
        Ok(true) => log::info!("[local update] uncordoned the backend's node {when}"),
        Ok(false) => {}
        Err(why) => log::info!("[local update] node not checked {when}: {why}"),
    }
}

/// `local_update::repair` on `stack`, with the CLI's Helm and folder and the environment and
/// engine every CLI call gets. Counts as finishing (`update_finishing`) while it runs.
fn repair_stack(stack: &StackId) -> Result<crate::local_update::Repaired, String> {
    let directory = crate::local_update::stack_dir(stack.as_str())
        .ok_or("no home folder to find the CLI's files in")?;
    let tools = directory
        .parent()
        .map(|parent| parent.join("tools"))
        .ok_or("no tools folder")?;
    let helm =
        crate::local_update::cli_helm(&tools).ok_or("the CLI has not downloaded its Helm")?;
    let engine = recorded_engine();
    let command = |program: &std::ffi::OsStr| tool_command(program, engine.as_ref());
    let engine_command = || engine_command(engine.as_ref());
    let _finishing = Finishing::begin();
    crate::local_update::repair(&crate::local_update::Reach {
        stack: stack.as_str(),
        directory,
        helm,
        command: &command,
        engine: &engine_command,
    })
}

/// A program the CLI runs (its Helm), with the environment the CLI itself gets.
fn tool_command(program: &std::ffi::OsStr, engine: Option<&CliEngine>) -> std::process::Command {
    let mut command = crate::quiet::command(program);
    cli_environment(
        &mut command,
        engine,
        |name| std::env::var_os(name),
        crate::docker_config::owned(),
    );
    command
}

/// `run_with`, without the engine check.
fn run_downloading(
    cli: &PinnedCli,
    attempt: &str,
    action: Action,
    stack: &StackId,
    limits: (Limits, Limits),
    cancel: &Cancel,
    images_limits: crate::local_images::Limits,
) -> Result<Report, Failure> {
    // A CLI whose images cannot be read runs exactly as before, with nothing asked of it first.
    let downloaded = match (action, cli_images_of(cli)) {
        (Action::Update, Some(images)) => match update_resumes(cli, stack, cancel)? {
            Some(resumed) => download_images(
                &images,
                &arguments(action, stack),
                stack,
                resumed.as_deref(),
                attempt,
                cancel,
                images_limits,
            )?,
            None => false,
        },
        _ => false,
    };
    let limits = if downloaded { limits.0 } else { limits.1 };
    if action == Action::Update {
        return run_update(cli, attempt, stack, limits, cancel);
    }
    run(cli, action, stack, limits, cancel)
}

/// `run` for `local update`, followed through the CLI's log while it runs (`UpdateWatch`).
fn run_update(
    cli: &PinnedCli,
    attempt: &str,
    stack: &StackId,
    limits: Limits,
    cancel: &Cancel,
) -> Result<Report, Failure> {
    let mut watch = UpdateWatch::new(attempt, stack);
    let (code, bytes) = execute_watching(
        cli,
        &arguments(Action::Update, stack),
        None,
        limits,
        cancel,
        None,
        watch.as_mut(),
    )?;
    normalize(Action::Update, code, &bytes)
}

/// What `cli` pulls, read from its own bytes (`local_images::cli_images`): the script a runtime
/// runs, or the program itself. Larger than this is not a CLI it can read.
fn cli_images_of(cli: &PinnedCli) -> Option<crate::local_images::CliImages> {
    const MAX_SOURCE: u64 = 128 << 20;
    let mut bytes = Vec::new();
    std::fs::File::open(cli.entry.as_ref().unwrap_or(&cli.program))
        .ok()?
        .take(MAX_SOURCE)
        .read_to_end(&mut bytes)
        .ok()?;
    crate::local_images::cli_images(&String::from_utf8_lossy(&bytes))
}

/// What the CLI this app runs pulls when it updates a stack (`cli_images_of`), for `update_ready`,
/// which downloads the next release's images by the same repositories. None without a CLI whose
/// images can be read.
pub fn bundled_cli_images() -> Option<crate::local_images::CliImages> {
    cli_images_of(&installed().ok()?)
}

/**
Download `images` into `stack`'s node before the CLI pulls them. True when it downloaded, false when
there was nothing it could do, which leaves the pull to the CLI as before: a release other than
`expected` when one is, or a node it cannot reach.

A download that stops is the call's failure, and the CLI does not run: on a line that stopped it
would only fail again, later. What arrived is kept for the next attempt.
*/
fn download_images(
    images: &crate::local_images::CliImages,
    arguments: &[&str],
    stack: &StackId,
    expected: Option<&str>,
    attempt: &str,
    cancel: &Cancel,
    limits: crate::local_images::Limits,
) -> Result<bool, Failure> {
    use crate::local_images::{download, Done, Node, Showing, Stop};
    if expected.is_some_and(|release| release != images.release) {
        return Ok(false);
    }
    let engine = recorded_engine();
    // Where the CLI would refuse to run, nothing is downloaded for it either.
    refuse_rootless(arguments, engine.as_ref())?;
    let command = || engine_command(engine.as_ref());
    let node = Node::for_stack(&command, stack.as_str());
    let _running = Running::start();
    let showing = Showing::new(attempt);
    match download(
        &node,
        images,
        limits,
        &|| cancel.requested(),
        &mut |progress| showing.show(progress),
    ) {
        Ok(Done::Downloaded) => Ok(true),
        Ok(Done::NothingToDo | Done::Unavailable) => Ok(false),
        Err(Stop::Stalled) => Err(Failure::DownloadStalled),
        Err(Stop::TooLong) => Err(Failure::Timeout),
        Err(Stop::Cancelled) => Err(Failure::Cancelled),
    }
}

/// What `local update` on `stack` would install, as far as `local status` says: `Some(None)` for a
/// new update, `Some(Some(release))` to resume the one the CLI keeps on record because it did not
/// finish (`UnfinishedUpdate::to`), and `None` when status does not say.
fn update_resumes(
    cli: &PinnedCli,
    stack: &StackId,
    cancel: &Cancel,
) -> Result<Option<Option<String>>, Failure> {
    match run(
        cli,
        Action::Status,
        stack,
        Limits::for_action(Action::Status),
        cancel,
    ) {
        Ok(Report {
            outcome: Outcome::Completed,
            stack: Some(saved),
            ..
        }) => {
            let saved = repaired_before(stack, saved);
            Ok(match saved.unfinished_update {
                Some(unfinished) => Some(Some(unfinished.to)),
                // An update on record that does not name its release is the CLI's own business.
                None if saved.update_in_progress => None,
                None => Some(None),
            })
        }
        Err(Failure::Cancelled) => Err(Failure::Cancelled),
        // The update itself says what is wrong; this was only a look.
        _ => Ok(None),
    }
}

/**
An update on record that got past its first step, on a running stack, is repaired before it resumes
(`local_update`), so a stack an earlier update left half done does not fail it at once. A stopped
stack is left to the CLI, which starts it; if the update then fails on it, `update_repairing`
repairs it and tries once more.
*/
fn repaired_before(stack: &StackId, saved: Stack) -> Stack {
    let past_first_step = saved
        .unfinished_update
        .as_ref()
        .is_some_and(|update| !update.prepared);
    let running = saved
        .observed
        .as_ref()
        .is_some_and(|observed| observed.running);
    if past_first_step && running {
        log::info!(
            "[update repair] an update is on record past its first step; checking the backend before it resumes"
        );
        match repair_stack(stack) {
            Ok(repaired) => log::info!("[update repair] {repaired:?}"),
            Err(why) => log::warn!("[update repair] not repaired: {why}"),
        }
    }
    saved
}

/**
The stack `local setup` in `installation` resumes, when it has images still to pull: the one the CLI
recorded for that folder (`appPaths`, which it keeps as the folder's real path), with its release,
and not already set up. `None` for a first setup, which has no node to download into yet.
*/
fn stack_set_up_in(
    cli: &PinnedCli,
    installation: &std::path::Path,
    cancel: &Cancel,
) -> Result<Option<(StackId, String)>, Failure> {
    let (code, bytes) = match execute(
        cli,
        &LIST_ARGUMENTS,
        None,
        Limits::for_action(Action::Status),
        cancel,
    ) {
        Ok(answer) => answer,
        Err(Failure::Cancelled) => return Err(Failure::Cancelled),
        Err(_) => return Ok(None),
    };
    let Ok((Outcome::Completed, wire)) = parse_envelope("local list", code, &bytes) else {
        return Ok(None);
    };
    let Ok(folder) = installation.canonicalize() else {
        return Ok(None);
    };
    let here = |saved: &Value| {
        saved
            .get("appPaths")
            .and_then(Value::as_array)
            .is_some_and(|paths| {
                paths.iter().any(|path| {
                    path.get("path")
                        .and_then(Value::as_str)
                        .and_then(|path| std::path::Path::new(path).canonicalize().ok())
                        .is_some_and(|path| path == folder)
                })
            })
    };
    let stacks = wire.get("stacks").and_then(Value::as_array);
    Ok(stacks
        .into_iter()
        .flatten()
        .filter(|saved| here(saved))
        .find_map(|saved| {
            let id = StackId::parse(saved.get("id")?.as_str()?).ok()?;
            let release = text(saved.get("installedRelease")).ok()?;
            let finished = saved.get("step").and_then(Value::as_str) == Some("ready")
                && saved.get("failedStep").is_none_or(Value::is_null)
                && saved.get("update").is_none_or(Value::is_null);
            (!finished).then_some((id, release))
        }))
}

/// `local setup` in `installation` against the installed CLI, in its turn like every other call.
/// The digest of the CLI that ran comes back with the report, so the caller records which one.
///
/// A setup that resumes a stack whose node is there downloads its images first (`local_images`):
/// on a slow line that is how a first setup that stopped in its image download finishes.
///
/// A setup that stopped because this folder's stack lost its private files starts that stack over,
/// or says in plain words what to do (`lost_stack`).
pub fn setup_installed(
    attempt: &str,
    installation: &std::path::Path,
    accepted: Option<&EulaVersion>,
) -> Result<(Report, String), SetupStopped> {
    let id = attempt;
    let attempt = Attempt::register(attempt);
    one_at_a_time(&attempt.0, Limits::for_setup(), |remaining| {
        // Its turn: the CLI's log from here on is this setup's (`Trail`).
        let _trail = Trail::begin(id, TrailKind::Setup);
        let cli = installed()?;
        let set_up = || {
            setup_with(
                &cli,
                id,
                installation,
                accepted,
                (Limits::for_setup(), remaining),
                &attempt.0,
                crate::local_images::Limits::standard(),
            )
        };
        let report = set_up()?;
        let report = match lost_stack(&cli, &report, installation, &attempt.0)? {
            None => report,
            Some(Lost::Said(problem)) => return Ok(Err(problem)),
            // A delete that did not finish leaves the setup failed, as it was.
            Some(Lost::Forgettable(stack)) => match forget(&cli, &stack, &attempt.0) {
                Ok(()) => set_up()?,
                Err(Failure::Cancelled) => return Err(Failure::Cancelled),
                Err(_) => report,
            },
        };
        Ok(Ok((report, cli.sha256().to_owned())))
    })
    .map_err(SetupStopped::Failure)?
    .map_err(SetupStopped::Said)
}

/// Why `setup_installed` gave no report: the CLI's own static category, or OpenBot's plain words.
#[derive(Debug, PartialEq, Eq)]
pub enum SetupStopped {
    Failure(Failure),
    Said(crate::problem::Problem),
}

/// What setup does about a stack that lost the files it resumes from.
enum Lost {
    /// The stack is this folder's alone and its files are gone: forgotten, and set up again.
    Forgettable(StackId),
    /// Kept as it is, with what the person can do about it.
    Said(crate::problem::Problem),
}

/// The private files the CLI resumes a stack from, in `local-evaluation/<stack>`.
#[derive(Debug, PartialEq, Eq)]
enum PrivateFiles {
    Present,
    /// `setup.json` or `secrets.json` is not there.
    Missing,
    /// There, but not readable as the CLI writes it.
    Damaged,
}

/**
Whether `local setup` can still resume a stack from `folder`, its private folder. The CLI's own test,
before it touches anything (Intelligence `apps/cli/src/services/local-setup.ts`): `setup.json` holds
the stack's licence and `secrets.json` its keys, and with either gone it refuses with "Restore the
private setup and credentials files before resuming this stack", never making new keys.
*/
fn private_files(folder: &std::path::Path) -> PrivateFiles {
    let read = |name: &str| std::fs::read(folder.join(name));
    let gone = |result: &std::io::Result<Vec<u8>>| matches!(result, Err(error) if error.kind() == std::io::ErrorKind::NotFound);
    let (setup, secrets) = (read("setup.json"), read("secrets.json"));
    if gone(&setup) || gone(&secrets) {
        return PrivateFiles::Missing;
    }
    let licensed = setup
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|setup| {
            setup
                .get("licenseToken")
                .and_then(Value::as_str)
                .map(|token| !token.is_empty())
        })
        .unwrap_or(false);
    if licensed && secrets.is_ok() {
        PrivateFiles::Present
    } else {
        PrivateFiles::Damaged
    }
}

/**
A failed `local setup` for a stack that can no longer be resumed.

Found on OpenBot Desktop 1.0.0, reinstalled after the earlier installation's folder, app data and
back end were deleted. The CLI still recorded a stack for `~/OpenBot`, and its private folder was
gone, so every setup stopped with "Restore the private setup and credentials files before resuming
this stack" and the window said "Back end setup stopped", with nothing the person could do.

The stack is the one the CLI records for this folder (`appPaths`, by real path). With its private
files missing and no other app using it, nothing can ever resume it, so it is forgotten and set up
again. With them damaged, or with another app on it, it is kept and the person is told what to do.
None for every other failure, and for a stack whose files are there.
*/
fn lost_stack(
    cli: &PinnedCli,
    report: &Report,
    installation: &std::path::Path,
    cancel: &Cancel,
) -> Result<Option<Lost>, Failure> {
    if report.outcome != Outcome::Failed || report.reason != Some(Reason::LocalCommandFailed) {
        return Ok(None);
    }
    let (code, bytes) = match execute(
        cli,
        &LIST_ARGUMENTS,
        None,
        Limits::for_action(Action::Status),
        cancel,
    ) {
        Ok(answer) => answer,
        Err(Failure::Cancelled) => return Err(Failure::Cancelled),
        Err(_) => return Ok(None),
    };
    let Ok((Outcome::Completed, wire)) = parse_envelope("local list", code, &bytes) else {
        return Ok(None);
    };
    let Ok(folder) = installation.canonicalize() else {
        return Ok(None);
    };
    let is_here = |path: &str| {
        std::path::Path::new(path)
            .canonicalize()
            .is_ok_and(|path| path == folder)
    };
    for saved in wire
        .get("stacks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let paths: Vec<&str> = saved
            .get("appPaths")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|path| path.get("path").and_then(Value::as_str))
            .collect();
        if !paths.iter().any(|path| is_here(path)) {
            continue;
        }
        let Some(stack) = saved
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| StackId::parse(id).ok())
        else {
            return Ok(None);
        };
        let Some(private) = crate::local_update::stack_dir(stack.as_str()) else {
            return Ok(None);
        };
        let shared = paths.iter().any(|path| !is_here(path));
        let files = private_files(&private);
        log::warn!(
            "[local setup] {}'s private files are {files:?}{}",
            stack.as_str(),
            if shared {
                "; another app uses it too"
            } else {
                ""
            }
        );
        return Ok(match files {
            PrivateFiles::Present => None,
            PrivateFiles::Missing if !shared => Some(Lost::Forgettable(stack)),
            PrivateFiles::Missing => Some(Lost::Said(crate::problem::Problem::with(
                format!(
                    "OpenBot's services on this computer are missing their saved settings, and \
                     another app on this computer uses them too. Restore {} from a backup, then try \
                     again.",
                    private.display()
                ),
                format!("{} lost setup.json or secrets.json", stack.as_str()),
            ))),
            PrivateFiles::Damaged => Some(Lost::Said(crate::problem::Problem::with(
                format!(
                    "The saved settings of OpenBot's services on this computer can't be read. \
                     Restore {} from a backup, or delete that folder to set them up again from the \
                     start. Then try again.",
                    private.display()
                ),
                format!("{}: setup.json or secrets.json is unreadable", stack.as_str()),
            ))),
        });
    }
    Ok(None)
}

/// `local delete --stack <stack> --confirm-delete <stack> --json`: the CLI's own way to forget a
/// stack. It removes the stack's cluster when k3d still lists one, its private folder and its
/// record, and leaves every other stack as it is.
pub fn forget_arguments(stack: &StackId) -> [&str; 7] {
    [
        "local",
        "delete",
        "--stack",
        stack.as_str(),
        "--confirm-delete",
        stack.as_str(),
        "--json",
    ]
}

/// Forget `stack` (`forget_arguments`). Anything but a completed delete leaves setup failed.
fn forget(cli: &PinnedCli, stack: &StackId, cancel: &Cancel) -> Result<(), Failure> {
    let (code, bytes) = execute(
        cli,
        &forget_arguments(stack),
        None,
        Limits::for_action(Action::Stop),
        cancel,
    )?;
    let (outcome, _) = parse_envelope("local delete", code, &bytes)?;
    if outcome != Outcome::Completed {
        log::warn!(
            "[local setup] the CLI did not forget {}: {outcome:?}",
            stack.as_str()
        );
        return Err(Failure::InvalidStatus);
    }
    log::info!(
        "[local setup] forgot {}, whose private files were gone; setting the backend up again",
        stack.as_str()
    );
    Ok(())
}

/// `configure_learning_model` against the installed CLI, in its turn like every other call.
pub fn configure_learning_model_installed(
    attempt: &str,
    installation: &std::path::Path,
    file: Option<&std::path::Path>,
) -> Result<Report, Failure> {
    let attempt = Attempt::register(attempt);
    one_at_a_time(&attempt.0, Limits::for_learning_model(), |limits| {
        let cli = installed()?;
        configure_learning_model(&cli, installation, file, limits, &attempt.0)
    })
}

/// `setup`, after downloading the images a resumed setup is about to pull. Limits as `run_with`.
pub(crate) fn setup_with(
    cli: &PinnedCli,
    attempt: &str,
    installation: &std::path::Path,
    accepted: Option<&EulaVersion>,
    limits: (Limits, Limits),
    cancel: &Cancel,
    images_limits: crate::local_images::Limits,
) -> Result<Report, Failure> {
    // The engine is checked around it, as around `local start` (`checked_call`).
    checked_call("local setup", None, || {
        setup_downloading(
            cli,
            attempt,
            installation,
            accepted,
            limits,
            cancel,
            images_limits,
        )
    })
}

/// `setup_with`, without the engine check.
fn setup_downloading(
    cli: &PinnedCli,
    attempt: &str,
    installation: &std::path::Path,
    accepted: Option<&EulaVersion>,
    limits: (Limits, Limits),
    cancel: &Cancel,
    images_limits: crate::local_images::Limits,
) -> Result<Report, Failure> {
    let downloaded = match cli_images_of(cli) {
        Some(images) => match stack_set_up_in(cli, installation, cancel)? {
            Some((stack, release)) => download_images(
                &images,
                &setup_arguments(accepted),
                &stack,
                Some(&release),
                attempt,
                cancel,
                images_limits,
            )?,
            // A first setup: its node does not exist until the CLI makes it, so its download is
            // followed while the CLI pulls (`local_images::follow_new_stack`).
            None => {
                return setup_followed(
                    cli,
                    installation,
                    accepted,
                    limits.1,
                    cancel,
                    &images,
                    attempt,
                    images_limits,
                );
            }
        },
        None => false,
    };
    let limits = if downloaded { limits.0 } else { limits.1 };
    setup(cli, installation, accepted, limits, cancel)
}

/**
A first `local setup`, with how far its image download has got shown for `attempt` while it runs.

The CLI creates the stack's node and pulls into it itself, so nothing can be downloaded for it first.
Its pulls are followed instead, from the node's containerd, so the row shows the download a first
install waits on. An engine that does not say which nodes it has leaves the setup to run as before.
*/
#[allow(clippy::too_many_arguments)]
fn setup_followed(
    cli: &PinnedCli,
    installation: &std::path::Path,
    accepted: Option<&EulaVersion>,
    limits: Limits,
    cancel: &Cancel,
    images: &crate::local_images::CliImages,
    attempt: &str,
    images_limits: crate::local_images::Limits,
) -> Result<Report, Failure> {
    let engine = recorded_engine();
    if refuse_rootless(&setup_arguments(accepted), engine.as_ref()).is_err() {
        return setup(cli, installation, accepted, limits, cancel);
    }
    let command = || engine_command(engine.as_ref());
    let Some(before) = crate::local_images::stack_nodes(&command, images_limits) else {
        return setup(cli, installation, accepted, limits, cancel);
    };
    let finished = AtomicBool::new(false);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let showing = crate::local_images::Showing::new(attempt);
            crate::local_images::follow_new_stack(
                &command,
                images,
                &before,
                images_limits,
                &|| finished.load(Ordering::SeqCst) || cancel.requested(),
                &mut |progress| showing.show(progress),
            );
        });
        let report = setup(cli, installation, accepted, limits, cancel);
        finished.store(true, Ordering::SeqCst);
        report
    })
}

/// The CopilotKit account sign-in against the installed CLI. While it waits, `shown_sign_in_page`
/// answers for `attempt` with the page the CLI opened.
pub fn account_sign_in_installed(attempt: &str) -> Result<AccountSignIn, Failure> {
    let showing = ShowingSignIn(attempt.to_owned());
    let attempt = Attempt::register(attempt);
    one_at_a_time(&attempt.0, Limits::for_account_sign_in(), |limits| {
        let cli = installed()?;
        account_sign_in(&cli, limits, &attempt.0, &mut |page| showing.show(page))
    })
}

/// Closed output of the CLI's authenticated desktop identity handshake.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TelemetryIdentity {
    Account { account_id: String },
    Linked { account_id: String },
    SignedOut,
    Skipped,
}

/// Background attribution never queues ahead of required CLI work, and yields if it arrives.
fn background_telemetry_call<T>(
    call: impl FnOnce(&Cancel, Limits) -> Result<T, Failure>,
) -> Result<T, Failure> {
    let cancel = Cancel::default();
    let mut active = BACKGROUND_TELEMETRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if REQUIRED_CALLS.load(Ordering::SeqCst) != 0 {
        return Err(Failure::Cancelled);
    }
    let _turn = match CALLS.try_lock() {
        Ok(turn) => turn,
        Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => return Err(Failure::Cancelled),
    };
    *active = Some(cancel.clone());
    drop(active);
    let _cleanup = BackgroundTelemetryCall;
    call(&cancel, telemetry_link_limits())
}

/// Use the same verified CLI contract, but let required account/setup calls preempt it.
pub fn link_telemetry_background_installed(
    installation: &Installation,
    account: Option<&str>,
) -> Result<TelemetryIdentity, Failure> {
    background_telemetry_call(|cancel, limits| {
        let cli = installed()?;
        link_telemetry(&cli, installation, account, limits, cancel)
    })
}

/// Bound the optional handshake separately from product CLI operations.
fn telemetry_link_limits() -> Limits {
    Limits {
        timeout: Duration::from_secs(8),
        grace: Duration::from_millis(250),
        output: MAX_OUTPUT,
    }
}

/// Execute the fixed identity command through the same bounded process boundary as setup.
fn link_telemetry(
    cli: &PinnedCli,
    installation: &Installation,
    account: Option<&str>,
    limits: Limits,
    cancel: &Cancel,
) -> Result<TelemetryIdentity, Failure> {
    if account.is_some_and(|value| !crate::telemetry::is_account_id(value)) {
        return Err(Failure::ContractMismatch);
    }
    let mut arguments = vec![
        "telemetry",
        "link",
        "--installation-id",
        installation.as_str(),
        "--json",
    ];
    if let Some(account) = account {
        arguments.extend(["--account-id", account]);
    }
    let (code, bytes) = execute(cli, &arguments, None, limits, cancel)?;
    normalize_telemetry_identity(code, &bytes)
}

/// Refuse unexpected or private fields before returning anything to the shell.
pub fn normalize_telemetry_identity(code: i32, bytes: &[u8]) -> Result<TelemetryIdentity, Failure> {
    if code != 0 {
        return Err(Failure::UnexpectedExit);
    }
    if bytes.len() > MAX_OUTPUT {
        return Err(Failure::OutputLimit);
    }
    let result: TelemetryIdentity =
        serde_json::from_slice(bytes).map_err(|_| Failure::InvalidJson)?;
    match &result {
        TelemetryIdentity::Account { account_id } | TelemetryIdentity::Linked { account_id }
            if !crate::telemetry::is_account_id(account_id) =>
        {
            return Err(Failure::ContractMismatch)
        }
        _ => {}
    }
    Ok(result)
}

/// The approval page each waiting account sign-in has shown, by attempt id.
static SIGN_IN_PAGES: std::sync::Mutex<Vec<(String, SignInPage)>> =
    std::sync::Mutex::new(Vec::new());

fn sign_in_pages() -> std::sync::MutexGuard<'static, Vec<(String, SignInPage)>> {
    SIGN_IN_PAGES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// An account sign-in's place in `SIGN_IN_PAGES`, removed however the sign-in ends.
struct ShowingSignIn(String);

impl ShowingSignIn {
    fn show(&self, page: SignInPage) {
        let mut pages = sign_in_pages();
        pages.retain(|(attempt, _)| attempt != &self.0);
        pages.push((self.0.clone(), page));
    }
}

impl Drop for ShowingSignIn {
    fn drop(&mut self) {
        sign_in_pages().retain(|(attempt, _)| attempt != &self.0);
    }
}

/**
The steps a running CLI call has finished, as its `cli.log` lines say, while it runs: so the window
can say what a long setup, start or update is doing now and how far along it is, and never sit on
one line for minutes.

From the call's turn on (`one_at_a_time`), the log's new `local.step` lines are the call's own:
OpenBot runs one CLI call at a time. Only the steps' names, which are identifiers, leave this
module, and the seconds since the last one ended.
*/
struct Trail(String);

struct Followed {
    attempt: String,
    kind: TrailKind,
    log: crate::local_update::StepLog,
    ended: Vec<String>,
    since: Instant,
}

/// Which CLI call a trail follows, for the journey its steps belong to (`stall`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrailKind {
    /// `local setup`.
    Setup,
    /// `local update`.
    Update,
    /// Any other call: `local start`, `stop` or `status`.
    Other,
}

impl From<Action> for TrailKind {
    fn from(action: Action) -> Self {
        match action {
            Action::Update => TrailKind::Update,
            Action::Status | Action::Start | Action::Stop => TrailKind::Other,
        }
    }
}

static TRAILS: std::sync::Mutex<Vec<Followed>> = std::sync::Mutex::new(Vec::new());

fn trails() -> std::sync::MutexGuard<'static, Vec<Followed>> {
    TRAILS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Trail {
    fn begin(attempt: &str, kind: TrailKind) -> Self {
        if let Some(path) = crate::local_update::cli_log() {
            let mut held = trails();
            held.retain(|followed| followed.attempt != attempt);
            held.push(Followed {
                attempt: attempt.to_owned(),
                kind,
                log: crate::local_update::StepLog::at_end_of(path),
                ended: Vec::new(),
                since: Instant::now(),
            });
        }
        Self(attempt.to_owned())
    }
}

impl Drop for Trail {
    fn drop(&mut self) {
        trails().retain(|followed| followed.attempt != self.0);
    }
}

/// What the call `attempt` has done so far, by the CLI's own step names, in the order they ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Steps {
    pub ended: Vec<String>,
    /// Seconds since the last step ended, or since the call began.
    pub quiet_seconds: u64,
}

/// The steps the running call `attempt` has finished, while it runs. None once it has ended.
pub fn steps(attempt: &str) -> Option<Steps> {
    let mut held = trails();
    let followed = held
        .iter_mut()
        .find(|followed| followed.attempt == attempt)?;
    followed.catch_up();
    Some(Steps {
        ended: followed.ended.clone(),
        quiet_seconds: followed.since.elapsed().as_secs(),
    })
}

impl Followed {
    /// Read the steps logged since the last look.
    fn catch_up(&mut self) {
        let ended = self.log.poll();
        if !ended.is_empty() {
            self.since = Instant::now();
            self.ended.extend(ended);
        }
    }
}

/// The setup or update running now, as `stall` times its steps: its attempt, the steps it has
/// finished, and when the last of them ended (or the call began).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrailNow {
    pub kind: TrailKind,
    pub attempt: String,
    pub ended: Vec<String>,
    pub since: Instant,
}

/// The `local setup` or `local update` running now, if one is.
pub fn trail_now() -> Option<TrailNow> {
    let mut held = trails();
    let followed = held
        .iter_mut()
        .find(|followed| followed.kind != TrailKind::Other)?;
    followed.catch_up();
    Some(TrailNow {
        kind: followed.kind,
        attempt: followed.attempt.clone(),
        ended: followed.ended.clone(),
        since: followed.since,
    })
}

/// How far the back end's image download before the call `attempt` has got, while it runs.
pub fn downloading(attempt: &str) -> Option<crate::local_images::Download> {
    crate::local_images::downloading(attempt)
}

/// The approval page the account sign-in `attempt` is waiting on, once the CLI has opened one.
pub fn shown_sign_in_page(attempt: &str) -> Option<SignInPage> {
    sign_in_pages()
        .iter()
        .find(|(id, _)| id == attempt)
        .map(|(_, page)| page.clone())
}

/// The evaluation agreement against the installed CLI.
pub fn terms_installed(attempt: &str) -> Result<Terms, Failure> {
    let attempt = Attempt::register(attempt);
    one_at_a_time(&attempt.0, Limits::for_action(Action::Status), |limits| {
        let cli = installed()?;
        terms(&cli, limits, &attempt.0)
    })
}

/// `local connect` in `installation` against the installed CLI, within the limits of `status`.
pub fn connect_installed(
    attempt: &str,
    installation: &std::path::Path,
) -> Result<Connection, Failure> {
    let attempt = Attempt::register(attempt);
    one_at_a_time(&attempt.0, Limits::for_action(Action::Status), |limits| {
        let cli = installed()?;
        connect(&cli, installation, limits, &attempt.0)
    })
}

/// This installation's Composio project against the installed CLI. See `apps_arguments`.
pub fn provision_apps_installed(
    attempt: &str,
    installation: &str,
    env_file: &std::path::Path,
) -> Result<AppsProvisioned, Failure> {
    let installation = Installation::parse(installation)?;
    let attempt = Attempt::register(attempt);
    one_at_a_time(&attempt.0, Limits::for_apps(), |limits| {
        let cli = installed()?;
        provision_apps(&cli, &installation, env_file, limits, &attempt.0)
    })
}

/// `local login` against the installed CLI, within the limits of `status`: the CLI waits up to a
/// minute for the dashboard before it opens anything.
pub fn login_installed(attempt: &str, stack: &StackId) -> Result<SignIn, Failure> {
    let attempt = Attempt::register(attempt);
    one_at_a_time(&attempt.0, Limits::for_action(Action::Status), |limits| {
        let cli = installed()?;
        login(&cli, stack, limits, &attempt.0)
    })
}

/// `local list` against the installed CLI.
pub fn list_installed(attempt: &str) -> Result<Listing, Failure> {
    let attempt = Attempt::register(attempt);
    one_at_a_time(&attempt.0, Limits::for_action(Action::Status), |limits| {
        let cli = installed()?;
        list(&cli, limits, &attempt.0)
    })
}

/// Stop one call, whether or not it has started yet.
pub fn cancel(attempt: &str) {
    let mut held = in_flight();
    match held.iter().find(|(id, _)| id == attempt) {
        Some((_, cancel)) => cancel.cancel(),
        None => {
            if held.len() >= REMEMBERED {
                held.remove(0);
            }
            let cancel = Cancel::default();
            cancel.cancel();
            held.push((attempt.to_owned(), cancel));
        }
    }
}

/// Stop every call in progress, before Stop or Quit asks the CLI to stop. Each stops its own
/// process tree, and a call still waiting for its turn never starts.
pub fn cancel_all() {
    for (_, cancel) in in_flight().iter() {
        cancel.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{compile_fixture, temp_root};
    use serde_json::json;
    use std::path::Path;
    use std::sync::OnceLock;

    const SECRET: &str = "synthetic-secret-marker";

    // Mirrors local.ts and local-manager.ts at Intelligence 3935afbf, with synthetic identifiers.
    fn envelope() -> Value {
        json!({
            "version": 1,
            "command": "local status",
            "status": "completed",
            "stack": {
                "id": "local-abc123",
                "installedRelease": "0.15.0",
                "step": "ready",
                "urls": {
                    "api": "http://localhost:8082",
                    "dashboard": "http://intelligence.localhost:8080",
                    "gateway": "ws://[::1]:4401"
                },
                "failedStep": null,
                "update": null,
                "observed": {
                    "running": true,
                    "services": [{ "name": "cpki-app-api-test", "phase": "Running", "ready": true }]
                }
            },
            "auth": { "running": true },
            "nextAction": null,
            "error": null,
            "diagnostics": []
        })
    }

    // As 4.29.0 printed it, with the agreement version shortened.
    fn setup_blocked(reason: &str) -> String {
        json!({
            "version": 1,
            "command": "local setup",
            "status": "blocked",
            "error": null,
            "nextAction": {
                "reason": reason,
                "summary": "Ask the developer to run `copilotkit local accept-terms`.",
                "instructions": ["Ask the developer to run `copilotkit local accept-terms`."],
                "resumeCommand": null,
                "url": null
            },
            "diagnostics": []
        })
        .to_string()
    }

    fn status(input: &Value) -> Result<Report, Failure> {
        normalize(Action::Status, 0, input.to_string().as_bytes())
    }

    /// A stack on `installed`, as `local status` reports it.
    fn on_release(installed: &str) -> Report {
        let mut input = envelope();
        input["stack"]["installedRelease"] = json!(installed);
        status(&input).unwrap()
    }

    /// The 0.16.0-rc.9 CLI (copilotkit 4.34.0-pre.48a3863), as its bundle names the release its
    /// `local setup` and `local update` install.
    const PINNED_CLI: &str = r#"async function resolveDefaultLocalRelease(directory2, dependencies = {}) {   const pinnedVersion = false ? "" : "0.16.0-rc.9";   const support = supportSchema.parse("#;

    #[test]
    fn telemetry_link_accepts_only_the_closed_account_handshake() {
        let account = "a".repeat(64);
        for kind in ["account", "linked"] {
            let response = serde_json::json!({ "type": kind, "account_id": account });
            assert!(normalize_telemetry_identity(0, response.to_string().as_bytes()).is_ok());
            assert!(normalize_telemetry_identity(1, response.to_string().as_bytes()).is_err());
            for field in [
                "email",
                "name",
                "prompt",
                "response",
                "recording",
                "filename",
                "url",
            ] {
                let mut extra = response.clone();
                extra[field] = serde_json::json!("synthetic private content");
                assert!(normalize_telemetry_identity(0, extra.to_string().as_bytes()).is_err());
            }
        }
        assert_eq!(
            normalize_telemetry_identity(0, br#"{"type":"skipped"}"#),
            Ok(TelemetryIdentity::Skipped)
        );
        assert!(normalize_telemetry_identity(
            0,
            br#"{"type":"account","account_id":"private@example.com"}"#
        )
        .is_err());
        assert!(normalize_telemetry_identity(0, b"not json").is_err());
    }

    #[test]
    fn the_release_a_cli_installs_is_read_out_of_the_cli_itself() {
        assert_eq!(
            crate::cli_release::pinned_release_in(PINNED_CLI).as_deref(),
            Some("0.16.0-rc.9")
        );
        // A CLI built without a pin takes Helm's newest stable release: no version to compare.
        assert_eq!(
            crate::cli_release::pinned_release_in("const pinnedVersion = true ? \"\" : \"\";"),
            None
        );
        assert_eq!(crate::cli_release::pinned_release_in("nothing here"), None);
        // Nothing that is not a plain version comes out of it.
        assert_eq!(
            crate::cli_release::pinned_release_in(
                "const pinnedVersion = false ? \"\" : \"0.16.0; rm -rf\";"
            ),
            None
        );
    }

    /// The Trajectory refusal: a stack an older app set up on rc.8 is updated to the rc.9 this
    /// app's CLI installs, and a stack already on it, or past it, is left alone.
    #[test]
    fn a_stack_older_than_the_release_the_cli_installs_is_updated_and_no_other() {
        let target = Some("0.16.0-rc.9");
        assert_eq!(
            update_due(&on_release("0.16.0-rc.8"), target).as_deref(),
            Some("0.16.0-rc.9")
        );
        assert_eq!(
            update_due(&on_release("0.16.0-rc.5"), target).as_deref(),
            Some("0.16.0-rc.9")
        );
        assert_eq!(
            update_due(&on_release("0.15.1"), target).as_deref(),
            Some("0.16.0-rc.9")
        );
        for current in ["0.16.0-rc.9", "v0.16.0-rc.9", "0.16.0-rc.10", "0.16.0"] {
            assert_eq!(update_due(&on_release(current), target), None, "{current}");
        }
        // Not known: a CLI with no pinned release, or a version that does not read.
        assert_eq!(update_due(&on_release("0.16.0-rc.8"), None), None);
        assert_eq!(update_due(&on_release("latest"), target), None);
        // An update that did not finish is due again, to the release on record, as the CLI 48a3863
        // reports it, whatever release this app's CLI would choose now: `local update` resumes it.
        let mut resuming = envelope();
        resuming["stack"]["installedRelease"] = json!("0.16.0-rc.5");
        resuming["stack"]["failedStep"] = json!("image-download");
        resuming["stack"]["update"] = json!({
            "attemptedRelease": "0.16.0-rc.9",
            "state": "prepared",
            "observedSchema": null,
            "recoveryCommand": "copilotkit local update --stack local-abc123"
        });
        let resuming = status(&resuming).unwrap();
        for target in [Some("0.16.0-rc.9"), Some("0.16.0-rc.10")] {
            assert_eq!(
                update_due(&resuming, target).as_deref(),
                Some("0.16.0-rc.9")
            );
        }
        // A record that does not name its release is left alone.
        let mut unnamed = envelope();
        unnamed["stack"]["installedRelease"] = json!("0.16.0-rc.8");
        unnamed["stack"]["update"] = json!({ "state": "migrated" });
        assert_eq!(update_due(&status(&unnamed).unwrap(), target), None);
        // A report that is not a completed status says nothing about the stack's release.
        let mut blocked = on_release("0.16.0-rc.8");
        blocked.outcome = Outcome::Blocked;
        assert_eq!(update_due(&blocked, target), None);
    }

    /// `local update --stack <id> --json`, fixed like every other call, and read like them: its
    /// completed report, including the CLI's answer that the stack already runs that release.
    #[test]
    fn update_runs_as_a_fixed_call_and_reports_like_the_others() {
        let stack = StackId::parse("local-abc123").unwrap();
        assert_eq!(
            arguments(Action::Update, &stack),
            ["local", "update", "--stack", "local-abc123", "--json"]
        );
        let mut updated = envelope();
        updated["command"] = json!("local update");
        updated["stack"]["installedRelease"] = json!("0.16.0-rc.9");
        let report = normalize(Action::Update, 0, updated.to_string().as_bytes()).unwrap();
        assert_eq!(report.outcome, Outcome::Completed);
        assert_eq!(report.stack.unwrap().installed_release, "0.16.0-rc.9");
        // `status` is not `update`: an answer for another command is refused.
        assert_eq!(
            normalize(Action::Update, 0, envelope().to_string().as_bytes()),
            Err(Failure::UnexpectedCommand)
        );
        assert_eq!(
            Limits::for_action(Action::Update).timeout,
            Duration::from_secs(60 * 60)
        );
    }

    fn exposes_secret(report: &Report) -> bool {
        serde_json::to_string(report).unwrap().contains(SECRET)
    }

    #[test]
    fn a_completed_command_with_ready_pods_is_not_licensed_readiness() {
        let report = status(&envelope()).unwrap();
        assert_eq!(report.outcome, Outcome::Completed);
        assert_eq!(report.readiness, Readiness::Unknown);
        assert_eq!(report.licence, Licence::Unknown);
        let stack = report.stack.unwrap();
        assert_eq!(stack.id, "local-abc123");
        assert!(stack.observed.unwrap().services[0].ready);
    }

    #[test]
    fn stopped_unready_and_interrupted_stacks_are_kept_as_observed() {
        for running in [false, true] {
            let mut input = envelope();
            input["stack"]["observed"] = json!({
                "running": running,
                "services": [{ "name": "cpki-app-api-test", "phase": "Running", "ready": false }]
            });
            input["stack"]["failedStep"] = json!("services-start");
            input["stack"]["update"] = json!({ "state": "migrated", "recoveryCommand": SECRET });
            let report = status(&input).unwrap();
            let stack = report.stack.clone().unwrap();
            assert!(stack.has_failed_step);
            assert!(stack.update_in_progress);
            let observed = stack.observed.unwrap();
            assert_eq!(observed.running, running);
            assert!(!observed.services[0].ready);
            assert_eq!(report.readiness, Readiness::Unknown);
            assert!(!exposes_secret(&report));
        }
    }

    #[test]
    fn empty_or_missing_observations_never_imply_readiness() {
        let mut input = envelope();
        input["stack"]["observed"] = json!({ "running": true, "services": [] });
        assert_eq!(status(&input).unwrap().readiness, Readiness::Unknown);
        input["stack"].as_object_mut().unwrap().remove("observed");
        assert_eq!(status(&input).unwrap().stack.unwrap().observed, None);
    }

    #[test]
    fn blocked_and_failed_keep_only_the_reason() {
        for (code, outcome, reason, expected) in [
            (
                2,
                "blocked",
                "authentication_required",
                Reason::AuthenticationRequired,
            ),
            (
                1,
                "failed",
                "local_command_failed",
                Reason::LocalCommandFailed,
            ),
        ] {
            let input = json!({
                "version": 1,
                "command": "local status",
                "status": outcome,
                "error": { "message": SECRET },
                "nextAction": {
                    "reason": reason,
                    "summary": SECRET,
                    "instructions": [SECRET],
                    "resumeCommand": format!("echo {SECRET}")
                }
            });
            let report = normalize(Action::Status, code, input.to_string().as_bytes()).unwrap();
            assert_eq!(report.reason, Some(expected));
            assert_eq!(report.stack, None);
            assert!(!exposes_secret(&report));
        }
    }

    #[test]
    fn unknown_fields_and_unsupported_licence_claims_are_discarded() {
        let mut input = envelope();
        input["credentials"] = json!(SECRET);
        input["stack"]["apiKey"] = json!(SECRET);
        input["stack"]["licence"] = json!({ "valid": true });
        input["stack"]["readiness"] = json!("ready");
        input["readiness"] = json!("ready");
        let report = status(&input).unwrap();
        assert_eq!(report.licence, Licence::Unknown);
        assert_eq!(report.readiness, Readiness::Unknown);
        assert!(!exposes_secret(&report));
    }

    // The additive v1 fields the CLI publishes on `local status`, with synthetic organization data.
    fn canonical(readiness: &str, licence: &str, expires_at: Value) -> Value {
        let mut input = envelope();
        input["readiness"] = json!({
            "state": readiness,
            "checkedAt": "2026-10-21T18:04:05.123Z",
            "checks": ["api", SECRET]
        });
        input["license"] = json!({
            "state": licence,
            "expiresAt": expires_at,
            "organizationId": SECRET,
            "organizationName": SECRET,
            "renewal": "none"
        });
        input
    }

    /// Start's wait for the back end, from the CLI's own status answers: each new answer said with
    /// what is not ready and the addresses the CLI checks, a repeat not said again, a failed call
    /// said as one, and the wait ended once the back end is ready with a valid licence.
    #[test]
    fn the_back_end_wait_says_each_status_and_ends_when_ready() {
        let start = std::time::Instant::now();
        let at = |seconds: u64| start + std::time::Duration::from_secs(seconds);
        let mut starting = canonical("starting", "valid", json!(null));
        starting["stack"]["observed"]["services"] = json!([
            { "name": "cpki-app-api", "phase": "Running", "ready": true },
            { "name": "cpki-gateway", "phase": "Pending", "ready": false }
        ]);
        let starting = status(&starting).unwrap();
        let mut wait = None;

        let first = status_waited(&mut wait, at(0), &Ok(starting.clone()));
        assert_eq!(first.len(), 1, "{first:#?}");
        assert!(first[0].starts_with(
            "[wait] the backend, `local status` until it is ready with a valid licence: readiness starting, licence valid"
        ), "{first:#?}");
        assert!(
            first[0].contains("services 1 of 2 ready (not ready: cpki-gateway Pending)"),
            "{first:#?}"
        );
        assert!(
            first[0].contains(
                "API http://localhost:8082, gateway ws://[::1]:4401, dashboard http://intelligence.localhost:8080"
            ),
            "{first:#?}"
        );
        assert!(!first[0].contains(SECRET), "{first:#?}");
        assert!(status_waited(&mut wait, at(15), &Ok(starting.clone())).is_empty());
        let failed = status_waited(&mut wait, at(30), &Err(Failure::Timeout));
        assert!(
            failed[0].contains("the status call failed: Timeout"),
            "{failed:#?}"
        );

        // What the window gives up with, and the last answer it had.
        let gave_up = wait.as_ref().unwrap().ended(
            at(40),
            "gave up: OpenBot didn't get ready in time. Retry to check again.",
        );
        assert!(gave_up.contains("after 40.0s and 3 checks"), "{gave_up}");
        assert!(gave_up.ends_with("last answer: the status call failed: Timeout"));

        let ready = status(&canonical("ready", "valid", json!(null))).unwrap();
        let ended = status_waited(&mut wait, at(45), &Ok(ready));
        assert!(
            ended
                .last()
                .unwrap()
                .contains(": ready after 45.0s and 4 checks"),
            "{ended:#?}"
        );
        assert!(wait.is_none());

        // A wait nobody ended is not carried on by the next one.
        status_waited(&mut wait, at(400), &Ok(starting.clone()));
        let next = status_waited(&mut wait, at(400 + 121), &Ok(starting));
        assert!(next[0].contains("(0.0s in, check 1)"), "{next:#?}");
    }

    #[test]
    fn each_readiness_state_is_read() {
        for (wire, expected) in [
            ("ready", Readiness::Ready),
            ("starting", Readiness::Starting),
            ("stopped", Readiness::Stopped),
            ("degraded", Readiness::Degraded),
            ("unknown", Readiness::Unknown),
        ] {
            let report = status(&canonical(wire, "valid", Value::Null)).unwrap();
            assert_eq!(report.readiness, expected, "{wire}");
            assert!(!exposes_secret(&report));
        }
    }

    #[test]
    fn each_licence_state_is_read() {
        for (wire, expected) in [
            ("valid", Licence::Valid),
            ("expired", Licence::Expired),
            ("missing", Licence::Missing),
            ("invalid", Licence::Invalid),
            ("organization_mismatch", Licence::OrganizationMismatch),
        ] {
            let report = status(&canonical("ready", wire, Value::Null)).unwrap();
            assert_eq!(report.licence, expected, "{wire}");
            assert_eq!(report.licence_expires_at, None);
            assert!(!exposes_secret(&report));
        }
    }

    #[test]
    fn a_licence_expiring_in_four_days_keeps_only_its_instant() {
        let report = status(&canonical(
            "ready",
            "valid",
            json!("2026-10-25T18:04:05.000Z"),
        ))
        .unwrap();
        assert_eq!(report.readiness, Readiness::Ready);
        assert_eq!(report.licence, Licence::Valid);
        assert_eq!(
            report.licence_expires_at.as_deref(),
            Some("2026-10-25T18:04:05.000Z")
        );
        // Organization, renewal and check names are not kept.
        let serialized = serde_json::to_value(&report).unwrap();
        assert_eq!(serialized["readiness"], "ready");
        assert_eq!(serialized["licence"], "valid");
        assert_eq!(serialized["licenceExpiresAt"], "2026-10-25T18:04:05.000Z");
        assert!(!exposes_secret(&report));
    }

    #[test]
    fn ready_pods_with_an_api_that_is_not_ready_are_not_ready() {
        // Every observed service is ready; the CLI's own end-to-end check is what says it is not.
        let report = status(&canonical("starting", "valid", Value::Null)).unwrap();
        assert!(report.stack.unwrap().observed.unwrap().services[0].ready);
        assert_eq!(report.readiness, Readiness::Starting);
    }

    #[test]
    fn unknown_canonical_values_are_unknown() {
        let report = status(&canonical("green", "revoked", Value::Null)).unwrap();
        assert_eq!(report.readiness, Readiness::Unknown);
        assert_eq!(report.licence, Licence::Unknown);
        // Wire spellings only: the window's own spelling is not a CLI value.
        let report = status(&canonical("Ready", "organization-mismatch", Value::Null)).unwrap();
        assert_eq!(report.readiness, Readiness::Unknown);
        assert_eq!(report.licence, Licence::Unknown);
    }

    #[test]
    fn malformed_readiness_is_unknown_and_never_fails_the_report() {
        let good = canonical("ready", "valid", Value::Null);
        for broken in [
            json!(null),
            json!("ready"),
            json!(["ready"]),
            json!({ "checkedAt": "2026-10-21T18:04:05Z" }),
            json!({ "state": true, "checkedAt": "2026-10-21T18:04:05Z" }),
            json!({ "state": "ready" }),
            json!({ "state": "ready", "checkedAt": null }),
            json!({ "state": "ready", "checkedAt": "yesterday" }),
        ] {
            let mut input = good.clone();
            input["readiness"] = broken.clone();
            let report = status(&input).unwrap();
            assert_eq!(report.readiness, Readiness::Unknown, "{broken}");
            assert_eq!(report.licence, Licence::Valid, "{broken}");
        }
        let mut input = good;
        input.as_object_mut().unwrap().remove("readiness");
        assert_eq!(status(&input).unwrap().readiness, Readiness::Unknown);
    }

    #[test]
    fn malformed_licence_is_unknown_with_no_expiry() {
        let good = canonical("ready", "valid", json!("2026-10-25T18:04:05Z"));
        let mut cases = vec![
            json!(null),
            json!("valid"),
            json!({ "expiresAt": null }),
            json!({ "state": 1, "expiresAt": null }),
            // `expiresAt` is ISO-8601 or null, and present.
            json!({ "state": "valid" }),
            json!({ "state": "valid", "expiresAt": 1792000000 }),
        ];
        for expires in [
            SECRET,
            "2026-10-25",
            "2026-10-25 18:04:05Z",
            "2026-10-25t18:04:05z",
            "2026-13-25T18:04:05Z",
            "2026-02-30T18:04:05Z",
            "2026-10-25T24:00:00Z",
            "2026-10-25T18:60:05Z",
            "2026-10-25T18:04:05",
            "2026-10-25T18:04:05.Z",
            "2026-10-25T18:04:05.1234567890Z",
            "2026-10-25T18:04:05+2400",
            "+02026-10-25T18:04:05Z",
            " 2026-10-25T18:04:05Z",
        ] {
            cases.push(json!({ "state": "valid", "expiresAt": expires }));
        }
        for broken in cases {
            let mut input = good.clone();
            input["license"] = broken.clone();
            let report = status(&input).unwrap();
            assert_eq!(report.licence, Licence::Unknown, "{broken}");
            assert_eq!(report.licence_expires_at, None, "{broken}");
            assert_eq!(report.readiness, Readiness::Ready, "{broken}");
            assert!(!exposes_secret(&report));
        }
        let mut input = good;
        input.as_object_mut().unwrap().remove("license");
        assert_eq!(status(&input).unwrap().licence, Licence::Unknown);
    }

    #[test]
    fn strict_instants_with_offsets_and_fractions_are_kept() {
        for instant in [
            "2026-10-25T18:04:05Z",
            "2026-10-25T18:04:05.1Z",
            "2026-10-25T18:04:05.123456789Z",
            "2026-10-25T18:04:05+02:00",
            "2026-10-25T18:04:05.5-07:30",
            "2028-02-29T00:00:00Z",
        ] {
            let report = status(&canonical("ready", "valid", json!(instant))).unwrap();
            assert_eq!(report.licence_expires_at.as_deref(), Some(instant));
        }
        // Not a leap year.
        let report = status(&canonical("ready", "valid", json!("2026-02-29T00:00:00Z"))).unwrap();
        assert_eq!(report.licence, Licence::Unknown);
    }

    #[test]
    fn readiness_and_licence_are_read_only_from_a_completed_report() {
        let mut input = canonical("ready", "valid", Value::Null);
        input["status"] = json!("blocked");
        input["nextAction"] = json!({ "reason": "docker_unavailable" });
        let report = normalize(Action::Status, 2, input.to_string().as_bytes()).unwrap();
        assert_eq!(report.readiness, Readiness::Unknown);
        assert_eq!(report.licence, Licence::Unknown);
    }

    #[test]
    fn unsupported_versions_wrong_commands_and_missing_stacks_are_refused() {
        let mut input = envelope();
        input["version"] = json!(2);
        assert_eq!(status(&input), Err(Failure::UnsupportedVersion));
        let mut input = envelope();
        input["command"] = json!("local delete");
        assert_eq!(status(&input), Err(Failure::UnexpectedCommand));
        assert_eq!(
            normalize(Action::Start, 0, envelope().to_string().as_bytes()),
            Err(Failure::UnexpectedCommand)
        );
        let mut input = envelope();
        input.as_object_mut().unwrap().remove("stack");
        assert_eq!(status(&input), Err(Failure::MissingStack));
    }

    #[test]
    fn malformed_and_oversized_output_fail_without_its_contents() {
        assert_eq!(
            normalize(Action::Status, 0, SECRET.as_bytes()),
            Err(Failure::InvalidJson)
        );
        assert_eq!(
            normalize(Action::Status, 0, &[0xff, 0xfe]),
            Err(Failure::InvalidJson)
        );
        assert_eq!(
            normalize(Action::Status, 0, " ".repeat(MAX_OUTPUT + 1).as_bytes()),
            Err(Failure::OutputLimit)
        );
        let mut input = envelope();
        input["status"] = json!("ready");
        assert_eq!(status(&input), Err(Failure::InvalidStatus));
        let mut input = envelope();
        input["stack"] = json!({ "id": "local-test" });
        assert_eq!(status(&input), Err(Failure::InvalidStatus));
        // Failures are static categories, so nothing from the input can be in one.
        assert_eq!(
            serde_json::to_string(&Failure::InvalidJson).unwrap(),
            "\"invalid-json\""
        );
    }

    #[test]
    fn unsafe_api_endpoints_are_refused() {
        for url in [
            "http://example.com:8082",
            "http://localhost.evil.test:8082",
            "http://user:synthetic-secret-marker@localhost:8082",
            "http://localhost:8082?key=synthetic-secret-marker",
            "http://localhost:8082/#secret",
            "http://localhost:8082/api",
            "file:///tmp/sock",
            "https://localhost:8082",
            "http://intelligence.localhost:8082",
            "http://LOCALHOST:8082",
            "http://localhost",
            "http://localhost:0",
            "http://localhost:65536",
            "http://localhost:+80",
            "http://127.1:8082",
            "http://127.0.0.01:8082",
            "http://127.0.0.256:8082",
            "http://[::2]:8082",
        ] {
            let mut input = envelope();
            input["stack"]["urls"]["api"] = json!(url);
            assert_eq!(status(&input), Err(Failure::UnsafeEndpoint), "{url}");
        }
    }

    #[test]
    fn explicit_loopback_hosts_and_the_cli_dashboard_host_are_accepted() {
        for host in ["localhost", "127.0.0.1", "127.255.0.9", "[::1]"] {
            let mut input = envelope();
            input["stack"]["urls"]["api"] = json!(format!("http://{host}:8082"));
            input["stack"]["urls"]["gateway"] = json!(format!("ws://{host}:4401/"));
            let urls = status(&input).unwrap().stack.unwrap().urls;
            assert_eq!(urls.api, format!("http://{host}:8082"));
        }
        let urls = status(&envelope()).unwrap().stack.unwrap().urls;
        assert_eq!(urls.dashboard, "http://intelligence.localhost:8080");

        let mut input = envelope();
        input["stack"]["urls"]["gateway"] = json!("http://localhost:4401");
        assert_eq!(status(&input), Err(Failure::UnsafeEndpoint));
        for dashboard in [
            "http://a.b.localhost:8080",
            "http://-a.localhost:8080",
            "http://.localhost:8080",
        ] {
            let mut input = envelope();
            input["stack"]["urls"]["dashboard"] = json!(dashboard);
            assert_eq!(status(&input), Err(Failure::UnsafeEndpoint), "{dashboard}");
        }
    }

    #[test]
    fn malformed_observations_are_refused_rather_than_partly_believed() {
        let mut input = envelope();
        input["stack"]["observed"] = json!({ "running": "true", "services": [] });
        assert_eq!(status(&input), Err(Failure::InvalidStatus));
        input["stack"]["observed"] = json!({
            "running": true,
            "services": [{ "name": "pod", "phase": "Running", "ready": "true" }]
        });
        assert_eq!(status(&input), Err(Failure::InvalidStatus));
    }

    #[test]
    fn arguments_are_fixed() {
        let stack = StackId::parse("local-abc123").unwrap();
        for (action, name) in [
            (Action::Status, "status"),
            (Action::Start, "start"),
            (Action::Stop, "stop"),
        ] {
            assert_eq!(
                arguments(action, &stack),
                ["local", name, "--stack", "local-abc123", "--json"]
            );
        }
        // An action outside the allowlist cannot arrive from the window either.
        assert!(serde_json::from_value::<Action>(json!("delete")).is_err());
    }

    #[test]
    fn setup_defers_the_model_and_never_accepts_the_agreement() {
        assert_eq!(
            SETUP_ARGUMENTS,
            ["local", "setup", "--defer-model", "--json"]
        );
        assert!(!SETUP_ARGUMENTS
            .iter()
            .any(|argument| argument.contains("eula") || argument.contains("accept")));
    }

    #[test]
    fn setup_runs_in_the_installation_folder() {
        let fixture = Fixture::new(
            "local-eval-setup",
            &format!("2\n{}", setup_blocked("eula_acceptance_required")),
        );
        let installation = fixture.root.join("installation");
        std::fs::create_dir_all(&installation).unwrap();
        let report = setup(
            &fixture.cli(),
            &installation,
            None,
            Limits::for_setup(),
            &Cancel::default(),
        )
        .unwrap();
        assert_eq!(report.outcome, Outcome::Blocked);
        assert_eq!(report.reason, Some(Reason::EulaAcceptanceRequired));
        // `--app-path`: the installation folder exactly, never a folder above it with its own stack.
        assert_eq!(
            fixture.argv().unwrap(),
            format!(
                "local\nsetup\n--defer-model\n--json\n--app-path\n{}",
                installation.display()
            )
        );
        assert_eq!(fixture.cwd(), installation.canonicalize().unwrap());
    }

    /// The ending `execute_watching` logged on this thread, taken.
    fn last_ending() -> Option<String> {
        LAST_ENDING.with(|last| last.borrow_mut().take())
    }

    /// A first setup on Windows stopped after `runtime-inspect` and the log said nothing: the CLI
    /// exited 1 with its own failed report, and none of it was kept. The log now says how it ended,
    /// what its report says and the end of its stderr.
    #[test]
    fn a_setup_that_fails_logs_its_exit_its_report_and_its_stderr() {
        let failed = json!({
            "version": 1,
            "command": "local setup",
            "status": "failed",
            "error": {
                "code": "LOCAL_COMMAND_FAILED",
                "message": "The local command did not finish."
            },
            "nextAction": { "reason": "local_command_failed", "resumeCommand": null },
            "diagnostics": []
        });
        let fixture = Fixture::new("local-eval-setup-failed-logged", &format!("1\n{failed}"));
        std::fs::write(
            fixture.root.join("stderr"),
            "Error: This demo requires CLI-managed k3d inside Docker. The node does not match \
             the saved installation.\n",
        )
        .unwrap();
        let installation = fixture.root.join("installation");
        std::fs::create_dir_all(&installation).unwrap();
        last_ending();
        let report = setup(
            &fixture.cli(),
            &installation,
            None,
            Limits::for_setup(),
            &Cancel::default(),
        )
        .unwrap();
        assert_eq!(report.outcome, Outcome::Failed);
        assert_eq!(report.reason, Some(Reason::LocalCommandFailed));
        let entry = last_ending().expect("the setup's ending was logged");
        assert!(entry.starts_with("[local setup] failed after "), "{entry}");
        for said in [
            "exit 1",
            "\"LOCAL_COMMAND_FAILED\"",
            "\"local_command_failed\"",
            "The local command did not finish.",
            "stderr ends: Error: This demo requires CLI-managed k3d inside Docker.",
            "The node does not match the saved installation.",
        ] {
            assert!(entry.contains(said), "{said:?} is not in {entry}");
        }
    }

    /// A setup OpenBot stopped says so, and a finished one says how long it took.
    #[test]
    fn a_setup_logs_that_openbot_stopped_it_or_that_it_finished() {
        let fixture = Fixture::new("local-eval-setup-stopped-logged", "sleep");
        let installation = fixture.root.join("installation");
        std::fs::create_dir_all(&installation).unwrap();
        let cancel = Cancel::default();
        cancel.cancel();
        last_ending();
        let stopped = setup(
            &fixture.cli(),
            &installation,
            None,
            Limits::for_setup(),
            &cancel,
        );
        assert_eq!(stopped.unwrap_err(), Failure::Cancelled);
        let entry = last_ending().expect("the stopped setup's ending was logged");
        assert!(
            entry.starts_with("[local setup] failed after ")
                && entry.ends_with("Cancelled, stopped by OpenBot"),
            "{entry}"
        );

        let mut done = envelope();
        done["command"] = json!("local setup");
        std::fs::write(fixture.root.join("scenario"), format!("0\n{done}")).unwrap();
        setup(
            &fixture.cli(),
            &installation,
            None,
            Limits::for_setup(),
            &Cancel::default(),
        )
        .unwrap();
        let entry = last_ending().expect("the finished setup's ending was logged");
        assert!(entry.starts_with("[local setup] finished in "), "{entry}");
    }

    /// `status` is polled and the account calls print sign-in codes: their endings are not logged.
    #[test]
    fn a_status_call_logs_nothing() {
        let fixture = Fixture::new(
            "local-eval-status-not-logged",
            &format!("1\n{}", envelope()),
        );
        last_ending();
        let _ = fixture.run(
            Action::Status,
            Limits::for_action(Action::Status),
            &Cancel::default(),
        );
        assert_eq!(last_ending(), None);
    }

    /// The Learning agent's model goes to `local setup` on the stack the installation already has:
    /// the file OpenBot wrote, or `--defer-model` to take a model away. Nothing else is passed.
    #[test]
    fn the_learning_model_is_given_by_running_setup_again_with_its_file() {
        let mut done = envelope();
        done["command"] = json!("local setup");
        let fixture = Fixture::new("local-eval-learning-model", &format!("0\n{done}"));
        let installation = fixture.root.join("installation");
        std::fs::create_dir_all(&installation).unwrap();
        let file = installation.join(".openbot-learning").join("model.json");
        let report = configure_learning_model(
            &fixture.cli(),
            &installation,
            Some(&file),
            Limits::for_learning_model(),
            &Cancel::default(),
        )
        .unwrap();
        assert_eq!(report.outcome, Outcome::Completed);
        assert_eq!(
            fixture.argv().unwrap(),
            format!(
                "local\nsetup\n--model-config\n{}\n--json\n--app-path\n{}",
                file.display(),
                installation.display()
            )
        );
        assert_eq!(fixture.cwd(), installation.canonicalize().unwrap());

        configure_learning_model(
            &fixture.cli(),
            &installation,
            None,
            Limits::for_learning_model(),
            &Cancel::default(),
        )
        .unwrap();
        assert_eq!(
            fixture.argv().unwrap(),
            format!(
                "local\nsetup\n--defer-model\n--json\n--app-path\n{}",
                installation.display()
            )
        );

        for refused in [Path::new("model.json"), Path::new("-x/model.json")] {
            assert_eq!(
                configure_learning_model(
                    &fixture.cli(),
                    &installation,
                    Some(refused),
                    Limits::for_learning_model(),
                    &Cancel::default(),
                ),
                Err(Failure::Spawn)
            );
        }
    }

    // As `local connect` prints it at Intelligence 780313e4: no key, only the stack it connected.
    fn connected(status: &str, conflicts: Value, next: Value) -> String {
        let mut input = envelope();
        input["command"] = json!("local connect");
        input["status"] = json!(status);
        input["conflicts"] = conflicts;
        input["nextAction"] = next;
        input.as_object_mut().unwrap().remove("auth");
        input.to_string()
    }

    #[test]
    fn connect_approves_only_the_documented_connection() {
        assert_eq!(
            CONNECT_ARGUMENTS,
            ["local", "connect", "--approve-connection", "--json"]
        );
        assert!(!CONNECT_ARGUMENTS
            .iter()
            .any(|argument| argument.contains("eula") || argument.contains("terms")));
    }

    #[test]
    fn connect_runs_in_the_installation_folder() {
        let fixture = Fixture::new(
            "local-eval-connect",
            &format!("0\n{}", connected("completed", json!([]), Value::Null)),
        );
        let installation = fixture.root.join("installation");
        std::fs::create_dir_all(&installation).unwrap();
        let connection = connect(
            &fixture.cli(),
            &installation,
            Limits::for_action(Action::Status),
            &Cancel::default(),
        )
        .unwrap();
        assert_eq!(connection.outcome, Outcome::Completed);
        assert!(!connection.conflicted);
        assert_eq!(connection.stack.unwrap().id, "local-abc123");
        assert_eq!(
            fixture.argv().unwrap(),
            format!(
                "local\nconnect\n--approve-connection\n--json\n--app-path\n{}",
                installation.display()
            )
        );
        assert_eq!(fixture.cwd(), installation.canonicalize().unwrap());
    }

    #[test]
    fn connect_answers_keep_only_their_reason_and_whether_settings_conflicted() {
        let confirmation = normalize_connect(
            2,
            connected(
                "blocked",
                Value::Null,
                json!({
                    "reason": "confirmation_required",
                    "summary": SECRET,
                    "instructions": [SECRET],
                    "resumeCommand": "copilotkit local connect --approve-connection"
                }),
            )
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(confirmation.outcome, Outcome::Blocked);
        assert_eq!(confirmation.reason, Some(Reason::ConfirmationRequired));
        assert!(!confirmation.conflicted);

        let conflict = normalize_connect(
            2,
            connected(
                "blocked",
                json!(["CPK_INTELLIGENCE_API_KEY", SECRET]),
                Value::Null,
            )
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(conflict.outcome, Outcome::Blocked);
        assert_eq!(conflict.reason, None);
        assert!(conflict.conflicted);

        let failed = normalize_connect(
            1,
            json!({
                "version": 1,
                "command": "local connect",
                "status": "failed",
                "error": { "code": "LOCAL_COMMAND_FAILED", "message": SECRET },
                "nextAction": { "reason": "local_command_failed", "resumeCommand": SECRET }
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(failed.reason, Some(Reason::LocalCommandFailed));
        assert_eq!(failed.stack, None);

        for answer in [confirmation, conflict, failed] {
            assert!(!serde_json::to_string(&answer).unwrap().contains(SECRET));
        }
    }

    #[test]
    fn a_connect_report_is_held_to_the_same_rules() {
        // A completed connection names the stack it connected.
        let mut input: Value =
            serde_json::from_str(&connected("completed", json!([]), Value::Null)).unwrap();
        input.as_object_mut().unwrap().remove("stack");
        assert_eq!(
            normalize_connect(0, input.to_string().as_bytes()),
            Err(Failure::MissingStack)
        );
        // Conflicts are a list of setting names, or absent.
        assert_eq!(
            normalize_connect(
                2,
                connected("blocked", json!(SECRET), Value::Null).as_bytes()
            ),
            Err(Failure::InvalidStatus)
        );
        // Another command's report, or a completion that exits as blocked, is not a connection.
        assert_eq!(
            normalize_connect(0, envelope().to_string().as_bytes()),
            Err(Failure::UnexpectedCommand)
        );
        assert_eq!(
            normalize_connect(2, connected("completed", json!([]), Value::Null).as_bytes()),
            Err(Failure::ContractMismatch)
        );
        assert_eq!(
            normalize_connect(0, connected("completed", json!([]), Value::Null).as_bytes())
                .unwrap()
                .stack
                .unwrap()
                .urls
                .api,
            "http://localhost:8082"
        );
    }

    #[test]
    fn connect_waits_its_turn_and_is_refused_once_cancelled() {
        let installation = temp_root("local-eval-connect-installed");
        std::fs::create_dir_all(&installation).unwrap();
        assert_eq!(
            connect_installed("connect-no-cli", &installation),
            Err(Failure::Unavailable)
        );
        cancel("connect-cancelled");
        assert_eq!(
            connect_installed("connect-cancelled", &installation),
            Err(Failure::Cancelled)
        );
        std::fs::remove_dir_all(installation).unwrap();
    }

    // As `local login --json` prints it at Intelligence 780313e4 (`local-login.ts`), with the
    // bearer-free fields it really has: no handoff link is ever in it.
    fn logged_in(status: &str, next: Value) -> String {
        let mut input = json!({
            "version": 1,
            "command": "local login",
            "status": status,
            "error": null,
            "nextAction": next,
            "diagnostics": []
        });
        if status == "completed" {
            input["browserOpened"] = json!(true);
            input["stackId"] = json!("local-abc123");
        }
        input.to_string()
    }

    fn login_blocked(reason: &str) -> Value {
        json!({
            "reason": reason,
            "summary": format!("Open http://cpk.localhost:8080/login {SECRET}"),
            "instructions": ["http://cpk.localhost:8080/login", "copilotkit local auth pending --stack local-abc123"],
            "resumeCommand": "copilotkit local login --stack local-abc123",
            "url": "http://cpk.localhost:8080/login",
            "linkLabel": "Open dashboard"
        })
    }

    #[test]
    fn login_arguments_are_fixed() {
        let stack = StackId::parse("local-abc123").unwrap();
        assert_eq!(
            login_arguments(&stack),
            ["local", "login", "--stack", "local-abc123", "--json"]
        );
    }

    #[test]
    fn login_runs_the_fixed_arguments_and_keeps_only_that_it_opened() {
        let fixture = Fixture::new(
            "local-eval-login",
            &format!("0\n{}", logged_in("completed", Value::Null)),
        );
        let stack = StackId::parse("local-abc123").unwrap();
        let signed = login(
            &fixture.cli(),
            &stack,
            Limits::for_action(Action::Status),
            &Cancel::default(),
        )
        .unwrap();
        assert_eq!(
            signed,
            SignIn {
                outcome: Outcome::Completed,
                reason: None
            }
        );
        assert_eq!(
            fixture.argv().unwrap(),
            "local\nlogin\n--stack\nlocal-abc123\n--json"
        );
    }

    #[test]
    fn login_answers_keep_only_their_reason() {
        let stack = StackId::parse("local-abc123").unwrap();
        for (wire, reason) in [
            ("dashboard_unavailable", Reason::DashboardUnavailable),
            ("browser_open_failed", Reason::BrowserOpenFailed),
            ("local_command_busy", Reason::LocalCommandBusy),
            ("docker_unavailable", Reason::DockerUnavailable),
            ("something_new", Reason::Unrecognized),
        ] {
            let signed = normalize_login(
                &stack,
                2,
                logged_in("blocked", login_blocked(wire)).as_bytes(),
            )
            .unwrap();
            assert_eq!(
                signed,
                SignIn {
                    outcome: Outcome::Blocked,
                    reason: Some(reason)
                }
            );
            let said = serde_json::to_string(&signed).unwrap();
            for leaked in [SECRET, "cpk.localhost", "auth pending", "copilotkit"] {
                assert!(!said.contains(leaked), "{said} carried {leaked}");
            }
        }
        let failed = normalize_login(
            &stack,
            1,
            logged_in("failed", login_blocked("local_command_failed")).as_bytes(),
        )
        .unwrap();
        assert_eq!(failed.outcome, Outcome::Failed);
        assert_eq!(failed.reason, Some(Reason::LocalCommandFailed));
    }

    #[test]
    fn a_login_report_is_held_to_the_same_rules() {
        let stack = StackId::parse("local-abc123").unwrap();
        // Opened only when the CLI says it opened the browser, for this stack.
        let mut unopened: Value =
            serde_json::from_str(&logged_in("completed", Value::Null)).unwrap();
        unopened["browserOpened"] = json!(false);
        let mut other: Value = serde_json::from_str(&logged_in("completed", Value::Null)).unwrap();
        other["stackId"] = json!("local-other");
        let mut missing: Value =
            serde_json::from_str(&logged_in("completed", Value::Null)).unwrap();
        missing.as_object_mut().unwrap().remove("browserOpened");
        for input in [unopened, other, missing] {
            assert_eq!(
                normalize_login(&stack, 0, input.to_string().as_bytes()),
                Err(Failure::InvalidStatus)
            );
        }
        // Another command's report, a status the exit code contradicts, and the CLI's text output.
        assert_eq!(
            normalize_login(&stack, 0, envelope().to_string().as_bytes()),
            Err(Failure::UnexpectedCommand)
        );
        assert_eq!(
            normalize_login(
                &stack,
                0,
                logged_in("blocked", login_blocked("x")).as_bytes()
            ),
            Err(Failure::ContractMismatch)
        );
        assert_eq!(
            normalize_login(
                &stack,
                0,
                b"Opened local sign-in in your browser. No code approval is needed; if the dashboard shows Sign In, choose it.\n"
            ),
            Err(Failure::InvalidJson)
        );
        assert_eq!(
            normalize_login(&stack, 9, b""),
            Err(Failure::UnexpectedExit)
        );
    }

    #[test]
    fn login_waits_its_turn_and_is_refused_once_cancelled() {
        let stack = StackId::parse("local-abc123").unwrap();
        assert_eq!(
            login_installed("login-no-cli", &stack),
            Err(Failure::Unavailable)
        );
        cancel("login-cancelled");
        assert_eq!(
            login_installed("login-cancelled", &stack),
            Err(Failure::Cancelled)
        );
    }

    #[test]
    fn a_pinned_cli_is_known_by_the_digest_of_what_it_runs() {
        let fixture = Fixture::new("local-eval-cli-digest", "0\n");
        assert_eq!(fixture.cli().sha256(), sha256(&fixture.program));
        let entry = fixture.root.join("index.js");
        std::fs::write(&entry, "// pinned entry").unwrap();
        let entry_pin = Pin {
            path: entry.clone(),
            sha256: sha256(&entry),
        };
        let cli = PinnedCli::verify(&fixture.pin(), Some(&entry_pin)).unwrap();
        // A runtime runs many scripts; the script is what identifies the CLI.
        assert_eq!(cli.sha256(), sha256(&entry));
    }

    #[test]
    fn setup_waits_its_turn_and_is_refused_once_cancelled() {
        let installation = temp_root("local-eval-setup-installed");
        std::fs::create_dir_all(&installation).unwrap();
        assert_eq!(
            setup_installed("setup-no-cli", &installation, None).map(|(report, _)| report),
            Err(SetupStopped::Failure(Failure::Unavailable))
        );
        cancel("setup-cancelled");
        assert_eq!(
            setup_installed("setup-cancelled", &installation, None).map(|(report, _)| report),
            Err(SetupStopped::Failure(Failure::Cancelled))
        );
        std::fs::remove_dir_all(installation).unwrap();
    }

    #[test]
    fn a_setup_report_is_held_to_the_same_rules() {
        let blocked =
            normalize_setup(2, setup_blocked("eula_acceptance_required").as_bytes()).unwrap();
        assert_eq!(blocked.reason, Some(Reason::EulaAcceptanceRequired));
        assert!(!serde_json::to_string(&blocked)
            .unwrap()
            .contains("accept-terms"));
        // Another command's report is not a setup report.
        assert_eq!(
            normalize_setup(0, envelope().to_string().as_bytes()),
            Err(Failure::UnexpectedCommand)
        );
    }

    #[test]
    fn invalid_stack_ids_are_refused_in_arguments_and_reports() {
        let long = "a".repeat(129);
        for id in [
            "",
            "--json",
            "a b",
            "a/b",
            "a\nb",
            "a;id",
            "a$(id)",
            "_a",
            long.as_str(),
        ] {
            assert_eq!(StackId::parse(id), Err(Failure::InvalidStack), "{id:?}");
            let mut input = envelope();
            input["stack"]["id"] = json!(id);
            assert_eq!(status(&input), Err(Failure::InvalidStack), "{id:?}");
        }
        assert!(StackId::parse(&"a".repeat(128)).is_ok());
    }

    #[test]
    fn start_stop_and_busy_envelopes_are_understood() {
        for action in [Action::Start, Action::Stop] {
            let mut input = envelope();
            input["command"] = json!(format!("local {}", action.as_str()));
            input["stack"].as_object_mut().unwrap().remove("observed");
            let report = normalize(action, 0, input.to_string().as_bytes()).unwrap();
            assert_eq!(report.stack.unwrap().observed, None);

            let busy = json!({
                "version": 1,
                "command": format!("local {}", action.as_str()),
                "status": "blocked",
                "error": null,
                "nextAction": {
                    "reason": "local_command_busy",
                    "resumeCommand": format!("copilotkit local {} --stack local-abc123 --json", action.as_str())
                },
                "diagnostics": []
            });
            let report = normalize(action, 2, busy.to_string().as_bytes()).unwrap();
            assert_eq!(report.reason, Some(Reason::LocalCommandBusy));
        }
        let unknown = json!({
            "version": 1, "command": "local start", "status": "blocked",
            "nextAction": { "reason": "something_new" }
        });
        let report = normalize(Action::Start, 2, unknown.to_string().as_bytes()).unwrap();
        assert_eq!(report.reason, Some(Reason::Unrecognized));
    }

    #[test]
    fn exit_codes_and_statuses_must_agree() {
        let completed = envelope().to_string();
        assert_eq!(
            normalize(Action::Status, 2, completed.as_bytes()),
            Err(Failure::ContractMismatch)
        );
        let blocked = json!({ "version": 1, "command": "local status", "status": "blocked" });
        assert_eq!(
            normalize(Action::Status, 0, blocked.to_string().as_bytes()),
            Err(Failure::ContractMismatch)
        );
        for code in [3, 75, 127, -1] {
            assert_eq!(
                normalize(Action::Status, code, completed.as_bytes()),
                Err(Failure::UnexpectedExit),
                "{code}"
            );
        }
    }

    #[test]
    fn this_build_has_no_cli_to_run() {
        assert!(matches!(installed(), Err(Failure::Unavailable)));
        let stack = StackId::parse("local-abc123").unwrap();
        assert_eq!(
            run_installed("no-cli-attempt", Action::Status, &stack),
            Err(Failure::Unavailable)
        );
        // The attempt is gone however the call ended.
        assert!(!in_flight().iter().any(|(id, _)| id == "no-cli-attempt"));
    }

    #[test]
    fn a_debug_build_runs_only_the_cli_a_developer_pinned() {
        // Sets process environment, which other tests read.
        if crate::test_support::isolated_process(
            "local_eval::tests::a_debug_build_runs_only_the_cli_a_developer_pinned",
        ) {
            return;
        }
        let fixture = Fixture::new("local-eval-developer-pin", &format!("0\n{}", envelope()));
        let stack = StackId::parse("local-abc123").unwrap();
        // A path alone is not a pin, and neither is a digest of something else.
        std::env::set_var(DEVELOPER_PROGRAM, &fixture.program);
        assert!(matches!(installed(), Err(Failure::Unverified)));
        std::env::set_var(DEVELOPER_PROGRAM_SHA256, "0".repeat(64));
        assert!(matches!(installed(), Err(Failure::Unverified)));
        assert_eq!(fixture.argv(), None, "an unverified CLI ran");

        std::env::set_var(DEVELOPER_PROGRAM_SHA256, sha256(&fixture.program));
        let report = run_installed("developer-pin", Action::Status, &stack).unwrap();
        assert_eq!(report.outcome, Outcome::Completed);
        assert_eq!(
            fixture.argv().unwrap(),
            "local\nstatus\n--stack\nlocal-abc123\n--json"
        );

        let entry = fixture.root.join("index.js");
        std::fs::write(&entry, "// pinned entry").unwrap();
        std::env::set_var(DEVELOPER_ENTRY, &entry);
        assert!(matches!(installed(), Err(Failure::Unverified)));
        std::env::set_var(DEVELOPER_ENTRY_SHA256, sha256(&entry));
        run_installed("developer-pin-entry", Action::Status, &stack).unwrap();
        assert_eq!(
            fixture.argv().unwrap(),
            format!(
                "{}\nlocal\nstatus\n--stack\nlocal-abc123\n--json",
                entry.display()
            )
        );
    }

    #[test]
    fn a_cancel_that_arrives_first_is_kept_for_its_call() {
        cancel("early-attempt");
        let attempt = Attempt::register("early-attempt");
        assert!(attempt.0.requested());
        drop(attempt);
        assert!(!in_flight().iter().any(|(id, _)| id == "early-attempt"));
    }

    #[test]
    fn cancelling_one_attempt_leaves_the_others_running() {
        let start = Attempt::register("start-attempt");
        let status = Attempt::register("status-attempt");
        cancel("status-attempt");
        assert!(status.0.requested());
        assert!(!start.0.requested());
    }

    /// Take the turn every call through `one_at_a_time` waits for, as a running call would.
    fn hold_turn() -> std::sync::MutexGuard<'static, ()> {
        CALLS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[test]
    fn quitting_allows_a_stop_two_minutes() {
        let quit = Limits::for_quit();
        assert_eq!(quit.timeout, Duration::from_secs(120));
        assert_eq!(quit.grace, Limits::for_action(Action::Stop).grace);
        assert_eq!(quit.output, MAX_OUTPUT);
        let stack = StackId::parse("local-abc123").unwrap();
        assert_eq!(
            run_installed_with("quit-no-cli", Action::Stop, &stack, quit),
            Err(Failure::Unavailable)
        );
    }

    #[test]
    fn required_cli_work_preempts_background_attribution() {
        if crate::test_support::isolated_process(
            "local_eval::tests::required_cli_work_preempts_background_attribution",
        ) {
            return;
        }
        let (entered, waiting) = std::sync::mpsc::channel();
        let background = std::thread::spawn(move || {
            background_telemetry_call(|cancel, _| {
                entered.send(()).unwrap();
                let deadline = Instant::now() + Duration::from_secs(2);
                while !cancel.requested() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Ok(cancel.requested())
            })
        });
        waiting.recv_timeout(Duration::from_secs(3)).unwrap();
        let started = Instant::now();
        assert_eq!(
            one_at_a_time(
                &Cancel::default(),
                Limits::for_action(Action::Status),
                |_| Ok(())
            ),
            Ok(())
        );
        let cancelled = background.join().unwrap().unwrap();
        assert!(
            cancelled,
            "required account checks waited for optional telemetry"
        );
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn calls_run_one_at_a_time() {
        let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let most = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls: Vec<_> = (0..4)
            .map(|_| {
                let (active, most) = (active.clone(), most.clone());
                std::thread::spawn(move || {
                    one_at_a_time(
                        &Cancel::default(),
                        Limits::for_action(Action::Status),
                        |_| {
                            let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                            most.fetch_max(now, Ordering::SeqCst);
                            std::thread::sleep(Duration::from_millis(50));
                            active.fetch_sub(1, Ordering::SeqCst);
                            Ok(())
                        },
                    )
                })
            })
            .collect();
        for call in calls {
            assert_eq!(call.join().unwrap(), Ok(()));
        }
        assert_eq!(most.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_call_cancelled_while_waiting_for_its_turn_never_runs() {
        let turn = hold_turn();
        let cancel = Cancel::default();
        let ran = Arc::new(AtomicBool::new(false));
        let waiting = {
            let (cancel, ran) = (cancel.clone(), ran.clone());
            std::thread::spawn(move || {
                one_at_a_time(&cancel, Limits::for_action(Action::Stop), |_| {
                    ran.store(true, Ordering::SeqCst);
                    Ok(())
                })
            })
        };
        std::thread::sleep(Duration::from_millis(100));
        cancel.cancel();
        // Released only after the cancel, so a call that missed it would run and fail the test
        // rather than hang it.
        std::thread::sleep(Duration::from_millis(100));
        drop(turn);
        assert_eq!(waiting.join().unwrap(), Err(Failure::Cancelled));
        assert!(!ran.load(Ordering::SeqCst));
    }

    #[test]
    fn a_call_that_waits_past_its_deadline_never_runs() {
        let turn = hold_turn();
        let ran = AtomicBool::new(false);
        let result = one_at_a_time(
            &Cancel::default(),
            short(Duration::from_millis(100)),
            |_| {
                ran.store(true, Ordering::SeqCst);
                Ok(())
            },
        );
        drop(turn);
        assert_eq!(result, Err(Failure::Timeout));
        assert!(!ran.load(Ordering::SeqCst));
    }

    #[test]
    fn waiting_for_a_turn_counts_against_the_deadline() {
        let turn = hold_turn();
        let (asking, asked) = std::sync::mpsc::channel();
        let waiting = std::thread::spawn(move || {
            asking.send(()).unwrap();
            one_at_a_time(
                &Cancel::default(),
                short(Duration::from_secs(10)),
                |limits| Ok(limits.timeout),
            )
        });
        asked.recv().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        drop(turn);
        let left = waiting.join().unwrap().unwrap();
        assert!(left <= Duration::from_millis(9_900), "{left:?}");
    }

    #[test]
    fn a_cancelled_attempt_does_not_run_the_cli() {
        let fixture = Fixture::new("local-eval-precancelled", &format!("0\n{}", envelope()));
        let cancelled = Cancel::default();
        cancelled.cancel();
        let result = one_at_a_time(&cancelled, short(Duration::from_secs(30)), |limits| {
            fixture.run(Action::Status, limits, &cancelled)
        });
        assert_eq!(result, Err(Failure::Cancelled));
        assert_eq!(fixture.argv(), None, "the fake CLI ran");
        // Through the public entry point, the cancel is seen before looking for a CLI at all.
        let stack = StackId::parse("local-abc123").unwrap();
        cancel("precancelled-attempt");
        assert_eq!(
            run_installed("precancelled-attempt", Action::Start, &stack),
            Err(Failure::Cancelled)
        );
    }

    #[test]
    fn calls_are_refused_while_a_stop_is_closing_and_allowed_after() {
        // Closing is process-wide, and would refuse other tests' calls.
        if crate::test_support::isolated_process(
            "local_eval::tests::calls_are_refused_while_a_stop_is_closing_and_allowed_after",
        ) {
            return;
        }
        let stack = StackId::parse("local-abc123").unwrap();
        let running = Attempt::register("running-before-stop");
        let closing = closing_for_stop();
        assert!(running.0.requested(), "a call already running is cancelled");
        assert_eq!(
            run_installed("start-during-stop", Action::Start, &stack),
            Err(Failure::Cancelled)
        );
        assert_eq!(list_installed("list-during-stop"), Err(Failure::Cancelled));
        // The shutdown's own stop is the one call allowed through; this build then has no CLI.
        assert_eq!(
            stop_for_shutdown("the-shutdown", &stack, Limits::for_quit()),
            Err(Failure::Unavailable)
        );
        let second = closing_for_stop();
        drop(closing);
        assert_eq!(
            run_installed("status-during-second-stop", Action::Status, &stack),
            Err(Failure::Cancelled),
            "one Stop finishing does not reopen for another still running"
        );
        drop(second);
        assert_eq!(
            run_installed("status-after-stop", Action::Status, &stack),
            Err(Failure::Unavailable)
        );
    }

    #[test]
    fn quitting_closes_for_good_and_cancels_a_stop_in_progress() {
        if crate::test_support::isolated_process(
            "local_eval::tests::quitting_closes_for_good_and_cancels_a_stop_in_progress",
        ) {
            return;
        }
        let stack = StackId::parse("local-abc123").unwrap();
        let stopping = closing_for_stop();
        let stops = Attempt::register_for_shutdown("stop-in-progress");
        close_for_quit();
        assert!(
            stops.0.requested(),
            "Quit does not wait behind Stop's own stop"
        );
        drop(stopping);
        drop(closing_for_stop());
        assert_eq!(
            run_installed("status-after-quit", Action::Status, &stack),
            Err(Failure::Cancelled)
        );
        assert_eq!(
            stop_for_shutdown("quit-shutdown", &stack, Limits::for_quit()),
            Err(Failure::Unavailable)
        );
    }

    #[test]
    #[cfg(unix)]
    fn quitting_waits_until_a_cli_that_ignores_sigterm_is_gone() {
        // Quit used to only ask: the app could exit before the CLI's SIGKILL, and the CLI then ran
        // on with nobody to stop it, holding its stack's lock.
        if crate::test_support::isolated_process(
            "local_eval::tests::quitting_waits_until_a_cli_that_ignores_sigterm_is_gone",
        ) {
            return;
        }
        let fixture = Fixture::new("local-eval-quit-stubborn", "stubborn");
        let cli = fixture.cli();
        let attempt = Attempt::register("stubborn-call");
        let cancel = attempt.0.clone();
        let call = std::thread::spawn(move || {
            run(
                &cli,
                Action::Status,
                &StackId::parse("local-abc123").unwrap(),
                Limits {
                    timeout: Duration::from_secs(60),
                    grace: Duration::from_secs(1),
                    output: MAX_OUTPUT,
                },
                &cancel,
            )
        });
        Fixture::wait_for_grandchild(&fixture.root);
        let pid: libc::pid_t = std::fs::read_to_string(fixture.root.join("pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let alive = |pid: libc::pid_t| unsafe { libc::kill(pid, 0) } == 0;
        assert!(alive(pid));

        close_for_quit();

        // Gone when Quit goes on, not some time after.
        assert!(!alive(pid), "the CLI outlived close_for_quit");
        let grandchild = fixture.grandchild();
        let until = Instant::now() + Duration::from_secs(2);
        while alive(grandchild) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !alive(grandchild),
            "the CLI's child outlived close_for_quit"
        );
        assert_eq!(call.join().unwrap(), Err(Failure::Cancelled));
        drop(attempt);
    }

    /**
    A back end like the one an interrupted `local update` leaves, with stand-ins for the programs
    the CLI and the repair run, all keeping their state in files:

    - `helm`, in the CLI's tool folder under its digest, as `cli_helm` finds it. `upgrade` with
      `stopped.yaml` deletes the Learning Deployments and without it puts them back, as the chart
      does; any upgrade of a release left `pending-upgrade` fails as Helm does; `rollback` deploys.
    - `docker`, whose `exec <node> kubectl` answers `get deployment` and refuses to `scale` a
      Deployment that is not there, with the NotFound the real one prints.
    - the CLI, whose `local update` runs the update's steps in the CLI's order, against those two,
      logging each to `cli.log` as the CLI does, and failing where the CLI fails.

    Unix only: the stand-ins are shell scripts.
    */
    #[cfg(unix)]
    struct UpdateWorld {
        root: PathBuf,
        state: PathBuf,
        stack_dir: PathBuf,
        cli: PinnedCli,
    }

    #[cfg(unix)]
    impl UpdateWorld {
        const STACK: &'static str = "local-abc123";

        /// Sets this process's HOME and PATH: run only in an isolated test process.
        fn new(label: &str) -> Self {
            use std::os::unix::fs::PermissionsExt;
            let root = temp_root(label);
            let home = root.join("home");
            let bin = root.join("bin");
            let state = root.join("state");
            for dir in [&home, &bin, &state] {
                std::fs::create_dir_all(dir).unwrap();
            }
            std::env::set_var("HOME", &home);
            std::env::set_var("XDG_CONFIG_HOME", home.join(".config"));
            std::env::set_var(
                "PATH",
                std::env::join_paths(
                    std::iter::once(bin.clone())
                        .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
                )
                .unwrap(),
            );
            use_engine(&crate::engine::Address::new(
                crate::engine::Engine::Docker,
                None,
            ));
            let stack_dir = crate::local_update::stack_dir(Self::STACK).unwrap();
            std::fs::create_dir_all(&stack_dir).unwrap();
            for file in [
                "kubeconfig",
                "values.yaml",
                "values-local-evaluation.yaml",
                "intelligence-0.16.0-rc.10.tgz",
                "stopped.yaml",
            ] {
                std::fs::write(stack_dir.join(file), file).unwrap();
            }
            // What the CLI records for the update it runs. The licence is not read.
            std::fs::write(
                stack_dir.join("install.json"),
                json!({
                    "licenseToken": SECRET,
                    "chart": stack_dir.join("intelligence-0.16.0-rc.10.tgz"),
                    "profile": stack_dir.join("values-local-evaluation.yaml"),
                    "directory": stack_dir,
                })
                .to_string(),
            )
            .unwrap();
            let (os, arch) = crate::local_update::platform();
            let download = b"helm-archive";
            let tools = stack_dir.parent().unwrap().join("tools").join(format!(
                "helm-3.17.3-{os}-{arch}-{}",
                Sha256::digest(download)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            ));
            std::fs::create_dir_all(&tools).unwrap();
            std::fs::write(tools.join("download"), download).unwrap();
            let s = state.display();
            let script = |path: &Path, body: String| {
                std::fs::write(path, format!("#!/bin/sh\nS='{s}'\n{body}")).unwrap();
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
            };
            script(
                &tools.join("helm"),
                r#"echo "helm $*" >> "$S/calls"
case "$1" in
  list)
    printf '[{"name":"cpki","namespace":"default","revision":"5","status":"%s","chart":"intelligence-0.16.0-rc.10"}]\n' "$(cat "$S/status")" ;;
  history)
    printf '[{"revision":3,"status":"superseded"},{"revision":4,"status":"deployed"},{"revision":5,"status":"%s"}]\n' "$(cat "$S/status")" ;;
  rollback)
    echo deployed > "$S/status" ;;
  upgrade)
    case "$(cat "$S/status")" in
      pending-*) echo "Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress" >&2; exit 1 ;;
    esac
    case "$*" in
      *stopped.yaml*) echo cpki-app-api > "$S/deployments" ;;
      *) printf 'cpki-app-api\ncpki-learning-reconciler\ncpki-learning-agent\n' > "$S/deployments" ;;
    esac
    echo deployed > "$S/status" ;;
  *) exit 1 ;;
esac
"#
                .to_owned(),
            );
            script(
                &bin.join("docker"),
                r#"echo "docker $*" >> "$S/calls"
[ "$1" = exec ] || exit 1
shift
[ "$1" = -i ] && shift
shift
[ "$1" = kubectl ] || exit 1
shift
case "$1 $2" in
  "get node")
    cat "$S/unschedulable" 2>/dev/null || printf false
    exit 0 ;;
  "uncordon "*)
    printf false > "$S/unschedulable"
    echo "node/$2 uncordoned"
    exit 0 ;;
  "get jobs")
    echo '{"items":[]}'
    exit 0 ;;
esac
case "$1" in
  get)
    for name in cpki-learning-reconciler cpki-learning-agent; do
      grep -qx "$name" "$S/deployments" && echo "deployment.apps/$name"
    done
    exit 0 ;;
  scale)
    for argument in "$@"; do
      case "$argument" in
        deployment/*)
          name="${argument#deployment/}"
          grep -qx "$name" "$S/deployments" || { echo "Error from server (NotFound): deployments.apps \"$name\" not found" >&2; exit 1; } ;;
      esac
    done
    exit 0 ;;
esac
exit 1
"#
                .to_owned(),
            );
            let completed = {
                let mut updated = envelope();
                updated["command"] = json!("local update");
                updated["stack"]["installedRelease"] = json!("0.16.0-rc.10");
                updated.to_string()
            };
            let helm = tools.join("helm");
            let chart = stack_dir.join("intelligence-0.16.0-rc.10.tgz");
            let stopped = stack_dir.join("stopped.yaml");
            let node = format!("k3d-{}-server-0", Self::STACK);
            let program = root.join("copilotkit");
            script(
                &program,
                format!(
                    r#"echo "cli $*" >> "$S/calls"
[ "$2" = update ] || exit 3
mkdir -p "$HOME/.copilotkit"
step() {{ printf '{{"level":30,"event":"local.step","step":"%s","outcome":"succeeded"}}\n' "$1" >> "$HOME/.copilotkit/cli.log"; }}
fail() {{
  printf '{{"level":50,"event":"local.step","step":"%s","outcome":"failed"}}\n' "$1" >> "$HOME/.copilotkit/cli.log"
  printf '{{"version":1,"command":"local update","status":"failed","stack":null,"nextAction":null,"error":{{"code":"LOCAL_COMMAND_FAILED","message":"Local %s failed (exit 1)."}},"diagnostics":[]}}' "$1"
  exit 1
}}
[ -e "$S/cordon-on-start" ] && printf true > "$S/unschedulable"
step secrets-apply
sleep "$(cat "$S/quiesce-seconds" 2>/dev/null || echo 0)"
docker exec -i {node} kubectl scale deployment/cpki-app-api deployment/cpki-learning-reconciler --replicas=0 || fail update-quiesce
step update-quiesce
docker exec -i {node} kubectl scale deployment/cpki-learning-agent --replicas=0 || fail update-agent-stop
step update-agent-stop
step update-agent-wait
'{helm}' upgrade --install cpki '{chart}' -f '{stopped}' --no-hooks || fail dependencies-install
step dependencies-install
sleep "$(cat "$S/wait-seconds" 2>/dev/null || echo 0)"
# The databases' rollout: nothing schedules on a cordoned node. The real wait is ten minutes.
tries=0
while [ "$(cat "$S/unschedulable" 2>/dev/null)" = true ]; do
  tries=$((tries + 1))
  [ "$tries" -gt 100 ] && fail dependencies-wait
  sleep 0.2
done
step dependencies-wait
'{helm}' upgrade cpki '{chart}' --no-hooks || fail services-start
step services-start
touch "$S/finished"
printf '%s' '{completed}'
"#,
                    helm = helm.display(),
                    chart = chart.display(),
                    stopped = stopped.display(),
                ),
            );
            let cli = PinnedCli::verify(
                &Pin {
                    path: program.clone(),
                    sha256: sha256(&program),
                },
                None,
            )
            .unwrap();
            let world = Self {
                root,
                state,
                stack_dir,
                cli,
            };
            world.set("status", "deployed");
            world.set(
                "deployments",
                "cpki-app-api\ncpki-learning-reconciler\ncpki-learning-agent\n",
            );
            world
        }

        fn set(&self, name: &str, value: &str) {
            std::fs::write(self.state.join(name), value).unwrap();
        }

        fn calls(&self) -> Vec<String> {
            std::fs::read_to_string(self.state.join("calls"))
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        }

        fn finished(&self) -> bool {
            self.state.join("finished").exists()
        }

        /// `local update` as the window runs it, through `run_with`.
        fn update(&self, attempt: &str, cancel: &Cancel) -> Result<Report, Failure> {
            let limits = short(Duration::from_secs(120));
            run_with(
                &self.cli,
                attempt,
                Action::Update,
                &StackId::parse(Self::STACK).unwrap(),
                (limits, limits),
                cancel,
                crate::local_images::Limits::standard(),
            )
        }

        fn cli_log_has(&self, step: &str) -> bool {
            std::fs::read_to_string(crate::local_update::cli_log().unwrap())
                .unwrap_or_default()
                .contains(&format!("\"step\":\"{step}\",\"outcome\":\"succeeded\""))
        }
    }

    #[cfg(unix)]
    impl Drop for UpdateWorld {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /**
    AN UPDATE QUIT STOPPED PARTWAY IS REPAIRED, AND THE NEXT ONE FINISHES.

    Found on OpenBot Desktop, 0.16.0-rc.9 to rc.10: Quit stopped `local update` after its first
    `helm upgrade`, which had deleted the Learning Deployments. Every Start after that failed in
    under a second with "Local update-quiesce failed (exit 1)", the CLI scaling a Deployment that
    was gone. Here the update fails exactly so, the repair applies the update's chart without hooks,
    which puts them back, and the one retry runs to the end.
    */
    #[test]
    #[cfg(unix)]
    fn an_update_stopped_partway_is_repaired_and_the_retry_finishes() {
        if crate::test_support::isolated_process(
            "local_eval::tests::an_update_stopped_partway_is_repaired_and_the_retry_finishes",
        ) {
            return;
        }
        let world = UpdateWorld::new("update-repaired");
        // As the stopped update left it: its stopped.yaml upgrade done, Learning deleted.
        world.set("deployments", "cpki-app-api\n");

        let report = world.update("repaired-update", &Cancel::default()).unwrap();

        assert_eq!(report.outcome, Outcome::Completed, "{:?}", world.calls());
        assert!(world.finished());
        let calls = world.calls();
        let updates = calls
            .iter()
            .filter(|call| call.starts_with("cli local update"))
            .count();
        assert_eq!(updates, 2, "one failed update, one retry: {calls:?}");
        let repair = calls
            .iter()
            .find(|call| call.starts_with("helm upgrade cpki ") && call.contains("--no-hooks"))
            .unwrap_or_else(|| panic!("no repair upgrade: {calls:?}"));
        let chart = world.stack_dir.join("intelligence-0.16.0-rc.10.tgz");
        assert!(
            repair.contains(&chart.canonicalize().unwrap().display().to_string()),
            "the update's own chart: {repair}"
        );
        assert!(repair.contains("values.yaml") && !repair.contains("stopped.yaml"));
        assert!(repair.contains(&format!(
            "--kubeconfig {}",
            world.stack_dir.join("kubeconfig").display()
        )));
        assert!(
            !calls.iter().any(|call| call.starts_with("helm rollback")),
            "a deployed release is not rolled back: {calls:?}"
        );
    }

    /**
    A RELEASE QUIT LEFT `pending-upgrade` IS ROLLED BACK, AND THE NEXT UPDATE FINISHES.

    Quit that stops Helm itself leaves the release pending, and every later `helm upgrade` refuses
    with "another operation (install/upgrade/rollback) is in progress". The repair rolls it back
    to its last deployed revision, and the one retry runs to the end.
    */
    #[test]
    #[cfg(unix)]
    fn a_release_left_pending_is_rolled_back_and_the_retry_finishes() {
        if crate::test_support::isolated_process(
            "local_eval::tests::a_release_left_pending_is_rolled_back_and_the_retry_finishes",
        ) {
            return;
        }
        let world = UpdateWorld::new("update-pending");
        world.set("status", "pending-upgrade");

        let report = world.update("pending-update", &Cancel::default()).unwrap();

        assert_eq!(report.outcome, Outcome::Completed, "{:?}", world.calls());
        assert!(world.finished());
        let calls = world.calls();
        let rollback = calls
            .iter()
            .position(|call| call.starts_with("helm rollback cpki 4 --no-hooks"))
            .unwrap_or_else(|| panic!("not rolled back to the deployed revision: {calls:?}"));
        let retry = calls
            .iter()
            .rposition(|call| call.starts_with("cli local update"))
            .unwrap();
        assert!(rollback < retry, "rolled back before the retry: {calls:?}");
        assert_eq!(
            calls
                .iter()
                .filter(|call| call.starts_with("cli local update"))
                .count(),
            2
        );
    }

    /**
    A NODE LEFT CORDONED IS UNCORDONED, SO THE UPDATE'S DATABASES CAN START.

    Found on a Mac: the update hung for minutes in `dependencies-wait`, the database, Redis and
    object storage pods in `FailedScheduling: 0/1 nodes are available: 1 node(s) were
    unschedulable`. k3s marks its node unschedulable as `local stop` stops it, and the CLI starts
    the node again inside `local update`. Here the node comes up cordoned once the update has
    started, as it did there, and the update's watch uncordons it while the CLI waits.
    */
    #[test]
    #[cfg(unix)]
    fn a_node_left_cordoned_is_uncordoned_while_the_update_waits_on_it() {
        if crate::test_support::isolated_process(
            "local_eval::tests::a_node_left_cordoned_is_uncordoned_while_the_update_waits_on_it",
        ) {
            return;
        }
        let world = UpdateWorld::new("update-cordoned");
        world.set("unschedulable", "true");
        world.set("cordon-on-start", "");

        let report = world.update("cordoned-update", &Cancel::default()).unwrap();

        assert_eq!(report.outcome, Outcome::Completed, "{:?}", world.calls());
        let calls = world.calls();
        let started = calls
            .iter()
            .position(|call| call.starts_with("cli local update"))
            .unwrap();
        let uncordons: Vec<usize> = calls
            .iter()
            .enumerate()
            .filter(|(_, call)| call.contains("kubectl uncordon k3d-local-abc123-server-0"))
            .map(|(index, _)| index)
            .collect();
        assert!(
            uncordons.first().is_some_and(|first| *first < started),
            "a cordoned node is uncordoned before the update: {calls:?}"
        );
        assert!(
            uncordons.iter().any(|index| *index > started),
            "and again while the update waits on it: {calls:?}"
        );
        assert_eq!(
            calls
                .iter()
                .filter(|call| call.starts_with("cli local update"))
                .count(),
            1,
            "no retry was needed: {calls:?}"
        );
    }

    /**
    QUIT LETS AN UPDATE THAT HAS BEGUN CHANGING THE RELEASE FINISH.

    Quit used to stop `local update` wherever it was: SIGTERM, then SIGKILL five seconds later,
    mid-Helm. That is what left the stacks above. Before its first `helm upgrade` an update is
    still stopped (here by Cancel, which takes the same path); from `update-agent-wait` on, Quit
    waits for it, says so once, and the update runs to its end.
    */
    #[test]
    #[cfg(unix)]
    fn quit_lets_an_update_past_its_first_helm_step_finish() {
        if crate::test_support::isolated_process(
            "local_eval::tests::quit_lets_an_update_past_its_first_helm_step_finish",
        ) {
            return;
        }
        let world = UpdateWorld::new("update-quit");
        let wait_for = |what: &str, done: &dyn Fn() -> bool| {
            let until = Instant::now() + Duration::from_secs(30);
            while !done() {
                assert!(Instant::now() < until, "never saw {what}");
                std::thread::sleep(Duration::from_millis(20));
            }
        };

        // Before Helm: stopped.
        world.set("quiesce-seconds", "30");
        let early = Attempt::register("update-before-helm");
        let started = Instant::now();
        let stopped = std::thread::scope(|scope| {
            let call = scope.spawn(|| world.update("update-before-helm", &early.0));
            wait_for("secrets-apply", &|| world.cli_log_has("secrets-apply"));
            assert!(!update_finishing());
            cancel("update-before-helm");
            call.join().unwrap()
        });
        assert_eq!(stopped, Err(Failure::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(20));
        assert!(!world.finished());
        drop(early);

        // Past its first Helm step: Quit waits for it.
        world.set("quiesce-seconds", "0");
        world.set("wait-seconds", "3");
        let attempt = Attempt::register("update-during-quit");
        let (finished, said, waited) = std::thread::scope(|scope| {
            let call = scope.spawn(|| world.update("update-during-quit", &attempt.0));
            wait_for("the update past update-agent-wait", &|| update_finishing());
            assert!(!world.finished(), "still running when Quit comes");
            let mut said = 0;
            let waited = close_for_quit_reporting(|| said += 1);
            (call.join().unwrap(), said, waited)
        });
        assert!(waited, "Quit waited for the update");
        assert_eq!(said, 1, "and said so once");
        assert!(world.finished(), "the update ran to its end");
        assert_eq!(finished.unwrap().outcome, Outcome::Completed);
        assert!(!update_finishing());
        drop(attempt);
    }

    #[test]
    fn remembered_cancels_are_bounded() {
        // Evicting the oldest remembered cancel would race with tests that rely on one.
        if crate::test_support::isolated_process(
            "local_eval::tests::remembered_cancels_are_bounded",
        ) {
            return;
        }
        for index in 0..(REMEMBERED * 2) {
            cancel(&format!("never-runs-{index}"));
        }
        assert!(in_flight().len() <= REMEMBERED + 8);
    }

    #[test]
    fn identifiers_cannot_carry_prose_and_observations_are_bounded() {
        for step in ["services start", "a\nb", "ready;", &"a".repeat(129)] {
            let mut input = envelope();
            input["stack"]["step"] = json!(step);
            assert_eq!(status(&input), Err(Failure::InvalidStatus), "{step:?}");
        }
        let mut input = envelope();
        input["stack"]["observed"]["services"][0]["phase"] = json!("Error: token=abc");
        assert_eq!(status(&input), Err(Failure::InvalidStatus));
        let service = json!({ "name": "pod", "phase": "Running", "ready": true });
        input = envelope();
        input["stack"]["observed"]["services"] = json!(vec![service; MAX_SERVICES + 1]);
        assert_eq!(status(&input), Err(Failure::InvalidStatus));
        input = envelope();
        input["stack"]["installedRelease"] = json!("0.15.0-rc.1+build.7");
        assert!(status(&input).is_ok());
    }

    /// The CLI's environment, from an environment of `pairs` and OpenBot's Docker configuration
    /// in `owned`.
    #[cfg(unix)]
    fn cli_environment(
        pairs: &[(&str, &Path)],
        owned: &Path,
    ) -> std::collections::BTreeMap<String, Option<String>> {
        let cli = PinnedCli {
            program: PathBuf::from("copilotkit"),
            entry: None,
            sha256: String::new(),
        };
        let pairs: std::collections::HashMap<String, std::ffi::OsString> = pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.as_os_str().to_owned()))
            .collect();
        let docker = CliEngine {
            engine: crate::engine::Engine::Docker,
            api: None,
            connection: None,
            rootless: false,
        };
        command_inheriting(
            &cli,
            &["local", "setup", "--json"],
            None,
            Some(&docker),
            |name| pairs.get(name).cloned(),
            Some(owned),
        )
        .get_envs()
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.map(|value| value.to_string_lossy().into_owned()),
            )
        })
        .collect()
    }

    /// Docker Desktop's `~/.docker` on a Mac: its credential helper, which macOS stops to ask about
    /// when OpenBot runs it, and its context.
    #[cfg(unix)]
    fn docker_desktop_home(home: &Path) {
        let docker = home.join(".docker");
        std::fs::create_dir_all(docker.join("contexts/meta/fe9c6bd7")).unwrap();
        std::fs::write(
            docker.join("config.json"),
            r#"{"auths":{"ghcr.io":{}},"credsStore":"desktop","currentContext":"desktop-linux"}"#,
        )
        .unwrap();
    }

    /// The CLI's `helm pull` of the chart, and its `docker run` of the probe image, read Docker's
    /// configuration. Docker Desktop's names `docker-credential-desktop`, which macOS stopped to ask
    /// "OpenBot would like to access data from other apps" and setup timed out behind. The CLI runs
    /// with OpenBot's own configuration instead: no credential store, the person's context.
    #[cfg(unix)]
    #[test]
    fn the_cli_runs_without_the_persons_docker_credential_helper() {
        let root = temp_root("cli-docker-config");
        let home = root.join("home");
        docker_desktop_home(&home);
        let owned = root.join("docker-config");

        let variables = cli_environment(&[("HOME", &home)], &owned);

        assert_eq!(
            variables.get("DOCKER_CONFIG"),
            Some(&Some(owned.to_string_lossy().into_owned()))
        );
        let config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(owned.join("config.json")).unwrap()).unwrap();
        for key in crate::docker_config::CREDENTIAL_KEYS {
            assert!(config.get(key).is_none(), "{key} reached the CLI");
        }
        assert_eq!(config["currentContext"], "desktop-linux");
        assert!(owned.join("contexts/meta/fe9c6bd7").is_dir());
        let _ = std::fs::remove_dir_all(root);
    }

    /// A person who points Docker somewhere themselves: their DOCKER_CONFIG is the configuration
    /// mirrored, and their DOCKER_HOST and DOCKER_CONTEXT reach the CLI untouched.
    #[cfg(unix)]
    #[test]
    fn the_cli_keeps_an_explicit_docker_config_host_and_context() {
        let root = temp_root("cli-docker-config-explicit");
        let home = root.join("home");
        docker_desktop_home(&home);
        let theirs = root.join("theirs");
        std::fs::create_dir_all(theirs.join("contexts")).unwrap();
        std::fs::write(
            theirs.join("config.json"),
            r#"{"credsStore":"osxkeychain","currentContext":"colima"}"#,
        )
        .unwrap();
        let host = Path::new("unix:///Users/a/.colima/default/docker.sock");
        let context = Path::new("colima");
        let owned = root.join("docker-config");

        let variables = cli_environment(
            &[
                ("HOME", &home),
                ("DOCKER_CONFIG", &theirs),
                ("DOCKER_HOST", host),
                ("DOCKER_CONTEXT", context),
            ],
            &owned,
        );

        assert_eq!(
            variables.get("DOCKER_CONFIG"),
            Some(&Some(owned.to_string_lossy().into_owned()))
        );
        assert_eq!(
            variables.get("DOCKER_HOST"),
            Some(&Some(host.to_string_lossy().into_owned()))
        );
        assert_eq!(
            variables.get("DOCKER_CONTEXT"),
            Some(&Some("colima".into()))
        );
        let config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(owned.join("config.json")).unwrap()).unwrap();
        assert_eq!(config, json!({"currentContext": "colima"}));
        assert_eq!(
            std::fs::read_link(owned.join("contexts")).unwrap(),
            theirs.join("contexts")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    fn engine_variables(
        engine: Option<&CliEngine>,
    ) -> std::collections::BTreeMap<String, Option<String>> {
        let cli = PinnedCli {
            program: PathBuf::from("copilotkit"),
            entry: None,
            sha256: String::new(),
        };
        command_for(&cli, &["local", "status", "--json"], None, engine)
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect()
    }

    const ENGINE_VARIABLES: [&str; 5] = [
        "COPILOTKIT_LOCAL_ENGINE",
        "CONTAINER_HOST",
        "CONTAINER_CONNECTION",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
    ];

    #[test]
    fn the_cli_is_told_the_engine_openbot_runs_on() {
        use crate::engine::Engine;
        let docker = CliEngine {
            engine: Engine::Docker,
            api: None,
            connection: None,
            rootless: false,
        };
        let variables = engine_variables(Some(&docker));
        assert_eq!(
            variables.get("COPILOTKIT_LOCAL_ENGINE"),
            Some(&Some("docker".to_string()))
        );
        // Docker is found as Docker's own CLI finds it: nothing is set or taken away for it.
        for name in ["CONTAINER_HOST", "DOCKER_HOST", "DOCKER_CONTEXT"] {
            assert!(!variables.contains_key(name), "{name} in {variables:?}");
        }

        let api = "unix:///var/folders/xy/T/podman/openbot-api.sock";
        let podman = CliEngine {
            engine: Engine::Podman,
            api: Some(api.into()),
            connection: None,
            rootless: false,
        };
        let variables = engine_variables(Some(&podman));
        assert_eq!(
            variables.get("COPILOTKIT_LOCAL_ENGINE"),
            Some(&Some("podman".to_string()))
        );
        assert_eq!(
            variables.get("CONTAINER_HOST"),
            Some(&Some(api.to_string()))
        );
        assert_eq!(variables.get("DOCKER_HOST"), Some(&Some(api.to_string())));
        // An inherited Docker context names a Docker, and is not handed to k3d beside a Podman.
        assert!(
            engine_environment(Some(&podman)).contains(&("DOCKER_CONTEXT", None)),
            "a Podman call must drop DOCKER_CONTEXT"
        );
        assert!(!matches!(variables.get("DOCKER_CONTEXT"), Some(Some(_))));

        // A Podman whose API could not be found is still named, and inherits no Docker address.
        let unfound = CliEngine {
            api: None,
            ..podman
        };
        let variables = engine_variables(Some(&unfound));
        assert_eq!(
            variables.get("COPILOTKIT_LOCAL_ENGINE"),
            Some(&Some("podman".to_string()))
        );
        assert_eq!(
            engine_environment(Some(&unfound))[1..],
            [
                ("CONTAINER_HOST", None),
                ("CONTAINER_CONNECTION", None),
                ("DOCKER_HOST", None),
                ("DOCKER_CONTEXT", None)
            ]
        );
        for name in ["CONTAINER_HOST", "DOCKER_HOST", "DOCKER_CONTEXT"] {
            assert!(
                !matches!(variables.get(name), Some(Some(_))),
                "{name} in {variables:?}"
            );
        }

        // Before the app knows its engine the CLI chooses for itself, as it did before.
        let variables = engine_variables(None);
        for name in ENGINE_VARIABLES {
            assert!(!variables.contains_key(name), "{name} in {variables:?}");
        }
    }

    /// The engine adds names and addresses, never a secret: what the CLI receives is the inherited
    /// allowlist and the engine's own variables, and nothing else.
    #[test]
    fn naming_the_engine_adds_nothing_secret() {
        use crate::engine::Engine;
        for engine in [
            None,
            Some(CliEngine {
                engine: Engine::Docker,
                api: None,
                connection: None,
                rootless: false,
            }),
            Some(CliEngine {
                engine: Engine::Podman,
                api: Some("npipe:////./pipe/podman-openbot".into()),
                connection: None,
                rootless: false,
            }),
        ] {
            for name in engine_variables(engine.as_ref()).keys() {
                assert!(
                    INHERITED.contains(&name.as_str()) || ENGINE_VARIABLES.contains(&name.as_str()),
                    "{name} is neither inherited nor the engine's"
                );
            }
        }
    }

    /// OpenBot on the bare connection of a rootful machine: Intelligence goes to the same machine's
    /// rootful engine. OpenBot on a rootless machine, by either connection: declined.
    #[cfg(not(target_os = "linux"))]
    #[test]
    fn intelligence_runs_on_the_rootful_engine_of_the_machine_openbot_is_on() {
        use crate::acquire::MachineFacts;
        use crate::engine::{Address, Engine};
        let api = "unix:///tmp/podman/openbot-api.sock";
        let machine = |rootful| {
            move |name: &str| {
                assert_eq!(name.strip_suffix("-root").unwrap_or(name), "openbot");
                Ok(MachineFacts {
                    rootful: Some(rootful),
                    api: Some(api.into()),
                })
            }
        };
        for connection in ["openbot", "openbot-root"] {
            let address = Address::new(Engine::Podman, Some(connection.into()));
            assert_eq!(
                CliEngine::of_with(&address, machine(true)),
                CliEngine {
                    engine: Engine::Podman,
                    api: Some(api.into()),
                    connection: None,
                    rootless: false,
                },
                "{connection}"
            );
            assert!(
                CliEngine::of_with(&address, machine(false)).rootless,
                "{connection}"
            );
        }
    }

    /// Windows: a Podman machine's API is a named pipe, which k3d, Docker clients and the CLI's own
    /// requests open, but which the `podman` the CLI runs (`podman run` to measure the machine)
    /// refuses: `"npipe" is not a supported schema`, exit 125, and Intelligence never starts. That
    /// `podman` is given the machine's rootful connection by name, which it prefers to any
    /// `CONTAINER_HOST`, so both read the same engine.
    #[cfg(not(target_os = "linux"))]
    #[test]
    fn the_podman_the_cli_runs_on_windows_is_given_a_connection_it_can_open() {
        use crate::acquire::MachineFacts;
        use crate::engine::{Address, Engine};
        let pipe = "npipe:////./pipe/podman-openbot";
        for connection in ["openbot", "openbot-root"] {
            let address = Address::new(Engine::Podman, Some(connection.into()));
            let engine = CliEngine::of_with(&address, |_| {
                Ok(MachineFacts {
                    rootful: Some(true),
                    api: Some(pipe.into()),
                })
            });
            let variables = engine_variables(Some(&engine));
            assert_eq!(
                variables.get("CONTAINER_HOST"),
                Some(&Some(pipe.to_string())),
                "{connection}"
            );
            assert_eq!(variables.get("DOCKER_HOST"), Some(&Some(pipe.to_string())));
            assert_eq!(
                variables.get("CONTAINER_CONNECTION"),
                Some(&Some("openbot-root".to_string())),
                "{connection}: a named pipe in CONTAINER_HOST needs the connection beside it"
            );
        }

        // A Unix socket (macOS) is an address `podman` opens itself; nothing more is added.
        let address = Address::new(Engine::Podman, Some("openbot-root".into()));
        let engine = CliEngine::of_with(&address, |_| {
            Ok(MachineFacts {
                rootful: Some(true),
                api: Some("unix:///tmp/podman/openbot-api.sock".into()),
            })
        });
        assert!(!matches!(
            engine_variables(Some(&engine)).get("CONTAINER_CONNECTION"),
            Some(Some(_))
        ));
    }

    /// With the person's own machine passed over (`engine::passed_over_machine`), OpenBot runs on
    /// its own, and the CLI is told that machine's API and connection. The machine behind Podman's
    /// default connection, which is the person's, is never the one asked about.
    #[cfg(not(target_os = "linux"))]
    #[test]
    fn the_cli_is_told_openbots_own_machine_and_never_the_default_one() {
        use crate::acquire::MachineFacts;
        use crate::engine::{Address, Engine};
        let pipe = "npipe:////./pipe/podman-openbot";
        let address = Address::new(Engine::Podman, Some("openbot-root".into()));
        let mut asked = Vec::new();
        let engine = CliEngine::of_with(&address, |connection| {
            asked.push(connection.to_string());
            Ok(MachineFacts {
                rootful: Some(true),
                api: Some(pipe.into()),
            })
        });
        assert_eq!(asked, ["openbot-root"]);
        assert!(!engine.rootless);
        let variables = engine_variables(Some(&engine));
        assert_eq!(variables.get("DOCKER_HOST"), Some(&Some(pipe.to_string())));
        assert_eq!(
            variables.get("CONTAINER_CONNECTION"),
            Some(&Some("openbot-root".to_string()))
        );
    }

    #[test]
    fn a_rootless_podman_declines_setup_start_and_update_and_nothing_else() {
        use crate::engine::Engine;
        let rootless = CliEngine {
            engine: Engine::Podman,
            api: Some("unix:///tmp/podman.sock".into()),
            connection: None,
            rootless: true,
        };
        let rootful = CliEngine {
            rootless: false,
            ..rootless.clone()
        };
        let stack = StackId::parse("local-abc123").unwrap();
        for arguments in [
            SETUP_ARGUMENTS.to_vec(),
            arguments(Action::Start, &stack).to_vec(),
            // It installs a release, as setup does.
            arguments(Action::Update, &stack).to_vec(),
        ] {
            assert_eq!(
                refuse_rootless(&arguments, Some(&rootless)),
                Err(Failure::RootlessPodman)
            );
            assert_eq!(refuse_rootless(&arguments, Some(&rootful)), Ok(()));
            assert_eq!(refuse_rootless(&arguments, None), Ok(()));
        }
        for arguments in [
            arguments(Action::Status, &stack).to_vec(),
            arguments(Action::Stop, &stack).to_vec(),
            LIST_ARGUMENTS.to_vec(),
            CONNECT_ARGUMENTS.to_vec(),
            login_arguments(&stack).to_vec(),
            ACCOUNT_SIGN_IN_ARGUMENTS.to_vec(),
            TERMS_ARGUMENTS.to_vec(),
            apps_arguments(&Installation::parse(APPS_ID).unwrap(), "/tmp/composio.env").to_vec(),
        ] {
            assert_eq!(refuse_rootless(&arguments, Some(&rootless)), Ok(()));
        }
    }

    #[test]
    fn every_failure_category_is_known_to_the_window() {
        let window = include_str!("../../src/localEvalCli.ts");
        let all = [
            Failure::Unavailable,
            Failure::Unverified,
            Failure::InvalidStack,
            Failure::Spawn,
            Failure::Timeout,
            Failure::Cancelled,
            Failure::OutputLimit,
            Failure::InvalidJson,
            Failure::UnsupportedVersion,
            Failure::UnexpectedCommand,
            Failure::InvalidStatus,
            Failure::MissingStack,
            Failure::UnsafeEndpoint,
            Failure::ContractMismatch,
            Failure::UnexpectedExit,
            Failure::InvalidAcceptance,
            Failure::RootlessPodman,
            Failure::DownloadStalled,
        ];
        // Adding a variant without listing it above stops compiling here.
        for failure in all {
            match failure {
                Failure::Unavailable
                | Failure::Unverified
                | Failure::InvalidStack
                | Failure::Spawn
                | Failure::Timeout
                | Failure::Cancelled
                | Failure::OutputLimit
                | Failure::InvalidJson
                | Failure::UnsupportedVersion
                | Failure::UnexpectedCommand
                | Failure::InvalidStatus
                | Failure::MissingStack
                | Failure::UnsafeEndpoint
                | Failure::ContractMismatch
                | Failure::UnexpectedExit
                | Failure::InvalidAcceptance
                | Failure::RootlessPodman
                | Failure::DownloadStalled => {}
            }
            let name = serde_json::to_string(&failure).unwrap();
            assert!(window.contains(&name), "localEvalCli.ts is missing {name}");
        }
    }

    #[test]
    fn every_reason_readiness_and_licence_is_known_to_the_window() {
        let window = include_str!("../../src/localEvalCli.ts");
        let reasons = [
            "authentication_required",
            "eula_acceptance_required",
            "eula_unavailable",
            "eula_declined",
            "release_unavailable",
            "feature_disabled",
            "unsupported_platform",
            "unsupported_engine",
            "port_unavailable",
            "docker_unavailable",
            "update_recovery_required",
            "incompatible_release",
            "local_command_busy",
            "local_command_failed",
            "confirmation_required",
            "something_new",
        ]
        .map(Reason::from_wire)
        .map(|reason| serde_json::to_string(&reason).unwrap());
        let readiness = [
            Readiness::Ready,
            Readiness::Starting,
            Readiness::Stopped,
            Readiness::Degraded,
            Readiness::Unknown,
        ]
        .map(|state| serde_json::to_string(&state).unwrap());
        let licence = [
            Licence::Valid,
            Licence::Expired,
            Licence::Missing,
            Licence::Invalid,
            Licence::OrganizationMismatch,
            Licence::Unknown,
        ]
        .map(|state| serde_json::to_string(&state).unwrap());
        for name in reasons.iter().chain(&readiness).chain(&licence) {
            assert!(
                window.contains(name.as_str()),
                "localEvalCli.ts is missing {name}"
            );
        }
    }

    // A fake CLI. It records its arguments, then does what `scenario` (beside it) says: an exit
    // code and a body to print, or `sleep`, `hold` or `flood`. `sleep` and `hold` start a
    // grandchild that sleeps, holding stdout, so tree cleanup can be observed. `--warm` only
    // exits: macOS checks a newly written executable on its first run, and that delay belongs
    // before a test's deadline starts, not inside it.
    const FAKE_CLI: &str = r#"
use std::io::Write;
fn main() {
    let exe = std::env::current_exe().unwrap();
    let dir = exe.parent().unwrap().to_path_buf();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--warm") => return,
        Some("--grandchild") => {
            std::thread::sleep(std::time::Duration::from_secs(60));
            return;
        }
        _ => {}
    }
    // The CLI's help for `login`: `help` beside the program, or a CLI from before `--mode`.
    if args == ["login", "--help"] {
        let asked = std::fs::read_to_string(dir.join("help-asked")).unwrap_or_default();
        std::fs::write(dir.join("help-asked"), format!("{asked}x")).unwrap();
        let help = std::fs::read_to_string(dir.join("help")).unwrap_or_else(|_| {
            "Usage: copilotkit login [--json [--force] | --device]\n".to_owned()
        });
        print!("{help}");
        return;
    }
    std::fs::write(dir.join("argv"), args.join("\n")).unwrap();
    std::fs::write(dir.join("cwd"), std::env::current_dir().unwrap().display().to_string()).unwrap();
    let inherited = |name: &str| format!("{name}={}", std::env::var(name).is_ok());
    std::fs::write(dir.join("env"), [inherited("NODE_OPTIONS"), inherited("HOME"), inherited("DO_NOT_TRACK"), inherited("COPILOTKIT_TELEMETRY_DISABLED")].join("\n")).unwrap();
    let scenario = std::fs::read_to_string(dir.join("scenario")).unwrap();
    let (mode, body) = scenario.split_once('\n').unwrap_or((scenario.as_str(), ""));
    match mode {
        "sleep" | "hold" => {
            let grandchild = std::process::Command::new(&exe).arg("--grandchild").spawn().unwrap();
            std::fs::write(dir.join("grandchild.tmp"), grandchild.id().to_string()).unwrap();
            std::fs::rename(dir.join("grandchild.tmp"), dir.join("grandchild")).unwrap();
            if mode == "hold" {
                print!("{body}");
                std::io::stdout().flush().unwrap();
                return;
            }
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
        // `login --json` waiting for the approval: what it printed so far, then nothing more.
        "wait" => {
            print!("{body}");
            std::io::stdout().flush().unwrap();
            std::fs::write(dir.join("pid"), std::process::id().to_string()).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
        // Like the real CLI, which forwards SIGTERM to its children instead of exiting: only
        // SIGKILL stops it.
        "stubborn" => {
            #[cfg(unix)]
            {
                extern "C" {
                    fn signal(signum: i32, handler: usize) -> usize;
                }
                // SAFETY: SIGTERM (15) set to SIG_IGN (1) before any other thread exists.
                unsafe { signal(15, 1) };
            }
            std::fs::write(dir.join("pid"), std::process::id().to_string()).unwrap();
            let grandchild = std::process::Command::new(&exe).arg("--grandchild").spawn().unwrap();
            std::fs::write(dir.join("grandchild.tmp"), grandchild.id().to_string()).unwrap();
            std::fs::rename(dir.join("grandchild.tmp"), dir.join("grandchild")).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
        // A valid machine response can precede the CLI's bounded telemetry flush.
        "flush" => {
            print!("{body}");
            std::io::stdout().flush().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2300));
        }
        "flood" => {
            let chunk = vec![b' '; 65536];
            let mut out = std::io::stdout();
            loop {
                if out.write_all(&chunk).is_err() {
                    std::process::exit(0);
                }
            }
        }
        code => {
            // What the real CLI's runtime prints when it fails, when the test gave one.
            match std::fs::read_to_string(dir.join("stderr")) {
                Ok(said) => eprint!("{said}"),
                Err(_) => eprint!("synthetic-secret-marker"),
            }
            print!("{body}");
            std::io::stdout().flush().unwrap();
            std::process::exit(code.parse().unwrap());
        }
    }
}
"#;

    /**
    A first setup leaves the k3s node image and k3d's tools and proxy to k3d. The CLI hands k3d
    them by digest and, after the cluster is made, checks the node's `Config.Image` is exactly that
    digest reference. Pulled first and tagged by OpenBot, Podman on Windows recorded the node's
    image as the tag (`docker.io/rancher/k3s:sha256-...`) with no digest, and every fresh install
    failed right after the CLI inspected its runtime. So the engine is never asked to pull or tag
    any of them, before or during the setup.
    */
    #[test]
    fn a_first_setup_leaves_the_k3s_and_k3d_images_for_k3d_to_pull_by_digest() {
        if crate::test_support::isolated_process(
            "local_eval::tests::a_first_setup_leaves_the_k3s_and_k3d_images_for_k3d_to_pull_by_digest",
        ) {
            return;
        }
        let root = temp_root("first-setup-k3d-images");
        std::fs::create_dir_all(&root).unwrap();
        // Each program writes every argument list it is given beside itself, one per line, and
        // fails: no stack is listed, no node answers, and nothing is ever pulled.
        let recording = |name: &str| {
            let source = root.join(format!("{name}.rs"));
            std::fs::write(
                &source,
                format!(
                    r#"
use std::io::Write;
fn main() {{
    let args: Vec<String> = std::env::args().skip(1).collect();
    let log = std::env::current_exe().unwrap().parent().unwrap().join("{name}-argv");
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(log).unwrap();
    writeln!(file, "{{}}", args.join(" ")).unwrap();
    std::process::exit(1);
}}
"#
                ),
            )
            .unwrap();
            let binary = root.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
            compile_fixture(&source, &binary);
            binary
        };
        let engine = recording("docker");
        let program = recording("copilotkit");
        assert!(engine.is_file());
        // The CLI's bundle, naming the k3s and k3d images k3d pulls through the engine.
        let entry = root.join("index.js");
        std::fs::write(
            &entry,
            include_str!("../test-fixtures/local-images/cli-48a3863-excerpt.txt"),
        )
        .unwrap();
        let cli = PinnedCli {
            program,
            entry: Some(entry),
            sha256: String::new(),
        };
        assert!(cli_images_of(&cli).is_some(), "the bundle is read");
        std::env::set_var("PATH", &root);
        use_engine(&crate::engine::Address::new(
            crate::engine::Engine::Docker,
            None,
        ));
        let installation = root.join("installation");
        std::fs::create_dir_all(&installation).unwrap();
        let limits = Limits::for_setup();
        let _ = setup_with(
            &cli,
            "first-setup-k3d-images",
            &installation,
            None,
            (limits, limits),
            &Cancel::default(),
            crate::local_images::Limits::standard(),
        );
        let ran = std::fs::read_to_string(root.join("copilotkit-argv")).unwrap_or_default();
        assert!(ran.contains("local setup"), "the setup ran: {ran}");
        let asked = std::fs::read_to_string(root.join("docker-argv")).unwrap_or_default();
        for line in asked.lines() {
            let words: Vec<&str> = line.split_whitespace().collect();
            let pulls_or_tags = words.iter().any(|word| *word == "pull" || *word == "tag");
            let k3d_image = ["rancher/k3s", "k3d-io/k3d-tools", "k3d-io/k3d-proxy"]
                .iter()
                .any(|image| line.contains(image));
            assert!(
                !(pulls_or_tags && k3d_image),
                "the engine was asked to `{line}`; k3d pulls these itself"
            );
        }
    }

    fn compiled() -> &'static Path {
        static BINARY: OnceLock<PathBuf> = OnceLock::new();
        BINARY.get_or_init(|| {
            let root = temp_root("local-eval-cli-build");
            std::fs::create_dir_all(&root).unwrap();
            let source = root.join("cli.rs");
            std::fs::write(&source, FAKE_CLI).unwrap();
            let binary = root.join(format!("cli{}", std::env::consts::EXE_SUFFIX));
            compile_fixture(&source, &binary);
            binary
        })
    }

    fn sha256(path: &Path) -> String {
        Sha256::digest(std::fs::read(path).unwrap())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    /**
    Run a program this test has just copied, once, the first time it is run.

    On Linux, running a file that was just written can fail with ETXTBSY ("Text file busy"). Another
    test thread may fork a child while this one has the copy open for writing. The child holds that
    write handle until it calls exec, and the kernel refuses to run a file someone has open for
    writing. Seen on CI as `too_much_output_stops_the_call` failing with `ExecutableFileBusy`. The
    handle goes as soon as the child execs, so a short retry is enough. The first run is the only
    one at risk: once it ran, the copy is no longer open anywhere for writing.
    */
    fn warm_copied_program(program: &Path) -> std::process::ExitStatus {
        let mut tries = 0;
        loop {
            match std::process::Command::new(program).arg("--warm").status() {
                Err(error)
                    if error.kind() == std::io::ErrorKind::ExecutableFileBusy && tries < 50 =>
                {
                    tries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                result => return result.unwrap(),
            }
        }
    }

    /// The CI flake made certain: the copy is held open for writing, as a forked child would hold
    /// it, while it is first run. Linux refuses to run it until the handle goes.
    #[test]
    #[cfg(target_os = "linux")]
    fn a_copied_program_still_open_for_writing_runs_once_the_handle_goes() {
        let root = temp_root("local-eval-busy-copy");
        std::fs::create_dir_all(&root).unwrap();
        let program = root.join("cli");
        std::fs::copy(compiled(), &program).unwrap();
        let held = std::fs::OpenOptions::new()
            .write(true)
            .open(&program)
            .unwrap();
        // Busy while held: the failure CI saw.
        let busy = std::process::Command::new(&program).arg("--warm").status();
        assert_eq!(
            busy.unwrap_err().kind(),
            std::io::ErrorKind::ExecutableFileBusy
        );
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            drop(held);
        });
        assert!(warm_copied_program(&program).success());
        release.join().unwrap();
    }

    struct Fixture {
        root: PathBuf,
        program: PathBuf,
    }

    impl Fixture {
        fn new(label: &str, scenario: &str) -> Self {
            let root = temp_root(label);
            std::fs::create_dir_all(&root).unwrap();
            let program = root.join(format!("cli{}", std::env::consts::EXE_SUFFIX));
            // On Linux, another test's fork can inherit fs::copy's writable descriptor
            // until exec, even after copy returns. Executing that inode then fails ETXTBSY.
            // The fixture binary is immutable; link it without opening a new write handle.
            #[cfg(target_os = "linux")]
            std::fs::hard_link(compiled(), &program).unwrap();
            #[cfg(not(target_os = "linux"))]
            std::fs::copy(compiled(), &program).unwrap();
            std::fs::write(root.join("scenario"), scenario).unwrap();
            assert!(warm_copied_program(&program).success());
            Self { root, program }
        }

        fn pin(&self) -> Pin {
            Pin {
                path: self.program.clone(),
                sha256: sha256(&self.program),
            }
        }

        fn cli(&self) -> PinnedCli {
            PinnedCli::verify(&self.pin(), None).unwrap()
        }

        fn argv(&self) -> Option<String> {
            std::fs::read_to_string(self.root.join("argv")).ok()
        }

        /// The folder the program ran in, resolved: Windows reports the temporary folder by its
        /// short 8.3 name (`RUNNER~1`) and `canonicalize` by its long one, with a `\\?\` prefix.
        fn cwd(&self) -> PathBuf {
            PathBuf::from(std::fs::read_to_string(self.root.join("cwd")).unwrap())
                .canonicalize()
                .unwrap()
        }

        fn run(&self, action: Action, limits: Limits, cancel: &Cancel) -> Result<Report, Failure> {
            run(
                &self.cli(),
                action,
                &StackId::parse("local-abc123").unwrap(),
                limits,
                cancel,
            )
        }

        /// The fake has started the grandchild it will hold the call open with.
        fn wait_for_grandchild(root: &Path) {
            let until = Instant::now() + Duration::from_secs(30);
            while !root.join("grandchild").exists() {
                assert!(
                    Instant::now() < until,
                    "the fake never started its grandchild"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        #[cfg(unix)]
        fn grandchild(&self) -> libc::pid_t {
            std::fs::read_to_string(self.root.join("grandchild"))
                .expect("the fake started its grandchild before the call ended")
                .parse()
                .unwrap()
        }

        #[cfg(unix)]
        fn grandchild_stops(&self) -> bool {
            let pid = self.grandchild();
            let until = Instant::now() + Duration::from_secs(5);
            while Instant::now() < until {
                // SAFETY: signal 0 only checks existence.
                if unsafe { libc::kill(pid, 0) } != 0 {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            false
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn short(timeout: Duration) -> Limits {
        Limits {
            timeout,
            grace: Duration::from_millis(500),
            output: MAX_OUTPUT,
        }
    }

    #[test]
    fn fixture_executables_keep_scenarios_and_cleanup_independent() {
        let installation = Installation::parse("ba7361bc-59d2-4ef3-b26c-476db6490ed7").unwrap();
        let signed_out = Fixture::new(
            "telemetry-fixture-signed-out",
            "0\n{\"type\":\"signed_out\"}",
        );
        let skipped = Fixture::new("telemetry-fixture-skipped", "0\n{\"type\":\"skipped\"}");
        assert_eq!(
            link_telemetry(
                &signed_out.cli(),
                &installation,
                None,
                telemetry_link_limits(),
                &Cancel::default()
            ),
            Ok(TelemetryIdentity::SignedOut)
        );
        drop(signed_out);
        assert_eq!(
            link_telemetry(
                &skipped.cli(),
                &installation,
                None,
                telemetry_link_limits(),
                &Cancel::default()
            ),
            Ok(TelemetryIdentity::Skipped)
        );
        assert!(compiled().is_file());
    }

    #[test]
    fn telemetry_process_uses_fixed_arguments_and_ignores_stderr() {
        let installation = Installation::parse("ba7361bc-59d2-4ef3-b26c-476db6490ed7").unwrap();
        let account = "a".repeat(64);
        for bound in [None, Some(account.as_str())] {
            let fixture = Fixture::new(
                "telemetry-process",
                &format!("0\n{{\"type\":\"account\",\"account_id\":\"{account}\"}}\n"),
            );
            assert_eq!(
                link_telemetry(
                    &fixture.cli(),
                    &installation,
                    bound,
                    telemetry_link_limits(),
                    &Cancel::default()
                ),
                Ok(TelemetryIdentity::Account {
                    account_id: account.clone()
                })
            );
            let mut expected = format!(
                "telemetry\nlink\n--installation-id\n{}\n--json",
                installation.as_str()
            );
            if let Some(bound) = bound {
                expected.push_str(&format!("\n--account-id\n{bound}"));
            }
            assert_eq!(fixture.argv(), Some(expected));
        }
    }

    #[test]
    fn telemetry_process_refuses_failed_and_old_cli_without_exposing_output() {
        let installation = Installation::parse("ba7361bc-59d2-4ef3-b26c-476db6490ed7").unwrap();
        for body in ["private upstream failure", "Unknown telemetry subcommand"] {
            let fixture = Fixture::new("telemetry-old-cli", &format!("1\n{body}"));
            assert_eq!(
                link_telemetry(
                    &fixture.cli(),
                    &installation,
                    None,
                    telemetry_link_limits(),
                    &Cancel::default()
                ),
                Err(Failure::UnexpectedExit)
            );
        }
    }

    #[test]
    fn telemetry_process_keeps_a_valid_response_while_cli_finishes_flushing() {
        let fixture = Fixture::new("telemetry-flush", "flush\n{\"type\":\"signed_out\"}");
        let installation = Installation::parse("ba7361bc-59d2-4ef3-b26c-476db6490ed7").unwrap();
        assert_eq!(
            link_telemetry(
                &fixture.cli(),
                &installation,
                None,
                telemetry_link_limits(),
                &Cancel::default()
            ),
            Ok(TelemetryIdentity::SignedOut)
        );
    }

    #[test]
    fn required_cli_work_stops_a_real_background_process_tree() {
        if crate::test_support::isolated_process(
            "local_eval::tests::required_cli_work_stops_a_real_background_process_tree",
        ) {
            return;
        }
        let fixture = Fixture::new("telemetry-preempt", "stubborn");
        let cli = fixture.cli();
        let worker = std::thread::spawn(move || {
            background_telemetry_call(|cancel, limits| {
                link_telemetry(
                    &cli,
                    &Installation::parse("ba7361bc-59d2-4ef3-b26c-476db6490ed7").unwrap(),
                    None,
                    limits,
                    cancel,
                )
            })
        });
        Fixture::wait_for_grandchild(&fixture.root);
        let started = Instant::now();
        assert_eq!(
            one_at_a_time(
                &Cancel::default(),
                Limits::for_action(Action::Status),
                |_| Ok(())
            ),
            Ok(())
        );
        assert_eq!(worker.join().unwrap(), Err(Failure::Cancelled));
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "required work waited for the eight-second telemetry timeout"
        );
        #[cfg(unix)]
        assert!(fixture.grandchild_stops());
    }

    #[test]
    fn background_telemetry_defers_instead_of_queueing_behind_required_work() {
        let _turn = hold_turn();
        assert_eq!(
            background_telemetry_call::<()>(|_, _| panic!("busy CLI must not run telemetry")),
            Err(Failure::Cancelled)
        );
    }

    #[test]
    fn telemetry_process_bounds_startup_wait_and_kills_a_hung_cli() {
        let limits = telemetry_link_limits();
        // Each call remains bounded while leaving room for cold start, Ops and CLI flush.
        assert!(limits.timeout + limits.grace <= Duration::from_millis(8250));
        let fixture = Fixture::new("telemetry-timeout", "stubborn");
        let cli = fixture.cli();
        let installation = Installation::parse("ba7361bc-59d2-4ef3-b26c-476db6490ed7").unwrap();
        let started = Instant::now();
        assert_eq!(
            link_telemetry(&cli, &installation, None, limits, &Cancel::default()),
            Err(Failure::Timeout)
        );
        // Allow scheduler overhead beyond the eight-second budget and kill grace.
        assert!(started.elapsed() < Duration::from_secs(10));
        #[cfg(unix)]
        assert!(fixture.grandchild_stops());
    }

    #[test]
    fn runs_the_fixed_arguments_and_keeps_only_the_report() {
        let fixture = Fixture::new("local-eval-status", &format!("0\n{}", envelope()));
        let report = fixture
            .run(
                Action::Status,
                Limits::for_action(Action::Status),
                &Cancel::default(),
            )
            .unwrap();
        assert_eq!(report.outcome, Outcome::Completed);
        assert_eq!(
            fixture.argv().unwrap(),
            "local\nstatus\n--stack\nlocal-abc123\n--json"
        );
        // The fake writes the marker to stderr; stderr is never read.
        assert!(!exposes_secret(&report));
    }

    #[test]
    fn a_blocked_call_never_runs_its_recovery_command() {
        let fixture = Fixture::new("local-eval-blocked", "");
        let executed = fixture.root.join("executed");
        let body = json!({
            "version": 1,
            "command": "local start",
            "status": "blocked",
            "error": null,
            "nextAction": {
                "reason": "authentication_required",
                "summary": SECRET,
                "resumeCommand": format!("touch {}", executed.display())
            }
        });
        std::fs::write(fixture.root.join("scenario"), format!("2\n{body}")).unwrap();
        let report = fixture
            .run(
                Action::Start,
                Limits::for_action(Action::Start),
                &Cancel::default(),
            )
            .unwrap();
        assert_eq!(report.outcome, Outcome::Blocked);
        assert_eq!(report.reason, Some(Reason::AuthenticationRequired));
        assert!(!executed.exists());
        assert!(!exposes_secret(&report));
    }

    #[test]
    fn exit_codes_local_does_not_use_are_not_believed() {
        let fixture = Fixture::new("local-eval-exit", &format!("3\n{}", envelope()));
        assert_eq!(
            fixture.run(
                Action::Status,
                Limits::for_action(Action::Status),
                &Cancel::default()
            ),
            Err(Failure::UnexpectedExit)
        );
    }

    #[test]
    fn a_cli_that_does_not_match_its_pin_is_never_run() {
        let fixture = Fixture::new("local-eval-unverified", &format!("0\n{}", envelope()));
        let mut pin = fixture.pin();
        pin.sha256 = "0".repeat(64);
        assert!(matches!(
            PinnedCli::verify(&pin, None),
            Err(Failure::Unverified)
        ));
        let missing = Pin {
            path: fixture.root.join("absent"),
            sha256: "0".repeat(64),
        };
        assert!(matches!(
            PinnedCli::verify(&missing, None),
            Err(Failure::Unverified)
        ));
        // An entry script is pinned the same way.
        assert!(matches!(
            PinnedCli::verify(&fixture.pin(), Some(&missing)),
            Err(Failure::Unverified)
        ));
        assert_eq!(fixture.argv(), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_the_pinned_file_is_not_the_pinned_file() {
        let fixture = Fixture::new("local-eval-link", "0\n");
        let link = fixture.root.join("linked");
        std::os::unix::fs::symlink(&fixture.program, &link).unwrap();
        let pin = Pin {
            path: link,
            sha256: sha256(&fixture.program),
        };
        assert!(matches!(
            PinnedCli::verify(&pin, None),
            Err(Failure::Unverified)
        ));
    }

    #[test]
    fn a_verified_entry_script_is_the_first_argument() {
        let fixture = Fixture::new("local-eval-entry", &format!("0\n{}", envelope()));
        let entry = fixture.root.join("index.js");
        std::fs::write(&entry, "// pinned entry").unwrap();
        let entry_pin = Pin {
            path: entry.clone(),
            sha256: sha256(&entry),
        };
        let cli = PinnedCli::verify(&fixture.pin(), Some(&entry_pin)).unwrap();
        run(
            &cli,
            Action::Status,
            &StackId::parse("local-abc123").unwrap(),
            Limits::for_action(Action::Status),
            &Cancel::default(),
        )
        .unwrap();
        assert_eq!(
            fixture.argv().unwrap(),
            format!(
                "{}\nlocal\nstatus\n--stack\nlocal-abc123\n--json",
                entry.display()
            )
        );
    }

    #[test]
    fn a_call_past_its_deadline_stops_its_whole_tree() {
        let fixture = Fixture::new("local-eval-timeout", "sleep");
        let started = Instant::now();
        assert_eq!(
            fixture.run(
                Action::Start,
                short(Duration::from_secs(5)),
                &Cancel::default()
            ),
            Err(Failure::Timeout)
        );
        assert!(started.elapsed() < Duration::from_secs(15));
        #[cfg(unix)]
        assert!(
            fixture.grandchild_stops(),
            "grandchild outlived the timeout"
        );
    }

    #[test]
    fn a_cancelled_call_stops_its_whole_tree() {
        let fixture = Fixture::new("local-eval-cancel", "sleep");
        let cancel = Cancel::default();
        let later = cancel.clone();
        let root = fixture.root.clone();
        std::thread::spawn(move || {
            Fixture::wait_for_grandchild(&root);
            later.cancel();
        });
        let started = Instant::now();
        assert_eq!(
            fixture.run(Action::Start, short(Duration::from_secs(60)), &cancel),
            Err(Failure::Cancelled)
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        #[cfg(unix)]
        assert!(
            fixture.grandchild_stops(),
            "grandchild outlived cancellation"
        );
    }

    #[test]
    fn too_much_output_stops_the_call() {
        let fixture = Fixture::new("local-eval-flood", "flood");
        let started = Instant::now();
        assert_eq!(
            fixture.run(
                Action::Status,
                short(Duration::from_secs(60)),
                &Cancel::default()
            ),
            Err(Failure::OutputLimit)
        );
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_cli_that_exits_is_finished_even_if_something_keeps_its_output_open() {
        let fixture = Fixture::new("local-eval-hold", &format!("hold\n{}", envelope()));
        let started = Instant::now();
        let report = fixture
            .run(
                Action::Status,
                short(Duration::from_secs(30)),
                &Cancel::default(),
            )
            .unwrap();
        assert_eq!(report.outcome, Outcome::Completed);
        assert!(started.elapsed() < Duration::from_secs(10));
        #[cfg(unix)]
        {
            // A CLI that exited normally keeps what it left running; this test cleans it up.
            let pid = fixture.grandchild();
            // SAFETY: signal 0 checks existence; SIGKILL stops the fixture's own grandchild.
            assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "the holder was stopped");
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }

    #[test]
    fn the_cli_does_not_inherit_code_loading_settings() {
        if crate::test_support::isolated_process(
            "local_eval::tests::the_cli_does_not_inherit_code_loading_settings",
        ) {
            return;
        }
        std::env::set_var("NODE_OPTIONS", "--require=/tmp/synthetic-secret-marker.js");
        std::env::set_var("DO_NOT_TRACK", "1");
        let fixture = Fixture::new("local-eval-env", &format!("0\n{}", envelope()));
        fixture
            .run(
                Action::Status,
                Limits::for_action(Action::Status),
                &Cancel::default(),
            )
            .unwrap();
        let env = std::fs::read_to_string(fixture.root.join("env")).unwrap();
        assert!(env.contains("NODE_OPTIONS=false"), "{env}");
        assert!(env.contains("DO_NOT_TRACK=true"), "{env}");
        assert_eq!(
            env.contains("HOME=true"),
            std::env::var_os("HOME").is_some(),
            "{env}"
        );
    }

    /// Share usage data turned off in Settings reaches the CLI as the variable it reads, though
    /// nothing in the app's own environment set it.
    #[test]
    fn usage_data_turned_off_in_settings_reaches_the_cli_as_its_opt_out() {
        if crate::test_support::isolated_process(
            "local_eval::tests::usage_data_turned_off_in_settings_reaches_the_cli_as_its_opt_out",
        ) {
            return;
        }
        std::env::remove_var("COPILOTKIT_TELEMETRY_DISABLED");
        let fixture = Fixture::new("local-eval-usage-data", &format!("0\n{}", envelope()));
        let run = || {
            fixture
                .run(
                    Action::Status,
                    Limits::for_action(Action::Status),
                    &Cancel::default(),
                )
                .unwrap();
            std::fs::read_to_string(fixture.root.join("env")).unwrap()
        };
        assert!(run().contains("COPILOTKIT_TELEMETRY_DISABLED=false"));
        crate::usage_data::set_off(true);
        let env = run();
        assert!(env.contains("COPILOTKIT_TELEMETRY_DISABLED=true"), "{env}");
    }

    fn listing(stacks: Value) -> Value {
        json!({
            "version": 1,
            "command": "local list",
            "status": "completed",
            "stacks": stacks,
            "nextAction": null,
            "error": null,
            "diagnostics": []
        })
    }

    fn listed_stack(id: &str) -> Value {
        let mut stack = envelope()["stack"].clone();
        stack["id"] = json!(id);
        stack.as_object_mut().unwrap().remove("observed");
        stack["appPaths"] =
            json!([{ "path": format!("/Users/someone/{SECRET}"), "missing": false }]);
        stack
    }

    #[test]
    fn a_listing_keeps_each_stack_and_none_of_its_app_folders() {
        let input = listing(json!([
            listed_stack("local-one"),
            listed_stack("local-two")
        ]));
        let listed = normalize_list(0, input.to_string().as_bytes()).unwrap();
        let ids: Vec<_> = listed
            .stacks
            .iter()
            .map(|stack| stack.id.as_str())
            .collect();
        assert_eq!(ids, ["local-one", "local-two"]);
        assert!(!serde_json::to_string(&listed).unwrap().contains(SECRET));
        let empty = normalize_list(0, listing(json!([])).to_string().as_bytes()).unwrap();
        assert!(empty.stacks.is_empty());
    }

    #[test]
    fn a_listing_fails_whole_rather_than_partly() {
        let mut bad = listed_stack("local-two");
        bad["urls"]["api"] = json!("http://example.com:8082");
        let input = listing(json!([listed_stack("local-one"), bad]));
        assert_eq!(
            normalize_list(0, input.to_string().as_bytes()),
            Err(Failure::UnsafeEndpoint)
        );
        let mut input = listing(json!([]));
        input.as_object_mut().unwrap().remove("stacks");
        assert_eq!(
            normalize_list(0, input.to_string().as_bytes()),
            Err(Failure::InvalidStatus)
        );
        let many = vec![listed_stack("local-one"); MAX_STACKS + 1];
        assert_eq!(
            normalize_list(0, listing(json!(many)).to_string().as_bytes()),
            Err(Failure::InvalidStatus)
        );
        assert_eq!(
            normalize_list(0, envelope().to_string().as_bytes()),
            Err(Failure::UnexpectedCommand)
        );
        assert_eq!(
            normalize_list(2, listing(json!([])).to_string().as_bytes()),
            Err(Failure::ContractMismatch)
        );
        let failed = json!({
            "version": 1, "command": "local list", "status": "failed",
            "error": { "message": SECRET },
            "nextAction": { "reason": "local_command_failed", "resumeCommand": SECRET }
        });
        let listed = normalize_list(1, failed.to_string().as_bytes()).unwrap();
        assert_eq!(listed.reason, Some(Reason::LocalCommandFailed));
        assert!(listed.stacks.is_empty());
        assert!(!serde_json::to_string(&listed).unwrap().contains(SECRET));
    }

    #[test]
    fn listing_runs_without_a_stack() {
        let body = listing(json!([listed_stack("local-one")]));
        let fixture = Fixture::new("local-eval-list", &format!("0\n{body}"));
        let listed = list(
            &fixture.cli(),
            Limits::for_action(Action::Status),
            &Cancel::default(),
        )
        .unwrap();
        assert_eq!(listed.stacks[0].id, "local-one");
        assert_eq!(fixture.argv().unwrap(), "local\nlist\n--json");
        assert_eq!(list_installed("list-no-cli"), Err(Failure::Unavailable));
    }

    #[test]
    fn an_accepted_agreement_version_is_an_identifier_and_reaches_setup_only_when_given() {
        assert_eq!(setup_arguments(None), SETUP_ARGUMENTS.to_vec());
        let version = EulaVersion::parse("developer-edition-2026-10-01-web").unwrap();
        assert_eq!(
            setup_arguments(Some(&version)),
            [
                "local",
                "setup",
                "--defer-model",
                "--accept-eula-version",
                "developer-edition-2026-10-01-web",
                "--json"
            ]
        );
        for refused in [
            "",
            "--json",
            "-x",
            "v1 --stack other",
            "v1\n",
            "a/b",
            &"v".repeat(129),
        ] {
            assert_eq!(
                EulaVersion::parse(refused),
                Err(Failure::InvalidAcceptance),
                "{refused:?}"
            );
        }
    }

    const APPS_ID: &str = "e1503aba-d1ba-4d21-ab5e-7b6cb109bfb6";

    /// `integrations composio provision`'s line, as `commands/integrations.ts` prints it.
    fn apps_report(fields: Value) -> String {
        let mut report = json!({
            "type": "completed",
            "installation_id": APPS_ID,
            "project_id": "pr_fixture",
            "environment_file_written": true,
            "reused": false,
        });
        for (name, value) in fields.as_object().unwrap() {
            report[name] = value.clone();
        }
        format!("{report}\n")
    }

    /// Only an id OpenBot could have made reaches the command line, and the arguments are fixed.
    #[test]
    fn apps_arguments_are_fixed_and_take_only_a_lowercase_installation_id() {
        let id = Installation::parse(APPS_ID).unwrap();
        assert_eq!(
            apps_arguments(&id, "/home/person/OpenBot/.openbot-apps/composio.env"),
            [
                "integrations",
                "composio",
                "provision",
                "--installation-id",
                APPS_ID,
                "--env-path",
                "/home/person/OpenBot/.openbot-apps/composio.env",
                "--json"
            ]
        );
        for refused in [
            "",
            "--json",
            "E1503ABA-D1BA-4D21-AB5E-7B6CB109BFB6",
            "e1503aba-d1ba-4d21-ab5e-7b6cb109bfb",
            "e1503aba-d1ba-4d21-ab5e-7b6cb109bfb6 --x",
            "e1503abad1ba-4d21-ab5e-7b6cb109bfb6-",
        ] {
            assert_eq!(
                Installation::parse(refused),
                Err(Failure::Spawn),
                "{refused}"
            );
        }
    }

    /// Only a completed report for the installation asked about, with the file written, counts.
    #[test]
    fn an_apps_report_is_believed_only_for_this_installation() {
        let id = Installation::parse(APPS_ID).unwrap();
        assert_eq!(
            normalize_apps(&id, 0, apps_report(json!({ "reused": true })).as_bytes()),
            Ok(AppsProvisioned {
                installation_id: APPS_ID.into(),
                project_id: "pr_fixture".into(),
                reused: true,
            })
        );
        // Every failure exits 1 with its sentence on stderr only.
        assert_eq!(normalize_apps(&id, 1, b""), Err(Failure::UnexpectedExit));
        for wrong in [
            json!({ "type": "already_configured", "environment_file_written": false }),
            json!({ "installation_id": "a1503aba-d1ba-4d21-ab5e-7b6cb109bfb6" }),
            json!({ "environment_file_written": false }),
            json!({ "project_id": "" }),
            json!({ "reused": "yes" }),
        ] {
            assert_eq!(
                normalize_apps(&id, 0, apps_report(wrong.clone()).as_bytes()),
                Err(Failure::ContractMismatch),
                "{wrong}"
            );
        }
        assert_eq!(
            normalize_apps(&id, 0, b"Composio provisioning could not finish."),
            Err(Failure::InvalidJson)
        );
    }

    /// The real bounded process: fixed arguments in, the one line read back.
    #[test]
    fn provisioning_apps_runs_the_fixed_arguments_and_reads_only_the_report() {
        let fixture = Fixture::new("local-eval-apps", &format!("0\n{}", apps_report(json!({}))));
        let env_file = fixture.root.join("composio.env");
        let id = Installation::parse(APPS_ID).unwrap();
        assert_eq!(
            provision_apps(
                &fixture.cli(),
                &id,
                &env_file,
                Limits::for_apps(),
                &Cancel::default()
            )
            .map(|provisioned| provisioned.reused),
            Ok(false)
        );
        assert_eq!(
            fixture.argv().unwrap(),
            format!(
                "integrations\ncomposio\nprovision\n--installation-id\n{APPS_ID}\n--env-path\n{}\n--json",
                env_file.display()
            )
        );
        // A relative file is refused before anything runs.
        assert_eq!(
            provision_apps(
                &fixture.cli(),
                &id,
                std::path::Path::new("composio.env"),
                Limits::for_apps(),
                &Cancel::default()
            ),
            Err(Failure::Spawn)
        );
    }

    /// #991: the sign-in page a person sees explains OpenBot's setup. The CLI carries that as
    /// `login --mode openbot`, once it has the flag; an older one would refuse it and sign nobody in.
    #[test]
    fn the_account_sign_in_asks_for_openbots_sign_in_page_when_the_cli_takes_it() {
        let signed_in = "0\n{\"type\":\"completed\"}\n";
        let current = Fixture::new("local-eval-sign-in-mode", signed_in);
        std::fs::write(
            current.root.join("help"),
            "Usage: copilotkit login [--json [--force] | --device] [--mode openbot]\n",
        )
        .unwrap();
        assert_eq!(
            account_sign_in(
                &current.cli(),
                Limits::for_account_sign_in(),
                &Cancel::default(),
                &mut |_| {}
            ),
            Ok(AccountSignIn { signed_in: true })
        );
        assert_eq!(
            current.argv().as_deref(),
            Some("login\n--json\n--mode\nopenbot")
        );

        let older = Fixture::new("local-eval-sign-in-no-mode", signed_in);
        assert_eq!(
            account_sign_in(
                &older.cli(),
                Limits::for_account_sign_in(),
                &Cancel::default(),
                &mut |_| {}
            ),
            Ok(AccountSignIn { signed_in: true })
        );
        assert_eq!(older.argv().as_deref(), Some("login\n--json"));

        // Asked once per CLI: these bytes do not change while they run.
        account_sign_in(
            &current.cli(),
            Limits::for_account_sign_in(),
            &Cancel::default(),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(current.root.join("help-asked")).unwrap(),
            "x"
        );
    }

    /// What `login --json` prints before it waits, as the CLI writes it at Intelligence e03c163a
    /// (`commands/login.tsx`), with a synthetic code.
    fn authentication_url(url: &str, code: &str) -> String {
        format!(
            "{}\n",
            json!({
                "expires_at": "2026-11-06T12:15:00.000Z",
                "type": "authentication_url",
                "url": url,
                "user_code": code,
            })
        )
    }

    const DEVICE_PAGE: &str =
        "https://dashboard.copilotkit.ai/cli-auth/device?user_code=WXYZ-2345&source=cli&mode=openbot";

    /// The sign-in that waited forever: an account in several organizations lands on the
    /// dashboard instead of the approval. The window shows the page the CLI is waiting on, and
    /// Cancel stops the CLI rather than leaving it waiting behind the window.
    #[test]
    fn the_account_sign_in_shows_its_page_while_it_waits_and_cancel_stops_the_cli() {
        let printed = format!(
            "{}{}\n",
            authentication_url(DEVICE_PAGE, "WXYZ-2345"),
            json!({"type": "action_required", "browser_opened": true, "message": SECRET})
        );
        let fixture = Fixture::new("local-eval-sign-in-wait", &format!("wait\n{printed}"));
        let cli = fixture.cli();
        let cancel = Cancel::default();
        let stop = cancel.clone();
        let (pages, shown) = std::sync::mpsc::channel();
        let signing_in = std::thread::spawn(move || {
            account_sign_in(&cli, Limits::for_account_sign_in(), &cancel, &mut |page| {
                pages.send(page).unwrap()
            })
        });
        let page = shown
            .recv_timeout(Duration::from_secs(20))
            .expect("the page was shown while the CLI waited");
        assert_eq!(
            page,
            SignInPage {
                url: DEVICE_PAGE.to_owned(),
                user_code: "WXYZ-2345".to_owned(),
            }
        );
        assert!(!signing_in.is_finished(), "the CLI was still waiting");

        stop.cancel();
        let started = Instant::now();
        assert_eq!(signing_in.join().unwrap(), Err(Failure::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(10));
        #[cfg(unix)]
        {
            let pid: libc::pid_t = std::fs::read_to_string(fixture.root.join("pid"))
                .unwrap()
                .parse()
                .unwrap();
            // SAFETY: signal 0 only checks existence. The CLI was reaped, so it is gone.
            assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "the CLI outlived Cancel");
        }
        // Shown once: the same page printed again is not news.
        assert!(shown.try_recv().is_err());
    }

    /// The window asks by attempt while the sign-in waits, and hears nothing once it has ended.
    #[test]
    fn a_shown_sign_in_page_lasts_as_long_as_its_sign_in() {
        let page = SignInPage {
            url: DEVICE_PAGE.to_owned(),
            user_code: "WXYZ-2345".to_owned(),
        };
        let showing = ShowingSignIn("sign-in-page-lifetime".to_owned());
        assert_eq!(shown_sign_in_page("sign-in-page-lifetime"), None);
        showing.show(page.clone());
        assert_eq!(shown_sign_in_page("sign-in-page-lifetime"), Some(page));
        assert_eq!(shown_sign_in_page("another-sign-in"), None);
        drop(showing);
        assert_eq!(shown_sign_in_page("sign-in-page-lifetime"), None);
    }

    #[test]
    fn the_sign_in_page_is_the_clis_latest_page_for_its_own_code() {
        let first = authentication_url(DEVICE_PAGE, "WXYZ-2345");
        assert_eq!(
            sign_in_page(first.as_bytes()),
            Some(SignInPage {
                url: DEVICE_PAGE.to_owned(),
                user_code: "WXYZ-2345".to_owned(),
            })
        );
        // A code that expired unapproved is replaced, and the window shows the new one.
        let renewed_page = "https://dashboard.copilotkit.ai/cli-auth/device?user_code=MNPQ-6789";
        let renewed = format!("{first}{}", authentication_url(renewed_page, "MNPQ-6789"));
        assert_eq!(
            sign_in_page(renewed.as_bytes()).map(|page| page.user_code),
            Some("MNPQ-6789".to_owned())
        );
        // A line the CLI is still writing is not read yet.
        assert_eq!(sign_in_page(&first.as_bytes()[..first.len() - 1]), None);
        // A local dashboard is allowed over http; nothing else is.
        let local = "http://127.0.0.1:3000/cli-auth/device?user_code=WXYZ-2345";
        assert!(sign_in_page(authentication_url(local, "WXYZ-2345").as_bytes()).is_some());
        for (url, code) in [
            (
                "http://dashboard.copilotkit.ai/cli-auth/device?user_code=WXYZ-2345",
                "WXYZ-2345",
            ),
            (
                "https://someone:secret@dashboard.copilotkit.ai/cli-auth/device?user_code=WXYZ-2345",
                "WXYZ-2345",
            ),
            // The page has to be the one for the code it names.
            (DEVICE_PAGE, "ABCD-0000"),
            ("file:///etc/passwd?user_code=WXYZ-2345", "WXYZ-2345"),
            ("javascript:alert(1)//?user_code=WXYZ-2345", "WXYZ-2345"),
            (
                "https://dashboard.copilotkit.ai/cli-auth/device?user_code=%3Cb%3E",
                "<b>",
            ),
        ] {
            assert_eq!(
                sign_in_page(authentication_url(url, code).as_bytes()),
                None,
                "{url}"
            );
        }
        let long = format!("{DEVICE_PAGE}&pad={}", "a".repeat(MAX_SIGN_IN_URL));
        assert_eq!(
            sign_in_page(authentication_url(&long, "WXYZ-2345").as_bytes()),
            None
        );
        // Nothing else the CLI prints is taken as a page.
        assert_eq!(
            sign_in_page(b"{\"type\":\"action_required\",\"url\":\"https://x\"}\nnot json\n"),
            None
        );
    }

    #[test]
    fn only_a_help_that_lists_the_openbot_mode_says_the_cli_takes_it() {
        assert!(help_lists_openbot_mode(
            0,
            b"  --mode openbot  Show the OpenBot setup text\n"
        ));
        assert!(!help_lists_openbot_mode(
            0,
            b"Usage: copilotkit login [--json | --device]\n"
        ));
        assert!(!help_lists_openbot_mode(1, b"--mode openbot"));
        assert!(!help_lists_openbot_mode(0, &[0xff, 0xfe]));
    }

    #[test]
    fn account_sign_in_believes_the_last_outcome_line_and_its_exit_code() {
        let completed = concat!(
            "{\"type\":\"action_required\",\"authentication_url\":\"https://x\",\"user_code\":\"ABCD\",\"browser_opened\":true}\n",
            "{\"type\":\"completed\"}\n"
        );
        assert_eq!(
            normalize_account_sign_in(0, completed.as_bytes()),
            Ok(AccountSignIn { signed_in: true })
        );
        assert_eq!(
            normalize_account_sign_in(
                0,
                b"{\"already_authenticated\":true,\"type\":\"completed\"}\n"
            ),
            Ok(AccountSignIn { signed_in: true })
        );
        assert_eq!(
            normalize_account_sign_in(1, b"{\"type\":\"failed\",\"error\":\"denied\"}\n"),
            Ok(AccountSignIn { signed_in: false })
        );
        // An outcome that disagrees with how it exited is not believed.
        assert_eq!(
            normalize_account_sign_in(1, b"{\"type\":\"completed\"}\n"),
            Err(Failure::ContractMismatch)
        );
        assert_eq!(
            normalize_account_sign_in(0, b"{\"type\":\"action_required\"}\n"),
            Err(Failure::InvalidStatus)
        );
        assert_eq!(
            normalize_account_sign_in(0, b"not json\n"),
            Err(Failure::InvalidJson)
        );
    }

    /// The CLI's report of a failed resource check, as the 4.34.0-pre.647a03b CLI prints it.
    fn refused_for_resources(code: &str, message: &str) -> Vec<u8> {
        json!({
            "version": 1,
            "command": "local setup",
            "status": "failed",
            "error": { "code": code, "message": message },
            "nextAction": {
                "reason": "local_command_failed",
                "summary": "The local command did not finish. Check local status for the recorded failed step, then resume the command. No automatic rollback was requested.",
                "instructions": ["Inspect the recorded stack with npx --yes copilotkit@4.34.0-pre.647a03b local status --json."],
                "resumeCommand": "npx --yes copilotkit@4.34.0-pre.647a03b local setup --json",
                "url": null, "linkLabel": null, "linkFile": null,
                "caveats": [], "requiredEnvVars": [], "artifacts": []
            },
            "diagnostics": []
        })
        .to_string()
        .into_bytes()
    }

    /// A fresh Mac failed at Start with "stopped with an error partway through": Docker had 10
    /// CPUs and 20.5 GiB, but its virtual disk was full, against the CLI's 40 GiB free. The CLI's
    /// `nextAction.reason` is only `local_command_failed`; its `error` says which resource is short,
    /// and the window is told that one.
    #[test]
    fn a_setup_the_cli_refused_for_resources_names_the_resource() {
        let none = Shortfall::default();
        let numbers = |cpus: &str, memory: &str, disk: &str| Shortfall {
            cpus: Some(cpus.into()),
            memory_gb: Some(memory.into()),
            disk_gb: Some(disk.into()),
            ..Shortfall::default()
        };
        for (code, message, short) in [
            (
                "LOCAL_DOCKER_RESOURCES_SHORT",
                "Docker available resources: 9.871234 CPUs (requires 4), 18.9 GiB RAM available (requires 4), 0 GiB free storage (requires 40). Stop other container workloads or increase Docker resources, then retry local setup.",
                Shortfall { disk: true, ..numbers("9.8", "18.9", "0") },
            ),
            (
                "LOCAL_DOCKER_RESOURCES_SHORT",
                "Docker available resources: 3.71 CPUs (requires 4), 5.2 GiB RAM available (requires 4), 51 GiB free storage (requires 40). Stop other container workloads or increase Docker resources, then retry local setup.",
                Shortfall { cpu: true, ..numbers("3.7", "5.2", "51") },
            ),
            (
                "LOCAL_DOCKER_RESOURCES_SHORT",
                "Docker available resources: 3.5 CPUs (requires 4), 2.9 GiB RAM available (requires 4), 12 GiB free storage (requires 40). Docker memory: 3.8 GiB total, 2.9 GiB available to new containers (requires 4 GiB available). Docker keeps part of its memory limit for itself, so raise Docker's memory limit by at least 3 GiB (Docker Desktop: Settings > Resources > Memory), or stop other containers, raise the CPUs or storage named above, then retry local setup.",
                Shortfall { cpu: true, memory: true, disk: true, ..numbers("3.5", "2.9", "12") },
            ),
            (
                "LOCAL_DOCKER_MEMORY_SHORT",
                "Docker memory: 7.6 GiB total, 2.9 GiB available to new containers (requires 4 GiB available). Docker keeps part of its memory limit for itself, so raise Docker's memory limit by at least 3 GiB (Docker Desktop: Settings > Resources > Memory), or stop other containers, then retry local setup.",
                Shortfall { memory: true, memory_gb: Some("2.9".into()), ..none.clone() },
            ),
        ] {
            let report = normalize_setup(1, &refused_for_resources(code, message)).unwrap();
            assert_eq!(report.outcome, Outcome::Failed);
            assert_eq!(report.reason, Some(Reason::ResourcesShort), "{message}");
            assert_eq!(report.shortfall, Some(short), "{message}");
        }
        let disk = normalize_setup(
            1,
            &refused_for_resources(
                "LOCAL_DOCKER_RESOURCES_SHORT",
                "Docker available resources: 9.871234 CPUs (requires 4), 18.9 GiB RAM available (requires 4), 0 GiB free storage (requires 40). Stop other container workloads or increase Docker resources, then retry local setup.",
            ),
        )
        .unwrap();
        let wire = serde_json::to_value(&disk).unwrap();
        assert_eq!(wire["reason"], json!("resources-short"));
        assert_eq!(
            wire["shortfall"],
            json!({
                "podman": false, "cpu": false, "memory": false, "disk": true,
                "cpus": "9.8", "memoryGb": "18.9", "diskGb": "0"
            })
        );
        // A probe that measured nothing is not a shortfall the person can fix in Settings.
        let unmeasurable = normalize_setup(
            1,
            &refused_for_resources(
                "LOCAL_DOCKER_RESOURCES_UNMEASURABLE",
                "Docker available memory or storage could not be measured. Check the container engine, then retry local setup.",
            ),
        )
        .unwrap();
        assert_eq!(unmeasurable.reason, Some(Reason::LocalCommandFailed));
        assert_eq!(unmeasurable.shortfall, None);
        assert!(serde_json::to_value(&unmeasurable)
            .unwrap()
            .get("shortfall")
            .is_none());
    }

    /// The onboarding check stops only an engine that can never pass the CLI's check at Start:
    /// fewer than 4 CPUs, under 4 GiB of memory, or under 40 GiB of free disk. OpenBot's own
    /// 4 CPU, 6 GiB Podman machine passes. Free disk is measured as the CLI measures it, with
    /// `df -Pk /` in a container.
    #[test]
    fn a_small_or_full_engine_is_caught_before_local_setup() {
        const GB: u64 = 1_000_000_000;
        let roomy = Some(100 * GB);
        // `docker info --format '{{.NCPU}} {{.MemTotal}}'` on Docker Desktop.
        for (said, free, cpu, memory, disk) in [
            // OpenBot's own Podman machine: 4 CPUs and 6144 MiB, as `podman info` reports it. The
            // CLI's check passes on it, so this check must too.
            (
                "4 6262661120
",
                roomy,
                false,
                false,
                false,
            ),
            // 4 CPUs and 8 GB, as Docker Desktop reports an 8 GB limit.
            (
                "4 8217473024
",
                roomy,
                false,
                false,
                false,
            ),
            // Fewer than 4 CPUs can never leave the CLI 4 free ones.
            (
                "3 8217473024
",
                roomy,
                true,
                false,
                false,
            ),
            (
                "6 4113829888
",
                roomy,
                false,
                true,
                false,
            ),
            // 10 CPUs and 20.5 GiB with a full disk: the case that happened.
            (
                "10 22011707392
",
                Some(0),
                false,
                false,
                true,
            ),
            (
                "10 22011707392
",
                Some(39 * GIB),
                false,
                false,
                true,
            ),
            // 6 CPUs, 8 GB and 40 GiB free, and a larger one, are enough.
            (
                "6 8217473024
",
                Some(40 * GIB),
                false,
                false,
                false,
            ),
            (
                "18 16745730048
",
                roomy,
                false,
                false,
                false,
            ),
            // Free disk that could not be measured is not judged.
            (
                "18 16745730048
",
                None,
                false,
                false,
                false,
            ),
        ] {
            let (cpus, bytes) = parse_engine_size(said).unwrap();
            let short = engine_shortfall(cpus, bytes, free);
            assert_eq!(
                (short.cpu, short.memory, short.disk),
                (cpu, memory, disk),
                "{said} {free:?}"
            );
        }
        assert!(!engine_shortfall(MIN_ENGINE_CPUS, 8 * GB, roomy).named());
        for unread in [
            "",
            "4",
            "four 8217473024",
            "4 8217473024 extra",
            "-1 8217473024",
        ] {
            assert_eq!(parse_engine_size(unread), None, "{unread:?}");
        }
        // `df -Pk /` inside a container on a full Docker Desktop disk, and on a roomy one.
        assert_eq!(
            parse_free_disk(
                "Filesystem     1024-blocks      Used Available Capacity Mounted on
overlay          100597760 100597760         0     100% /
"
            ),
            Some(0)
        );
        assert_eq!(
            parse_free_disk(
                "Filesystem 1024-blocks Used Available Capacity Mounted on
overlay 164506208 20481024 135620148 14% /
"
            ),
            Some(135_620_148 * 1024)
        );
        assert_eq!(
            parse_free_disk(
                "df: /: No such file or directory
"
            ),
            None
        );
        assert_eq!(
            serde_json::to_value(Terms::EngineTooSmall {
                podman: false,
                cpu: false,
                memory: false,
                disk: true,
                wsl: false,
                drive: None,
                measured: EngineMeasure {
                    cpus: 8,
                    memory_bytes: 8 * GIB,
                    free_disk_bytes: Some(GIB),
                },
            })
            .unwrap(),
            json!({ "status": "engine-too-small", "podman": false, "cpu": false, "memory": false, "disk": true })
        );
        assert_eq!(
            serde_json::to_value(Terms::EngineTooSmall {
                podman: true,
                cpu: false,
                memory: false,
                disk: true,
                wsl: true,
                drive: Some("C:".into()),
                measured: EngineMeasure::default(),
            })
            .unwrap(),
            json!({ "status": "engine-too-small", "podman": true, "cpu": false, "memory": false, "disk": true, "wsl": true, "drive": "C:" })
        );
    }

    /// A new Windows computer installs Podman while the person signs in, and the CLI will not say
    /// anything about the agreement until an engine answers. Those answers, as the CLI gave them on
    /// Windows, are "not yet", which the account screen waits out, not a failure it shows.
    #[test]
    fn terms_blocked_on_the_engine_are_not_ready_rather_than_failed() {
        for wire in [
            r#"{"command":"onboard local-terms","status":"blocked","preflight":{"status":"fail","reason":"docker_unavailable","detail":"Docker did not answer. Start Docker Desktop or the Docker service, and check that your user can run `docker info`, then try again."},"next":"Tell the developer `preflight.detail` in one sentence."}"#,
            r#"{"command":"onboard local-terms","status":"blocked","preflight":{"status":"fail","reason":"unsupported_engine","failureDetail":"engine_mismatch","detail":"The Docker address answers with Podman. Set COPILOTKIT_LOCAL_ENGINE=podman to use Podman, then retry."},"next":"Tell the developer `preflight.detail` in one sentence."}"#,
        ] {
            assert!(
                matches!(
                    normalize_terms(0, wire.as_bytes()),
                    Ok(Terms::EngineNotReady { .. })
                ),
                "{wire}"
            );
        }
        // The CLI's cause is for the log: the window is told only that the engine is not ready.
        assert_eq!(
            serde_json::to_value(Terms::EngineNotReady {
                cause: "docker_unavailable"
            })
            .unwrap(),
            serde_json::json!({ "status": "engine-not-ready" })
        );
        // Blocked for anything but the engine is still not an answer.
        assert_eq!(
            normalize_terms(
                0,
                br#"{"command":"onboard local-terms","status":"blocked"}"#
            ),
            Err(Failure::InvalidStatus)
        );
    }

    /**
    1.0.0 on a new Mac: the Account step said "Checking your CopilotKit account…" for minutes while
    Install put Podman in, and the desktop log said nothing about why. The CLI's answer for a Podman
    that does not answer yet is waited out, and the log says each change in what the step waits on
    once, not every 2 seconds. `local-eval-terms-no-engine.json` is what the window's test is given.
    */
    #[test]
    fn the_account_steps_wait_for_the_engine_is_logged_once_per_change() {
        let wire = include_str!("../test-fixtures/local-eval/onboard-local-terms-no-engine.json");
        let window: Value = serde_json::from_str(include_str!(
            "../test-fixtures/local-eval/local-eval-terms-no-engine.json"
        ))
        .unwrap();
        let no_engine = normalize_terms(0, wire.as_bytes());
        assert_eq!(
            serde_json::to_value(no_engine.clone().unwrap()).unwrap(),
            window
        );

        let start = Instant::now();
        let took = Duration::from_secs(1);
        let mut wait = AccountWait::default();
        let mut logged = Vec::new();
        let mut hear = |seconds: u64, answer: &Result<Terms, Failure>, step: Option<&str>| {
            logged.extend(wait.heard(start + Duration::from_secs(seconds), took, answer, step));
        };
        // As on that Mac: Podman installing, its machine made and started, then the engine answers.
        hear(1, &no_engine, Some("install-engine"));
        hear(4, &no_engine, Some("install-engine"));
        hear(7, &no_engine, Some("install-engine"));
        hear(121, &no_engine, Some("create-machine"));
        hear(124, &no_engine, Some("create-machine"));
        hear(179, &no_engine, Some("start-machine"));
        hear(193, &Ok(Terms::SignedOut), Some("images"));
        // Checks with no wait in them say what they answered, and how long the CLI took.
        hear(500, &Ok(Terms::SignedOut), None);
        hear(540, &Err(Failure::Timeout), None);
        assert_eq!(
            logged,
            [
                "[account] waiting for the engine before the sign-in check: the CLI's preflight \
                 says docker_unavailable; install step: install-engine",
                "[account] still waiting for the engine after 121s (4 checks); install step: \
                 create-machine",
                "[account] still waiting for the engine after 179s (6 checks); install step: \
                 start-machine",
                "[account] engine answering after 193s (7 checks); sign-in check answered \
                 signed-out after 1.0s",
                "[account] sign-in check answered signed-out after 1.0s",
                "[account] sign-in check failed after 1.0s: Timeout",
            ]
        );
    }

    /**
    1.0.0 on a Mac whose Docker is OrbStack: the CLI's preflight refuses the engine on every try,
    and the account step waited 15 minutes for an engine that was already running, then said only
    that it couldn't check the account. A refusal waiting cannot change is said at once, in the
    CLI's own sentence. `local-eval-terms-orbstack.json` is what the window's own test is given.
    */
    #[test]
    fn terms_blocked_on_an_engine_local_setup_does_not_run_on_say_so_at_once() {
        let wire = include_str!("../test-fixtures/local-eval/onboard-local-terms-orbstack.json");
        let window: Value = serde_json::from_str(include_str!(
            "../test-fixtures/local-eval/local-eval-terms-orbstack.json"
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value(normalize_terms(0, wire.as_bytes()).unwrap()).unwrap(),
            window
        );

        let blocked = |preflight: Value| {
            let wire = json!({ "command": "onboard local-terms", "status": "blocked", "preflight": preflight });
            serde_json::to_value(normalize_terms(0, wire.to_string().as_bytes()).unwrap()).unwrap()
        };
        // An engine setting the CLI names its own fix for is not told to switch engines.
        assert_eq!(
            blocked(json!({
                "status": "fail",
                "reason": "unsupported_engine",
                "failureDetail": "rootless",
                "detail": "Rootless Podman is not supported. Switch to rootful Podman (podman machine stop; podman machine set --rootful; podman machine start), then retry."
            })),
            json!({
                "status": "blocked",
                "reason": "unsupported-engine",
                "said": "Rootless Podman is not supported. Switch to rootful Podman (podman machine stop; podman machine set --rootful; podman machine start), then retry."
            })
        );
        // Too few CPUs is not waited out either. A reason this build does not know stays unknown.
        assert_eq!(
            blocked(json!({
                "status": "fail",
                "reason": "cpu_short",
                "detail": "Docker has 2 CPUs. Local evaluation needs 4."
            })),
            json!({
                "status": "blocked",
                "reason": "unrecognized",
                "said": "Docker has 2 CPUs. Local evaluation needs 4."
            })
        );
        // A sentence that is not one plain line is not shown; the window says its own.
        assert_eq!(
            blocked(json!({
                "status": "fail",
                "reason": "unsupported_engine",
                "failureDetail": "engine_not_docker_desktop",
                "detail": "Docker Desktop is required.\u{1b}[31m"
            })),
            json!({ "status": "blocked", "reason": "unsupported-engine", "switchEngine": true })
        );
        assert_eq!(
            blocked(json!({
                "status": "fail",
                "reason": "unsupported_engine",
                "failureDetail": "engine_not_docker_desktop",
                "detail": "x".repeat(401)
            })),
            json!({ "status": "blocked", "reason": "unsupported-engine", "switchEngine": true })
        );
    }

    #[test]
    fn terms_keep_the_agreement_and_nothing_the_cli_says_around_it() {
        let required = r#"{"command":"onboard local-terms","status":"required","accepted":false,"version":"developer-edition-2026-10-01-web","url":"https://copilotkit.ai/legal/developer-edition","organizationId":"org_1","organizationName":"CopilotKit🪁","next":"Ask the developer to accept."}"#
            .as_bytes();
        assert_eq!(
            normalize_terms(0, required),
            Ok(Terms::Required {
                accepted: false,
                version: "developer-edition-2026-10-01-web".into(),
                url: "https://copilotkit.ai/legal/developer-edition".into(),
                organization_name: "CopilotKit🪁".into(),
            })
        );
        for status in ["not-required", "unavailable", "signed-out"] {
            let wire = format!(r#"{{"command":"onboard local-terms","status":"{status}"}}"#);
            assert!(normalize_terms(0, wire.as_bytes()).is_ok(), "{status}");
        }
        for (wire, failure) in [
            (
                r#"{"command":"onboard local-terms","status":"required","accepted":false,"version":"v1","url":"http://copilotkit.ai/x","organizationName":"o"}"#,
                Failure::InvalidStatus,
            ),
            (
                r#"{"command":"onboard local-terms","status":"required","accepted":false,"version":"--json","url":"https://copilotkit.ai/x","organizationName":"o"}"#,
                Failure::InvalidStatus,
            ),
            (
                r#"{"command":"onboard local-terms","status":"required","accepted":false,"version":"v1","url":"https://copilotkit.ai/x","organizationName":"a\nb"}"#,
                Failure::InvalidStatus,
            ),
            (
                r#"{"command":"local setup","status":"required"}"#,
                Failure::UnexpectedCommand,
            ),
        ] {
            assert_eq!(normalize_terms(0, wire.as_bytes()), Err(failure), "{wire}");
        }
        assert_eq!(normalize_terms(1, b"{}"), Err(Failure::UnexpectedExit));
    }

    #[test]
    fn the_window_reads_terms_in_the_clis_own_words() {
        for (terms, status) in [
            (Terms::SignedOut, "signed-out"),
            (Terms::NotRequired, "not-required"),
            (Terms::Unavailable, "unavailable"),
        ] {
            assert_eq!(
                serde_json::to_value(terms).unwrap(),
                serde_json::json!({ "status": status })
            );
        }
        assert_eq!(
            serde_json::to_value(Terms::Required {
                accepted: false,
                version: "v1".into(),
                url: "https://copilotkit.ai/x".into(),
                organization_name: "o".into(),
            })
            .unwrap(),
            serde_json::json!({
                "status": "required",
                "accepted": false,
                "version": "v1",
                "url": "https://copilotkit.ai/x",
                "organizationName": "o",
            })
        );
    }

    #[test]
    fn a_build_without_a_bundled_cli_finds_none() {
        // This test build was not made with OPENBOT_BUNDLED_CLI=1.
        assert!(option_env!("OPENBOT_BUNDLED_CLI_PROGRAM_SHA256").is_none());
        assert!(bundled_cli().is_none());
        assert!(bundled_cli_root().is_some());
    }

    /**
    A container engine as `local start` meets it, put on PATH as `docker` or `podman`. It answers
    what OpenBot asks before and after a start with what the real one prints, from files beside it:
    `info --format` (`info`), `image ls --quiet --no-trunc` (`images`), `df -Pk /` in a container
    (`df`), `kubectl get nodes -o json` in the stack's node (`nodes`) and `machine inspect`
    (`inspect`). A node or a file that is not there fails as the engine does.
    */
    const FAKE_ENGINE: &str = r#"
use std::io::Write;
fn main() {
    let exe = std::env::current_exe().unwrap();
    let dir = exe.parent().unwrap().to_path_buf();
    let name = exe.file_stem().unwrap().to_string_lossy().into_owned();
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut asked = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("asked")).unwrap();
    writeln!(asked, "{} {}", name, args.join(" ")).unwrap();
    while matches!(args.first().map(String::as_str), Some("--connection" | "--url" | "--context" | "--host")) {
        args.drain(..2.min(args.len()));
    }
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let file = match a.as_slice() {
        ["info", "--format", format] if format.contains("Version") => "version",
        ["system", "df"] => "system-df",
        ["info", "--format", _] => "info",
        ["image", "ls", "--quiet", "--no-trunc"] => "images",
        ["run", "--rm", "--pull=never", "--network=none", "--entrypoint", "/bin/sh", _, "-c", "df -Pk /"] => "df",
        ["exec", "k3d-local-abc123-server-0", "kubectl", "get", "nodes", ..] => "nodes",
        ["machine", "inspect", "openbot"] => "inspect",
        _ => "",
    };
    // An engine that hangs: `<file>.hang` beside it, and that answer never comes.
    if !file.is_empty() && dir.join(format!("{file}.hang")).exists() {
        std::thread::sleep(std::time::Duration::from_secs(120));
    }
    if let Some(bytes) = (!file.is_empty()).then(|| std::fs::read(dir.join(file)).ok()).flatten() {
        std::io::stdout().write_all(&bytes).unwrap();
        return;
    }
    if a.first() == Some(&"exec") {
        let node = a.get(1).copied().unwrap_or_default();
        if name == "podman" {
            eprintln!("Error: no container with name or ID \"{node}\" found: no such container");
            std::process::exit(125);
        }
        eprintln!("Error response from daemon: No such container: {node}");
        std::process::exit(1);
    }
    eprintln!("Error: unknown command {a:?}");
    std::process::exit(125);
}
"#;

    /// Every entry logged in this process. Only a test that runs alone in its process
    /// (`isolated_process`) installs it.
    static LOGGED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

    struct Keep;

    impl log::Log for Keep {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }
        fn log(&self, record: &log::Record) {
            LOGGED
                .lock()
                .unwrap()
                .push(format!("{} {}", record.level(), record.args()));
        }
        fn flush(&self) {}
    }

    /// The `[local check]` entries logged since the last call, taken.
    fn checks_logged() -> Vec<String> {
        std::mem::take(&mut *LOGGED.lock().unwrap())
            .into_iter()
            .filter(|entry| entry.contains("[local check]"))
            .collect()
    }

    /// `docker info --format '{{.NCPU}} {{.MemTotal}}'` on a Mac's Docker Desktop with 10 CPUs and
    /// 20.5 GiB, and `podman info --format '{{.Host.CPUs}} {{.Host.MemTotal}}'` on OpenBot's own
    /// Podman machine, 4 CPUs and 6144 MiB.
    const DOCKER_INFO: &str = "10 22011707392\n";
    const PODMAN_INFO: &str = "4 6262661120\n";

    /// `df -Pk /` in a container, as busybox prints it: a disk of `size` KiB with `free` KiB free.
    fn df(size: u64, free: u64) -> String {
        let used = size - free - size / 20;
        format!(
            "Filesystem           1024-blocks    Used Available Capacity Mounted on\noverlay              {size} {used} {free} {}% /\n",
            used * 100 / (used + free)
        )
    }

    const KIB_PER_GIB: u64 = 1024 * 1024;
    /// OpenBot's Podman machine on WSL: a sparse virtual disk of about a terabyte.
    const WSL_DISK: u64 = 1_055_762_868;

    /// `kubectl get nodes -o json` in the stack's node, as k3s v1.31.5 printed it, with its
    /// `DiskPressure` condition as the kubelet sets it when `pressure`.
    fn nodes(pressure: bool) -> String {
        let mut nodes: Value = serde_json::from_str(include_str!(
            "../test-fixtures/local-eval/k3s-v1.31.5-get-nodes.json"
        ))
        .unwrap();
        if pressure {
            for condition in nodes["items"][0]["status"]["conditions"]
                .as_array_mut()
                .unwrap()
            {
                if condition["type"] == "DiskPressure" {
                    condition["status"] = json!("True");
                    condition["reason"] = json!("KubeletHasDiskPressure");
                    condition["message"] = json!("kubelet has disk pressure");
                }
            }
        }
        serde_json::to_string_pretty(&nodes).unwrap()
    }

    /// `podman machine inspect openbot` for OpenBot's own rootful machine on WSL, as Podman 5
    /// prints it on Windows.
    const WSL_INSPECT: &str = r#"[
     {
          "ConfigDir": {
               "Path": "C:\\Users\\me\\.config\\containers\\podman\\machine\\wsl"
          },
          "ConnectionInfo": {
               "PodmanSocket": null,
               "PodmanPipe": {
                    "Path": "\\\\.\\pipe\\podman-openbot"
               }
          },
          "Created": "2026-11-02T09:14:03.4719262-08:00",
          "LastUp": "2026-11-09T08:02:51.1063417-08:00",
          "Name": "openbot",
          "Resources": {
               "CPUs": 4,
               "DiskSize": 100,
               "Memory": 6144,
               "USBs": []
          },
          "SSHConfig": {
               "IdentityPath": "C:\\Users\\me\\.local\\share\\containers\\podman\\machine\\machine",
               "Port": 61842,
               "RemoteUsername": "user"
          },
          "State": "running",
          "UserModeNetworking": true,
          "Rootful": true,
          "Rosetta": false
     }
]
"#;

    /// `local start` as the pinned CLI (4.34.0-pre.647a03b) reports a start that stopped in
    /// `stack-services-ready`, the step that waits for the back end's deployments.
    fn start_failed() -> String {
        json!({
            "version": 1,
            "command": "local start",
            "status": "failed",
            "error": {
                "code": "LOCAL_COMMAND_FAILED",
                "message": "Local stack-services-ready failed (exit 1). Run `copilotkit local status` and retry the failed step."
            },
            "nextAction": {
                "reason": "local_command_failed",
                "summary": "The local command did not finish. Check local status for the recorded failed step, then resume the command. No automatic rollback was requested.",
                "instructions": ["Inspect the recorded stack with npx --yes copilotkit@4.34.0-pre.647a03b local status --json."],
                "resumeCommand": "npx --yes copilotkit@4.34.0-pre.647a03b local start --json",
                "url": null, "linkLabel": null, "linkFile": null,
                "caveats": [], "requiredEnvVars": [], "artifacts": []
            },
            "diagnostics": []
        })
        .to_string()
    }

    fn start_completed() -> String {
        let mut done = envelope();
        done["command"] = json!("local start");
        done.to_string()
    }

    /**
    An engine and a CLI for `local start` through `run_installed`, the window's own path. The engine
    is `engine` on PATH answering with `answers` (`FAKE_ENGINE`), and named to the CLI as OpenBot
    names it; the CLI is pinned as a developer pins one. Windows' answer for the drive that holds a
    Podman machine's disk is `drive`. Sets process environment: only for a test in its own process.
    */
    struct StartLab {
        fixture: Fixture,
        bin: PathBuf,
    }

    impl StartLab {
        fn new(label: &str) -> Self {
            let fixture = Fixture::new(label, "0\n{}");
            let bin = fixture.root.join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            let source = fixture.root.join("engine.rs");
            std::fs::write(&source, FAKE_ENGINE).unwrap();
            for engine in ["docker", "podman"] {
                compile_fixture(
                    &source,
                    &bin.join(format!("{engine}{}", std::env::consts::EXE_SUFFIX)),
                );
            }
            std::env::set_var(
                "PATH",
                std::env::join_paths(std::iter::once(bin.clone()).chain(std::env::split_paths(
                    &std::env::var_os("PATH").unwrap_or_default(),
                )))
                .unwrap(),
            );
            std::env::set_var(DEVELOPER_PROGRAM, &fixture.program);
            std::env::set_var(DEVELOPER_PROGRAM_SHA256, sha256(&fixture.program));
            let _ = log::set_boxed_logger(Box::new(Keep));
            log::set_max_level(log::LevelFilter::Info);
            Self { fixture, bin }
        }

        /// The engine as it answers now, and how `local start` ends.
        fn engine(
            &self,
            engine: crate::engine::Engine,
            info: &str,
            df: &str,
            nodes: Option<&str>,
            drive: Option<crate::windows::MachineDrive>,
        ) {
            let write = |file: &str, said: Option<&str>| match said {
                Some(said) => std::fs::write(self.bin.join(file), said).unwrap(),
                None => {
                    let _ = std::fs::remove_file(self.bin.join(file));
                }
            };
            write("info", Some(info));
            // `image ls --quiet --no-trunc`: the k3d tools image, which has a shell.
            write(
                "images",
                Some("sha256:3a68d8567335f56c168c36b53059c5dd4dfe23c2edbf4d9251e9ed3170dfacd8\n"),
            );
            write("df", Some(df));
            write("nodes", nodes);
            write("inspect", Some(WSL_INSPECT));
            use_engine(&match engine {
                crate::engine::Engine::Docker => crate::engine::Address::new(engine, None),
                crate::engine::Engine::Podman => {
                    crate::engine::Address::new(engine, Some("openbot-root".into()))
                }
            });
            MACHINE_DRIVE.with(|said| *said.borrow_mut() = Some(drive));
        }

        fn start(&self, ends: &str) -> Report {
            self.run(Action::Start, ends)
        }

        /// `action` through the window's path, answered with `ends`.
        fn run(&self, action: Action, ends: &str) -> Report {
            std::fs::write(self.fixture.root.join("scenario"), ends).unwrap();
            let stack = StackId::parse("local-abc123").unwrap();
            let report = run_installed("checked", action, &stack).unwrap();
            assert_eq!(
                self.fixture.argv().unwrap(),
                format!("local\n{}\n--stack\nlocal-abc123\n--json", action.as_str())
            );
            report
        }
    }

    /**
    An engine that stops answering, on the account step. `docker info`, `docker image ls` and the
    `docker run` that measures disk had no time limit, so a hung engine left the step on
    "Checking your CopilotKit account…" for good. Each has its own limit now, and what did not
    answer is not measured, as when nothing answers at all: the CLI is asked next.
    */
    #[test]
    fn an_engine_that_hangs_is_not_measured_and_does_not_hold_the_account_step() {
        if crate::test_support::isolated_process(
            "local_eval::tests::an_engine_that_hangs_is_not_measured_and_does_not_hold_the_account_step",
        ) {
            return;
        }
        let lab = StartLab::new("engine-check-hangs");
        lab.engine(
            crate::engine::Engine::Docker,
            DOCKER_INFO,
            &df(WSL_DISK, 500 * KIB_PER_GIB),
            None,
            None,
        );
        // Long enough for the fake engine to answer on a busy test machine, far short of a hang.
        *ENGINE_CHECK_LIMIT_FOR_TESTS.lock().unwrap() = Some(Duration::from_secs(3));
        let checked = |hangs: &[&str]| {
            for file in ["info", "images", "df"] {
                let _ = std::fs::remove_file(lab.bin.join(format!("{file}.hang")));
            }
            for file in hangs {
                std::fs::write(lab.bin.join(format!("{file}.hang")), "").unwrap();
            }
            let (sender, received) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = sender.send(engine_size_terms());
            });
            received
                .recv_timeout(Duration::from_secs(30))
                .unwrap_or_else(|_| {
                    panic!("the engine check waited on an engine hung in {hangs:?}")
                })
        };
        // Nothing answers, so nothing is measured and nothing stops the step.
        assert_eq!(checked(&["info", "images"]), None);
        // Its disk check hangs: a small engine is still said small, from what it did answer.
        std::fs::write(lab.bin.join("info"), "2 22011707392\n").unwrap();
        assert_eq!(
            checked(&["df"]),
            Some(Terms::EngineTooSmall {
                podman: false,
                cpu: true,
                memory: false,
                disk: false,
                wsl: false,
                drive: None,
                measured: EngineMeasure {
                    cpus: 2,
                    memory_bytes: 22011707392,
                    free_disk_bytes: None,
                },
            })
        );
    }

    /**
    Troubleshooting logs from a Mac whose Docker disk is full, the case they were made for: the
    engine's version and its numbers as `[local check]` measures them, both log tails, and the CLI's
    sign-in line with its email and ids taken out.
    */
    #[test]
    fn troubleshooting_logs_carry_both_log_tails_and_the_engines_numbers() {
        if crate::test_support::isolated_process(
            "local_eval::tests::troubleshooting_logs_carry_both_log_tails_and_the_engines_numbers",
        ) {
            return;
        }
        let lab = StartLab::new("troubleshooting-logs");
        lab.engine(
            crate::engine::Engine::Docker,
            DOCKER_INFO,
            &df(WSL_DISK, 0),
            None,
            None,
        );
        std::fs::write(lab.bin.join("version"), "28.5.1\n").unwrap();
        std::fs::write(
            lab.bin.join("system-df"),
            "TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE\nImages          14        3         18.2GB    12.1GB (66%)\n",
        )
        .unwrap();
        let home = lab.fixture.root.join("home");
        std::fs::create_dir_all(home.join(".copilotkit")).unwrap();
        std::fs::write(
            home.join(".copilotkit").join("cli.log"),
            concat!(
                r#"{"level":30,"time":"2026-11-08T10:12:01.004Z","event":"auth.signed_in","email":"dana.rivera@acme-robotics.io","organizationId":"org_2xK9pQ7vLm","userId":"user_31aZ"}"#,
                "\n",
                r#"{"level":50,"time":"2026-11-08T10:15:39.900Z","event":"local.step.failed","step":"stack-images","message":"write /var/lib/docker/tmp/GetImageBlob123: no space left on device"}"#,
                "\n",
            ),
        )
        .unwrap();
        let logs = lab.fixture.root.join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(
            logs.join("openbot-desktop.log"),
            "2026-11-08T10:15:40.003Z ERROR [local setup] failed after 88.1s: exit 1\n",
        )
        .unwrap();
        let home = home.to_string_lossy().into_owned();

        let text = crate::troubleshooting::gather(crate::troubleshooting::Sources {
            desktop: "OpenBot Desktop 1.0.0 (Built 2026-11-08 06:40 UTC from 52ea4b5)".into(),
            failure: Some("The backend could not start.".into()),
            log_folder: Some(&logs),
            home: Some(&home),
            engine: engine_in_use(),
        });

        // `~/.copilotkit/cli.log`, with Windows' separators on Windows.
        let cli_log = format!("~{0}.copilotkit{0}cli.log", std::path::MAIN_SEPARATOR);
        for expected in [
            "Failed: The backend could not start.",
            "Container engine: docker 28.5.1. 10 CPUs and 20.5 GiB of memory, 0 GiB free of 1006.8 GiB in a container; short of disk (nearly full).",
            "$ docker system df\nTYPE",
            "Images          14        3         18.2GB    12.1GB (66%)",
            "[local setup] failed after 88.1s: exit 1",
            &cli_log,
            "no space left on device",
            r#""email":"[email]","organizationId":"[id]","userId":"[id]""#,
        ] {
            assert!(text.contains(expected), "missing {expected:?} in\n{text}");
        }
        for secret in [
            "dana.rivera@acme-robotics.io",
            "org_2xK9pQ7vLm",
            "user_31aZ",
            &home,
        ] {
            assert!(!text.contains(secret), "{secret} survived in\n{text}");
        }
    }

    /// Windows' answer for drive C: with `tenths` tenths of a GiB free, and a little more.
    fn drive(tenths: u64) -> Option<crate::windows::MachineDrive> {
        Some(crate::windows::MachineDrive {
            drive: Some("C:".into()),
            free: tenths * GIB / 10 + GIB / 100,
        })
    }

    /**
    1.0.0 on Windows, a used install on OpenBot's own Podman machine with 30.5 GiB free inside it:
    Quit, then a relaunch. The CLI checks resources only at a first setup, and an existing back end
    can run on less than its 40 GiB, so a start that finishes is let through. The log warns, with the
    numbers, and nothing else changes.
    */
    #[test]
    fn a_used_install_short_of_disk_still_starts_and_the_log_warns() {
        if crate::test_support::isolated_process(
            "local_eval::tests::a_used_install_short_of_disk_still_starts_and_the_log_warns",
        ) {
            return;
        }
        let lab = StartLab::new("start-short-of-disk-warns");
        lab.engine(
            crate::engine::Engine::Podman,
            PODMAN_INFO,
            &df(WSL_DISK, 30 * KIB_PER_GIB + KIB_PER_GIB / 2),
            Some(&nodes(false)),
            drive(946),
        );
        let report = lab.start(&format!("0\n{}", start_completed()));
        let wire = serde_json::to_value(&report).unwrap();
        assert_eq!(wire["outcome"], json!("completed"));
        assert_eq!(wire["reason"], Value::Null);
        assert!(wire.get("shortfall").is_none(), "{wire}");
        assert_eq!(
            checks_logged(),
            ["WARN [local check] before local start: 4 CPUs and 5.8 GiB of memory, 30.5 GiB free of 1006.8 GiB in a container, 94.6 GiB free on C:; short of disk (nearly full)"]
        );
    }

    /**
    The same start, failed: the card said only "The back end stopped with an error partway through"
    while k3s, short of disk, had removed 13 of the back end's 15 images. A start that fails is
    checked again with the node asked, and the report names the disk with its numbers, for Podman on
    Windows, and for Docker short of the CLI's 40 GiB or with its node under disk pressure.
    */
    #[test]
    fn a_start_that_fails_short_of_disk_names_the_disk_with_its_numbers() {
        if crate::test_support::isolated_process(
            "local_eval::tests::a_start_that_fails_short_of_disk_names_the_disk_with_its_numbers",
        ) {
            return;
        }
        let lab = StartLab::new("start-short-of-disk-named");
        let failed = format!("1\n{}", start_failed());

        lab.engine(
            crate::engine::Engine::Podman,
            PODMAN_INFO,
            &df(WSL_DISK, 30 * KIB_PER_GIB + KIB_PER_GIB / 2),
            Some(&nodes(true)),
            drive(946),
        );
        let wire = serde_json::to_value(lab.start(&failed)).unwrap();
        assert_eq!(wire["outcome"], json!("failed"));
        assert_eq!(wire["reason"], json!("resources-short"));
        assert_eq!(
            wire["shortfall"],
            json!({
                "podman": true, "cpu": false, "memory": false, "disk": true,
                "diskGb": "30.5", "nearlyFull": true, "diskSizeGb": "1006.8",
                "wsl": true, "drive": "C:"
            })
        );
        assert_eq!(
            checks_logged(),
            [
                "WARN [local check] before local start: 4 CPUs and 5.8 GiB of memory, 30.5 GiB free of 1006.8 GiB in a container, 94.6 GiB free on C:; short of disk (nearly full)",
                "WARN [local check] after local start failed: 4 CPUs and 5.8 GiB of memory, 30.5 GiB free of 1006.8 GiB in a container, 94.6 GiB free on C:, the node reports disk pressure; short of disk (nearly full)",
            ]
        );

        // Docker Desktop with 30 GiB of a 64 GiB disk free: below the CLI's 40 GiB.
        lab.engine(
            crate::engine::Engine::Docker,
            DOCKER_INFO,
            &df(64 * KIB_PER_GIB, 30 * KIB_PER_GIB),
            Some(&nodes(false)),
            None,
        );
        let wire = serde_json::to_value(lab.start(&failed)).unwrap();
        assert_eq!(wire["reason"], json!("resources-short"));
        assert_eq!(
            wire["shortfall"],
            json!({ "podman": false, "cpu": false, "memory": false, "disk": true, "diskGb": "30" })
        );
        assert_eq!(
            checks_logged().last().unwrap(),
            "WARN [local check] after local start failed: 10 CPUs and 20.5 GiB of memory, 30 GiB free of 64 GiB in a container, no disk pressure; short of disk (OpenBot needs 40 GiB free)"
        );

        // Docker on a 1.8 TiB disk with 160 GiB free, its node under DiskPressure: nearly full
        // by k3s's own line, though above the CLI's 40 GiB.
        lab.engine(
            crate::engine::Engine::Docker,
            DOCKER_INFO,
            &df(1_916_694_008, 160 * KIB_PER_GIB),
            Some(&nodes(true)),
            None,
        );
        let wire = serde_json::to_value(lab.start(&failed)).unwrap();
        assert_eq!(wire["reason"], json!("resources-short"));
        assert_eq!(
            wire["shortfall"],
            json!({
                "podman": false, "cpu": false, "memory": false, "disk": true,
                "diskGb": "160", "nearlyFull": true, "diskSizeGb": "1827.9"
            })
        );
        checks_logged();
    }

    /**
    Windows, once space was freed: k3s keeps its DiskPressure condition for five minutes after, and
    a Retry in those minutes failed again, three times over six minutes. A start that fails while
    the node still says DiskPressure, with the disk above both lines, says the back end is
    recovering, so the card can say to wait rather than to free more space.
    */
    #[test]
    fn a_start_that_fails_while_the_node_recovers_from_low_disk_says_so() {
        if crate::test_support::isolated_process(
            "local_eval::tests::a_start_that_fails_while_the_node_recovers_from_low_disk_says_so",
        ) {
            return;
        }
        let lab = StartLab::new("start-recovering");
        lab.engine(
            crate::engine::Engine::Podman,
            PODMAN_INFO,
            &df(WSL_DISK, 941 * KIB_PER_GIB),
            Some(&nodes(true)),
            drive(1200),
        );
        let wire = serde_json::to_value(lab.start(&format!("1\n{}", start_failed()))).unwrap();
        assert_eq!(wire["reason"], json!("resources-short"));
        assert_eq!(
            wire["shortfall"],
            json!({
                "podman": true, "cpu": false, "memory": false, "disk": false,
                "recovering": true, "wsl": true, "drive": "C:"
            })
        );
        assert_eq!(
            checks_logged().last().unwrap(),
            "WARN [local check] after local start failed: 4 CPUs and 5.8 GiB of memory, 941 GiB free of 1006.8 GiB in a container, 120 GiB free on C:, the node reports disk pressure; recovering: the node still reports disk pressure with the disk above both lines"
        );
    }

    /**
    On Windows the machine's disk is a sparse virtual disk of about a terabyte, so a container sees
    941 GiB free while the drive that holds it has 30. The drive is what runs out: it is checked,
    the smaller figure counts, and the card says to free space on that drive. The account step's
    check before a first setup reads the drive too.
    */
    #[test]
    fn on_windows_the_drive_under_podmans_disk_is_the_free_disk_that_counts() {
        if crate::test_support::isolated_process(
            "local_eval::tests::on_windows_the_drive_under_podmans_disk_is_the_free_disk_that_counts",
        ) {
            return;
        }
        let lab = StartLab::new("start-windows-drive");
        lab.engine(
            crate::engine::Engine::Podman,
            PODMAN_INFO,
            &df(WSL_DISK, 941 * KIB_PER_GIB),
            Some(&nodes(false)),
            drive(300),
        );
        let wire = serde_json::to_value(lab.start(&format!("1\n{}", start_failed()))).unwrap();
        assert_eq!(wire["reason"], json!("resources-short"));
        assert_eq!(
            wire["shortfall"],
            json!({
                "podman": true, "cpu": false, "memory": false, "disk": true,
                "diskGb": "30", "wsl": true, "drive": "C:"
            })
        );
        assert_eq!(
            checks_logged(),
            [
                "WARN [local check] before local start: 4 CPUs and 5.8 GiB of memory, 941 GiB free of 1006.8 GiB in a container, 30 GiB free on C:; short of disk (OpenBot needs 40 GiB free)",
                "WARN [local check] after local start failed: 4 CPUs and 5.8 GiB of memory, 941 GiB free of 1006.8 GiB in a container, 30 GiB free on C:, no disk pressure; short of disk (OpenBot needs 40 GiB free)",
            ]
        );
        assert_eq!(
            serde_json::to_value(engine_size_terms()).unwrap(),
            json!({
                "status": "engine-too-small", "podman": true, "cpu": false, "memory": false,
                "disk": true, "wsl": true, "drive": "C:"
            })
        );
    }

    /**
    OpenBot's own Podman machine, 4 CPUs and 6144 MiB, with room on its disk and its drive, passes:
    a start that finishes says so in the log, and one that fails for some other reason keeps its
    own words rather than being blamed on resources. The account step lets it through.
    */
    #[test]
    fn openbots_own_podman_machine_with_room_passes_the_check() {
        if crate::test_support::isolated_process(
            "local_eval::tests::openbots_own_podman_machine_with_room_passes_the_check",
        ) {
            return;
        }
        let lab = StartLab::new("start-roomy-podman");
        lab.engine(
            crate::engine::Engine::Podman,
            PODMAN_INFO,
            &df(WSL_DISK, 941 * KIB_PER_GIB),
            Some(&nodes(false)),
            drive(1200),
        );
        let started =
            serde_json::to_value(lab.start(&format!("0\n{}", start_completed()))).unwrap();
        assert_eq!(started["outcome"], json!("completed"));
        assert!(started.get("shortfall").is_none(), "{started}");
        let failed = serde_json::to_value(lab.start(&format!("1\n{}", start_failed()))).unwrap();
        assert_eq!(failed["reason"], json!("local-command-failed"));
        assert!(failed.get("shortfall").is_none(), "{failed}");
        let enough = "4 CPUs and 5.8 GiB of memory, 941 GiB free of 1006.8 GiB in a container, 120 GiB free on C:";
        assert_eq!(
            checks_logged(),
            [
                format!("INFO [local check] before local start: {enough}; enough"),
                format!("INFO [local check] before local start: {enough}; enough"),
                format!("INFO [local check] after local start failed: {enough}, no disk pressure; enough"),
            ]
        );
        assert_eq!(engine_size_terms(), None);
    }

    /// `local status` for a back end left up after a start that failed: its node runs, and the
    /// API and gateway do not answer. `passed` when every check passed, as with an update on record.
    fn status_degraded(passed: bool) -> String {
        let mut status = canonical("degraded", "valid", Value::Null);
        status["readiness"]["checks"] = json!([
            { "name": "api", "ok": passed },
            { "name": "gateway", "ok": passed },
            { "name": "dashboard", "ok": true }
        ]);
        format!("0\n{status}")
    }

    /**
    Windows, after space was freed: Retry read the back end's status, which said `degraded`, and the
    card said "The back end is running but not healthy." twice over two minutes while the node still
    reported DiskPressure. A back end that runs but does not answer is checked as a failed start is:
    recovering, nearly full, or nothing to say, in which case the report is as it was.
    */
    #[test]
    fn a_back_end_running_but_not_healthy_is_checked_for_its_disk() {
        if crate::test_support::isolated_process(
            "local_eval::tests::a_back_end_running_but_not_healthy_is_checked_for_its_disk",
        ) {
            return;
        }
        let lab = StartLab::new("status-degraded-checked");
        let degraded = status_degraded(false);

        // Space freed, the node still under DiskPressure.
        lab.engine(
            crate::engine::Engine::Podman,
            PODMAN_INFO,
            &df(WSL_DISK, 941 * KIB_PER_GIB),
            Some(&nodes(true)),
            drive(1200),
        );
        let wire = serde_json::to_value(lab.run(Action::Status, &degraded)).unwrap();
        assert_eq!(wire["readiness"], json!("degraded"));
        assert_eq!(wire["reason"], Value::Null);
        assert_eq!(
            wire["shortfall"],
            json!({
                "podman": true, "cpu": false, "memory": false, "disk": false,
                "recovering": true, "wsl": true, "drive": "C:"
            })
        );
        assert_eq!(
            checks_logged(),
            ["WARN [local check] local status, running but not healthy: 4 CPUs and 5.8 GiB of memory, 941 GiB free of 1006.8 GiB in a container, 120 GiB free on C:, the node reports disk pressure; recovering: the node still reports disk pressure with the disk above both lines"]
        );

        // Still nearly full.
        lab.engine(
            crate::engine::Engine::Podman,
            PODMAN_INFO,
            &df(WSL_DISK, 30 * KIB_PER_GIB + KIB_PER_GIB / 2),
            Some(&nodes(true)),
            drive(946),
        );
        let wire = serde_json::to_value(lab.run(Action::Status, &degraded)).unwrap();
        assert_eq!(
            wire["shortfall"],
            json!({
                "podman": true, "cpu": false, "memory": false, "disk": true,
                "diskGb": "30.5", "nearlyFull": true, "diskSizeGb": "1006.8",
                "wsl": true, "drive": "C:"
            })
        );

        // Room on the disk and no pressure: not the disk, and the report is as it was.
        lab.engine(
            crate::engine::Engine::Podman,
            PODMAN_INFO,
            &df(WSL_DISK, 941 * KIB_PER_GIB),
            Some(&nodes(false)),
            drive(1200),
        );
        let wire = serde_json::to_value(lab.run(Action::Status, &degraded)).unwrap();
        assert_eq!(wire["readiness"], json!("degraded"));
        assert!(wire.get("shortfall").is_none(), "{wire}");
        checks_logged();

        // Every check passed: an update on record, not a back end that does not answer.
        lab.engine(
            crate::engine::Engine::Podman,
            PODMAN_INFO,
            &df(WSL_DISK, 30 * KIB_PER_GIB),
            Some(&nodes(true)),
            drive(946),
        );
        let wire = serde_json::to_value(lab.run(Action::Status, &status_degraded(true))).unwrap();
        assert!(wire.get("shortfall").is_none(), "{wire}");
        assert_eq!(checks_logged(), Vec::<String>::new());
    }
}
