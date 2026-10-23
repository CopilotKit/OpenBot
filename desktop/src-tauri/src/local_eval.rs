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
//!   `--json`, plus the constant `list`, `setup` and `connect` lists, as separate arguments with no shell. The CLI's `resumeCommand` strings are text for a
//!   terminal user; they are dropped here and never executed.
//! - **Only allowlisted facts leave.** Raw stdout, stderr, error messages and recovery text never
//!   cross IPC or reach a log. Failures are static categories with no payload.
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
}

impl Action {
    fn as_str(self) -> &'static str {
        match self {
            Action::Status => "status",
            Action::Start => "start",
            Action::Stop => "stop",
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
    pub observed: Option<Observed>,
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

/// The evaluation agreement, read only: `onboard local-terms --json`.
pub const TERMS_ARGUMENTS: [&str; 3] = ["onboard", "local-terms", "--json"];

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
    Ok(Report {
        outcome,
        stack: reported_stack(outcome, wire)?,
        reason: reason(outcome, wire)?,
        readiness,
        licence,
        licence_expires_at,
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

/// Whether the CopilotKit account sign-in finished. The approval page address and its code stay
/// in the CLI and the browser; only the outcome is kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSignIn {
    pub signed_in: bool,
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

/// The evaluation agreement the licence needs, as the window shows it. No CLI prose is kept.
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
    match (outcome, wire.get("nextAction")) {
        (Outcome::Completed, _) | (_, None | Some(Value::Null)) => Ok(None),
        (_, Some(next)) => match object(next)?.get("reason") {
            Some(Value::String(reason)) => Ok(Some(Reason::from_wire(reason))),
            None | Some(Value::Null) => Ok(None),
            Some(_) => Err(Failure::InvalidStatus),
        },
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
        observed: observation(saved.get("observed"))?,
    })
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
        };
        Self {
            timeout,
            grace: Duration::from_secs(5),
            output: MAX_OUTPUT,
        }
    }

    /// `local setup` downloads a release and creates the cluster. 88 seconds on a warm machine
    /// with a fast connection; a first pull of every image is what this allows for.
    pub fn for_setup() -> Self {
        Self {
            timeout: Duration::from_secs(30 * 60),
            ..Self::for_action(Action::Start)
        }
    }

    /// The CopilotKit account sign-in waits on a person approving it in their browser.
    pub fn for_account_sign_in() -> Self {
        Self {
            timeout: Duration::from_secs(15 * 60),
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

/// `login --json`: the CopilotKit account sign-in.
pub fn account_sign_in(
    cli: &PinnedCli,
    limits: Limits,
    cancel: &Cancel,
) -> Result<AccountSignIn, Failure> {
    let (code, bytes) = execute(cli, &ACCOUNT_SIGN_IN_ARGUMENTS, None, limits, cancel)?;
    normalize_account_sign_in(code, &bytes)
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

/// The exit code and stdout of one bounded CLI process. Arguments come only from `arguments`,
/// `login_arguments`, `LIST_ARGUMENTS`, `setup_arguments`, `CONNECT_ARGUMENTS`,
/// `ACCOUNT_SIGN_IN_ARGUMENTS` and `TERMS_ARGUMENTS`; only setup and connect run somewhere other
/// than inherited.
fn execute(
    cli: &PinnedCli,
    arguments: &[&str],
    folder: Option<&std::path::Path>,
    limits: Limits,
    cancel: &Cancel,
) -> Result<(i32, Vec<u8>), Failure> {
    let output = Output::create()?;
    let mut command = crate::quiet::command(&cli.program);
    if let Some(entry) = &cli.entry {
        command.arg(entry);
    }
    command.env_clear();
    for name in INHERITED {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    // The CLI looks `docker` up by name. Opened from Finder, this app has the system's minimal
    // PATH, which does not reach Docker Desktop's `/usr/local/bin`; the CLI gets Docker's own
    // directory added.
    if let Some(path) = crate::engine::path_with_docker() {
        command.env("PATH", path);
    }
    if let Some(folder) = folder {
        command.current_dir(folder);
    }
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(output.file.try_clone().map_err(|_| Failure::Spawn)?)
        // stderr can carry anything a dependency prints. It is never read, so it is not kept.
        .stderr(Stdio::null());
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
    loop {
        if exited(&mut child)? {
            let code = child.wait().map_err(|_| Failure::Spawn)?.code();
            let bytes = output.read(limits.output)?;
            // A signal-terminated CLI has no code and no report.
            return Ok((code.ok_or(Failure::UnexpectedExit)?, bytes));
        }
        if output.len() > limits.output as u64 {
            return Err(stop_tree(&mut child, limits.grace, Failure::OutputLimit));
        }
        if cancel.requested() {
            return Err(stop_tree(&mut child, limits.grace, Failure::Cancelled));
        }
        if Instant::now() >= deadline {
            return Err(stop_tree(&mut child, limits.grace, Failure::Timeout));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
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
    QUITTING.store(true, Ordering::SeqCst);
    cancel_all();
    // Cancelling only asks: each call stops its CLI's process tree on its own thread, and the CLI
    // forwards SIGTERM to its children rather than exiting, so the tree goes at SIGKILL, after the
    // grace. An app that exits before then leaves it running with nobody to stop it.
    wait_until_stopped(Duration::from_secs(10));
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

/// Waits, at most `patience`, until no CLI process tree is running. True when none is.
fn wait_until_stopped(patience: Duration) -> bool {
    let until = Instant::now() + patience;
    while RUNNING.load(Ordering::SeqCst) > 0 {
        if Instant::now() >= until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    true
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
    run_attempt(Attempt::register(attempt), action, stack, limits)
}

/// `stop` for Stop or Quit itself: the one call let through while closing. A later Quit still
/// cancels it.
pub fn stop_for_shutdown(
    attempt: &str,
    stack: &StackId,
    limits: Limits,
) -> Result<Report, Failure> {
    run_attempt(
        Attempt::register_for_shutdown(attempt),
        Action::Stop,
        stack,
        limits,
    )
}

fn run_attempt(
    attempt: Attempt,
    action: Action,
    stack: &StackId,
    limits: Limits,
) -> Result<Report, Failure> {
    one_at_a_time(&attempt.0, limits, |limits| {
        let cli = installed()?;
        run(&cli, action, stack, limits, &attempt.0)
    })
}

/// `local setup` in `installation` against the installed CLI, in its turn like every other call.
/// The digest of the CLI that ran comes back with the report, so the caller records which one.
pub fn setup_installed(
    attempt: &str,
    installation: &std::path::Path,
    accepted: Option<&EulaVersion>,
) -> Result<(Report, String), Failure> {
    let attempt = Attempt::register(attempt);
    one_at_a_time(&attempt.0, Limits::for_setup(), |limits| {
        let cli = installed()?;
        let report = setup(&cli, installation, accepted, limits, &attempt.0)?;
        Ok((report, cli.sha256().to_owned()))
    })
}

/// The CopilotKit account sign-in against the installed CLI.
pub fn account_sign_in_installed(attempt: &str) -> Result<AccountSignIn, Failure> {
    let attempt = Attempt::register(attempt);
    one_at_a_time(&attempt.0, Limits::for_account_sign_in(), |limits| {
        let cli = installed()?;
        account_sign_in(&cli, limits, &attempt.0)
    })
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
        assert_eq!(
            fixture.argv().unwrap(),
            "local\nsetup\n--defer-model\n--json"
        );
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("cwd")).unwrap(),
            installation.canonicalize().unwrap().display().to_string()
        );
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
            "local\nconnect\n--approve-connection\n--json"
        );
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("cwd")).unwrap(),
            installation.canonicalize().unwrap().display().to_string()
        );
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
            Err(Failure::Unavailable)
        );
        cancel("setup-cancelled");
        assert_eq!(
            setup_installed("setup-cancelled", &installation, None).map(|(report, _)| report),
            Err(Failure::Cancelled)
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
                | Failure::InvalidAcceptance => {}
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
    std::fs::write(dir.join("argv"), args.join("\n")).unwrap();
    std::fs::write(dir.join("cwd"), std::env::current_dir().unwrap().display().to_string()).unwrap();
    let inherited = |name: &str| format!("{name}={}", std::env::var(name).is_ok());
    std::fs::write(dir.join("env"), [inherited("NODE_OPTIONS"), inherited("HOME"), inherited("DO_NOT_TRACK")].join("\n")).unwrap();
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
            eprint!("synthetic-secret-marker");
            print!("{body}");
            std::io::stdout().flush().unwrap();
            std::process::exit(code.parse().unwrap());
        }
    }
}
"#;

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

    struct Fixture {
        root: PathBuf,
        program: PathBuf,
    }

    impl Fixture {
        fn new(label: &str, scenario: &str) -> Self {
            let root = temp_root(label);
            std::fs::create_dir_all(&root).unwrap();
            let program = root.join(format!("cli{}", std::env::consts::EXE_SUFFIX));
            std::fs::copy(compiled(), &program).unwrap();
            std::fs::write(root.join("scenario"), scenario).unwrap();
            let warm = std::process::Command::new(&program).arg("--warm").status();
            assert!(warm.unwrap().success());
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
}
