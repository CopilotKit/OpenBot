//! Tauri integration for the setup emitter. Network work stays off the event loop.
use std::collections::BTreeMap;
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
}

impl DesktopTelemetry {
    fn new(emitter: Arc<telemetry::Telemetry>) -> Self {
        Self {
            runtime_env: Mutex::new(fresh_runtime_env(&emitter)),
            emitter,
            identity_link: Mutex::new(()),
            linked: Mutex::new(None),
        }
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
    use telemetry::{Architecture, Distribution, Engine, NumericVersion, Platform, RuntimeEnv};
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
        app_version: NumericVersion::parse(version.split('-').next()?).ok()?,
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

fn set_usage_data_in(
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
    let app = app.clone();
    finish_account_check_with(result, move || link_account_background(&app))
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

pub fn failure<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    error_class: telemetry::SetupErrorClass,
) {
    let Some(state) = app.try_state::<DesktopTelemetry>() else {
        return;
    };
    let step = state
        .emitter
        .snapshot()
        .ok()
        .and_then(|state| state.last_step)
        .unwrap_or(telemetry::Step::Install);
    record(app, telemetry::EventData::SetupFailed { step, error_class });
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
/// to answer than the handshake's eight-second budget. Only for a test in its own process.
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

        /// Every call so far, one line each, arguments space-separated.
        pub(crate) fn calls(&self) -> String {
            std::fs::read_to_string(self.dir.join("calls")).unwrap_or_default()
        }

        pub(crate) fn forget_calls(&self) {
            let _ = std::fs::remove_file(self.dir.join("calls"));
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
            Ok(local_eval::Terms::EngineNotReady),
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

    pub(super) fn context() -> telemetry::Context {
        telemetry::Context {
            distribution: telemetry::Distribution::Desktop,
            app_version: telemetry::NumericVersion::parse("1.2.3").unwrap(),
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
