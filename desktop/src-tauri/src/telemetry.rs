use rand::RngCore;
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const STATE_SCHEMA_VERSION: u8 = 1;
const STATE_FILE: &str = "telemetry-state.json";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const FLUSH_BUDGET: Duration = Duration::from_secs(6);

pub type Result<T> = std::result::Result<T, TelemetryError>;

#[derive(Debug)]
pub enum TelemetryError {
    Io(io::Error),
    Json(serde_json::Error),
    Http(reqwest::Error),
    MissingEndpoint,
    InvalidState(String),
    Poisoned,
}

impl From<io::Error> for TelemetryError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for TelemetryError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<reqwest::Error> for TelemetryError {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(error)
    }
}

impl std::fmt::Display for TelemetryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "telemetry I/O error: {error}"),
            Self::Json(error) => write!(formatter, "telemetry JSON error: {error}"),
            Self::Http(error) => write!(formatter, "telemetry HTTP error: {error}"),
            Self::MissingEndpoint => formatter.write_str("telemetry endpoint is missing"),
            Self::InvalidState(error) => write!(formatter, "invalid telemetry state: {error}"),
            Self::Poisoned => formatter.write_str("telemetry state lock is poisoned"),
        }
    }
}

impl std::error::Error for TelemetryError {}

#[derive(Debug, Clone)]
pub struct Config {
    pub enabled: bool,
    pub endpoint: Option<String>,
    pub max_queue: usize,
}

impl Config {
    pub fn disabled_for_tests() -> Self {
        Self {
            enabled: true,
            endpoint: None,
            max_queue: 256,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvOverride {
    Process,
    Enabled,
    Disabled,
}

#[derive(Debug)]
pub struct Telemetry {
    state_path: PathBuf,
    context: Mutex<Context>,
    config: Config,
    state: Mutex<Option<PersistedState>>,
    session_last_step_viewed: Mutex<Option<Step>>,
    flush_lock: Mutex<()>,
    client: Client,
}

impl Telemetry {
    pub fn open(data_dir: impl AsRef<Path>, context: Context, config: Config) -> Result<Arc<Self>> {
        Self::open_with_env(data_dir, context, config, EnvOverride::Process)
    }

    pub fn open_with_env(
        data_dir: impl AsRef<Path>,
        context: Context,
        config: Config,
        env_override: EnvOverride,
    ) -> Result<Arc<Self>> {
        let state_path = state_path(data_dir.as_ref());
        if telemetry_disabled(env_override) || !config.enabled {
            let _ = fs::remove_file(&state_path);
            return Ok(Arc::new(Self::disabled(state_path, context, config)?));
        }

        fs::create_dir_all(data_dir.as_ref())?;
        let mut state = if state_path.exists() {
            let state = serde_json::from_slice::<PersistedState>(&fs::read(&state_path)?)?;
            state.validate()?;
            state
        } else {
            PersistedState::new(new_uuid())
        };

        if !state.activated {
            if let Some(step) = state.last_step.take() {
                state.push_bounded(
                    Event::new(EventData::SetupAbandoned { step }, context.clone()),
                    normalized_max_queue(config.max_queue),
                );
            }
        }
        write_state(&state_path, &state)?;

        Ok(Arc::new(Self {
            state_path,
            context: Mutex::new(context),
            config,
            state: Mutex::new(Some(state)),
            session_last_step_viewed: Mutex::new(None),
            flush_lock: Mutex::new(()),
            client: client()?,
        }))
    }

    fn disabled(state_path: PathBuf, context: Context, config: Config) -> Result<Self> {
        Ok(Self {
            state_path,
            context: Mutex::new(context),
            config,
            state: Mutex::new(None),
            session_last_step_viewed: Mutex::new(None),
            flush_lock: Mutex::new(()),
            client: client()?,
        })
    }

    pub fn install_id(&self) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|state| state.install_id.clone()))
    }

    pub fn update_engine(&self, engine: Engine) -> Result<()> {
        let mut context = self.context.lock().map_err(|_| TelemetryError::Poisoned)?;
        context.engine = engine;
        Ok(())
    }

    /// The exact process environment the desktop gives to Bun before runtime imports.
    pub fn runtime_env(&self) -> std::collections::BTreeMap<String, String> {
        let mut env = std::collections::BTreeMap::new();
        let Some(id) = self.install_id() else {
            env.insert("COPILOTKIT_TELEMETRY_DISABLED".into(), "1".into());
            return env;
        };
        let Ok(context) = self.context.lock() else {
            return env;
        };
        env.insert("CPK_TELEMETRY_ID".into(), id);
        env.insert("COPILOTKIT_TELEMETRY_SAMPLE_RATE".into(), "1".into());
        env.insert(
            "OPENBOT_DISTRIBUTION".into(),
            context.distribution.as_str().into(),
        );
        env.insert("OPENBOT_VERSION".into(), context.app_version.to_string());
        env.insert("OPENBOT_PLATFORM".into(), context.platform.as_str().into());
        env.insert("OPENBOT_ARCH".into(), context.arch.as_str().into());
        env.insert("OPENBOT_ENGINE".into(), context.engine.as_str().into());
        if let Some(version) = &context.os_version {
            env.insert("OPENBOT_OS_VERSION".into(), version.to_string());
        }
        env
    }

    pub fn record(&self, data: EventData) -> Result<()> {
        let context = self
            .context
            .lock()
            .map_err(|_| TelemetryError::Poisoned)?
            .clone();
        let mut guard = self.state.lock().map_err(|_| TelemetryError::Poisoned)?;
        let Some(state) = guard.as_mut() else {
            return Ok(());
        };

        match &data {
            EventData::StepViewed { step } => {
                let mut last_step = self
                    .session_last_step_viewed
                    .lock()
                    .map_err(|_| TelemetryError::Poisoned)?;
                if *last_step == Some(*step) {
                    return Ok(());
                }
                *last_step = Some(*step);
                state.last_step = Some(*step);
            }
            EventData::Activated => {
                if state.activated {
                    return Ok(());
                }
                state.activated = true;
                state.last_step = None;
                *self
                    .session_last_step_viewed
                    .lock()
                    .map_err(|_| TelemetryError::Poisoned)? = None;
            }
            EventData::SetupAbandoned { .. } => {
                if state.activated {
                    return Ok(());
                }
                state.last_step = None;
                *self
                    .session_last_step_viewed
                    .lock()
                    .map_err(|_| TelemetryError::Poisoned)? = None;
            }
            _ => {
                *self
                    .session_last_step_viewed
                    .lock()
                    .map_err(|_| TelemetryError::Poisoned)? = None;
            }
        }

        state.push_bounded(
            Event::new(data, context),
            normalized_max_queue(self.config.max_queue),
        );
        write_state(&self.state_path, state)
    }

    pub fn flush(&self) -> Result<()> {
        self.flush_with_lock_wait(Duration::ZERO)
    }

    fn flush_with_lock_wait(&self, lock_wait: Duration) -> Result<()> {
        let started = Instant::now();
        let flush_guard = loop {
            match self.flush_lock.try_lock() {
                Ok(guard) => break guard,
                Err(_) if started.elapsed() < lock_wait => sleep(Duration::from_millis(10)),
                Err(_) => return Ok(()),
            }
        };
        let _flush_guard = flush_guard;
        let endpoint = match self.config.endpoint.as_ref() {
            Some(endpoint) if !endpoint.trim().is_empty() => endpoint,
            _ => return Ok(()),
        };

        loop {
            if started.elapsed() >= FLUSH_BUDGET {
                return Ok(());
            }
            let (install_id, event) = {
                let guard = self.state.lock().map_err(|_| TelemetryError::Poisoned)?;
                let Some(state) = guard.as_ref() else {
                    return Ok(());
                };
                let Some(event) = state.queue.first().cloned() else {
                    return Ok(());
                };
                (state.install_id.clone(), event)
            };

            let response = self
                .client
                .post(endpoint)
                .header("X-CopilotKit-Telemetry-Id", &install_id)
                .json(&event.to_sink_payload())
                .send();
            match response {
                Ok(response) if response.status().is_success() => {
                    let mut guard = self.state.lock().map_err(|_| TelemetryError::Poisoned)?;
                    if let Some(state) = guard.as_mut() {
                        if let Some(index) = state
                            .queue
                            .iter()
                            .position(|queued| queued.event_id == event.event_id)
                        {
                            state.queue.remove(index);
                            write_state(&self.state_path, state)?;
                        }
                    }
                }
                Ok(_) => return Ok(()),
                Err(error) => return Err(TelemetryError::Http(error)),
            }
        }
    }

    pub fn shutdown(&self) -> Result<()> {
        let step = {
            let guard = self.state.lock().map_err(|_| TelemetryError::Poisoned)?;
            guard
                .as_ref()
                .and_then(|state| (!state.activated).then_some(state.last_step).flatten())
        };
        if let Some(step) = step {
            self.record(EventData::SetupAbandoned { step })?;
        }
        self.flush_with_lock_wait(FLUSH_BUDGET)
    }

    pub fn snapshot(&self) -> Result<PersistedState> {
        self.state
            .lock()
            .map_err(|_| TelemetryError::Poisoned)?
            .clone()
            .ok_or(TelemetryError::MissingEndpoint)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SinkPayload {
    pub event: String,
    pub event_id: String,
    pub properties: serde_json::Value,
    pub global_properties: serde_json::Value,
    pub package: SinkPackage,
    pub ts: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SinkPackage {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Context {
    #[serde(rename = "openbot_distribution")]
    pub distribution: Distribution,
    #[serde(rename = "openbot_version")]
    pub app_version: NumericVersion,
    #[serde(rename = "openbot_platform")]
    pub platform: Platform,
    #[serde(rename = "openbot_arch")]
    pub arch: Architecture,
    #[serde(rename = "openbot_os_version", skip_serializing_if = "Option::is_none")]
    pub os_version: Option<NumericVersion>,
    #[serde(rename = "openbot_engine")]
    pub engine: Engine,
    pub runtime_env: RuntimeEnv,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumericVersion {
    pub parts: Vec<u32>,
}

impl NumericVersion {
    pub fn new(parts: Vec<u32>) -> Result<Self> {
        if (2..=4).contains(&parts.len()) {
            Ok(Self { parts })
        } else {
            Err(TelemetryError::InvalidState(
                "numeric version must have 2 to 4 dot-separated numeric parts".to_string(),
            ))
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        if value.len() > 32 {
            return Err(TelemetryError::InvalidState(
                "numeric version is too long".to_string(),
            ));
        }
        let parts = value
            .split('.')
            .map(|part| {
                if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err(TelemetryError::InvalidState(format!(
                        "numeric version contains a non-numeric part: {value}"
                    )));
                }
                part.parse::<u32>().map_err(|_| {
                    TelemetryError::InvalidState(format!(
                        "numeric version part is too large: {value}"
                    ))
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Self::new(parts)
    }
}

impl std::fmt::Display for NumericVersion {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (index, part) in self.parts.iter().enumerate() {
            if index > 0 {
                formatter.write_str(".")?;
            }
            write!(formatter, "{part}")?;
        }
        Ok(())
    }
}

impl Serialize for NumericVersion {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for NumericVersion {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

impl Context {
    fn to_global_properties(&self) -> serde_json::Value {
        let mut properties = serde_json::json!({
            "openbot_distribution": self.distribution,
            "openbot_version": &self.app_version,
            "openbot_platform": self.platform,
            "openbot_arch": self.arch,
            "openbot_engine": self.engine,
            "runtime_env": self.runtime_env,
            "sampleRate": 1,
            "sampleWeight": 1,
            "sampleRateAdjustmentFactor": 0
        });
        if let Some(os_version) = &self.os_version {
            properties["openbot_os_version"] =
                serde_json::to_value(os_version).unwrap_or(serde_json::Value::Null);
        }
        properties
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PersistedState {
    pub schema_version: u8,
    pub install_id: String,
    pub activated: bool,
    pub last_step: Option<Step>,
    pub queue: Vec<Event>,
}

impl PersistedState {
    fn new(install_id: String) -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            install_id,
            activated: false,
            last_step: None,
            queue: Vec::new(),
        }
    }

    fn push_bounded(&mut self, event: Event, max_queue: usize) {
        self.queue.push(event);
        while self.queue.len() > max_queue {
            self.queue.remove(0);
        }
    }

    fn validate(&self) -> Result<()> {
        if self.schema_version != STATE_SCHEMA_VERSION {
            return Err(TelemetryError::InvalidState(format!(
                "unsupported telemetry state schema {}",
                self.schema_version
            )));
        }
        if !is_uuid(&self.install_id) {
            return Err(TelemetryError::InvalidState(
                "install_id is not a UUID".to_string(),
            ));
        }
        for event in &self.queue {
            event.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub event_id: String,
    pub occurred_at_ms: u64,
    pub event_name: String,
    pub context: Context,
    pub data: EventData,
}

impl Event {
    pub fn new(data: EventData, context: Context) -> Self {
        let event_name = data.event_name().to_string();
        Self {
            event_id: new_uuid(),
            occurred_at_ms: now_ms(),
            event_name,
            context,
            data,
        }
    }

    pub fn event_name(&self) -> &str {
        &self.event_name
    }

    fn validate(&self) -> Result<()> {
        if !is_uuid(&self.event_id) {
            return Err(TelemetryError::InvalidState(
                "event_id is not a UUID".to_string(),
            ));
        }
        if self.event_name != self.data.event_name() {
            return Err(TelemetryError::InvalidState(format!(
                "event_name {} does not match {:?}",
                self.event_name, self.data
            )));
        }
        Ok(())
    }

    fn to_sink_payload(&self) -> SinkPayload {
        SinkPayload {
            event: self.event_name.clone(),
            event_id: self.event_id.clone(),
            properties: serde_json::to_value(&self.data).unwrap_or_else(|_| serde_json::json!({})),
            global_properties: self.context.to_global_properties(),
            package: SinkPackage {
                name: "openbot-desktop".to_string(),
                version: self.context.app_version.to_string(),
            },
            ts: self.occurred_at_ms / 1000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum EventData {
    StepViewed {
        step: Step,
    },
    HarnessChosen {
        harness: Harness,
    },
    ModelChosen {
        provider: Provider,
        credential_path: CredentialPath,
        custom_base_url: bool,
    },
    EngineDetected {
        engine: Engine,
        responding: bool,
    },
    EngineInstalled {
        engine: Engine,
        outcome: EngineInstallOutcome,
    },
    WindowsStage {
        outcome: WindowsStageOutcome,
    },
    ImagePull {
        outcome: Outcome,
        duration_ms: u64,
        bytes: Option<u64>,
    },
    SetupFailed {
        step: Step,
        error_class: SetupErrorClass,
    },
    Activated,
    SetupAbandoned {
        step: Step,
    },
}

impl EventData {
    pub fn event_name(&self) -> &'static str {
        match self {
            Self::StepViewed { .. } => "oss.desktop.step_viewed",
            Self::HarnessChosen { .. } => "oss.desktop.harness_chosen",
            Self::ModelChosen { .. } => "oss.desktop.model_chosen",
            Self::EngineDetected { .. } => "oss.desktop.engine_detected",
            Self::EngineInstalled { .. } => "oss.desktop.engine_installed",
            Self::WindowsStage { .. } => "oss.desktop.windows_stage",
            Self::ImagePull { .. } => "oss.desktop.image_pull",
            Self::SetupFailed { .. } => "oss.desktop.setup_failed",
            Self::Activated => "oss.desktop.activated",
            Self::SetupAbandoned { .. } => "oss.desktop.setup_abandoned",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Distribution {
    Desktop,
}

impl Distribution {
    fn as_str(self) -> &'static str {
        "desktop"
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEnv {
    Development,
    Production,
    Test,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Windows,
    Macos,
    Linux,
    Other,
}

impl Platform {
    fn as_str(self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::Macos => "macos",
            Self::Linux => "linux",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Architecture {
    X86_64,
    Aarch64,
    Other,
}

impl Architecture {
    fn as_str(self) -> &'static str {
        match self {
            Self::X86_64 => "x86_64",
            Self::Aarch64 => "aarch64",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    Welcome,
    Harness,
    Model,
    Install,
    Ask,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Harness {
    Crewai,
    Llamaindex,
    Agno,
    Langgraph,
    GoogleAdk,
    PydanticAi,
    MicrosoftAgentFramework,
    ClaudeAgentSdk,
    Strands,
    Ag2,
    Langroid,
    Mastra,
    ByoUrl,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Openai,
    Anthropic,
    Compatible,
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CredentialPath {
    Subscription,
    ApiKey,
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Engine {
    Docker,
    Podman,
    None,
}

impl Engine {
    fn as_str(self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Podman => "podman",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EngineInstallOutcome {
    Success,
    Failure,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WindowsStageOutcome {
    Ready,
    WslAbsent,
    WslOne,
    WslNoKernel,
    VirtualMachinePlatformDisabled,
    VirtualizationDisabled,
    NotAdministrator,
    CheckFailed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Success,
    Failure,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SetupErrorClass {
    EngineUnavailable,
    EngineInstallFailed,
    ImagePullFailed,
    InvalidConfiguration,
    NetworkUnavailable,
    PermissionDenied,
    Unknown,
}

pub fn schema_json() -> serde_json::Value {
    serde_json::json!({
        "schema_version": STATE_SCHEMA_VERSION,
        "event_name_prefix": "oss.desktop.",
        "numeric_version_pattern": r"^\d+(?:\.\d+){1,3}$",
        "context": {
            "openbot_distribution": ["desktop"],
            "openbot_version": { "pattern": r"^\d+(?:\.\d+){1,3}$" },
            "openbot_platform": ["windows", "macos", "linux", "other"],
            "openbot_arch": ["x86_64", "aarch64", "other"],
            "openbot_os_version": { "optional": true, "pattern": r"^\d+(?:\.\d+){1,3}$" },
            "openbot_engine": ["docker", "podman", "none"],
            "runtime_env": ["development", "production", "test"]
        },
        "events": {
            "step_viewed": { "step": ["welcome", "harness", "model", "install", "ask"] },
            "harness_chosen": { "harness": ["crewai", "llamaindex", "agno", "langgraph", "google_adk", "pydantic_ai", "microsoft_agent_framework", "claude_agent_sdk", "strands", "ag2", "langroid", "mastra", "byo_url"] },
            "model_chosen": { "provider": ["openai", "anthropic", "compatible", "none"], "credential_path": ["subscription", "api_key", "none"], "custom_base_url": "bool" },
            "engine_detected": { "engine": ["docker", "podman", "none"], "responding": "bool" },
            "engine_installed": { "engine": ["docker", "podman", "none"], "outcome": ["success", "failure"] },
            "windows_stage": { "outcome": ["ready", "wsl_absent", "wsl_one", "wsl_no_kernel", "virtual_machine_platform_disabled", "virtualization_disabled", "not_administrator", "check_failed"] },
            "image_pull": { "outcome": ["success", "failure"], "duration_ms": "u64", "bytes": "option_u64" },
            "setup_failed": { "step": ["welcome", "harness", "model", "install", "ask"], "error_class": ["engine_unavailable", "engine_install_failed", "image_pull_failed", "invalid_configuration", "network_unavailable", "permission_denied", "unknown"] },
            "activated": {},
            "setup_abandoned": { "step": ["welcome", "harness", "model", "install", "ask"] }
        }
    })
}

pub fn state_path(data_dir: impl AsRef<Path>) -> PathBuf {
    data_dir.as_ref().join(STATE_FILE)
}

fn client() -> Result<Client> {
    Ok(Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(REQUEST_TIMEOUT)
        .redirect(Policy::none())
        .build()?)
}

fn write_state(path: &Path, state: &PersistedState) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    crate::env::write_private_file(path, &serde_json::to_vec(state)?)?;
    Ok(())
}

fn normalized_max_queue(configured: usize) -> usize {
    configured.clamp(1, 256)
}

fn telemetry_disabled(env_override: EnvOverride) -> bool {
    match env_override {
        EnvOverride::Enabled => false,
        EnvOverride::Disabled => true,
        EnvOverride::Process => {
            disabled_value("COPILOTKIT_TELEMETRY_DISABLED") || disabled_value("DO_NOT_TRACK")
        }
    }
}

fn disabled_value(name: &str) -> bool {
    env::var(name)
        .ok()
        .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true"))
        .unwrap_or(false)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn new_uuid() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::{mpsc, Barrier};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("openbot-telemetry-{name}-{unique}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn context(version: &str, engine: Engine) -> Context {
        Context {
            distribution: Distribution::Desktop,
            app_version: NumericVersion::parse(version).unwrap(),
            platform: Platform::Macos,
            arch: Architecture::Aarch64,
            os_version: Some(NumericVersion::parse("14.5.0").unwrap()),
            engine,
            runtime_env: RuntimeEnv::Test,
        }
    }

    fn enabled(endpoint: String) -> Config {
        Config {
            enabled: true,
            endpoint: Some(endpoint),
            max_queue: 256,
        }
    }

    #[test]
    fn numeric_version_accepts_only_normalized_numeric_versions() {
        let version = NumericVersion::parse("1.2").unwrap();
        assert_eq!(version.to_string(), "1.2");
        assert_eq!(serde_json::to_value(&version).unwrap(), "1.2");
        let without_os = Context {
            os_version: None,
            ..context("1.2.3", Engine::None)
        };
        assert!(serde_json::to_value(&without_os)
            .unwrap()
            .get("openbot_os_version")
            .is_none());
        assert_eq!(
            NumericVersion::parse("1.2.3.4").unwrap().to_string(),
            "1.2.3.4"
        );
        assert!(NumericVersion::parse("1").is_err());
        assert!(NumericVersion::parse("1.2.3.4.5").is_err());
        assert!(NumericVersion::parse("1.2-beta").is_err());
        assert!(NumericVersion::parse("123456789012345678901234567890123").is_err());
    }

    #[test]
    fn event_schema_is_tagged_closed_and_exposes_centralized_name() {
        let event = Event::new(
            EventData::ModelChosen {
                provider: Provider::Compatible,
                credential_path: CredentialPath::ApiKey,
                custom_base_url: true,
            },
            context("1.2.3", Engine::None),
        );

        assert_eq!(event.event_name(), "oss.desktop.model_chosen");
        let json = serde_json::to_value(&event.data).unwrap();
        assert_eq!(json["kind"], "model_chosen");
        assert_eq!(json["provider"], "compatible");
        assert_eq!(
            serde_json::to_value(EventData::HarnessChosen {
                harness: Harness::MicrosoftAgentFramework
            })
            .unwrap()["harness"],
            "microsoft_agent_framework"
        );
        assert!(serde_json::from_value::<EventData>(serde_json::json!({
            "kind": "model_chosen",
            "provider": "compatible",
            "credential_path": "api_key",
            "custom_base_url": true,
            "extra": "rejected"
        }))
        .is_err());
        assert!(serde_json::from_value::<EventData>(serde_json::json!({
            "kind": "setup_failed",
            "step": "welcome",
            "error_class": "raw user-facing error"
        }))
        .is_err());
    }

    #[test]
    fn schema_lists_every_closed_event_kind_and_no_freeform_string_fields() {
        let schema = schema_json();
        let events = schema["events"].as_object().unwrap();
        for sample in sample_events() {
            let value = serde_json::to_value(&sample).unwrap();
            let kind = value["kind"].as_str().unwrap();
            assert!(events.contains_key(kind), "schema missing {kind}");
            assert_string_values_are_listed(&value, &events[kind]);
        }
        assert_eq!(schema["numeric_version_pattern"], r"^\d+(?:\.\d+){1,3}$");
    }

    fn sample_events() -> Vec<EventData> {
        vec![
            EventData::StepViewed {
                step: Step::Welcome,
            },
            EventData::HarnessChosen {
                harness: Harness::ByoUrl,
            },
            EventData::ModelChosen {
                provider: Provider::Openai,
                credential_path: CredentialPath::Subscription,
                custom_base_url: false,
            },
            EventData::EngineDetected {
                engine: Engine::Docker,
                responding: true,
            },
            EventData::EngineInstalled {
                engine: Engine::Podman,
                outcome: EngineInstallOutcome::Failure,
            },
            EventData::WindowsStage {
                outcome: WindowsStageOutcome::WslNoKernel,
            },
            EventData::ImagePull {
                outcome: Outcome::Success,
                duration_ms: 12,
                bytes: Some(34),
            },
            EventData::SetupFailed {
                step: Step::Install,
                error_class: SetupErrorClass::ImagePullFailed,
            },
            EventData::Activated,
            EventData::SetupAbandoned { step: Step::Ask },
        ]
    }

    fn assert_string_values_are_listed(value: &serde_json::Value, schema: &serde_json::Value) {
        if let Some(object) = value.as_object() {
            for (key, child) in object {
                if key == "kind" {
                    continue;
                }
                if let Some(string) = child.as_str() {
                    let allowed = schema[key]
                        .as_array()
                        .expect("string fields must be enum arrays");
                    assert!(
                        allowed.iter().any(|candidate| candidate == string),
                        "{key}={string} not in schema"
                    );
                } else if child.is_object() {
                    assert_string_values_are_listed(child, &schema[key]);
                }
            }
        }
    }

    #[test]
    fn disabled_mode_drops_pending_state_without_reading_or_replaying() {
        let dir = temp_dir("disabled");
        let state = PersistedState {
            schema_version: STATE_SCHEMA_VERSION,
            install_id: "11111111-1111-4111-8111-111111111111".to_string(),
            activated: false,
            last_step: None,
            queue: vec![Event::new(
                EventData::Activated,
                context("1.2.3", Engine::None),
            )],
        };
        fs::write(state_path(&dir), serde_json::to_vec_pretty(&state).unwrap()).unwrap();

        let telemetry = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            enabled("http://127.0.0.1:9/ingest".to_string()),
            EnvOverride::Disabled,
        )
        .unwrap();
        telemetry.record(EventData::Activated).unwrap();
        telemetry.flush().unwrap();

        assert!(telemetry.install_id().is_none());
        assert!(telemetry.install_id().is_none());
        assert!(!state_path(&dir).exists());
    }

    #[test]
    fn adjacent_duplicate_step_viewed_is_suppressed_only_within_current_session() {
        let dir = temp_dir("step-dedupe");
        let first = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            Config::disabled_for_tests(),
            EnvOverride::Enabled,
        )
        .unwrap();
        first
            .record(EventData::StepViewed {
                step: Step::Welcome,
            })
            .unwrap();
        first
            .record(EventData::StepViewed {
                step: Step::Welcome,
            })
            .unwrap();
        assert_eq!(
            first
                .snapshot()
                .unwrap()
                .queue
                .iter()
                .filter(|event| matches!(
                    event.data,
                    EventData::StepViewed {
                        step: Step::Welcome
                    }
                ))
                .count(),
            1
        );
        first
            .record(EventData::HarnessChosen {
                harness: Harness::ByoUrl,
            })
            .unwrap();
        first
            .record(EventData::StepViewed {
                step: Step::Welcome,
            })
            .unwrap();
        assert_eq!(
            first
                .snapshot()
                .unwrap()
                .queue
                .iter()
                .filter(|event| matches!(
                    event.data,
                    EventData::StepViewed {
                        step: Step::Welcome
                    }
                ))
                .count(),
            2
        );
        drop(first);

        let second = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            Config::disabled_for_tests(),
            EnvOverride::Enabled,
        )
        .unwrap();
        second
            .record(EventData::StepViewed {
                step: Step::Welcome,
            })
            .unwrap();
        let state = second.snapshot().unwrap();
        assert_eq!(
            state
                .queue
                .iter()
                .filter(|event| matches!(
                    event.data,
                    EventData::StepViewed {
                        step: Step::Welcome
                    }
                ))
                .count(),
            3
        );
        assert_eq!(
            state
                .queue
                .iter()
                .filter(|event| matches!(
                    event.data,
                    EventData::SetupAbandoned {
                        step: Step::Welcome
                    }
                ))
                .count(),
            1
        );
    }

    #[test]
    fn record_persists_before_send_and_flush_preserves_until_success() {
        let dir = temp_dir("queue");
        let telemetry = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            enabled("http://127.0.0.1:9/ingest".to_string()),
            EnvOverride::Enabled,
        )
        .unwrap();

        telemetry
            .record(EventData::StepViewed {
                step: Step::Harness,
            })
            .unwrap();
        assert!(fs::read_to_string(state_path(&dir))
            .unwrap()
            .contains("step_viewed"));
        assert!(telemetry.flush().is_err());
        assert_eq!(
            serde_json::from_str::<PersistedState>(&fs::read_to_string(state_path(&dir)).unwrap())
                .unwrap()
                .queue
                .len(),
            1
        );

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/ingest", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let first = one_response(listener.try_clone().unwrap());
            let second = one_response(listener);
            format!("{first}\n{second}")
        });
        let replay = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            enabled(endpoint),
            EnvOverride::Enabled,
        )
        .unwrap();
        replay.flush().unwrap();
        let request = server.join().unwrap();
        assert!(request.contains("oss.desktop.step_viewed"));
        assert!(request
            .to_ascii_lowercase()
            .contains("x-copilotkit-telemetry-id"));
        assert!(request.contains("oss.desktop.setup_abandoned"));
        assert!(request.contains("openbot_distribution"));
        assert_eq!(
            serde_json::from_str::<PersistedState>(&fs::read_to_string(state_path(&dir)).unwrap())
                .unwrap()
                .queue
                .len(),
            0
        );
    }

    #[test]
    fn concurrent_flush_does_not_drop_unsent_second_event() {
        let dir = temp_dir("concurrent");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/ingest", listener.local_addr().unwrap());
        let telemetry = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            enabled(endpoint),
            EnvOverride::Enabled,
        )
        .unwrap();
        telemetry
            .record(EventData::StepViewed {
                step: Step::Welcome,
            })
            .unwrap();
        telemetry
            .record(EventData::StepViewed {
                step: Step::Harness,
            })
            .unwrap();

        let server = thread::spawn(move || one_response(listener));
        let barrier = Arc::new(Barrier::new(2));
        let a = Arc::clone(&telemetry);
        let barrier_a = Arc::clone(&barrier);
        let first = thread::spawn(move || {
            barrier_a.wait();
            let _ = a.flush();
        });
        let b = Arc::clone(&telemetry);
        let second = thread::spawn(move || {
            barrier.wait();
            let _ = b.flush();
        });
        first.join().unwrap();
        second.join().unwrap();
        let _ = server.join().unwrap();

        let state = telemetry.snapshot().unwrap();
        assert_eq!(state.queue.len(), 1);
        assert!(matches!(
            state.queue[0].data,
            EventData::StepViewed {
                step: Step::Harness
            }
        ));
    }

    fn one_response(listener: TcpListener) -> String {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0u8; 8192];
        let read = stream.read(&mut buffer).unwrap();
        stream.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}").unwrap();
        String::from_utf8_lossy(&buffer[..read]).into_owned()
    }

    #[test]
    fn shutdown_waits_for_active_flush_and_returns_only_after_abandonment_flushes() {
        let dir = temp_dir("shutdown-active-flush");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/ingest", listener.local_addr().unwrap());
        let telemetry = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            enabled(endpoint),
            EnvOverride::Enabled,
        )
        .unwrap();
        telemetry
            .record(EventData::StepViewed {
                step: Step::Welcome,
            })
            .unwrap();

        let (first_read_tx, first_read_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut first_stream, _) = listener.accept().unwrap();
            let mut first_buffer = [0u8; 8192];
            let first_read = first_stream.read(&mut first_buffer).unwrap();
            first_read_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            first_stream.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}").unwrap();

            let (mut second_stream, _) = listener.accept().unwrap();
            let mut second_buffer = [0u8; 8192];
            let second_read = second_stream.read(&mut second_buffer).unwrap();
            second_stream.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}").unwrap();
            format!(
                "{}\n{}",
                String::from_utf8_lossy(&first_buffer[..first_read]),
                String::from_utf8_lossy(&second_buffer[..second_read])
            )
        });

        let flushing = Arc::clone(&telemetry);
        let flush_thread = thread::spawn(move || flushing.flush().unwrap());
        first_read_rx.recv().unwrap();

        let shutting_down = Arc::clone(&telemetry);
        let shutdown_thread = thread::spawn(move || shutting_down.shutdown().unwrap());
        sleep(Duration::from_millis(50));
        assert!(
            !shutdown_thread.is_finished(),
            "shutdown returned while active flush was still blocked"
        );
        release_tx.send(()).unwrap();
        shutdown_thread.join().unwrap();
        assert_eq!(telemetry.snapshot().unwrap().queue.len(), 0);
        flush_thread.join().unwrap();
        let requests = server.join().unwrap();

        assert!(requests.contains("oss.desktop.step_viewed"));
        assert!(requests.contains("oss.desktop.setup_abandoned"));
    }

    #[test]
    fn pending_events_keep_record_time_context() {
        let dir = temp_dir("context");
        let telemetry = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            Config::disabled_for_tests(),
            EnvOverride::Enabled,
        )
        .unwrap();
        telemetry
            .record(EventData::EngineDetected {
                engine: Engine::None,
                responding: false,
            })
            .unwrap();
        telemetry.update_engine(Engine::Docker).unwrap();
        let state = telemetry.snapshot().unwrap();
        assert_eq!(state.queue[0].context.engine, Engine::None);
    }

    #[test]
    fn activation_and_shutdown_abandonment_are_deduped_from_persisted_state() {
        let dir = temp_dir("activation");
        let telemetry = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            Config::disabled_for_tests(),
            EnvOverride::Enabled,
        )
        .unwrap();
        telemetry
            .record(EventData::StepViewed { step: Step::Ask })
            .unwrap();
        telemetry.record(EventData::Activated).unwrap();
        telemetry.record(EventData::Activated).unwrap();
        telemetry.shutdown().unwrap();
        let state = telemetry.snapshot().unwrap();
        assert_eq!(
            state
                .queue
                .iter()
                .filter(|event| matches!(event.data, EventData::Activated))
                .count(),
            1
        );
        assert!(!state
            .queue
            .iter()
            .any(|event| matches!(event.data, EventData::SetupAbandoned { .. })));
    }

    #[test]
    fn quit_abandonment_is_not_duplicated_on_next_launch() {
        let dir = temp_dir("quit-reopen");
        let first = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            Config::disabled_for_tests(),
            EnvOverride::Enabled,
        )
        .unwrap();
        first
            .record(EventData::StepViewed { step: Step::Ask })
            .unwrap();
        first.shutdown().unwrap();
        drop(first);

        let second = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            Config::disabled_for_tests(),
            EnvOverride::Enabled,
        )
        .unwrap();
        let state = second.snapshot().unwrap();
        assert_eq!(
            state
                .queue
                .iter()
                .filter(|event| matches!(event.data, EventData::SetupAbandoned { step: Step::Ask }))
                .count(),
            1
        );
    }

    #[test]
    fn next_launch_records_abandoned_step_after_crash_before_activation() {
        let dir = temp_dir("abandoned");
        let first = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            Config::disabled_for_tests(),
            EnvOverride::Enabled,
        )
        .unwrap();
        first
            .record(EventData::StepViewed {
                step: Step::Install,
            })
            .unwrap();
        drop(first);

        let second = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            Config::disabled_for_tests(),
            EnvOverride::Enabled,
        )
        .unwrap();
        let state = second.snapshot().unwrap();
        assert!(state.queue.iter().any(|event| matches!(
            event.data,
            EventData::SetupAbandoned {
                step: Step::Install
            }
        )));
    }

    #[test]
    fn state_deserialize_refuses_unknown_fields_and_untyped_events() {
        let dir = temp_dir("schema");
        let raw = serde_json::json!({
            "schema_version": 1,
            "install_id": "11111111-1111-4111-8111-111111111111",
            "activated": false,
            "last_step": null,
            "queue": [{
                "event_id": "22222222-2222-4222-8222-222222222222",
                "occurred_at_ms": 1,
                "event_name": "oss.desktop.activated",
                "context": context("1.2.3", Engine::None),
                "data": { "kind": "activated" },
                "unknown": true
            }]
        });
        fs::write(state_path(&dir), serde_json::to_vec_pretty(&raw).unwrap()).unwrap();
        assert!(Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            Config::disabled_for_tests(),
            EnvOverride::Enabled
        )
        .is_err());
    }

    #[test]
    fn queue_is_bounded_to_maximum() {
        let dir = temp_dir("bounded");
        let telemetry = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            Config {
                enabled: true,
                endpoint: None,
                max_queue: 2,
            },
            EnvOverride::Enabled,
        )
        .unwrap();
        telemetry
            .record(EventData::StepViewed {
                step: Step::Welcome,
            })
            .unwrap();
        telemetry
            .record(EventData::StepViewed {
                step: Step::Harness,
            })
            .unwrap();
        telemetry
            .record(EventData::StepViewed { step: Step::Model })
            .unwrap();
        let state = telemetry.snapshot().unwrap();
        assert_eq!(state.queue.len(), 2);
        assert!(matches!(
            state.queue[0].data,
            EventData::StepViewed {
                step: Step::Harness
            }
        ));
    }
}
