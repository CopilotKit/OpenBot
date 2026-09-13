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
}

struct State {
    stopped: bool,
    thread: Option<JoinHandle<()>>,
    grants: HashMap<String, LocalGrant>,
    running: HashMap<String, RunningContainer>,
    completed: HashSet<String>,
    canceled_operations: HashSet<String>,
    active_by_operation: HashSet<String>,
    active_by_bot: HashSet<String>,
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
    Runtime(String),
    Http(String),
    Denied(String),
    Io(String),
}

impl std::fmt::Display for HostAccessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostAccessError::InvalidConfig(message)
            | HostAccessError::Runtime(message)
            | HostAccessError::Http(message)
            | HostAccessError::Denied(message)
            | HostAccessError::Io(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for HostAccessError {}

pub type HostAccessResult<T> = Result<T, HostAccessError>;

pub trait HostApprovalUi: Send + Sync + 'static {
    fn choose_folder(&self, request: &ChooseFolderPrompt) -> HostAccessResult<ApprovedFolder>;
    fn confirm_write(&self, request: &WritePrompt) -> HostAccessResult<()>;
    fn confirm_command(&self, request: &CommandPrompt) -> HostAccessResult<()>;
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
    pub working_directory: Option<String>,
    pub command: String,
    pub writable: bool,
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
            state: Mutex::new(State {
                stopped: false,
                thread: None,
                grants: HashMap::new(),
                running: HashMap::new(),
                completed: HashSet::new(),
                canceled_operations: HashSet::new(),
                active_by_operation: HashSet::new(),
                active_by_bot: HashSet::new(),
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
            eprintln!("host access broker could not create HTTP client: {error}");
            return;
        }
    };
    while !inner.is_stopped() {
        match inner.next_operation(&client) {
            Ok(Some(operation)) => inner.spawn_operation(client.clone(), operation),
            Ok(None) => thread::sleep(inner.config.poll_interval),
            Err(error) => {
                eprintln!("host access broker poll failed and revoked local leases: {error}");
                if let Err(cleanup) = inner.revoke_all_and_stop() {
                    eprintln!("host access broker cleanup after poll failure failed: {cleanup}");
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
            } else if state.active_by_operation.len() >= MAX_ACTIVE_OPERATIONS {
                Err("Too many host operations are already waiting.".to_string())
            } else if state.active_by_bot.contains(&operation.bot_id) {
                Err("That Bot already has a host operation in progress.".to_string())
            } else {
                state
                    .active_by_operation
                    .insert(operation.operation_id.clone());
                state.active_by_bot.insert(operation.bot_id.clone());
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
                state.active_by_bot.remove(&worker_bot_id);
            })
        {
            let mut state = self.state.lock().expect("host state poisoned");
            state.active_by_operation.remove(&operation_id);
            state.active_by_bot.remove(&bot_id);
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
            eprintln!("host access broker could not post refusal: {error}");
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
                eprintln!(
                    "host access operation {} failed: {error}",
                    operation.operation_id
                );
                DesktopResult {
                    operation_id: operation.operation_id.clone(),
                    ok: false,
                    result: None,
                    grant: None,
                    error: Some(public_error_message(&error)),
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
            eprintln!("host access broker could not post result: {error}");
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
        let approved = self.approval.choose_folder(&ChooseFolderPrompt {
            operation_id: operation.operation_id.clone(),
            bot_id: operation.bot_id.clone(),
            actor_id: operation.actor_id.clone(),
            bot_name: operation.bot_name.clone(),
            writable_requested: operation.writable == Some(true),
        })?;
        let root = validate_grant_root(&approved.root, &self.config.forbidden_paths)?;
        self.ensure_operation_fresh(operation)?;
        if self.operation_was_canceled(&operation.operation_id) {
            return Err(HostAccessError::Denied(
                "Host operation was canceled before the folder was granted.".into(),
            ));
        }
        let grant_id = fresh_id("host-grant");
        let display_name = display_name_for(&root);
        let grant = LocalGrant {
            id: grant_id.clone(),
            bot_id: operation.bot_id.clone(),
            actor_id: operation.actor_id.clone(),
            bot_name: operation.bot_name.clone(),
            root,
            revoked: false,
        };
        self.state
            .lock()
            .expect("host state poisoned")
            .grants
            .insert(grant_id.clone(), grant);
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
        self.run_container(&operation.operation_id, &grant, false, &script)
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
        self.run_container(&operation.operation_id, &grant, false, &script)
            .map(OperationSuccess::output)
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
        self.approval.confirm_write(&WritePrompt {
            operation_id: operation.operation_id.clone(),
            bot_id: operation.bot_id.clone(),
            bot_name: grant.bot_name.clone(),
            root: grant.root.clone(),
            relative_path: relative_path.into(),
            content: content.clone(),
            writable: true,
        })?;
        self.ensure_operation_still_allowed(operation, &grant)?;
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
        self.run_container_with_stdin(
            &operation.operation_id,
            &grant,
            true,
            &script,
            content.as_bytes(),
        )?;
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
        self.approval.confirm_command(&CommandPrompt {
            operation_id: operation.operation_id.clone(),
            bot_id: operation.bot_id.clone(),
            bot_name: grant.bot_name.clone(),
            root: grant.root.clone(),
            working_directory: operation.relative_path.clone(),
            command: command.into(),
            writable,
        })?;
        self.ensure_operation_still_allowed(operation, &grant)?;
        let command_directory = if let Some(directory) = working_directory {
            let relative = host_relative(&grant.root, &directory)?;
            container_path(&relative)
        } else {
            APPROVED_MOUNT.into()
        };
        let script = format!("cd -- {} && {command}", shell_quote(command_directory));
        self.run_container(&operation.operation_id, &grant, writable, &script)
            .map(OperationSuccess::output)
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
    ) -> HostAccessResult<String> {
        self.run_container_with_stdin(operation_id, grant, writable, script, &[])
    }

    fn run_container_with_stdin(
        &self,
        operation_id: &str,
        grant: &LocalGrant,
        writable: bool,
        script: &str,
        stdin: &[u8],
    ) -> HostAccessResult<String> {
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

    fn start_attach_wait(&self, name: &str, stdin: &[u8]) -> HostAccessResult<String> {
        let mut start = self.config.engine.command();
        start.args(["start", "-a"]);
        if !stdin.is_empty() {
            start.arg("-i");
            start.stdin(Stdio::piped());
        }
        start.arg(name);
        start.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = start.spawn().map_err(|error| {
            HostAccessError::Runtime(format!("Could not start host container: {error}"))
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
        let output_limit = self.config.output_limit;
        let stdout_reader = thread::spawn(move || read_limited(stdout, output_limit));
        let stderr_reader = thread::spawn(move || read_limited(stderr, output_limit));
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
        let mut combined = stdout_reader
            .join()
            .map_err(|_| HostAccessError::Runtime("Host stdout reader panicked.".into()))??;
        combined.extend(
            stderr_reader
                .join()
                .map_err(|_| HostAccessError::Runtime("Host stderr reader panicked.".into()))??,
        );
        let text = limit_output(&combined, self.config.output_limit)?;
        if !status.success() {
            let inspect = self.run_engine(["inspect", "-f", "{{.State.ExitCode}}", name])?;
            let exit = String::from_utf8_lossy(&inspect.stdout).trim().to_string();
            return Err(HostAccessError::Runtime(format!(
                "Host operation exited with code {exit}: {text}"
            )));
        }
        Ok(text)
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

fn public_error_message(error: &HostAccessError) -> String {
    match error {
        HostAccessError::InvalidConfig(_) => "Local host access is not configured.".into(),
        HostAccessError::Http(_) => "The desktop lost its host access connection.".into(),
        HostAccessError::Runtime(message) if message.contains("timed out") => {
            "The host operation timed out and was stopped.".into()
        }
        HostAccessError::Runtime(message) if message.contains("output exceeded") => {
            "The host operation produced too much output and was stopped.".into()
        }
        HostAccessError::Runtime(_) => "The local sandbox could not complete the operation.".into(),
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
    let root = canonical(path)?;
    if root.parent().is_none() {
        return Err(HostAccessError::Denied(
            "The filesystem root cannot be granted.".into(),
        ));
    }
    let forbidden = forbidden_paths(configured_forbidden);
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
    let mut exact_or_ancestor_only = Vec::new();
    let mut protected_subtrees = Vec::new();
    protected_subtrees.extend(configured.iter().filter_map(|path| canonical(path).ok()));
    if let Some(home) = home_dir().and_then(|path| canonical(&path).ok()) {
        exact_or_ancestor_only.push(home.clone());
        for relative in [
            ".ssh",
            ".gnupg",
            ".aws",
            ".config/gcloud",
            ".docker",
            ".kube",
            "Library/Application Support/OpenBot",
            "Library/Application Support/Google/Chrome",
            "Library/Application Support/BraveSoftware",
            "Library/Application Support/Firefox",
            "Library/Keychains",
            "AppData/Roaming/OpenBot",
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
        "C:\\Windows",
        "C:\\Program Files",
        "C:\\Program Files (x86)",
        "C:\\ProgramData",
    ] {
        if let Ok(path) = canonical(Path::new(path)) {
            protected_subtrees.push(path);
        }
    }
    ForbiddenPaths {
        exact_or_ancestor_only,
        protected_subtrees,
    }
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

fn read_limited<R: Read>(mut reader: R, limit: usize) -> HostAccessResult<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer).map_err(|error| {
            HostAccessError::Runtime(format!("Could not read host output: {error}"))
        })?;
        if read == 0 {
            return Ok(output);
        }
        output.extend_from_slice(&buffer[..read]);
        if output.len() > limit {
            return Err(HostAccessError::Runtime(format!(
                "Host operation output exceeded {limit} bytes."
            )));
        }
    }
}

fn limit_output(bytes: &[u8], limit: usize) -> HostAccessResult<String> {
    if bytes.len() > limit {
        return Err(HostAccessError::Runtime(format!(
            "Host operation output exceeded {limit} bytes."
        )));
    }
    String::from_utf8(bytes.to_vec())
        .map_err(|_| HostAccessError::Runtime("Host operation returned non-UTF-8 output.".into()))
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
            state: Mutex::new(State {
                stopped: false,
                thread: None,
                grants: HashMap::new(),
                running: HashMap::new(),
                completed: HashSet::new(),
                canceled_operations: HashSet::new(),
                active_by_operation: HashSet::new(),
                active_by_bot: HashSet::new(),
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
                active_by_bot: HashSet::new(),
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
    fn bounded_reader_rejects_output_above_the_cap() {
        let data = vec![b'x'; DEFAULT_OUTPUT_LIMIT + 1];
        assert!(read_limited(std::io::Cursor::new(data), DEFAULT_OUTPUT_LIMIT).is_err());
    }

    #[test]
    fn public_errors_do_not_leak_host_paths_or_engine_stderr() {
        let raw = HostAccessError::Runtime("docker: /Users/example/secret failed".into());
        let said = public_error_message(&raw);
        assert!(!said.contains("/Users/example"));
        let raw = HostAccessError::Denied("Host path /Users/example/.ssh is unavailable".into());
        let said = public_error_message(&raw);
        assert!(!said.contains("/Users/example"));
    }
}
