//! Tauri integration for the setup emitter. Network work stays off the event loop.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use openbot_desktop_lib::{engine, local_eval, quiet, telemetry};
use tauri::Manager;

pub struct DesktopTelemetry {
    emitter: Arc<telemetry::Telemetry>,
    runtime_env: Mutex<BTreeMap<String, String>>,
    identity_link: Mutex<()>,
}

pub fn initialize<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let initialized = (|| {
        let context = context(&app.package_info().version.to_string())?;
        let emitter = telemetry::Telemetry::open(
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
        )
        .ok()?;
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
        if emitter.install_id().is_none() {
            runtime_env.insert("COPILOTKIT_TELEMETRY_DISABLED".into(), "1".into());
        }
        app.manage(DesktopTelemetry {
            emitter,
            runtime_env: Mutex::new(runtime_env),
            identity_link: Mutex::new(()),
        });
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

/// Run on a worker alongside startup preparation, before the runtime reads its identity.
/// Alias failures never prevent opening OpenBot; the next launch retries the same binding.
pub fn link_account<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(state) = app.try_state::<DesktopTelemetry>() else {
        return;
    };
    let Ok(_link) = state.identity_link.lock() else {
        return;
    };
    if link_account_with(&state, local_eval::link_telemetry_installed).is_err() {
        eprintln!("[telemetry] account link deferred until the next launch");
    }
}

/// Keep the binding durable before invoking the CLI's permanent alias operation.
fn link_account_with(
    state: &DesktopTelemetry,
    mut link: impl FnMut(
        &local_eval::Installation,
        Option<&str>,
    ) -> Result<local_eval::TelemetryIdentity, local_eval::Failure>,
) -> Result<(), ()> {
    for _ in 0..2 {
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
                return Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;
    use tauri::Manager;

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
        DesktopTelemetry {
            runtime_env: Mutex::new(emitter.runtime_env()),
            emitter,
            identity_link: Mutex::new(()),
        }
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

    fn context() -> telemetry::Context {
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
                .manage(DesktopTelemetry {
                    emitter,
                    runtime_env: Mutex::new(BTreeMap::new()),
                    identity_link: Mutex::new(()),
                })
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
