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

/// Opaque fingerprint of the account verified by Ops, never an email or credential.
pub fn is_account_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

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

    /// The account binding is saved before requesting a permanent PostHog alias.
    pub fn bound_account(&self) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.as_ref().and_then(|state| state.account_id.clone()))
    }

    /// Keep the anonymous trail on first sign-in; rotate before a different account is linked.
    /// Queued events retain their original installation, including queues from older versions.
    pub fn bind_account(&self, account: &str) -> Result<()> {
        if !is_account_id(account) {
            return Err(TelemetryError::InvalidState(
                "invalid account binding".into(),
            ));
        }
        self.change_account(Some(account))
    }

    /// Rotate a previously linked installation on sign-out, retaining queued attribution.
    pub fn clear_account(&self) -> Result<()> {
        self.change_account(None)
    }

    /// Settings' Share usage data, turned off: the same as launching with the opt-out. The
    /// identity, its account binding and every queued event are deleted, and nothing more is
    /// recorded or sent.
    pub fn stop_sharing(&self) -> Result<()> {
        let mut guard = self.state.lock().map_err(|_| TelemetryError::Poisoned)?;
        *guard = None;
        match fs::remove_file(&self.state_path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Settings' Share usage data, turned back on: a fresh identity, with nothing from before the
    /// opt-out. Setup is long finished by the time Settings can be reached, so activation is not
    /// recorded a second time.
    pub fn resume_sharing(&self) -> Result<()> {
        if !self.config.enabled || telemetry_disabled(EnvOverride::Process) {
            return Ok(());
        }
        let mut guard = self.state.lock().map_err(|_| TelemetryError::Poisoned)?;
        if guard.is_some() {
            return Ok(());
        }
        if let Some(parent) = self.state_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut state = PersistedState::new(new_uuid());
        state.activated = true;
        write_state(&self.state_path, &state)?;
        *guard = Some(state);
        Ok(())
    }

    fn change_account(&self, account: Option<&str>) -> Result<()> {
        let mut guard = self.state.lock().map_err(|_| TelemetryError::Poisoned)?;
        let Some(current) = guard.as_ref() else {
            return Ok(());
        };
        if current.account_id.as_deref() == account {
            return Ok(());
        }
        let mut next = current.clone();
        if current.account_id.is_some() {
            for event in &mut next.queue {
                if event.installation_id.is_none() {
                    event.installation_id = Some(current.install_id.clone());
                }
            }
            next.install_id = new_uuid();
        }
        next.account_id = account.map(str::to_owned);
        write_state(&self.state_path, &next)?;
        *guard = Some(next);
        Ok(())
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
                (
                    event
                        .installation_id
                        .clone()
                        .unwrap_or_else(|| state.install_id.clone()),
                    event,
                )
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
    pub app_version: AppVersion,
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

/**
The app's own version as released: a numeric version, and for a release candidate or other
pre-release its label, as in `1.0.0-rc.5`. Cut at the first `-`, every 1.0 release candidate said
`1.0.0`.

The label is a closed word (`alpha`, `beta`, `rc`, `dev`, `pre`, `preview`, `canary`) with at most
one number after a dot. Anything else after the `-` is not sent: only the numeric part is, as before.
*/
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppVersion {
    pub numeric: NumericVersion,
    pub prerelease: Option<(PrereleaseLabel, Option<u32>)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrereleaseLabel {
    Alpha,
    Beta,
    Rc,
    Dev,
    Pre,
    Preview,
    Canary,
}

impl PrereleaseLabel {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "alpha" => Self::Alpha,
            "beta" => Self::Beta,
            "rc" => Self::Rc,
            "dev" => Self::Dev,
            "pre" => Self::Pre,
            "preview" => Self::Preview,
            "canary" => Self::Canary,
            _ => return None,
        })
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Alpha => "alpha",
            Self::Beta => "beta",
            Self::Rc => "rc",
            Self::Dev => "dev",
            Self::Pre => "pre",
            Self::Preview => "preview",
            Self::Canary => "canary",
        }
    }
}

impl AppVersion {
    /// Exactly a numeric version with an optional closed pre-release label; anything else fails.
    pub fn parse(value: &str) -> Result<Self> {
        let (numeric, label) = match value.split_once('-') {
            Some((numeric, label)) => (numeric, Some(label)),
            None => (value, None),
        };
        let numeric = NumericVersion::parse(numeric)?;
        let prerelease = match label {
            None => None,
            Some(label) => {
                let (word, number) = match label.split_once('.') {
                    Some((word, number)) => (word, Some(number)),
                    None => (label, None),
                };
                let word = PrereleaseLabel::parse(word).ok_or_else(|| {
                    TelemetryError::InvalidState("unknown pre-release label".into())
                })?;
                let number = number
                    .map(|number| {
                        if number.is_empty()
                            || number.len() > 9
                            || !number.bytes().all(|byte| byte.is_ascii_digit())
                        {
                            return Err(TelemetryError::InvalidState(
                                "pre-release number is not numeric".into(),
                            ));
                        }
                        number.parse::<u32>().map_err(|_| {
                            TelemetryError::InvalidState("pre-release number is too large".into())
                        })
                    })
                    .transpose()?;
                Some((word, number))
            }
        };
        Ok(Self {
            numeric,
            prerelease,
        })
    }

    /// The version the app was built as, keeping a release candidate's label. A label outside the
    /// closed set keeps only the numeric part, as every version did before. None when even that
    /// is not a numeric version.
    pub fn from_package(value: &str) -> Option<Self> {
        Self::parse(value).ok().or_else(|| {
            NumericVersion::parse(value.split(['-', '+']).next()?)
                .ok()
                .map(|numeric| Self {
                    numeric,
                    prerelease: None,
                })
        })
    }
}

impl std::fmt::Display for AppVersion {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.numeric)?;
        if let Some((label, number)) = self.prerelease {
            write!(formatter, "-{}", label.as_str())?;
            if let Some(number) = number {
                write!(formatter, ".{number}")?;
            }
        }
        Ok(())
    }
}

impl Serialize for AppVersion {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for AppVersion {
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub activated: bool,
    pub last_step: Option<Step>,
    pub queue: Vec<Event>,
}

impl PersistedState {
    fn new(install_id: String) -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            install_id,
            account_id: None,
            activated: false,
            last_step: None,
            queue: Vec::new(),
        }
    }

    fn push_bounded(&mut self, mut event: Event, max_queue: usize) {
        event.installation_id = Some(self.install_id.clone());
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
        if self
            .account_id
            .as_deref()
            .is_some_and(|id| !is_account_id(id))
        {
            return Err(TelemetryError::InvalidState(
                "invalid account binding".into(),
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
    /// Local queue metadata only; never part of the event payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installation_id: Option<String>,
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
            installation_id: None,
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
        if self
            .installation_id
            .as_deref()
            .is_some_and(|id| !is_uuid(id))
        {
            return Err(TelemetryError::InvalidState(
                "invalid queued installation id".into(),
            ));
        }
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
    /// Setup or a Start stopped. `step` is the last screen the window showed; `failing_step` is
    /// the part of the work that failed, by the names the setup window's rows use. The CLI's own
    /// closed reason or failure category, and what an engine too small had against what it needs,
    /// when known. Never a sentence, a path or anything the CLI printed.
    SetupFailed {
        step: Step,
        error_class: SetupErrorClass,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        failing_step: Option<FailingStep>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cli_reason: Option<CliReason>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cli_failure: Option<CliFailure>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resources: Option<Resources>,
    },
    Activated,
    SetupAbandoned {
        step: Step,
    },
    /// The Account step's CopilotKit sign-in: started, and how it ended, with how long the person
    /// was in their browser. `restored` is an account check that found this computer already
    /// signed in, once a launch.
    SignIn {
        outcome: SignInOutcome,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cli_failure: Option<CliFailure>,
    },
    /// A setup, start or update step running far past the time it typically takes (`stall`):
    /// three times as long, and two minutes over at least. Said once per step. A step that then
    /// finishes says nothing more; one that fails is a `setup_failed`.
    SetupStalled {
        part: StallPart,
        step: StallStep,
        typical_seconds: u64,
        elapsed_seconds: u64,
    },
    /// The setup window stopped taking what the desktop sent it for over 30 seconds while it was
    /// on screen (`stall::UiWatch`): for how long, and the part of setup under way, by the setup
    /// rows' names. Said once, when the window answers again or at quit.
    UiStalled {
        step: FailingStep,
        stalled_seconds: u64,
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
            Self::SignIn { .. } => "oss.desktop.sign_in",
            Self::SetupStalled { .. } => "oss.desktop.setup_stalled",
            Self::UiStalled { .. } => "oss.desktop.ui_stalled",
        }
    }
}

/// Which journey a stalled step is part of: the back end's first setup (`local setup`), its update
/// (`local update`), OpenBot's own start, or OpenBot updating itself.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StallPart {
    Setup,
    Update,
    Start,
    Release,
}

impl StallPart {
    pub const ALL: [StallPart; 4] = [Self::Setup, Self::Update, Self::Start, Self::Release];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Setup => "setup",
            Self::Update => "update",
            Self::Start => "start",
            Self::Release => "release",
        }
    }
}

/// A timed step of a journey, by name: one of the closed set `stall::step_names` lists, from the
/// journeys' measured timings. Anything else is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StallStep(&'static str);

impl StallStep {
    pub fn named(name: &str) -> Option<Self> {
        crate::stall::step_names()
            .iter()
            .copied()
            .find(|known| *known == name)
            .map(Self)
    }

    pub fn as_str(self) -> &'static str {
        self.0
    }
}

impl Serialize for StallStep {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0)
    }
}

impl<'de> Deserialize<'de> for StallStep {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let name = String::deserialize(deserializer)?;
        Self::named(&name).ok_or_else(|| serde::de::Error::custom("unknown stall step"))
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
    Install,
    /// The CopilotKit sign-in and evaluation agreement of a local first run.
    Account,
    Model,
    Connect,
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
    Google,
    Xai,
    Compatible,
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CredentialPath {
    Subscription,
    ApiKey,
    Oauth,
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
    NestedVirtualizationUnavailable,
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
    /// The engine has fewer CPUs, or less memory or free disk, than local setup needs.
    InsufficientResources,
    /// An engine or platform local setup does not run on, such as OrbStack, or rootless Podman.
    UnsupportedEngine,
    Unknown,
}

/// The part of setup that failed, by the step names the setup window's rows use (`report`), and
/// the back end's own CLI calls.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailingStep {
    /// Start, before any of its steps.
    Start,
    Engine,
    InstallEngine,
    CreateMachine,
    StartMachine,
    HealthGate,
    Deployment,
    Release,
    Images,
    Installation,
    Env,
    Ports,
    Cleanup,
    Services,
    CarryOver,
    Answering,
    Stopped,
    Windows,
    Linux,
    Open,
    Quit,
    /// The Account step's check of the engine and the CLI's preflight, before the agreement.
    AccountCheck,
    LocalSetup,
    LocalStart,
    LocalUpdate,
    LocalConnect,
    LearningModel,
    /// A step name this build does not list.
    Other,
}

impl FailingStep {
    /// The step a setup row names, such as `install-engine`.
    pub fn from_row(step: &str) -> Self {
        match step {
            "start" => Self::Start,
            "engine" => Self::Engine,
            "install-engine" => Self::InstallEngine,
            "create-machine" => Self::CreateMachine,
            "start-machine" => Self::StartMachine,
            "health-gate" => Self::HealthGate,
            "deployment" => Self::Deployment,
            "release" => Self::Release,
            "images" => Self::Images,
            "installation" => Self::Installation,
            "env" => Self::Env,
            "ports" => Self::Ports,
            "cleanup" => Self::Cleanup,
            "services" => Self::Services,
            "carry-over" => Self::CarryOver,
            "answering" => Self::Answering,
            "stopped" => Self::Stopped,
            "windows" => Self::Windows,
            "linux" => Self::Linux,
            "open" => Self::Open,
            "quit" => Self::Quit,
            _ => Self::Other,
        }
    }
}

/// The CLI's own reason for stopping, from its closed set (`local_eval::Reason`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliReason {
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
    ConfirmationRequired,
    DashboardUnavailable,
    BrowserOpenFailed,
    ResourcesShort,
    Unrecognized,
}

/// Why a CLI call produced no report, from the desktop's closed set (`local_eval::Failure`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliFailure {
    Unavailable,
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
    ContractMismatch,
    UnexpectedExit,
    InvalidAcceptance,
    RootlessPodman,
    DownloadStalled,
}

/**
What the engine had against what local setup needs, for a setup that stopped on it. CPUs in
thousandths of a CPU, memory and disk in MiB. `*_short` says which resource is below; an
`available` that was not measured is absent. `disk_nearly_full` is the back end's own disk below
k3s's lines rather than below the 40 GiB setup needs.
*/
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Resources {
    pub cpu_short: bool,
    pub memory_short: bool,
    pub disk_short: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub disk_nearly_full: bool,
    pub cpu_needed_millis: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_available_millis: Option<u64>,
    pub memory_needed_mib: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_available_mib: Option<u64>,
    pub disk_needed_mib: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_available_mib: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SignInOutcome {
    Started,
    Completed,
    Failed,
    Cancelled,
    /// The account check found this computer already signed in.
    Restored,
}

/// Every `FailingStep`, as sent.
const FAILING_STEPS: &[&str] = &[
    "start",
    "engine",
    "install_engine",
    "create_machine",
    "start_machine",
    "health_gate",
    "deployment",
    "release",
    "images",
    "installation",
    "env",
    "ports",
    "cleanup",
    "services",
    "carry_over",
    "answering",
    "stopped",
    "windows",
    "linux",
    "open",
    "quit",
    "account_check",
    "local_setup",
    "local_start",
    "local_update",
    "local_connect",
    "learning_model",
    "other",
];

const CLI_REASONS: &[&str] = &[
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
    "dashboard_unavailable",
    "browser_open_failed",
    "resources_short",
    "unrecognized",
];

const CLI_FAILURES: &[&str] = &[
    "unavailable",
    "unverified",
    "invalid_stack",
    "spawn",
    "timeout",
    "cancelled",
    "output_limit",
    "invalid_json",
    "unsupported_version",
    "unexpected_command",
    "invalid_status",
    "missing_stack",
    "unsafe_endpoint",
    "contract_mismatch",
    "unexpected_exit",
    "invalid_acceptance",
    "rootless_podman",
    "download_stalled",
];

/// A numeric version, and for the app's own version a closed pre-release label (`AppVersion`).
pub const APP_VERSION_PATTERN: &str =
    r"^\d+(?:\.\d+){1,3}(?:-(?:alpha|beta|rc|dev|pre|preview|canary)(?:\.\d{1,9})?)?$";

pub fn schema_json() -> serde_json::Value {
    let steps = [
        "welcome", "harness", "install", "account", "model", "connect", "ask",
    ];
    serde_json::json!({
        "schema_version": STATE_SCHEMA_VERSION,
        "event_name_prefix": "oss.desktop.",
        "numeric_version_pattern": r"^\d+(?:\.\d+){1,3}$",
        "context": {
            "openbot_distribution": ["desktop"],
            "openbot_version": { "pattern": APP_VERSION_PATTERN },
            "openbot_platform": ["windows", "macos", "linux", "other"],
            "openbot_arch": ["x86_64", "aarch64", "other"],
            "openbot_os_version": { "optional": true, "pattern": r"^\d+(?:\.\d+){1,3}$" },
            "openbot_engine": ["docker", "podman", "none"],
            "runtime_env": ["development", "production", "test"]
        },
        "events": {
            "step_viewed": { "step": steps },
            "harness_chosen": { "harness": ["crewai", "llamaindex", "agno", "langgraph", "google_adk", "pydantic_ai", "microsoft_agent_framework", "claude_agent_sdk", "strands", "ag2", "langroid", "mastra", "byo_url"] },
            "model_chosen": { "provider": ["openai", "anthropic", "google", "xai", "compatible", "none"], "credential_path": ["subscription", "api_key", "oauth", "none"], "custom_base_url": "bool" },
            "engine_detected": { "engine": ["docker", "podman", "none"], "responding": "bool" },
            "engine_installed": { "engine": ["docker", "podman", "none"], "outcome": ["success", "failure"] },
            "windows_stage": { "outcome": ["ready", "wsl_absent", "wsl_one", "wsl_no_kernel", "virtual_machine_platform_disabled", "virtualization_disabled", "nested_virtualization_unavailable", "not_administrator", "check_failed"] },
            "image_pull": { "outcome": ["success", "failure"], "duration_ms": "u64", "bytes": "option_u64" },
            "setup_failed": {
                "step": steps,
                "error_class": ["engine_unavailable", "engine_install_failed", "image_pull_failed", "invalid_configuration", "network_unavailable", "permission_denied", "insufficient_resources", "unsupported_engine", "unknown"],
                "failing_step": FAILING_STEPS,
                "cli_reason": CLI_REASONS,
                "cli_failure": CLI_FAILURES,
                "resources": {
                    "cpu_short": "bool", "memory_short": "bool", "disk_short": "bool", "disk_nearly_full": "bool",
                    "cpu_needed_millis": "u64", "cpu_available_millis": "option_u64",
                    "memory_needed_mib": "u64", "memory_available_mib": "option_u64",
                    "disk_needed_mib": "u64", "disk_available_mib": "option_u64"
                }
            },
            "activated": {},
            "setup_abandoned": { "step": steps },
            "sign_in": {
                "outcome": ["started", "completed", "failed", "cancelled", "restored"],
                "duration_ms": "option_u64",
                "cli_failure": CLI_FAILURES
            },
            "setup_stalled": {
                "part": StallPart::ALL.map(StallPart::as_str),
                "step": crate::stall::step_names(),
                "typical_seconds": "u64",
                "elapsed_seconds": "u64"
            },
            "ui_stalled": {
                "step": FAILING_STEPS,
                "stalled_seconds": "u64"
            }
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

/// `COPILOTKIT_TELEMETRY_DISABLED` or `DO_NOT_TRACK` in this app's own environment. Settings
/// cannot turn sharing back on over it.
pub fn disabled_by_environment() -> bool {
    telemetry_disabled(EnvOverride::Process)
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
            app_version: AppVersion::parse(version).unwrap(),
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
    fn persisted_queue_accepts_account_binding_and_record_time_identity() {
        let mut state = serde_json::to_value(PersistedState::new(new_uuid())).unwrap();
        state["account_id"] = serde_json::json!("a".repeat(64));
        let mut event = serde_json::to_value(Event::new(
            EventData::Activated,
            context("1.2.3", Engine::None),
        ))
        .unwrap();
        event["installation_id"] = serde_json::json!(new_uuid());
        state["queue"] = serde_json::json!([event]);
        assert!(serde_json::from_value::<PersistedState>(state).is_ok(), "account binding must survive a restart alongside each queued event's original identity");
    }

    #[test]
    fn account_binding_survives_restart_and_same_account_keeps_anonymous_trail() {
        let dir = temp_dir("account-binding");
        let first = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            Config::disabled_for_tests(),
            EnvOverride::Enabled,
        )
        .unwrap();
        let id = first.install_id().unwrap();
        first.record(EventData::Activated).unwrap();
        first.bind_account(&"a".repeat(64)).unwrap();
        assert_eq!(first.install_id().as_deref(), Some(id.as_str()));
        drop(first);
        let reopened = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            Config::disabled_for_tests(),
            EnvOverride::Enabled,
        )
        .unwrap();
        assert_eq!(reopened.bound_account(), Some("a".repeat(64)));
        reopened.bind_account(&"a".repeat(64)).unwrap();
        assert_eq!(reopened.install_id().as_deref(), Some(id.as_str()));
        assert_eq!(reopened.snapshot().unwrap().queue.len(), 1);
    }

    #[test]
    fn switching_accounts_sends_queued_events_under_their_original_identity() {
        let _ports = crate::test_support::hold_ports();
        let dir = temp_dir("account-switch");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/ingest", listener.local_addr().unwrap());
        let telemetry = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            enabled(endpoint),
            EnvOverride::Enabled,
        )
        .unwrap();
        let old_id = telemetry.install_id().unwrap();
        telemetry.bind_account(&"a".repeat(64)).unwrap();
        telemetry.record(EventData::Activated).unwrap();
        // An old on-disk queue did not carry per-event installation IDs.
        telemetry.state.lock().unwrap().as_mut().unwrap().queue[0].installation_id = None;
        telemetry.bind_account(&"b".repeat(64)).unwrap();
        let new_id = telemetry.install_id().unwrap();
        assert_ne!(old_id, new_id);
        assert_eq!(
            telemetry.runtime_env().get("CPK_TELEMETRY_ID"),
            Some(&new_id)
        );
        telemetry
            .record(EventData::HarnessChosen {
                harness: Harness::ByoUrl,
            })
            .unwrap();
        let server = thread::spawn(move || {
            [
                one_response(listener.try_clone().unwrap()),
                one_response(listener),
            ]
        });
        telemetry.flush().unwrap();
        let requests = server.join().unwrap();
        assert!(requests[0].contains(&old_id));
        assert!(!requests[0].contains(&new_id));
        assert!(requests[1].contains(&new_id));
        for request in requests {
            assert!(!request.contains("account_id"));
        }
        assert!(telemetry.snapshot().unwrap().queue.is_empty());
    }

    #[test]
    fn sign_out_sends_later_events_under_a_fresh_anonymous_identity() {
        let _ports = crate::test_support::hold_ports();
        let dir = temp_dir("account-sign-out");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/ingest", listener.local_addr().unwrap());
        let telemetry = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            enabled(endpoint),
            EnvOverride::Enabled,
        )
        .unwrap();
        let old_id = telemetry.install_id().unwrap();
        telemetry.bind_account(&"a".repeat(64)).unwrap();
        telemetry.record(EventData::Activated).unwrap();
        // An old on-disk queue did not carry per-event installation IDs.
        telemetry.state.lock().unwrap().as_mut().unwrap().queue[0].installation_id = None;
        telemetry.clear_account().unwrap();
        assert_eq!(telemetry.bound_account(), None);
        let signed_out_id = telemetry.install_id();
        telemetry.clear_account().unwrap();
        assert_eq!(telemetry.install_id(), signed_out_id);
        let new_id = telemetry.install_id().unwrap();
        assert_ne!(old_id, new_id);
        assert_eq!(
            telemetry.runtime_env().get("CPK_TELEMETRY_ID"),
            Some(&new_id)
        );
        telemetry
            .record(EventData::HarnessChosen {
                harness: Harness::ByoUrl,
            })
            .unwrap();
        let server = thread::spawn(move || {
            [
                one_response(listener.try_clone().unwrap()),
                one_response(listener),
            ]
        });
        telemetry.flush().unwrap();
        let requests = server.join().unwrap();
        assert!(requests[0].contains(&old_id));
        assert!(!requests[0].contains(&new_id));
        assert!(requests[1].contains(&new_id));
        for request in requests {
            assert!(!request.contains("account_id"));
        }
        assert!(telemetry.snapshot().unwrap().queue.is_empty());
    }

    #[test]
    fn opt_out_does_not_create_an_account_binding() {
        let dir = temp_dir("account-opt-out");
        let telemetry = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            Config::disabled_for_tests(),
            EnvOverride::Disabled,
        )
        .unwrap();
        telemetry.bind_account(&"a".repeat(64)).unwrap();
        assert!(telemetry.install_id().is_none());
        assert!(telemetry.bound_account().is_none());
        assert!(!state_path(&dir).exists());
    }

    #[test]
    fn failed_binding_write_leaves_in_memory_identity_unchanged() {
        let dir = temp_dir("account-write-failure");
        let telemetry = Telemetry::open_with_env(
            &dir,
            context("1.2.3", Engine::None),
            Config::disabled_for_tests(),
            EnvOverride::Enabled,
        )
        .unwrap();
        telemetry.bind_account(&"a".repeat(64)).unwrap();
        let id = telemetry.install_id();
        fs::remove_file(state_path(&dir)).unwrap();
        fs::create_dir(state_path(&dir)).unwrap();
        assert!(telemetry.bind_account(&"b".repeat(64)).is_err());
        assert_eq!(telemetry.install_id(), id);
        assert_eq!(telemetry.bound_account(), Some("a".repeat(64)));
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

    /// The new parts of `setup_failed` and `sign_in` are closed: enums and numbers, nothing a
    /// sentence, a path, an email or a key can ride in. A queue saved by an older version, whose
    /// `setup_failed` has only a step and a class, still reads.
    #[test]
    fn setup_failed_and_sign_in_take_only_closed_values() {
        let failed = serde_json::json!({
            "kind": "setup_failed",
            "step": "account",
            "error_class": "insufficient_resources",
            "failing_step": "local_setup",
            "cli_reason": "resources_short",
            "resources": {
                "cpu_short": false, "memory_short": false, "disk_short": true,
                "cpu_needed_millis": 4000, "cpu_available_millis": 9800,
                "memory_needed_mib": 4096, "memory_available_mib": 19353,
                "disk_needed_mib": 40960, "disk_available_mib": 0
            }
        });
        let event = serde_json::from_value::<EventData>(failed.clone()).unwrap();
        assert_eq!(serde_json::to_value(&event).unwrap(), failed);
        assert_eq!(event.event_name(), "oss.desktop.setup_failed");
        for (path, value) in [
            (
                "detail",
                serde_json::json!("/Users/someone/OpenBot: no space left on device"),
            ),
            ("failing_step", serde_json::json!("compose up -d failed")),
            ("cli_reason", serde_json::json!("the CLI's own sentence")),
            (
                "cli_failure",
                serde_json::json!("exit 1: someone@example.invalid"),
            ),
            ("email", serde_json::json!("someone@example.invalid")),
        ] {
            let mut private = failed.clone();
            private[path] = value;
            assert!(
                serde_json::from_value::<EventData>(private).is_err(),
                "{path}"
            );
        }
        let mut private = failed.clone();
        private["resources"]["drive"] = serde_json::json!("C:\\Users\\someone");
        assert!(serde_json::from_value::<EventData>(private).is_err());
        // An older queue's event.
        assert!(serde_json::from_value::<EventData>(serde_json::json!({
            "kind": "setup_failed", "step": "install", "error_class": "unknown"
        }))
        .is_ok());

        let sign_in =
            serde_json::json!({ "kind": "sign_in", "outcome": "cancelled", "duration_ms": 1200 });
        let event = serde_json::from_value::<EventData>(sign_in.clone()).unwrap();
        assert_eq!(serde_json::to_value(&event).unwrap(), sign_in);
        assert_eq!(event.event_name(), "oss.desktop.sign_in");
        for (path, value) in [
            (
                "outcome",
                serde_json::json!("signed in as someone@example.invalid"),
            ),
            ("email", serde_json::json!("someone@example.invalid")),
            ("account_id", serde_json::json!("a".repeat(64))),
        ] {
            let mut private = sign_in.clone();
            private[path] = value;
            assert!(
                serde_json::from_value::<EventData>(private).is_err(),
                "{path}"
            );
        }
    }

    #[test]
    fn model_provider_categories_round_trip_and_match_the_closed_schema() {
        let schema = schema_json();
        assert_eq!(
            schema["events"]["model_chosen"]["provider"],
            serde_json::json!(["openai", "anthropic", "google", "xai", "compatible", "none"])
        );
        assert_eq!(
            schema["events"]["model_chosen"]["credential_path"],
            serde_json::json!(["subscription", "api_key", "oauth", "none"])
        );
        for (provider, credential_path) in [
            ("openai", "subscription"),
            ("openai", "api_key"),
            ("anthropic", "subscription"),
            ("anthropic", "api_key"),
            ("google", "oauth"),
            ("xai", "oauth"),
            ("compatible", "api_key"),
            ("compatible", "none"),
            ("none", "none"),
        ] {
            let value = serde_json::json!({
                "kind": "model_chosen",
                "provider": provider,
                "credential_path": credential_path,
                "custom_base_url": provider == "compatible"
            });
            let event = serde_json::from_value::<EventData>(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(event).unwrap(), value);
            assert_string_values_are_listed(&value, &schema["events"]["model_chosen"]);
        }
    }

    #[test]
    fn model_provider_events_reject_unknown_categories_and_private_properties() {
        let event = serde_json::json!({
            "kind": "model_chosen",
            "provider": "google",
            "credential_path": "oauth",
            "custom_base_url": false
        });
        for property in ["apiKey", "token", "model", "baseUrl", "containerBaseUrl"] {
            let mut private_event = event.clone();
            private_event[property] = serde_json::json!("synthetic-private-value");
            assert!(serde_json::from_value::<EventData>(private_event).is_err());
        }
        for property in ["provider", "credential_path"] {
            let mut unknown_event = event.clone();
            unknown_event[property] = serde_json::json!("private-category");
            assert!(serde_json::from_value::<EventData>(unknown_event).is_err());
        }
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
                failing_step: None,
                cli_reason: None,
                cli_failure: None,
                resources: None,
            },
            EventData::SetupFailed {
                step: Step::Account,
                error_class: SetupErrorClass::InsufficientResources,
                failing_step: Some(FailingStep::LocalSetup),
                cli_reason: Some(CliReason::ResourcesShort),
                cli_failure: Some(CliFailure::DownloadStalled),
                resources: Some(Resources {
                    cpu_short: true,
                    memory_short: false,
                    disk_short: true,
                    disk_nearly_full: true,
                    cpu_needed_millis: 4000,
                    cpu_available_millis: Some(2000),
                    memory_needed_mib: 4096,
                    memory_available_mib: None,
                    disk_needed_mib: 40960,
                    disk_available_mib: Some(1024),
                }),
            },
            EventData::Activated,
            EventData::SetupAbandoned { step: Step::Ask },
            EventData::SignIn {
                outcome: SignInOutcome::Cancelled,
                duration_ms: Some(12),
                cli_failure: Some(CliFailure::Cancelled),
            },
            EventData::SetupStalled {
                part: StallPart::Update,
                step: StallStep::named("update_quiesce_wait").unwrap(),
                typical_seconds: 31,
                elapsed_seconds: 160,
            },
            EventData::UiStalled {
                step: FailingStep::CreateMachine,
                stalled_seconds: 42,
            },
        ]
    }

    /// The two stall events carry closed values and numbers only: a step that is not one of the
    /// journeys' timed steps, any text, or any other property is refused.
    #[test]
    fn stall_events_round_trip_and_refuse_anything_open() {
        let stalled = serde_json::json!({
            "kind": "setup_stalled",
            "part": "setup",
            "step": "dependencies_wait",
            "typical_seconds": 27,
            "elapsed_seconds": 148
        });
        let event = serde_json::from_value::<EventData>(stalled.clone()).unwrap();
        assert_eq!(event.event_name(), "oss.desktop.setup_stalled");
        assert_eq!(serde_json::to_value(event).unwrap(), stalled);
        let window = serde_json::json!({
            "kind": "ui_stalled",
            "step": "create_machine",
            "stalled_seconds": 42
        });
        let event = serde_json::from_value::<EventData>(window.clone()).unwrap();
        assert_eq!(event.event_name(), "oss.desktop.ui_stalled");
        assert_eq!(serde_json::to_value(event).unwrap(), window);
        for (base, path, value) in [
            (&stalled, "step", serde_json::json!("Waiting for databases")),
            (&stalled, "step", serde_json::json!("image_download")),
            (&stalled, "part", serde_json::json!("quit")),
            (&stalled, "typical_seconds", serde_json::json!("27")),
            (&stalled, "detail", serde_json::json!("/Users/someone")),
            (&window, "step", serde_json::json!("the engine machine")),
            (&window, "stalled_seconds", serde_json::json!(-1)),
            (&window, "url", serde_json::json!("tauri://localhost")),
        ] {
            let mut open = base.clone();
            open[path] = value;
            assert!(serde_json::from_value::<EventData>(open).is_err(), "{path}");
        }
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
            account_id: None,
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
