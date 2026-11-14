//! Native host-access broker.
//!
//! The server may decide which Bot is offered host tools, but the desktop process owns every local
//! path decision and every execution boundary. There is deliberately no unsandboxed fallback: a
//! missing runtime, image, approval, grant, path check, or stop cleanup is an error.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};

use crate::engine::{Address, Engine};
use crate::quiet::said as command_said;

#[cfg(test)]
const DEFAULT_IMAGE: &str = "openbot-agent-computer:s10-chromium-arm64";
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(1);
const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_OUTPUT_LIMIT: usize = 64 * 1024;
const DEFAULT_MEMORY: &str = "512m";
const DEFAULT_CPUS: &str = "1";
const DEFAULT_PIDS_LIMIT: &str = "128";
const MAX_ACTIVE_OPERATIONS: usize = 4;
const MAX_OPERATION_AGE_MS: u128 = 120_000;
const APPROVED_MOUNT: &str = "/approved";
const WORKSPACE_MOUNT: &str = "/workspace";

#[derive(Clone, Debug)]
pub struct HostAccessConfig {
    pub base_url: String,
    pub token: String,
    pub engine: Address,
    pub image: String,
    pub forbidden_paths: Vec<PathBuf>,
    pub poll_interval: Duration,
    pub operation_timeout: Duration,
    pub output_limit: usize,
    pub memory: String,
    pub cpus: String,
    pub pids_limit: String,
}

impl HostAccessConfig {
    pub fn new(
        base_url: impl Into<String>,
        token: impl Into<String>,
        engine: Address,
        image: impl Into<String>,
        forbidden_paths: Vec<PathBuf>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            token: token.into(),
            engine,
            image: image.into(),
            forbidden_paths,
            poll_interval: DEFAULT_POLL_INTERVAL,
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
            output_limit: DEFAULT_OUTPUT_LIMIT,
            memory: DEFAULT_MEMORY.into(),
            cpus: DEFAULT_CPUS.into(),
            pids_limit: DEFAULT_PIDS_LIMIT.into(),
        }
    }
}

#[derive(Clone)]
pub struct HostAccess {
    inner: Arc<Inner>,
}

struct Inner {
    config: HostAccessConfig,
    approval: Arc<dyn HostApprovalUi>,
    instance_label: String,
    state: Mutex<State>,
    effect_lock: Mutex<()>,
    /// Held while a dialog is on screen, so the person is shown one at a time. See `prompt_turn`.
    prompt_lock: Mutex<()>,
}

struct State {
    stopped: bool,
    thread: Option<JoinHandle<()>>,
    grants: HashMap<String, LocalGrant>,
    running: HashMap<String, RunningContainer>,
    completed: HashSet<String>,
    canceled_operations: HashSet<String>,
    active_by_operation: HashSet<String>,
    /// Each Bot's one operation in progress, by its id. A Bot's slot is freed when its operation
    /// ends, or when the server cancels it while a dialog for it is still on screen.
    active_by_bot: HashMap<String, String>,
}

#[derive(Clone, Debug)]
struct LocalGrant {
    id: String,
    bot_id: String,
    actor_id: String,
    bot_name: Option<String>,
    root: PathBuf,
    revoked: bool,
}

#[derive(Clone, Debug)]
struct RunningContainer {
    name: String,
    operation_id: String,
    actor_id: String,
    grant_id: Option<String>,
}

#[derive(Debug)]
pub enum HostAccessError {
    InvalidConfig(String),
    /// The container engine or the container failed. The message is the engine's own, which can
    /// name a host path, so it is written to this computer's log and never sent: what the server is
    /// told is `engine_failure_message`'s reading of it.
    Runtime(String),
    Http(String),
    Denied(String),
    Io(String),
    /// What went wrong inside the sandbox, already worded for the Bot: what failed and what to do.
    /// Sent as it is, so it names only paths inside the sandbox and never the engine's output.
    Sandbox(String),
}

impl std::fmt::Display for HostAccessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostAccessError::InvalidConfig(message)
            | HostAccessError::Runtime(message)
            | HostAccessError::Http(message)
            | HostAccessError::Denied(message)
            | HostAccessError::Io(message)
            | HostAccessError::Sandbox(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for HostAccessError {}

pub type HostAccessResult<T> = Result<T, HostAccessError>;

pub trait HostApprovalUi: Send + Sync + 'static {
    fn choose_folder(&self, request: &ChooseFolderPrompt) -> HostAccessResult<ApprovedFolder>;
    fn confirm_write(&self, request: &WritePrompt) -> HostAccessResult<()>;
    fn confirm_command(&self, request: &CommandPrompt) -> HostAccessResult<()>;
    /// The person allowed an action after OpenBot had stopped waiting for the answer, so it did
    /// not run. Told so they do not believe it did. Nothing by default.
    ///
    /// FOUND ON A MAC: a native dialog cannot be closed from outside, so "Allow this command?" stayed
    /// on screen after the server gave up on it, still offering Allow once, and Allow did nothing
    /// anyone could see.
    fn approval_lapsed(&self, _notice: &LapsedApproval) {}
}

/// An action the person allowed too late. See `HostApprovalUi::approval_lapsed`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LapsedApproval {
    pub bot_id: String,
    pub bot_name: Option<String>,
    pub action: LapsedAction,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LapsedAction {
    Command,
    FileChange,
}

pub struct DenyAllApprovalUi;

impl HostApprovalUi for DenyAllApprovalUi {
    fn choose_folder(&self, _: &ChooseFolderPrompt) -> HostAccessResult<ApprovedFolder> {
        Err(HostAccessError::Denied(
            "Native folder approval is not wired.".into(),
        ))
    }

    fn confirm_write(&self, _: &WritePrompt) -> HostAccessResult<()> {
        Err(HostAccessError::Denied(
            "Native write approval is not wired.".into(),
        ))
    }

    fn confirm_command(&self, _: &CommandPrompt) -> HostAccessResult<()> {
        Err(HostAccessError::Denied(
            "Native command approval is not wired.".into(),
        ))
    }
}

#[derive(Clone, Debug)]
pub struct ChooseFolderPrompt {
    pub operation_id: String,
    pub bot_id: String,
    pub actor_id: String,
    pub bot_name: Option<String>,
    pub writable_requested: bool,
}

#[derive(Clone, Debug)]
pub struct ApprovedFolder {
    pub root: PathBuf,
}

#[derive(Clone, Debug)]
pub struct WritePrompt {
    pub operation_id: String,
    pub bot_id: String,
    pub bot_name: Option<String>,
    pub root: PathBuf,
    pub relative_path: String,
    pub content: String,
    pub writable: bool,
}

#[derive(Clone, Debug)]
pub struct CommandPrompt {
    pub operation_id: String,
    pub bot_id: String,
    pub bot_name: Option<String>,
    pub root: PathBuf,
    /// The folder on this computer the command runs in, when it is not the approved folder itself.
    pub working_directory: Option<PathBuf>,
    pub command: String,
    pub writable: bool,
    /// The member's OpenBot setting after the team cap, as the server sent it.
    pub command_policy: CommandPolicy,
}

/// Commands on this computer: ask every time, always allow, or never.
///
/// The server sends the member's setting after the admin cap (the stricter applies). It is parsed
/// leniently and toward caution: a missing or unrecognised value is `Ask`, so a newer server can
/// never loosen an older desktop by sending a word it does not know.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandPolicy {
    Ask,
    Allow,
    Never,
}

impl CommandPolicy {
    pub fn from_wire(value: Option<&str>) -> Self {
        match value {
            Some("allow") => CommandPolicy::Allow,
            Some("never") => CommandPolicy::Never,
            _ => CommandPolicy::Ask,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            CommandPolicy::Ask => "ask every time",
            CommandPolicy::Allow => "always allow",
            CommandPolicy::Never => "never",
        }
    }
}

/// What the native layer does with one command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandApproval {
    /// Refused on this machine too, whatever the server let through.
    Refuse,
    /// The person chose "always allow" for this Bot in this folder on this computer, and the
    /// command leaves the folder read-only.
    Proceed,
    /// Show the dialog. `offer_always` adds "Always allow in this folder".
    Ask { offer_always: bool },
}

/// The member's server setting gates the local one: a folder the person always allowed here is
/// only honoured while their setting (after the team cap) is still "always allow".
///
/// "Always allow" covers read-only commands. A command that can edit the folder asks every time.
pub fn command_approval(
    policy: CommandPolicy,
    allowed_here: bool,
    writable: bool,
) -> CommandApproval {
    match policy {
        CommandPolicy::Never => CommandApproval::Refuse,
        CommandPolicy::Allow if writable => CommandApproval::Ask {
            offer_always: false,
        },
        CommandPolicy::Allow if allowed_here => CommandApproval::Proceed,
        CommandPolicy::Allow => CommandApproval::Ask { offer_always: true },
        CommandPolicy::Ask => CommandApproval::Ask {
            offer_always: false,
        },
    }
}

/// Folders where the person told this computer to stop asking about one Bot's commands.
///
/// Kept in the desktop app's own configuration directory, never on the server: approval on this
/// computer is collected here. Keyed by Bot and folder path because grants are session-only and
/// their ids do not survive a restart. A file that cannot be read counts as empty, so a damaged
/// file asks again rather than allowing.
#[derive(Clone, Debug)]
pub struct LocalCommandAllowList {
    path: PathBuf,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AllowListFile {
    folders: Vec<AllowedFolder>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AllowedFolder {
    bot_id: String,
    root: String,
}

impl LocalCommandAllowList {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    fn read(&self) -> AllowListFile {
        fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn entry(bot_id: &str, root: &Path) -> AllowedFolder {
        AllowedFolder {
            bot_id: bot_id.into(),
            root: root.to_string_lossy().into_owned(),
        }
    }

    pub fn allows(&self, bot_id: &str, root: &Path) -> bool {
        self.read().folders.contains(&Self::entry(bot_id, root))
    }

    fn write(&self, file: &AllowListFile) -> HostAccessResult<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| HostAccessError::Io(error.to_string()))?;
        }
        let bytes = serde_json::to_vec_pretty(file)
            .map_err(|error| HostAccessError::Io(error.to_string()))?;
        let temporary = self.path.with_extension("json.tmp");
        fs::write(&temporary, bytes).map_err(|error| HostAccessError::Io(error.to_string()))?;
        fs::rename(&temporary, &self.path).map_err(|error| HostAccessError::Io(error.to_string()))
    }

    pub fn remember(&self, bot_id: &str, root: &Path) -> HostAccessResult<()> {
        let mut file = self.read();
        let entry = Self::entry(bot_id, root);
        if !file.folders.contains(&entry) {
            file.folders.push(entry);
        }
        self.write(&file)
    }

    pub fn forget(&self, bot_id: &str, root: &Path) -> HostAccessResult<()> {
        let mut file = self.read();
        let entry = Self::entry(bot_id, root);
        file.folders.retain(|folder| folder != &entry);
        self.write(&file)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopOperation {
    operation_id: String,
    kind: HostOperationKind,
    bot_id: String,
    actor_id: String,
    bot_name: Option<String>,
    grant_id: Option<String>,
    target_operation_id: Option<String>,
    relative_path: Option<String>,
    content: Option<String>,
    command: Option<String>,
    writable: Option<bool>,
    /// Kept as text and parsed by `CommandPolicy::from_wire`, so an unknown value is `Ask` rather
    /// than a poll response this desktop cannot read.
    command_policy: Option<String>,
    expires_at: Option<u64>,
    #[serde(skip, default = "now_millis")]
    received_at_ms: u128,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum HostOperationKind {
    ChooseFolder,
    ListFiles,
    ReadFile,
    WriteFile,
    RunCommand,
    Cancel,
    Stop,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPollResponse {
    operations: Vec<DesktopOperation>,
    #[serde(rename = "leaseMs")]
    _lease_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopResult {
    operation_id: String,
    ok: bool,
    result: Option<serde_json::Value>,
    grant: Option<DesktopGrantResult>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopGrantResult {
    grant_id: String,
    display_name: String,
    writable: bool,
}

struct OperationSuccess {
    output: Option<String>,
    grant: Option<OperationGrant>,
}

struct OperationGrant {
    grant_id: String,
    display_name: String,
    writable: bool,
}

impl OperationSuccess {
    fn output(output: String) -> Self {
        Self {
            output: Some(output),
            grant: None,
        }
    }

    fn empty() -> Self {
        Self {
            output: None,
            grant: None,
        }
    }
}

impl HostAccess {
    pub fn start(
        base_url: impl Into<String>,
        token: impl Into<String>,
        engine: Address,
        image: impl Into<String>,
        forbidden_paths: Vec<PathBuf>,
    ) -> HostAccessResult<Self> {
        Self::start_with_approval(
            HostAccessConfig::new(base_url, token, engine, image, forbidden_paths),
            Arc::new(DenyAllApprovalUi),
        )
    }

    pub fn start_with_approval(
        config: HostAccessConfig,
        approval: Arc<dyn HostApprovalUi>,
    ) -> HostAccessResult<Self> {
        validate_config(&config)?;
        let inner = Arc::new(Inner {
            config,
            approval,
            instance_label: fresh_id("host-instance"),
            effect_lock: Mutex::new(()),
            prompt_lock: Mutex::new(()),
            state: Mutex::new(State {
                stopped: false,
                thread: None,
                grants: HashMap::new(),
                running: HashMap::new(),
                completed: HashSet::new(),
                canceled_operations: HashSet::new(),
                active_by_operation: HashSet::new(),
                active_by_bot: HashMap::new(),
            }),
        });
        let thread_inner = inner.clone();
        let handle = thread::Builder::new()
            .name("openbot-host-access".into())
            .spawn(move || broker_loop(thread_inner))
            .map_err(|error| {
                HostAccessError::Runtime(format!("Could not start host access broker: {error}"))
            })?;
        inner.state.lock().expect("host state poisoned").thread = Some(handle);
        Ok(Self { inner })
    }

    pub fn stop(&self) -> HostAccessResult<()> {
        let _effect = self
            .inner
            .effect_lock
            .lock()
            .expect("host effect lock poisoned");
        let running = {
            let mut state = self.inner.state.lock().expect("host state poisoned");
            state.stopped = true;
            for grant in state.grants.values_mut() {
                grant.revoked = true;
            }
            state.running.values().cloned().collect::<Vec<_>>()
        };
        let mut failed = Vec::new();
        for container in &running {
            if let Err(error) = self.inner.remove_container(&container.name) {
                failed.push(format!("{}: {error}", container.name));
            }
        }
        if failed.is_empty() {
            self.inner
                .state
                .lock()
                .expect("host state poisoned")
                .running
                .clear();
            self.inner.verify_no_owned_containers()
        } else {
            Err(HostAccessError::Runtime(format!(
                "Could not remove host containers: {}",
                failed.join(", ")
            )))
        }
    }
}

impl Drop for HostAccess {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn broker_loop(inner: Arc<Inner>) {
    let client = match Client::builder().timeout(Duration::from_secs(15)).build() {
        Ok(client) => client,
        Err(error) => {
            log::error!("[host access] could not create its HTTP client: {error}");
            return;
        }
    };
    while !inner.is_stopped() {
        match inner.next_operation(&client) {
            Ok(Some(operation)) => inner.spawn_operation(client.clone(), operation),
            Ok(None) => thread::sleep(inner.config.poll_interval),
            Err(error) => {
                log::warn!("[host access] poll failed and revoked local leases: {error}");
                if let Err(cleanup) = inner.revoke_all_and_stop() {
                    log::error!("[host access] cleanup after a failed poll failed: {cleanup}");
                }
                thread::sleep(inner.config.poll_interval);
            }
        }
    }
}

impl Inner {
    fn is_stopped(&self) -> bool {
        self.state.lock().expect("host state poisoned").stopped
    }

    fn revoke_all_and_stop(&self) -> HostAccessResult<()> {
        let _effect = self.effect_lock.lock().expect("host effect lock poisoned");
        let running = {
            let mut state = self.state.lock().expect("host state poisoned");
            for grant in state.grants.values_mut() {
                grant.revoked = true;
            }
            state.running.values().cloned().collect::<Vec<_>>()
        };
        let mut failed = Vec::new();
        for container in &running {
            if let Err(error) = self.remove_container(&container.name) {
                failed.push(format!("{}: {error}", container.name));
            }
        }
        if failed.is_empty() {
            let mut state = self.state.lock().expect("host state poisoned");
            for container in running {
                state.running.remove(&container.operation_id);
            }
            Ok(())
        } else {
            Err(HostAccessError::Runtime(format!(
                "Could not remove host containers: {}",
                failed.join(", ")
            )))
        }
    }

    fn next_operation(&self, client: &Client) -> HostAccessResult<Option<DesktopOperation>> {
        let url = endpoint(&self.config.base_url, "/api/host-access/desktop/next");
        let response = client
            .get(url)
            .bearer_auth(&self.config.token)
            .send()
            .map_err(|error| {
                HostAccessError::Http(format!("Could not poll host operation: {error}"))
            })?;
        if !response.status().is_success() {
            return Err(HostAccessError::Http(format!(
                "Host operation poll failed with HTTP {}",
                response.status()
            )));
        }
        let poll = response.json::<DesktopPollResponse>().map_err(|error| {
            HostAccessError::Http(format!(
                "Host operation poll returned invalid JSON: {error}"
            ))
        })?;
        Ok(poll.operations.into_iter().next())
    }

    fn spawn_operation(self: &Arc<Self>, client: Client, operation: DesktopOperation) {
        if matches!(
            operation.kind,
            HostOperationKind::Cancel | HostOperationKind::Stop
        ) {
            self.handle_and_post(&client, operation);
            return;
        }
        let accepted = {
            let mut state = self.state.lock().expect("host state poisoned");
            // A native approval may outlast the server's delivery lease. The original
            // worker still owns this operation and will post its result; redelivery
            // must neither run it twice nor reject that original request.
            if state.active_by_operation.contains(&operation.operation_id) {
                return;
            }
            if state.stopped || state.canceled_operations.contains(&operation.operation_id) {
                Err("Host access is stopped.".to_string())
            } else if state
                .active_by_operation
                .iter()
                .filter(|id| !state.canceled_operations.contains(*id))
                .count()
                >= MAX_ACTIVE_OPERATIONS
            {
                // One the server cancelled is waiting only on a dialog nobody answered; it does not
                // count, or four walked-away dialogs would refuse every Bot.
                Err("Too many host operations are already waiting.".to_string())
            } else if state.active_by_bot.contains_key(&operation.bot_id) {
                Err("That Bot already has a host operation in progress.".to_string())
            } else {
                state
                    .active_by_operation
                    .insert(operation.operation_id.clone());
                state
                    .active_by_bot
                    .insert(operation.bot_id.clone(), operation.operation_id.clone());
                Ok(())
            }
        };
        if let Err(error) = accepted {
            self.post_error(&client, &operation.operation_id, error);
            return;
        }
        let inner = self.clone();
        let operation_id = operation.operation_id.clone();
        let bot_id = operation.bot_id.clone();
        let worker_operation_id = operation_id.clone();
        let worker_bot_id = bot_id.clone();
        let worker_client = client.clone();
        if let Err(error) = thread::Builder::new()
            .name("openbot-host-operation".into())
            .spawn(move || {
                inner.handle_and_post(&worker_client, operation);
                let mut state = inner.state.lock().expect("host state poisoned");
                state.active_by_operation.remove(&worker_operation_id);
                // The slot may already be another operation's: this one's was freed when the
                // server cancelled it.
                if state.active_by_bot.get(&worker_bot_id) == Some(&worker_operation_id) {
                    state.active_by_bot.remove(&worker_bot_id);
                }
            })
        {
            let mut state = self.state.lock().expect("host state poisoned");
            state.active_by_operation.remove(&operation_id);
            if state.active_by_bot.get(&bot_id) == Some(&operation_id) {
                state.active_by_bot.remove(&bot_id);
            }
            drop(state);
            self.post_error(
                &client,
                &operation_id,
                format!("Could not start host operation worker: {error}"),
            );
        }
    }

    fn post_error(&self, client: &Client, operation_id: &str, error: String) {
        let body = DesktopResult {
            operation_id: operation_id.to_string(),
            ok: false,
            result: None,
            grant: None,
            error: Some(error),
        };
        let url = endpoint(&self.config.base_url, "/api/host-access/desktop/result");
        if let Err(error) = client
            .post(url)
            .bearer_auth(&self.config.token)
            .json(&body)
            .send()
        {
            log::warn!("[host access] could not post a refusal: {error}");
        }
    }

    fn handle_and_post(&self, client: &Client, operation: DesktopOperation) {
        let result = self.handle_operation(&operation);
        let body = match result {
            Ok(success) => DesktopResult {
                operation_id: operation.operation_id.clone(),
                ok: true,
                result: success.output.map(serde_json::Value::String),
                grant: success.grant.map(|grant| DesktopGrantResult {
                    grant_id: grant.grant_id,
                    display_name: grant.display_name,
                    writable: grant.writable,
                }),
                error: None,
            },
            Err(error) => {
                // The server is told `said`, never the error itself, which can carry a host path.
                // This computer's log keeps the engine's own words too, the home folder written as
                // `~` (see `logging`): without them a sandbox that fails on one person's machine
                // leaves nothing to go on. No variant carries what a Bot's command printed.
                let said = public_error_message(&error, &self.config);
                match &error {
                    HostAccessError::Runtime(raw) | HostAccessError::InvalidConfig(raw) => {
                        log::warn!(
                            "[host access] operation {} failed on {:?} {} ({}): {raw}. Told: {said}",
                            operation.operation_id,
                            self.config.engine.engine,
                            self.engine_version(),
                            std::env::consts::ARCH,
                        )
                    }
                    _ => log::warn!(
                        "[host access] operation {} failed: {said}",
                        operation.operation_id
                    ),
                }
                DesktopResult {
                    operation_id: operation.operation_id.clone(),
                    ok: false,
                    result: None,
                    grant: None,
                    error: Some(said),
                }
            }
        };
        let url = endpoint(&self.config.base_url, "/api/host-access/desktop/result");
        if let Err(error) = client
            .post(url)
            .bearer_auth(&self.config.token)
            .json(&body)
            .send()
        {
            log::warn!("[host access] could not post a result: {error}");
        }
    }

    fn operation_was_canceled(&self, operation_id: &str) -> bool {
        let state = self.state.lock().expect("host state poisoned");
        state.stopped || state.canceled_operations.contains(operation_id)
    }

    fn operation_expired(&self, operation: &DesktopOperation) -> bool {
        let now = now_millis();
        now.saturating_sub(operation.received_at_ms) > MAX_OPERATION_AGE_MS
            || operation
                .expires_at
                .is_some_and(|expires_at| u128::from(expires_at) <= now)
    }

    fn ensure_operation_fresh(&self, operation: &DesktopOperation) -> HostAccessResult<()> {
        if self.operation_expired(operation) {
            return Err(HostAccessError::Denied(
                "Host operation approval expired.".into(),
            ));
        }
        Ok(())
    }

    fn handle_operation(&self, operation: &DesktopOperation) -> HostAccessResult<OperationSuccess> {
        if matches!(
            operation.kind,
            HostOperationKind::Cancel | HostOperationKind::Stop
        ) {
            return self.cancel_or_stop(operation);
        }
        {
            let mut state = self.state.lock().expect("host state poisoned");
            if self.operation_expired(operation) {
                return Err(HostAccessError::Denied(
                    "Host operation approval expired.".into(),
                ));
            }
            if state.canceled_operations.contains(&operation.operation_id) {
                return Err(HostAccessError::Denied(
                    "Host operation was canceled.".into(),
                ));
            }
            if state.completed.contains(&operation.operation_id) {
                return Err(HostAccessError::Denied(
                    "Host operation replay was refused.".into(),
                ));
            }
            state.completed.insert(operation.operation_id.clone());
        }
        match operation.kind {
            HostOperationKind::ChooseFolder => self.choose_folder(operation),
            HostOperationKind::ListFiles => self.list_files(operation),
            HostOperationKind::ReadFile => self.read_file(operation),
            HostOperationKind::WriteFile => self.write_file(operation),
            HostOperationKind::RunCommand => self.run_command(operation),
            HostOperationKind::Cancel | HostOperationKind::Stop => unreachable!(),
        }
    }

    fn choose_folder(&self, operation: &DesktopOperation) -> HostAccessResult<OperationSuccess> {
        let approved = {
            let _turn = self.prompt_turn();
            self.ensure_operation_fresh(operation)?;
            if self.operation_was_canceled(&operation.operation_id) {
                return Err(HostAccessError::Denied(
                    "Host operation was canceled before the folder was granted.".into(),
                ));
            }
            self.approval.choose_folder(&ChooseFolderPrompt {
                operation_id: operation.operation_id.clone(),
                bot_id: operation.bot_id.clone(),
                actor_id: operation.actor_id.clone(),
                bot_name: operation.bot_name.clone(),
                writable_requested: operation.writable == Some(true),
            })?
        };
        let root = validate_grant_root(&approved.root, &self.config.forbidden_paths)?;
        self.ensure_operation_fresh(operation)?;
        if self.operation_was_canceled(&operation.operation_id) {
            return Err(HostAccessError::Denied(
                "Host operation was canceled before the folder was granted.".into(),
            ));
        }
        let display_name = display_name_for(&root);
        let mut state = self.state.lock().expect("host state poisoned");
        // FOUND ON A MAC: choosing a folder the Bot already had made a second grant beside the
        // first, so Settings listed it twice and the Bot was handed two grants with one name. One
        // grant per Bot, person and folder: choosing it again makes that grant live again, under the
        // id the Bot already knows.
        let existing = state
            .grants
            .values()
            .find(|grant| {
                grant.bot_id == operation.bot_id
                    && grant.actor_id == operation.actor_id
                    && grant.root == root
            })
            .map(|grant| grant.id.clone());
        let grant_id = existing.unwrap_or_else(|| fresh_id("host-grant"));
        state.grants.insert(
            grant_id.clone(),
            LocalGrant {
                id: grant_id.clone(),
                bot_id: operation.bot_id.clone(),
                actor_id: operation.actor_id.clone(),
                bot_name: operation.bot_name.clone(),
                root,
                revoked: false,
            },
        );
        drop(state);
        Ok(OperationSuccess {
            output: None,
            grant: Some(OperationGrant {
                grant_id,
                display_name,
                writable: false,
            }),
        })
    }

    fn list_files(&self, operation: &DesktopOperation) -> HostAccessResult<OperationSuccess> {
        let grant = self.require_grant(operation)?;
        let directory = resolve_relative(
            &grant.root,
            operation.relative_path.as_deref().unwrap_or("."),
        )?;
        if !directory.is_dir() {
            return Err(HostAccessError::Denied(
                "Host path is not a directory.".into(),
            ));
        }
        let relative = host_relative(&grant.root, &directory)?;
        let script = format!(
            "find {} -maxdepth 1 -mindepth 1 -printf '%f\\n' | sort | head -200",
            shell_quote(container_path(&relative))
        );
        self.ensure_operation_still_allowed(operation, &grant)?;
        let ran = self.run_container(&operation.operation_id, &grant, false, &script)?;
        self.finished(ran, "Listing the folder")
            .map(OperationSuccess::output)
    }

    fn read_file(&self, operation: &DesktopOperation) -> HostAccessResult<OperationSuccess> {
        let grant = self.require_grant(operation)?;
        let relative_path = operation
            .relative_path
            .as_deref()
            .ok_or_else(|| HostAccessError::Denied("Host read missing a relative path.".into()))?;
        let path = resolve_relative(&grant.root, relative_path)?;
        if !path.is_file() {
            return Err(HostAccessError::Denied("Host path is not a file.".into()));
        }
        let relative = host_relative(&grant.root, &path)?;
        let script = format!("cat -- {}", shell_quote(container_path(&relative)));
        self.ensure_operation_still_allowed(operation, &grant)?;
        let ran = self.run_container(&operation.operation_id, &grant, false, &script)?;
        read_answer(ran, &self.config).map(OperationSuccess::output)
    }

    fn write_file(&self, operation: &DesktopOperation) -> HostAccessResult<OperationSuccess> {
        let grant = self.require_grant(operation)?;
        let relative_path = operation
            .relative_path
            .as_deref()
            .ok_or_else(|| HostAccessError::Denied("Host write missing a relative path.".into()))?;
        let content = operation
            .content
            .clone()
            .ok_or_else(|| HostAccessError::Denied("Host write missing content.".into()))?;
        let target = resolve_relative_for_write(&grant.root, relative_path)?;
        {
            let _turn = self.prompt_turn();
            self.ensure_operation_still_allowed(operation, &grant)?;
            self.approval.confirm_write(&WritePrompt {
                operation_id: operation.operation_id.clone(),
                bot_id: operation.bot_id.clone(),
                bot_name: grant.bot_name.clone(),
                root: grant.root.clone(),
                relative_path: relative_path.into(),
                content: content.clone(),
                writable: true,
            })?;
            self.ensure_approved_in_time(operation, &grant, LapsedAction::FileChange)?;
        }
        let relative = host_relative_for_write(&grant.root, &target)?;
        let target_path = container_path(&relative);
        let backup_name = backup_name_for(&relative);
        let backup_path = format!("{APPROVED_MOUNT}/.openbot-backups/{backup_name}");
        let script = format!(
            "mkdir -p -- {backup_dir} && if [ -e {target} ]; then cp -- {target} {backup}; fi && cat > {target}",
            backup_dir = shell_quote(format!("{APPROVED_MOUNT}/.openbot-backups")),
            target = shell_quote(target_path),
            backup = shell_quote(backup_path.clone()),
        );
        let ran = self.run_container_with_stdin(
            &operation.operation_id,
            &grant,
            true,
            &script,
            content.as_bytes(),
        )?;
        self.finished(ran, "Writing the file")?;
        Ok(OperationSuccess::output(format!(
            "Wrote file. Backup, if the file existed, is .openbot-backups/{backup_name}"
        )))
    }

    fn run_command(&self, operation: &DesktopOperation) -> HostAccessResult<OperationSuccess> {
        let grant = self.require_grant(operation)?;
        let command = operation
            .command
            .as_deref()
            .ok_or_else(|| HostAccessError::Denied("Host command missing command text.".into()))?;
        if command.trim().is_empty() {
            return Err(HostAccessError::Denied("Host command was empty.".into()));
        }
        let writable = operation.writable == Some(true);
        let working_directory = match operation.relative_path.as_deref() {
            Some(value) if !value.trim().is_empty() => Some(resolve_relative(&grant.root, value)?),
            _ => None,
        };
        let command_policy = CommandPolicy::from_wire(operation.command_policy.as_deref());
        // The server refuses these first; refused here too, so a server that forgot still cannot.
        if command_policy == CommandPolicy::Never {
            return Err(HostAccessError::Denied(
                "Commands on this computer are set to never run.".into(),
            ));
        }
        {
            let _turn = self.prompt_turn();
            self.ensure_operation_still_allowed(operation, &grant)?;
            self.approval.confirm_command(&CommandPrompt {
                operation_id: operation.operation_id.clone(),
                bot_id: operation.bot_id.clone(),
                bot_name: grant.bot_name.clone(),
                root: grant.root.clone(),
                working_directory: working_directory.clone(),
                command: command.into(),
                writable,
                command_policy,
            })?;
            self.ensure_approved_in_time(operation, &grant, LapsedAction::Command)?;
        }
        let command_directory = if let Some(directory) = working_directory {
            let relative = host_relative(&grant.root, &directory)?;
            container_path(&relative)
        } else {
            APPROVED_MOUNT.into()
        };
        let script = format!("cd -- {} && {command}", shell_quote(command_directory));
        let ran = self.run_container(&operation.operation_id, &grant, writable, &script)?;
        if ran.exit_code != 0 {
            // The code and nothing of what it printed: that is the person's, not the log's.
            log::info!(
                "[host access] operation {} ran a command that exited with code {}",
                operation.operation_id,
                ran.exit_code
            );
        }
        command_answer(ran, &self.config, writable).map(OperationSuccess::output)
    }

    fn cancel_or_stop(&self, operation: &DesktopOperation) -> HostAccessResult<OperationSuccess> {
        let target_operation_id = operation
            .target_operation_id
            .as_deref()
            .unwrap_or(&operation.operation_id)
            .to_string();
        let running = {
            let mut state = self.state.lock().expect("host state poisoned");
            state
                .canceled_operations
                .insert(target_operation_id.clone());
            // FOUND ON A MAC: the server gave up on a command whose "Allow this command?" was still
            // on screen, and every folder action that Bot asked for after it failed with "That Bot
            // already has a host operation in progress." until someone dismissed the dialog. The
            // cancelled one can no longer run (`ensure_approved_in_time`), so its Bot is free.
            state
                .active_by_bot
                .retain(|_, operation_id| *operation_id != target_operation_id);
            if let Some(grant_id) = operation.grant_id.as_deref() {
                if let Some(grant) = state.grants.get_mut(grant_id) {
                    if grant.actor_id == operation.actor_id || operation.actor_id == "*" {
                        grant.revoked = true;
                    }
                }
            }
            if matches!(operation.kind, HostOperationKind::Stop) {
                for grant in state.grants.values_mut() {
                    if operation.actor_id == "*" || grant.actor_id == operation.actor_id {
                        grant.revoked = true;
                    }
                }
            }
            state
                .running
                .values()
                .filter(|container| {
                    matches!(operation.kind, HostOperationKind::Stop)
                        && (operation.actor_id == "*" || container.actor_id == operation.actor_id)
                        || operation
                            .grant_id
                            .as_ref()
                            .is_some_and(|grant_id| container.grant_id.as_ref() == Some(grant_id))
                        || container.operation_id == target_operation_id
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        for container in &running {
            self.remove_container(&container.name)?;
        }
        let mut state = self.state.lock().expect("host state poisoned");
        for container in running {
            state.running.remove(&container.operation_id);
        }
        Ok(OperationSuccess::empty())
    }

    fn require_grant(&self, operation: &DesktopOperation) -> HostAccessResult<LocalGrant> {
        let grant_id = required_grant_id(operation)?;
        let state = self.state.lock().expect("host state poisoned");
        let grant = state.grants.get(grant_id).ok_or_else(|| {
            HostAccessError::Denied("Host grant is unknown on this device.".into())
        })?;
        if grant.revoked {
            return Err(HostAccessError::Denied("Host grant was revoked.".into()));
        }
        if grant.bot_id != operation.bot_id || grant.actor_id != operation.actor_id {
            return Err(HostAccessError::Denied(
                "Host grant is bound to a different Bot or actor.".into(),
            ));
        }
        Ok(grant.clone())
    }
    /// The person's turn to be shown a dialog. A native dialog cannot be closed from outside, so one
    /// OpenBot stopped waiting for stays up until the person answers it; a second one shown beside it
    /// sat exactly on top of it, two identical dialogs nobody could tell apart. Each dialog waits
    /// for the one before it, the "didn't run" notice included, and an action that is no longer
    /// wanted by the time its turn comes is never shown (`ensure_operation_still_allowed`).
    fn prompt_turn(&self) -> std::sync::MutexGuard<'_, ()> {
        self.prompt_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// After the person allowed an action: whether it may still run. When the server stopped
    /// waiting for the answer first (it expired, or the server cancelled it alone), the person is
    /// told it did not run, and the server is answered that it expired.
    fn ensure_approved_in_time(
        &self,
        operation: &DesktopOperation,
        grant: &LocalGrant,
        action: LapsedAction,
    ) -> HostAccessResult<()> {
        let Err(refused) = self.ensure_operation_still_allowed(operation, grant) else {
            return Ok(());
        };
        let lapsed = {
            let state = self.state.lock().expect("host state poisoned");
            let grant_still_held = state
                .grants
                .get(&grant.id)
                .is_some_and(|current| !current.revoked);
            !state.stopped
                && grant_still_held
                && (state.canceled_operations.contains(&operation.operation_id)
                    || self.operation_expired(operation))
        };
        if !lapsed {
            return Err(refused);
        }
        log::info!(
            "[host access] operation {} was allowed after the server stopped waiting; nothing ran",
            operation.operation_id
        );
        self.approval.approval_lapsed(&LapsedApproval {
            bot_id: operation.bot_id.clone(),
            bot_name: grant.bot_name.clone(),
            action,
        });
        Err(HostAccessError::Denied(
            "Host operation approval expired.".into(),
        ))
    }

    fn ensure_operation_still_allowed(
        &self,
        operation: &DesktopOperation,
        grant: &LocalGrant,
    ) -> HostAccessResult<()> {
        let state = self.state.lock().expect("host state poisoned");
        if state.stopped || state.canceled_operations.contains(&operation.operation_id) {
            return Err(HostAccessError::Denied(
                "Host access was stopped before execution.".into(),
            ));
        }
        drop(state);
        self.ensure_operation_fresh(operation)?;
        let state = self.state.lock().expect("host state poisoned");
        match state.grants.get(&grant.id) {
            Some(current)
                if !current.revoked
                    && current.bot_id == operation.bot_id
                    && current.actor_id == operation.actor_id =>
            {
                Ok(())
            }
            _ => Err(HostAccessError::Denied(
                "Host grant was revoked before execution.".into(),
            )),
        }
    }

    fn run_container(
        &self,
        operation_id: &str,
        grant: &LocalGrant,
        writable: bool,
        script: &str,
    ) -> HostAccessResult<Ran> {
        self.run_container_with_stdin(operation_id, grant, writable, script, &[])
    }

    /// The text of an operation OpenBot itself ran (a listing, a read, a write), or what stopped it.
    fn finished(&self, ran: Ran, doing: &str) -> HostAccessResult<String> {
        operation_answer(ran, &self.config, doing)
    }

    fn run_container_with_stdin(
        &self,
        operation_id: &str,
        grant: &LocalGrant,
        writable: bool,
        script: &str,
        stdin: &[u8],
    ) -> HostAccessResult<Ran> {
        let name = fresh_container_name(operation_id);
        {
            let _effect = self.effect_lock.lock().expect("host effect lock poisoned");
            self.ensure_image_exists()?;
            let mut create = self.config.engine.command();
            append_container_create_args(
                &mut create,
                &self.config,
                &self.instance_label,
                &name,
                &grant.root,
                writable,
                script,
            );
            let output = create.output().map_err(|error| {
                HostAccessError::Runtime(format!("Could not create host container: {error}"))
            })?;
            if !output.status.success() {
                return Err(HostAccessError::Runtime(format!(
                    "Could not create host container: {}",
                    command_said(&output.stderr)
                )));
            }
            let mut state = self.state.lock().expect("host state poisoned");
            if state.stopped
                || state
                    .grants
                    .get(&grant.id)
                    .map(|g| g.revoked)
                    .unwrap_or(true)
            {
                drop(state);
                let _ = self.remove_container(&name);
                return Err(HostAccessError::Denied(
                    "Host operation was stopped before it could start.".into(),
                ));
            }
            state.running.insert(
                operation_id.into(),
                RunningContainer {
                    name: name.clone(),
                    operation_id: operation_id.into(),
                    actor_id: grant.actor_id.clone(),
                    grant_id: Some(grant.id.clone()),
                },
            );
        }
        let result = self.start_attach_wait(&name, stdin);
        let remove_result = self.remove_container(&name);
        if remove_result.is_ok() {
            self.state
                .lock()
                .expect("host state poisoned")
                .running
                .remove(operation_id);
        }
        remove_result?;
        result
    }

    fn start_attach_wait(&self, name: &str, stdin: &[u8]) -> HostAccessResult<Ran> {
        let mut start = self.config.engine.command();
        start.args(["start", "-a"]);
        if !stdin.is_empty() {
            start.arg("-i");
            start.stdin(Stdio::piped());
        }
        start.arg(name);
        start.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = start.spawn().map_err(|error| {
            HostAccessError::Runtime(format!("Could not run container engine: {error}"))
        })?;
        if !stdin.is_empty() {
            if let Some(mut pipe) = child.stdin.take() {
                pipe.write_all(stdin).map_err(|error| {
                    HostAccessError::Runtime(format!("Could not write host input: {error}"))
                })?;
            }
        }
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| HostAccessError::Runtime("Could not capture host stdout.".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| HostAccessError::Runtime("Could not capture host stderr.".into()))?;
        // Drained to the end, keeping the last `output_limit` bytes. A reader that stopped at the
        // cap left the command blocked on a full pipe until the timeout stopped it.
        let output_limit = self.config.output_limit;
        let stdout_reader = thread::spawn(move || read_tail(stdout, output_limit));
        let stderr_reader = thread::spawn(move || read_tail(stderr, output_limit));
        let deadline = Instant::now() + self.config.operation_timeout + Duration::from_secs(2);
        loop {
            if child
                .try_wait()
                .map_err(|error| {
                    HostAccessError::Runtime(format!("Could not inspect host process: {error}"))
                })?
                .is_some()
            {
                break;
            }
            if Instant::now() >= deadline {
                let _ = self.remove_container(name);
                let _ = child.kill();
                return Err(HostAccessError::Runtime(
                    "Host operation timed out and was stopped.".into(),
                ));
            }
            thread::sleep(Duration::from_millis(100));
        }
        let status = child.wait().map_err(|error| {
            HostAccessError::Runtime(format!("Could not reap host process: {error}"))
        })?;
        let (mut combined, stdout_cut) = stdout_reader
            .join()
            .map_err(|_| HostAccessError::Runtime("Host stdout reader panicked.".into()))??;
        let (stderr_bytes, stderr_cut) = stderr_reader
            .join()
            .map_err(|_| HostAccessError::Runtime("Host stderr reader panicked.".into()))??;
        combined.extend(stderr_bytes);
        let (output, combined_cut) = keep_tail(combined, output_limit);
        let truncated = stdout_cut || stderr_cut || combined_cut;
        if status.success() {
            return Ok(Ran {
                exit_code: 0,
                oom_killed: false,
                output,
                truncated,
            });
        }
        // `start -a` exits non-zero both when the command ran and failed and when the engine never
        // got it running. Only the container's own state tells the two apart.
        let inspect = self.run_engine([
            "inspect",
            "-f",
            "{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}",
            name,
        ])?;
        if !inspect.status.success() {
            return Err(HostAccessError::Runtime(format!(
                "Could not inspect host container: {}",
                command_said(&inspect.stderr)
            )));
        }
        let state = String::from_utf8_lossy(&inspect.stdout).trim().to_string();
        match ContainerEnd::parse(&state) {
            Some(end) if end.engine_error.is_empty() && end.exit_code != 0 => Ok(Ran {
                exit_code: end.exit_code,
                oom_killed: end.oom_killed,
                output,
                truncated,
            }),
            Some(end) if !end.engine_error.is_empty() => Err(HostAccessError::Runtime(format!(
                "Could not start host container: {}",
                end.engine_error
            ))),
            _ => Err(HostAccessError::Runtime(format!(
                "Could not start host container ({state}): {}",
                command_said(&output)
            ))),
        }
    }

    fn verify_no_owned_containers(&self) -> HostAccessResult<()> {
        let filter = format!("label=openbot.host-access.instance={}", self.instance_label);
        let output = self
            .config
            .engine
            .command()
            .args(["ps", "-a", "--filter", &filter, "--format", "{{.Names}}"])
            .output()
            .map_err(|error| {
                HostAccessError::Runtime(format!(
                    "Could not verify host containers stopped: {error}"
                ))
            })?;
        if !output.status.success() {
            return Err(HostAccessError::Runtime(format!(
                "Could not verify host containers stopped: {}",
                command_said(&output.stderr)
            )));
        }
        let remaining = String::from_utf8_lossy(&output.stdout);
        if remaining.trim().is_empty() {
            Ok(())
        } else {
            Err(HostAccessError::Runtime(format!(
                "Host containers are still present: {}",
                remaining.trim()
            )))
        }
    }

    fn run_engine<const N: usize>(&self, args: [&str; N]) -> HostAccessResult<Output> {
        self.config
            .engine
            .command()
            .args(args)
            .output()
            .map_err(|error| {
                HostAccessError::Runtime(format!("Could not run container engine: {error}"))
            })
    }

    fn remove_container(&self, name: &str) -> HostAccessResult<()> {
        let output = self.run_engine(["rm", "-f", name])?;
        if !output.status.success() {
            let said = command_said(&output.stderr);
            let lower = said.to_lowercase();
            if lower.contains("no such container") || lower.contains("no container with name") {
                return Ok(());
            }
            return Err(HostAccessError::Runtime(format!(
                "Could not remove host container: {said}"
            )));
        }
        Ok(())
    }

    /// The engine's server version, for the log line of a failure. Best effort: it is asked only
    /// after something already failed, and that engine may not answer.
    fn engine_version(&self) -> String {
        self.run_engine(["version", "--format", "{{.Server.Version}}"])
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .filter(|version| !version.is_empty())
            .unwrap_or_else(|| "version unknown".into())
    }

    fn ensure_image_exists(&self) -> HostAccessResult<()> {
        let output = self
            .config
            .engine
            .command()
            .args(["image", "inspect", &self.config.image])
            .output()
            .map_err(|error| {
                HostAccessError::Runtime(format!("Could not inspect host image: {error}"))
            })?;
        if output.status.success() {
            Ok(())
        } else {
            Err(HostAccessError::Runtime(format!(
                "Required host sandbox image is unavailable: {}",
                self.config.image
            )))
        }
    }
}

fn validate_config(config: &HostAccessConfig) -> HostAccessResult<()> {
    if config.base_url.trim().is_empty() {
        return Err(HostAccessError::InvalidConfig(
            "Host access base URL is required.".into(),
        ));
    }
    if config.token.trim().is_empty() {
        return Err(HostAccessError::InvalidConfig(
            "Host access token is required.".into(),
        ));
    }
    if config.image.trim().is_empty() {
        return Err(HostAccessError::InvalidConfig(
            "Host access container image is required.".into(),
        ));
    }
    Ok(())
}

/// What the server, and through it the Bot, is told: what failed and what to do, and never a host
/// path or the engine's own output.
fn public_error_message(error: &HostAccessError, config: &HostAccessConfig) -> String {
    match error {
        HostAccessError::InvalidConfig(_) => "Local host access is not configured.".into(),
        HostAccessError::Http(_) => "The desktop lost its host access connection.".into(),
        HostAccessError::Runtime(message) => engine_failure_message(message, config),
        HostAccessError::Sandbox(message) => message.clone(),
        HostAccessError::Io(_) => "The local file operation failed.".into(),
        HostAccessError::Denied(message) if message.contains("approved folder") => {
            "The requested path is outside the approved folder.".into()
        }
        HostAccessError::Denied(message) if message.contains("unavailable") => {
            "The requested path is unavailable.".into()
        }
        HostAccessError::Denied(message) if message.contains("cannot be granted") => {
            "That folder cannot be granted to a Bot.".into()
        }
        HostAccessError::Denied(message) => message.clone(),
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn endpoint(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

fn required_grant_id(operation: &DesktopOperation) -> HostAccessResult<&str> {
    operation
        .grant_id
        .as_deref()
        .ok_or_else(|| HostAccessError::Denied("Host operation missing grant id.".into()))
}

fn append_container_create_args(
    command: &mut Command,
    config: &HostAccessConfig,
    instance_label: &str,
    name: &str,
    root: &Path,
    writable: bool,
    script: &str,
) {
    let (uid, gid) = owner_ids();
    command.args([
        "create",
        "--name",
        name,
        "--pull",
        "never",
        "--network",
        "none",
        "--read-only",
        "--interactive",
        "--tmpfs",
    ]);
    match config.engine.engine {
        Engine::Docker => {
            command.arg(format!(
                "/tmp:rw,nosuid,nodev,noexec,size=64m,uid={uid},gid={gid},mode=700"
            ));
            command.args(["--tmpfs"]);
            command.arg(format!(
                "{WORKSPACE_MOUNT}:rw,nosuid,nodev,exec,size=128m,uid={uid},gid={gid},mode=700"
            ));
        }
        Engine::Podman => {
            command.arg("/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777");
            command.args(["--tmpfs"]);
            command.arg(format!(
                "{WORKSPACE_MOUNT}:rw,nosuid,nodev,exec,size=128m,mode=1777"
            ));
            command.args(["--read-only-tmpfs=false"]);
        }
    }
    command.args(["--mount"]);
    let bind_recursion = match config.engine.engine {
        Engine::Docker => "bind-recursive=disabled",
        Engine::Podman => "bind-nonrecursive=true",
    };
    let readonly = if writable { "" } else { ",readonly" };
    command.arg(format!(
        "type=bind,src={},dst={APPROVED_MOUNT}{readonly},{bind_recursion}",
        root.display()
    ));
    command.arg("--user");
    command.arg(format!("{uid}:{gid}"));
    command.args([
        "--workdir",
        WORKSPACE_MOUNT,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges=true",
        "--pids-limit",
    ]);
    command.arg(&config.pids_limit);
    command.arg("--memory");
    command.arg(&config.memory);
    command.arg("--cpus");
    command.arg(&config.cpus);
    command.args(["--label", "openbot.host-access=true"]);
    command.arg("--label");
    command.arg(format!("openbot.host-access.instance={instance_label}"));
    command.args(["--entrypoint", "/usr/bin/env"]);
    command.arg(&config.image);
    command.args([
        "-i",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "HOME=/workspace",
        "timeout",
        "--signal=TERM",
        "--kill-after=1s",
    ]);
    command.arg(format!("{}s", config.operation_timeout.as_secs().max(1)));
    command.args(["sh", "-lc", script]);
}

fn owner_ids() -> (u32, u32) {
    #[cfg(unix)]
    unsafe {
        (libc::getuid(), libc::getgid())
    }
    #[cfg(not(unix))]
    {
        (1000, 1000)
    }
}

struct ForbiddenPaths {
    exact_or_ancestor_only: Vec<PathBuf>,
    protected_subtrees: Vec<PathBuf>,
}

fn validate_grant_root(path: &Path, configured_forbidden: &[PathBuf]) -> HostAccessResult<PathBuf> {
    validate_grant_root_with_forbidden(path, &forbidden_paths(configured_forbidden))
}

fn validate_grant_root_with_forbidden(
    path: &Path,
    forbidden: &ForbiddenPaths,
) -> HostAccessResult<PathBuf> {
    let root = canonical(path)?;
    if root.parent().is_none() {
        return Err(HostAccessError::Denied(
            "The filesystem root cannot be granted.".into(),
        ));
    }
    for denied in &forbidden.exact_or_ancestor_only {
        if &root == denied || path_contains(&root, denied) {
            return Err(HostAccessError::Denied(
                "That folder cannot be granted to a Bot.".into(),
            ));
        }
    }
    for denied in &forbidden.protected_subtrees {
        if path_contains(&root, denied) || path_contains(denied, &root) {
            return Err(HostAccessError::Denied(
                "That folder cannot be granted to a Bot.".into(),
            ));
        }
    }
    Ok(root)
}

fn forbidden_paths(configured: &[PathBuf]) -> ForbiddenPaths {
    forbidden_paths_with_home(configured, home_dir().as_deref())
}

fn forbidden_paths_with_home(configured: &[PathBuf], home: Option<&Path>) -> ForbiddenPaths {
    let mut exact_or_ancestor_only = Vec::new();
    let mut protected_subtrees = Vec::new();
    protected_subtrees.extend(configured.iter().filter_map(|path| canonical(path).ok()));
    if let Some(home) = home.and_then(|path| canonical(path).ok()) {
        exact_or_ancestor_only.push(home.clone());
        for relative in [
            ".ssh",
            ".gnupg",
            ".aws",
            ".config/gcloud",
            ".config/gh",
            ".local/share/keyrings",
            ".claude",
            ".codex",
            ".cargo/credentials",
            ".cargo/credentials.toml",
            ".netrc",
            ".git-credentials",
            ".npmrc",
            ".docker",
            ".kube",
            "Library/Application Support/OpenBot",
            "Library/Application Support/Google/Chrome",
            "Library/Application Support/BraveSoftware",
            "Library/Application Support/Firefox",
            "Library/Keychains",
            "AppData/Roaming/OpenBot",
            "AppData/Roaming/GitHub CLI",
            "AppData/Local/Google/Chrome",
            "AppData/Local/BraveSoftware",
            "AppData/Roaming/Mozilla/Firefox",
            "AppData/Roaming/Microsoft/Windows/PowerShell",
        ] {
            protected_subtrees.push(home.join(relative));
        }
    }
    for path in [
        "/System",
        "/Library",
        "/Applications",
        "/private/etc",
        "/etc",
        "/var/run",
    ] {
        if let Ok(path) = canonical(Path::new(path)) {
            protected_subtrees.push(path);
        }
    }
    #[cfg(windows)]
    protected_subtrees.extend(
        windows_environment_paths(|name| std::env::var_os(name))
            .iter()
            .filter_map(|path| canonical(path).ok()),
    );
    ForbiddenPaths {
        exact_or_ancestor_only,
        protected_subtrees,
    }
}

#[cfg(any(windows, test))]
fn windows_environment_paths(
    mut get_env: impl FnMut(&str) -> Option<std::ffi::OsString>,
) -> Vec<PathBuf> {
    // Installations may relocate these folders; ProgramW6432 also covers the native
    // Program Files directory when this process runs under WOW64.
    let mut paths: Vec<_> = [
        "SystemRoot",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "ProgramData",
    ]
    .into_iter()
    .filter_map(&mut get_env)
    .map(PathBuf::from)
    .collect();
    if let Some(app_data) = get_env("AppData") {
        paths.push(PathBuf::from(app_data).join("GitHub CLI"));
    }
    paths
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).or({
        #[cfg(windows)]
        {
            std::env::var_os("USERPROFILE").map(PathBuf::from)
        }
        #[cfg(not(windows))]
        {
            None
        }
    })
}

fn resolve_relative(root: &Path, relative: &str) -> HostAccessResult<PathBuf> {
    reject_unsafe_relative(relative)?;
    let root = canonical(root)?;
    let target = canonical(&root.join(relative))?;
    if path_contains(&root, &target) {
        Ok(target)
    } else {
        Err(HostAccessError::Denied(
            "Host path escaped the approved folder.".into(),
        ))
    }
}

fn resolve_relative_for_write(root: &Path, relative: &str) -> HostAccessResult<PathBuf> {
    reject_unsafe_relative(relative)?;
    let root = canonical(root)?;
    let raw = root.join(relative);
    let parent = raw
        .parent()
        .ok_or_else(|| HostAccessError::Denied("Host write has no parent directory.".into()))?;
    let parent = canonical(parent)?;
    if !path_contains(&root, &parent) {
        return Err(HostAccessError::Denied(
            "Host write escaped the approved folder.".into(),
        ));
    }
    if raw.exists() {
        let existing = canonical(&raw)?;
        if !path_contains(&root, &existing) {
            return Err(HostAccessError::Denied(
                "Host write target escaped through a link.".into(),
            ));
        }
    }
    Ok(raw)
}

fn reject_unsafe_relative(relative: &str) -> HostAccessResult<()> {
    let path = Path::new(relative);
    if path.is_absolute() {
        return Err(HostAccessError::Denied(
            "Host path must be relative.".into(),
        ));
    }
    for component in path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err(HostAccessError::Denied(
                "Host path cannot traverse upward.".into(),
            ));
        }
    }
    Ok(())
}

fn canonical(path: &Path) -> HostAccessResult<PathBuf> {
    fs::canonicalize(path).map_err(|_| HostAccessError::Denied("Host path is unavailable.".into()))
}

fn path_contains(root: &Path, candidate: &Path) -> bool {
    let root = normalize_for_compare(root);
    let candidate = normalize_for_compare(candidate);
    candidate == root || candidate.starts_with(&root)
}

fn normalize_for_compare(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

fn host_relative(root: &Path, path: &Path) -> HostAccessResult<PathBuf> {
    path.strip_prefix(root)
        .map(PathBuf::from)
        .map_err(|_| HostAccessError::Denied("Host path escaped the approved folder.".into()))
}

fn host_relative_for_write(root: &Path, path: &Path) -> HostAccessResult<PathBuf> {
    path.strip_prefix(root)
        .map(PathBuf::from)
        .map_err(|_| HostAccessError::Denied("Host write escaped the approved folder.".into()))
}

fn container_path(relative: &Path) -> String {
    let suffix = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    if suffix.is_empty() {
        APPROVED_MOUNT.into()
    } else {
        format!("{APPROVED_MOUNT}/{suffix}")
    }
}

fn shell_quote(value: String) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn backup_name_for(relative: &Path) -> String {
    let safe = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("__")
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!(
        "{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        if safe.is_empty() { "file".into() } else { safe }
    )
}

fn display_name_for(root: &Path) -> String {
    root.file_name()
        .and_then(OsStr::to_str)
        .filter(|name| !name.is_empty())
        .unwrap_or("Selected folder")
        .to_string()
}

fn fresh_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

fn fresh_container_name(operation_id: &str) -> String {
    let safe: String = operation_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .take(32)
        .collect();
    format!("openbot-host-{safe}-{}", std::process::id())
}

/// How a container that ran to its end went: what it printed (stdout, then stderr, the last
/// `output_limit` bytes of them) and how it exited.
#[derive(Debug)]
struct Ran {
    exit_code: i64,
    oom_killed: bool,
    output: Vec<u8>,
    /// Whether anything was dropped from the start of `output` to keep it under the limit.
    truncated: bool,
}

/// The container's state once `start -a` returned non-zero: `{{.State.ExitCode}}`,
/// `{{.State.OOMKilled}}` and `{{.State.Error}}`, which Docker and Podman both report.
struct ContainerEnd {
    exit_code: i64,
    oom_killed: bool,
    engine_error: String,
}

impl ContainerEnd {
    fn parse(state: &str) -> Option<Self> {
        let mut fields = state.splitn(3, '|');
        let exit_code = fields.next()?.trim().parse::<i64>().ok()?;
        let oom_killed = fields.next().map(str::trim) == Some("true");
        let engine_error = fields.next().unwrap_or("").trim().to_string();
        Some(Self {
            exit_code,
            oom_killed,
            engine_error,
        })
    }
}

/// `timeout`'s own exit status when the time ran out, and a process ended by SIGKILL, which is what
/// `timeout --kill-after` sends to a command that ignored the first signal.
const TIMEOUT_EXIT: i64 = 124;
const KILLED_EXIT: i64 = 137;

/// Read to the end, keeping only the last `limit` bytes. Never stops early: a command whose output
/// is not read blocks on a full pipe.
fn read_tail<R: Read>(mut reader: R, limit: usize) -> HostAccessResult<(Vec<u8>, bool)> {
    let mut output = Vec::new();
    let mut truncated = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer).map_err(|error| {
            HostAccessError::Runtime(format!("Could not read host output: {error}"))
        })?;
        if read == 0 {
            let (kept, cut) = keep_tail(output, limit);
            return Ok((kept, truncated || cut));
        }
        output.extend_from_slice(&buffer[..read]);
        // Trimmed in batches rather than on every read, so a long stream is not copied each time.
        if output.len() > limit.saturating_mul(2).max(limit + buffer.len()) {
            let excess = output.len() - limit;
            output.drain(..excess);
            truncated = true;
        }
    }
}

fn keep_tail(mut bytes: Vec<u8>, limit: usize) -> (Vec<u8>, bool) {
    if bytes.len() <= limit {
        return (bytes, false);
    }
    let excess = bytes.len() - limit;
    bytes.drain(..excess);
    (bytes, true)
}

/// What the sandbox itself stopped, whatever was running in it: too long, or too much memory.
fn stopped_by_sandbox(ran: &Ran, config: &HostAccessConfig) -> Option<HostAccessError> {
    if ran.oom_killed {
        return Some(HostAccessError::Sandbox(format!(
            "The command used more than the local sandbox's {} of memory, so it was stopped. Work \
             on less at once, for example read a large file in parts.",
            config.memory
        )));
    }
    if ran.exit_code == TIMEOUT_EXIT || ran.exit_code == KILLED_EXIT {
        return Some(timed_out(config));
    }
    None
}

fn timed_out(config: &HostAccessConfig) -> HostAccessError {
    HostAccessError::Sandbox(timed_out_sentence(config))
}

fn timed_out_sentence(config: &HostAccessConfig) -> String {
    format!(
        "The command ran for more than {} seconds, so the local sandbox stopped it. Anything it \
         changed before then stays changed. Split the work into shorter commands.",
        config.operation_timeout.as_secs()
    )
}

/// A listing, read or write OpenBot ran on the Bot's behalf: its output, or the reason it failed,
/// from the last line the tool printed (it names only paths inside the sandbox).
fn operation_answer(ran: Ran, config: &HostAccessConfig, doing: &str) -> HostAccessResult<String> {
    if let Some(stopped) = stopped_by_sandbox(&ran, config) {
        return Err(stopped);
    }
    let text = String::from_utf8_lossy(&ran.output).into_owned();
    if ran.exit_code == 0 {
        return Ok(text);
    }
    let said = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    Err(HostAccessError::Sandbox(if said.is_empty() {
        format!(
            "{doing} failed in the local sandbox (exit code {}).",
            ran.exit_code
        )
    } else {
        format!("{doing} failed in the local sandbox: {said}")
    }))
}

/// A file read: its text, or why it cannot be read as text and what to do instead.
fn read_answer(ran: Ran, config: &HostAccessConfig) -> HostAccessResult<String> {
    if ran.exit_code == 0 && ran.truncated {
        return Err(HostAccessError::Sandbox(format!(
            "The file is larger than {} KB, so it cannot be read whole. Read part of it with a \
             command instead, such as head -c 60000 on it.",
            config.output_limit / 1024
        )));
    }
    if ran.exit_code == 0 && std::str::from_utf8(&ran.output).is_err() {
        return Err(HostAccessError::Sandbox(
            "The file is not text (a spreadsheet, document, PDF or image, for example), so it \
             cannot be read as text. Open it with a command instead, such as python3 with openpyxl \
             for an .xlsx file."
                .into(),
        ));
    }
    operation_answer(ran, config, "Reading the file")
}

/// A command the Bot ran. One that exited non-zero still ran: the Bot gets its exit code, what it
/// printed and, where the cause is the sandbox's, what to do about it. Only a command the sandbox
/// stopped is an error.
fn command_answer(ran: Ran, config: &HostAccessConfig, writable: bool) -> HostAccessResult<String> {
    if let Some(stopped) = stopped_by_sandbox(&ran, config) {
        return Err(stopped);
    }
    let text = String::from_utf8_lossy(&ran.output).into_owned();
    let mut notes = Vec::new();
    if ran.truncated {
        notes.push(format!(
            "It printed more than {} KB, so only the end is shown.",
            config.output_limit / 1024
        ));
    }
    if std::str::from_utf8(&ran.output).is_err() {
        notes.push("Some of what it printed is not text and is shown as \u{FFFD}.".into());
    }
    if ran.exit_code == 0 {
        if notes.is_empty() {
            return Ok(text);
        }
        return Ok(format!("{}\n{text}", notes.join(" ")));
    }
    let mut answer = format!("The command exited with code {}.", ran.exit_code);
    if let Some(hint) = command_hint(ran.exit_code, &text, writable) {
        answer.push(' ');
        answer.push_str(&hint);
    }
    for note in notes {
        answer.push(' ');
        answer.push_str(&note);
    }
    if text.trim().is_empty() {
        answer.push_str(" It printed nothing.");
    } else {
        answer.push_str(" What it printed:\n");
        answer.push_str(&text);
    }
    Ok(answer)
}

/// What to do when a command failed because of how the sandbox is, rather than because of the
/// command: what the Bot cannot know from the error alone.
fn command_hint(exit_code: i64, output: &str, writable: bool) -> Option<String> {
    let lower = output.to_lowercase();
    if exit_code == 127 || lower.contains("command not found") || lower.contains(": not found") {
        return Some(
            "A program it named is not in the local sandbox, and the sandbox has no network, so \
             nothing can be installed in it. Use a program it has."
                .into(),
        );
    }
    if lower.contains("no module named") {
        return Some(
            "That Python module is not in the local sandbox, and the sandbox has no network, so \
             nothing can be installed in it. Use a library it has."
                .into(),
        );
    }
    if lower.contains("read-only file system") && !writable {
        return Some(
            "The folder was shared read-only for this command. To change files in it, run the \
             command again with writable set to true."
                .into(),
        );
    }
    if lower.contains("no space left on device") {
        return Some(format!(
            "Only the folder has room for large files: {WORKSPACE_MOUNT} and /tmp are small and \
             are emptied after every command. Write large files into the folder, with writable set \
             to true. The folder is at {APPROVED_MOUNT}."
        ));
    }
    if exit_code == 126 {
        return Some(
            "A file it tried to run cannot be run here. Run a script through its interpreter, \
             such as sh script.sh or python3 script.py."
                .into(),
        );
    }
    None
}

/// The server's sentence for a failure of the container engine or the container itself, from the
/// engine's own words. Those can name a host path, so they stay in this computer's log, and every
/// sentence here says whether anything ran and what the person can do.
fn engine_failure_message(raw: &str, config: &HostAccessConfig) -> String {
    let lower = raw.to_lowercase();
    let engine = match config.engine.engine {
        Engine::Docker => "Docker",
        Engine::Podman => "Podman",
    };
    if lower.contains("timed out") {
        return timed_out_sentence(config);
    }
    if lower.contains("sandbox image is unavailable") || lower.contains("no such image") {
        return "Nothing ran: the local sandbox's software is missing from this computer. \
                Restarting OpenBot downloads it again; ask the person to restart OpenBot, then try \
                again."
            .into();
    }
    if lower.contains("could not run container engine")
        || lower.contains("cannot connect to the docker daemon")
        || lower.contains("failed to connect to the docker api")
        || lower.contains("error during connect")
        || lower.contains("cannot connect to podman")
        || lower.contains("unable to connect to podman")
        || lower.contains("connection refused")
    {
        return format!(
            "Nothing ran: {engine}, which runs the local sandbox, is not answering. Ask the \
             person to restart OpenBot, then try again."
        );
    }
    if lower.contains("mounts denied") || lower.contains("is not shared from the host") {
        return "Nothing ran: Docker Desktop does not share this folder with containers. The \
                person can add it in Docker Desktop under Settings, Resources, File sharing, or \
                choose a folder inside their home folder."
            .into();
    }
    if lower.contains("bind source path does not exist")
        || (lower.contains("statfs") && lower.contains("no such file"))
    {
        return "Nothing ran: the folder is no longer where it was (moved, renamed, or on a drive \
                that is not connected). Ask the person to choose it again for this Bot."
            .into();
    }
    if lower.contains("unexpected key")
        || lower.contains("unknown flag")
        || lower.contains("unknown option")
        || lower.contains("invalid field")
        || lower.contains("unknown mount option")
    {
        return format!(
            "Nothing ran: the {engine} on this computer is too old for the local sandbox. Ask \
             the person to update {engine}, then try again."
        );
    }
    "Nothing ran: the local sandbox could not start the command, and trying again will not help. \
     Tell the person the reason is in OpenBot's log (Settings, This computer, Open log folder)."
        .into()
}

#[cfg(test)]
mod command_policy_tests {
    use super::*;

    #[test]
    fn unknown_or_missing_policy_asks() {
        assert_eq!(CommandPolicy::from_wire(None), CommandPolicy::Ask);
        assert_eq!(
            CommandPolicy::from_wire(Some("sometimes")),
            CommandPolicy::Ask
        );
        assert_eq!(
            CommandPolicy::from_wire(Some("allow")),
            CommandPolicy::Allow
        );
        assert_eq!(
            CommandPolicy::from_wire(Some("never")),
            CommandPolicy::Never
        );
    }

    #[test]
    fn local_always_allow_only_counts_while_the_server_setting_allows() {
        assert_eq!(
            command_approval(CommandPolicy::Never, true, false),
            CommandApproval::Refuse
        );
        assert_eq!(
            command_approval(CommandPolicy::Allow, true, false),
            CommandApproval::Proceed
        );
        assert_eq!(
            command_approval(CommandPolicy::Allow, false, false),
            CommandApproval::Ask { offer_always: true }
        );
        // An admin cap of "ask" pauses a folder the person always allowed.
        assert_eq!(
            command_approval(CommandPolicy::Ask, true, false),
            CommandApproval::Ask {
                offer_always: false
            }
        );
    }

    #[test]
    fn a_command_that_can_edit_the_folder_asks_even_where_always_allowed() {
        assert_eq!(
            command_approval(CommandPolicy::Allow, true, true),
            CommandApproval::Ask {
                offer_always: false
            }
        );
        assert_eq!(
            command_approval(CommandPolicy::Allow, false, true),
            CommandApproval::Ask {
                offer_always: false
            }
        );
        assert_eq!(
            command_approval(CommandPolicy::Ask, true, true),
            CommandApproval::Ask {
                offer_always: false
            }
        );
        assert_eq!(
            command_approval(CommandPolicy::Never, true, true),
            CommandApproval::Refuse
        );
    }

    #[test]
    fn the_local_allow_list_is_per_bot_and_folder_and_survives_reload() {
        let dir = std::env::temp_dir().join(fresh_id("allow-list"));
        let path = dir.join("host-command-approvals.json");
        let list = LocalCommandAllowList::new(&path);
        let root = Path::new("/Users/someone/project");
        assert!(!list.allows("bot-a", root));
        list.remember("bot-a", root).unwrap();
        list.remember("bot-a", root).unwrap();
        let reloaded = LocalCommandAllowList::new(&path);
        assert!(reloaded.allows("bot-a", root));
        assert!(!reloaded.allows("bot-b", root));
        assert!(!reloaded.allows("bot-a", Path::new("/Users/someone/other")));
        reloaded.forget("bot-a", root).unwrap();
        assert!(!list.allows("bot-a", root));
        fs::write(&path, b"not json").unwrap();
        assert!(!list.allows("bot-a", root));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_never_policy_in_the_poll_response_parses() {
        let operation: DesktopOperation = serde_json::from_str(
            r#"{"operationId":"op","kind":"run_command","botId":"b","actorId":"a","command":"ls","commandPolicy":"never"}"#,
        )
        .unwrap();
        assert_eq!(
            CommandPolicy::from_wire(operation.command_policy.as_deref()),
            CommandPolicy::Never
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{Address, Engine};
    use crate::quiet::command as quiet_command;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    struct BlockingFolderApprovalUi {
        root: PathBuf,
        calls: AtomicUsize,
        called_tx: Mutex<mpsc::Sender<()>>,
        release_rx: Mutex<mpsc::Receiver<()>>,
    }

    impl HostApprovalUi for BlockingFolderApprovalUi {
        fn choose_folder(&self, _: &ChooseFolderPrompt) -> HostAccessResult<ApprovedFolder> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.called_tx.lock().unwrap().send(()).unwrap();
            self.release_rx.lock().unwrap().recv().unwrap();
            Ok(ApprovedFolder {
                root: self.root.clone(),
            })
        }

        fn confirm_write(&self, _: &WritePrompt) -> HostAccessResult<()> {
            unreachable!("choose_folder regression must not ask for write approval")
        }

        fn confirm_command(&self, _: &CommandPrompt) -> HostAccessResult<()> {
            unreachable!("choose_folder regression must not ask for command approval")
        }
    }

    struct ResultCollector {
        base_url: String,
        bodies: Arc<Mutex<Vec<String>>>,
        thread: Option<JoinHandle<()>>,
    }

    impl ResultCollector {
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let base_url = format!("http://{}", listener.local_addr().unwrap());
            let bodies = Arc::new(Mutex::new(Vec::new()));
            let worker_bodies = bodies.clone();
            let thread = thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(3);
                loop {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            // Winsock accept inherits the listener's nonblocking mode.
                            // Only accept polls; each fixture request uses bounded blocking I/O.
                            stream.set_nonblocking(false).unwrap();
                            stream
                                .set_read_timeout(Some(Duration::from_secs(2)))
                                .unwrap();
                            stream
                                .set_write_timeout(Some(Duration::from_secs(2)))
                                .unwrap();
                            let mut reader = BufReader::new(stream.try_clone().unwrap());
                            let mut content_length = 0_usize;
                            loop {
                                let mut line = String::new();
                                reader.read_line(&mut line).unwrap();
                                let trimmed = line.trim_end();
                                if trimmed.is_empty() {
                                    break;
                                }
                                if let Some(value) = trimmed.strip_prefix("content-length: ") {
                                    content_length = value.parse().unwrap();
                                } else if let Some(value) = trimmed.strip_prefix("Content-Length: ")
                                {
                                    content_length = value.parse().unwrap();
                                }
                            }
                            let mut body = vec![0_u8; content_length];
                            reader.read_exact(&mut body).unwrap();
                            worker_bodies
                                .lock()
                                .unwrap()
                                .push(String::from_utf8(body).unwrap());
                            stream
                                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                                .unwrap();
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            if Instant::now() >= deadline {
                                return;
                            }
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => return,
                    }
                }
            });
            Self {
                base_url,
                bodies,
                thread: Some(thread),
            }
        }

        fn wait_for_posts(&self, count: usize) {
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                if self.bodies.lock().unwrap().len() >= count {
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
            panic!("timed out waiting for {count} host result posts");
        }

        fn bodies(&self) -> Vec<String> {
            self.bodies.lock().unwrap().clone()
        }
    }

    impl Drop for ResultCollector {
        fn drop(&mut self) {
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    #[test]
    fn result_collector_accepts_delayed_fragmented_requests() {
        let collector = ResultCollector::start();
        let address = collector.base_url.strip_prefix("http://").unwrap();
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream.write_all(b"POST /res").unwrap();
        thread::sleep(Duration::from_millis(50));
        stream
            .write_all(b"ults HTTP/1.1\r\nHost: localhost\r\nContent-Length: 11\r\n\r\n{\"ok\":")
            .unwrap();
        thread::sleep(Duration::from_millis(50));
        stream.write_all(b"true}").unwrap();
        // Content-Length frames the response; a subsequent socket close is not part of it.
        let expected = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}";
        let mut response = vec![0_u8; expected.len()];
        stream.read_exact(&mut response).unwrap();
        assert_eq!(response, expected);
        assert_eq!(collector.bodies(), vec!["{\"ok\":true}".to_owned()]);
    }

    fn temp_root(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn grant_root_rejects_forbidden_ancestors_and_children() {
        let root = temp_root("host-access-root");
        let forbidden = root.join("private");
        fs::create_dir_all(&forbidden).unwrap();
        assert!(validate_grant_root(&root, std::slice::from_ref(&forbidden)).is_err());
        assert!(validate_grant_root(&forbidden, std::slice::from_ref(&root)).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn grant_root_rejects_default_credential_directories_and_overlapping_folders() {
        let home = temp_root("host-access-credential-home");
        let forbidden = forbidden_paths_with_home(&[], Some(&home));
        let mut allowed_secrets = Vec::new();
        for relative in [
            ".config/gh",
            ".local/share/keyrings",
            ".claude",
            ".codex",
            "AppData/Roaming/GitHub CLI",
        ] {
            let directory = home.join(relative);
            let child = directory.join("nested");
            fs::create_dir_all(&child).unwrap();
            for candidate in [directory.as_path(), &child, directory.parent().unwrap()] {
                if validate_grant_root_with_forbidden(candidate, &forbidden).is_ok() {
                    allowed_secrets.push(candidate.to_path_buf());
                }
            }
            let sibling = home.join(format!("{relative}-project"));
            fs::create_dir_all(&sibling).unwrap();
            assert!(validate_grant_root_with_forbidden(&sibling, &forbidden).is_ok());
        }
        fs::remove_dir_all(home).unwrap();
        assert!(
            allowed_secrets.is_empty(),
            "credential folders allowed: {allowed_secrets:?}"
        );
    }

    #[test]
    fn grant_root_rejects_home_credential_files_but_allows_project_configuration() {
        let home = temp_root("host-access-credential-files");
        let forbidden = forbidden_paths_with_home(&[], Some(&home));
        let mut allowed_secrets = Vec::new();
        for relative in [
            ".cargo/credentials",
            ".cargo/credentials.toml",
            ".netrc",
            ".git-credentials",
            ".npmrc",
        ] {
            let file = home.join(relative);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, "test credential").unwrap();
            for candidate in [file.as_path(), file.parent().unwrap()] {
                if validate_grant_root_with_forbidden(candidate, &forbidden).is_ok() {
                    allowed_secrets.push(candidate.to_path_buf());
                }
            }
        }
        for relative in ["projects/app", ".cargo/registry"] {
            let project = home.join(relative);
            fs::create_dir_all(&project).unwrap();
            fs::write(
                project.join(".npmrc"),
                "registry=https://registry.npmjs.org",
            )
            .unwrap();
            assert!(validate_grant_root_with_forbidden(&project, &forbidden).is_ok());
            assert!(resolve_relative(&project, ".npmrc").is_ok());
        }
        fs::remove_dir_all(home).unwrap();
        assert!(
            allowed_secrets.is_empty(),
            "credential files allowed: {allowed_secrets:?}"
        );
    }

    #[test]
    fn grant_root_rejects_relocated_windows_system_directories() {
        let root = temp_root("host-access-windows-locations");
        let locations = [
            ("SystemRoot", root.join("relocated/Windows")),
            ("ProgramFiles", root.join("relocated/Applications")),
            ("ProgramFiles(x86)", root.join("relocated/Applications x86")),
            ("ProgramW6432", root.join("relocated/Applications x64")),
            ("ProgramData", root.join("relocated/Shared data")),
        ];
        for (_, directory) in &locations {
            fs::create_dir_all(directory.join("nested")).unwrap();
        }
        let paths = windows_environment_paths(|name| {
            locations
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, path)| path.join(".").into_os_string())
        });
        let forbidden = forbidden_paths_with_home(&paths, None);
        let mut allowed_system_paths = Vec::new();
        for (_, directory) in &locations {
            for candidate in [
                directory.clone(),
                directory.join("nested"),
                directory.parent().unwrap().to_path_buf(),
            ] {
                if validate_grant_root_with_forbidden(&candidate, &forbidden).is_ok() {
                    allowed_system_paths.push(candidate);
                }
            }
            let sibling = directory.with_file_name(format!(
                "{}-project",
                directory.file_name().unwrap().to_string_lossy()
            ));
            fs::create_dir_all(&sibling).unwrap();
            assert!(validate_grant_root_with_forbidden(&sibling, &forbidden).is_ok());
        }
        fs::remove_dir_all(root).unwrap();
        assert!(
            allowed_system_paths.is_empty(),
            "system folders allowed: {allowed_system_paths:?}"
        );
    }

    #[test]
    fn grant_root_rejects_github_cli_credentials_under_relocated_appdata() {
        let root = temp_root("host-access-github-cli-appdata");
        let app_data = root.join("relocated/Roaming");
        let credentials = app_data.join("GitHub CLI");
        let child = credentials.join("nested");
        let sibling = app_data.join("GitHub CLI-project");
        fs::create_dir_all(&child).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        let paths = windows_environment_paths(|name| {
            (name == "AppData").then(|| app_data.clone().into_os_string())
        });
        let forbidden = forbidden_paths_with_home(&paths, None);
        let allowed_secrets: Vec<_> = [&credentials, &child, &app_data]
            .into_iter()
            .filter(|path| validate_grant_root_with_forbidden(path, &forbidden).is_ok())
            .collect();
        assert!(validate_grant_root_with_forbidden(&sibling, &forbidden).is_ok());
        fs::remove_dir_all(root).unwrap();
        assert!(
            allowed_secrets.is_empty(),
            "GitHub CLI folders allowed: {allowed_secrets:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn grant_root_rejects_windows_system_directories_from_process_environment() {
        for name in [
            "SystemRoot",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
            "ProgramData",
        ] {
            let Some(value) = std::env::var_os(name) else {
                assert!(
                    matches!(name, "ProgramFiles(x86)" | "ProgramW6432"),
                    "missing {name}"
                );
                continue;
            };
            let path = PathBuf::from(value);
            let canonical_path = canonical(&path).unwrap();
            assert!(
                forbidden_paths(&[])
                    .protected_subtrees
                    .contains(&canonical_path),
                "system location missing: {name}"
            );
            assert!(
                validate_grant_root(&path, &[]).is_err(),
                "system location allowed: {name}"
            );
        }
    }

    #[test]
    fn relative_paths_cannot_escape_through_dotdot_or_symlink() {
        let root = temp_root("host-access-relative");
        let outside = temp_root("host-access-outside");
        fs::write(root.join("inside.txt"), "ok").unwrap();
        fs::write(outside.join("secret.txt"), "nope").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("link")).unwrap();
        assert!(resolve_relative(&root, "inside.txt").is_ok());
        assert!(resolve_relative(&root, "../outside").is_err());
        #[cfg(unix)]
        assert!(resolve_relative(&root, "link").is_err());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn docker_args_are_offline_readonly_nonroot_and_have_no_engine_socket() {
        let root = temp_root("host-access-args");
        let config = HostAccessConfig::new(
            "http://127.0.0.1:3001",
            "token",
            Address::new(Engine::Docker, None),
            DEFAULT_IMAGE,
            vec![],
        );
        let mut command = quiet_command("docker");
        append_container_create_args(
            &mut command,
            &config,
            "test-instance",
            "case",
            &root,
            false,
            "cat /approved/a",
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args.windows(2).any(|pair| pair == ["--network", "none"]));
        assert!(args.iter().any(|arg| arg == "--read-only"));
        assert!(args.windows(2).any(|pair| pair == ["--cap-drop", "ALL"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--security-opt", "no-new-privileges=true"]));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--user" && !pair[1].starts_with('0')));
        assert!(args.iter().any(|arg| arg.contains("readonly")));
        assert!(args.iter().any(|arg| arg == "timeout"));
        assert!(!args
            .iter()
            .any(|arg| arg.contains("docker.sock") || arg.contains("podman.sock")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn podman_args_use_supported_tmpfs_and_nonrecursive_bind_flags() {
        let root = temp_root("host-access-podman-args");
        let config = HostAccessConfig::new(
            "http://127.0.0.1:3001",
            "token",
            Address::new(Engine::Podman, Some("openbot".into())),
            DEFAULT_IMAGE,
            vec![],
        );
        let mut command = quiet_command("podman");
        append_container_create_args(
            &mut command,
            &config,
            "test-instance",
            "case",
            &root,
            false,
            "true",
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args.iter().any(|arg| arg == "--read-only-tmpfs=false"));
        assert!(args
            .iter()
            .any(|arg| arg.contains("bind-nonrecursive=true")));
        assert!(!args
            .iter()
            .any(|arg| arg.contains("uid=") || arg.contains("gid=")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn redelivered_active_operation_does_not_reject_or_duplicate_native_approval() {
        let root = temp_root("host-access-redelivery");
        let collector = ResultCollector::start();
        let (called_tx, called_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let approval = Arc::new(BlockingFolderApprovalUi {
            root: root.clone(),
            calls: AtomicUsize::new(0),
            called_tx: Mutex::new(called_tx),
            release_rx: Mutex::new(release_rx),
        });
        let config = HostAccessConfig::new(
            collector.base_url.clone(),
            "token",
            Address::new(Engine::Docker, None),
            DEFAULT_IMAGE,
            vec![],
        );
        let inner = Arc::new(Inner {
            config,
            approval: approval.clone(),
            instance_label: "test-instance".into(),
            effect_lock: Mutex::new(()),
            prompt_lock: Mutex::new(()),
            state: Mutex::new(State {
                stopped: false,
                thread: None,
                grants: HashMap::new(),
                running: HashMap::new(),
                completed: HashSet::new(),
                canceled_operations: HashSet::new(),
                active_by_operation: HashSet::new(),
                active_by_bot: HashMap::new(),
            }),
        });
        fn redelivered_operation() -> DesktopOperation {
            DesktopOperation {
                operation_id: "op-redelivered".into(),
                kind: HostOperationKind::ChooseFolder,
                bot_id: "bot-a".into(),
                actor_id: "actor-a".into(),
                bot_name: Some("Research Bot".into()),
                grant_id: None,
                target_operation_id: None,
                relative_path: None,
                content: None,
                command: None,
                writable: Some(false),
                command_policy: None,
                expires_at: None,
                received_at_ms: now_millis(),
            }
        }
        let client = Client::new();

        inner.spawn_operation(client.clone(), redelivered_operation());
        called_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        inner.spawn_operation(client, redelivered_operation());
        thread::sleep(Duration::from_millis(50));

        assert_eq!(approval.calls.load(Ordering::SeqCst), 1);
        assert_eq!(collector.bodies(), Vec::<String>::new());

        release_tx.send(()).unwrap();
        collector.wait_for_posts(1);
        thread::sleep(Duration::from_millis(50));
        let posts = collector.bodies();
        assert_eq!(posts.len(), 1);
        let posted: serde_json::Value = serde_json::from_str(&posts[0]).unwrap();
        assert_eq!(posted["operationId"], "op-redelivered");
        assert_eq!(posted["ok"], true);
        assert!(posted["grant"].is_object());
        fs::remove_dir_all(root).unwrap();
    }

    /// The person's first "Allow this command?" is left open; every later one is denied.
    struct LateCommandApprovalUi {
        asked: AtomicUsize,
        asked_tx: Mutex<mpsc::Sender<()>>,
        release_rx: Mutex<mpsc::Receiver<()>>,
        lapsed: Mutex<Vec<LapsedApproval>>,
    }

    impl HostApprovalUi for LateCommandApprovalUi {
        fn choose_folder(&self, _: &ChooseFolderPrompt) -> HostAccessResult<ApprovedFolder> {
            unreachable!("the grant is made by the test")
        }

        fn confirm_write(&self, _: &WritePrompt) -> HostAccessResult<()> {
            unreachable!("only commands are asked about here")
        }

        fn confirm_command(&self, _: &CommandPrompt) -> HostAccessResult<()> {
            let first = self.asked.fetch_add(1, Ordering::SeqCst) == 0;
            self.asked_tx.lock().unwrap().send(()).unwrap();
            if first {
                self.release_rx.lock().unwrap().recv().unwrap();
                return Ok(());
            }
            Err(HostAccessError::Denied(
                "Declined in OpenBot Desktop.".into(),
            ))
        }

        fn approval_lapsed(&self, notice: &LapsedApproval) {
            self.lapsed.lock().unwrap().push(notice.clone());
        }
    }

    /*
     * FOUND ON A MAC: an "Allow this command?" left past the server's two minutes ended the folder
     * for good, and the dialog stayed up offering an Allow that did nothing. The server now
     * cancels an operation that ran out its time without naming its grant; this is what the
     * desktop does with that cancel and with the Allow pressed after it.
     */
    #[test]
    fn a_command_allowed_after_the_server_stopped_waiting_does_not_run_and_the_folder_still_asks() {
        let (asked_tx, asked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let approval = Arc::new(LateCommandApprovalUi {
            asked: AtomicUsize::new(0),
            asked_tx: Mutex::new(asked_tx),
            release_rx: Mutex::new(release_rx),
            lapsed: Mutex::new(Vec::new()),
        });
        let config = HostAccessConfig::new(
            "http://127.0.0.1:9",
            "token",
            Address::new(Engine::Docker, None),
            DEFAULT_IMAGE,
            vec![],
        );
        let inner = Arc::new(Inner {
            config,
            approval: approval.clone(),
            instance_label: "test-instance".into(),
            effect_lock: Mutex::new(()),
            prompt_lock: Mutex::new(()),
            state: Mutex::new(State {
                stopped: false,
                thread: None,
                grants: HashMap::from([(
                    "grant".into(),
                    LocalGrant {
                        id: "grant".into(),
                        bot_id: "bot-a".into(),
                        actor_id: "actor".into(),
                        bot_name: Some("Research Bot".into()),
                        root: temp_root("host-access-late-allow"),
                        revoked: false,
                    },
                )]),
                running: HashMap::new(),
                completed: HashSet::new(),
                canceled_operations: HashSet::new(),
                active_by_operation: HashSet::new(),
                active_by_bot: HashMap::new(),
            }),
        });
        let operation =
            |id: &str, kind: HostOperationKind, target: Option<&str>| DesktopOperation {
                operation_id: id.into(),
                kind,
                bot_id: "bot-a".into(),
                actor_id: "actor".into(),
                bot_name: None,
                grant_id: matches!(kind, HostOperationKind::RunCommand).then(|| "grant".into()),
                target_operation_id: target.map(str::to_string),
                relative_path: None,
                content: None,
                command: matches!(kind, HostOperationKind::RunCommand).then(|| "ls -la".into()),
                writable: Some(false),
                command_policy: None,
                expires_at: None,
                received_at_ms: now_millis(),
            };

        let worker = inner.clone();
        let first = operation("op-late", HostOperationKind::RunCommand, None);
        let answered = thread::spawn(move || worker.handle_operation(&first).map(|_| ()));
        asked_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        // The server stops waiting and cancels that one operation, naming no grant.
        inner
            .handle_operation(&operation(
                "op-cancel",
                HostOperationKind::Cancel,
                Some("op-late"),
            ))
            .unwrap();
        // Then the person presses Allow once on the dialog still on screen.
        release_tx.send(()).unwrap();
        let error = answered.join().unwrap().unwrap_err();
        assert_eq!(
            public_error_message(&error, &inner.config),
            "Host operation approval expired."
        );
        assert_eq!(
            *approval.lapsed.lock().unwrap(),
            vec![LapsedApproval {
                bot_id: "bot-a".into(),
                bot_name: Some("Research Bot".into()),
                action: LapsedAction::Command,
            }]
        );

        // The next command on the same folder asks again.
        let next = inner
            .handle_operation(&operation("op-next", HostOperationKind::RunCommand, None))
            .map(|_| ())
            .unwrap_err();
        assert_eq!(approval.asked.load(Ordering::SeqCst), 2);
        assert_eq!(
            public_error_message(&next, &inner.config),
            "Declined in OpenBot Desktop."
        );
        assert!(!inner.state.lock().unwrap().grants["grant"].revoked);
    }

    /*
     * FOUND ON A MAC: with an "Allow this command?" the server had given up on still on screen,
     * every folder action that Bot asked for next failed with "That Bot already has a host
     * operation in progress." until someone dismissed the stale dialog. Freed of that, the next
     * dialog then sat exactly on top of the stale one, two identical dialogs nobody could tell
     * apart. The next action is taken, and its dialog waits its turn: shown once the stale one is
     * answered and its "didn't run" notice closed, and never shown at all if it is no longer wanted
     * by then.
     */
    #[test]
    fn a_dialog_left_on_screen_holds_up_no_bot_and_the_next_dialog_waits_its_turn() {
        let collector = ResultCollector::start();
        let (asked_tx, asked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let approval = Arc::new(LateCommandApprovalUi {
            asked: AtomicUsize::new(0),
            asked_tx: Mutex::new(asked_tx),
            release_rx: Mutex::new(release_rx),
            lapsed: Mutex::new(Vec::new()),
        });
        let config = HostAccessConfig::new(
            collector.base_url.clone(),
            "token",
            Address::new(Engine::Docker, None),
            DEFAULT_IMAGE,
            vec![],
        );
        let grant = |bot: &str| LocalGrant {
            id: format!("grant-{bot}"),
            bot_id: bot.into(),
            actor_id: "actor".into(),
            bot_name: Some("Research Bot".into()),
            root: temp_root("host-access-stale-dialog"),
            revoked: false,
        };
        let inner = Arc::new(Inner {
            config,
            approval: approval.clone(),
            instance_label: "test-instance".into(),
            effect_lock: Mutex::new(()),
            prompt_lock: Mutex::new(()),
            state: Mutex::new(State {
                stopped: false,
                thread: None,
                grants: HashMap::from([
                    ("grant-bot-a".into(), grant("bot-a")),
                    ("grant-bot-b".into(), grant("bot-b")),
                ]),
                running: HashMap::new(),
                completed: HashSet::new(),
                canceled_operations: HashSet::new(),
                active_by_operation: HashSet::new(),
                active_by_bot: HashMap::new(),
            }),
        });
        let command = |id: &str, bot: &str| DesktopOperation {
            operation_id: id.into(),
            kind: HostOperationKind::RunCommand,
            bot_id: bot.into(),
            actor_id: "actor".into(),
            bot_name: None,
            grant_id: Some(format!("grant-{bot}")),
            target_operation_id: None,
            relative_path: None,
            content: None,
            command: Some("ls -la".into()),
            writable: Some(false),
            command_policy: None,
            expires_at: None,
            received_at_ms: now_millis(),
        };
        let cancel = |id: &str, target: &str, bot: &str| DesktopOperation {
            kind: HostOperationKind::Cancel,
            grant_id: None,
            command: None,
            target_operation_id: Some(target.into()),
            ..command(id, bot)
        };
        let posted = |id: &str| {
            collector
                .bodies()
                .iter()
                .map(|body| serde_json::from_str::<serde_json::Value>(body).unwrap())
                .find(|body| body["operationId"] == id)
        };
        let client = Client::new();

        inner.spawn_operation(client.clone(), command("op-stale", "bot-a"));
        asked_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        inner.spawn_operation(client.clone(), cancel("op-c1", "op-stale", "bot-a"));

        // The person is away. The Bot asks again, and another Bot asks for something that is then
        // given up on too, while the stale dialog is still open.
        inner.spawn_operation(client.clone(), command("op-next", "bot-a"));
        inner.spawn_operation(client.clone(), command("op-gone", "bot-b"));
        thread::sleep(Duration::from_millis(150));
        inner.spawn_operation(client.clone(), cancel("op-c2", "op-gone", "bot-b"));
        thread::sleep(Duration::from_millis(150));
        assert!(
            posted("op-next").is_none(),
            "the Bot's next action was turned away: {:?}",
            posted("op-next")
        );
        assert_eq!(
            approval.asked.load(Ordering::SeqCst),
            1,
            "a second dialog was shown on top of the stale one"
        );

        // The person comes back and presses Allow on the stale dialog: nothing runs, they are told
        // so, and only then is the next dialog shown. The one given up on meanwhile never is.
        release_tx.send(()).unwrap();
        asked_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("the waiting dialog was not shown after the stale one was answered");
        collector.wait_for_posts(5);
        assert_eq!(approval.lapsed.lock().unwrap().len(), 1);
        assert_eq!(approval.asked.load(Ordering::SeqCst), 2);
        assert_eq!(
            posted("op-stale").unwrap()["error"],
            "Host operation approval expired."
        );
        assert_eq!(
            posted("op-next").unwrap()["error"],
            "Declined in OpenBot Desktop."
        );
        assert_eq!(posted("op-gone").unwrap()["ok"], false);
        thread::sleep(Duration::from_millis(50));
        let state = inner.state.lock().unwrap();
        assert!(state.active_by_bot.is_empty());
        assert!(!state.grants["grant-bot-a"].revoked);
    }

    struct SameFolderApprovalUi {
        root: PathBuf,
        asked_to_change: AtomicUsize,
    }

    impl HostApprovalUi for SameFolderApprovalUi {
        fn choose_folder(&self, _: &ChooseFolderPrompt) -> HostAccessResult<ApprovedFolder> {
            Ok(ApprovedFolder {
                root: self.root.clone(),
            })
        }

        fn confirm_write(&self, _: &WritePrompt) -> HostAccessResult<()> {
            self.asked_to_change.fetch_add(1, Ordering::SeqCst);
            Err(HostAccessError::Denied(
                "Declined in OpenBot Desktop.".into(),
            ))
        }

        fn confirm_command(&self, request: &CommandPrompt) -> HostAccessResult<()> {
            assert!(
                request.writable,
                "only commands that change files are asked here"
            );
            self.asked_to_change.fetch_add(1, Ordering::SeqCst);
            Err(HostAccessError::Denied(
                "Declined in OpenBot Desktop.".into(),
            ))
        }
    }

    /*
     * FOUND ON A MAC: choosing a folder the Bot already had made a second grant beside the first,
     * so Settings → Computer read "2 read-only folders" and the Bot was handed two grants with one
     * name.
     */
    #[test]
    fn choosing_a_folder_the_bot_already_has_keeps_one_grant_and_makes_it_live_again() {
        let root = fs::canonicalize(temp_root("host-access-same-folder")).unwrap();
        fs::write(root.join("notes.txt"), "hello").unwrap();
        let approval = Arc::new(SameFolderApprovalUi {
            root: root.clone(),
            asked_to_change: AtomicUsize::new(0),
        });
        let inner = Inner {
            config: HostAccessConfig::new(
                "http://127.0.0.1:9",
                "token",
                Address::new(Engine::Docker, None),
                DEFAULT_IMAGE,
                vec![],
            ),
            approval: approval.clone(),
            instance_label: "test-instance".into(),
            effect_lock: Mutex::new(()),
            prompt_lock: Mutex::new(()),
            state: Mutex::new(State {
                stopped: false,
                thread: None,
                grants: HashMap::new(),
                running: HashMap::new(),
                completed: HashSet::new(),
                canceled_operations: HashSet::new(),
                active_by_operation: HashSet::new(),
                active_by_bot: HashMap::new(),
            }),
        };
        let choose = |id: &str, bot: &str| DesktopOperation {
            operation_id: id.into(),
            kind: HostOperationKind::ChooseFolder,
            bot_id: bot.into(),
            actor_id: "actor".into(),
            bot_name: Some("Research Bot".into()),
            grant_id: None,
            target_operation_id: None,
            relative_path: None,
            content: None,
            command: None,
            writable: Some(false),
            command_policy: None,
            expires_at: None,
            received_at_ms: now_millis(),
        };
        let granted = |id: &str, bot: &str| {
            inner
                .handle_operation(&choose(id, bot))
                .unwrap()
                .grant
                .unwrap()
                .grant_id
        };

        let first = granted("op-1", "bot-a");
        inner
            .state
            .lock()
            .unwrap()
            .grants
            .get_mut(&first)
            .unwrap()
            .revoked = true;
        let again = granted("op-2", "bot-a");
        assert_eq!(again, first);
        {
            let state = inner.state.lock().unwrap();
            assert_eq!(state.grants.len(), 1);
            assert!(!state.grants[&first].revoked);
        }
        // A grant is read-only whichever time it was chosen: the grant it comes back as carries
        // nothing over, and every change to the folder still asks the person, each time.
        let change = |id: &str, kind: HostOperationKind| DesktopOperation {
            kind,
            grant_id: Some(first.clone()),
            relative_path: matches!(kind, HostOperationKind::WriteFile).then(|| "notes.txt".into()),
            content: matches!(kind, HostOperationKind::WriteFile).then(|| "changed".into()),
            command: matches!(kind, HostOperationKind::RunCommand).then(|| "rm notes.txt".into()),
            writable: Some(matches!(kind, HostOperationKind::RunCommand)),
            command_policy: Some("allow".into()),
            ..choose(id, "bot-a")
        };
        for (id, kind) in [
            ("op-write", HostOperationKind::WriteFile),
            ("op-edit", HostOperationKind::RunCommand),
        ] {
            let refused = inner.handle_operation(&change(id, kind)).map(|_| ());
            assert_eq!(
                public_error_message(&refused.unwrap_err(), &inner.config),
                "Declined in OpenBot Desktop."
            );
        }
        assert_eq!(approval.asked_to_change.load(Ordering::SeqCst), 2);
        // Another Bot given the same folder has its own grant.
        assert_ne!(granted("op-3", "bot-b"), first);
        assert_eq!(inner.state.lock().unwrap().grants.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn grant_binding_refuses_wrong_bot_or_actor() {
        let config = HostAccessConfig::new(
            "http://127.0.0.1:3001",
            "token",
            Address::new(Engine::Docker, None),
            DEFAULT_IMAGE,
            vec![],
        );
        let inner = Inner {
            config,
            approval: Arc::new(DenyAllApprovalUi),
            instance_label: "test-instance".into(),
            effect_lock: Mutex::new(()),
            prompt_lock: Mutex::new(()),
            state: Mutex::new(State {
                stopped: false,
                thread: None,
                grants: HashMap::from([(
                    "grant".into(),
                    LocalGrant {
                        id: "grant".into(),
                        bot_id: "bot-a".into(),
                        actor_id: "actor".into(),
                        bot_name: None,
                        root: temp_root("host-access-grant"),
                        revoked: false,
                    },
                )]),
                running: HashMap::new(),
                completed: HashSet::new(),
                canceled_operations: HashSet::new(),
                active_by_operation: HashSet::new(),
                active_by_bot: HashMap::new(),
            }),
        };
        let operation = DesktopOperation {
            operation_id: "op1".into(),
            kind: HostOperationKind::ReadFile,
            bot_id: "bot-b".into(),
            actor_id: "actor".into(),
            bot_name: None,
            grant_id: Some("grant".into()),
            target_operation_id: None,
            relative_path: Some("file.txt".into()),
            content: None,
            command: None,
            writable: None,
            command_policy: None,
            expires_at: None,
            received_at_ms: now_millis(),
        };
        assert!(inner.require_grant(&operation).is_err());
    }

    #[test]
    fn ordinary_child_folder_under_home_is_allowed_but_home_itself_is_not() {
        let Some(home) = home_dir() else {
            return;
        };
        let child = home.join(format!("openbot-host-access-{}", std::process::id()));
        fs::create_dir_all(&child).unwrap();
        assert!(validate_grant_root(&child, &[]).is_ok());
        assert!(validate_grant_root(&home, &[]).is_err());
        fs::remove_dir_all(child).unwrap();
    }

    #[test]
    fn container_paths_are_posix_even_for_windows_style_components() {
        assert_eq!(
            container_path(Path::new("nested/file.txt")),
            "/approved/nested/file.txt"
        );
        let expected = if cfg!(windows) {
            "/approved/nested/file.txt"
        } else {
            "/approved/nested\\file.txt"
        };
        assert_eq!(container_path(Path::new("nested\\file.txt")), expected);
    }

    #[test]
    fn output_above_the_cap_keeps_its_end_and_says_so() {
        let mut data = vec![b'x'; DEFAULT_OUTPUT_LIMIT * 3];
        data.extend_from_slice(b"the end");
        let (kept, truncated) =
            read_tail(std::io::Cursor::new(data), DEFAULT_OUTPUT_LIMIT).unwrap();
        assert!(truncated);
        assert_eq!(kept.len(), DEFAULT_OUTPUT_LIMIT);
        assert!(kept.ends_with(b"the end"));
        let (kept, truncated) = read_tail(std::io::Cursor::new(b"short".to_vec()), 64).unwrap();
        assert!(!truncated);
        assert_eq!(kept, b"short");
    }

    #[test]
    fn public_errors_do_not_leak_host_paths_or_engine_stderr() {
        let config = HostAccessConfig::new(
            "http://127.0.0.1:3001",
            "token",
            Address::new(Engine::Docker, None),
            DEFAULT_IMAGE,
            vec![],
        );
        let raw = HostAccessError::Runtime("docker: /Users/example/secret failed".into());
        let said = public_error_message(&raw, &config);
        assert!(!said.contains("/Users/example"));
        let raw = HostAccessError::Denied("Host path /Users/example/.ssh is unavailable".into());
        let said = public_error_message(&raw, &config);
        assert!(!said.contains("/Users/example"));
    }
}

/// The folder sandbox on a real engine: what the server, and through it the Bot, is told when a
/// command fails, for each way one fails. Every case here once answered "The local sandbox could
/// not complete the operation.", which told the Bot nothing, so it retried or gave up.
///
/// Runs Docker, so it is opt-in: `cargo test --lib host_access::live -- --ignored
/// --test-threads=1`. The image is `ubuntu:24.04` unless `OPENBOT_SANDBOX_TEST_IMAGE` names
/// another; it has the `timeout` and shell the sandbox runs and no Python, as the computer had none.
#[cfg(test)]
mod live {
    use super::*;
    use crate::engine::{Address, Engine};

    struct AllowAll;

    impl HostApprovalUi for AllowAll {
        fn choose_folder(&self, _: &ChooseFolderPrompt) -> HostAccessResult<ApprovedFolder> {
            unreachable!("the grant is made by the test")
        }
        fn confirm_write(&self, _: &WritePrompt) -> HostAccessResult<()> {
            Ok(())
        }
        fn confirm_command(&self, _: &CommandPrompt) -> HostAccessResult<()> {
            Ok(())
        }
    }

    fn image() -> String {
        std::env::var("OPENBOT_SANDBOX_TEST_IMAGE").unwrap_or_else(|_| "ubuntu:24.04".into())
    }

    /// A broker with one grant on a fresh folder, as the desktop holds one after Choose folder.
    struct Sandbox {
        inner: Inner,
        root: PathBuf,
    }

    impl Sandbox {
        fn new(configure: impl FnOnce(&mut HostAccessConfig)) -> Self {
            let pulled = Command::new("docker")
                .args(["image", "inspect", &image()])
                .output()
                .unwrap()
                .status
                .success()
                || Command::new("docker")
                    .args(["pull", "--quiet", &image()])
                    .status()
                    .unwrap()
                    .success();
            assert!(pulled, "could not pull {}", image());
            let root = std::env::temp_dir().join(format!(
                "openbot-sandbox-live-{}-{}",
                std::process::id(),
                now_millis()
            ));
            fs::create_dir_all(&root).unwrap();
            let root = fs::canonicalize(root).unwrap();
            fs::write(root.join("notes.txt"), "hello\n").unwrap();
            fs::write(
                root.join("sheet.xlsx"),
                [0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00],
            )
            .unwrap();
            let mut config = HostAccessConfig::new(
                "http://127.0.0.1:9",
                "token",
                Address::new(Engine::Docker, None),
                image(),
                vec![],
            );
            configure(&mut config);
            let mut grants = HashMap::new();
            grants.insert(
                "grant-live".to_string(),
                LocalGrant {
                    id: "grant-live".into(),
                    bot_id: "bot-live".into(),
                    actor_id: "actor-live".into(),
                    bot_name: Some("Live Bot".into()),
                    root: root.clone(),
                    revoked: false,
                },
            );
            let inner = Inner {
                config,
                approval: Arc::new(AllowAll),
                instance_label: fresh_id("host-live"),
                effect_lock: Mutex::new(()),
                prompt_lock: Mutex::new(()),
                state: Mutex::new(State {
                    stopped: false,
                    thread: None,
                    grants,
                    running: HashMap::new(),
                    completed: HashSet::new(),
                    canceled_operations: HashSet::new(),
                    active_by_operation: HashSet::new(),
                    active_by_bot: HashMap::new(),
                }),
            };
            Self { inner, root }
        }

        /// What the server would be sent for this operation: `Ok` with the result text, or
        /// `Err` with the error sentence.
        fn answer(
            &self,
            kind: HostOperationKind,
            command: Option<&str>,
            path: Option<&str>,
            writable: bool,
        ) -> Result<String, String> {
            let operation = DesktopOperation {
                operation_id: fresh_id("op-live"),
                kind,
                bot_id: "bot-live".into(),
                actor_id: "actor-live".into(),
                bot_name: Some("Live Bot".into()),
                grant_id: Some("grant-live".into()),
                target_operation_id: None,
                relative_path: path.map(str::to_string),
                content: None,
                command: command.map(str::to_string),
                writable: Some(writable),
                command_policy: None,
                expires_at: None,
                received_at_ms: now_millis(),
            };
            self.inner
                .handle_operation(&operation)
                .map(|success| success.output.unwrap_or_default())
                .map_err(|error| public_error_message(&error, &self.inner.config))
        }

        fn run(&self, command: &str) -> Result<String, String> {
            self.answer(HostOperationKind::RunCommand, Some(command), None, false)
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
            let _ = self.inner.verify_no_owned_containers();
        }
    }

    #[test]
    #[ignore = "runs docker"]
    fn a_command_that_succeeds_answers_with_what_it_printed() {
        let sandbox = Sandbox::new(|_| {});
        assert_eq!(sandbox.run("cat notes.txt"), Ok("hello\n".into()));
        assert_eq!(
            sandbox.answer(HostOperationKind::ListFiles, None, None, false),
            Ok("notes.txt\nsheet.xlsx\n".into())
        );
    }

    #[test]
    #[ignore = "runs docker"]
    fn a_command_that_fails_answers_with_its_exit_code_and_output() {
        let sandbox = Sandbox::new(|_| {});
        assert_eq!(
            sandbox.run("echo working; echo broke >&2; exit 3"),
            Ok("The command exited with code 3. What it printed:\nworking\nbroke\n".into())
        );
        assert_eq!(
            sandbox.run("exit 1"),
            Ok("The command exited with code 1. It printed nothing.".into())
        );
    }

    #[test]
    #[ignore = "runs docker"]
    fn a_missing_program_says_nothing_can_be_installed() {
        let sandbox = Sandbox::new(|_| {});
        let answer = sandbox.run("python3 -c 'print(1)'").unwrap();
        assert!(
            answer.starts_with(
                "The command exited with code 127. A program it named is not in the local \
                 sandbox, and the sandbox has no network, so nothing can be installed in it."
            ),
            "{answer}"
        );
        assert!(answer.contains("python3: not found"), "{answer}");
    }

    #[test]
    #[ignore = "runs docker"]
    fn a_write_to_a_read_only_folder_says_to_ask_for_writable() {
        let sandbox = Sandbox::new(|_| {});
        let answer = sandbox.run("echo new > made.txt").unwrap();
        assert!(
            answer.starts_with("The command exited with code"),
            "{answer}"
        );
        assert!(
            answer.contains("run the command again with writable set to true"),
            "{answer}"
        );
        assert_eq!(
            sandbox.answer(
                HostOperationKind::RunCommand,
                Some("echo new > made.txt && cat made.txt"),
                None,
                true
            ),
            Ok("new\n".into())
        );
    }

    #[test]
    #[ignore = "runs docker"]
    fn long_output_keeps_its_end_instead_of_failing() {
        let sandbox = Sandbox::new(|_| {});
        let answer = sandbox
            .run("head -c 200000 /dev/zero | tr '\\0' x; echo; echo the end")
            .unwrap();
        assert!(
            answer.starts_with("It printed more than 64 KB, so only the end is shown.\n"),
            "{}",
            &answer[..80]
        );
        assert!(answer.ends_with("the end\n"));
    }

    #[test]
    #[ignore = "runs docker"]
    fn output_that_is_not_text_is_shown_and_said_to_be_so() {
        let sandbox = Sandbox::new(|_| {});
        let answer = sandbox.run("printf 'ok \\377\\376'").unwrap();
        assert_eq!(
            answer,
            "Some of what it printed is not text and is shown as \u{FFFD}.\nok \u{FFFD}\u{FFFD}"
        );
    }

    #[test]
    #[ignore = "runs docker"]
    fn a_binary_file_read_as_text_says_to_open_it_with_a_command() {
        let sandbox = Sandbox::new(|_| {});
        let answer = sandbox.answer(HostOperationKind::ReadFile, None, Some("sheet.xlsx"), false);
        assert_eq!(
            answer,
            Err(
                "The file is not text (a spreadsheet, document, PDF or image, for example), so it \
                 cannot be read as text. Open it with a command instead, such as python3 with \
                 openpyxl for an .xlsx file."
                    .into()
            )
        );
    }

    #[test]
    #[ignore = "runs docker"]
    fn a_command_that_runs_too_long_is_stopped_and_says_so() {
        let sandbox = Sandbox::new(|config| config.operation_timeout = Duration::from_secs(2));
        assert_eq!(
            sandbox.run("sleep 20"),
            Err(
                "The command ran for more than 2 seconds, so the local sandbox stopped it. \
                 Anything it changed before then stays changed. Split the work into shorter \
                 commands."
                    .into()
            )
        );
    }

    #[test]
    #[ignore = "runs docker"]
    fn a_command_that_runs_out_of_memory_is_stopped_and_says_so() {
        let sandbox = Sandbox::new(|config| config.memory = "32m".into());
        assert_eq!(
            sandbox.run("head -c 300m /dev/zero | tail -c 250m > /dev/null"),
            Err(
                "The command used more than the local sandbox's 32m of memory, so it was \
                 stopped. Work on less at once, for example read a large file in parts."
                    .into()
            )
        );
    }

    #[test]
    #[ignore = "runs docker"]
    fn a_missing_image_says_nothing_ran_and_what_to_do() {
        let sandbox = Sandbox::new(|config| config.image = "openbot-sandbox-live:missing".into());
        assert_eq!(
            sandbox.run("true"),
            Err(
                "Nothing ran: the local sandbox's software is missing from this computer. \
                 Restarting OpenBot downloads it again; ask the person to restart OpenBot, then \
                 try again."
                    .into()
            )
        );
    }

    #[test]
    #[ignore = "runs docker"]
    fn a_folder_that_is_gone_says_nothing_ran_and_to_choose_it_again() {
        let sandbox = Sandbox::new(|_| {});
        fs::remove_dir_all(&sandbox.root).unwrap();
        assert_eq!(
            sandbox.run("ls"),
            Err(
                "Nothing ran: the folder is no longer where it was (moved, renamed, or on a \
                 drive that is not connected). Ask the person to choose it again for this Bot."
                    .into()
            )
        );
    }
}
