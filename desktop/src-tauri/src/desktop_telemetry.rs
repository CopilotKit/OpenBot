//! Tauri integration for the setup emitter. Network work stays off the event loop.
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use openbot_desktop_lib::{engine, local_eval, quiet, telemetry, usage_data};
use tauri::Manager;

pub struct DesktopTelemetry {
    emitter: Arc<telemetry::Telemetry>,
    runtime_env: Mutex<BTreeMap<String, String>>,
    identity_link: Mutex<()>,
    /// The installation and account `telemetry link` last confirmed in this launch. Each link is a
    /// CLI command with its own analytics, so a confirmed pair is not asked about again until a
    /// new sign-in, a rotated installation, or the next launch.
    linked: Mutex<Option<(String, String)>>,
    /// Setup failures recorded in this launch, so a failed Start or install whose step already
    /// said so is not recorded a second time by its catch-all (`unreported_failure`).
    failures: AtomicU64,
    /// The Account step's last refusal recorded, so a check the window asks again is one event.
    account_refusal: Mutex<Option<telemetry::EventData>>,
    /// A sign-in completed or an account was found signed in this launch: `restored` is said once.
    signed_in: AtomicBool,
}

impl DesktopTelemetry {
    fn new(emitter: Arc<telemetry::Telemetry>) -> Self {
        Self {
            runtime_env: Mutex::new(fresh_runtime_env(&emitter)),
            emitter,
            identity_link: Mutex::new(()),
            linked: Mutex::new(None),
            failures: AtomicU64::new(0),
            account_refusal: Mutex::new(None),
            signed_in: AtomicBool::new(false),
        }
    }

    /// `for_tests`, sending to `endpoint` (a loopback test sink).
    #[cfg(test)]
    pub(crate) fn for_tests_sending(
        data_dir: std::path::PathBuf,
        sharing: bool,
        endpoint: String,
    ) -> Self {
        let emitter = telemetry::Telemetry::open_with_env(
            data_dir,
            tests::context(),
            telemetry::Config {
                enabled: true,
                endpoint: Some(endpoint),
                max_queue: 256,
            },
            if sharing {
                telemetry::EnvOverride::Enabled
            } else {
                telemetry::EnvOverride::Disabled
            },
        )
        .unwrap();
        Self::new(emitter)
    }

    /// Send what is queued now, past a background flush that skipped an event recorded while it
    /// was already sending. Bounded: an unreachable sink leaves the queue as it is.
    #[cfg(test)]
    pub(crate) fn deliver(&self) {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !self.queued().is_empty() && std::time::Instant::now() < until {
            let _ = self.emitter.flush();
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    /// Every event queued and not yet sent, or nothing when not sharing.
    #[cfg(test)]
    pub(crate) fn queued(&self) -> Vec<telemetry::EventData> {
        self.emitter
            .snapshot()
            .map(|state| state.queue.into_iter().map(|event| event.data).collect())
            .unwrap_or_default()
    }

    /// An emitter in `data_dir`, sharing or not, for tests that drive the app's commands.
    #[cfg(test)]
    pub(crate) fn for_tests(data_dir: std::path::PathBuf, sharing: bool) -> Self {
        let emitter = telemetry::Telemetry::open_with_env(
            data_dir,
            tests::context(),
            telemetry::Config::disabled_for_tests(),
            if sharing {
                telemetry::EnvOverride::Enabled
            } else {
                telemetry::EnvOverride::Disabled
            },
        )
        .unwrap();
        Self::new(emitter)
    }
}

/// What the server is started with: the emitter's identity and metadata, or the opt-out, and the
/// app's own telemetry settings passed through.
fn fresh_runtime_env(emitter: &telemetry::Telemetry) -> BTreeMap<String, String> {
    let mut runtime_env = emitter.runtime_env();
    for variable in [
        "COPILOTKIT_TELEMETRY_DISABLED",
        "DO_NOT_TRACK",
        "COPILOTKIT_TELEMETRY_URL",
    ] {
        if let Ok(value) = std::env::var(variable) {
            runtime_env.insert(variable.into(), value);
        }
    }
    if emitter.install_id().is_none() || usage_data::off() {
        runtime_env.insert("COPILOTKIT_TELEMETRY_DISABLED".into(), "1".into());
    }
    runtime_env
}

pub fn initialize<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    // Settings' Share usage data, as it was left. Off is the environment opt-out by another name.
    let shared = app
        .path()
        .app_config_dir()
        .map(|directory| usage_data::saved(&directory))
        .unwrap_or(true);
    usage_data::set_off(!shared);
    let initialized = (|| {
        let context = context(&app.package_info().version.to_string())?;
        let emitter = telemetry::Telemetry::open_with_env(
            app.path().app_local_data_dir().ok()?.join("telemetry"),
            context,
            telemetry::Config {
                enabled: true,
                endpoint: Some(
                    std::env::var("COPILOTKIT_TELEMETRY_URL")
                        .unwrap_or_else(|_| "https://telemetry.copilotkit.ai/ingest".into()),
                ),
                max_queue: 256,
            },
            if shared {
                telemetry::EnvOverride::Process
            } else {
                telemetry::EnvOverride::Disabled
            },
        )
        .ok()?;
        app.manage(DesktopTelemetry::new(emitter));
        Some(())
    })();
    if initialized.is_none() {
        log::warn!("[telemetry] local setup telemetry could not initialize");
        return;
    }
    record(
        app,
        telemetry::EventData::StepViewed {
            step: telemetry::Step::Welcome,
        },
    );
}

fn context(version: &str) -> Option<telemetry::Context> {
    use telemetry::{
        AppVersion, Architecture, Distribution, Engine, NumericVersion, Platform, RuntimeEnv,
    };
    let platform = match std::env::consts::OS {
        "macos" => Platform::Macos,
        "windows" => Platform::Windows,
        "linux" => Platform::Linux,
        _ => Platform::Other,
    };
    let mut command = match platform {
        Platform::Macos => {
            let mut c = quiet::command("/usr/bin/sw_vers");
            c.arg("-productVersion");
            c
        }
        Platform::Windows => {
            let mut c = quiet::command("cmd");
            c.args(["/C", "ver"]);
            c
        }
        _ => {
            let mut c = quiet::command("uname");
            c.arg("-r");
            c
        }
    };
    let os_version = command
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .split(|c: char| !c.is_ascii_digit() && c != '.')
                .find_map(|part| NumericVersion::parse(part).ok())
        });
    Some(telemetry::Context {
        distribution: Distribution::Desktop,
        // The whole version, a release candidate's label included (`AppVersion`).
        app_version: AppVersion::from_package(version)?,
        platform,
        arch: match std::env::consts::ARCH {
            "aarch64" => Architecture::Aarch64,
            "x86_64" => Architecture::X86_64,
            _ => Architecture::Other,
        },
        os_version,
        engine: Engine::None,
        runtime_env: if cfg!(debug_assertions) {
            RuntimeEnv::Development
        } else {
            RuntimeEnv::Production
        },
    })
}

/// After a successful Start, on its own thread: Start never waits for attribution. The runtime
/// was handed the identity as it stood; a link that changes it reaches the runtime at the next
/// Start. The handshake yields to required CLI work and is bounded by the CLI's own budget (two
/// calls of eight seconds each, plus termination grace), so it holds nothing up after it either.
pub fn link_account_after_start<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let app = app.clone();
    spawn_link(move || link_account_background(&app));
}

/// Settings' Share usage data: whether this installation shares, and whether the app's own
/// environment turned it off, which Settings cannot override.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageData {
    pub shared: bool,
    pub off_by_environment: bool,
}

pub fn usage_data_now() -> UsageData {
    let off_by_environment = telemetry::disabled_by_environment();
    UsageData {
        shared: !off_by_environment && !usage_data::off(),
        off_by_environment,
    }
}

/// Turn sharing on or off from Settings. Kept for the next launch, and applied at once to the
/// desktop's own events and to the CLI. The server reads it the next time OpenBot starts.
pub fn set_usage_data<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    share: bool,
) -> Result<UsageData, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let state = app.try_state::<DesktopTelemetry>();
    set_usage_data_in(&directory, state.as_deref(), share)
}

pub(crate) fn set_usage_data_in(
    directory: &std::path::Path,
    state: Option<&DesktopTelemetry>,
    share: bool,
) -> Result<UsageData, String> {
    if share && telemetry::disabled_by_environment() {
        return Err("Usage data is turned off on this computer.".into());
    }
    usage_data::save(directory, share).map_err(|error| error.to_string())?;
    usage_data::set_off(!share);
    if let Some(state) = state {
        if share {
            state
                .emitter
                .resume_sharing()
                .map_err(|error| error.to_string())?;
        } else {
            // A handshake already running stops; none starts again while sharing is off.
            local_eval::cancel_background_telemetry();
            state
                .emitter
                .stop_sharing()
                .map_err(|error| error.to_string())?;
        }
        if let Ok(mut linked) = state.linked.lock() {
            *linked = None;
        }
        if let Ok(mut environment) = state.runtime_env.lock() {
            *environment = fresh_runtime_env(&state.emitter);
        }
    }
    log::info!(
        "[telemetry] usage data {} from Settings",
        if share { "shared" } else { "turned off" }
    );
    Ok(usage_data_now())
}

/// A hook never queues another handshake behind an active one; Start remains the retry.
fn link_account_background<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(state) = app.try_state::<DesktopTelemetry>() else {
        return;
    };
    if link_account_background_with(&state, local_eval::link_telemetry_background_installed)
        .is_err()
    {
        log::warn!("[telemetry] account link deferred until sign-in or Start");
    }
}

fn link_account_background_with(
    state: &DesktopTelemetry,
    link: impl FnMut(
        &local_eval::Installation,
        Option<&str>,
    ) -> Result<local_eval::TelemetryIdentity, local_eval::Failure>,
) -> Result<(), ()> {
    let Ok(_link) = state.identity_link.try_lock() else {
        return Ok(());
    };
    // Confirmed already in this launch: not asked again until a new sign-in clears it.
    if let (Some(id), Some(account)) = (state.emitter.install_id(), state.emitter.bound_account()) {
        if state.linked.lock().map_err(|_| ())?.as_ref() == Some(&(id, account)) {
            return Ok(());
        }
    }
    link_account_unlocked(state, link)
}

/// A restored account has already passed the CLI's account check, even before Start.
pub fn finish_account_check<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    result: Result<local_eval::Terms, local_eval::Failure>,
) -> Result<local_eval::Terms, local_eval::Failure> {
    account_checked(app, &result);
    let app = app.clone();
    finish_account_check_with(result, move || link_account_background(&app))
}

/**
The Account step's check, in usage data. An account found signed in, when no sign-in has said so
this launch, is a `restored` sign-in. A check that stops setup (an engine too small, one local setup
does not run on, a CLI that failed) is a `setup_failed` at `account_check`, once for as long as the
window keeps getting the same answer: it asks again every few seconds while it waits.
*/
fn account_checked<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    result: &Result<local_eval::Terms, local_eval::Failure>,
) {
    let Some(state) = app.try_state::<DesktopTelemetry>() else {
        return;
    };
    if matches!(
        result,
        Ok(local_eval::Terms::Required { .. } | local_eval::Terms::NotRequired)
    ) && !state.signed_in.swap(true, Ordering::SeqCst)
    {
        record(
            app,
            telemetry::EventData::SignIn {
                outcome: telemetry::SignInOutcome::Restored,
                duration_ms: None,
                cli_failure: None,
            },
        );
    }
    let refusal = terms_failure(result);
    let event = refusal
        .as_ref()
        .map(|failure| failure.event(telemetry::Step::Account));
    {
        let Ok(mut last) = state.account_refusal.lock() else {
            return;
        };
        if *last == event {
            return;
        }
        last.clone_from(&event);
    }
    if let Some(failure) = refusal {
        setup_failed(app, failure);
    }
}

fn finish_account_check_with(
    result: Result<local_eval::Terms, local_eval::Failure>,
    link: impl FnOnce() + Send + 'static,
) -> Result<local_eval::Terms, local_eval::Failure> {
    if matches!(
        &result,
        Ok(local_eval::Terms::Required { .. } | local_eval::Terms::NotRequired)
    ) {
        spawn_link(link);
    }
    result
}

/// Successful login is an attribution opportunity before the person reaches Start.
pub fn finish_sign_in<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    result: Result<local_eval::AccountSignIn, local_eval::Failure>,
) -> Result<local_eval::AccountSignIn, local_eval::Failure> {
    if result.as_ref().is_ok_and(|signed| signed.signed_in) {
        // A new sign-in may be another account: ask again.
        if let Some(state) = app.try_state::<DesktopTelemetry>() {
            if let Ok(mut linked) = state.linked.lock() {
                *linked = None;
            }
            state.signed_in.store(true, Ordering::SeqCst);
        }
    }
    let app = app.clone();
    finish_sign_in_with(result, move || link_account_background(&app))
}

/// Return the sign-in result without waiting for optional attribution.
fn finish_sign_in_with(
    result: Result<local_eval::AccountSignIn, local_eval::Failure>,
    link: impl FnOnce() + Send + 'static,
) -> Result<local_eval::AccountSignIn, local_eval::Failure> {
    if result.as_ref().is_ok_and(|signed| signed.signed_in) {
        spawn_link(link);
    }
    result
}

/// Retry after app setup, which may have cancelled the earlier account-check handshake.
/// The CLI still verifies the account; app provisioning success is not identity authority.
pub fn finish_account_setup<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    result: Result<(), crate::Problem>,
) -> Result<(), crate::Problem> {
    let app = app.clone();
    finish_account_setup_with(result, move || link_account_background(&app))
}

fn finish_account_setup_with(
    result: Result<(), crate::Problem>,
    link: impl FnOnce() + Send + 'static,
) -> Result<(), crate::Problem> {
    spawn_link(link);
    result
}

/// Detach optional telemetry work; failures leave the next lifecycle attempt free to retry.
fn spawn_link(link: impl FnOnce() + Send + 'static) {
    if std::thread::Builder::new()
        .name("openbot-account-link".into())
        .spawn(link)
        .is_err()
    {
        log::warn!("[telemetry] account link deferred until sign-in or Start");
    }
}

/// Keep the binding durable before invoking the CLI's permanent alias operation. Waits for a
/// handshake already running, where the app's own hooks skip it; tests drive the protocol here.
#[cfg(test)]
fn link_account_with(
    state: &DesktopTelemetry,
    link: impl FnMut(
        &local_eval::Installation,
        Option<&str>,
    ) -> Result<local_eval::TelemetryIdentity, local_eval::Failure>,
) -> Result<(), ()> {
    // Launch, sign-in and Start must never interleave binding writes with permanent aliases.
    let _link = state.identity_link.lock().map_err(|_| ())?;
    link_account_unlocked(state, link)
}

fn link_account_unlocked(
    state: &DesktopTelemetry,
    mut link: impl FnMut(
        &local_eval::Installation,
        Option<&str>,
    ) -> Result<local_eval::TelemetryIdentity, local_eval::Failure>,
) -> Result<(), ()> {
    for _ in 0..2 {
        // Turned off in Settings: no identity, and no CLI call.
        if usage_data::off() {
            return Ok(());
        }
        let Some(id) = state.emitter.install_id() else {
            return Ok(());
        };
        let installation = local_eval::Installation::parse(&id).map_err(|_| ())?;
        let account = state.emitter.bound_account();
        match link(&installation, account.as_deref()).map_err(|_| ())? {
            local_eval::TelemetryIdentity::Skipped => return Ok(()),
            local_eval::TelemetryIdentity::SignedOut => {
                state.emitter.clear_account().map_err(|_| ())?;
                state
                    .runtime_env
                    .lock()
                    .map_err(|_| ())?
                    .extend(state.emitter.runtime_env());
                return Ok(());
            }
            local_eval::TelemetryIdentity::Linked { account_id }
                if account.as_deref() == Some(&account_id) =>
            {
                *state.linked.lock().map_err(|_| ())? = Some((id, account_id));
                return Ok(());
            }
            local_eval::TelemetryIdentity::Account { account_id } => {
                state.emitter.bind_account(&account_id).map_err(|_| ())?;
                let mut environment = state.runtime_env.lock().map_err(|_| ())?;
                environment.extend(state.emitter.runtime_env());
            }
            _ => return Err(()),
        }
    }
    Err(())
}

pub fn record<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: telemetry::EventData) {
    let Some(state) = app.try_state::<DesktopTelemetry>() else {
        return;
    };
    if state.emitter.record(event).is_err() {
        log::warn!("[telemetry] setup event could not be saved");
        return;
    }
    let emitter = Arc::clone(&state.emitter);
    if std::thread::Builder::new()
        .name("openbot-telemetry".into())
        .spawn(move || {
            if emitter.flush().is_err() {
                log::warn!("[telemetry] delivery deferred until the next flush");
            }
        })
        .is_err()
    {
        log::warn!("[telemetry] delivery deferred until the next flush");
    }
}

pub fn observe_engine<R: tauri::Runtime>(app: &tauri::AppHandle<R>, status: &engine::EngineStatus) {
    let engine = status.address.as_ref().map(|address| address.engine);
    let kind = match engine {
        Some(engine::Engine::Docker) => telemetry::Engine::Docker,
        Some(engine::Engine::Podman) => telemetry::Engine::Podman,
        None => telemetry::Engine::None,
    };
    if let Some(state) = app.try_state::<DesktopTelemetry>() {
        let _ = state.emitter.update_engine(kind);
        if let Ok(mut env) = state.runtime_env.lock() {
            env.insert(
                "OPENBOT_ENGINE".into(),
                engine.map(|value| value.binary()).unwrap_or("none").into(),
            );
        }
    }
    record(
        app,
        telemetry::EventData::EngineDetected {
            engine: kind,
            responding: status.responding,
        },
    );
}

pub fn runtime_env<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> BTreeMap<String, String> {
    app.try_state::<DesktopTelemetry>()
        .and_then(|state| state.runtime_env.lock().ok().map(|env| env.clone()))
        .unwrap_or_default()
}

/// One setup failure, every part of it a closed value: never a sentence, a path or CLI output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetupFailure {
    pub failing_step: telemetry::FailingStep,
    pub error_class: telemetry::SetupErrorClass,
    pub cli_reason: Option<telemetry::CliReason>,
    pub cli_failure: Option<telemetry::CliFailure>,
    pub resources: Option<telemetry::Resources>,
}

impl SetupFailure {
    pub fn new(
        failing_step: telemetry::FailingStep,
        error_class: telemetry::SetupErrorClass,
    ) -> Self {
        Self {
            failing_step,
            error_class,
            cli_reason: None,
            cli_failure: None,
            resources: None,
        }
    }

    fn event(&self, step: telemetry::Step) -> telemetry::EventData {
        telemetry::EventData::SetupFailed {
            step,
            error_class: self.error_class,
            failing_step: Some(self.failing_step),
            cli_reason: self.cli_reason,
            cli_failure: self.cli_failure,
            resources: self.resources.clone(),
        }
    }
}

/// Record a setup failure, at the last setup screen the window showed (Install when none).
pub fn setup_failed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, failure: SetupFailure) {
    let Some(state) = app.try_state::<DesktopTelemetry>() else {
        return;
    };
    state.failures.fetch_add(1, Ordering::SeqCst);
    let step = state
        .emitter
        .snapshot()
        .ok()
        .and_then(|state| state.last_step)
        .unwrap_or(telemetry::Step::Install);
    record(app, failure.event(step));
}

/// How many setup failures this launch has recorded, to compare after a Start or install.
pub fn failures_recorded<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> u64 {
    app.try_state::<DesktopTelemetry>()
        .map_or(0, |state| state.failures.load(Ordering::SeqCst))
}

/**
A Start or install that failed after `before` with none of its steps having recorded why: one
`setup_failed`, at the part of the work it was in, with a class read from the problem's words. A
Start cancelled by Stop is the person's choice, not a failure, and is not recorded.
*/
pub fn unreported_failure<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    before: u64,
    failing_step: telemetry::FailingStep,
    problem: &crate::Problem,
    cancelled: bool,
) {
    if cancelled || failures_recorded(app) != before {
        return;
    }
    let text = format!(
        "{}\n{}",
        problem.said,
        problem.detail.as_deref().unwrap_or("")
    );
    setup_failed(
        app,
        SetupFailure::new(failing_step, class_of_row(failing_step, &text)),
    );
}

/// The class of a failure at `step`: what the step is about, else what its words say.
pub fn class_of_row(step: telemetry::FailingStep, text: &str) -> telemetry::SetupErrorClass {
    use telemetry::{FailingStep as S, SetupErrorClass as C};
    let by_step = match step {
        S::InstallEngine => C::EngineInstallFailed,
        S::Engine | S::CreateMachine | S::StartMachine | S::HealthGate => C::EngineUnavailable,
        S::Env | S::Ports => C::InvalidConfiguration,
        S::Images => C::ImagePullFailed,
        _ => C::Unknown,
    };
    match (by_step, class_of_text(text)) {
        // The words say more than the step does: a permission or a full disk under any step.
        (_, Some(said @ (C::PermissionDenied | C::InsufficientResources))) => said,
        (C::Unknown, Some(said)) => said,
        (by_step, _) => by_step,
    }
}

/**
A failure's class from its words, as engines, registries and the operating system say them. Only the
class leaves this function; the words are never recorded.
*/
pub fn class_of_text(text: &str) -> Option<telemetry::SetupErrorClass> {
    use telemetry::SetupErrorClass as C;
    let text = text.to_ascii_lowercase();
    let any = |needles: &[&str]| needles.iter().any(|needle| text.contains(needle));
    if any(&[
        "no space left on device",
        "disk is full",
        "not enough space",
        "insufficient disk",
        "out of memory",
        "cannot allocate memory",
        "insufficient memory",
    ]) {
        return Some(C::InsufficientResources);
    }
    if any(&[
        "pull access denied",
        "manifest unknown",
        "manifest for",
        "error pulling",
        "failed to pull",
        "toomanyrequests",
        "error response from daemon: pull",
        "no matching manifest",
        "unauthorized: authentication required",
        "could not download",
    ]) {
        return Some(C::ImagePullFailed);
    }
    if any(&[
        "no such host",
        "could not resolve",
        "temporary failure in name resolution",
        "name resolution",
        "network is unreachable",
        "tls handshake timeout",
        "i/o timeout",
        "dial tcp",
        "connection reset",
        "econnreset",
        "enotfound",
        "eai_again",
        "certificate verify failed",
        "x509:",
        "proxyconnect",
        "offline",
    ]) {
        return Some(C::NetworkUnavailable);
    }
    if any(&[
        "permission denied",
        "access is denied",
        "access denied",
        "operation not permitted",
        "eacces",
        "eperm",
        "requires administrator",
        "not an administrator",
    ]) {
        return Some(C::PermissionDenied);
    }
    if any(&[
        "cannot connect to the docker daemon",
        "is the docker daemon running",
        "docker daemon is not running",
        "engine is not answering",
        "cannot connect to podman",
        "podman machine is not running",
    ]) {
        return Some(C::EngineUnavailable);
    }
    None
}

pub fn cli_failure(failure: local_eval::Failure) -> telemetry::CliFailure {
    use local_eval::Failure as F;
    use telemetry::CliFailure as T;
    match failure {
        F::Unavailable => T::Unavailable,
        F::Unverified => T::Unverified,
        F::InvalidStack => T::InvalidStack,
        F::Spawn => T::Spawn,
        F::Timeout => T::Timeout,
        F::Cancelled => T::Cancelled,
        F::OutputLimit => T::OutputLimit,
        F::InvalidJson => T::InvalidJson,
        F::UnsupportedVersion => T::UnsupportedVersion,
        F::UnexpectedCommand => T::UnexpectedCommand,
        F::InvalidStatus => T::InvalidStatus,
        F::MissingStack => T::MissingStack,
        F::UnsafeEndpoint => T::UnsafeEndpoint,
        F::ContractMismatch => T::ContractMismatch,
        F::UnexpectedExit => T::UnexpectedExit,
        F::InvalidAcceptance => T::InvalidAcceptance,
        F::RootlessPodman => T::RootlessPodman,
        F::DownloadStalled => T::DownloadStalled,
    }
}

pub fn cli_reason(reason: local_eval::Reason) -> telemetry::CliReason {
    use local_eval::Reason as R;
    use telemetry::CliReason as T;
    match reason {
        R::AuthenticationRequired => T::AuthenticationRequired,
        R::EulaAcceptanceRequired => T::EulaAcceptanceRequired,
        R::EulaUnavailable => T::EulaUnavailable,
        R::EulaDeclined => T::EulaDeclined,
        R::ReleaseUnavailable => T::ReleaseUnavailable,
        R::FeatureDisabled => T::FeatureDisabled,
        R::UnsupportedPlatform => T::UnsupportedPlatform,
        R::UnsupportedEngine => T::UnsupportedEngine,
        R::PortUnavailable => T::PortUnavailable,
        R::DockerUnavailable => T::DockerUnavailable,
        R::UpdateRecoveryRequired => T::UpdateRecoveryRequired,
        R::IncompatibleRelease => T::IncompatibleRelease,
        R::LocalCommandBusy => T::LocalCommandBusy,
        R::LocalCommandFailed => T::LocalCommandFailed,
        R::ConfirmationRequired => T::ConfirmationRequired,
        R::DashboardUnavailable => T::DashboardUnavailable,
        R::BrowserOpenFailed => T::BrowserOpenFailed,
        R::ResourcesShort => T::ResourcesShort,
        R::Unrecognized => T::Unrecognized,
    }
}

fn class_of_cli_failure(failure: local_eval::Failure) -> telemetry::SetupErrorClass {
    use local_eval::Failure as F;
    use telemetry::SetupErrorClass as C;
    match failure {
        F::DownloadStalled => C::NetworkUnavailable,
        F::RootlessPodman => C::UnsupportedEngine,
        F::Unavailable | F::Unverified => C::InvalidConfiguration,
        _ => C::Unknown,
    }
}

fn class_of_cli_reason(reason: local_eval::Reason) -> telemetry::SetupErrorClass {
    use local_eval::Reason as R;
    use telemetry::SetupErrorClass as C;
    match reason {
        R::ResourcesShort => C::InsufficientResources,
        R::UnsupportedEngine | R::UnsupportedPlatform => C::UnsupportedEngine,
        R::DockerUnavailable => C::EngineUnavailable,
        R::PortUnavailable => C::InvalidConfiguration,
        R::ReleaseUnavailable | R::DashboardUnavailable => C::NetworkUnavailable,
        _ => C::Unknown,
    }
}

/// A blocked answer that is the normal next step (sign in, accept the agreement), the person's own
/// choice, or the CLI busy with another call: not a failure.
fn blocked_normally(reason: Option<local_eval::Reason>) -> bool {
    use local_eval::Reason as R;
    matches!(
        reason,
        Some(
            R::AuthenticationRequired
                | R::EulaAcceptanceRequired
                | R::EulaDeclined
                | R::LocalCommandBusy
        )
    )
}

const MIB: u64 = 1024 * 1024;

/// What local setup needs, as `local_eval`'s minimums say it.
fn needed(cpu_short: bool, memory_short: bool, disk_short: bool) -> telemetry::Resources {
    telemetry::Resources {
        cpu_short,
        memory_short,
        disk_short,
        disk_nearly_full: false,
        cpu_needed_millis: local_eval::MIN_ENGINE_CPUS * 1000,
        cpu_available_millis: None,
        memory_needed_mib: local_eval::MIN_ENGINE_MEMORY_BYTES / MIB,
        memory_available_mib: None,
        disk_needed_mib: local_eval::MIN_ENGINE_FREE_DISK_BYTES / MIB,
        disk_available_mib: None,
    }
}

/// A shortfall the CLI or OpenBot's check after a failed call named, with the numbers it said: CPUs,
/// and GiB to one decimal.
pub fn resources_of_shortfall(shortfall: &local_eval::Shortfall) -> telemetry::Resources {
    let number = |said: &Option<String>, scale: f64| {
        said.as_deref()
            .and_then(|said| said.parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| (value * scale).floor() as u64)
    };
    telemetry::Resources {
        disk_nearly_full: shortfall.nearly_full,
        cpu_available_millis: number(&shortfall.cpus, 1000.0),
        memory_available_mib: number(&shortfall.memory_gb, 1024.0),
        disk_available_mib: number(&shortfall.disk_gb, 1024.0),
        ..needed(shortfall.cpu, shortfall.memory, shortfall.disk)
    }
}

/// What the Account step measured of an engine too small (`local_eval::engine_size_terms`).
pub fn resources_of_measure(
    cpu: bool,
    memory: bool,
    disk: bool,
    measured: &local_eval::EngineMeasure,
) -> telemetry::Resources {
    telemetry::Resources {
        cpu_available_millis: Some(measured.cpus.saturating_mul(1000)),
        memory_available_mib: Some(measured.memory_bytes / MIB),
        disk_available_mib: measured.free_disk_bytes.map(|free| free / MIB),
        ..needed(cpu, memory, disk)
    }
}

/// A failed CLI call: its category, and its class. Cancelled is the person's or Stop's doing.
fn call_failure(
    failing_step: telemetry::FailingStep,
    failure: local_eval::Failure,
) -> Option<SetupFailure> {
    (failure != local_eval::Failure::Cancelled).then(|| SetupFailure {
        cli_failure: Some(cli_failure(failure)),
        ..SetupFailure::new(failing_step, class_of_cli_failure(failure))
    })
}

/// A CLI report that failed, or blocked on anything but the next normal step, as a setup failure.
fn reported_failure(
    failing_step: telemetry::FailingStep,
    outcome: local_eval::Outcome,
    reason: Option<local_eval::Reason>,
    shortfall: Option<&local_eval::Shortfall>,
) -> Option<SetupFailure> {
    let failed = match outcome {
        local_eval::Outcome::Completed => false,
        local_eval::Outcome::Failed => true,
        local_eval::Outcome::Blocked => !blocked_normally(reason),
    };
    if !failed {
        return None;
    }
    let mut failure = SetupFailure::new(
        failing_step,
        reason.map_or(telemetry::SetupErrorClass::Unknown, class_of_cli_reason),
    );
    failure.cli_reason = reason.map(cli_reason);
    if let Some(shortfall) = shortfall.filter(|short| short.cpu || short.memory || short.disk) {
        failure.error_class = telemetry::SetupErrorClass::InsufficientResources;
        failure.resources = Some(resources_of_shortfall(shortfall));
    }
    Some(failure)
}

/// `local setup`, `start` or `update` as the window ran it: a failure, or None.
pub fn report_failure(
    failing_step: telemetry::FailingStep,
    result: &Result<local_eval::Report, local_eval::Failure>,
) -> Option<SetupFailure> {
    match result {
        Ok(report) => reported_failure(
            failing_step,
            report.outcome,
            report.reason,
            report.shortfall.as_ref(),
        ),
        Err(failure) => call_failure(failing_step, *failure),
    }
}

/// `local connect`: a failure, or None.
pub fn connection_failure(
    result: &Result<local_eval::Connection, local_eval::Failure>,
) -> Option<SetupFailure> {
    let step = telemetry::FailingStep::LocalConnect;
    match result {
        Ok(connection) => reported_failure(step, connection.outcome, connection.reason, None),
        Err(failure) => call_failure(step, *failure),
    }
}

/// The Account step's check: a failure when it stops setup, or None when it is waiting or fine.
pub fn terms_failure(
    result: &Result<local_eval::Terms, local_eval::Failure>,
) -> Option<SetupFailure> {
    let step = telemetry::FailingStep::AccountCheck;
    match result {
        Ok(local_eval::Terms::Blocked { reason, .. }) => Some(SetupFailure {
            cli_reason: Some(cli_reason(*reason)),
            ..SetupFailure::new(step, class_of_cli_reason(*reason))
        }),
        Ok(local_eval::Terms::EngineTooSmall {
            cpu,
            memory,
            disk,
            measured,
            ..
        }) => Some(SetupFailure {
            resources: Some(resources_of_measure(*cpu, *memory, *disk, measured)),
            ..SetupFailure::new(step, telemetry::SetupErrorClass::InsufficientResources)
        }),
        Ok(_) => None,
        Err(failure) => call_failure(step, *failure),
    }
}

/// The browser sign-in has started.
pub fn sign_in_started<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    record(
        app,
        telemetry::EventData::SignIn {
            outcome: telemetry::SignInOutcome::Started,
            duration_ms: None,
            cli_failure: None,
        },
    );
}

/// How the browser sign-in ended, after `took`.
pub fn sign_in_ended<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    result: &Result<local_eval::AccountSignIn, local_eval::Failure>,
    took: std::time::Duration,
) {
    record(app, sign_in_outcome(result, took));
}

fn sign_in_outcome(
    result: &Result<local_eval::AccountSignIn, local_eval::Failure>,
    took: std::time::Duration,
) -> telemetry::EventData {
    use telemetry::SignInOutcome as O;
    let (outcome, failure) = match result {
        Ok(signed) if signed.signed_in => (O::Completed, None),
        Ok(_) => (O::Failed, None),
        Err(local_eval::Failure::Cancelled) => (O::Cancelled, None),
        Err(failure) => (O::Failed, Some(cli_failure(*failure))),
    };
    telemetry::EventData::SignIn {
        outcome,
        duration_ms: Some(u64::try_from(took.as_millis()).unwrap_or(u64::MAX)),
        cli_failure: failure,
    }
}

pub fn pull_completed<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    metrics: openbot_desktop_lib::pull_metrics::PullMetrics,
) {
    record(
        app,
        telemetry::EventData::ImagePull {
            outcome: metrics.outcome,
            duration_ms: metrics.duration_ms,
            bytes: metrics.bytes,
        },
    );
}

pub fn shutdown<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(state) = app.try_state::<DesktopTelemetry>() {
        if state.emitter.shutdown().is_err() {
            log::warn!("[telemetry] pending setup events retained for next launch");
        }
    }
}

/// A CLI pinned as this debug build's developer CLI, exactly as `local_eval::installed` checks one,
/// that records each call and answers `telemetry link` with `skipped`. With `slow`, it takes longer
/// to answer than the handshake's eight-second budget. `answer` makes it answer every call with
/// that output and exit code instead, as the real CLI answers a `local setup` that failed. Only for
/// a test in its own process.
#[cfg(test)]
pub(crate) mod fake_cli {
    use std::path::PathBuf;

    const SOURCE: &str = r#"
fn main() {
    let exe = std::env::current_exe().unwrap();
    let dir = exe.parent().unwrap().to_path_buf();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--warm") {
        return;
    }
    let mut calls = std::fs::read_to_string(dir.join("calls")).unwrap_or_default();
    calls.push_str(&args.join(" "));
    calls.push('\n');
    std::fs::write(dir.join("calls"), calls).unwrap();
    if dir.join("slow").exists() {
        std::thread::sleep(std::time::Duration::from_secs(30));
    }
    if let Ok(answer) = std::fs::read_to_string(dir.join("answer")) {
        print!("{answer}");
        let code = std::fs::read_to_string(dir.join("exit")).unwrap_or_default();
        std::process::exit(code.trim().parse().unwrap_or(0));
    }
    println!("{{\"type\":\"skipped\"}}");
}
"#;

    pub(crate) struct FakeCli {
        pub(crate) dir: PathBuf,
    }

    impl FakeCli {
        pub(crate) fn pinned(label: &str, slow: bool) -> Self {
            let dir = crate::test_support::temp_root(label);
            std::fs::create_dir_all(&dir).unwrap();
            let source = dir.join("cli.rs");
            std::fs::write(&source, SOURCE).unwrap();
            let program = dir.join(format!("cli{}", std::env::consts::EXE_SUFFIX));
            crate::test_support::compile_fixture(&source, &program);
            assert!(std::process::Command::new(&program)
                .arg("--warm")
                .status()
                .unwrap()
                .success());
            if slow {
                std::fs::write(dir.join("slow"), "").unwrap();
            }
            use sha2::Digest;
            let digest: String = sha2::Sha256::digest(std::fs::read(&program).unwrap())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_PROGRAM", &program);
            std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_PROGRAM_SHA256", digest);
            Self { dir }
        }

        /// Answer every later call with `stdout` and `exit`.
        pub(crate) fn answer(&self, stdout: &str, exit: i32) {
            std::fs::write(self.dir.join("answer"), stdout).unwrap();
            std::fs::write(self.dir.join("exit"), exit.to_string()).unwrap();
        }

        /// Every call so far, one line each, arguments space-separated.
        pub(crate) fn calls(&self) -> String {
            std::fs::read_to_string(self.dir.join("calls")).unwrap_or_default()
        }

        pub(crate) fn forget_calls(&self) {
            let _ = std::fs::remove_file(self.dir.join("calls"));
        }
    }
}

/// A telemetry ingest on 127.0.0.1 for tests: each event the emitter posts, as its JSON body and
/// the installation id it was sent under.
#[cfg(test)]
pub(crate) mod sink {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::sync::mpsc;
    use std::time::Duration;

    pub(crate) struct Sink {
        pub(crate) endpoint: String,
        received: mpsc::Receiver<(String, serde_json::Value)>,
    }

    impl Sink {
        pub(crate) fn start() -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}/ingest", listener.local_addr().unwrap());
            let (sent, received) = mpsc::channel();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { return };
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let (mut length, mut id) = (0usize, String::new());
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        let lower = line.to_ascii_lowercase();
                        if let Some(value) = lower.strip_prefix("content-length:") {
                            length = value.trim().parse().unwrap_or(0);
                        }
                        if lower.starts_with("x-copilotkit-telemetry-id:") {
                            id = line["x-copilotkit-telemetry-id:".len()..].trim().to_owned();
                        }
                    }
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).unwrap();
                    let _ = stream.write_all(
                        b"HTTP/1.1 202 Accepted\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
                    );
                    if sent
                        .send((id, serde_json::from_slice(&body).unwrap()))
                        .is_err()
                    {
                        return;
                    }
                }
            });
            Self { endpoint, received }
        }

        /// The next event posted within `wait`.
        pub(crate) fn next(&self, wait: Duration) -> Option<(String, serde_json::Value)> {
            self.received.recv_timeout(wait).ok()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;
    use tauri::Manager;

    /// Settings' Share usage data, turned off. It writes the same opt-out the environment variable
    /// gives: kept for the next launch, the server started with `COPILOTKIT_TELEMETRY_DISABLED=1`
    /// and no identity, and the desktop's identity and queue gone. And `telemetry link` is never
    /// run again, by any of the app's hooks, against a real (pinned) CLI process.
    #[test]
    fn turning_usage_data_off_writes_the_opt_out_and_prevents_telemetry_link() {
        if crate::test_support::isolated_process(
            "desktop_telemetry::tests::turning_usage_data_off_writes_the_opt_out_and_prevents_telemetry_link",
        ) {
            return;
        }
        std::env::remove_var("COPILOTKIT_TELEMETRY_DISABLED");
        std::env::remove_var("DO_NOT_TRACK");
        let cli = fake_cli::FakeCli::pinned("usage-data-cli", false);
        let settings = temp_root("usage-data-settings");
        let app = tauri::test::mock_builder()
            .manage(DesktopTelemetry::for_tests(
                temp_root("usage-data-telemetry"),
                true,
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let handle = app.handle().clone();
        let state = app.state::<DesktopTelemetry>();
        state.emitter.bind_account(&"a".repeat(64)).unwrap();

        // Sharing: the hooks reach the CLI.
        link_account_background(&handle);
        assert!(
            cli.calls().starts_with("telemetry link --installation-id "),
            "{}",
            cli.calls()
        );
        cli.forget_calls();

        assert_eq!(
            set_usage_data_in(&settings, Some(&state), false),
            Ok(UsageData {
                shared: false,
                off_by_environment: false
            })
        );
        assert!(!usage_data::saved(&settings), "kept for the next launch");
        assert!(!usage_data_now().shared);
        let environment = state.runtime_env.lock().unwrap().clone();
        assert_eq!(
            environment
                .get("COPILOTKIT_TELEMETRY_DISABLED")
                .map(String::as_str),
            Some("1")
        );
        assert!(!environment.contains_key("CPK_TELEMETRY_ID"));
        assert_eq!(state.emitter.install_id(), None);

        // Every hook that links: none reaches the CLI.
        link_account_background(&handle);
        let _ = finish_sign_in(&handle, Ok(local_eval::AccountSignIn { signed_in: true }));
        let _ = finish_account_check(&handle, Ok(local_eval::Terms::NotRequired));
        let _ = finish_account_setup(&handle, Ok(()));
        link_account_after_start(&handle);
        std::thread::sleep(std::time::Duration::from_secs(1));
        assert_eq!(cli.calls(), "", "opted out, yet `telemetry link` ran");

        // On again: a fresh identity, and linking resumes.
        set_usage_data_in(&settings, Some(&state), true).unwrap();
        assert!(usage_data::saved(&settings));
        assert!(state.emitter.install_id().is_some());
        assert_eq!(
            state.runtime_env.lock().unwrap().get("CPK_TELEMETRY_ID"),
            state.emitter.install_id().as_ref()
        );
        link_account_background(&handle);
        assert!(cli.calls().starts_with("telemetry link --installation-id "));
    }

    /// The environment opt-out wins: Settings cannot turn sharing on over it.
    #[test]
    fn settings_cannot_share_over_the_environment_opt_out() {
        if crate::test_support::isolated_process(
            "desktop_telemetry::tests::settings_cannot_share_over_the_environment_opt_out",
        ) {
            return;
        }
        std::env::set_var("DO_NOT_TRACK", "1");
        let settings = temp_root("usage-data-environment");
        assert_eq!(
            usage_data_now(),
            UsageData {
                shared: false,
                off_by_environment: true
            }
        );
        assert!(set_usage_data_in(&settings, None, true).is_err());
        assert!(usage_data::saved(&settings), "nothing was written");
    }

    /// `telemetry link` is a CLI command with its own analytics. Once it confirmed this
    /// installation's account, later hooks in the same launch do not ask again; a new sign-in does.
    #[test]
    fn a_confirmed_link_is_not_asked_again_until_a_new_sign_in() {
        let state = identity_state(true);
        let account = "a".repeat(64);
        state.emitter.bind_account(&account).unwrap();
        let calls = std::cell::Cell::new(0);
        let linked = |_: &local_eval::Installation, _: Option<&str>| {
            calls.set(calls.get() + 1);
            Ok(local_eval::TelemetryIdentity::Linked {
                account_id: "a".repeat(64),
            })
        };
        for _ in 0..5 {
            assert!(link_account_background_with(&state, linked).is_ok());
        }
        assert_eq!(calls.get(), 1);
        // What a successful sign-in does before it links.
        *state.linked.lock().unwrap() = None;
        assert!(link_account_background_with(&state, linked).is_ok());
        assert_eq!(calls.get(), 2);
    }

    fn identity_state(enabled: bool) -> DesktopTelemetry {
        let emitter = telemetry::Telemetry::open_with_env(
            temp_root("account-link"),
            context(),
            telemetry::Config::disabled_for_tests(),
            if enabled {
                telemetry::EnvOverride::Enabled
            } else {
                telemetry::EnvOverride::Disabled
            },
        )
        .unwrap();
        DesktopTelemetry::new(emitter)
    }

    #[test]
    fn successful_sign_in_returns_while_attribution_is_still_blocked() {
        use std::sync::mpsc;
        use std::time::Duration;
        let state = Arc::new(identity_state(true));
        let worker_state = Arc::clone(&state);
        let (entered, waiting) = mpsc::channel();
        let (release, proceed) = mpsc::channel();
        let (finished, completed) = mpsc::channel();
        let account = "a".repeat(64);
        let expected = account.clone();
        let signed = finish_sign_in_with(
            Ok(local_eval::AccountSignIn { signed_in: true }),
            move || {
                entered.send(()).unwrap();
                if proceed.recv_timeout(Duration::from_secs(5)).is_err() {
                    return;
                }
                let result = link_account_with(&worker_state, |_, bound| {
                    Ok(if bound.is_some() {
                        local_eval::TelemetryIdentity::Linked {
                            account_id: account.clone(),
                        }
                    } else {
                        local_eval::TelemetryIdentity::Account {
                            account_id: account.clone(),
                        }
                    })
                });
                finished.send(result).unwrap();
            },
        );
        assert_eq!(signed, Ok(local_eval::AccountSignIn { signed_in: true }));
        let started = waiting.recv_timeout(Duration::from_secs(2));
        release.send(()).ok();
        assert!(
            started.is_ok(),
            "successful sign-in never scheduled attribution"
        );
        assert_eq!(
            completed.recv_timeout(Duration::from_secs(2)).unwrap(),
            Ok(())
        );
        assert_eq!(state.emitter.bound_account(), Some(expected));
    }

    #[test]
    fn unsuccessful_sign_in_preserves_its_result_without_linking() {
        for result in [
            Ok(local_eval::AccountSignIn { signed_in: false }),
            Err(local_eval::Failure::UnexpectedExit),
        ] {
            let expected = result;
            let (sent, received) = std::sync::mpsc::channel();
            assert_eq!(
                finish_sign_in_with(result, move || sent.send(()).unwrap()),
                expected
            );
            assert!(received
                .recv_timeout(std::time::Duration::from_millis(100))
                .is_err());
        }
    }

    #[test]
    fn background_hooks_do_not_queue_behind_an_existing_handshake() {
        let state = identity_state(true);
        let _active = state.identity_link.lock().unwrap();
        for _ in 0..20 {
            assert!(link_account_background_with(&state, |_, _| panic!(
                "duplicate link must not reach the CLI"
            ))
            .is_ok());
        }
    }

    #[test]
    fn account_setup_completion_retries_attribution_even_when_apps_are_unavailable() {
        for result in [
            Ok(()),
            Err(crate::Problem::plain("synthetic unavailable apps")),
        ] {
            let expected_ok = result.is_ok();
            let (sent, received) = std::sync::mpsc::channel();
            let answer = finish_account_setup_with(result, move || sent.send(()).unwrap());
            assert_eq!(answer.is_ok(), expected_ok);
            assert!(
                received
                    .recv_timeout(std::time::Duration::from_secs(2))
                    .is_ok(),
                "the last required CLI call did not retry attribution"
            );
        }
    }

    #[test]
    fn restored_account_links_before_start_but_other_account_checks_do_not() {
        use std::sync::mpsc;
        use std::time::Duration;
        for terms in [
            local_eval::Terms::NotRequired,
            local_eval::Terms::Required {
                accepted: false,
                version: "1".into(),
                url: "https://example.invalid/terms".into(),
                organization_name: "Synthetic".into(),
            },
        ] {
            let (sent, received) = mpsc::channel();
            let expected = terms.clone();
            assert_eq!(
                finish_account_check_with(Ok(terms), move || sent.send(()).unwrap()),
                Ok(expected)
            );
            received.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        for result in [
            Ok(local_eval::Terms::SignedOut),
            Ok(local_eval::Terms::EngineNotReady {
                cause: "docker_unavailable",
            }),
            Ok(local_eval::Terms::Unavailable),
            Err(local_eval::Failure::UnexpectedExit),
        ] {
            let expected = result.clone();
            let (sent, received) = mpsc::channel();
            assert_eq!(
                finish_account_check_with(result, move || sent.send(()).unwrap()),
                expected
            );
            assert!(received.recv_timeout(Duration::from_millis(100)).is_err());
        }
    }

    #[test]
    fn concurrent_links_serialize_aliases_and_rotate_before_the_next_account() {
        use std::sync::mpsc;
        use std::time::Duration;
        let state = Arc::new(identity_state(true));
        let original_id = state.emitter.install_id().unwrap();
        let first_state = Arc::clone(&state);
        let (entered, waiting) = mpsc::channel();
        let (release, proceed) = mpsc::channel();
        let first = std::thread::spawn(move || {
            link_account_with(&first_state, |_, bound| {
                if bound.is_none() {
                    entered.send(()).unwrap();
                    proceed.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(local_eval::TelemetryIdentity::Account {
                        account_id: "a".repeat(64),
                    })
                } else {
                    Ok(local_eval::TelemetryIdentity::Linked {
                        account_id: "a".repeat(64),
                    })
                }
            })
        });
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        let second_state = Arc::clone(&state);
        let (second_entered, second_waiting) = mpsc::channel();
        let second = std::thread::spawn(move || {
            link_account_with(&second_state, |installation, bound| {
                second_entered.send(()).unwrap();
                if bound == Some("b".repeat(64).as_str()) {
                    assert_ne!(installation.as_str(), original_id);
                    Ok(local_eval::TelemetryIdentity::Linked {
                        account_id: "b".repeat(64),
                    })
                } else {
                    assert_eq!(bound, Some("a".repeat(64).as_str()));
                    Ok(local_eval::TelemetryIdentity::Account {
                        account_id: "b".repeat(64),
                    })
                }
            })
        });
        let interleaved = second_waiting
            .recv_timeout(Duration::from_millis(100))
            .is_ok();
        release.send(()).unwrap();
        assert_eq!(first.join().unwrap(), Ok(()));
        assert_eq!(second.join().unwrap(), Ok(()));
        assert!(
            !interleaved,
            "another handshake entered before the first alias completed"
        );
        assert_eq!(state.emitter.bound_account(), Some("b".repeat(64)));
        assert_eq!(
            state.runtime_env.lock().unwrap().get("CPK_TELEMETRY_ID"),
            state.emitter.install_id().as_ref()
        );
    }

    #[test]
    fn account_link_saves_binding_before_alias_and_retries_after_failure() {
        let state = identity_state(true);
        let id = state.emitter.install_id().unwrap();
        let account = "a".repeat(64);
        let mut calls = 0;
        assert!(link_account_with(&state, |installation, bound| {
            calls += 1;
            assert_eq!(installation.as_str(), id);
            if calls == 1 {
                assert_eq!(bound, None);
                Ok(local_eval::TelemetryIdentity::Account {
                    account_id: account.clone(),
                })
            } else {
                assert_eq!(bound, Some(account.as_str()));
                assert_eq!(
                    state.emitter.snapshot().unwrap().account_id.as_deref(),
                    bound
                );
                Err(local_eval::Failure::UnexpectedExit)
            }
        })
        .is_err());
        assert_eq!(calls, 2);
        assert!(link_account_with(&state, |installation, bound| {
            assert_eq!(installation.as_str(), id);
            assert_eq!(bound, Some(account.as_str()));
            Ok(local_eval::TelemetryIdentity::Linked {
                account_id: account.clone(),
            })
        })
        .is_ok());
    }

    #[test]
    fn account_change_rotates_before_linking_and_updates_runtime_environment() {
        let state = identity_state(true);
        state.emitter.bind_account(&"a".repeat(64)).unwrap();
        let old = state.emitter.install_id().unwrap();
        let account = "b".repeat(64);
        let mut calls = 0;
        assert!(link_account_with(&state, |installation, bound| {
            calls += 1;
            if calls == 1 {
                assert_eq!(installation.as_str(), old);
                Ok(local_eval::TelemetryIdentity::Account {
                    account_id: account.clone(),
                })
            } else {
                assert_ne!(installation.as_str(), old);
                assert_eq!(bound, Some(account.as_str()));
                assert_eq!(
                    state
                        .runtime_env
                        .lock()
                        .unwrap()
                        .get("CPK_TELEMETRY_ID")
                        .map(String::as_str),
                    Some(installation.as_str())
                );
                Ok(local_eval::TelemetryIdentity::Linked {
                    account_id: account.clone(),
                })
            }
        })
        .is_ok());
        assert_eq!(calls, 2);
    }

    #[test]
    fn signed_out_receipt_clears_binding_and_updates_runtime_environment() {
        let state = identity_state(true);
        state.emitter.bind_account(&"a".repeat(64)).unwrap();
        let old = state.emitter.install_id();
        assert!(link_account_with(&state, |_, _| {
            local_eval::normalize_telemetry_identity(0, br#"{"type":"signed_out"}"#)
        })
        .is_ok());
        assert_eq!(state.emitter.bound_account(), None);
        assert_ne!(state.emitter.install_id(), old);
        assert_eq!(
            state.runtime_env.lock().unwrap().get("CPK_TELEMETRY_ID"),
            state.emitter.install_id().as_ref()
        );
    }

    #[test]
    fn disabled_telemetry_never_calls_the_account_linker() {
        let state = identity_state(false);
        assert!(link_account_with(&state, |_, _| panic!(
            "opted-out desktop must not call the CLI"
        ))
        .is_ok());
    }

    #[test]
    fn account_link_refuses_an_unexpected_alias_receipt_and_bounds_account_changes() {
        let state = identity_state(true);
        assert!(
            link_account_with(&state, |_, _| Ok(local_eval::TelemetryIdentity::Linked {
                account_id: "a".repeat(64)
            }))
            .is_err()
        );
        let mut calls = 0;
        assert!(link_account_with(&state, |_, _| {
            calls += 1;
            Ok(local_eval::TelemetryIdentity::Account {
                account_id: if calls == 1 {
                    "a".repeat(64)
                } else {
                    "b".repeat(64)
                },
            })
        })
        .is_err());
        assert_eq!(calls, 2);
    }

    /// Every 1.0 release candidate said `1.0.0`: the version was cut at its first `-`. The whole
    /// version is sent now, a release candidate's label included, and anything after a `-` that is
    /// not a closed label is still cut off, so no text can ride along in it.
    #[test]
    fn the_app_version_keeps_its_release_candidate_label() {
        let version = |package: &str| super::context(package).unwrap().app_version.to_string();
        assert_eq!(version("1.0.0-rc.5"), "1.0.0-rc.5");
        assert_eq!(version("1.0.0"), "1.0.0");
        assert_eq!(version("0.3.4-beta"), "0.3.4-beta");
        assert_eq!(version("1.2.3-private-name"), "1.2.3");
        assert_eq!(version("1.2.3-rc.1.2"), "1.2.3");
        assert_eq!(version("1.2.3+build.7"), "1.2.3");
        let emitter = telemetry::Telemetry::open_with_env(
            temp_root("app-version"),
            super::context("1.0.0-rc.5").unwrap(),
            telemetry::Config::disabled_for_tests(),
            telemetry::EnvOverride::Enabled,
        )
        .unwrap();
        assert_eq!(
            emitter
                .runtime_env()
                .get("OPENBOT_VERSION")
                .map(String::as_str),
            Some("1.0.0-rc.5")
        );
        let pattern = regex::Regex::new(telemetry::APP_VERSION_PATTERN).unwrap();
        for sent in ["1.0.0-rc.5", "1.0.0", "0.3.4-beta", "1.2.3"] {
            assert!(pattern.is_match(sent), "{sent}");
        }
        for refused in [
            "1.2-private-name",
            "1.0.0-rc.x",
            "/Users/someone",
            "1.0.0-rc.5\n",
        ] {
            assert!(!pattern.is_match(refused), "{refused}");
            assert!(telemetry::AppVersion::parse(refused).is_err(), "{refused}");
        }
    }

    /// The classes a failure's words map to, on what engines, registries and the system say. A
    /// row whose step says nothing (deployment, services, answering, cleanup) gets the words'
    /// class rather than `unknown`; a permission or a full disk wins over any step's class.
    #[test]
    fn a_failure_is_classed_by_its_step_and_then_its_words() {
        use telemetry::{FailingStep as S, SetupErrorClass as C};
        for (text, class) in [
            ("Error response from daemon: pull access denied for openbot-agent-langgraph-agui, repository does not exist or may require 'docker login'", Some(C::ImagePullFailed)),
            ("Error response from daemon: manifest for ghcr.io/copilotkit/openbot-server:1.0.0 not found: manifest unknown", Some(C::ImagePullFailed)),
            ("toomanyrequests: You have reached your pull rate limit.", Some(C::ImagePullFailed)),
            ("Get \"https://registry-1.docker.io/v2/\": dial tcp: lookup registry-1.docker.io: no such host", Some(C::NetworkUnavailable)),
            ("net/http: TLS handshake timeout", Some(C::NetworkUnavailable)),
            ("permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock", Some(C::PermissionDenied)),
            ("Access is denied.", Some(C::PermissionDenied)),
            ("failed to register layer: write /usr/lib/x: no space left on device", Some(C::InsufficientResources)),
            ("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?", Some(C::EngineUnavailable)),
            ("Part of OpenBot stopped during startup.", None),
        ] {
            assert_eq!(class_of_text(text), class, "{text}");
        }
        assert_eq!(
            class_of_row(S::Services, "Part of OpenBot stopped during startup."),
            C::Unknown
        );
        assert_eq!(
            class_of_row(S::Deployment, "dial tcp: lookup github.com: no such host"),
            C::NetworkUnavailable
        );
        assert_eq!(
            class_of_row(S::InstallEngine, "The installer failed."),
            C::EngineInstallFailed
        );
        assert_eq!(
            class_of_row(S::InstallEngine, "permission denied"),
            C::PermissionDenied
        );
        assert_eq!(
            class_of_row(S::Engine, "dial tcp: i/o timeout"),
            C::EngineUnavailable
        );
        assert_eq!(class_of_row(S::Images, "something"), C::ImagePullFailed);
    }

    /// What the CLI answers maps to a failure only when it stops setup: the agreement, a sign-in
    /// and a cancel are the person's next step or choice. A resource the CLI found short carries
    /// what it measured against what setup needs.
    #[test]
    fn cli_answers_are_failures_only_when_they_stop_setup() {
        use telemetry::{FailingStep as S, SetupErrorClass as C};
        let report = |outcome, reason, shortfall| {
            Ok(local_eval::Report {
                outcome,
                stack: None,
                reason,
                readiness: local_eval::Readiness::Unknown,
                licence: local_eval::Licence::Unknown,
                licence_expires_at: None,
                update_to: None,
                checks_passed: false,
                shortfall,
            })
        };
        for normal in [
            local_eval::Reason::AuthenticationRequired,
            local_eval::Reason::EulaAcceptanceRequired,
        ] {
            assert_eq!(
                report_failure(
                    S::LocalSetup,
                    &report(local_eval::Outcome::Blocked, Some(normal), None)
                ),
                None
            );
        }
        assert_eq!(
            report_failure(
                S::LocalSetup,
                &report(local_eval::Outcome::Completed, None, None)
            ),
            None
        );
        assert_eq!(
            report_failure(S::LocalSetup, &Err(local_eval::Failure::Cancelled)),
            None
        );
        assert_eq!(
            report_failure(S::LocalStart, &Err(local_eval::Failure::DownloadStalled)),
            Some(SetupFailure {
                cli_failure: Some(telemetry::CliFailure::DownloadStalled),
                ..SetupFailure::new(S::LocalStart, C::NetworkUnavailable)
            })
        );
        let short = local_eval::Shortfall {
            disk: true,
            cpus: Some("9.8".into()),
            memory_gb: Some("18.9".into()),
            disk_gb: Some("0".into()),
            ..local_eval::Shortfall::default()
        };
        let failed = report_failure(
            S::LocalSetup,
            &report(
                local_eval::Outcome::Failed,
                Some(local_eval::Reason::ResourcesShort),
                Some(short),
            ),
        )
        .unwrap();
        assert_eq!(failed.error_class, C::InsufficientResources);
        assert_eq!(
            failed.cli_reason,
            Some(telemetry::CliReason::ResourcesShort)
        );
        assert_eq!(
            failed.resources,
            Some(telemetry::Resources {
                cpu_short: false,
                memory_short: false,
                disk_short: true,
                disk_nearly_full: false,
                cpu_needed_millis: 4000,
                cpu_available_millis: Some(9800),
                memory_needed_mib: 4096,
                memory_available_mib: Some(19353),
                disk_needed_mib: 40960,
                disk_available_mib: Some(0),
            })
        );
        // #1358's screen for an engine local setup does not run on, such as OrbStack.
        assert_eq!(
            terms_failure(&Ok(local_eval::Terms::Blocked {
                reason: local_eval::Reason::UnsupportedEngine,
                said: Some("OrbStack is not supported".into()),
                switch_engine: true,
            })),
            Some(SetupFailure {
                cli_reason: Some(telemetry::CliReason::UnsupportedEngine),
                ..SetupFailure::new(S::AccountCheck, C::UnsupportedEngine)
            })
        );
        assert_eq!(
            terms_failure(&Ok(local_eval::Terms::EngineNotReady {
                cause: "docker_unavailable"
            })),
            None
        );
    }

    /// The Account step's check, asked every few seconds: an engine too small is one
    /// `setup_failed` with what was measured against what setup needs, for as long as the answer
    /// stays the same; an account found signed in is one `restored` sign-in, and none after a
    /// sign-in this launch completed.
    #[test]
    fn the_account_check_says_a_refusal_once_and_a_restored_account_once() {
        if crate::test_support::isolated_process(
            "desktop_telemetry::tests::the_account_check_says_a_refusal_once_and_a_restored_account_once",
        ) {
            return;
        }
        std::env::remove_var("COPILOTKIT_TELEMETRY_DISABLED");
        std::env::remove_var("DO_NOT_TRACK");
        // The links a sign-in and an account check start reach this CLI, never a real one.
        let _cli = fake_cli::FakeCli::pinned("account-check-cli", false);
        let app = tauri::test::mock_builder()
            .manage(DesktopTelemetry::for_tests(
                temp_root("account-check"),
                true,
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let handle = app.handle().clone();
        let small = || {
            Ok(local_eval::Terms::EngineTooSmall {
                podman: true,
                cpu: false,
                memory: true,
                disk: false,
                wsl: false,
                drive: None,
                measured: local_eval::EngineMeasure {
                    cpus: 4,
                    memory_bytes: 2 * 1024 * 1024 * 1024,
                    free_disk_bytes: Some(100 * 1024 * 1024 * 1024),
                },
            })
        };
        for _ in 0..3 {
            let _ = finish_account_check(&handle, small());
        }
        let required = || {
            Ok(local_eval::Terms::Required {
                accepted: false,
                version: "1".into(),
                url: "https://example.invalid/terms".into(),
                organization_name: "Synthetic".into(),
            })
        };
        for _ in 0..3 {
            let _ = finish_account_check(&handle, required());
        }
        let queued = app.state::<DesktopTelemetry>().queued();
        assert_eq!(
            queued,
            vec![
                telemetry::EventData::SetupFailed {
                    step: telemetry::Step::Install,
                    error_class: telemetry::SetupErrorClass::InsufficientResources,
                    failing_step: Some(telemetry::FailingStep::AccountCheck),
                    cli_reason: None,
                    cli_failure: None,
                    resources: Some(telemetry::Resources {
                        cpu_short: false,
                        memory_short: true,
                        disk_short: false,
                        disk_nearly_full: false,
                        cpu_needed_millis: 4000,
                        cpu_available_millis: Some(4000),
                        memory_needed_mib: 4096,
                        memory_available_mib: Some(2048),
                        disk_needed_mib: 40960,
                        disk_available_mib: Some(102400),
                    }),
                },
                telemetry::EventData::SignIn {
                    outcome: telemetry::SignInOutcome::Restored,
                    duration_ms: None,
                    cli_failure: None,
                },
            ]
        );
        // A completed sign-in this launch: the check after it is not a restored account.
        let fresh = tauri::test::mock_builder()
            .manage(DesktopTelemetry::for_tests(
                temp_root("account-check-fresh"),
                true,
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let _ = finish_sign_in(
            fresh.handle(),
            Ok(local_eval::AccountSignIn { signed_in: true }),
        );
        let _ = finish_account_check(fresh.handle(), required());
        assert_eq!(fresh.state::<DesktopTelemetry>().queued(), vec![]);
        // Opted out: nothing at all.
        let off = tauri::test::mock_builder()
            .manage(DesktopTelemetry::for_tests(
                temp_root("account-check-off"),
                false,
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let _ = finish_account_check(off.handle(), small());
        let _ = finish_account_check(off.handle(), required());
        assert!(off.state::<DesktopTelemetry>().emitter.snapshot().is_err());
    }

    pub(super) fn context() -> telemetry::Context {
        telemetry::Context {
            distribution: telemetry::Distribution::Desktop,
            app_version: telemetry::AppVersion::parse("1.2.3").unwrap(),
            platform: telemetry::Platform::Macos,
            arch: telemetry::Architecture::Aarch64,
            os_version: None,
            engine: telemetry::Engine::None,
            runtime_env: telemetry::RuntimeEnv::Test,
        }
    }

    struct Fixture {
        app: tauri::App<tauri::test::MockRuntime>,
        window: tauri::WebviewWindow<tauri::test::MockRuntime>,
    }

    impl Fixture {
        fn new() -> Self {
            let data_dir = temp_root("desktop-telemetry-ipc");
            let emitter = telemetry::Telemetry::open_with_env(
                data_dir,
                context(),
                telemetry::Config {
                    enabled: true,
                    endpoint: None,
                    max_queue: 256,
                },
                telemetry::EnvOverride::Enabled,
            )
            .unwrap();
            let app = tauri::test::mock_builder()
                .manage(DesktopTelemetry::new(emitter))
                .invoke_handler(tauri::generate_handler![crate::record_setup_event])
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap();
            Self { app, window }
        }

        fn invoke(&self, event: serde_json::Value) {
            let _ = tauri::test::get_ipc_response(
                &self.window,
                tauri::webview::InvokeRequest {
                    cmd: "record_setup_event".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: if cfg!(any(windows, target_os = "android")) {
                        "http://tauri.localhost"
                    } else {
                        "tauri://localhost"
                    }
                    .parse()
                    .unwrap(),
                    body: tauri::ipc::InvokeBody::Json(serde_json::json!({ "event": event })),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            );
        }

        fn queued(&self) -> Vec<telemetry::EventData> {
            self.app
                .state::<DesktopTelemetry>()
                .emitter
                .snapshot()
                .unwrap()
                .queue
                .into_iter()
                .map(|event| event.data)
                .collect()
        }
    }

    #[test]
    fn model_telemetry_ipc_accepts_provider_categories_without_private_properties() {
        let fixture = Fixture::new();
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
            let event = serde_json::json!({
                "kind": "model_chosen",
                "provider": provider,
                "credential_path": credential_path,
                "custom_base_url": provider == "compatible"
            });
            let queued_before = fixture.queued().len();
            fixture.invoke(event.clone());
            let queued = fixture.queued();
            assert_eq!(queued.len(), queued_before + 1);
            assert_eq!(serde_json::to_value(queued.last().unwrap()).unwrap(), event);

            for property in ["apiKey", "token", "model", "baseUrl", "containerBaseUrl"] {
                let mut private_event = event.clone();
                private_event[property] = serde_json::json!("synthetic-private-value");
                fixture.invoke(private_event);
            }
            for property in ["provider", "credential_path"] {
                let mut unknown_event = event.clone();
                unknown_event[property] = serde_json::json!("private-category");
                fixture.invoke(unknown_event);
            }
            assert_eq!(fixture.queued(), queued);
        }
    }

    #[test]
    fn setup_telemetry_ipc_accepts_only_frontend_setup_events() {
        let fixture = Fixture::new();

        fixture.invoke(serde_json::json!({
            "kind": "step_viewed",
            "step": "harness"
        }));
        fixture.invoke(serde_json::json!({
            "kind": "harness_chosen",
            "harness": "byo_url"
        }));
        assert_eq!(fixture.queued().len(), 2);

        fixture.invoke(serde_json::json!({
            "kind": "harness_chosen",
            "harness": "byo_url",
            "url": "https://example.invalid"
        }));
        fixture.invoke(serde_json::json!({
            "kind": "step_viewed",
            "step": "credentials"
        }));
        fixture.invoke(serde_json::json!({
            "kind": "activated"
        }));
        // The desktop sends these itself, from where it sees the failure or the sign-in; the
        // window cannot send them, with or without the new fields.
        fixture.invoke(serde_json::json!({
            "kind": "setup_failed",
            "step": "account",
            "error_class": "unknown"
        }));
        fixture.invoke(serde_json::json!({
            "kind": "setup_failed",
            "step": "account",
            "error_class": "unknown",
            "failing_step": "local_setup",
            "detail": "/Users/someone/OpenBot: no space left on device"
        }));
        fixture.invoke(serde_json::json!({
            "kind": "sign_in",
            "outcome": "completed"
        }));
        fixture.invoke(serde_json::json!({
            "kind": "sign_in",
            "outcome": "completed",
            "email": "someone@example.invalid"
        }));

        let queued = fixture.queued();
        assert_eq!(queued.len(), 2);
        assert!(matches!(
            queued[0],
            telemetry::EventData::StepViewed {
                step: telemetry::Step::Harness
            }
        ));
        assert!(matches!(
            queued[1],
            telemetry::EventData::HarnessChosen {
                harness: telemetry::Harness::ByoUrl
            }
        ));
    }
}
