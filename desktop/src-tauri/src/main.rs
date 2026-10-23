// A window, not a console. Release builds on Windows must not open one behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

mod desktop_connection;
mod desktop_host_access;
mod desktop_page;
mod desktop_status;
mod desktop_telemetry;
mod intelligence_bridge;

#[cfg(test)]
mod test_support;

use openbot_desktop_lib::{
    acquire, deployment, deployment_release, engine, env as openbot_env, harness, host_access,
    install, local_eval, local_eval_state, preparation, problem::Problem, provider, pull_metrics,
    quiet, stack, supervise, telemetry, tray, windows as win,
};

const QUIT_CLEANUP_NOTICE_FILE: &str = ".openbot-quit-cleanup-notice";
/// Kept apart from the quit cleanup notice, whose presence alone means OpenBot needs recovery.
const LOCAL_EVAL_STOP_NOTICE_FILE: &str = ".openbot-local-eval-stop-notice";
/// How an Intelligence failure starts, so Stop and Quit can tell it from OpenBot's own.
const INTELLIGENCE_STOP_FAILED: &str = "Intelligence stop failed: ";
const QUIT_MENU_ACCELERATOR: &str = "CmdOrCtrl+KeyQ";
const QUIT_CLEANUP_NOTICE_LIMIT: usize = 16 * 1024;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// What the shell is running, so the window and the tray say the same thing.
#[derive(Default)]
struct Shell {
    /// Session-only local folder authority; shutdown retires it before stopping the API server.
    host_access: Mutex<Option<host_access::HostAccess>>,
    /// Named, because a restart policy that cannot say which process died cannot start it again.
    children: Mutex<Vec<(&'static str, std::process::Child)>>,
    /// Native Linux engine API owned by this desktop session, kept through Stop/Start.
    #[cfg(target_os = "linux")]
    podman_api: Mutex<engine::local_api::Service>,
    /// Which run is the current one.
    ///
    /// Stopping and starting again inside two seconds would otherwise leave the previous watcher
    /// alive beside the new one, both answering the same death, and a process restarted twice is
    /// one process and one orphan holding a port.
    generation: std::sync::atomic::AtomicU64,
    /// Cancellation of pending Start is independent of the hosts still serving the previous run.
    start_generation: std::sync::atomic::AtomicU64,
    /// Stop serializes with synchronous startup side effects, never with an async wait.
    startup: Mutex<()>,
    /// A cancelled attempt must finish returning its unpublished children before another starts.
    starting: std::sync::atomic::AtomicBool,
    /// An explicit Stop must survive setup navigation; a new app session may resume again.
    stopped_in_session: std::sync::atomic::AtomicBool,
    /// Quit keeps the event loop alive until one background cleanup attempt finishes.
    quit: std::sync::Arc<QuitState>,
    /// Why the stack stopped, kept for the screen that has not loaded yet.
    ///
    /// Going back to the setup screen is a navigation, and a navigation is a fresh page: React
    /// remounts with no progress and the sentence explaining what happened is lost at the one
    /// moment it is worth reading. Held here instead, and asked for on load.
    last_failure: Mutex<Option<openbot_desktop_lib::problem::Problem>>,
    /// Reading the notification must not make a partially running deployment adoptable again.
    recovery_required: Mutex<Option<RecoveryRequired>>,
    /// An explicit reset remains bound to the engine that found the leftover database.
    leftover_database: Mutex<Option<LeftoverDatabase>>,
    selected_root: Mutex<Option<PathBuf>>,
    root: Mutex<Option<PathBuf>>,
    /// Containers may outlive a failed Start before any host root is published.
    containers: Mutex<Option<ContainerDeployment>>,
    /// A verified down allows a following Stop/Quit to be an idempotent no-op.
    stopped_container_root: Mutex<Option<PathBuf>>,
    /// An Intelligence sign-in waiting for its loopback callback.
    signing_in_to_intelligence:
        Mutex<Option<openbot_desktop_lib::intelligence::SigningInToIntelligence>>,
    /// The credential that sign-in produced, held so a project can be chosen with it.
    intelligence_credential: Mutex<Option<String>>,
    /// Proof that this runtime key's project has the default Learning container.
    intelligence_learning: Mutex<Option<openbot_desktop_lib::intelligence::ProvisionedConnection>>,
    self_hosted_intelligence:
        Mutex<Option<std::sync::Arc<openbot_desktop_lib::self_hosted_intelligence::SigningIn>>>,
    self_hosted_sign_in_generation: std::sync::atomic::AtomicU64,
    /// A ChatGPT sign-in waiting for the browser redirect to complete it.
    ///
    /// Held for the same reason the Claude one is: a person leaves and comes back in the middle.
    /// Unlike that one, nothing is typed here — the callback finishes it.
    signing_in_to_chatgpt: Mutex<Option<openbot_desktop_lib::plan::SigningInToChatGpt>>,
    /// A plan sign-in waiting for the code from the browser.
    ///
    /// Held across two commands because a person has to leave and approve in the middle of it, and
    /// the flow that showed the URL is the only one that can redeem the code: each start mints its
    /// own PKCE challenge and state, so a second start invalidates the first.
    signing_in: Mutex<Option<openbot_desktop_lib::plan::SigningIn>>,
    /// The configured setup destination, resolved using Tauri's build mode and platform.
    /// WebView2's current URL can still be about:blank during startup; it is never a setup source.
    setup_url: Mutex<Option<String>>,
    /// The installation whose Intelligence dashboard the menus open, while the window is in local
    /// mode with a recorded stack. None hides the item.
    intelligence_menu: Mutex<Option<PathBuf>>,
    /// The menu's "Open Intelligence dashboard" is running; its item is disabled until it ends.
    intelligence_opening: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Dashboard addresses and this session's sign-ins, so a later opening needs no CLI call.
    dashboards: Dashboards,
    /// The OpenBot app page's sidebar row, and the app origins allowed to reach it.
    intelligence_bridge: intelligence_bridge::Bridge,
}

/// The deployment whose Compose up may have created containers, including a partial failure.
/// Independent of the editable selection and host ownership. Change this ownership while
/// holding `Shell::startup`; capture before up and release only after its down succeeds. Keeping
/// it in one record lets shutdown carry further deployment identity without changing host state.
struct ContainerDeployment {
    root: PathBuf,
    address: engine::Address,
}

struct LeftoverDatabase {
    root: PathBuf,
    volume: String,
    address: engine::Address,
}

struct RecoveryRequired {
    root: PathBuf,
    generation: u64,
    connection: Option<openbot_desktop_lib::problem::Connection>,
}

/// Callers serialize eligibility and any navigation with `startup`. A failed Start may advance
/// the host generation while reclaiming survivors; that does not resolve their recovery state.
fn recovery_required(shell: &Shell, root: &Path) -> bool {
    shell
        .recovery_required
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|recovery| {
            recovery.root == root
                && recovery.generation <= shell.generation.load(std::sync::atomic::Ordering::SeqCst)
        })
}

/// Called under `startup` after validating the affected run. Does not retire survivor watchers.
fn mark_recovery_required(shell: &Shell, root: &Path, generation: u64) {
    *shell.recovery_required.lock().unwrap() = Some(RecoveryRequired {
        root: root.to_path_buf(),
        generation,
        connection: None,
    });
}

/// Only completed recovery or deliberate shutdown resolves the condition, never reading a notice.
fn clear_recovery_required(shell: &Shell, root: &Path) {
    let mut recovery = shell.recovery_required.lock().unwrap();
    if recovery
        .as_ref()
        .is_some_and(|recovery| recovery.root == root)
    {
        *recovery = None;
        *shell.last_failure.lock().unwrap() = None;
    }
}

/// One ticket spans the whole initial Start, including deployment and dependency preparation.
/// Stop invalidates it before waiting for synchronous work. A late readiness result cannot mint
/// a replacement ticket or publish itself as a new run.
struct StartAttempt<'a> {
    shell: &'a Shell,
    generation: u64,
}

impl<'a> StartAttempt<'a> {
    fn begin(shell: &'a Shell) -> Result<Self, Problem> {
        use std::sync::atomic::Ordering::SeqCst;
        shell.starting.compare_exchange(false, true, SeqCst, SeqCst).map_err(|_| {
            Problem::plain("OpenBot is already starting or finishing a cancelled startup. Wait for it to finish, then try again.")
        })?;
        Ok(Self {
            shell,
            generation: shell.start_generation.fetch_add(1, SeqCst) + 1,
        })
    }

    fn require_current(&self) -> Result<(), Problem> {
        if self
            .shell
            .start_generation
            .load(std::sync::atomic::Ordering::SeqCst)
            == self.generation
        {
            Ok(())
        } else {
            Err(Self::cancelled())
        }
    }

    fn lock_current(&self) -> Result<std::sync::MutexGuard<'_, ()>, Problem> {
        let guard = self.shell.startup.lock().unwrap();
        self.require_current()?;
        Ok(guard)
    }

    fn cancelled() -> Problem {
        Problem::plain("OpenBot startup was cancelled by Stop. Start again when you are ready.")
    }
}

impl Drop for StartAttempt<'_> {
    fn drop(&mut self) {
        self.shell
            .starting
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
struct Progress {
    step: String,
    ok: bool,
    detail: String,
    running: bool,
    #[serde(rename = "downloadBytes", skip_serializing_if = "Option::is_none")]
    download_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedModelApiKeys {
    openai: Option<bool>,
    anthropic: Option<bool>,
    compatible: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedModelSessions {
    openai: Option<bool>,
    anthropic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    google: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    xai: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedConfiguration {
    intelligence_api_key: Option<bool>,
    model_api_keys: SavedModelApiKeys,
    model_sessions: SavedModelSessions,
    model: Option<openbot_desktop_lib::saved_intent::ModelIntent>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlreadyConfigured {
    values: std::collections::BTreeMap<String, String>,
    saved: SavedConfiguration,
    #[serde(skip_serializing_if = "Option::is_none")]
    launch: Option<preparation::Launch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    installation: Option<preparation::Launch>,
    auto_start: bool,
    /// Where the local evaluation has got to, if one was ever begun here. The checkpoint only:
    /// whether its stack is running is the CLI's to say.
    #[serde(skip_serializing_if = "Option::is_none")]
    local_eval: Option<local_eval_state::State>,
}

struct ReadyRespondingEngine {
    address: engine::Address,
    detail: String,
    installed: Option<String>,
}

/// Return a responding engine only after Compose is present too.
fn ready_responding_engine_after_compose_repair(
    found: engine::EngineStatus,
    install_missing_native: bool,
    mut install_engine: impl FnMut() -> Result<String, Problem>,
    mut detect: impl FnMut() -> engine::EngineStatus,
    mut composes: impl FnMut(&engine::Address) -> bool,
) -> Result<Option<ReadyRespondingEngine>, Problem> {
    if let Some(address) = found.address.clone().filter(|_| found.responding) {
        if composes(&address) {
            return Ok(Some(ReadyRespondingEngine {
                address,
                detail: found.detail,
                installed: None,
            }));
        }
    } else if !install_missing_native {
        return Ok(None);
    }

    let installed = install_engine()?;
    let ready = detect();
    let Some(address) = ready.address.clone().filter(|_| ready.responding) else {
        return Err(Problem::with(
            if install_missing_native {
                "OpenBot installed the container software, but the engine is not answering. Try again."
            } else {
                "OpenBot installed Compose, but the container engine is not answering. Try again."
            },
            ready.detail,
        ));
    };
    if !composes(&address) {
        return Err(Problem::plain(acquire::missing_compose(
            address.engine.binary(),
        )));
    }
    Ok(Some(ReadyRespondingEngine {
        address,
        detail: ready.detail,
        installed: Some(installed),
    }))
}

fn report<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    step: &str,
    ok: bool,
    detail: impl Into<String>,
) {
    if !ok {
        let error_class = match step {
            "install-engine" => telemetry::SetupErrorClass::EngineInstallFailed,
            "engine" | "create-machine" | "start-machine" | "health-gate" => {
                telemetry::SetupErrorClass::EngineUnavailable
            }
            "env" | "ports" => telemetry::SetupErrorClass::InvalidConfiguration,
            _ => telemetry::SetupErrorClass::Unknown,
        };
        desktop_telemetry::failure(app, error_class);
    }
    let _ = app.emit(
        "setup:progress",
        Progress {
            step: step.into(),
            ok,
            detail: detail.into(),
            running: false,
            download_bytes: None,
        },
    );
}

fn report_running<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    step: &str,
    detail: impl Into<String>,
    download_bytes: Option<u64>,
) {
    let _ = app.emit(
        "setup:progress",
        Progress {
            step: step.into(),
            ok: true,
            detail: detail.into(),
            running: true,
            download_bytes,
        },
    );
}

fn cancel_self_hosted_sign_in(shell: &Shell) {
    shell
        .self_hosted_sign_in_generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let signing = shell.self_hosted_intelligence.lock().unwrap().take();
    if let Some(signing) = signing {
        signing.cancel();
    }
}

fn remember_selected_root(shell: &Shell, root: &Path) {
    let changed = shell.selected_root.lock().unwrap().as_deref() != Some(root);
    if changed {
        cancel_self_hosted_sign_in(shell);
    }
    *shell.selected_root.lock().unwrap() = Some(root.to_path_buf());
}

fn cleanup_root(shell: &Shell, fallback_root: &Path) -> PathBuf {
    shell
        .root
        .lock()
        .unwrap()
        .clone()
        .or_else(|| {
            shell
                .containers
                .lock()
                .unwrap()
                .as_ref()
                .map(|owned| owned.root.clone())
        })
        .or_else(|| shell.selected_root.lock().unwrap().clone())
        .unwrap_or_else(|| fallback_root.to_path_buf())
}

#[tauri::command]
fn detect_engine<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> engine::EngineStatus {
    let status = engine::detect();
    desktop_telemetry::observe_engine(&app, &status);
    status
}

#[tauri::command]
fn windows_blocker<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<win::Blocker>, Problem> {
    let result = win::blocker();
    if cfg!(target_os = "windows") {
        use telemetry::WindowsStageOutcome as Outcome;
        let outcome = match &result {
            Ok(None) => Outcome::Ready,
            Ok(Some(win::Blocker::WslAbsent)) => Outcome::WslAbsent,
            Ok(Some(win::Blocker::WslOne)) => Outcome::WslOne,
            Ok(Some(win::Blocker::WslNoKernel)) => Outcome::WslNoKernel,
            Ok(Some(win::Blocker::VirtualMachinePlatformDisabled)) => {
                Outcome::VirtualMachinePlatformDisabled
            }
            Ok(Some(win::Blocker::VirtualizationDisabled)) => Outcome::VirtualizationDisabled,
            Ok(Some(win::Blocker::NotAdministrator)) => Outcome::NotAdministrator,
            Err(_) => Outcome::CheckFailed,
        };
        desktop_telemetry::record(&app, telemetry::EventData::WindowsStage { outcome });
    }
    result
}

#[tauri::command]
fn record_setup_event<R: tauri::Runtime>(app: tauri::AppHandle<R>, event: serde_json::Value) {
    if let Ok(
        event @ (telemetry::EventData::StepViewed { .. }
        | telemetry::EventData::HarnessChosen { .. }
        | telemetry::EventData::ModelChosen { .. }),
    ) = serde_json::from_value(event)
    {
        desktop_telemetry::record(&app, event);
    }
}

#[tauri::command]
fn windows_blocker_instruction(blocker: win::Blocker) -> String {
    blocker.instruction().to_string()
}

/// Bring the engine up: create the machine if it is missing, start it, then prove it answers.
///
/// Reported step by step rather than as one result, because these take minutes and a window with
/// nothing moving in it reads as a hang.
#[tauri::command]
async fn prepare_engine(app: tauri::AppHandle) -> Result<engine::EngineStatus, Problem> {
    engine_ready(&app).await?;
    Ok(engine::detect())
}

/// Complete all local software acquisition before either authentication screen is available.
#[tauri::command]
async fn prepare_installation(
    app: tauri::AppHandle,
    root: String,
    harness: Option<harness::HarnessChoice>,
) -> Result<(), Problem> {
    let root = stack::root_from(&root);
    tauri::async_runtime::spawn_blocking(move || {
        let shell = app.state::<Shell>();
        let attempt = StartAttempt::begin(&shell)?;
        {
            let shell = app.state::<Shell>();
            let _startup = attempt.lock_current()?;
            if shell.containers.lock().unwrap().is_some() || shell.root.lock().unwrap().is_some() {
                return Err(Problem::plain(
                    "Stop OpenBot before changing its local installation.",
                ));
            }
            remember_selected_root(&shell, &root);
        }
        let address = tauri::async_runtime::block_on(engine_ready(&app))?.pin()?;
        attempt.require_current()?;
        tauri::async_runtime::block_on(deployment_ready(&app, &root))?;
        let picked = harness::picked(harness.as_ref(), &root).map_err(Problem::from)?;
        let handle = app.clone();
        let _startup = attempt.lock_current()?;
        if preparation::require(&root, Some(&harness), &address).is_ok() {
            preparation::save_selected_root(
                &app.path()
                    .app_config_dir()
                    .map_err(|e| Problem::from(e.to_string()))?,
                &root,
            )?;
            report(
                &handle,
                "installation",
                true,
                "Local software is already installed.",
            );
            return Ok(());
        }
        preparation::invalidate(&root)?;
        if let Some(problem) = stack::deployment_problem(&root) {
            return Err(Problem::from(problem));
        }
        report_running(
            &handle,
            "dependencies",
            "Preparing the app's dependencies.",
            None,
        );
        preparation::install_dependencies_if_needed(&root, || {
            report_running(
                &handle,
                "dependencies",
                "Preparing the local runtime.",
                None,
            );
            let bun = install::ensure_bun(&root, which_bun())?;
            report_running(
                &handle,
                "dependencies",
                "Installing the app's packages.",
                None,
            );
            Ok(bun)
        })?;
        report(
            &handle,
            "dependencies",
            true,
            "The app's dependencies are installed.",
        );
        report_running(
            &handle,
            "images",
            "Checking which local software to download.",
            None,
        );
        let settings = preparation::image_settings(&root, picked.as_ref())?;
        let installed = picked
            .as_ref()
            .and_then(|picked| picked.installed_port())
            .is_some();
        let mut images = stack::installation_images(&address, &root, installed, &settings)?;
        for published in [
            openbot_desktop_lib::plan::SIGN_IN_IMAGE,
            openbot_desktop_lib::plan::CHATGPT_SIGN_IN_IMAGE,
        ] {
            images.push(deployment::reference(&root, published)?);
        }
        images.sort();
        images.dedup();
        for (index, image) in images.iter().enumerate() {
            attempt.require_current()?;
            let detail = format!(
                "Downloading local software ({}/{}).",
                index + 1,
                images.len()
            );
            report_running(&handle, "images", &detail, None);
            pull_metrics::pull_image(
                &address,
                image,
                |bytes| report_running(&handle, "images", &detail, Some(bytes)),
                |metrics| desktop_telemetry::pull_completed(&handle, metrics),
            )?;
        }
        report(
            &handle,
            "images",
            true,
            format!(
                "Local software is downloaded ({}/{}).",
                images.len(),
                images.len()
            ),
        );
        report_running(&handle, "installation", "Finishing installation.", None);
        attempt.require_current()?;
        preparation::complete(&root, harness.as_ref(), images, &address)?;
        preparation::save_selected_root(
            &app.path()
                .app_config_dir()
                .map_err(|e| Problem::from(e.to_string()))?,
            &root,
        )?;
        report(
            &handle,
            "installation",
            true,
            "Local software is installed. Continue to sign in.",
        );
        Ok::<(), Problem>(())
    })
    .await
    .map_err(|error| {
        Problem::with(
            "The local installation did not finish. Try again.",
            error.to_string(),
        )
    })?
}

/// An engine that can run a container: installed, its machine up, and answering.
///
/// Called only by local installation. Authentication and launch check the prepared assets and
/// never invoke acquisition or repair from inside a sign-in operation.
///
/// Reported step by step rather than as one result, because these take minutes and a window with
/// nothing moving in it reads as a hang.
async fn engine_ready(app: &tauri::AppHandle) -> Result<engine::Address, Problem> {
    report_running(app, "engine", "Checking the software OpenBot needs.", None);
    let found = engine::detect();
    desktop_telemetry::observe_engine(app, &found);
    let root = stack::default_root();
    let existing = tauri::async_runtime::spawn_blocking(move || {
        ready_responding_engine_after_compose_repair(
            found,
            cfg!(target_os = "linux"),
            || install::install_engine(&root),
            engine::detect,
            engine::Address::composes,
        )
    })
    .await
    .map_err(|error| {
        Problem::with(
            "OpenBot could not check the software it runs on. Try again.",
            format!("the engine check did not run: {error}"),
        )
    })?;
    match existing {
        Ok(Some(ready)) => {
            if let Some(installed) = ready.installed {
                report(app, "install-engine", true, installed);
            }
            #[cfg(target_os = "linux")]
            {
                let handle = app.clone();
                let address = ready.address.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let shell = handle.state::<Shell>();
                    let _startup = shell.startup.lock().unwrap();
                    ensure_linux_podman_api(&shell, &address)
                })
                .await
                .map_err(|error| {
                    Problem::with(
                        "OpenBot could not start its container service.",
                        error.to_string(),
                    )
                })??;
            }
            report(app, "engine", true, ready.detail);
            return Ok(ready.address);
        }
        Ok(None) => {}
        Err(problem) => {
            report(app, "install-engine", false, problem.said.clone());
            return Err(problem);
        }
    }

    // Fetch and install an engine when there is none, and the Compose provider Podman ships
    // without either way. Nobody is sent to a download page: see `install.rs`.
    //
    // On a blocking thread for the reason the deployment fetch is: a blocking HTTP client dropped
    // inside an async context panics the worker instead of returning an error, and the window
    // survives that with a step that never ends.
    report_running(
        app,
        "install-engine",
        "Looking for the software OpenBot runs on.",
        None,
    );
    let telemetry_app = app.clone();
    let progress_app = app.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || {
        install::install_engine_observed(
            &stack::default_root(),
            |engine, success| {
                desktop_telemetry::record(
                    &telemetry_app,
                    telemetry::EventData::EngineInstalled {
                        engine: match engine {
                            engine::Engine::Docker => telemetry::Engine::Docker,
                            engine::Engine::Podman => telemetry::Engine::Podman,
                        },
                        outcome: if success {
                            telemetry::EngineInstallOutcome::Success
                        } else {
                            telemetry::EngineInstallOutcome::Failure
                        },
                    },
                );
            },
            // Starting or installing Docker Desktop takes minutes; each line says where it is.
            &mut |progress| {
                report_running(
                    &progress_app,
                    "install-engine",
                    progress.said,
                    progress.downloaded,
                )
            },
        )
    })
    .await
    .map_err(|error| {
        Problem::with(
            "OpenBot could not install the software it needs. Try again.",
            format!("the install task did not run: {error}"),
        )
    })?;
    match installed {
        Ok(said) => {
            report(app, "install-engine", true, said);
        }
        Err(problem) => {
            report(app, "install-engine", false, problem.said.clone());
            return Err(problem);
        }
    }

    // One at a time, and each only if the last one worked. Written as a loop over an array once,
    // which ran all three before the first was checked: a failed `machine init` was still followed
    // by `machine start`.
    report_running(app, "create-machine", "Preparing the engine machine.", None);
    let created = acquire::create_machine(4, 6144, 60);
    report(app, "create-machine", created.ok, created.said.clone());
    if !created.ok {
        return Err(created.problem());
    }

    report_running(app, "start-machine", "Starting the engine machine.", None);
    let started = acquire::start_machine();
    report(app, "start-machine", started.ok, started.said.clone());
    if !started.ok {
        return Err(started.problem());
    }

    report_running(
        app,
        "health-gate",
        "Waiting for the engine to answer.",
        None,
    );
    let gate = acquire::health_gate(&acquire::address());
    report(app, "health-gate", gate.ok, gate.said.clone());
    if !gate.ok {
        return Err(gate.problem());
    }

    let ready = engine::detect();
    desktop_telemetry::observe_engine(app, &ready);
    let address = ready
        .address
        .clone()
        .filter(|_| ready.responding)
        .ok_or_else(|| {
            Problem::with(
                "OpenBot set up the software it runs on, but it is still not answering. Try again.",
                ready.detail,
            )
        })?;
    report(app, "engine", true, "The container engine is answering.");
    Ok(address)
}

/// Called while holding startup so Quit cannot retire the service during its acquisition.
#[cfg(target_os = "linux")]
fn ensure_linux_podman_api(shell: &Shell, address: &engine::Address) -> Result<(), Problem> {
    if !matches!(*shell.quit.phase.lock().unwrap(), QuitPhase::Idle) {
        return Err(Problem::plain(
            "OpenBot is quitting. Start it again to continue.",
        ));
    }
    shell
        .podman_api
        .lock()
        .unwrap()
        .ensure(&address.pin()?, &stack::default_root())
}

/// Install the latest published deployment on first use, then keep its recorded version.
///
/// Local preparation fetches the manifest needed by both launch and plan sign-in images.
/// An installed deployment keeps its exact tag without consulting GitHub again.
async fn deployment_ready<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    root: &Path,
) -> Result<(), Problem> {
    report_running(app, "deployment", "Checking the OpenBot release.", None);
    // Both release discovery and downloading use blocking HTTP. Keeping them in a blocking task
    // avoids dropping reqwest's runtime inside this async context.
    let target = root.to_path_buf();
    let handle = app.clone();
    let version = tauri::async_runtime::spawn_blocking(move || {
        let version = deployment_release::resolve_version(&target)?;
        if deployment::needs_fetch(&target, &version) {
            report_running(
                &handle,
                "deployment",
                format!("Downloading OpenBot {version}."),
                None,
            );
            deployment::fetch(&target, &version)?;
        }
        Ok::<_, String>(version)
    })
    .await
    .map_err(|error| format!("the download did not run: {error}"))
    .and_then(|result| result)
    .map_err(|error| {
        report(app, "deployment", false, error.clone());
        Problem::with(
            "OpenBot could not download what it needs to run. Check the internet \
             connection and try again.",
            error,
        )
    })?;
    report(
        app,
        "deployment",
        true,
        format!("{version} in {}", root.display()),
    );
    Ok(())
}

/// The reference for an image the shell runs directly, rather than through Compose.
///
/// Require completed local installation before starting an authentication container.
fn prepared_sign_in(root: &Path, published: &str) -> Result<(engine::Address, String), Problem> {
    let status = engine::detect();
    let address = status
        .address
        .filter(|_| status.responding)
        .ok_or_else(|| preparation::required(status.detail))?
        .pin()?;
    preparation::require(root, None, &address)?;
    let image = sign_in_reference(root, published, deployment::reference)?;
    preparation::require_images(&address, std::slice::from_ref(&image))?;
    Ok((address, image))
}

fn sign_in_reference(
    root: &Path,
    published: &str,
    reference: impl FnOnce(&Path, &str) -> Result<String, String>,
) -> Result<String, Problem> {
    reference(root, published).map_err(|error| {
        Problem::with(
            "This version of OpenBot cannot sign in to that plan. Use an API key instead, or \
             update OpenBot.",
            error,
        )
    })
}

/// What the model screen chose, as the window sends it.
///
/// Deliberately not the same type as `ModelCredential`: this is whatever arrived over the bridge,
/// and turning it into a credential is a conversion that can fail. Accepting the credential type
/// directly would make an impossible combination representable at the boundary.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChosenModel {
    provider: String,
    login: String,
    api_key: Option<String>,
    base_url: Option<String>,
    container_base_url: Option<String>,
    model: Option<String>,
    /// Minted by signing in, never typed. Absent for every path but a plan.
    token: Option<String>,
    /// A saved credential/session indicator chosen in the window. The value is resolved here.
    saved: Option<bool>,
}

impl ChosenModel {
    fn into_credential(self, root: &Path) -> Result<openbot_env::ModelCredential, Problem> {
        self.into_credential_with(root, saved_secret)
    }

    fn into_credential_with(
        self,
        root: &Path,
        mut saved_secret: impl FnMut(&Path, &str) -> Result<String, Problem>,
    ) -> Result<openbot_env::ModelCredential, Problem> {
        let given = |value: Option<String>| value.unwrap_or_default().trim().to_string();
        let saved = self.saved.unwrap_or(false);
        // TEMPORARY demo diagnosis: which fields arrived, never their values. Remove after.
        eprintln!(
            "[debug] model credential: provider={} login={} token_present={} token_len={} saved={:?}",
            self.provider,
            self.login,
            self.token.is_some(),
            self.token.as_deref().map(str::len).unwrap_or(0),
            self.saved
        );
        match (self.provider.as_str(), self.login.as_str()) {
            ("google" | "xai", "oauth") => {
                let saved = openbot_desktop_lib::provider_oauth::read(root, &self.provider)
                    .map_err(Problem::plain)?;
                let model = given(self.model);
                if model.is_empty() { return Err("Choose a model for this provider.".into()); }
                Ok(openbot_env::ModelCredential::ProviderOAuth {
                    provider: self.provider,
                    path: root.join(openbot_desktop_lib::provider_oauth::FILE).to_string_lossy().into_owned(),
                    proxy_token: saved.proxy_token,
                    model,
                })
            }
            ("openai", "api-key") => {
                let api_key = if saved {
                    saved_secret(root, "OPENAI_API_KEY")?
                } else {
                    given(self.api_key)
                };
                if saved && api_key.is_empty() {
                    return Err("That saved OpenAI API key is no longer available.".into());
                }
                Ok(openbot_env::ModelCredential::OpenAi { api_key })
            }
            ("anthropic", "api-key") => {
                let api_key = if saved {
                    saved_secret(root, "ANTHROPIC_API_KEY")?
                } else {
                    given(self.api_key)
                };
                if saved && api_key.is_empty() {
                    return Err("That saved Anthropic API key is no longer available.".into());
                }
                Ok(openbot_env::ModelCredential::Anthropic { api_key })
            }
            ("anthropic", "plan") => {
                let token = if saved {
                    saved_secret(root, "CLAUDE_CODE_OAUTH_TOKEN")?
                } else {
                    given(self.token)
                };
                if token.is_empty() {
                    // Said rather than written blank. A plan with no token produces a stack that
                    // comes up and a Bot that cannot answer, which reads as a broken product.
                    return Err("That Claude plan was not signed in to.".into());
                }
                Ok(openbot_env::ModelCredential::ClaudePlan { token })
            }
            /*
             * The sign-in hands back the vendor's whole token store, not one token, and it travels
             * in the same field the Claude plan uses. See `ModelCredential::ChatGptPlan`: the
             * refresh token in there is what keeps the Bot answering past the first hour.
             */
            ("openai", "plan") => {
                let store = if saved {
                    openbot_env::read_plan_store(root)
                        .map_err(|error| {
                            Problem::with(
                                "OpenBot could not read the saved ChatGPT sign-in.",
                                format!("{}: {error}", root.join(openbot_env::CHATGPT_STORE_FILE).display()),
                            )
                        })?
                        .unwrap_or_default()
                } else {
                    given(self.token)
                };
                if store.is_empty() {
                    return Err("That ChatGPT plan was not signed in to.".into());
                }
                Ok(openbot_env::ModelCredential::ChatGptPlan { store })
            }
            ("openai-compatible", "endpoint") => {
                let base_url = given(self.base_url);
                if !reqwest::Url::parse(&base_url)
                    .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
                {
                    return Err(
                        "Enter a valid http:// or https:// address for your model endpoint.".into(),
                    );
                }
                let container_base_url = given(self.container_base_url);
                if !container_base_url.is_empty()
                    && !reqwest::Url::parse(&container_base_url)
                        .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
                {
                    return Err(
                        "Enter a valid http:// or https:// address for the container model endpoint.".into(),
                    );
                }
                let model = given(self.model);
                if model.is_empty() {
                    return Err("Enter the model name your endpoint serves.".into());
                }
                let api_key = if saved {
                    use openbot_desktop_lib::saved_intent::{
                        compatible_key_from_record, SavedIntent, COMPATIBLE_CREDENTIAL,
                    };
                    if !SavedIntent::read(root).has_compatible_key_for(&base_url) {
                        return Err("That saved endpoint key does not belong to this address. Enter its API key again.".into());
                    }
                    let record = saved_secret(root, COMPATIBLE_CREDENTIAL)?;
                    compatible_key_from_record(&base_url, &record)?
                } else {
                    given(self.api_key)
                };
                Ok(openbot_env::ModelCredential::Compatible {
                    base_url,
                    container_base_url: (!container_base_url.is_empty())
                        .then_some(container_base_url),
                    api_key,
                    model,
                })
            }
            (provider, login) => Err(format!(
                "{provider} cannot be connected by {login}, which is not a way in that screen offers."
            )
            .into()),
        }
    }
}

fn start_stack_credential(
    root: &Path,
    model: ChosenModel,
) -> Result<openbot_env::ModelCredential, Problem> {
    model
        .into_credential(root)
        .map_err(|problem| problem.connection(openbot_desktop_lib::problem::Connection::Model))
}

#[cfg(test)]
fn start_stack_credential_with(
    root: &Path,
    model: ChosenModel,
    saved_secret: impl FnMut(&Path, &str) -> Result<String, Problem>,
) -> Result<openbot_env::ModelCredential, Problem> {
    model
        .into_credential_with(root, saved_secret)
        .map_err(|problem| problem.connection(openbot_desktop_lib::problem::Connection::Model))
}

fn saved_secret(root: &Path, key: &str) -> Result<String, Problem> {
    openbot_desktop_lib::vault::already_given_no_ui(root, &root.join(".env"), &[key])
        .map(|found| found.get(key).cloned().unwrap_or_default())
}

fn intelligence_key_for_start(
    root: &Path,
    given: String,
    mut resolve: impl FnMut(&Path, &str) -> Result<String, Problem>,
) -> Result<String, Problem> {
    let key = if given.trim().is_empty() {
        resolve(root, "INTELLIGENCE_API_KEY").map_err(|problem| {
            problem.connection(openbot_desktop_lib::problem::Connection::Intelligence)
        })?
    } else {
        given
    };
    if key.trim().is_empty() {
        return Err(Problem::plain("That saved CopilotKit connection is no longer available. Sign in again or enter a project key.")
            .connection(openbot_desktop_lib::problem::Connection::Intelligence));
    }
    Ok(key)
}

fn seed_learning_default(
    root: &Path,
    settings: &mut std::collections::BTreeMap<String, String>,
    proof: Option<&openbot_desktop_lib::intelligence::ProvisionedConnection>,
) -> Result<(), Problem> {
    const TARGET: &str = "CPK_INTELLIGENCE_LEARNING_CONTAINER_ID";
    let Some(proof) = proof else {
        return Ok(());
    };
    if settings.get("INTELLIGENCE_API_KEY") != Some(&proof.api_key)
        || settings
            .get("INTELLIGENCE_API_URL")
            .map(|api| api.trim_end_matches('/'))
            != Some(proof.api_url.trim_end_matches('/'))
        || settings.contains_key(TARGET)
    {
        return Ok(());
    }
    let existing = match std::fs::read_to_string(root.join(".env")) {
        Ok(existing) => existing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(Problem::with(
                "OpenBot could not read its Learning settings.",
                error.to_string(),
            ));
        }
    };
    // Preserve both dotenv assignment forms, including an optional export prefix and spacing.
    let configured = existing.lines().any(|line| {
        let Some((key, value)) = line.split_once('=') else {
            return false;
        };
        let mut words = key.split_whitespace();
        matches!(
            (words.next(), words.next(), words.next()),
            (Some(TARGET), None, None) | (Some("export"), Some(TARGET), None)
        ) && !value.trim().is_empty()
    });
    if !configured {
        settings.insert(TARGET.into(), proof.learning_container_id.clone());
    }
    Ok(())
}

fn require_existing_encryption_key(
    root: &Path,
    secrets: &std::collections::BTreeMap<String, String>,
    existing_postgres_volume: impl FnOnce() -> Result<bool, Problem>,
) -> Result<(), Problem> {
    if secrets
        .get("KEY_ENCRYPTION_KEY")
        .is_some_and(|value| openbot_env::usable_encryption_key(value))
    {
        return Ok(());
    }
    let configured = openbot_desktop_lib::saved_intent::SavedIntent::read(root)
        .model
        .is_some()
        || openbot_env::already_set(&root.join(".env"), &["DATABASE_URL"])
            .contains_key("DATABASE_URL");
    // A reinstall can remove every root-local marker and secret while Compose keeps its volume.
    // Only a verified fresh database may receive a newly minted encryption key.
    if configured || existing_postgres_volume()? {
        return Err(Problem::plain(
            "This installation's saved encryption key is missing, invalid, or public. Restore its original private key from backup, or get help preserving its saved data. OpenBot will not replace the key automatically.",
        ));
    }
    Ok(())
}

fn require_existing_encryption_key_with_recovery(
    root: &Path,
    secrets: &stack::Secrets,
    existing_postgres_volume: impl FnOnce() -> Result<bool, Problem>,
    resettable_volume: impl FnOnce() -> Result<Option<String>, Problem>,
) -> Result<(), Problem> {
    let mut volume_exists = false;
    require_existing_encryption_key(root, secrets, || {
        volume_exists = existing_postgres_volume()?;
        Ok(volume_exists)
    })
    .map_err(|mut problem| {
        // A failed probe is not proof of an existing volume. Configured roots never reach here.
        if volume_exists {
            let recovery = fresh_root_without_encryption_key(root, secrets).and_then(|fresh| {
                if fresh {
                    resettable_volume()
                } else {
                    Ok(None)
                }
            });
            match recovery {
                Ok(volume) => {
                    if volume.is_some() {
                        problem.said = "OpenBot found a database from a previous installation, but its encryption key is unavailable. Restore the original key to keep its saved data, or reset the leftover database to start fresh.".into();
                    }
                    problem.database_reset = volume;
                }
                Err(verification) => {
                    problem.detail = Some(match verification.detail {
                        Some(detail) => format!("{}\n{detail}", verification.said),
                        None => verification.said,
                    });
                }
            }
        }
        problem
    })
}

/// Destructive recovery needs positive evidence that root metadata is readable and unconfigured.
/// The ordinary startup guard keeps its existing behavior when metadata is unknown.
fn fresh_root_without_encryption_key(
    root: &Path,
    secrets: &stack::Secrets,
) -> Result<bool, Problem> {
    if secrets
        .get("KEY_ENCRYPTION_KEY")
        .is_some_and(|key| openbot_env::usable_encryption_key(key))
    {
        return Ok(false);
    }
    let unknown = || {
        Problem::plain("OpenBot could not verify that this is an unconfigured installation. Its leftover database cannot be reset here.")
    };
    let settings = openbot_env::read_already_set(&root.join(".env"), &["DATABASE_URL"])
        .map_err(|_| unknown())?;
    if settings.contains_key("DATABASE_URL") {
        return Ok(false);
    }
    use openbot_desktop_lib::saved_intent::{SavedIntent, FILE};
    match std::fs::read(root.join(FILE)) {
        Ok(bytes) => {
            let record: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| unknown())?;
            if record["version"].as_u64() != Some(1) {
                return Err(unknown());
            }
            let intent: SavedIntent = serde_json::from_value(record).map_err(|_| unknown())?;
            Ok(intent.model.is_none())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err(unknown()),
    }
}

fn reset_leftover_database_with(
    shell: &Shell,
    root: &Path,
    volume: &str,
    confirmed: bool,
    read_secrets: impl FnOnce() -> Result<stack::Secrets, Problem>,
    reset: impl FnOnce(&engine::Address, &stack::Secrets) -> Result<(), Problem>,
) -> Result<(), Problem> {
    if !confirmed {
        return Err(Problem::plain("Confirm that you want to permanently delete the leftover database before resetting it."));
    }
    let attempt = StartAttempt::begin(shell)?;
    let _startup = attempt.lock_current()?;
    if shell.containers.lock().unwrap().is_some()
        || shell.root.lock().unwrap().is_some()
        || !shell.children.lock().unwrap().is_empty()
    {
        return Err(Problem::plain("OpenBot still owns running services. Choose Stop OpenBot before resetting a leftover database."));
    }
    if shell
        .selected_root
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|selected| selected != root)
    {
        return Err(Problem::plain("The selected installation changed. Try Start again before resetting its leftover database."));
    }
    let address = shell.leftover_database.lock().unwrap().as_ref()
        .filter(|offer| offer.root == root && offer.volume == volume)
        .map(|offer| offer.address.clone())
        .ok_or_else(|| Problem::plain("The leftover database reset offer is no longer current. Try Start again before confirming a reset."))?;
    let secrets = read_secrets()?;
    if !fresh_root_without_encryption_key(root, &secrets)? {
        return Err(Problem::plain("This installation is already configured or has its original encryption key. Its database cannot be reset here."));
    }
    reset(&address, &secrets)?;
    *shell.leftover_database.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
async fn reset_leftover_database<R: tauri::Runtime>(
    root: String,
    volume: String,
    confirmed: bool,
    app: tauri::AppHandle<R>,
) -> Result<(), Problem> {
    let root = stack::root_from(&root);
    let shell = app.state::<Shell>();
    reset_leftover_database_with(
        &shell,
        &root,
        &volume,
        confirmed,
        || {
            openbot_desktop_lib::vault::already_given_no_ui(
                &root,
                &root.join(".env"),
                &openbot_env::MINTED[..],
            )
        },
        |address, secrets| stack::reset_leftover_database(address, &root, secrets, &volume),
    )
}

/// Write the `.env`, raise the containers, migrate, then start the three host processes.
#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "These named fields preserve the existing Tauri IPC contract."
)]
async fn start_stack<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: String,
    api_url: String,
    gateway_ws_url: String,
    api_key: String,
    model: ChosenModel,
    // The row the person picked, with the address only for the bring-your-own row.
    harness: Option<harness::HarnessChoice>,
    organization_auth_url: Option<String>,
    // Both registers on the way out: see `problem.rs`. Anything that still returns a bare string
    // converts to the plain half, so a path without its own sentence reads as it always did.
) -> Result<(), openbot_desktop_lib::problem::Problem> {
    let root = stack::root_from(&root);
    let menus = app.clone();
    let started = start_stack_inner(
        app,
        root,
        api_url,
        gateway_ws_url,
        api_key,
        model,
        harness,
        organization_auth_url,
    )
    .await;
    // The menu bar says whether OpenBot is running.
    refresh_menus(&menus);
    started
}

#[allow(
    clippy::too_many_arguments,
    reason = "Mirror the command fields while testing startup with a resolved root."
)]
async fn start_stack_inner<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: PathBuf,
    api_url: String,
    gateway_ws_url: String,
    api_key: String,
    model: ChosenModel,
    harness: Option<harness::HarnessChoice>,
    organization_auth_url: Option<String>,
) -> Result<(), Problem> {
    let organization_auth_url = organization_auth_url.map(|url| url.trim().to_string());
    if let Some(url) = organization_auth_url.as_ref().filter(|url| !url.is_empty()) {
        if !reqwest::Url::parse(url).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.has_host()
                && url.username().is_empty()
                && url.password().is_none()
        }) {
            return Err(Problem::plain(
                "Enter a valid http:// or https:// organization OpenBot URL.",
            )
            .connection(openbot_desktop_lib::problem::Connection::Organization));
        }
    }
    let shell = app.state::<Shell>();
    let attempt = StartAttempt::begin(&shell)?;
    {
        let _startup = attempt.lock_current()?;
        if shell
            .containers
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|owned| owned.root != root)
        {
            return Err(Problem::plain(
                "OpenBot still has services from another installation to stop. Choose Stop OpenBot before starting in a different folder.",
            ));
        }
        // A rejected concurrent Start must not replace the accepted attempt's selection.
        remember_selected_root(&shell, &root);
        *shell.leftover_database.lock().unwrap() = None;
    }
    /*
     * Resolved from the catalogue rather than taken from the window.
     *
     * The image, the port and how it is dialled are facts about the harness, and the window
     * knowing them would mean two lists to keep in step. An id that is not in the catalogue is
     * refused here rather than written into `.env`, where it would become a Bot pointing at a
     * container nobody started.
     */
    // Resolved from the catalogue rather than taken from the window: the image, the port and how
    // it is dialled are facts about the harness, and the window knowing them would be a second
    // list to keep in step. See `harness::picked` for what each refusal is for.
    // Named rather than inlined: the Bot choice below reads it, the store file is written from it,
    // and reading the model screen twice could not be relied on to give the same answer.
    let credential = start_stack_credential(&root, model)?;

    /*
     * A PLAN CHOOSES ITS OWN BOT, because only one Bot can spend it.
     *
     * Every harness takes any model through a key, so the Bot step and the model step are
     * independent there. A subscription is not: it buys that vendor's own models through a path
     * that speaks that vendor's subscription auth, and nothing else. Signing in to a Claude plan
     * and keeping the default Bot produced a clean start and a Bot whose log said "Missing
     * credentials. Please pass an `api_key`" — the person had answered both screens correctly and
     * had no way to know which answer to change.
     *
     * Nobody is asked to know this, which is the audience rule. The plan re-points the Bot, and
     * the window says which Bot it will be while there is still a screen to say it on.
     */
    let requested_harness = harness.clone();
    let harness =
        match &credential {
            openbot_env::ModelCredential::ClaudePlan { .. } => harness::speaking_for("anthropic")
                .map(|id| harness::HarnessChoice {
                    id: id.into(),
                    agent_url: None,
                }),
            openbot_env::ModelCredential::ChatGptPlan { .. } => harness::speaking_for("openai")
                .map(|id| harness::HarnessChoice {
                    id: id.into(),
                    agent_url: None,
                }),
            _ => harness,
        };
    let picked = harness::picked(harness.as_ref(), &root).map_err(|error| {
        // Two registers, because one of these refusals is about a release and the other is
        // about a pick. "OpenBot v0.0.8 does not include agent-langgraph-agui" is the
        // evidence, not the sentence: it names a published image, which is not a thing the
        // person chose or can change.
        Problem::with(
            "This version of OpenBot does not include the Bot you picked. Go back and choose \
                 another, or update OpenBot.",
            error,
        )
    })?;

    let (logs, bun, mut secrets, ports) = {
        let _startup = attempt.lock_current()?;

        // Belt and braces: a fetch that reported success and left something out is still not a
        // deployment, and Compose's own error would not say which part was missing.
        if let Some(problem) = stack::deployment_problem(&root) {
            report(&app, "deployment", false, problem.clone());
            return Err(problem.into());
        }

        let owned_address = shell
            .containers
            .lock()
            .unwrap()
            .as_ref()
            .map(|owned| owned.address.clone());
        let status = match owned_address {
            Some(address) => address.status(),
            None => engine::detect(),
        };
        let Some(found) = status.address.clone().filter(|_| status.responding) else {
            return Err(status.detail.into());
        };
        let found = found.pin()?;
        #[cfg(target_os = "linux")]
        ensure_linux_podman_api(&shell, &found)?;
        #[cfg(target_os = "linux")]
        let status = found.status();
        acquire::prepare_for_compose(&found)?;
        let bun = preparation::require(&root, Some(&requested_harness), &found)?;

        // Checked here as well as in the health gate, because the gate only runs when an engine had to
        // be installed. A machine that already had Podman skips all of that and arrives at Compose,
        // which is exactly the machine this was found on.
        if !found.composes() {
            let problem = acquire::missing_compose(found.engine.binary());
            report(&app, "engine", false, problem.clone());
            return Err(problem.into());
        }

        let api_key = intelligence_key_for_start(&root, api_key, saved_secret)?;
        let existing_secrets = openbot_desktop_lib::vault::already_given_no_ui(
            &root,
            &root.join(".env"),
            &openbot_env::MINTED[..],
        )?;
        require_existing_encryption_key_with_recovery(
            &root,
            &existing_secrets,
            || stack::postgres_volume_exists(&found, &root, &existing_secrets),
            || stack::leftover_database_volume(&found, &root, &existing_secrets),
        )
        .inspect_err(|problem| {
            *shell.leftover_database.lock().unwrap() =
                problem
                    .database_reset
                    .as_ref()
                    .map(|volume| LeftoverDatabase {
                        root: root.clone(),
                        volume: volume.clone(),
                        address: found.clone(),
                    });
        })?;

        // Only this deployment's recorded hosts are reclaimed; its existing containers are reusable.
        let previous_ports = openbot_env::Ports::read(&root).map_err(|error| {
            Problem::with("OpenBot could not read its local ports.", error.to_string())
        })?;
        let reclaimed = cleanup_before_start(&app, &attempt, &root, stack::stop_processes_under)?;
        if reclaimed > 0 {
            stack::wait_for_ports_to_clear(
                &[previous_ports.server, previous_ports.app],
                std::time::Duration::from_secs(5),
            );
        }
        let ours = stack::ports_we_already_publish(&found, &root);
        let ports = previous_ports
            .available(
                &ours,
                picked.as_ref().and_then(|picked| picked.installed_port()),
            )
            .map_err(|error| {
                Problem::with(
                    "OpenBot could not find available local ports. Try Start again.",
                    error.to_string(),
                )
            })?;

        let mut settings = openbot_env::compose(
            &openbot_env::Intelligence {
                api_url,
                gateway_ws_url,
                api_key,
            },
            &openbot_env::Model {
                credential: credential.clone(),
            },
            &status,
            &ports,
            &deployment::image_variables(&root)?,
            picked.as_ref(),
            // What a previous start of this deployment already minted. Without it every Start writes a
            // new KEY_ENCRYPTION_KEY and orphans everything the server had encrypted under the old one.
            &existing_secrets,
        );
        if let Some(authority) = organization_auth_url {
            settings.insert("OPENBOT_ORGANIZATION_AUTH_URL".into(), authority);
        }
        seed_learning_default(
            &root,
            &mut settings,
            shell.intelligence_learning.lock().unwrap().as_ref(),
        )?;
        /*
         * The credentials come out here and never reach the file.
         *
         * `.env` is a settings file, and a settings file is something somebody can open, read out to
         * support or paste into a chat. A model key, a plan token and the tokens these services prove
         * themselves to each other with are not settings. They go to this machine's own credential
         * store, and travel from there to the processes that need them as environment, which is where
         * a secret can live without being written down. See `vault` for what each platform gets.
         */
        let (settings, mut secrets) = openbot_desktop_lib::vault::split(settings);
        /*
         * The credentials, plus any setting this answer dropped.
         *
         * `write` keeps lines it does not own, which is what protects a hand-set value. The cost is
         * that a key this run deliberately stopped writing would otherwise survive: `BOT_MODEL` did,
         * leaving an OpenAI key asking OpenAI for the model name a previous compatible-endpoint answer
         * had given. Anything the writer owns and did not produce this time is taken out.
         */
        let mut purge = secrets.clone();
        for key in ["BOT_PROVIDER", "BOT_MODEL", "AGENT_BOT_MODEL"] {
            if !settings.contains_key(key) {
                purge.insert(key.into(), String::new());
            }
        }
        openbot_desktop_lib::saved_intent::persist_configuration(
            &root,
            &settings,
            &secrets,
            &purge,
            &credential,
        )?;
        report(&app, "env", true, "settings written, credentials stored");
        // Compose gives inherited environment precedence over .env. Pin this run's chosen ports.
        secrets.extend(ports.settings());
        for key in ["PICKED_HARNESS_PORT", "OPENBOT_TOOL_URL"] {
            if let Some(value) = settings.get(key) {
                secrets.insert(key.into(), value.clone());
            }
        }
        // Set before Bun imports the runtime, and retained for supervised restarts.
        secrets.extend(desktop_telemetry::runtime_env(&app));

        // Installation already verified these images. Start only raises the local containers;
        // its no-pull policy sends missing assets back to the installation step.
        report_running(&app, "services", "starting installed containers", None);

        // Only an installed harness needs the local service; a BYO endpoint is already running elsewhere.
        let installed_harness = picked
            .as_ref()
            .and_then(|picked| picked.installed_port())
            .is_some();
        /*
         * The bundled Bots only when there is a key for them.
         *
         * A plan is not a key, and both of them refuse to start without one, so a person signing in
         * with the subscription they already pay for was handed two dead containers and two red lines
         * about Bots they never chose. See `BOTS_NEEDING_A_KEY`.
         */
        let bundled_bots = stack::BundledBots::for_credential(&credential);
        attempt.require_current()?;
        // Even a failed up can have started some services. Keep their root until down succeeds.
        *shell.containers.lock().unwrap() = Some(ContainerDeployment {
            root: root.clone(),
            address: found.clone(),
        });
        let requested_services =
            stack::up(&found, &root, installed_harness, bundled_bots, &secrets)?;
        report(&app, "services", true, "containers up");

        report_running(&app, "migrate", "applying migrations", None);
        stack::migrate(&found, &root, &secrets)?;
        report(&app, "migrate", true, "migrations applied");

        // `compose up` succeeds once it has asked for everything. A service that then exits is not its
        // problem, and both Bots exit immediately without a model key. Reported and made fatal here;
        // otherwise the window can show a healthy stack while nothing can answer a question.
        require_no_exited_compose_services(&found, &root, &requested_services, |detail| {
            report(&app, "services", false, detail);
        })?;

        // Before spawning: if these are still held, whatever answers later is not ours.
        if let Some(problem) =
            stack::port_already_taken(&[("API server", ports.server), ("app", ports.app)])
        {
            report(&app, "ports", false, problem.clone());
            return Err(problem.into());
        }

        let logs = root.join(".logs");
        (logs, bun, secrets, ports)
    };

    // Never persisted or passed to Compose. Only the server process receives this credential;
    // model workers and frontend processes cannot impersonate the native approval transport.
    use base64::Engine as _;
    let host_token =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
    secrets.insert("OPENBOT_DESKTOP_HOST_TOKEN".into(), host_token.clone());

    let logs_for_wait = logs.clone();
    let generation = start_host_processes(
        &attempt,
        &root,
        &logs,
        &bun,
        &secrets,
        |name| report(&app, name, true, "started"),
        move |started| {
            stack::wait_until_answering(
                started,
                &logs_for_wait,
                &stack::Ready {
                    api: ports.server,
                    app: ports.app,
                },
                std::time::Duration::from_secs(180),
            )
        },
    )
    .await
    .inspect_err(|problem| report(&app, "answering", false, problem.said.clone()))?;
    // Stop must not finish between accepting readiness and reporting a successful Start.
    let _startup = attempt.lock_current()?;
    // Only a stack that answered successfully acquires a restart policy.
    let address = shell
        .containers
        .lock()
        .unwrap()
        .as_ref()
        .map(|owned| owned.address.clone())
        .ok_or_else(|| Problem::plain("The local container runtime is unavailable."))?;
    let config = host_access::HostAccessConfig::new(
        format!("http://127.0.0.1:{}", ports.server),
        host_token,
        address,
        deployment::reference(&root, "agent-computer")?,
        vec![root.clone()],
    );
    let broker = host_access::HostAccess::start_with_approval(
        config,
        std::sync::Arc::new(desktop_host_access::NativeApproval(app.clone())),
    )
    .map_err(|error| Problem::with("Local folder access could not start.", error.to_string()))?;
    *shell.host_access.lock().unwrap() = Some(broker);
    preparation::record_launch(&root, requested_harness.as_ref())?;
    let config = app.path().app_config_dir().map_err(|error| {
        Problem::with(
            "OpenBot could not remember this installation for next time.",
            error.to_string(),
        )
    })?;
    preparation::save_selected_root(&config, &root)?;
    supervise_host_processes(app.clone(), root, logs, bun, secrets, generation, ports);

    report(&app, "answering", true, "the API and the app are answering");
    Ok(())
}

/// This dedicated command accepts no setting, value, root or policy from the webview.
/// Stop what this started, and only what this started.
///
/// A Bot's computer belongs to the supervisor rather than to Compose and is deliberately left
/// running: its files and browser profile are volumes, and killing it here would sign somebody out
/// of everything their Bot had logged into.
#[tauri::command]
async fn stop_stack<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: String,
) -> Result<(), String> {
    // Inventory, held-child cleanup and Compose all block. Keep the complete shutdown off both
    // Tauri's event loop and its async workers, and resolve IPC only when shutdown has finished.
    tauri::async_runtime::spawn_blocking(move || {
        stop_everything(&app, &stack::root_from(&root)).into_result()
    })
    .await
    .map_err(|error| format!("the shutdown did not run: {error}"))?
}

#[cfg(test)]
fn shutdown_root(shell: &Shell, fallback_root: &Path) -> PathBuf {
    let mut active = shell.root.lock().unwrap();
    let root = active
        .clone()
        .or_else(|| shell.selected_root.lock().unwrap().clone())
        .unwrap_or_else(|| fallback_root.to_path_buf());
    *active = None;
    root
}

/// Take the whole stack down: the host processes, anything left over, the containers, and the
/// local Intelligence stack if OpenBot created it.
///
/// One implementation, because there are three ways to ask for it (the button, the menu bar, and
/// quitting) and a person who used one of them and got a different amount of stopping would be
/// right to call that a bug.
fn stop_everything<R: tauri::Runtime>(app: &tauri::AppHandle<R>, fallback_root: &Path) -> Stopped {
    stop_everything_for(&app.state::<Shell>(), fallback_root)
}

/// Stop as the button and the menu bar run it.
fn stop_everything_for(shell: &Shell, fallback_root: &Path) -> Stopped {
    let root = root_for_stop(shell, fallback_root);
    stop_everything_then(
        shell,
        &root,
        stack::stop_processes_under,
        |root| down_owned_containers(shell, root),
        intelligence_step(Shutdown::Stop),
    )
}

/// Quit's cleanup as the exit handler runs it, telling `progress` as each part starts and ends.
fn quit_cleanup<P>(shell: &Shell, progress: P) -> Stopped
where
    P: FnMut(QuitStep, QuitStepState),
{
    exit_cleanup_reporting(
        shell,
        &stack::default_root(),
        stack::stop_processes_under,
        |root| down_containers_on_quit(shell, root),
        intelligence_step(Shutdown::Quit),
        progress,
    )
}

/**
Quit with the Shutting down screen in front: the window comes back and shows each part of the
cleanup as it runs, then the app exits as it always has.

The window only listens. Nothing here waits for it: with no window, or a page that never loads,
the same cleanup runs in the same order and the exit follows.
*/
fn quit_cleanup_shown<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<String> {
    show_shutting_down(app);
    desktop_telemetry::shutdown(app);
    quit_cleanup(&app.state::<Shell>(), |step, state| {
        report_quit(app, step, state)
    })
    .lines()
}

/// The window event that carries the Shutting down screen's rows, the whole list each time.
const QUIT_PROGRESS_EVENT: &str = "quit:progress";

/// The setup page's fragment that opens it on the Shutting down screen alone.
const SHUTTING_DOWN_FRAGMENT: &str = "shutting-down";

/// A row on the Shutting down screen. Fixed ids and fixed words: nothing the CLI said reaches it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QuitStep {
    /// Host processes, Compose down, and on Linux the Podman API.
    OpenBot,
    /// The local Intelligence stack OpenBot created.
    Intelligence,
}

impl QuitStep {
    fn id(self) -> &'static str {
        match self {
            QuitStep::OpenBot => "stop-openbot",
            QuitStep::Intelligence => "stop-intelligence",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QuitStepState {
    Running,
    Complete,
    Failed,
}

impl QuitStepState {
    fn of<T, E>(result: &Result<T, E>) -> Self {
        if result.is_ok() {
            QuitStepState::Complete
        } else {
            QuitStepState::Failed
        }
    }
}

/// What the Shutting down screen shows, kept so a page that loads late can catch up.
///
/// `seq` only rises, so the page keeps whichever copy is newest, whether it came as an event or
/// as the answer to `quit_status`.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
struct QuitStatus {
    seq: u64,
    steps: Vec<Progress>,
}

impl QuitStatus {
    fn begin(&mut self) {
        self.seq += 1;
        self.steps.clear();
    }

    fn record(&mut self, step: QuitStep, state: QuitStepState) {
        self.seq += 1;
        let row = Progress {
            step: step.id().into(),
            ok: state != QuitStepState::Failed,
            detail: String::new(),
            running: state == QuitStepState::Running,
            download_bytes: None,
        };
        match self.steps.iter_mut().find(|known| known.step == row.step) {
            Some(known) => *known = row,
            None => self.steps.push(row),
        }
    }
}

/// Bring the window back on the Shutting down screen.
///
/// The setup page already open listens for `quit:progress` and switches by itself; reloading it
/// would only run its launch checks again. Anything else, OpenBot itself or a page that never
/// loaded, is sent to the setup page's Shutting down screen, which asks `quit_status` for what it
/// missed.
fn show_shutting_down<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    app.state::<Shell>().quit.status.lock().unwrap().begin();
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Ok(mut setup) = setup_destination(app) {
        let showing_setup = window
            .url()
            .is_ok_and(|current| same_window_app(&current, &setup));
        if !showing_setup {
            setup.set_fragment(Some(SHUTTING_DOWN_FRAGMENT));
            let _ = window.navigate(setup);
        }
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn report_quit<R: tauri::Runtime>(app: &tauri::AppHandle<R>, step: QuitStep, state: QuitStepState) {
    let status = {
        let shell = app.state::<Shell>();
        let mut status = shell.quit.status.lock().unwrap();
        status.record(step, state);
        status.clone()
    };
    let _ = app.emit(QUIT_PROGRESS_EVENT, status);
}

/// The Shutting down screen's rows so far, or None when no Quit has begun.
#[tauri::command]
fn quit_status<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Option<QuitStatus> {
    let status = app.state::<Shell>().quit.status.lock().unwrap().clone();
    (status.seq > 0).then_some(status)
}

/// What a Stop or Quit could not do, kept apart: only OpenBot's own failures mean OpenBot needs
/// recovery. A local Intelligence stack that would not stop is said, but it is not OpenBot's
/// processes or containers left behind, and must not hold OpenBot's next start.
#[derive(Debug, Default, PartialEq, Eq)]
struct Stopped {
    openbot: Vec<String>,
    /// The whole line, starting with `INTELLIGENCE_STOP_FAILED`.
    intelligence: Option<String>,
}

impl Stopped {
    /// Every failure, OpenBot's first.
    fn lines(self) -> Vec<String> {
        self.openbot.into_iter().chain(self.intelligence).collect()
    }

    fn into_result(self) -> Result<(), String> {
        let lines = self.lines();
        if lines.is_empty() {
            Ok(())
        } else {
            Err(lines.join("\n"))
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Shutdown {
    Stop,
    Quit,
}

/// How long the CLI may take to stop the stack. Quit's is shorter: somebody is waiting for the
/// app to close.
fn intelligence_limits(kind: Shutdown) -> local_eval::Limits {
    match kind {
        Shutdown::Stop => local_eval::Limits::for_action(local_eval::Action::Stop),
        Shutdown::Quit => local_eval::Limits::for_quit(),
    }
}

/// The Intelligence step both production paths run, chosen here so they cannot drift apart.
fn intelligence_step(kind: Shutdown) -> impl FnOnce(&Path) -> Result<(), String> {
    let limits = intelligence_limits(kind);
    move |root: &Path| stop_local_eval(root, limits)
}

fn root_for_stop(shell: &Shell, fallback_root: &Path) -> PathBuf {
    let root = cleanup_root(shell, fallback_root);
    remember_selected_root(shell, &root);
    root
}

#[cfg(test)]
fn stop_everything_with<C, D>(
    shell: &Shell,
    fallback_root: &Path,
    cleanup: C,
    down: D,
) -> Result<(), String>
where
    C: FnOnce(&Path) -> Result<usize, openbot_desktop_lib::problem::Problem>,
    D: FnOnce(&Path) -> Result<(), String>,
{
    stop_everything_then(shell, fallback_root, cleanup, down, |_| Ok(())).into_result()
}

/**
Stop, then `intelligence` last, once OpenBot's own processes and containers have had their turn,
and whether or not they stopped. Its failure is kept beside theirs, never instead of them.

Local evaluation closes first, before any lock: calls in flight are cancelled and new ones refused
until this returns, so neither a running `start` nor one the window sends now can hold the stop up
or outlive it. The startup lock is released before the Intelligence step, which can take minutes,
so a Quit arriving meanwhile is not held behind it.
*/
fn stop_everything_then<C, D, I>(
    shell: &Shell,
    fallback_root: &Path,
    cleanup: C,
    down: D,
    intelligence: I,
) -> Stopped
where
    C: FnOnce(&Path) -> Result<usize, openbot_desktop_lib::problem::Problem>,
    D: FnOnce(&Path) -> Result<(), String>,
    I: FnOnce(&Path) -> Result<(), String>,
{
    let _closing = local_eval::closing_for_stop();
    cancel_self_hosted_sign_in(shell);
    shell
        .stopped_in_session
        .store(true, std::sync::atomic::Ordering::SeqCst);
    shell
        .start_generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    shell
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let startup = shell.startup.lock().unwrap();
    let root = cleanup_root(shell, fallback_root);
    let mut failures = Vec::new();
    if let Err(problem) = cleanup_host_state(shell, &root, cleanup) {
        failures.push(problem_detail(problem));
    }

    if let Err(problem) = down_containers_with(shell, &root, down) {
        failures.push(format!("Compose down failed: {problem}"));
    }

    // Recovery is about what OpenBot runs, so only OpenBot's own failures keep it.
    if failures.is_empty() {
        clear_recovery_required(shell, &root);
    }
    drop(startup);
    Stopped {
        openbot: failures,
        intelligence: intelligence(&root)
            .err()
            .map(|problem| format!("{INTELLIGENCE_STOP_FAILED}{problem}")),
    }
}

/// The production Intelligence step for Stop and Quit, within `limits`.
fn stop_local_eval(root: &Path, limits: local_eval::Limits) -> Result<(), String> {
    #[cfg(test)]
    INTELLIGENCE_TIMEOUT.with(|used| used.set(Some(limits.timeout)));
    let attempt = format!("openbot-shutdown-{:016x}", rand::random::<u64>());
    stop_local_eval_with(root, local_eval::cancel_all, |stack| {
        local_eval::stop_for_shutdown(&attempt, stack, limits)
    })
}

#[cfg(test)]
thread_local! {
    /// The timeout the last `stop_local_eval` on this thread was given, so a test can tell which
    /// limits a production path chose without a CLI to time.
    static INTELLIGENCE_TIMEOUT: std::cell::Cell<Option<std::time::Duration>> =
        const { std::cell::Cell::new(None) };
}

#[cfg(test)]
fn last_intelligence_timeout() -> Option<std::time::Duration> {
    INTELLIGENCE_TIMEOUT.with(std::cell::Cell::take)
}

/**
Ask the CLI to stop the local Intelligence stack, if and only if OpenBot created it.

No record, or a stack that was already there when OpenBot found it, is left exactly as it is: it
may be serving other apps, and stopping OpenBot is not a reason to stop them. Docker and the
stack's containers are never touched here; only the CLI stops what the CLI started.

Calls already in flight are cancelled first, whoever owns the stack: cancelling ends only this
app's own CLI processes, never the stack, and a `start` left running could otherwise hold the stop
behind it, finish after it and leave the stack running, or outlive the app as an orphan.

Every way this can fail is said in fixed words. There is no CLI output to repeat, and none would
be repeated if there were.
*/
fn stop_local_eval_with<A, S>(root: &Path, cancel_all: A, stop: S) -> Result<(), String>
where
    A: FnOnce(),
    S: FnOnce(&local_eval::StackId) -> Result<local_eval::Report, local_eval::Failure>,
{
    cancel_all();
    let Some(state) = local_eval_state::read(root, None).filter(|state| state.tied_to_openbot())
    else {
        return Ok(());
    };
    let not_stopped = |why: String| {
        format!("the Intelligence CLI did not stop the local Intelligence stack ({why})")
    };
    match stop(&state.stack_id()) {
        Ok(report) => match report.outcome {
            local_eval::Outcome::Completed => Ok(()),
            outcome => Err(not_stopped(match report.reason {
                Some(reason) => format!("{}: {}", wire_name(outcome), wire_name(reason)),
                None => wire_name(outcome),
            })),
        },
        Err(local_eval::Failure::Unavailable) => Err(
            "this build has no Intelligence CLI to stop the local Intelligence stack OpenBot created"
                .into(),
        ),
        Err(failure) => Err(not_stopped(wire_name(failure))),
    }
}

/// A category's name as the window knows it, `local-command-busy` rather than `LocalCommandBusy`.
fn wire_name(category: impl Serialize) -> String {
    serde_json::to_value(category)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// Called under the startup lock by both Stop and Quit. Host cleanup can clear its own root
/// first; Compose must still use the deployment captured before up, retaining it on any error.
fn down_containers_with<D>(shell: &Shell, fallback_root: &Path, down: D) -> Result<(), String>
where
    D: FnOnce(&Path) -> Result<(), String>,
{
    let root = shell
        .containers
        .lock()
        .unwrap()
        .as_ref()
        .map(|owned| owned.root.clone())
        .unwrap_or_else(|| fallback_root.to_path_buf());
    down(&root)?;
    if shell.containers.lock().unwrap().take().is_some() {
        *shell.stopped_container_root.lock().unwrap() = Some(root);
    }
    Ok(())
}

/// Production Stop/Quit adapter. Called under startup, so the root and address stay paired
/// until down reports success. Unknown legacy ownership cannot authorize another runtime.
fn down_owned_containers(shell: &Shell, root: &Path) -> Result<(), String> {
    let containers = shell.containers.lock().unwrap();
    match containers.as_ref() {
        Some(owned) => stack::down(&owned.address, root),
        None if shell.stopped_container_root.lock().unwrap().as_deref() == Some(root) => Ok(()),
        None if root.join("docker-compose.yml").exists() => Err(
            "OpenBot has no runtime ownership for this installation. Stop its containers using the original engine and context before starting OpenBot again.".into(),
        ),
        None => Ok(()),
    }
}

/// Merely viewing setup does not give this session containers to shut down.
/// Start records ownership before Compose up, including partial failures. Quit must still
/// retire those runs, but an old Compose file alone is not a failed shutdown by this session.
/// Explicit Stop keeps the unknown-runtime error so it cannot claim an unverified cleanup.
fn down_containers_on_quit(shell: &Shell, root: &Path) -> Result<(), String> {
    if shell.containers.lock().unwrap().is_none() {
        return Ok(());
    }
    down_owned_containers(shell, root)
}

/// Reclaim held replacements before consulting durable inventory. Keep the handles and pidfile
/// if any phase fails, so the next Stop or Start can retry with the same ownership evidence.
fn cleanup_host_children<C>(
    root: &Path,
    children: &mut Vec<(&'static str, std::process::Child)>,
    cleanup: C,
) -> Result<usize, Problem>
where
    C: FnOnce(&Path) -> Result<usize, Problem>,
{
    let held = stack::stop_host_children(root, children)?;
    stop_held_process_handles(children)?;
    let recorded = cleanup(root)?;
    Ok(held + recorded)
}

fn stop_held_process_handles(
    children: &mut Vec<(&'static str, std::process::Child)>,
) -> Result<(), Problem> {
    for (name, child) in children.iter_mut() {
        let failure = |error| {
            Problem::with(
                "OpenBot could not stop one of its host processes.",
                format!("could not finish stopping held {name}: {error}"),
            )
        };
        if child.try_wait().map_err(failure)?.is_none() {
            child.kill().map_err(failure)?;
        }
        child.wait().map_err(failure)?;
    }
    children.clear();
    Ok(())
}

fn cleanup_after_host_recording_failure<C, F>(
    shell: &Shell,
    root: &Path,
    children: &mut Vec<(&'static str, std::process::Child)>,
    recording: Problem,
    cleanup: C,
    force_handles: F,
) -> Result<u64, Problem>
where
    C: FnOnce(&Path, &mut Vec<(&'static str, std::process::Child)>) -> Result<usize, Problem>,
    F: FnOnce(&mut Vec<(&'static str, std::process::Child)>) -> Result<(), Problem>,
{
    shell
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let cleanup = cleanup(root, children);
    let failure = match cleanup {
        Ok(_) => {
            *shell.root.lock().unwrap() = None;
            return Err(recording);
        }
        Err(cleanup) => cleanup,
    };
    let forced = force_handles(children);
    let mut detail = recording.detail.unwrap_or_default();
    if !detail.is_empty() {
        detail.push('\n');
    }
    detail.push_str(&problem_detail(failure));
    match forced {
        Ok(()) => {
            *shell.root.lock().unwrap() = None;
        }
        Err(forced) => {
            detail.push('\n');
            detail.push_str(&problem_detail(forced));
        }
    }
    Err(Problem::with(recording.said, detail))
}

#[cfg(test)]
fn retire_host_processes<C>(shell: &Shell, root: &Path, cleanup: C) -> Result<usize, Problem>
where
    C: FnOnce(&Path) -> Result<usize, Problem>,
{
    // Invalidate before waiting for a restart that already owns the lock. That restart either
    // observes retirement before spawning, or publishes its handle before cleanup can proceed.
    shell
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let _startup = shell.startup.lock().unwrap();
    cleanup_host_state(shell, root, cleanup)
}

fn cleanup_host_state<C>(shell: &Shell, root: &Path, cleanup: C) -> Result<usize, Problem>
where
    C: FnOnce(&Path) -> Result<usize, Problem>,
{
    // Also runs for startup replacement and failure recovery, so a retired authorization session
    // cannot leave a job running beside a new server. Keep failed cleanup owned for a later Stop.
    let host_access_result = {
        let mut slot = shell.host_access.lock().unwrap();
        let result = slot.as_ref().map_or(Ok(()), |broker| {
            broker.stop().map_err(|error| error.to_string())
        });
        if result.is_ok() {
            *slot = None;
        }
        result
    };
    let mut children = shell.children.lock().unwrap();
    let selected = shell
        .root
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| root.to_path_buf());
    let result = cleanup_host_children(&selected, &mut children, cleanup);
    let result = match (host_access_result, result) {
        (Ok(()), result) => result,
        (Err(error), Ok(_)) => Err(Problem::with(
            "OpenBot could not stop a folder operation.",
            error,
        )),
        (Err(error), Err(problem)) => Err(Problem::with(
            "OpenBot could not finish stopping its work.",
            format!("{error}\n{}", problem_detail(problem)),
        )),
    };
    if result.is_ok() {
        *shell.root.lock().unwrap() = None;
    }
    result
}

/// The initial host launch, including ownership handoff on every outcome.
async fn start_host_processes<R, W>(
    attempt: &StartAttempt<'_>,
    root: &Path,
    logs: &Path,
    bun: &Path,
    secrets: &stack::Secrets,
    mut report_started: R,
    wait: W,
) -> Result<u64, Problem>
where
    R: FnMut(&'static str),
    W: FnOnce(&mut Vec<(&'static str, std::process::Child)>) -> Result<(), String> + Send + 'static,
{
    let started = {
        let _startup = attempt.lock_current()?;
        let mut started = Vec::new();
        for process in stack::HOST_PROCESSES.iter() {
            if attempt.require_current().is_err() {
                return finish_host_start_locked(attempt, root, started, Ok(()));
            }
            let child = match stack::spawn_host_process(process, root, logs, bun, secrets) {
                Ok(child) => child,
                Err(error) => {
                    return finish_host_start_locked(
                        attempt,
                        root,
                        started,
                        Err(format!("could not start {}: {error}", process.name)),
                    );
                }
            };
            started.push((process.name, child));
            report_started(process.name);
        }
        // Stop and Quit need durable ownership while readiness is still waiting, especially on
        // Windows where a deployment directory alone cannot authorize terminating a process.
        if let Err(recording) = stack::record_host_processes(
            root,
            &started
                .iter()
                .map(|(name, child)| (*name, child.id()))
                .collect::<Vec<_>>(),
        ) {
            let shell = attempt.shell;
            let mut children = shell.children.lock().unwrap();
            children.extend(started);
            *shell.root.lock().unwrap() = Some(root.to_path_buf());
            return cleanup_after_host_recording_failure(
                shell,
                root,
                &mut children,
                recording,
                |root, children| cleanup_host_children(root, children, stack::stop_processes_under),
                stop_held_process_handles,
            );
        }
        if attempt.require_current().is_err() {
            return finish_host_start_locked(attempt, root, started, Ok(()));
        }
        started
    };
    // A failed blocking task must not drop the only handles either. The caller retains the
    // vector while readiness borrows it; even a panic returns every child to the same cleanup.
    let owned = std::sync::Arc::new(Mutex::new(started));
    let waiting = std::sync::Arc::clone(&owned);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut started = waiting.lock().unwrap();
        wait(&mut started)
    })
    .await
    .unwrap_or_else(|error| Err(format!("the wait did not run: {error}")));
    let started = std::mem::take(
        &mut *owned
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    );
    let readiness_failure = outcome.as_ref().err().cloned();
    finish_host_start(attempt, root, started, outcome).map_err(|problem| {
        // Preserve cancellation and lifecycle failures. Only the actual readiness error gets
        // the startup headline; cleanup details remain attached and are redacted with it.
        if readiness_failure.as_deref() == Some(problem.said.as_str()) {
            stack::startup_problem(problem, secrets)
        } else {
            problem
        }
    })
}

fn finish_host_start(
    attempt: &StartAttempt<'_>,
    root: &Path,
    started: Vec<(&'static str, std::process::Child)>,
    outcome: Result<(), String>,
) -> Result<u64, Problem> {
    let _startup = attempt.shell.startup.lock().unwrap();
    finish_host_start_locked(attempt, root, started, outcome)
}

fn finish_host_start_locked(
    attempt: &StartAttempt<'_>,
    root: &Path,
    mut started: Vec<(&'static str, std::process::Child)>,
    outcome: Result<(), String>,
) -> Result<u64, Problem> {
    let shell = attempt.shell;
    if let Err(cancelled) = attempt.require_current() {
        // These handles were never published. Stop may already have finished, so this attempt
        // must reap them itself. A concurrent initial Start is excluded until its ticket drops.
        let cleaned = cleanup_host_children(root, &mut started, stack::stop_processes_under);
        return match cleaned {
            Ok(_) => Err(cancelled),
            Err(cleanup) => {
                let mut detail = problem_detail(cleanup);
                if let Err(forced) = stop_held_process_handles(&mut started) {
                    detail.push('\n');
                    detail.push_str(&problem_detail(forced));
                    shell.children.lock().unwrap().extend(started);
                    *shell.root.lock().unwrap() = Some(root.to_path_buf());
                }
                Err(Problem::with(cancelled.said, detail))
            }
        };
    }
    let mut children = shell.children.lock().unwrap();
    children.extend(started);
    *shell.root.lock().unwrap() = Some(root.to_path_buf());
    if let Err(original) = outcome {
        shell
            .generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // The initial failure is the reason Start failed, even if its cleanup also needs help.
        return match cleanup_host_children(root, &mut children, stack::stop_processes_under) {
            Ok(_) => {
                *shell.root.lock().unwrap() = None;
                Err(original.into())
            }
            Err(cleanup) => Err(Problem::with(original, problem_detail(cleanup))),
        };
    }
    // Keep handles only while the recording failure is being cleaned up. Reporting Start failure
    // while leaving the just-spawned host processes alive would recreate the orphan this ownership
    // record exists to prevent.
    if let Err(recording) = stack::record_host_processes(
        root,
        &children
            .iter()
            .map(|(name, child)| (*name, child.id()))
            .collect::<Vec<_>>(),
    ) {
        return cleanup_after_host_recording_failure(
            shell,
            root,
            &mut children,
            recording,
            |root, children| cleanup_host_children(root, children, stack::stop_processes_under),
            stop_held_process_handles,
        );
    }
    attempt.require_current()?;
    clear_recovery_required(shell, root);
    Ok(shell.generation.load(std::sync::atomic::Ordering::SeqCst))
}

fn require_no_exited_compose_services(
    found: &engine::Address,
    root: &Path,
    requested_services: &[&str],
    mut report_failure: impl FnMut(String),
) -> Result<(), Problem> {
    let requested: std::collections::HashSet<&str> = requested_services.iter().copied().collect();
    let dead = stack::services_that_exited_among(found, root, Some(&requested)).inspect_err(
        |problem| {
            report_failure(problem.said.clone());
        },
    )?;
    if dead.is_empty() {
        return Ok(());
    }

    let detail = dead
        .iter()
        .map(|(name, why)| format!("{name} stopped: {why}"))
        .collect::<Vec<_>>()
        .join("\n");
    for line in detail.lines() {
        report_failure(line.to_string());
    }
    Err(Problem::with(
        "Part of OpenBot stopped during startup.",
        detail,
    ))
}

fn cleanup_before_start<R, C>(
    app: &tauri::AppHandle<R>,
    attempt: &StartAttempt<'_>,
    root: &Path,
    cleanup: C,
) -> Result<usize, openbot_desktop_lib::problem::Problem>
where
    R: tauri::Runtime,
    C: FnOnce(&Path) -> Result<usize, openbot_desktop_lib::problem::Problem>,
{
    attempt.require_current()?;
    // Preflight can fail while the previous run still owns live hosts. Retire that watcher only
    // when replacement actually begins reclaiming them, before taking the children lock, so a
    // restart already in progress hands its child to this cleanup and never adopts the new run.
    attempt
        .shell
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    cleanup_host_state(attempt.shell, root, cleanup).inspect_err(|problem| {
        report(app, "cleanup", false, problem_detail(problem.clone()));
    })
}

fn problem_detail(problem: openbot_desktop_lib::problem::Problem) -> String {
    match problem.detail {
        Some(detail) => format!("{}\n{}", problem.said, detail),
        None => problem.said,
    }
}

fn quit_cleanup_notice_path(root: &Path) -> PathBuf {
    root.join(QUIT_CLEANUP_NOTICE_FILE)
}

#[derive(Deserialize, Serialize)]
struct QuitCleanupNotice {
    version: u8,
    failures: Vec<QuitCleanupFailure>,
}

#[derive(Clone, Copy, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
enum QuitCleanupFailure {
    HostProcesses,
    Containers,
}

fn known_safe_quit_cleanup_failure(line: &str) -> QuitCleanupFailure {
    if line.starts_with("[exit] cleanup failed: Compose down failed:") {
        QuitCleanupFailure::Containers
    } else {
        QuitCleanupFailure::HostProcesses
    }
}

fn quit_cleanup_failure_summary(failure: QuitCleanupFailure) -> &'static str {
    match failure {
        QuitCleanupFailure::HostProcesses => "OpenBot could not confirm all app processes stopped.",
        QuitCleanupFailure::Containers => "OpenBot could not confirm all containers stopped.",
    }
}

fn is_intelligence_quit_failure(line: &str) -> bool {
    line.strip_prefix("[exit] cleanup failed: ")
        .is_some_and(|failure| failure.starts_with(INTELLIGENCE_STOP_FAILED))
}

/// OpenBot's own failures go to the notice that means recovery; an Intelligence one goes to its
/// own, which only says so.
fn write_quit_cleanup_notice(root: &Path, lines: &[String]) -> Result<(), String> {
    let (intelligence, openbot): (Vec<&String>, Vec<&String>) = lines
        .iter()
        .partition(|line| is_intelligence_quit_failure(line));
    write_openbot_quit_cleanup_notice(root, &openbot)?;
    if intelligence.is_empty() {
        return Ok(());
    }
    let path = root.join(LOCAL_EVAL_STOP_NOTICE_FILE);
    std::fs::create_dir_all(root)
        .and_then(|()| std::fs::write(&path, br#"{"version":1}"#))
        .map_err(|error| {
            format!(
                "{}: could not write the Intelligence shutdown notice: {error}",
                path.display()
            )
        })
}

/**
That the last Quit could not stop the local Intelligence stack, said once.

Apart from `last_failure` on purpose. The window treats that as an interrupted run and holds its
automatic start, and OpenBot's own processes are not what was left running. Fixed words: the
notice records only that it happened.
*/
fn take_local_eval_stop_notice(root: &Path) -> Option<Problem> {
    std::fs::remove_file(root.join(LOCAL_EVAL_STOP_NOTICE_FILE)).ok()?;
    Some(Problem::with(
        "When OpenBot last quit, it could not stop the local Intelligence stack it started.",
        "It may still be running. Stopping OpenBot again asks it to stop.",
    ))
}

/// What `take_local_eval_stop_notice` says, for the window.
#[tauri::command]
fn last_local_eval_stop_failure<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Option<openbot_desktop_lib::problem::Problem> {
    let shell = app.state::<Shell>();
    take_local_eval_stop_notice(&cleanup_root(&shell, &stack::default_root()))
}

fn write_openbot_quit_cleanup_notice(root: &Path, lines: &[&String]) -> Result<(), String> {
    if lines.is_empty() {
        return Ok(());
    }
    let notice = QuitCleanupNotice {
        version: 1,
        failures: lines
            .iter()
            .map(|line| known_safe_quit_cleanup_failure(line))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect(),
    };
    let bytes = serde_json::to_vec(&notice)
        .map_err(|error| format!("could not serialize shutdown notice: {error}"))?;
    if bytes.len() > QUIT_CLEANUP_NOTICE_LIMIT {
        return Err("shutdown notice exceeded its size limit".into());
    }
    std::fs::create_dir_all(root).map_err(|error| {
        format!(
            "{}: could not create shutdown notice directory: {error}",
            root.display()
        )
    })?;
    let path = quit_cleanup_notice_path(root);
    std::fs::write(&path, &bytes).map_err(|error| {
        format!(
            "{}: could not write shutdown notice: {error}",
            path.display()
        )
    })
}

fn read_quit_cleanup_notice(root: &Path) -> Result<Option<Problem>, Problem> {
    let path = quit_cleanup_notice_path(root);
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(Problem::with(
                "OpenBot could not read its previous shutdown notice.",
                format!("{}: {error}", path.display()),
            ))
        }
    };
    let size = file
        .metadata()
        .map_err(|error| {
            Problem::with(
                "OpenBot could not read its previous shutdown notice.",
                format!("{}: {error}", path.display()),
            )
        })?
        .len();
    if size > QUIT_CLEANUP_NOTICE_LIMIT as u64 {
        return Err(Problem::with(
            "OpenBot could not read its previous shutdown notice.",
            format!(
                "{}: shutdown notice exceeded its size limit",
                path.display()
            ),
        ));
    }
    let notice: QuitCleanupNotice = serde_json::from_reader(file).map_err(|error| {
        Problem::with(
            "OpenBot could not read its previous shutdown notice.",
            format!("{}: {error}", path.display()),
        )
    })?;
    std::fs::remove_file(&path).map_err(|error| {
        Problem::with(
            "OpenBot could not clear its previous shutdown notice.",
            format!("{}: {error}", path.display()),
        )
    })?;
    let detail = notice
        .failures
        .iter()
        .map(|failure| quit_cleanup_failure_summary(*failure))
        .collect::<Vec<_>>()
        .join("\n");
    if detail.is_empty() {
        return Ok(None);
    }
    Ok(Some(Problem::with(
        "OpenBot had trouble shutting down last time.",
        detail,
    )))
}

fn recovery_required_or_pending_quit_notice(shell: &Shell, root: &Path) -> bool {
    if recovery_required(shell, root) {
        return true;
    }
    if !quit_cleanup_notice_path(root).exists() {
        return false;
    }
    let generation = shell.generation.load(std::sync::atomic::Ordering::SeqCst);
    mark_recovery_required(shell, root, generation);
    true
}

#[cfg(test)]
fn exit_cleanup_with<C, D>(shell: &Shell, fallback_root: &Path, cleanup: C, down: D) -> Vec<String>
where
    C: FnOnce(&Path) -> Result<usize, openbot_desktop_lib::problem::Problem>,
    D: FnOnce(&Path) -> Result<(), String>,
{
    exit_cleanup_then(shell, fallback_root, cleanup, down, |_| Ok(())).lines()
}

/// `exit_cleanup_reporting` with nobody watching.
#[cfg(test)]
fn exit_cleanup_then<C, D, I>(
    shell: &Shell,
    fallback_root: &Path,
    cleanup: C,
    down: D,
    intelligence: I,
) -> Stopped
where
    C: FnOnce(&Path) -> Result<usize, openbot_desktop_lib::problem::Problem>,
    D: FnOnce(&Path) -> Result<(), String>,
    I: FnOnce(&Path) -> Result<(), String>,
{
    exit_cleanup_reporting(shell, fallback_root, cleanup, down, intelligence, |_, _| {})
}

/**
Quit's cleanup, then `intelligence` last, as in `stop_everything_then`.

Local evaluation closes for good here, which also cancels a Stop's own CLI stop, so Quit never
waits behind one. The order is host processes, Compose down, on Linux the Podman API this session
started, and only then Intelligence, with no lock held. So Quit's Intelligence cap starts after all
of that: 120 seconds for the CLI, its turn included, plus up to five seconds of grace to stop the
CLI's process tree if it overruns.

`progress` hears OpenBot's part start and end, then Intelligence's. Intelligence has a row only
when a stack OpenBot created is recorded, which is when its step stops anything; it is asked either
way, as before. A failure always gets its row, so the screen never says everything stopped when
something did not.
*/
fn exit_cleanup_reporting<C, D, I, P>(
    shell: &Shell,
    fallback_root: &Path,
    cleanup: C,
    down: D,
    intelligence: I,
    mut progress: P,
) -> Stopped
where
    C: FnOnce(&Path) -> Result<usize, openbot_desktop_lib::problem::Problem>,
    D: FnOnce(&Path) -> Result<(), String>,
    I: FnOnce(&Path) -> Result<(), String>,
    P: FnMut(QuitStep, QuitStepState),
{
    local_eval::close_for_quit();
    progress(QuitStep::OpenBot, QuitStepState::Running);
    shell
        .start_generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    shell
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let startup = shell.startup.lock().unwrap();
    let root = cleanup_root(shell, fallback_root);
    let mut failures = Vec::new();
    if let Err(problem) = cleanup_host_state(shell, &root, cleanup) {
        failures.push(problem_detail(problem));
    }
    if let Err(problem) = down_containers_with(shell, &root, down) {
        failures.push(format!("Compose down failed: {problem}"));
    }
    #[cfg(target_os = "linux")]
    if let Err(problem) = shell.podman_api.lock().unwrap().stop() {
        failures.push(format!(
            "Container API cleanup failed: {}",
            problem_detail(problem)
        ));
    }
    if failures.is_empty() {
        clear_recovery_required(shell, &root);
    }
    drop(startup);
    progress(
        QuitStep::OpenBot,
        if failures.is_empty() {
            QuitStepState::Complete
        } else {
            QuitStepState::Failed
        },
    );
    let created = created_stack_recorded(&root);
    if created {
        progress(QuitStep::Intelligence, QuitStepState::Running);
    }
    let stopped = intelligence(&root);
    if created || stopped.is_err() {
        progress(QuitStep::Intelligence, QuitStepState::of(&stopped));
    }
    Stopped {
        openbot: failures,
        intelligence: stopped
            .err()
            .map(|problem| format!("{INTELLIGENCE_STOP_FAILED}{problem}")),
    }
}

/// A local Intelligence stack OpenBot created is recorded under `root`, so Stop and Quit stop it.
fn created_stack_recorded(root: &Path) -> bool {
    local_eval_state::read(root, None).is_some_and(|state| state.tied_to_openbot())
}

fn report_exit_cleanup_failures<F>(failures: Vec<String>, sink: F) -> Result<(), String>
where
    F: FnOnce(Vec<String>) -> Result<(), String>,
{
    if failures.is_empty() {
        return Ok(());
    }
    let lines = failures
        .into_iter()
        .map(|failure| format!("[exit] cleanup failed: {failure}"))
        .collect::<Vec<_>>();
    let preserved = lines.join("\n");
    sink(lines).map_err(|error| format!("{error}\n\n{preserved}"))
}

#[derive(Default)]
struct QuitState {
    phase: Mutex<QuitPhase>,
    /// The Shutting down screen's rows.
    status: Mutex<QuitStatus>,
}

#[derive(Default)]
enum QuitPhase {
    #[default]
    Idle,
    Cleaning,
    Complete(i32),
}

type QuitWork = Box<dyn FnOnce() + Send + 'static>;

struct QuitDiagnostics<D, F> {
    sink: D,
    failed: F,
}

fn request_quit_with<C, D, F, E, S>(
    state: std::sync::Arc<QuitState>,
    code: Option<i32>,
    prevent_exit: impl FnOnce(),
    cleanup: C,
    diagnostic: QuitDiagnostics<D, F>,
    exit: E,
    spawn: S,
) -> std::io::Result<()>
where
    C: FnOnce() -> Vec<String> + Send + 'static,
    D: FnOnce(Vec<String>) -> Result<(), String> + Send + 'static,
    F: FnMut(String) + Send + 'static,
    E: FnOnce(i32) + Send + 'static,
    S: FnOnce(QuitWork) -> std::io::Result<()>,
{
    let QuitDiagnostics {
        sink: diagnostic,
        failed: mut diagnostic_failed,
    } = diagnostic;
    let start = {
        let mut phase = state.phase.lock().unwrap();
        match *phase {
            QuitPhase::Complete(saved) if code == Some(saved) => return Ok(()),
            QuitPhase::Idle => {
                *phase = QuitPhase::Cleaning;
                true
            }
            _ => false,
        }
    };
    // Prevent synchronously, before the event callback returns or a worker can request exit.
    prevent_exit();
    if !start {
        return Ok(());
    }
    let completing = std::sync::Arc::clone(&state);
    let code = code.unwrap_or(0);
    let work = Box::new(move || {
        if let Err(error) = report_exit_cleanup_failures(cleanup(), diagnostic) {
            *completing.phase.lock().unwrap() = QuitPhase::Idle;
            diagnostic_failed(error);
            return;
        }
        *completing.phase.lock().unwrap() = QuitPhase::Complete(code);
        exit(code);
    });
    if let Err(error) = spawn(work) {
        *state.phase.lock().unwrap() = QuitPhase::Idle;
        return Err(error);
    }
    Ok(())
}

/// Show OpenBot itself in this window.
///
/// The point of a desktop application is that it is the application. A window that sets things up
/// and then sends somebody to a browser tab is a launcher, and nobody wanted a launcher: they
/// double-clicked OpenBot to get OpenBot.
///
/// So the window navigates to the running app, and the tray keeps the controls that would otherwise
/// have nowhere to live. The connection screen comes back if the stack is stopped.
///
/// The address is asked for rather than named. `stack::app_url` tries `127.0.0.1` and `[::1]` and
/// returns whichever answered, because a dev server binds whichever loopback its runtime resolved
/// and naming one guesses wrong half the time. Never the word `localhost`: it does not resolve the
/// same way on every operating system, which is the whole reason both are asked.
#[tauri::command]
async fn show_openbot<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), Problem> {
    tauri::async_runtime::spawn_blocking(move || {
        let ports = ports_for_shell(&app)?;
        show_openbot_on(app, &ports)
    })
    .await
    .map_err(|error| Problem::with("OpenBot could not open its window.", error.to_string()))?
}

fn ports_for_shell<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<openbot_env::Ports, Problem> {
    let root = cleanup_root(&app.state::<Shell>(), &stack::default_root());
    openbot_env::Ports::read(&root).map_err(|error| {
        Problem::with("OpenBot could not read its local ports.", error.to_string())
    })
}

fn show_openbot_on<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    ports: &openbot_env::Ports,
) -> Result<(), Problem> {
    let port = ports.app;
    // Where it answered, not where it was asked to listen. A dev server binds whichever loopback
    // its runtime resolved `localhost` to, and navigating to the other one shows a blank window
    // that looks like the app failing to start.
    let shell = app.state::<Shell>();
    let _startup = shell.startup.lock().unwrap();
    let root = cleanup_root(&shell, &stack::default_root());
    let organization_recovery = !quit_cleanup_notice_path(&root).exists()
        && shell
            .recovery_required
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|recovery| {
                recovery.root == root
                    && recovery.connection
                        == Some(openbot_desktop_lib::problem::Connection::Organization)
            });
    if recovery_required_or_pending_quit_notice(&shell, &root) && !organization_recovery {
        return Err("Part of OpenBot needs recovery. Try starting OpenBot once more.".into());
    }
    let url = owned_app_url(&root, ports).ok_or_else(|| {
        format!("OpenBot could not verify its app on port {port} belongs to this installation. Try starting OpenBot again.")
    })?;
    let authority =
        openbot_env::already_set(&root.join(".env"), &["OPENBOT_ORGANIZATION_AUTH_URL"])
            .remove("OPENBOT_ORGANIZATION_AUTH_URL")
            .unwrap_or_default();
    let destination = if authority.is_empty() {
        if organization_recovery {
            return Err(Problem::plain(
                "Restore this installation's organization OpenBot URL before signing in.",
            )
            .connection(openbot_desktop_lib::problem::Connection::Organization));
        }
        // Only the owned app itself; an organization's OpenBot is not this machine's page.
        intelligence_bridge::allow(&app, &url);
        url
    } else {
        openbot_desktop_lib::organization_auth::session_destination(&root, &authority, &url)?
    };
    if organization_recovery {
        clear_recovery_required(&shell, &root);
    }
    // Organization destinations can contain a one-use session ticket; never log them.
    eprintln!("[show] navigating to the owned OpenBot app");
    let window = app
        .get_webview_window("main")
        .ok_or("the OpenBot window is not there to show it in")?;
    let outcome = window
        .navigate(
            destination
                .parse()
                .map_err(|_| "OpenBot returned an invalid app destination.".to_string())?,
        )
        .map_err(|_| Problem::plain("OpenBot could not navigate to its app."));
    eprintln!("[show] navigate returned {outcome:?}");
    outcome
}

/// Resolve the configured setup page before WebView2's first navigation completes.
/// Tauri 2's App URL mapping uses devUrl in development and the platform app protocol for
/// bundled files. Keep this aligned with Tauri's get_app_url and prepare_webview mapping:
/// https://v2.tauri.app/reference/config/#webviewurl
fn configured_setup_url(
    config: &tauri::utils::config::Config,
    development: bool,
    windows: bool,
) -> Result<tauri::Url, String> {
    let window = config
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or("the OpenBot setup window is not configured")?;
    match &window.url {
        tauri::WebviewUrl::External(url) | tauri::WebviewUrl::CustomProtocol(url) => {
            Ok(url.clone())
        }
        tauri::WebviewUrl::App(path) => {
            let configured_base = if development {
                config.build.dev_url.as_ref()
            } else {
                match &config.build.frontend_dist {
                    Some(tauri::utils::config::FrontendDist::Url(url)) => Some(url),
                    _ => None,
                }
            };
            let base = match configured_base {
                Some(url) => url.clone(),
                None => {
                    let protocol = if windows {
                        if window.use_https_scheme {
                            "https://tauri.localhost/"
                        } else {
                            "http://tauri.localhost/"
                        }
                    } else {
                        "tauri://localhost/"
                    };
                    protocol
                        .parse()
                        .map_err(|error| format!("invalid setup URL: {error}"))?
                }
            };
            // Tauri omits the default document when creating the initial app URL.
            if path == Path::new("index.html") {
                Ok(base)
            } else {
                base.join(&path.to_string_lossy())
                    .map_err(|error| format!("invalid setup page path: {error}"))
            }
        }
        _ => Err("the OpenBot setup window URL is not supported".into()),
    }
}

fn remember_setup_url<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let setup = configured_setup_url(app.config(), tauri::is_dev(), cfg!(windows))?;
    *app.state::<Shell>().setup_url.lock().unwrap() = Some(setup.to_string());
    Ok(())
}

fn setup_destination<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<tauri::Url, String> {
    // Use the intended setup destination even before the initial page has finished loading.
    let setup = app.state::<Shell>().setup_url.lock().unwrap().clone();
    match setup {
        Some(setup) => setup
            .parse()
            .map_err(|error| format!("{setup} is not a URL: {error}")),
        None => configured_setup_url(app.config(), tauri::is_dev(), cfg!(windows)),
    }
}

/// Put the setup screen back, when there is something to set up again.
#[tauri::command]
fn show_setup<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("the OpenBot window is not there")?;
    window
        .navigate(setup_destination(&app)?)
        .map_err(|error| format!("could not go back to setup: {error}"))
}

/// The setup screens' background in light and in dark, which the macOS title bar takes while they
/// show. The same values as `--surface-main` in styles.css.
const SETUP_BACKGROUND: tauri::window::Color = tauri::window::Color(0xde, 0xde, 0xe9, 0xff);
const SETUP_BACKGROUND_DARK: tauri::window::Color = tauri::window::Color(0x01, 0x05, 0x07, 0xff);

/// Whether `url` is the setup page rather than OpenBot.
fn on_setup_page<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &tauri::Url) -> bool {
    let setup = app.state::<Shell>().setup_url.lock().unwrap().clone();
    setup
        .and_then(|setup| setup.parse::<tauri::Url>().ok())
        .is_some_and(|setup| same_window_app(&setup, url))
}

/**
The appearance the setup screens use: the system's (a product choice, 2026-10-23). Both themes
exist; the page follows the window's appearance through `prefers-color-scheme`, so `Some(Dark)` or
`Some(Light)` here pins one instead.
*/
const SETUP_THEME: Option<tauri::Theme> = None;

/// What the window is showing, as far as its chrome is concerned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowPage {
    Setup,
    /// OpenBot served from this machine: its sidebar takes the title bar's place.
    OwnedApp,
    /// OpenBot served from this machine, from a release whose styles make no room for the window
    /// buttons: the system's title bar, still in the app's own light or dark.
    LocalApp,
    /// Anything else, such as an organization's OpenBot: the system's title bar.
    Other,
}

fn window_page<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &tauri::Url) -> WindowPage {
    if on_setup_page(app, url) {
        WindowPage::Setup
    } else if url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
    {
        if app_makes_room_for_window_buttons(&cleanup_root(
            &app.state::<Shell>(),
            &stack::default_root(),
        )) {
            WindowPage::OwnedApp
        } else {
            WindowPage::LocalApp
        }
    } else {
        WindowPage::Other
    }
}

/**
Whether the OpenBot installed under `root` pads its sidebar for the window's buttons.

The overlay title bar needs the page's help: without the room its styles make, the buttons sit on
the sidebar's name. Releases before that change (v0.2.0 among them) do not have it, so they keep the
system's title bar. Read from the installed source the app is built from, which is what the page
is.
*/
fn app_makes_room_for_window_buttons(root: &Path) -> bool {
    std::fs::read_to_string(root.join("app/src/styles.css"))
        .is_ok_and(|styles| styles.contains("data-desktop-titlebar"))
}

/**
The window's appearance and title bar for the page it shows.

Setup: the setup screens' theme, a transparent title bar over their ground, the title shown. The
window starts this way (in `setup`), so the first paint already matches.

OpenBot from this machine: one surface, as Mac apps with a sidebar have it. The title bar becomes an
overlay, its title text is hidden (the sidebar carries the name), and the page is marked so its
sidebar makes room for the window buttons and works as the drag handle (`OVERLAY_TITLE_BAR_PAGE`).

Anything else gets the system's bar back, since a page this app did not style cannot make room.
*/
fn match_title_bar<R: tauri::Runtime>(window: &tauri::Window<R>, page: WindowPage) {
    // OpenBot's own page sets the window's appearance to its own light or dark (`APP_THEME_PAGE`);
    // setting it here as well would undo that on every theme event.
    match page {
        WindowPage::Setup => {
            let _ = window.set_theme(SETUP_THEME);
        }
        WindowPage::OwnedApp | WindowPage::LocalApp => {}
        WindowPage::Other => {
            let _ = window.set_theme(None);
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = window.set_title_bar_style(match page {
            WindowPage::Setup => tauri::TitleBarStyle::Transparent,
            WindowPage::OwnedApp => tauri::TitleBarStyle::Overlay,
            WindowPage::LocalApp | WindowPage::Other => tauri::TitleBarStyle::Visible,
        });
        let ground = match SETUP_THEME.map_or_else(|| window.theme().ok(), Some) {
            Some(tauri::Theme::Dark) => SETUP_BACKGROUND_DARK,
            _ => SETUP_BACKGROUND,
        };
        let _ = window.set_background_color((page == WindowPage::Setup).then_some(ground));
        show_window_title(window, page != WindowPage::OwnedApp);
    }
}

/// The title text in the title bar. AppKit, so on the main thread.
#[cfg(target_os = "macos")]
fn show_window_title<R: tauri::Runtime>(window: &tauri::Window<R>, shown: bool) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(ns_window) = target.ns_window() else {
            return;
        };
        // NSWindowTitleVisible = 0, NSWindowTitleHidden = 1.
        let visibility: isize = if shown { 0 } else { 1 };
        // SAFETY: `ns_window` is this window's live NSWindow, used on the main thread.
        unsafe {
            let ns_window = ns_window.cast::<objc2::runtime::AnyObject>();
            let _: () = objc2::msg_send![ns_window, setTitleVisibility: visibility];
        }
    });
}

/**
Marks OpenBot's page for the overlay title bar: its styles pad the sidebar's header for the window
buttons, and the header becomes the drag handle. The sidebar renders after the page loads and again
on navigation, so new headers are marked as they appear, at most once a frame.
*/
const OVERLAY_TITLE_BAR_PAGE: &str = r#"(() => {
  document.documentElement.dataset.desktopTitlebar = "overlay";
  const mark = () => {
    for (const header of document.querySelectorAll('[data-slot="sidebar-header"]:not([data-tauri-drag-region])')) {
      header.setAttribute("data-tauri-drag-region", "");
    }
  };
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; mark(); });
  }).observe(document.documentElement, { childList: true, subtree: true });
  mark();
})();"#;

/**
Keeps the window's appearance on OpenBot's own light or dark, which it chooses itself (Settings)
rather than following the system.

MEASURED: with the Mac in dark and OpenBot set to light, the window kept the dark appearance, and
macOS drew its dark-window outline, a black line, around a light window. The page sets the window's
theme to its own whenever its `dark` class changes, through `desktop_page::appearance`.
*/
const APP_THEME_PAGE: &str = r#"(() => {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") return;
  let applied = null;
  const sync = () => {
    const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
    if (theme === applied) return;
    applied = theme;
    internals
      .invoke("plugin:openbot-desktop|appearance", { dark: theme === "dark" })
      .catch(() => {});
  };
  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  sync();
})();"#;

/// Lets OpenBot's own page move and zoom the window from its drag handle, set the window's
/// appearance to its own theme, and use Settings → This computer (`desktop_page`), and nothing more.
fn allow_window_drag<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &tauri::Url) {
    static GRANTED: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let origin = url.origin().ascii_serialization();
    let mut granted = GRANTED.lock().unwrap();
    if granted.contains(&origin) {
        return;
    }
    let mut capability =
        tauri::ipc::CapabilityBuilder::new(format!("openbot-app-window-{}", granted.len()))
            .remote(format!("{origin}/*"))
            .local(false)
            .window("main")
            .permission("core:window:allow-start-dragging")
            .permission("core:window:allow-internal-toggle-maximize");
    for permission in desktop_page::PERMISSIONS {
        capability = capability.permission(permission);
    }
    match app.add_capability(capability) {
        Ok(()) => granted.push(origin),
        Err(error) => eprintln!("[window] could not let the app page drag the window: {error}"),
    }
}

/// Where the Status window's page is: the setup page, at `#status`.
const STATUS_FRAGMENT: &str = "status";

/**
The Status window: what OpenBot is running, what it costs, and Restart and Stop for each part.

Its own window rather than a page of the main one, so looking at it never takes OpenBot off the
screen. Closing it hides it, as the main window does; it reads everything again when shown.
*/
fn show_status_window(app: &tauri::AppHandle) {
    if show_status_in_app(app) {
        return;
    }
    if let Some(window) = app.get_webview_window("status") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let Ok(mut url) = setup_destination(app) else {
        return;
    };
    url.set_fragment(Some(STATUS_FRAGMENT));
    let page = if matches!(url.scheme(), "http" | "https") {
        tauri::WebviewUrl::External(url)
    } else {
        tauri::WebviewUrl::CustomProtocol(url)
    };
    let built = tauri::WebviewWindowBuilder::new(app, "status", page)
        .title("OpenBot Status")
        .inner_size(640.0, 720.0)
        .min_inner_size(520.0, 480.0)
        .build();
    if let Err(error) = built {
        eprintln!("[status] could not open the Status window: {error}");
    }
}

/// Where OpenBot's Settings → This computer lives, in releases that have it.
const COMPUTER_SETTINGS_PATH: &str = "/settings/computer";

/**
Status in OpenBot itself, Settings → This computer, when the OpenBot running here has that page:
the main window goes there. True when it did. Otherwise, with OpenBot stopped or from a release
without the page, the Status window does the job.
*/
fn show_status_in_app(app: &tauri::AppHandle) -> bool {
    let root = cleanup_root(&app.state::<Shell>(), &stack::default_root());
    if !root
        .join("app/src/routes/_authed/settings/computer.tsx")
        .is_file()
    {
        return false;
    }
    let Some(mut url) = ports_for_shell(app)
        .ok()
        .and_then(|ports| owned_app_url(&root, &ports))
        .and_then(|url| url.parse::<tauri::Url>().ok())
    else {
        return false;
    };
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    url.set_path(COMPUTER_SETTINGS_PATH);
    intelligence_bridge::allow(app, url.as_str());
    if window.navigate(url).is_err() {
        return false;
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    true
}

/// What the Status window shows. Read fresh each time; nothing here is kept.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopStatus {
    /// OpenBot's host processes are up.
    openbot_running: bool,
    processes: Vec<desktop_status::Part>,
    containers: Vec<desktop_status::Part>,
    /// The local Intelligence stack recorded for this installation, if any.
    intelligence_stack: Option<String>,
    intelligence_containers: Vec<desktop_status::Part>,
    /// "docker" or "podman", answering now; None when nothing answers.
    engine: Option<&'static str>,
    root: String,
    app_port: Option<u16>,
    version: &'static str,
    build: String,
}

#[tauri::command]
async fn desktop_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<DesktopStatus, String> {
    tauri::async_runtime::spawn_blocking(move || read_desktop_status(&app))
        .await
        .map_err(|error| format!("the status could not be read: {error}"))
}

fn read_desktop_status<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> DesktopStatus {
    let shell = app.state::<Shell>();
    let root = cleanup_root(&shell, &stack::default_root());
    let pids: Vec<(&'static str, u32)> = shell
        .children
        .lock()
        .unwrap()
        .iter()
        .map(|(name, child)| (*name, child.id()))
        .collect();
    let processes = resident_parts(&pids);
    let stack_id =
        local_eval_state::read(&root, None).map(|state| state.stack_id().as_str().to_owned());
    let found = engine::detect();
    let running = found.engine.filter(|_| found.responding);
    let (containers, intelligence_containers) = match running {
        Some(running) => {
            let mut stats = quiet::command(
                engine::program(running).unwrap_or_else(|| PathBuf::from(running.binary())),
            );
            stats.args([
                "stats",
                "--no-stream",
                "--format",
                "{{.Name}}\t{{.MemUsage}}",
            ]);
            if let Some(path) = engine::path_with_docker() {
                stats.env("PATH", path);
            }
            let stats = stats
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
                .unwrap_or_default();
            desktop_status::containers(&stats, stack_id.as_deref())
        }
        None => (Vec::new(), Vec::new()),
    };
    DesktopStatus {
        openbot_running: !pids.is_empty(),
        processes,
        containers,
        intelligence_stack: stack_id,
        intelligence_containers,
        engine: running.map(|engine| engine.binary()),
        root: root.display().to_string(),
        app_port: ports_for_shell(app).ok().map(|ports| ports.app),
        version: env!("CARGO_PKG_VERSION"),
        build: build_description(
            env!("OPENBOT_BUILD_COMMIT"),
            env!("OPENBOT_BUILD_BRANCH"),
            env!("OPENBOT_BUILD_TIME").parse().unwrap_or_default(),
        ),
    }
}

/// Each host process by name, with its resident memory where `ps` could read it.
fn resident_parts(pids: &[(&'static str, u32)]) -> Vec<desktop_status::Part> {
    let sizes = if pids.is_empty() {
        Vec::new()
    } else {
        let list = pids
            .iter()
            .map(|(_, pid)| pid.to_string())
            .collect::<Vec<_>>()
            .join(",");
        quiet::command("ps")
            .args(["-o", "pid=,rss=", "-p", &list])
            .output()
            .ok()
            .map(|output| desktop_status::resident(&String::from_utf8_lossy(&output.stdout)))
            .unwrap_or_default()
    };
    pids.iter()
        .map(|(name, pid)| desktop_status::Part {
            name: (*name).to_owned(),
            memory_bytes: sizes
                .iter()
                .find(|(found, _)| found == pid)
                .map(|(_, bytes)| *bytes),
        })
        .collect()
}

/**
Restart OpenBot's host processes: each is ended, and the supervisor that keeps them alive starts it
again, as it would after a crash. The containers, its database among them, keep running, so nothing
is lost and the restart takes seconds.
*/
#[tauri::command]
fn restart_openbot<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let shell = app.state::<Shell>();
    let mut children = shell.children.lock().unwrap();
    if children.is_empty() {
        return Err("OpenBot is not running.".into());
    }
    for (name, child) in children.iter_mut() {
        // SAFETY: the pid is this app's own child, held and not yet reaped, so it cannot be reused.
        #[cfg(unix)]
        let ended = unsafe { libc::kill(child.id() as i32, libc::SIGTERM) } == 0;
        #[cfg(not(unix))]
        let ended = child.kill().is_ok();
        if !ended {
            eprintln!("[status] could not restart {name}");
        }
    }
    Ok(())
}

/// Stop, as the menu used to offer it: everything, Intelligence included if OpenBot started it.
#[tauri::command]
fn stop_openbot_from_status(app: tauri::AppHandle) {
    stop_from_menu(app);
}

/// Both pages are single-page apps. Keep their route and in-memory state on restore.
/// Compare the authority explicitly: tauri:// has an opaque URL origin.
fn same_window_app(current: &tauri::Url, destination: &tauri::Url) -> bool {
    destination.host_str().is_some()
        && current.scheme() == destination.scheme()
        && current.host_str() == destination.host_str()
        && current.port_or_known_default() == destination.port_or_known_default()
}

fn show_setup_and_focus<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    show_setup(app.clone())?;
    let window = app
        .get_webview_window("main")
        .ok_or("the OpenBot window is not there")?;
    window
        .show()
        .map_err(|error| format!("could not show setup: {error}"))?;
    window
        .unminimize()
        .map_err(|error| format!("could not unminimize setup: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("could not focus setup: {error}"))
}

/// Is a deployment this app manages already running?
///
/// The shell keeps what it started in memory, so closing the window and opening it again forgets a
/// stack that is still up. Without asking, the second launch offers to set up something already
/// running, and the port check then reports OpenBot as a foreign process holding its own port.
///
/// Asked of the deployment rather than of a file: a stamp says a deployment was installed, and only
/// an answer on the port says one is running now.
fn server_capabilities_answer(port: u16) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .ok()
        .and_then(|client| {
            client
                .get(format!("http://127.0.0.1:{port}/api/capabilities"))
                .send()
                .ok()
        })
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn already_running_on<F>(root: &Path, port: u16, owns_server: F) -> bool
where
    F: FnOnce(&Path, u16) -> Result<bool, Problem>,
{
    if deployment::installed(root).is_none() {
        return false;
    }
    server_capabilities_answer(port) && owns_server(root, port).unwrap_or(false)
}

#[tauri::command]
fn already_running<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String) -> bool {
    let root = stack::root_from(&root);
    let shell = app.state::<Shell>();
    let _startup = shell.startup.lock().unwrap();
    !recovery_required_or_pending_quit_notice(&shell, &root)
        && openbot_env::Ports::read(&root).is_ok_and(|ports| already_running_at(&root, &ports))
}

fn already_running_at(root: &Path, ports: &openbot_env::Ports) -> bool {
    owned_app_url(root, ports).is_some()
}

/// Neither an owned API nor an answering app port alone authorizes showing a deployment.
fn owned_app_url(root: &Path, ports: &openbot_env::Ports) -> Option<String> {
    if !already_running_on(root, ports.server, stack::recorded_server_owns_port)
        || !stack::recorded_process_owns_port(root, "app", ports.app).unwrap_or(false)
    {
        return None;
    }
    stack::app_url(ports.app)
}

/// What stopped the stack, if anything did, and forget it once it has been read.
///
/// Cleared on reading so a failure from an hour ago does not greet somebody who has since fixed it.
#[tauri::command]
fn last_failure<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Option<openbot_desktop_lib::problem::Problem> {
    let shell = app.state::<Shell>();
    if let Some(problem) = shell.last_failure.lock().unwrap().take() {
        return Some(problem);
    }
    let _startup = shell.startup.lock().unwrap();
    let root = cleanup_root(&shell, &stack::default_root());
    if !quit_cleanup_notice_path(&root).exists() {
        return None;
    }
    recovery_required_or_pending_quit_notice(&shell, &root);
    match read_quit_cleanup_notice(&root) {
        Ok(problem) => problem,
        Err(problem) => Some(problem),
    }
}

#[tauri::command]
fn default_root() -> String {
    stack::default_root().to_string_lossy().into_owned()
}

#[tauri::command]
fn selected_root(app: tauri::AppHandle) -> Option<String> {
    app.state::<Shell>()
        .selected_root
        .lock()
        .unwrap()
        .as_ref()
        .map(|root| root.to_string_lossy().into_owned())
}

/**
Put the wizard's last question to the Bot, and hand back what it said.

THE DEFINITION OF DONE FOR AN INSTALL. Everything before this proves that things started; only this
proves the configuration works. See `ask` for why a run that says nothing is a failure rather than
an empty answer, and why the harness's log is fetched to fill the developer half.

The endpoint and the token come out of the `.env` this run just wrote, not from the window. They are
facts about the deployment, and a window carrying them would be a second copy to keep in step.
*/
#[tauri::command]
async fn ask_the_bot<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: String,
    question: String,
) -> Result<String, openbot_desktop_lib::problem::Problem> {
    let result = ask_the_bot_inner(stack::root_from(&root), question).await;
    if result.is_ok() {
        desktop_telemetry::record(&app, telemetry::EventData::Activated);
    } else {
        desktop_telemetry::failure(&app, telemetry::SetupErrorClass::Unknown);
    }
    result
}

async fn ask_the_bot_inner(root: PathBuf, question: String) -> Result<String, Problem> {
    // The addresses come from the file and the token from the credential store, which is where
    // this run put it. Asked for together, because one without the other cannot ask anything.
    let settings = ask_saved_settings(&root)?;
    // The server's own address, so a picked Bot is asked through the runtime and the question is
    // a thread in Intelligence. See `ask::ask_through_server`. Only a server this root's stack
    // runs: whatever else answers on that port is not this deployment's. Checking asks the port,
    // which blocks.
    let checked = root.clone();
    let server = tauri::async_runtime::spawn_blocking(move || {
        openbot_env::Ports::read(&checked)
            .ok()
            .filter(|ports| {
                already_running_on(&checked, ports.server, stack::recorded_server_owns_port)
            })
            .map(|ports| format!("http://127.0.0.1:{}", ports.server))
    })
    .await
    .ok()
    .flatten();
    ask_the_bot_via(root, question, settings, server).await
}

fn ask_saved_settings(root: &Path) -> Result<std::collections::BTreeMap<String, String>, Problem> {
    openbot_desktop_lib::vault::already_given_no_ui(
        root,
        &root.join(".env"),
        &[
            "PICKED_HARNESS_URL",
            "PICKED_HARNESS_KIND",
            "PICKED_HARNESS_SOURCE",
            "PICKED_HARNESS_AGENT_ID",
            "MANAGED_AGENT_AG_UI_URL",
            "MANAGED_AGENT_TOKEN",
        ],
    )
}

/// `ask_the_bot_via` straight to the harness, with no server to record a thread.
#[cfg(test)]
async fn ask_the_bot_with_settings(
    root: PathBuf,
    question: String,
    settings: std::collections::BTreeMap<String, String>,
) -> Result<String, openbot_desktop_lib::problem::Problem> {
    ask_the_bot_via(root, question, settings, None).await
}

async fn ask_the_bot_via(
    root: PathBuf,
    question: String,
    settings: std::collections::BTreeMap<String, String>,
    server: Option<String>,
) -> Result<String, openbot_desktop_lib::problem::Problem> {
    // The picked harness if there is one, and the Bot that ships with OpenBot if there is not.
    // Both speak AG-UI at the same address shape, so this screen does not care which it got.
    let picked_endpoint = settings
        .get("PICKED_HARNESS_URL")
        .filter(|url| !url.trim().is_empty());
    let (endpoint, log_service, kind, agent_id) = match picked_endpoint {
        Some(endpoint) => (
            endpoint.clone(),
            // Only a selection this install explicitly recorded as local can explain itself
            // through Compose logs. Legacy/unknown provenance and stale IMAGE/PORT do not.
            (settings.get("PICKED_HARNESS_SOURCE").map(String::as_str) == Some("installed"))
                .then_some("agent-harness"),
            settings.get("PICKED_HARNESS_KIND").cloned(),
            settings.get("PICKED_HARNESS_AGENT_ID").cloned(),
        ),
        None => (
            settings
                .get("MANAGED_AGENT_AG_UI_URL")
                .cloned()
                .unwrap_or_default(),
            Some("agent-langgraph"),
            None,
            None,
        ),
    };
    let token = settings
        .get("MANAGED_AGENT_TOKEN")
        .cloned()
        .unwrap_or_default();
    if endpoint.trim().is_empty() || token.trim().is_empty() {
        return Err(openbot_desktop_lib::problem::Problem::plain(
            "OpenBot cannot find the Bot it just set up. Stop OpenBot and start it again.",
        ));
    }

    let question = if question.trim().is_empty() {
        openbot_desktop_lib::ask::SUGGESTED.to_string()
    } else {
        question
    };

    // A picked Bot is the server's `picked-harness`, asked through the runtime so the question and
    // its answer are a thread in Intelligence. The Bot that ships with OpenBot is asked directly.
    let through = server.filter(|_| picked_endpoint.is_some());
    let asked = tauri::async_runtime::spawn_blocking(move || {
        let answered = match &through {
            Some(server) => openbot_desktop_lib::ask::ask_through_server(
                server,
                openbot_desktop_lib::ask::PICKED_HARNESS_AGENT,
                &question,
            ),
            None => openbot_desktop_lib::ask::ask_harness(
                &endpoint,
                &token,
                &question,
                kind.as_deref(),
                agent_id.as_deref(),
            ),
        };
        match answered {
            Ok(answer) => Ok(answer),
            // An empty sentence carries no cause. Local logs can explain an installed Bot;
            // they cannot explain a BYO endpoint, even when an old local harness still has logs.
            Err(problem) if problem.said.is_empty() && log_service.is_none() => {
                Err(Some(Problem::with(
                    "The Bot at the selected endpoint returned no answer text. Check that endpoint's logs and ask again.",
                    format!("endpoint {endpoint}\nThe run returned no answer text."),
                )))
            }
            Err(problem) if problem.said.is_empty() => Err(None),
            Err(problem) => Err(Some(problem)),
        }
    })
    .await
    .map_err(|error| {
        openbot_desktop_lib::problem::Problem::plain(format!(
            "The question could not be asked: {error}"
        ))
    })?;

    match asked {
        Ok(answer) => Ok(answer),
        Err(Some(problem)) => Err(problem),
        Err(None) => {
            let log = log_service
                .and_then(|service| {
                    engine::detect()
                        .address
                        .map(|found| stack::service_log(&found, &root, service, 40))
                })
                .unwrap_or_default();
            Err(openbot_desktop_lib::ask::why_nothing_came_back(&log))
        }
    }
}

/**
What a previous run already wrote, so the wizard can arrive filled in.

Returned to the window because that is where the fields are, and it is the same machine and the
same person: reading their own file back to them is not a disclosure. The key is not logged here or
anywhere, and only the settings the wizard asks about are read.
*/
#[tauri::command]
fn already_configured<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: String,
) -> AlreadyConfigured {
    let mut configured = already_configured_for_root(root);
    configured.auto_start = !app
        .state::<Shell>()
        .stopped_in_session
        .load(std::sync::atomic::Ordering::SeqCst);
    configured
}

fn already_configured_for_root(root: String) -> AlreadyConfigured {
    let root = stack::root_from(&root);
    let env_file = root.join(".env");
    let mut values = openbot_desktop_lib::vault::already_given_file_only(
        &env_file,
        &[
            "INTELLIGENCE_API_KEY",
            "INTELLIGENCE_API_URL",
            "INTELLIGENCE_GATEWAY_WS_URL",
            "OPENBOT_ORGANIZATION_AUTH_URL",
            /*
             * The model credentials too, so the wizard never asks twice for one of these either.
             *
             * A key already in the file is one somebody has already produced, and making them find
             * it again means opening a dotfile in an editor. Read back for the same reason the
             * Intelligence key is: it is their own file, on their own machine, and this is the
             * screen that asks for it.
             */
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "OPENAI_BASE_URL",
            "OPENAI_CONTAINER_BASE_URL",
            "BOT_MODEL",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ],
    );

    use openbot_desktop_lib::saved_intent::{Category, SavedIntent};
    let intent = SavedIntent::read(&root);
    let hint = |category, file_present| {
        (file_present || intent.categories.contains(&category)).then_some(true)
    };
    let claude_plan = values.remove("CLAUDE_CODE_OAUTH_TOKEN").is_some();
    AlreadyConfigured {
        launch: preparation::launch(&root),
        installation: preparation::installation(&root),
        auto_start: true,
        local_eval: local_eval_state::read(&root, None),
        saved: SavedConfiguration {
            intelligence_api_key: hint(
                Category::Intelligence,
                values.contains_key("INTELLIGENCE_API_KEY"),
            ),
            model_api_keys: SavedModelApiKeys {
                openai: hint(
                    Category::OpenAiApiKey,
                    values.contains_key("OPENAI_API_KEY"),
                ),
                anthropic: hint(
                    Category::AnthropicApiKey,
                    values.contains_key("ANTHROPIC_API_KEY"),
                ),
                compatible: values
                    .get("OPENAI_BASE_URL")
                    .is_some_and(|url| intent.has_compatible_key_for(url))
                    .then_some(true),
            },
            model_sessions: SavedModelSessions {
                openai: hint(
                    Category::ChatGptPlan,
                    openbot_env::saved_chatgpt_plan_store(&root),
                ),
                anthropic: hint(Category::ClaudePlan, claude_plan),
                google: hint(Category::GoogleOauth, false),
                xai: hint(Category::XaiOauth, false),
            },
            model: intent.model,
        },
        values,
    }
}

/// The harness picker's rows. Data, so the screen is a list and not twelve branches.
#[tauri::command]
fn harnesses() -> Vec<harness::Harness> {
    harness::catalogue()
}

/// Start a Claude plan sign-in and return the address a browser has to open.
///
/// Blocking work on a blocking thread: it starts a container and waits on its output, and doing
/// that on the UI thread is a window that stops repainting mid-setup.
#[tauri::command]
async fn begin_claude_sign_in(app: tauri::AppHandle, root: String) -> Result<String, Problem> {
    let root = stack::root_from(&root);
    remember_selected_root(&app.state::<Shell>(), &root);
    /*
     * The image is decided here, not by the window, and it is the Claude Agent SDK harness whatever
     * harness the person picked. It is not being used as a Bot: it is the container that happens to
     * carry Anthropic's bundled CLI, which is what does the OAuth. Letting the screen name an image
     * would make the sign-in depend on a choice that has nothing to do with it.
     */
    #[cfg(target_os = "linux")]
    let service_app = app.clone();
    let (signing, url) = tauri::async_runtime::spawn_blocking(move || {
        let (address, image) = prepared_sign_in(&root, openbot_desktop_lib::plan::SIGN_IN_IMAGE)?;
        #[cfg(target_os = "linux")]
        {
            let shell = service_app.state::<Shell>();
            let _startup = shell.startup.lock().unwrap();
            ensure_linux_podman_api(&shell, &address)?;
        }
        openbot_desktop_lib::plan::SigningIn::begin(&address, &image).map_err(Problem::from)
    })
    .await
    .map_err(|error| {
        Problem::with(
            "The sign-in did not start. Try again.",
            format!("the sign-in task did not run: {error}"),
        )
    })??;
    *app.state::<Shell>().signing_in.lock().unwrap() = Some(signing);

    /*
     * Opened here rather than by the window, because the window would need the shell plugin's JS
     * half for the one call. The URL is returned as well, and the screen shows it: on Linux without
     * a registered browser, and in a session where the open silently does nothing, a link somebody
     * can copy is the difference between a stuck screen and a finished sign-in.
     */
    let _ = tauri_plugin_opener::OpenerExt::opener(&app).open_url(&url, None::<&str>);
    Ok(url)
}

/**
Redeem the code from the browser and return the plan token.

The token crosses to the window and comes back in the model choice, which is the same path a typed
key takes. It is never logged, and the failure messages never carry the command's output: see
`SigningIn::gave_up`.
*/
#[tauri::command]
async fn finish_claude_sign_in(app: tauri::AppHandle, code: String) -> Result<String, String> {
    // Taken, not borrowed. A sign-in is single-use, and leaving it in place would let a second
    // attempt write a code into a flow that has already finished.
    let signing = app
        .state::<Shell>()
        .signing_in
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "That sign-in is no longer running. Start it again.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || signing.finish(&code))
        .await
        .map_err(|error| format!("The sign-in did not finish: {error}"))?
}

/// Start a ChatGPT plan sign-in and return the address a browser has to open.
#[tauri::command]
async fn begin_chatgpt_sign_in(
    app: tauri::AppHandle,
    root: String,
) -> Result<String, openbot_desktop_lib::problem::Problem> {
    let root = stack::root_from(&root);
    remember_selected_root(&app.state::<Shell>(), &root);
    #[cfg(target_os = "linux")]
    let service_app = app.clone();
    let (signing, url) = tauri::async_runtime::spawn_blocking(move || {
        let (address, image) =
            prepared_sign_in(&root, openbot_desktop_lib::plan::CHATGPT_SIGN_IN_IMAGE)?;
        #[cfg(target_os = "linux")]
        {
            let shell = service_app.state::<Shell>();
            let _startup = shell.startup.lock().unwrap();
            ensure_linux_podman_api(&shell, &address)?;
        }
        openbot_desktop_lib::plan::SigningInToChatGpt::begin(&address, &image)
    })
    .await
    .map_err(|error| {
        Problem::with(
            "The sign-in did not start. Try again.",
            format!("the sign-in task did not run: {error}"),
        )
    })??;
    *app.state::<Shell>().signing_in_to_chatgpt.lock().unwrap() = Some(signing);
    let _ = tauri_plugin_opener::OpenerExt::opener(&app).open_url(&url, None::<&str>);
    Ok(url)
}

/**
Wait for the ChatGPT redirect to land, and return the plan token.

Nothing is sent: the browser's callback is what finishes it. So this is a wait rather than a
redemption, which is why there is no code field on that half of the screen.
*/
#[tauri::command]
async fn finish_chatgpt_sign_in(app: tauri::AppHandle) -> Result<String, String> {
    let signing = app
        .state::<Shell>()
        .signing_in_to_chatgpt
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "That sign-in is no longer running. Start it again.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || signing.finish())
        .await
        .map_err(|error| format!("The sign-in did not finish: {error}"))?
}

/// A self-hosted server authenticates in its own browser session. Only the selected project's
/// runtime key crosses into the window; the helper owns and then closes the temporary browser.
#[tauri::command]
async fn begin_self_hosted_intelligence_sign_in(
    app: tauri::AppHandle,
    root: String,
    api_url: String,
) -> Result<Vec<openbot_desktop_lib::intelligence::Project>, Problem> {
    let root = stack::root_from(&root);
    let shell = app.state::<Shell>();
    remember_selected_root(&shell, &root);
    cancel_self_hosted_sign_in(&shell);
    let generation = shell
        .self_hosted_sign_in_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let bun = preparation::dependencies_ready(&root)?;
        let shell = app.state::<Shell>();
        let signing = {
            let mut slot = shell.self_hosted_intelligence.lock().unwrap();
            if generation
                != shell
                    .self_hosted_sign_in_generation
                    .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err(Problem::plain("That Intelligence sign-in was cancelled."));
            }
            let signing = openbot_desktop_lib::self_hosted_intelligence::SigningIn::begin(
                &root, &bun, &api_url,
            )?;
            *slot = Some(signing.clone());
            signing
        };
        let result = signing.projects();
        if result.is_err() {
            let mut slot = shell.self_hosted_intelligence.lock().unwrap();
            if slot
                .as_ref()
                .is_some_and(|active| std::sync::Arc::ptr_eq(active, &signing))
            {
                slot.take();
            }
            drop(slot);
            signing.cancel();
        }
        result
    })
    .await
    .map_err(|_| Problem::plain("Intelligence sign-in could not finish."))?
}

#[tauri::command]
async fn finish_self_hosted_intelligence_sign_in(
    app: tauri::AppHandle,
    root: String,
    project: String,
) -> Result<String, Problem> {
    let root = stack::root_from(&root);
    let signing = app
        .state::<Shell>()
        .self_hosted_intelligence
        .lock()
        .unwrap()
        .clone()
        .filter(|signing| signing.root == root)
        .ok_or_else(|| Problem::plain("Sign in to this Intelligence server first."))?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = signing.connect(&project);
        let shell = app.state::<Shell>();
        let mut slot = shell.self_hosted_intelligence.lock().unwrap();
        if !slot
            .as_ref()
            .is_some_and(|active| std::sync::Arc::ptr_eq(active, &signing))
        {
            return Err(Problem::plain("That Intelligence sign-in was cancelled."));
        }
        slot.take();
        let provisioned = match result {
            Ok(provisioned) => provisioned,
            Err(problem) => {
                drop(slot);
                signing.cancel();
                return Err(problem);
            }
        };
        let key = provisioned.api_key.clone();
        *shell.intelligence_learning.lock().unwrap() = Some(provisioned);
        Ok(key)
    })
    .await
    .map_err(|_| Problem::plain("Intelligence sign-in could not finish."))?
}

#[tauri::command]
async fn cancel_self_hosted_intelligence_sign_in(app: tauri::AppHandle) -> Result<(), Problem> {
    tauri::async_runtime::spawn_blocking(move || cancel_self_hosted_sign_in(&app.state::<Shell>()))
        .await
        .map_err(|_| Problem::plain("The Intelligence sign-in could not be closed."))
}

/// Start signing in to Intelligence and return the address a browser has to open.
#[tauri::command]
async fn begin_intelligence_sign_in(app: tauri::AppHandle) -> Result<String, String> {
    let (signing, url) = openbot_desktop_lib::intelligence::SigningInToIntelligence::begin()?;
    *app.state::<Shell>()
        .signing_in_to_intelligence
        .lock()
        .unwrap() = Some(signing);
    let _ = tauri_plugin_opener::OpenerExt::opener(&app).open_url(&url, None::<&str>);
    Ok(url)
}

/// Wait for that sign-in, and answer with the projects it can see.
///
/// The credential is kept on this side rather than handed to the window: the window's business is
/// which project, and a credential it never holds is one it cannot leak into a log or a screenshot.
#[tauri::command]
async fn finish_intelligence_sign_in(
    app: tauri::AppHandle,
) -> Result<Vec<openbot_desktop_lib::intelligence::Project>, openbot_desktop_lib::problem::Problem>
{
    let signing = app
        .state::<Shell>()
        .signing_in_to_intelligence
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| {
            openbot_desktop_lib::problem::Problem::plain(
                "That sign-in is no longer running. Start it again.",
            )
        })?;
    let (credential, projects) = tauri::async_runtime::spawn_blocking(move || signing.finish())
        .await
        .map_err(|error| {
            openbot_desktop_lib::problem::Problem::plain(format!(
                "The sign-in did not finish: {error}"
            ))
        })??;
    *app.state::<Shell>().intelligence_credential.lock().unwrap() = Some(credential);
    Ok(projects)
}

/// Create a project using the account already signed in, without exposing its credential to the UI.
#[tauri::command]
async fn create_intelligence_project(
    app: tauri::AppHandle,
    name: String,
) -> Result<openbot_desktop_lib::intelligence::Project, Problem> {
    let credential = app
        .state::<Shell>()
        .intelligence_credential
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| Problem::plain("Sign in to CopilotKit first."))?;
    tauri::async_runtime::spawn_blocking(move || {
        openbot_desktop_lib::intelligence::create_project(&credential, &name)
    })
    .await
    .map_err(|error| Problem::with("Your project could not be created.", error.to_string()))?
}

/// Create a key for the project somebody chose, and hand it back for the field.
#[tauri::command]
async fn intelligence_key_for(
    app: tauri::AppHandle,
    project: String,
) -> Result<String, openbot_desktop_lib::problem::Problem> {
    let credential = app
        .state::<Shell>()
        .intelligence_credential
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| {
            openbot_desktop_lib::problem::Problem::plain("Sign in to CopilotKit first.")
        })?;
    let provisioned = tauri::async_runtime::spawn_blocking(move || {
        openbot_desktop_lib::intelligence::provision_connection(&credential, &project)
    })
    .await
    .map_err(|error| {
        openbot_desktop_lib::problem::Problem::plain(format!("A key could not be created: {error}"))
    })??;
    let key = provisioned.api_key.clone();
    *app.state::<Shell>().intelligence_learning.lock().unwrap() = Some(provisioned);
    Ok(key)
}

#[tauri::command]
async fn begin_organization_sign_in(
    app: tauri::AppHandle,
    root: String,
    authority_url: String,
    provider: String,
) -> Result<String, Problem> {
    let root = stack::root_from(&root);
    let handle = app.clone();
    let url = tauri::async_runtime::spawn_blocking(move || {
        let shell = handle.state::<Shell>();
        let _startup = shell.startup.lock().unwrap();
        if shell.root.lock().unwrap().as_deref() != Some(root.as_path()) {
            return Err(Problem::plain(
                "Start this OpenBot installation before signing in to its organization.",
            ));
        }
        let configured =
            openbot_env::already_set(&root.join(".env"), &["OPENBOT_ORGANIZATION_AUTH_URL"])
                .remove("OPENBOT_ORGANIZATION_AUTH_URL")
                .unwrap_or_default();
        if configured.trim() != authority_url.trim() {
            return Err(Problem::plain(
                "Save this organization's OpenBot URL before signing in.",
            ));
        }
        openbot_desktop_lib::organization_auth::begin(&root, &authority_url, &provider)
    })
    .await
    .map_err(|_| Problem::plain("Organization sign-in could not start."))??;
    if tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(&url, None::<&str>)
        .is_err()
    {
        eprintln!(
            "[organization] browser could not open; use the sign-in address shown in the window"
        );
    }
    Ok(url)
}

#[tauri::command]
async fn finish_organization_sign_in(
    app: tauri::AppHandle,
    root: String,
) -> Result<openbot_desktop_lib::organization_auth::OrganizationUser, Problem> {
    let root = stack::root_from(&root);
    tauri::async_runtime::spawn_blocking(move || {
        let shell = app.state::<Shell>();
        let generation = shell.generation.load(std::sync::atomic::Ordering::SeqCst);
        let user = openbot_desktop_lib::organization_auth::finish(&root)?;
        let _startup = shell.startup.lock().unwrap();
        if shell.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
            || shell.root.lock().unwrap().as_deref() != Some(root.as_path())
        {
            return Err(Problem::plain(
                "That sign-in belongs to a previous OpenBot run. Open this installation again.",
            ));
        }
        Ok(user)
    })
    .await
    .map_err(|_| Problem::plain("Organization sign-in did not finish."))?
}

#[tauri::command]
fn cancel_organization_sign_in(root: String) {
    openbot_desktop_lib::organization_auth::cancel(&stack::root_from(&root));
}

/// The model screen's rows. Independent of the picker above, and required to stay that way: no
/// harness on that list is tied to a vendor's models, so choosing one may not narrow this.
#[tauri::command]
fn providers() -> Vec<provider::Provider> {
    provider::catalogue()
}

#[tauri::command]
async fn begin_model_oauth(
    root: String,
    provider: String,
) -> Result<openbot_desktop_lib::provider_oauth::Authorization, String> {
    tauri::async_runtime::spawn_blocking(move || {
        openbot_desktop_lib::provider_oauth::begin(&stack::root_from(&root), &provider)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn finish_model_oauth(attempt_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        openbot_desktop_lib::provider_oauth::finish(&attempt_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_model_oauth(attempt_id: String) {
    openbot_desktop_lib::provider_oauth::cancel(&attempt_id);
}

/// One Intelligence CLI call for the local evaluation. Returns only the normalized report or a
/// static failure category; the CLI's own output never reaches the window. `attempt` names the
/// call so `cancel_local_eval` can stop it, including before it has started.
#[tauri::command]
async fn run_local_eval(
    app: tauri::AppHandle,
    attempt: String,
    action: local_eval::Action,
    stack: String,
) -> Result<local_eval::Report, local_eval::Failure> {
    let stack = local_eval::StackId::parse(&stack)?;
    let report = tauri::async_runtime::spawn_blocking(move || {
        local_eval::run_installed(&attempt, action, &stack)
    })
    .await
    .map_err(|_| local_eval::Failure::Spawn)??;
    learn_dashboards(&app, report.stack.iter());
    Ok(report)
}

/// Keep the dashboard address of every stack a CLI report described, for `Dashboards`.
fn learn_dashboards<'a>(
    app: &tauri::AppHandle,
    stacks: impl Iterator<Item = &'a local_eval::Stack>,
) {
    let shell = app.state::<Shell>();
    for stack in stacks {
        shell.dashboards.learn(stack);
    }
}

/// The stacks the CLI has recorded, so a stack id comes from the CLI rather than being typed.
/// Why a local evaluation setup produced nothing to show: the CLI's own static category, or a
/// stack that was set up but could not be recorded. The second is not a CLI category, so it is
/// not one: the window tells them apart by shape.
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum SetupError {
    Failure(local_eval::Failure),
    Unrecorded(Problem),
}

/**
`local setup` for this installation, and the stack it made recorded as OpenBot's.

Blocked is a normal answer here, not an error: the first one is the evaluation agreement, which the
person accepts in their own terminal before the window asks again. Only a completed setup is
recorded, and only then does Stop or Quit stop that stack.
*/
#[tauri::command]
async fn set_up_local_eval(
    app: tauri::AppHandle,
    attempt: String,
    root: String,
    accepted_eula_version: Option<String>,
) -> Result<local_eval::Report, SetupError> {
    let root = stack::root_from(&root);
    // Only a version the person accepted in the window, after `local_eval_terms` showed it.
    let accepted = accepted_eula_version
        .as_deref()
        .map(local_eval::EulaVersion::parse)
        .transpose()
        .map_err(SetupError::Failure)?;
    let report = tauri::async_runtime::spawn_blocking(move || {
        // A local first run starts setup while OpenBot is still installing into this folder, which
        // may not exist yet; the CLI runs in it.
        std::fs::create_dir_all(&root)
            .map_err(|_| SetupError::Failure(local_eval::Failure::Spawn))?;
        set_up_local_eval_at(&root, |folder| {
            local_eval::setup_installed(&attempt, folder, accepted.as_ref())
        })
    })
    .await
    .map_err(|_| SetupError::Failure(local_eval::Failure::Spawn))??;
    learn_dashboards(&app, report.stack.iter());
    Ok(report)
}

/**
Sign in to CopilotKit, which local evaluation needs to issue its licence: `login --json`.

The CLI opens the approval page in the browser and waits for it; this returns once the person has
approved it there, or it failed. `attempt` lets `cancel_local_eval` stop the wait.
*/
#[tauri::command]
async fn sign_in_to_copilotkit(
    attempt: String,
) -> Result<local_eval::AccountSignIn, local_eval::Failure> {
    tauri::async_runtime::spawn_blocking(move || local_eval::account_sign_in_installed(&attempt))
        .await
        .map_err(|_| local_eval::Failure::Spawn)?
}

/// The evaluation agreement local setup needs accepted, for the window to show before Accept.
#[tauri::command]
async fn local_eval_terms(attempt: String) -> Result<local_eval::Terms, local_eval::Failure> {
    tauri::async_runtime::spawn_blocking(move || local_eval::terms_installed(&attempt))
        .await
        .map_err(|_| local_eval::Failure::Spawn)?
}

/**
Run `setup` in `root` and record what it made.

A stack set up here was made for OpenBot, so it starts and stops with it. The one exception is a
record that already calls the same stack shared: setting up again resumes that stack, it does not
make OpenBot its owner.
*/
fn set_up_local_eval_at<S>(root: &Path, setup: S) -> Result<local_eval::Report, SetupError>
where
    S: FnOnce(&Path) -> Result<(local_eval::Report, String), local_eval::Failure>,
{
    let (report, cli_sha256) = setup(root).map_err(SetupError::Failure)?;
    let Some(stack) = report
        .stack
        .as_ref()
        .filter(|_| report.outcome == local_eval::Outcome::Completed)
    else {
        return Ok(report);
    };
    let stack = local_eval::StackId::parse(&stack.id).map_err(SetupError::Failure)?;
    let ownership = match local_eval_state::read(root, None) {
        Some(state) if state.stack_id() == stack => state.ownership,
        _ => local_eval_state::Ownership::Created,
    };
    local_eval_state::begin(root, &stack, ownership, &cli_sha256)
        .map_err(SetupError::Unrecorded)?;
    Ok(report)
}

/// Why connecting OpenBot to local Intelligence produced nothing to show: the CLI's own static
/// category, or a connection OpenBot would not take up. Told apart by shape, like `SetupError`.
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum ConnectError {
    Failure(local_eval::Failure),
    Unconnected(Problem),
}

/**
`local connect` for this installation, after the person chose to connect OpenBot to it.

Interim, until the CLI issues OpenBot a credential of its own: the key `connect` writes into the
installation's `.env` is moved into the credential store as OpenBot's Intelligence key, the same
place a pasted key goes, and Start takes it from there. Blocked and conflicted answers are returned
as they are, with nothing taken.
*/
#[tauri::command]
async fn connect_local_eval(
    app: tauri::AppHandle,
    attempt: String,
    root: String,
) -> Result<local_eval::Connection, ConnectError> {
    let root = stack::root_from(&root);
    let connection = tauri::async_runtime::spawn_blocking(move || {
        connect_local_eval_at(
            &root,
            |folder| local_eval::connect_installed(&attempt, folder),
            openbot_desktop_lib::vault::remember,
            openbot_desktop_lib::vault::recall,
        )
    })
    .await
    .map_err(|_| ConnectError::Failure(local_eval::Failure::Spawn))??;
    learn_dashboards(&app, connection.stack.iter());
    Ok(connection)
}

/// Where `local connect` puts the key for an app's runtime. OpenBot's server reads it as
/// `INTELLIGENCE_API_KEY`.
const LOCAL_EVAL_CONNECTED_KEY: &str = "CPK_INTELLIGENCE_API_KEY";

/**
Connect the recorded stack in `root`, and take up what the CLI wrote.

Only the stack this installation recorded is connected, and only its own addresses are believed:
the `.env` must hold exactly the API and gateway addresses the CLI reported for it. The key then
goes to the credential store and leaves the file, which keeps only settings (see `vault`). The
CLI connects a folder once, so connecting again finds no key in the file; that is the key already
kept, provided this stack was the one connected.
*/
fn connect_local_eval_at<C, R, K>(
    root: &Path,
    connect: C,
    mut remember: R,
    mut recall: K,
) -> Result<local_eval::Connection, ConnectError>
where
    C: FnOnce(&Path) -> Result<local_eval::Connection, local_eval::Failure>,
    R: FnMut(&Path, &str, &str) -> Result<(), Problem>,
    K: FnMut(&Path, &str) -> Result<Option<String>, Problem>,
{
    let unconnected = |said: &str| ConnectError::Unconnected(Problem::plain(said));
    let recorded = local_eval_state::read(root, None)
        .ok_or_else(|| unconnected("Set up local Intelligence before connecting OpenBot to it."))?;
    let connection = connect(root).map_err(ConnectError::Failure)?;
    if connection.outcome != local_eval::Outcome::Completed || connection.conflicted {
        return Ok(connection);
    }
    let Some(stack) = connection
        .stack
        .as_ref()
        .filter(|stack| stack.id == recorded.stack)
    else {
        return Err(unconnected(
            "The Intelligence CLI connected a different stack. OpenBot did not use it.",
        ));
    };
    let env_file = root.join(".env");
    let written = openbot_env::read_already_set(
        &env_file,
        &[
            "INTELLIGENCE_API_URL",
            "INTELLIGENCE_GATEWAY_WS_URL",
            LOCAL_EVAL_CONNECTED_KEY,
        ],
    )
    .map_err(|error| {
        ConnectError::Unconnected(Problem::with(
            "OpenBot could not read the connection the Intelligence CLI wrote.",
            format!("{}: {}", env_file.display(), error.kind()),
        ))
    })?;
    let addresses = [
        ("INTELLIGENCE_API_URL", &stack.urls.api),
        ("INTELLIGENCE_GATEWAY_WS_URL", &stack.urls.gateway),
    ];
    if addresses
        .iter()
        .any(|(name, reported)| written.get(*name) != Some(*reported))
    {
        return Err(unconnected(
            "The Intelligence CLI's connection settings do not match its stack. OpenBot did not use them.",
        ));
    }
    match written
        .get(LOCAL_EVAL_CONNECTED_KEY)
        .map(|key| key.trim())
        .filter(|key| !key.is_empty())
    {
        Some(key) => {
            remember(root, "INTELLIGENCE_API_KEY", key).map_err(ConnectError::Unconnected)?;
            let settings = addresses
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).clone()))
                .collect();
            let purge = [(LOCAL_EVAL_CONNECTED_KEY.to_owned(), String::new())].into();
            openbot_env::write(&env_file, &settings, &purge).map_err(|error| {
                ConnectError::Unconnected(Problem::with(
                    "OpenBot kept the local Intelligence key but could not remove it from its settings file.",
                    format!("{}: {}", env_file.display(), error.kind()),
                ))
            })?;
        }
        None => {
            let kept = recorded.connected
                && recall(root, "INTELLIGENCE_API_KEY")
                    .map_err(ConnectError::Unconnected)?
                    .is_some_and(|key| !key.trim().is_empty());
            if !kept {
                return Err(unconnected(
                    "The Intelligence CLI connected, but OpenBot has no key for this stack.",
                ));
            }
        }
    }
    let stack_id = local_eval::StackId::parse(&stack.id).map_err(ConnectError::Failure)?;
    local_eval_state::mark_connected(root, &stack_id).map_err(ConnectError::Unconnected)?;
    Ok(connection)
}

#[tauri::command]
async fn list_local_eval(
    app: tauri::AppHandle,
    attempt: String,
) -> Result<local_eval::Listing, local_eval::Failure> {
    let listing =
        tauri::async_runtime::spawn_blocking(move || local_eval::list_installed(&attempt))
            .await
            .map_err(|_| local_eval::Failure::Spawn)??;
    learn_dashboards(&app, listing.stacks.iter());
    Ok(listing)
}

#[tauri::command]
fn cancel_local_eval(attempt: String) {
    local_eval::cancel(&attempt);
}

/**
Open the recorded local stack's Intelligence dashboard, signed in, with no code to approve.

`local login` opens the browser itself, so nothing here opens a second tab; once it has signed this
stack in during this session the dashboard's address is opened directly (see `Dashboards`). The
window gets nothing back but success or a fixed sentence; `attempt` lets `cancel_local_eval` stop
the call.
*/
#[tauri::command]
async fn open_local_intelligence(
    app: tauri::AppHandle,
    attempt: String,
    root: String,
) -> Result<(), Problem> {
    let root = stack::root_from(&root);
    tauri::async_runtime::spawn_blocking(move || {
        open_dashboard_from(&app, &root, &attempt).map_err(|failure| failure.problem())
    })
    .await
    .map_err(|_| DashboardFailure::Failed.problem())?
}

/// Why the dashboard did not open: a fixed category, which is all the OpenBot app's page is told,
/// and one fixed sentence for each, which is all the setup window and the menu say.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DashboardFailure {
    NotSetUp,
    NotResponding,
    BrowserFailed,
    Busy,
    EngineStopped,
    Unsupported,
    TimedOut,
    Stopped,
    Failed,
}

impl DashboardFailure {
    fn said(self) -> &'static str {
        match self {
            DashboardFailure::NotSetUp => "Set up local Intelligence before opening its dashboard.",
            DashboardFailure::NotResponding => {
                "The Intelligence dashboard is not responding yet. Try again when Intelligence is ready."
            }
            DashboardFailure::BrowserFailed => "Your browser did not open. Try again.",
            DashboardFailure::Busy => {
                "Another Intelligence command is still running. Try again when it finishes."
            }
            DashboardFailure::EngineStopped => "The software Intelligence runs on is not running.",
            DashboardFailure::Unsupported => {
                "This version of OpenBot cannot open the Intelligence dashboard."
            }
            DashboardFailure::TimedOut => {
                "The Intelligence dashboard took too long to open. Try again."
            }
            DashboardFailure::Stopped => "Opening the Intelligence dashboard was stopped.",
            DashboardFailure::Failed => "OpenBot could not open the Intelligence dashboard. Try again.",
        }
    }

    fn problem(self) -> Problem {
        Problem::plain(self.said())
    }
}

/// `open_dashboard_at` with its sentence, as the setup window is told.
#[cfg(test)]
fn open_local_intelligence_at<L>(root: &Path, login: L) -> Result<(), Problem>
where
    L: FnOnce(&local_eval::StackId) -> Result<local_eval::SignIn, local_eval::Failure>,
{
    open_dashboard_at(root, login).map_err(DashboardFailure::problem)
}

/// `sign_in` for the stack recorded in `root`, and nothing for a root with no record.
fn open_dashboard_at<L>(root: &Path, sign_in: L) -> Result<(), DashboardFailure>
where
    L: FnOnce(&local_eval::StackId) -> Result<local_eval::SignIn, local_eval::Failure>,
{
    use local_eval::{Failure, Outcome, Reason};
    let recorded = local_eval_state::read(root, None).ok_or(DashboardFailure::NotSetUp)?;
    Err(match sign_in(&recorded.stack_id()) {
        Ok(signed) if signed.outcome == Outcome::Completed => return Ok(()),
        Ok(signed) => match signed.reason {
            Some(Reason::DashboardUnavailable) => DashboardFailure::NotResponding,
            Some(Reason::BrowserOpenFailed) => DashboardFailure::BrowserFailed,
            Some(Reason::LocalCommandBusy) => DashboardFailure::Busy,
            Some(Reason::DockerUnavailable) => DashboardFailure::EngineStopped,
            _ => DashboardFailure::Failed,
        },
        Err(Failure::Unavailable) => DashboardFailure::Unsupported,
        Err(Failure::Timeout) => DashboardFailure::TimedOut,
        Err(Failure::Cancelled) => DashboardFailure::Stopped,
        Err(_) => DashboardFailure::Failed,
    })
}

/**
The dashboard addresses the CLI has reported this session, and which stacks `local login` has
signed in since OpenBot started.

`local login` costs a CLI call: about 0.3 s to check the pinned CLI's digests and 0.25 s for it to
start, before it waits for the dashboard, mints a single-use link and hands that to the browser.
The browser keeps the session it was given, so once a stack has been signed in during this session,
"Open Intelligence dashboard" opens its address directly and at once. OpenBot does not read the
CLI's credential files or the browser to decide; the first opening in each session signs in again,
and a dashboard whose session ended shows its own Sign In.

Addresses come only from CLI reports, whose dashboard address was checked to be a loopback one when
the report was read. A stack whose address changes is signed in again: the browser's session
belongs to the old address.
*/
#[derive(Default)]
struct Dashboards {
    known: Mutex<std::collections::HashMap<String, KnownDashboard>>,
}

#[derive(Default)]
struct KnownDashboard {
    address: Option<String>,
    signed_in: bool,
}

impl Dashboards {
    fn learn(&self, stack: &local_eval::Stack) {
        let mut known = self.known.lock().unwrap();
        let entry = known.entry(stack.id.clone()).or_default();
        if entry
            .address
            .as_ref()
            .is_some_and(|address| *address != stack.urls.dashboard)
        {
            entry.signed_in = false;
        }
        entry.address = Some(stack.urls.dashboard.clone());
    }

    fn signed_in(&self, stack: &local_eval::StackId) -> Option<String> {
        let known = self.known.lock().unwrap();
        let entry = known.get(stack.as_str())?;
        entry.signed_in.then(|| entry.address.clone()).flatten()
    }

    fn mark_signed_in(&self, stack: &local_eval::StackId) {
        self.known
            .lock()
            .unwrap()
            .entry(stack.as_str().to_owned())
            .or_default()
            .signed_in = true;
    }
}

/**
Open `stack`'s dashboard: straight to its address once this session has signed it in, otherwise
through `login`, remembering a completed sign-in.

`open` hands an address to the browser. Its failure is the CLI's own category for the same thing.
*/
fn open_or_sign_in<L, O>(
    dashboards: &Dashboards,
    stack: &local_eval::StackId,
    login: L,
    open: O,
) -> Result<local_eval::SignIn, local_eval::Failure>
where
    L: FnOnce(&local_eval::StackId) -> Result<local_eval::SignIn, local_eval::Failure>,
    O: FnOnce(&str) -> Result<(), ()>,
{
    use local_eval::{Outcome, Reason, SignIn};
    if let Some(address) = dashboards.signed_in(stack) {
        return Ok(match open(&address) {
            Ok(()) => SignIn {
                outcome: Outcome::Completed,
                reason: None,
            },
            Err(()) => SignIn {
                outcome: Outcome::Failed,
                reason: Some(Reason::BrowserOpenFailed),
            },
        });
    }
    let signed = login(stack)?;
    if signed.outcome == Outcome::Completed {
        dashboards.mark_signed_in(stack);
    }
    Ok(signed)
}

/// The real `open_dashboard_at`: the installed CLI, and the browser through the opener plugin.
fn open_dashboard_from<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    root: &Path,
    attempt: &str,
) -> Result<(), DashboardFailure> {
    open_dashboard_at(root, |stack| {
        open_or_sign_in(
            &app.state::<Shell>().dashboards,
            stack,
            |stack| local_eval::login_installed(attempt, stack),
            |address| {
                use tauri_plugin_opener::OpenerExt;
                app.opener().open_url(address, None::<&str>).map_err(|_| ())
            },
        )
    })
}

/// The root whose dashboard the menu opens: only one in local mode with a recorded stack.
fn intelligence_menu_root(root: &Path, offered: bool) -> Option<PathBuf> {
    (offered && local_eval_state::read(root, None).is_some()).then(|| root.to_path_buf())
}

/**
The window says whether it is in local mode for `root`, and the menus follow.

The window decides local mode, as it does for its own link; the menus add "Open Intelligence
dashboard" only while it says so and a stack is recorded there. Sync, so the menus are rebuilt on
the main thread.
*/
#[tauri::command]
fn offer_local_intelligence(app: tauri::AppHandle, root: String, offered: bool) {
    let next = intelligence_menu_root(&stack::root_from(&root), offered);
    let shell = app.state::<Shell>();
    let mut current = shell.intelligence_menu.lock().unwrap();
    if *current == next {
        return;
    }
    let show = next.is_some();
    *current = next;
    drop(current);
    if let Err(error) = install_menus(&app, show) {
        eprintln!("[menu] could not update the menus: {error}");
    }
    intelligence_bridge::tell(&app, intelligence_bridge::current(&app));
}

/// The menu's "Open Intelligence dashboard". The CLI can take many seconds the first time, so the
/// window comes forward without leaving what it shows, where the setup page or the app's sidebar
/// says the dashboard is opening.
fn open_intelligence_from_menu<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    start_intelligence_opening(app);
}

/**
Open the dashboard of the stack the menus offer, from the menu or the app's sidebar alike.

Answered at once, before any CLI call: the menu item is disabled, a setup page shows the words
with a spinner, and the app's sidebar row spins (`intelligence_bridge`). How it went is said in the
same places. A failure that has none of them on screen is said in a dialog.
*/
fn start_intelligence_opening<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    let shell = app.state::<Shell>();
    let Some(root) = shell.intelligence_menu.lock().unwrap().clone() else {
        // Nothing to open any more: a row that thought otherwise is told, so it does not spin.
        intelligence_bridge::tell(&app, intelligence_bridge::current(&app));
        return;
    };
    let opening = std::sync::Arc::clone(&shell.intelligence_opening);
    let status_app = app.clone();
    open_intelligence_reporting(
        opening,
        move |status| show_intelligence_opening(&status_app, status),
        move || {
            let attempt = format!("menu-open-intelligence-{:016x}", rand::random::<u64>());
            open_dashboard_from(&app, &root, &attempt)
        },
        |job| {
            std::thread::Builder::new()
                .name("openbot-open-intelligence".into())
                .spawn(job)
                .map(|_| ())
        },
    );
}

/// What the menu's dashboard opening says, with fixed words: as `quit:progress`, nothing the CLI
/// printed reaches the window.
#[derive(Clone, Debug, PartialEq, Eq)]
enum IntelligenceOpening {
    Opening,
    Opened,
    Failed(DashboardFailure),
}

/// `{"state": "opening" | "opened" | "failed", "said": …}`, the words always included.
impl Serialize for IntelligenceOpening {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut status = serializer.serialize_struct("IntelligenceOpening", 2)?;
        status.serialize_field(
            "state",
            match self {
                IntelligenceOpening::Opening => "opening",
                IntelligenceOpening::Opened => "opened",
                IntelligenceOpening::Failed(_) => "failed",
            },
        )?;
        status.serialize_field("said", self.said())?;
        status.end()
    }
}

impl IntelligenceOpening {
    fn said(&self) -> &str {
        match self {
            IntelligenceOpening::Opening => "Opening the Intelligence dashboard…",
            IntelligenceOpening::Opened => "Opened in your browser.",
            IntelligenceOpening::Failed(failure) => failure.said(),
        }
    }
}

const INTELLIGENCE_OPENING_EVENT: &str = "intelligence:opening";

/**
Say `Opening` now, run `open` through `spawn`, then say how it went.

Once at a time: a click that arrives while one runs, from a menu built before the item was
disabled, does nothing. `opening` is clear again before the outcome is said, so the menus rebuilt
for it offer the item again.
*/
fn open_intelligence_reporting<S, O, W>(
    opening: std::sync::Arc<std::sync::atomic::AtomicBool>,
    status: S,
    open: O,
    spawn: W,
) where
    S: Fn(IntelligenceOpening) + Clone + Send + 'static,
    O: FnOnce() -> Result<(), DashboardFailure> + Send + 'static,
    W: FnOnce(Box<dyn FnOnce() + Send + 'static>) -> std::io::Result<()>,
{
    use std::sync::atomic::Ordering;
    if opening.swap(true, Ordering::SeqCst) {
        return;
    }
    status(IntelligenceOpening::Opening);
    let finishing = std::sync::Arc::clone(&opening);
    let finished = status.clone();
    let job = Box::new(move || {
        let outcome = match open() {
            Ok(()) => IntelligenceOpening::Opened,
            Err(failure) => IntelligenceOpening::Failed(failure),
        };
        finishing.store(false, Ordering::SeqCst);
        finished(outcome);
    });
    if spawn(job).is_err() {
        opening.store(false, Ordering::SeqCst);
        status(IntelligenceOpening::Failed(DashboardFailure::Failed));
    }
}

const OPENING_INTELLIGENCE_ITEM: &str = "Opening Intelligence dashboard…";

/// The menu's "Open Intelligence dashboard" item: its words, and whether it can be chosen.
fn intelligence_menu_item(opening: bool) -> (&'static str, bool) {
    if opening {
        (OPENING_INTELLIGENCE_ITEM, false)
    } else {
        ("Open Intelligence dashboard", true)
    }
}

/// Tell the setup page and the app's sidebar, then put the menus in step. Nothing is written in
/// the menu bar: a status title there widened the item behind the camera notch and, on macOS,
/// clearing the title never took it away. A failure with no page on screen to say it gets a dialog.
/// Menus belong to the main thread.
fn show_intelligence_opening<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    status: IntelligenceOpening,
) {
    let _ = app.emit(INTELLIGENCE_OPENING_EVENT, &status);
    let told = intelligence_bridge::tell(app, intelligence_bridge::Offer::after(&status));
    if let IntelligenceOpening::Failed(failure) = &status {
        if !told && !showing_setup(app) {
            use tauri_plugin_dialog::DialogExt;
            app.dialog()
                .message(failure.said())
                .title("Open Intelligence dashboard")
                .show(|_| {});
        }
    }
    refresh_menus(app);
}

/// Room left between a grown or clamped window and the edge of its monitor's work area.
const SCREEN_MARGIN: f64 = 24.0;

/**
How tall the window's content area should become, in logical pixels, or None to leave it.

Grows to `wanted` and never shrinks: a window that jumped smaller under somebody's pointer when a
row collapsed would be worse than one with a little room to spare. `tallest` is the most the content
area may have on this monitor; past it the page scrolls, as it always could.
*/
fn grown_height(current: f64, wanted: f64, tallest: f64) -> Option<f64> {
    let target = wanted.ceil().min(tallest.floor());
    (target > current.ceil()).then_some(target)
}

/// The window's monitor work area in logical pixels, and the height of its title bar and frame.
fn screen_room<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Option<(tauri::LogicalRect<f64, f64>, f64)> {
    let scale = window.scale_factor().ok()?;
    let monitor = window.current_monitor().ok().flatten()?;
    let area = monitor.work_area();
    let frame = window.outer_size().ok()?.height as f64 - window.inner_size().ok()?.height as f64;
    Some((
        tauri::LogicalRect {
            position: area.position.to_logical(scale),
            size: area.size.to_logical(scale),
        },
        frame / scale,
    ))
}

/// Resize the content area to `height` logical pixels, moving the window up if its bottom would
/// leave the work area.
fn set_window_height<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    area: &tauri::LogicalRect<f64, f64>,
    frame: f64,
    height: f64,
) {
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Ok(inner) = window.inner_size() else {
        return;
    };
    let width = inner.to_logical::<f64>(scale).width;
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    if let Ok(position) = window.outer_position() {
        let position = position.to_logical::<f64>(scale);
        let bottom = area.position.y + area.size.height - SCREEN_MARGIN;
        if position.y + frame + height > bottom {
            let top = (bottom - frame - height).max(area.position.y);
            let _ = window.set_position(tauri::LogicalPosition::new(position.x, top));
        }
    }
}

/**
Make the setup window tall enough for the screen it is showing, within its monitor.

The setup page measures its own content and asks; it is not granted any `core:window` permission,
so this is the only way it can change the window, and only ever larger. A maximized or full-screen
window is left as the person made it.
*/
#[tauri::command]
fn fit_setup_window<R: tauri::Runtime>(window: tauri::WebviewWindow<R>, content_height: f64) {
    if !content_height.is_finite()
        || window.is_maximized().unwrap_or(true)
        || window.is_fullscreen().unwrap_or(true)
    {
        return;
    }
    let (Some((area, frame)), Ok(scale), Ok(inner)) = (
        screen_room(&window),
        window.scale_factor(),
        window.inner_size(),
    ) else {
        return;
    };
    let current = inner.to_logical::<f64>(scale).height;
    let tallest = area.size.height - frame - 2.0 * SCREEN_MARGIN;
    if let Some(height) = grown_height(current, content_height, tallest) {
        set_window_height(&window, &area, frame, height);
    }
}

/// On launch: a window taller than its monitor's work area is brought within it.
fn fit_main_window_to_screen<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let (Some((area, frame)), Ok(scale), Ok(inner)) = (
        screen_room(&window),
        window.scale_factor(),
        window.inner_size(),
    ) else {
        return;
    };
    let tallest = area.size.height - frame - 2.0 * SCREEN_MARGIN;
    if inner.to_logical::<f64>(scale).height > tallest {
        set_window_height(&window, &area, frame, tallest.floor());
    }
}

/// Whether the main window shows the setup page, whose own overlay says the menu's outcome.
fn showing_setup<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    let Ok(setup) = setup_destination(app) else {
        return false;
    };
    window
        .url()
        .is_ok_and(|current| same_window_app(&current, &setup))
}

/// `bun` from PATH, or the places an installer puts it when PATH has not been reloaded.
fn which_bun() -> Option<PathBuf> {
    if quiet::command("bun")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        if let Some(path) = std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path)
                .map(|directory| directory.join(if cfg!(windows) { "bun.exe" } else { "bun" }))
                .find(|path| path.is_file())
        }) {
            return Some(path);
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let candidates = [
        PathBuf::from(&home).join(".bun/bin/bun"),
        PathBuf::from(&home).join(".bun/bin/bun.exe"),
    ];
    candidates.into_iter().find(|path| path.exists())
}

/// Watch the three host processes and start one again when it dies.
///
/// The policy is in `supervise.rs`; this is the loop that applies it. It ends when the stack is
/// stopped, which is what clearing the root means, so stopping does not race a restart.
fn publish_connection_failure<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    root: &Path,
    generation: u64,
    connection: openbot_desktop_lib::problem::Connection,
) -> Result<bool, String> {
    let shell = app.state::<Shell>();
    let _startup = shell.startup.lock().unwrap();
    if shell.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
        || shell.root.lock().unwrap().as_deref() != Some(root)
    {
        return Ok(false);
    }
    if recovery_required(&shell, root) {
        return Ok(true);
    }
    let said = match connection {
        openbot_desktop_lib::problem::Connection::Model => "Your AI connection was refused. Refresh it to continue using your existing OpenBot.",
        openbot_desktop_lib::problem::Connection::Intelligence => "Your CopilotKit connection was refused. Refresh it to continue using your existing OpenBot.",
        openbot_desktop_lib::problem::Connection::Organization => "Your organization sign-in needs to be refreshed to continue using your existing OpenBot.",
    };
    mark_recovery_required(&shell, root, generation);
    if let Some(recovery) = shell.recovery_required.lock().unwrap().as_mut() {
        recovery.connection = Some(connection.clone());
    }
    *shell.last_failure.lock().unwrap() = Some(Problem::plain(said).connection(connection));
    show_setup_and_focus(app.clone())?;
    Ok(true)
}

#[allow(
    clippy::too_many_arguments,
    reason = "Retain selected ports alongside the supervised run's identity and credentials."
)]
fn supervise_host_processes<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: PathBuf,
    logs: PathBuf,
    bun: PathBuf,
    // Carried rather than fetched again on each restart. A restart happens when something is
    // already wrong, and a credential prompt at that moment is the worst time to ask for one.
    secrets: stack::Secrets,
    generation: u64,
    ports: openbot_env::Ports,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        eprintln!(
            "[watch] supervising {} host processes",
            stack::HOST_PROCESSES.len()
        );
        let mut watches: Vec<supervise::Watch> = stack::HOST_PROCESSES
            .iter()
            .map(|process| supervise::Watch::new(process.name))
            .collect();
        let connection_client = desktop_connection::client()
            .map_err(|error| {
                eprintln!("[watch] {error}");
            })
            .ok();
        let mut connection_notice_sent = false;
        let mut connection_poll_failed = false;

        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let shell = app.state::<Shell>();
            // Not this run's any more, or no run at all.
            if shell.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
                || shell.root.lock().unwrap().is_none()
            {
                return;
            }

            if connection_notice_sent && !recovery_required(&shell, &root) {
                connection_notice_sent = false;
            }
            if !connection_notice_sent {
                if let (Some(client), Some(token)) = (
                    &connection_client,
                    secrets.get("OPENBOT_DESKTOP_HOST_TOKEN"),
                ) {
                    match desktop_connection::poll(client, ports.server, token) {
                        Ok(Some(connection)) => {
                            match publish_connection_failure(&app, &root, generation, connection) {
                                Ok(published) => connection_notice_sent = published,
                                Err(error) => {
                                    eprintln!("[watch] could not show connection refresh: {error}")
                                }
                            }
                        }
                        Ok(None) => connection_poll_failed = false,
                        Err(error) => {
                            if !connection_poll_failed {
                                eprintln!("[watch] {error}");
                            }
                            connection_poll_failed = true;
                        }
                    }
                }
            }

            // Which ones have died. Collected rather than acted on under the lock, because a
            // restart waits, and waiting while holding the children is how Stop would block on a
            // backoff nobody asked it to sit through.
            let dead: Vec<&'static str> = {
                let mut children = shell.children.lock().unwrap();
                let mut dead = Vec::new();
                for (name, child) in children.iter_mut() {
                    if let Ok(Some(_)) = child.try_wait() {
                        dead.push(*name);
                    }
                }
                dead
            };

            if !dead.is_empty() {
                eprintln!("[watch] dead: {dead:?}");
            }
            for name in dead {
                let Some(watch) = watches.iter_mut().find(|watch| watch.name == name) else {
                    continue;
                };
                if !watch.should_restart(std::time::Instant::now()) {
                    // A restore already probing may finish first; publish recovery and its setup
                    // navigation together after it, so that late probe cannot undo this transition.
                    let _startup = shell.startup.lock().unwrap();
                    // Let go of it. A dead child left in the list is found dead again two seconds
                    // later, and forever after: the count climbs past what actually happened, the
                    // window is sent back to the setup screen on a loop, and the giving up that was
                    // supposed to stop a hot laptop becomes one.
                    {
                        let mut children = shell.children.lock().unwrap();
                        if shell.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
                            || shell.root.lock().unwrap().as_deref() != Some(root.as_path())
                        {
                            return;
                        }
                        children.retain(|(held, _)| *held != name);
                    }

                    let reason = watch.gave_up();
                    mark_recovery_required(&shell, &root, generation);
                    report(&app, name, false, reason.clone());
                    /*
                     * Both registers here too. `gave_up` names the process and quotes the tail of
                     * its log, which is the developer half; the person needs to know a piece of
                     * OpenBot stopped and that starting again is the thing to try.
                     */
                    *shell.last_failure.lock().unwrap() =
                        Some(openbot_desktop_lib::problem::Problem::with(
                            format!(
                                "Part of OpenBot ({name}) stopped and could not be started again. \
                                 Try starting OpenBot once more."
                            ),
                            reason,
                        ));
                    // Back to the setup screen. By now the window is showing OpenBot, and OpenBot
                    // is not running: leaving it there is a window that lies.
                    let _ = show_setup(app.clone());
                    continue;
                }
                report(
                    &app,
                    name,
                    false,
                    format!("{name} stopped. Starting it again."),
                );
                std::thread::sleep(supervise::backoff(watch.restarts - 1));

                // Asked again after the backoff: a stop, or another start, may have happened while
                // this was waiting, and starting a process into either is how an orphan is made.
                if shell.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
                    || shell.root.lock().unwrap().is_none()
                {
                    return;
                }
                let Some(process) = stack::HOST_PROCESSES
                    .iter()
                    .find(|process| process.name == name)
                else {
                    continue;
                };
                match restart_host_process_with(&shell, &root, name, generation, || {
                    stack::spawn_host_process(process, &root, &logs, &bun, &secrets)
                }) {
                    Ok(true) => report(&app, name, true, "started again"),
                    Ok(false) => return,
                    Err(problem) => {
                        report(&app, name, false, problem.said.clone());
                        *shell.last_failure.lock().unwrap() = Some(problem);
                    }
                }
            }
        }
    })
}

/// The same lock covers generation validation, launch, publication, and owned cleanup on every
/// platform. Stop can retire during spawn, but cannot finish before receiving that child handle.
fn restart_host_process_with<F>(
    shell: &Shell,
    root: &Path,
    name: &'static str,
    generation: u64,
    spawn: F,
) -> Result<bool, Problem>
where
    F: FnOnce() -> std::io::Result<std::process::Child>,
{
    let mut children = shell.children.lock().unwrap();
    if shell.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
        || shell.root.lock().unwrap().as_deref() != Some(root)
    {
        return Ok(false);
    }
    let child = spawn().map_err(|error| {
        Problem::with(
            format!("OpenBot could not restart {name}."),
            error.to_string(),
        )
    })?;
    #[cfg(unix)]
    stack::replace_host_process(root, &mut children, name, child)?;
    #[cfg(not(unix))]
    stack::replace_windows_host_process_with(
        root,
        &mut children,
        name,
        child,
        Path::new("powershell"),
    )?;
    Ok(shell.generation.load(std::sync::atomic::Ordering::SeqCst) == generation)
}

/// Point the window at OpenBot if it is up, and at the setup screen if it is not.
///
/// Used by the tray and by a second launch, both of which happen at moments when the caller has no
/// idea which of the two the person should be looking at.
fn show_whichever_applies(app: &tauri::AppHandle) {
    match ports_for_shell(app) {
        Ok(ports) => restore_window_on(app, &ports),
        Err(problem) => {
            *app.state::<Shell>().last_failure.lock().unwrap() = Some(problem);
            if let Err(error) = show_setup_and_focus(app.clone()) {
                eprintln!("{error}");
            }
        }
    }
}

fn restore_window_on<R: tauri::Runtime>(app: &tauri::AppHandle<R>, ports: &openbot_env::Ports) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let shell = app.state::<Shell>();
    let _startup = shell.startup.lock().unwrap();
    let root = cleanup_root(&shell, &stack::default_root());
    // Restore has the same deployment ownership requirement as the setup page's passive probe.
    // A successful app-port response alone may belong to another installation or application.
    let destination = if let Some(url) = (!recovery_required_or_pending_quit_notice(&shell, &root))
        .then(|| owned_app_url(&root, ports))
        .flatten()
    {
        intelligence_bridge::allow(app, &url);
        url.parse().ok()
    } else {
        setup_destination(app).ok()
    };
    if let Some(destination) = destination {
        let already_showing = window
            .url()
            .is_ok_and(|current| same_window_app(&current, &destination));
        if !already_showing {
            let _ = window.navigate(destination);
        }
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn schedule_second_instance_restore<T, F>(
    context: T,
    restore: F,
) -> std::io::Result<std::thread::JoinHandle<()>>
where
    T: Send + 'static,
    F: FnOnce(T) + Send + 'static,
{
    std::thread::Builder::new()
        .name("openbot-second-instance-restore".into())
        .spawn(move || restore(context))
}

fn restore_after_second_instance(app: &tauri::AppHandle) {
    let app = app.clone();
    let reporting_app = app.clone();
    if let Err(error) = schedule_second_instance_restore(app, |app| {
        show_whichever_applies(&app);
    }) {
        eprintln!("[single-instance] restore scheduling failed: {error}");
        report(
            &reporting_app,
            "open",
            false,
            format!("OpenBot could not show the existing window: {error}"),
        );
    }
}

fn publish_quit_notice_failure<R: tauri::Runtime>(app: tauri::AppHandle<R>, error: String) {
    let problem = Problem::with("OpenBot could not record a shutdown problem.", error);
    let shell = app.state::<Shell>();
    {
        let _startup = shell.startup.lock().unwrap();
        let root = cleanup_root(&shell, &stack::default_root());
        let generation = shell.generation.load(std::sync::atomic::Ordering::SeqCst);
        mark_recovery_required(&shell, &root, generation);
        *shell.last_failure.lock().unwrap() = Some(problem);
    }
    let _ = show_setup_and_focus(app);
}

fn stop_from_menu<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    std::thread::spawn(move || {
        let root = default_root();
        let root_path = PathBuf::from(&root);
        eprintln!("[menu] stopping the stack under {root}");
        let stopped = stop_everything(&app, &root_path);
        refresh_menus(&app);
        match settle_menu_stop(&app.state::<Shell>(), &root_path, stopped) {
            None => {
                eprintln!("[menu] stopped");
                report(&app, "stopped", true, "OpenBot has been stopped");
            }
            // Said rather than swallowed. A menu item that fails silently is worse than one
            // that is not there: the person believes the stack is down and it is not.
            Some(problem) => {
                eprintln!(
                    "[menu] stop failed: {}",
                    problem.detail.as_deref().unwrap_or_default()
                );
                report(&app, "stopped", false, problem.said);
            }
        }
        let _ = show_setup(app.clone());
    });
}

/// Keep a menu Stop's failure for the setup screen, and mark recovery only when OpenBot's own
/// processes or containers may still be running. None when everything stopped.
fn settle_menu_stop(shell: &Shell, fallback_root: &Path, stopped: Stopped) -> Option<Problem> {
    let openbot_failed = !stopped.openbot.is_empty();
    let problem = if openbot_failed {
        Problem::with(
            "OpenBot could not finish stopping. Try Stop OpenBot again.",
            stopped.lines().join("\n"),
        )
    } else {
        Problem::with(
            "OpenBot stopped, but could not stop the local Intelligence stack it started.",
            stopped.intelligence?,
        )
    };
    let _startup = shell.startup.lock().unwrap();
    if openbot_failed {
        let root = cleanup_root(shell, fallback_root);
        let generation = shell.generation.load(std::sync::atomic::Ordering::SeqCst);
        mark_recovery_required(shell, &root, generation);
    }
    *shell.last_failure.lock().unwrap() = Some(problem.clone());
    Some(problem)
}

/// What each of the three items does, wherever it was chosen from.
///
/// The tray and the window menu carry the same items, so they share one function: two copies would
/// be two chances for Stop to mean something different depending on where somebody clicked.
fn chose(app: &tauri::AppHandle, item: &str) {
    match item {
        "open" => show_whichever_applies(app),
        // Stop without quitting: the stack is what costs something to leave running, and somebody
        // who wants it stopped does not necessarily want the application gone.
        "stop" => stop_from_menu(app.clone()),
        "status" => show_status_window(app),
        "open-intelligence" => open_intelligence_from_menu(app.clone()),
        // Exit rather than hide: quitting is a decision to stop, and the exit handler is what stops
        // the processes with it.
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

/**
A quit macOS starts, not OpenBot: Dock > Quit, an AppleScript `quit`, logging out or shutting down.

Tauri on macOS answers those only in `applicationWillTerminate:`, which ends the event loop at once:
`RunEvent::ExitRequested`, where OpenBot's own Quit stops its CLI calls, its containers and the
Intelligence stack it made, never runs. A local setup quit that way kept running with nobody to
stop it, and the next setup was refused as busy.

So the app delegate also answers `applicationShouldTerminate:`: it cancels macOS's termination
and asks for OpenBot's own Quit (`app.exit`), whose cleanup then exits. Tauri ends the loop with
`stop:` and `process::exit`, never `terminate:`, so this is not asked again on the way out. A
logout waits for nothing here: macOS reports that OpenBot cancelled it, and logging out again
after OpenBot has closed goes through.
*/
#[cfg(target_os = "macos")]
mod macos_quit {
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use std::sync::OnceLock;

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    /// `NSApplicationTerminateReply`.
    const TERMINATE_CANCEL: usize = 0;
    const TERMINATE_NOW: usize = 1;

    extern "C-unwind" fn should_terminate(_: *mut AnyObject, _: Sel, _: *mut AnyObject) -> usize {
        match APP.get() {
            Some(app) => {
                app.exit(0);
                TERMINATE_CANCEL
            }
            None => TERMINATE_NOW,
        }
    }

    /// Adds `applicationShouldTerminate:` to the delegate Tauri installed. Called once, in setup.
    pub fn install(app: &tauri::AppHandle) {
        if APP.set(app.clone()).is_err() {
            return;
        }
        // SAFETY: on the main thread during setup, after Tauri set the application's delegate. The
        // method is added to the delegate's own class, with the signature AppKit calls it with:
        // NSUInteger (Q) on self (@), _cmd (:), sender (@).
        unsafe {
            let application: *mut AnyObject =
                objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
            if application.is_null() {
                return;
            }
            let delegate: *mut AnyObject = objc2::msg_send![application, delegate];
            if delegate.is_null() {
                return;
            }
            let class = objc2::ffi::object_getClass(delegate) as *mut AnyClass;
            let imp: Imp = std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
                Imp,
            >(should_terminate);
            objc2::ffi::class_addMethod(
                class,
                objc2::sel!(applicationShouldTerminate:),
                imp,
                c"Q@:@".as_ptr(),
            );
        }
    }
}

/**
What About OpenBot says: the version, and which build this is.

The build is the commit it was built from, marked `-dirty` when the tree had uncommitted changes,
and when; see `build_identity` in build.rs. macOS shows the version and the build on one line and
the credits under them; Windows and Linux show the comments.
*/
fn about_openbot() -> tauri::menu::AboutMetadata<'static> {
    let built = build_description(
        env!("OPENBOT_BUILD_COMMIT"),
        env!("OPENBOT_BUILD_BRANCH"),
        env!("OPENBOT_BUILD_TIME").parse().unwrap_or_default(),
    );
    tauri::menu::AboutMetadata {
        name: Some("OpenBot".into()),
        short_version: Some(env!("CARGO_PKG_VERSION").into()),
        version: Some(env!("OPENBOT_BUILD_COMMIT").into()),
        credits: Some(built.clone()),
        comments: Some(built),
        ..Default::default()
    }
}

/// "Built 2026-10-22 06:40 UTC from 397d98a on dustywusty/local-eval-test-question".
fn build_description(commit: &str, branch: &str, built: u64) -> String {
    let on = if branch.is_empty() {
        String::new()
    } else {
        format!(" on {branch}")
    };
    format!("Built {} from {commit}{on}", utc_minute(built))
}

/// Seconds since 1970 as "YYYY-MM-DD HH:MM UTC", with no date library for one line.
fn utc_minute(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let minute_of_day = seconds % 86_400 / 60;
    // Howard Hinnant's days_from_civil, inverted.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02} UTC",
        minute_of_day / 60,
        minute_of_day % 60
    )
}

/**
The tray menu and the window's menu bar, with "Open Intelligence dashboard" when `intelligence`.

Built again whenever that changes, because a menu item cannot be hidden, only removed.
*/
fn install_menus<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    intelligence: bool,
) -> tauri::Result<()> {
    use tauri::menu::{IconMenuItem, Menu, MenuItem, NativeIcon, PredefinedMenuItem, Submenu};

    // The menu bar menu follows the system's appearance; its icons are drawn for each.
    let dark = system_is_dark(app);
    let running = !app.state::<Shell>().children.lock().unwrap().is_empty();
    let dashboard = || {
        intelligence_menu_item(
            app.state::<Shell>()
                .intelligence_opening
                .load(std::sync::atomic::Ordering::SeqCst),
        )
    };

    /*
     * The menu bar's menu, laid out as Mac menu bar apps have theirs: what is running, with a
     * status dot, then the things to do, each with an icon, then About, then Quit.
     *
     * No line carries the app's name. The icon it opens from already says whose menu it is, the
     * name is a brand that builds change (OpenBot, Soar, a company's own), and a verb in front of
     * a product name reads badly for some of them: never "Open Soar" (a product decision of
     * 2026-10-23).
     */
    let tray_entries = || -> tauri::Result<Vec<MenuEntry<R>>> {
        let icon = |name: &str| menu_icon(name, dark);
        let mut entries = vec![
            MenuEntry::Icon(IconMenuItem::with_id_and_native_icon(
                app,
                "state",
                if running { "Running" } else { "Not running" },
                false,
                Some(if running {
                    NativeIcon::StatusAvailable
                } else {
                    NativeIcon::StatusNone
                }),
                None::<&str>,
            )?),
            MenuEntry::Native(PredefinedMenuItem::separator(app)?),
            MenuEntry::Icon(IconMenuItem::with_id(
                app,
                "open",
                "Show Window",
                true,
                icon("open"),
                None::<&str>,
            )?),
        ];
        if intelligence {
            let (label, enabled) = dashboard();
            entries.push(MenuEntry::Icon(IconMenuItem::with_id(
                app,
                "open-intelligence",
                label,
                enabled,
                icon("dashboard"),
                None::<&str>,
            )?));
        }
        entries.push(MenuEntry::Icon(IconMenuItem::with_id(
            app,
            "status",
            "Status…",
            true,
            icon("status"),
            None::<&str>,
        )?));
        entries.push(MenuEntry::Native(PredefinedMenuItem::separator(app)?));
        entries.push(MenuEntry::Native(PredefinedMenuItem::about(
            app,
            Some("About"),
            Some(about_openbot()),
        )?));
        entries.push(MenuEntry::Native(PredefinedMenuItem::separator(app)?));
        entries.push(MenuEntry::Icon(IconMenuItem::with_id(
            app,
            "quit",
            "Quit",
            true,
            icon("quit"),
            quit_menu_accelerator(),
        )?));
        Ok(entries)
    };

    /*
     * The application menu keeps the plain Mac order, About first and no icons, which is how every
     * app's own menu reads. The same ids, so both arrive at the same function.
     */
    let window_entries = || -> tauri::Result<Vec<MenuEntry<R>>> {
        let mut entries = vec![
            MenuEntry::Native(PredefinedMenuItem::about(
                app,
                Some("About OpenBot"),
                Some(about_openbot()),
            )?),
            MenuEntry::Native(PredefinedMenuItem::separator(app)?),
            MenuEntry::Plain(MenuItem::with_id(
                app,
                "open",
                "Show Window",
                true,
                None::<&str>,
            )?),
        ];
        if intelligence {
            let (label, enabled) = dashboard();
            entries.push(MenuEntry::Plain(MenuItem::with_id(
                app,
                "open-intelligence",
                label,
                enabled,
                None::<&str>,
            )?));
        }
        entries.push(MenuEntry::Plain(MenuItem::with_id(
            app,
            "status",
            "Status…",
            true,
            None::<&str>,
        )?));
        entries.push(MenuEntry::Plain(MenuItem::with_id(
            app,
            "quit",
            "Quit",
            true,
            quit_menu_accelerator(),
        )?));
        Ok(entries)
    };

    let tray = tray_entries()?;
    if let Some(icon) = app.tray_by_id("openbot") {
        icon.set_menu(Some(Menu::with_items(app, &menu_refs(&tray))?))?;
        #[cfg(target_os = "macos")]
        show_menu_images(&icon, dark);
    }

    // The same items on the window itself, because the tray cannot be relied on.
    //
    // Linux needs a tray host to draw the icon, and Windows can place it in overflow.
    // The tray library restores the Windows icon after Explorer restarts, but the window
    // menu still provides access when the tray is unavailable or hard to find.
    // Its own items, not the tray's: a menu item belongs to one menu, and the two menus
    // outlive each other.
    let window = window_entries()?;
    // A submenu, because a top-level entry in a menu bar has to be one to open at all.
    let openbot = Submenu::with_items(app, "OpenBot", true, &menu_refs(&window))?;
    /*
     * AN EDIT MENU, WITHOUT WHICH COMMAND-V DOES NOTHING.
     *
     * MEASURED, on the screen that asks for a paste. macOS routes the clipboard shortcuts
     * through the menu bar, so a window with no Edit menu has no Paste, and a webview text
     * field silently ignores the keystroke. Typing worked and pasting did not, on the one
     * screen whose own instruction is "paste the code it shows you". Every person signing
     * in to a Claude plan would have reached that field, pressed the shortcut everybody
     * knows, and had nothing happen.
     *
     * Predefined items rather than our own: these carry the standard shortcuts and the
     * standard behaviour, which is the whole point of them being where a person expects.
     */
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    app.set_menu(Menu::with_items(app, &[&openbot, &edit])?)?;
    Ok(())
}

/**
Whether the system, rather than any one window, is in dark: the menu bar follows the system, and the
main window follows OpenBot's own theme once it shows OpenBot.
*/
fn system_is_dark<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        quiet::command("defaults")
            .args(["read", "-g", "AppleInterfaceStyle"])
            .output()
            .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).trim() == "Dark")
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.get_webview_window("main")
            .and_then(|window| window.theme().ok())
            == Some(tauri::Theme::Dark)
    }
}

/// One item of a menu: ours with an icon, ours without, or one of the system's own.
enum MenuEntry<R: tauri::Runtime> {
    Icon(tauri::menu::IconMenuItem<R>),
    Plain(tauri::menu::MenuItem<R>),
    Native(tauri::menu::PredefinedMenuItem<R>),
}

fn menu_refs<R: tauri::Runtime>(entries: &[MenuEntry<R>]) -> Vec<&dyn tauri::menu::IsMenuItem<R>> {
    entries
        .iter()
        .map(|entry| match entry {
            MenuEntry::Icon(item) => item as &dyn tauri::menu::IsMenuItem<R>,
            MenuEntry::Plain(item) => item,
            MenuEntry::Native(item) => item,
        })
        .collect()
}

/**
A menu bar icon, in the ink of the menu it is drawn on.

macOS does not treat these as template images, so a black icon would vanish in a dark menu. Each is
drawn twice by `icons/menu/draw.py`, and the menus are rebuilt when the appearance changes.
*/
fn menu_icon(name: &str, dark: bool) -> Option<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(menu_icon_png(name, dark)?).ok()
}

/// The PNG behind `menu_icon`.
fn menu_icon_png(name: &str, dark: bool) -> Option<&'static [u8]> {
    Some(match (name, dark) {
        ("open", false) => include_bytes!("../icons/menu/open-light.png"),
        ("open", true) => include_bytes!("../icons/menu/open-dark.png"),
        ("dashboard", false) => include_bytes!("../icons/menu/dashboard-light.png"),
        ("dashboard", true) => include_bytes!("../icons/menu/dashboard-dark.png"),
        ("status", false) => include_bytes!("../icons/menu/status-light.png"),
        ("status", true) => include_bytes!("../icons/menu/status-dark.png"),
        ("quit", false) => include_bytes!("../icons/menu/quit-light.png"),
        ("quit", true) => include_bytes!("../icons/menu/quit-dark.png"),
        ("about", false) => include_bytes!("../icons/menu/about-light.png"),
        ("about", true) => include_bytes!("../icons/menu/about-dark.png"),
        _ => return None,
    })
}

/**
Lets the menu bar menu draw its icons and status dot on macOS 27 and later.

MEASURED: built with the macOS 27 SDK, every image in this menu was hidden, Apple's own status
dot and SF Symbols included, in a bundled test app as much as here. macOS 27 added
`NSMenuItem.preferredImageVisibility`, and its default lets AppKit hide images; an item has to ask
for `NSMenuItemImageVisibilityVisible` (1). Docker's menu still showed icons only because it is
built with an older SDK. Asked only where the selector exists, so earlier macOS is untouched.

About is the system's own item, which takes no icon through the menu API, so its icon is set here.
*/
#[cfg(target_os = "macos")]
fn show_menu_images<R: tauri::Runtime>(tray: &tauri::tray::TrayIcon<R>, dark: bool) {
    use objc2::encode::{Encode, Encoding};
    use objc2::runtime::AnyObject;

    #[repr(C)]
    struct Size {
        width: f64,
        height: f64,
    }
    // SAFETY: the same layout as CGSize, two doubles.
    unsafe impl Encode for Size {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }

    let Ok(Some(status_item)) = tray.with_inner_tray_icon(|inner| {
        inner
            .ns_status_item()
            .map(|item| objc2::rc::Retained::as_ptr(&item) as usize)
    }) else {
        return;
    };
    // SAFETY: the status item is retained by the tray for the app's lifetime; this runs on the
    // main thread, as menus are built there; and the setter is sent only where it is implemented.
    unsafe {
        let status_item = status_item as *mut AnyObject;
        let menu: *mut AnyObject = objc2::msg_send![status_item, menu];
        if menu.is_null() {
            return;
        }
        let visibility = objc2::sel!(setPreferredImageVisibility:);
        let count: isize = objc2::msg_send![menu, numberOfItems];
        for index in 0..count {
            let item: *mut AnyObject = objc2::msg_send![menu, itemAtIndex: index];
            if item.is_null() {
                continue;
            }
            let title: *mut AnyObject = objc2::msg_send![item, title];
            let utf8: *const std::ffi::c_char = if title.is_null() {
                std::ptr::null()
            } else {
                objc2::msg_send![title, UTF8String]
            };
            let is_about = !utf8.is_null() && std::ffi::CStr::from_ptr(utf8) == c"About";
            if let Some(png) = is_about.then(|| menu_icon_png("about", dark)).flatten() {
                let data: *mut AnyObject = objc2::msg_send![
                    objc2::class!(NSData),
                    dataWithBytes: png.as_ptr().cast::<std::ffi::c_void>(),
                    length: png.len()
                ];
                let image: *mut AnyObject = objc2::msg_send![objc2::class!(NSImage), alloc];
                let image: *mut AnyObject = objc2::msg_send![image, initWithData: data];
                if !image.is_null() {
                    let _: () =
                        objc2::msg_send![image, setSize: Size { width: 18.0, height: 18.0 }];
                    let _: () = objc2::msg_send![item, setImage: image];
                    // `setImage:` keeps its own reference; this one came from `alloc`.
                    let _: () = objc2::msg_send![image, release];
                }
            }
            let implemented: bool = objc2::msg_send![item, respondsToSelector: visibility];
            if implemented {
                // NSMenuItemImageVisibilityVisible
                let _: () = objc2::msg_send![item, setPreferredImageVisibility: 1isize];
            }
        }
    }
}

/// Rebuild both menus on the main thread, for a new state, appearance or dashboard offer.
fn refresh_menus<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    // The mock runtime runs "main thread" work on a worker, where AppKit menus panic. The menus
    // are not what the tests that start and stop a stack are about.
    if cfg!(test) {
        return;
    }
    let menus_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        let offered = menus_app
            .state::<Shell>()
            .intelligence_menu
            .lock()
            .unwrap()
            .is_some();
        if let Err(error) = install_menus(&menus_app, offered) {
            eprintln!("[menu] could not update the menus: {error}");
        }
    });
}

fn quit_menu_accelerator() -> Option<&'static str> {
    Some(QUIT_MENU_ACCELERATOR)
}

fn main() {
    tauri::Builder::default()
        // A second launch is somebody looking for the window they already have, not a request for a
        // second stack. Without this both copies bind the same ports and the loser reports a
        // failure that belongs to the winner.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            restore_after_second_instance(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(intelligence_bridge::plugin())
        .plugin(desktop_page::plugin())
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![
            record_setup_event,
            fit_setup_window,
            detect_engine,
            windows_blocker,
            windows_blocker_instruction,
            prepare_engine,
            prepare_installation,
            start_stack,
            reset_leftover_database,
            stop_stack,
            show_openbot,
            show_setup,
            already_running,
            last_failure,
            default_root,
            selected_root,
            harnesses,
            providers,
            already_configured,
            begin_claude_sign_in,
            finish_claude_sign_in,
            begin_chatgpt_sign_in,
            begin_model_oauth,
            finish_model_oauth,
            cancel_model_oauth,
            finish_chatgpt_sign_in,
            begin_self_hosted_intelligence_sign_in,
            finish_self_hosted_intelligence_sign_in,
            cancel_self_hosted_intelligence_sign_in,
            begin_intelligence_sign_in,
            finish_intelligence_sign_in,
            intelligence_key_for,
            create_intelligence_project,
            begin_organization_sign_in,
            finish_organization_sign_in,
            cancel_organization_sign_in,
            run_local_eval,
            list_local_eval,
            cancel_local_eval,
            open_local_intelligence,
            offer_local_intelligence,
            set_up_local_eval,
            sign_in_to_copilotkit,
            local_eval_terms,
            connect_local_eval,
            last_local_eval_stop_failure,
            ask_the_bot,
            quit_status,
            desktop_status,
            restart_openbot,
            stop_openbot_from_status,
        ])
        // A packaged application is not a browser tab. Left alone, WebView2 answers a right-click
        // with Back, Refresh, Save as and Print: Back walks the window out of OpenBot with nothing
        // to walk it home, and Save as offers to write the page to disk as `Webpage, complete`.
        // macOS never showed this because Tauri suppresses it there in release builds; Windows has
        // no such setting, and Tauri has no configuration option for it either, so the page is
        // asked to refuse. Every navigation, because the window navigates to OpenBot and back.
        .on_page_load(|window, payload| {
            let _ = window
                .eval("document.addEventListener('contextmenu', e => e.preventDefault(), true)");
            let page = window_page(window.app_handle(), payload.url());
            match_title_bar(&window.window(), page);
            if matches!(page, WindowPage::OwnedApp | WindowPage::LocalApp)
                && payload.event() == tauri::webview::PageLoadEvent::Finished
            {
                allow_window_drag(window.app_handle(), payload.url());
                if cfg!(target_os = "macos") {
                    let _ = window.eval(APP_THEME_PAGE);
                    if page == WindowPage::OwnedApp {
                        let _ = window.eval(OVERLAY_TITLE_BAR_PAGE);
                    }
                }
            }
        })
        // Closing the window hides it. A tray application whose window is destroyed on close has a
        // menu item that points at nothing: `get_webview_window` returns None from then on, and the
        // only way back is to quit and start again, with a stack still running that nothing on
        // screen can reach.
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            // The setup screens follow the system's light and dark, and so does their title bar.
            tauri::WindowEvent::ThemeChanged(_) => {
                let app = window.app_handle();
                // The menu bar's icons are drawn for each appearance.
                if window.label() == "main" {
                    refresh_menus(app);
                }
                if let Some(url) = app
                    .get_webview_window(window.label())
                    .and_then(|own| own.url().ok())
                {
                    match_title_bar(window, window_page(app, &url));
                }
            }
            _ => {}
        })
        .setup(|app| {
            desktop_telemetry::initialize(app.handle());
            if let Some(root) = app
                .path()
                .app_config_dir()
                .ok()
                .and_then(|config| preparation::selected_root(&config))
            {
                remember_selected_root(&app.state::<Shell>(), &root);
            }
            // Where the Compose provider OpenBot installs itself lives, told once so every engine
            // command can put it on the child's PATH. Before anything asks for an engine.
            engine::tools_live_in(engine::tools_dir_under(&acquire::download_dir(
                &stack::default_root(),
            )));

            remember_setup_url(app.handle())?;
            if let Some(main) = app.get_webview_window("main") {
                match_title_bar(&main.as_ref().window(), WindowPage::Setup);
            }
            fit_main_window_to_screen(app.handle());
            // Built by `generate_context!`, so the bridge plugin's permissions are compiled in.
            intelligence_bridge::enable(app.handle());

            // The status menu lets somebody open the window, stop the stack, or quit the app.
            tauri::tray::TrayIconBuilder::with_id("openbot")
                .icon(tray::icon())
                .icon_as_template(false)
                .tooltip("OpenBot")
                .build(app)?;
            install_menus(app.handle(), false)?;
            app.on_menu_event(|app, event| chose(app, event.id().as_ref()));
            #[cfg(target_os = "macos")]
            macos_quit::install(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the OpenBot window could not be created")
        .run(|app, event| {
            match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    show_whichever_applies(app);
                }
                tauri::RunEvent::ExitRequested { api, code, .. } => {
                    // Exit runs on the event-loop thread. Waiting there for Windows process
                    // inventory or Compose made Quit show "Not Responding". Keep the loop alive
                    // until cleanup finishes, then allow its final exit without repeating work.
                    let cleaning_app = app.clone();
                    let notice_app = app.clone();
                    let notice_failure_app = app.clone();
                    let exiting_app = app.clone();
                    if let Err(error) = request_quit_with(
                        std::sync::Arc::clone(&app.state::<Shell>().quit),
                        code,
                        || api.prevent_exit(),
                        move || quit_cleanup_shown(&cleaning_app),
                        QuitDiagnostics {
                            sink: move |failures: Vec<String>| {
                                for failure in &failures {
                                    eprintln!("{failure}");
                                }
                                let shell = notice_app.state::<Shell>();
                                let root = cleanup_root(&shell, &stack::default_root());
                                write_quit_cleanup_notice(&root, &failures)
                            },
                            failed: move |error: String| {
                                publish_quit_notice_failure(notice_failure_app.clone(), error)
                            },
                        },
                        move |code| exiting_app.exit(code),
                        |work| {
                            std::thread::Builder::new()
                                .name("openbot-quit-cleanup".into())
                                .spawn(work)
                                .map(|_| ())
                        },
                    ) {
                        eprintln!("[exit] could not start cleanup: {error}");
                        report(
                            app,
                            "quit",
                            false,
                            "OpenBot could not start shutting down. Try Quit again.",
                        );
                    }
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_an_app_that_makes_room_gets_the_overlay_title_bar() {
        let root = test_support::temp_root("titlebar-room");
        assert!(!app_makes_room_for_window_buttons(&root));
        std::fs::create_dir_all(root.join("app/src")).unwrap();
        std::fs::write(root.join("app/src/styles.css"), "body {}").unwrap();
        assert!(!app_makes_room_for_window_buttons(&root));
        std::fs::write(
            root.join("app/src/styles.css"),
            ":root[data-desktop-titlebar=\"overlay\"] [data-slot=\"sidebar-header\"] {}",
        )
        .unwrap();
        assert!(app_makes_room_for_window_buttons(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    use super::*;
    use std::io::{Read, Write};

    include!("stop_ipc_tests.rs");

    #[test]
    fn learning_default_is_written_only_for_the_provisioned_connection() {
        use std::collections::BTreeMap;
        let root = temp_root("learning-default-env");
        std::fs::create_dir_all(&root).unwrap();
        let proof = openbot_desktop_lib::intelligence::ProvisionedConnection {
            api_key: "runtime-key".into(),
            api_url: "https://api.intelligence.example".into(),
            learning_container_id: "openbot".into(),
        };
        for (api, key, existing, verified, expected) in [
            ("https://api.intelligence.example", "runtime-key", None, true, Some("openbot")),
            ("https://api.intelligence.example", "runtime-key", Some(""), true, Some("openbot")),
            ("https://api.intelligence.example/", "runtime-key", Some(""), true, Some("openbot")),
            ("https://other.example", "runtime-key", Some(""), true, None),
            ("https://api.intelligence.example", "other-key", Some(""), true, None),
            ("https://api.intelligence.example", "runtime-key", Some(""), false, None),
            ("https://api.intelligence.example", "runtime-key", Some("CPK_INTELLIGENCE_LEARNING_CONTAINER_ID=custom\nCPK_INTELLIGENCE_SKILLS_REVISION=7\n"), true, Some("custom")),
            ("https://api.intelligence.example", "runtime-key", Some("export \tCPK_INTELLIGENCE_LEARNING_CONTAINER_ID = custom\n"), true, Some("custom")),
        ] {
            if let Some(existing) = existing {
                std::fs::write(root.join(".env"), existing).unwrap();
            }
            let mut settings = BTreeMap::from([
                ("INTELLIGENCE_API_URL".into(), api.into()),
                ("INTELLIGENCE_API_KEY".into(), key.into()),
            ]);
            seed_learning_default(&root, &mut settings, verified.then_some(&proof)).unwrap();
            openbot_env::write(&root.join(".env"), &settings, &BTreeMap::new()).unwrap();
            let read = openbot_env::read_already_set(&root.join(".env"), &["CPK_INTELLIGENCE_LEARNING_CONTAINER_ID", "CPK_INTELLIGENCE_SKILLS_REVISION"]).unwrap();
            if let Some(exported) = existing.filter(|text| text.starts_with("export")) {
                // The shared setup reader does not parse export syntax; the file must keep the
                // custom assignment with no bare assignment appended to override it.
                assert!(!read.contains_key("CPK_INTELLIGENCE_LEARNING_CONTAINER_ID"));
                assert!(std::fs::read_to_string(root.join(".env")).unwrap().contains(exported));
                continue;
            }
            assert_eq!(read.get("CPK_INTELLIGENCE_LEARNING_CONTAINER_ID").map(String::as_str), expected);
            if expected == Some("custom") {
                assert_eq!(read.get("CPK_INTELLIGENCE_SKILLS_REVISION").map(String::as_str), Some("7"));
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn quit_menu_uses_the_standard_quit_shortcut() {
        assert_eq!(quit_menu_accelerator(), Some("CmdOrCtrl+KeyQ"));
    }

    #[test]
    fn responsive_quit_returns_while_cleanup_is_blocked_then_exits_in_order() {
        use std::sync::{mpsc, Arc};
        let state = Arc::new(QuitState::default());
        let (entered, cleanup_started) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let (returned, handler_returned) = mpsc::channel();
        let (exiting, exit_requested) = mpsc::channel();
        let events = Arc::new(Mutex::new(Vec::new()));
        let dispatch = {
            let state = state.clone();
            let before = events.clone();
            let during = events.clone();
            let after = events.clone();
            std::thread::spawn(move || {
                let result = request_quit_with(
                    state,
                    Some(37),
                    move || before.lock().unwrap().push("prevent"),
                    move || {
                        during.lock().unwrap().push("cleanup-started");
                        entered.send(()).unwrap();
                        released.recv().unwrap();
                        during.lock().unwrap().push("cleanup-finished");
                        Vec::new()
                    },
                    QuitDiagnostics {
                        sink: |_: Vec<String>| {
                            panic!("successful cleanup must not report a failure")
                        },
                        failed: |_: String| panic!("successful cleanup must not fail diagnostics"),
                    },
                    move |code| {
                        after.lock().unwrap().push("exit");
                        exiting.send(code).unwrap();
                    },
                    |work| std::thread::Builder::new().spawn(work).map(|_| ()),
                );
                returned.send(result).unwrap();
            })
        };
        cleanup_started
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let returned_before_cleanup =
            handler_returned.recv_timeout(std::time::Duration::from_millis(200));
        let exit_before_cleanup = exit_requested.try_recv();
        // Always release and join before asserting, including against the synchronous regression.
        release.send(()).unwrap();
        dispatch.join().unwrap();
        let exit_code = exit_requested
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(
            returned_before_cleanup.is_ok(),
            "Quit's event handler blocked waiting for cleanup"
        );
        returned_before_cleanup.unwrap().unwrap();
        assert!(matches!(
            exit_before_cleanup,
            Err(mpsc::TryRecvError::Empty)
        ));
        assert_eq!(exit_code, 37);
        assert_eq!(
            *events.lock().unwrap(),
            ["prevent", "cleanup-started", "cleanup-finished", "exit"]
        );
        request_quit_with(
            state,
            Some(37),
            || panic!("completed Quit must allow its final exit request"),
            || panic!("final exit must not repeat cleanup"),
            QuitDiagnostics {
                sink: |_: Vec<String>| panic!("final exit must not repeat diagnostics"),
                failed: |_: String| panic!("final exit must not fail diagnostics"),
            },
            |_| panic!("final exit must not request another exit"),
            |_| panic!("final exit must not launch another worker"),
        )
        .unwrap();
    }

    #[test]
    fn responsive_quit_coalesces_duplicates_and_preserves_the_first_exit_code() {
        use std::sync::Arc;
        let state = Arc::new(QuitState::default());
        let work = std::cell::RefCell::new(None);
        let prevented = std::cell::Cell::new(0);
        let (exiting, exited) = std::sync::mpsc::channel();
        request_quit_with(
            state.clone(),
            Some(23),
            || prevented.set(prevented.get() + 1),
            Vec::new,
            QuitDiagnostics {
                sink: |_: Vec<String>| panic!("no cleanup failure"),
                failed: |_: String| panic!("successful cleanup must not fail diagnostics"),
            },
            move |code| exiting.send(code).unwrap(),
            |task| {
                *work.borrow_mut() = Some(task);
                Ok(())
            },
        )
        .unwrap();
        request_quit_with(
            state.clone(),
            Some(0),
            || prevented.set(prevented.get() + 1),
            || panic!("duplicate Quit must not run cleanup"),
            QuitDiagnostics {
                sink: |_: Vec<String>| panic!("duplicate Quit must not report"),
                failed: |_: String| panic!("duplicate Quit must not fail diagnostics"),
            },
            |_| panic!("duplicate Quit must not replace the saved exit code"),
            |_| panic!("duplicate Quit must not launch another worker"),
        )
        .unwrap();
        assert_eq!(prevented.get(), 2);
        assert!(matches!(
            exited.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        work.into_inner().expect("one cleanup worker")();
        assert_eq!(exited.recv().unwrap(), 23);
        request_quit_with(
            state,
            None,
            || prevented.set(prevented.get() + 1),
            || panic!("a late Quit must not repeat cleanup"),
            QuitDiagnostics {
                sink: |_: Vec<String>| panic!("a late Quit must not report"),
                failed: |_: String| panic!("a late Quit must not fail diagnostics"),
            },
            |_| panic!("a late Quit must not replace the saved exit code"),
            |_| panic!("a late Quit must not launch another worker"),
        )
        .unwrap();
        assert_eq!(prevented.get(), 3);
    }

    #[test]
    fn responsive_quit_reports_cleanup_failures_before_requesting_exit() {
        use std::sync::Arc;
        let state = Arc::new(QuitState::default());
        let events = Arc::new(Mutex::new(Vec::new()));
        let diagnostics = events.clone();
        let exiting = events.clone();
        let work = std::cell::RefCell::new(None);
        request_quit_with(
            state,
            None,
            || {},
            || {
                vec![
                    "host cleanup refused".into(),
                    "Compose down failed: synthetic".into(),
                ]
            },
            QuitDiagnostics {
                sink: move |lines: Vec<String>| {
                    diagnostics.lock().unwrap().extend(lines);
                    Ok(())
                },
                failed: |_: String| panic!("diagnostics should be recorded"),
            },
            move |code| exiting.lock().unwrap().push(format!("exit:{code}")),
            |task| {
                *work.borrow_mut() = Some(task);
                Ok(())
            },
        )
        .unwrap();
        assert!(
            events.lock().unwrap().is_empty(),
            "cleanup ran on the requesting thread"
        );
        work.into_inner().expect("cleanup worker")();
        assert_eq!(
            *events.lock().unwrap(),
            [
                "[exit] cleanup failed: host cleanup refused",
                "[exit] cleanup failed: Compose down failed: synthetic",
                "exit:0"
            ]
        );
    }

    #[test]
    fn responsive_quit_launch_failure_preserves_the_app_and_allows_retry() {
        use std::sync::Arc;
        let state = Arc::new(QuitState::default());
        let prevented = std::cell::Cell::new(0);
        let result = request_quit_with(
            state.clone(),
            Some(7),
            || prevented.set(prevented.get() + 1),
            || panic!("failed launch must not run cleanup"),
            QuitDiagnostics {
                sink: |_: Vec<String>| panic!("failed launch must not report cleanup errors"),
                failed: |_: String| panic!("failed launch must not fail diagnostics"),
            },
            |_| panic!("failed launch must not exit"),
            |_| Err(std::io::Error::other("synthetic worker launch failure")),
        );
        assert_eq!(
            result.unwrap_err().to_string(),
            "synthetic worker launch failure"
        );
        assert_eq!(prevented.get(), 1);
        let work = std::cell::RefCell::new(None);
        let (exiting, exited) = std::sync::mpsc::channel();
        request_quit_with(
            state,
            Some(9),
            || prevented.set(prevented.get() + 1),
            Vec::new,
            QuitDiagnostics {
                sink: |_: Vec<String>| panic!("retry cleanup succeeded"),
                failed: |_: String| panic!("retry cleanup must not fail diagnostics"),
            },
            move |code| exiting.send(code).unwrap(),
            |task| {
                *work.borrow_mut() = Some(task);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(prevented.get(), 2);
        assert!(matches!(
            exited.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        work.into_inner().expect("retry launches a worker")();
        assert_eq!(exited.recv().unwrap(), 9);
    }

    #[test]
    fn quit_cleanup_notice_is_known_safe_bounded_and_consumed_once() {
        let root = temp_root("openbot-quit-cleanup-notice");
        let lines = vec![
            "[exit] cleanup failed: Compose down failed: /Users/alice/OpenBot/docker-compose.yml refused token=secret".to_string(),
            "[exit] cleanup failed: C:\\Users\\alice\\OpenBot\\owned.exe OAuth password".to_string(),
        ];

        write_quit_cleanup_notice(&root, &lines).unwrap();
        let first = read_quit_cleanup_notice(&root)
            .unwrap()
            .expect("notice should be present");
        let detail = first.detail.unwrap();
        assert_eq!(first.said, "OpenBot had trouble shutting down last time.");
        assert!(detail.contains("containers stopped"), "{detail}");
        assert!(detail.contains("app processes stopped"), "{detail}");
        assert!(!detail.contains("Compose down failed"), "{detail}");
        assert!(!detail.contains("/Users/alice"), "{detail}");
        assert!(!detail.contains("C:\\Users\\alice"), "{detail}");
        assert!(!detail.contains("token=secret"), "{detail}");
        assert!(!detail.contains("OAuth"), "{detail}");
        assert!(read_quit_cleanup_notice(&root).unwrap().is_none());
    }

    #[test]
    fn diagnostic_sink_failure_keeps_quit_from_completing_exit() {
        use std::sync::Arc;
        let state = Arc::new(QuitState::default());
        let work = std::cell::RefCell::new(None);
        let failures = Arc::new(Mutex::new(Vec::new()));
        let captured = failures.clone();
        let exited = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let first_exit = exited.clone();
        request_quit_with(
            state.clone(),
            None,
            || {},
            || vec!["raw cleanup failure".into()],
            QuitDiagnostics {
                sink: |_: Vec<String>| Err("notice file is unavailable".into()),
                failed: move |error: String| captured.lock().unwrap().push(error),
            },
            move |_| {
                first_exit.store(true, std::sync::atomic::Ordering::SeqCst);
            },
            |task| {
                *work.borrow_mut() = Some(task);
                Ok(())
            },
        )
        .unwrap();

        work.into_inner().expect("cleanup worker")();
        assert!(
            !exited.load(std::sync::atomic::Ordering::SeqCst),
            "Quit exited after losing its notice sink"
        );
        let reported = failures.lock().unwrap().join("\n");
        assert!(
            reported.contains("notice file is unavailable"),
            "{reported}"
        );
        assert!(
            reported.contains("[exit] cleanup failed: raw cleanup failure"),
            "{reported}"
        );
        let second_exit = exited.clone();
        request_quit_with(
            state,
            None,
            || {},
            Vec::new,
            QuitDiagnostics {
                sink: |_: Vec<String>| Ok(()),
                failed: |_: String| panic!("diagnostics now succeed"),
            },
            move |_| {
                second_exit.store(true, std::sync::atomic::Ordering::SeqCst);
            },
            |task| {
                task();
                Ok(())
            },
        )
        .unwrap();
        assert!(
            exited.load(std::sync::atomic::Ordering::SeqCst),
            "Quit did not retry after diagnostic failure"
        );
    }

    #[test]
    fn ask_transport_regressions_do_not_load_from_the_vault() {
        let source = include_str!("main.rs");
        let test = source
            .split("\n    fn ask_the_bot_uses_native_mastra_for_a_picked_mastra_harness()")
            .nth(1)
            .expect("ID12 regression")
            .split("struct TestRequest")
            .next()
            .expect("ID12 regression body");

        assert!(
            !test.contains("ask_the_bot("),
            "ID12 must test dispatch with resolved settings instead of loading vault-backed settings"
        );
    }

    #[test]
    fn runtime_connection_recovery_retains_installation_and_rejects_stale_run_notifications() {
        let root = temp_root("runtime-connection-recovery");
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(root.clone());
        remember_selected_root(&shell, &root);
        *shell.setup_url.lock().unwrap() = Some("http://tauri.localhost/recovery".into());
        shell
            .generation
            .store(7, std::sync::atomic::Ordering::SeqCst);
        let app = tauri::test::mock_builder()
            .manage(shell)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        window
            .navigate("http://127.0.0.1:3010/channel/existing".parse().unwrap())
            .unwrap();
        let connection = openbot_desktop_lib::problem::Connection::Model;
        assert!(!publish_connection_failure(app.handle(), &root, 6, connection.clone()).unwrap());
        assert!(!publish_connection_failure(
            app.handle(),
            &root.join("another"),
            7,
            connection.clone()
        )
        .unwrap());
        assert_eq!(window.url().unwrap().path(), "/channel/existing");
        assert!(publish_connection_failure(app.handle(), &root, 7, connection).unwrap());
        let shell = app.state::<Shell>();
        assert_eq!(shell.root.lock().unwrap().as_ref(), Some(&root));
        assert_eq!(shell.selected_root.lock().unwrap().as_ref(), Some(&root));
        assert!(recovery_required(&shell, &root));
        assert_eq!(
            window.url().unwrap().as_str(),
            "http://tauri.localhost/recovery"
        );
        assert_eq!(
            last_failure(app.handle().clone()).unwrap().connection,
            Some(openbot_desktop_lib::problem::Connection::Model)
        );
        assert!(publish_connection_failure(
            app.handle(),
            &root,
            7,
            openbot_desktop_lib::problem::Connection::Intelligence
        )
        .unwrap());
        assert!(
            last_failure(app.handle().clone()).is_none(),
            "one refresh per run; a second signal cannot replace the pending screen"
        );
    }

    #[test]
    fn stop_retains_completed_installation_and_disables_only_automatic_start() {
        let root = temp_root("stopped-completed-installation");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(preparation::FILE), "{}").unwrap();
        preparation::record_launch(
            &root,
            Some(&harness::HarnessChoice {
                id: "mastra".into(),
                agent_url: None,
            }),
        )
        .unwrap();
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.state::<Shell>()
            .stopped_in_session
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let configured = serde_json::to_value(already_configured(
            app.handle().clone(),
            root.to_string_lossy().into_owned(),
        ))
        .unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(configured["launch"]["harness"]["id"], "mastra");
        assert_eq!(configured["autoStart"], false);
    }

    #[test]
    fn public_already_configured_reads_only_passive_files() {
        let root = temp_root("public-passive-boundary");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(".env"),
            "INTELLIGENCE_API_URL=https://synthetic.example\n",
        )
        .unwrap();
        for metadata in [
            None,
            Some("malformed"),
            Some(r#"{"version":9,"categories":["intelligence"],"model":null}"#),
            Some(
                r#"{"version":1,"categories":["intelligence","claude-plan"],"model":"claude-plan"}"#,
            ),
        ] {
            if let Some(metadata) = metadata {
                std::fs::write(root.join(openbot_desktop_lib::saved_intent::FILE), metadata)
                    .unwrap();
            }
            for legacy in ["", "INTELLIGENCE_API_KEY=synthetic-cpk\nOPENAI_API_KEY=synthetic-openai\nANTHROPIC_API_KEY=synthetic-anthropic\nCLAUDE_CODE_OAUTH_TOKEN=synthetic-claude\n"] {
                std::fs::write(root.join(".env"), format!("INTELLIGENCE_API_URL=https://synthetic.example\n{legacy}")).unwrap();
                let configured = already_configured_for_root(root.to_string_lossy().into_owned());
                assert_eq!(configured.values["INTELLIGENCE_API_URL"], "https://synthetic.example");
                assert!(!configured.values.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn launch_never_downloads_missing_images() {
        if test_support::isolated_process("tests::launch_never_downloads_missing_images") {
            return;
        }
        let _path = SerializedPath::set_only_with("docker", "installation-boundary");
        let root = temp_root("launch-without-installation");
        std::fs::create_dir_all(&root).unwrap();
        let address = engine::Address::new(engine::Engine::Docker, None);
        let secrets = stack::Secrets::new();
        let up = stack::up(&address, &root, false, stack::BundledBots::none(), &secrets);
        let migrate = stack::migrate(&address, &root, &secrets);
        std::fs::remove_dir_all(root).unwrap();
        assert!(up.is_ok(), "{up:?}");
        assert!(migrate.is_ok(), "{migrate:?}");
    }

    #[test]
    fn deployment_ready_preserves_the_installed_release() {
        let root = temp_root("deployment-ready-pinned");
        write_installed_deployment(&root);
        deployment::record(&root, "v0.0.7").unwrap();
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();

        tauri::async_runtime::block_on(deployment_ready(app.handle(), &root)).unwrap();

        assert_eq!(deployment::installed(&root).unwrap().version, "v0.0.7");
        assert_eq!(
            std::fs::read_to_string(root.join("docker-compose.yml")).unwrap(),
            "services: {}\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plan_sign_in_boundary_uses_selected_root_for_reference_without_acquisition() {
        let default = temp_root("signin-default-root");
        let selected = temp_root("signin-selected-root");
        std::fs::create_dir_all(&default).unwrap();
        std::fs::create_dir_all(&selected).unwrap();
        std::fs::write(default.join("manifest.json"), "poisoned-default").unwrap();
        let reference_root = std::cell::RefCell::new(None);

        let image = sign_in_reference(
            &selected,
            openbot_desktop_lib::plan::CHATGPT_SIGN_IN_IMAGE,
            |root, published| {
                *reference_root.borrow_mut() = Some((root.to_path_buf(), published.to_string()));
                Ok(format!("{}@{}", published, root.display()))
            },
        )
        .unwrap();

        assert_eq!(
            reference_root.into_inner(),
            Some((
                selected.clone(),
                openbot_desktop_lib::plan::CHATGPT_SIGN_IN_IMAGE.to_string()
            ))
        );
        assert!(image.contains(&selected.to_string_lossy().to_string()));
        assert!(!image.contains(&default.to_string_lossy().to_string()));
        assert_eq!(
            std::fs::read_to_string(default.join("manifest.json")).unwrap(),
            "poisoned-default"
        );
        let _ = std::fs::remove_dir_all(default);
        let _ = std::fs::remove_dir_all(selected);
    }

    #[test]
    fn command_roots_trim_paste_padding_and_preserve_interior_spaces() {
        let root = temp_root("openbot-command-root My Files");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("settings-marker"), "this deployment").unwrap();
        for typed in [
            root.display().to_string(),
            format!(" \n{}\t ", root.display()),
        ] {
            let work_root = stack::root_from(&typed);
            assert_eq!(
                std::fs::read_to_string(work_root.join("settings-marker")).unwrap(),
                "this deployment"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn credential_restore_commands_are_not_registered() {
        let source = include_str!("main.rs");
        let handlers = source
            .split("tauri::generate_handler![")
            .nth(1)
            .expect("handler list exists")
            .split("])")
            .next()
            .expect("handler list closes");
        for command in [
            ["reco", "ver", "_credential"].concat(),
            ["cancel", "_credential", "_reco", "very"].concat(),
        ] {
            assert!(
                !handlers.contains(&command),
                "{command} is still registered"
            );
        }
    }

    #[test]
    fn already_configured_trims_pasted_root_and_preserves_interior_spaces() {
        let root = temp_root("openbot-pasted-root My Files");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(".env"),
            "INTELLIGENCE_API_URL=https://trim.example.test\n",
        )
        .unwrap();
        let typed = format!(" \n{}\t ", root.display());
        let configured = already_configured_for_root(typed);
        let normal = already_configured_for_root(root.to_string_lossy().into_owned());
        assert_eq!(configured.values, normal.values);
        assert_eq!(
            configured.values.get("INTELLIGENCE_API_URL"),
            Some(&"https://trim.example.test".to_string())
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn already_configured_returns_file_values_and_saved_indicators() {
        let root = temp_root("openbot-already-configured");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(".env"),
            "INTELLIGENCE_API_KEY=file-cpk\nOPENAI_API_KEY=file-openai\nOPENAI_BASE_URL=https://models.example/v1\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join(".langchain")).unwrap();
        std::fs::write(
            root.join(openbot_env::CHATGPT_STORE_FILE),
            "{\"refresh_token\":\"stored\"}\n",
        )
        .unwrap();

        let configured = already_configured_for_root(root.to_string_lossy().into_owned());

        assert_eq!(
            configured.values.get("INTELLIGENCE_API_KEY"),
            Some(&"file-cpk".to_string())
        );
        assert_eq!(
            configured.values.get("OPENAI_API_KEY"),
            Some(&"file-openai".to_string())
        );
        assert_eq!(configured.saved.intelligence_api_key, Some(true));
        assert_eq!(configured.saved.model_api_keys.openai, Some(true));
        assert_eq!(configured.saved.model_sessions.openai, Some(true));
        assert_eq!(configured.saved.model_sessions.anthropic, None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn already_configured_reports_legacy_anthropic_plan_without_returning_token() {
        let root = temp_root("openbot-already-configured-anthropic-session");
        std::fs::create_dir_all(&root).unwrap();

        std::fs::write(
            root.join(".env"),
            "CLAUDE_CODE_OAUTH_TOKEN=synthetic-legacy-plan\n",
        )
        .unwrap();
        let configured = already_configured_for_root(root.to_string_lossy().into_owned());

        assert_eq!(configured.saved.model_sessions.anthropic, Some(true));
        assert!(!configured.values.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn second_instance_restore_runs_blocking_probe_outside_the_async_listener() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 512];
            let _ = stream.read(&mut request).unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });
        let (sent, received) = std::sync::mpsc::channel();

        let scheduled = tauri::async_runtime::block_on(async move {
            tauri::async_runtime::spawn(async move {
                schedule_second_instance_restore(port, move |port| {
                    sent.send(stack::app_url(port).is_some()).unwrap();
                })
                .unwrap()
                .join()
                .unwrap();
            })
            .await
        });

        assert!(
            scheduled.is_ok(),
            "the async single-instance listener must not panic while scheduling restore"
        );
        assert!(received.recv().unwrap());
        server.join().unwrap();
    }

    #[test]
    fn passive_metadata_and_legacy_hints_are_root_and_provider_scoped() {
        let root = temp_root("public-intent-cases");
        std::fs::create_dir_all(&root).unwrap();
        for input in [
            None,
            Some("bad json"),
            Some(r#"{"version":42,"categories":["intelligence"],"model":null}"#),
        ] {
            if let Some(input) = input {
                std::fs::write(root.join(openbot_desktop_lib::saved_intent::FILE), input).unwrap();
            }
            let unknown = already_configured_for_root(root.to_string_lossy().into_owned());
            assert_eq!(unknown.saved.intelligence_api_key, None);
            assert_eq!(unknown.saved.model_sessions.anthropic, None);
        }
        std::fs::write(
            root.join(openbot_desktop_lib::saved_intent::FILE),
            r#"{"version":1,"categories":["intelligence","claude-plan"],"model":"claude-plan"}"#,
        )
        .unwrap();
        let recorded = already_configured_for_root(root.to_string_lossy().into_owned());
        assert_eq!(recorded.saved.intelligence_api_key, Some(true));
        assert_eq!(recorded.saved.model_sessions.anthropic, Some(true));
        assert_eq!(recorded.saved.model_api_keys.anthropic, None);
        assert_eq!(recorded.saved.model_sessions.openai, None);
        assert!(recorded.values.is_empty());
        let fresh = already_configured_for_root(
            temp_root("different-public-root")
                .to_string_lossy()
                .into_owned(),
        );
        assert_eq!(fresh.saved.model_sessions.anthropic, None);
        std::fs::write(
            root.join(".env"),
            "ANTHROPIC_API_KEY=synthetic-legacy-anthropic\n",
        )
        .unwrap();
        let legacy = already_configured_for_root(root.to_string_lossy().into_owned());
        assert_eq!(legacy.saved.model_api_keys.anthropic, Some(true));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saved_selection_refusal_never_falls_back_to_a_different_provider_or_billing_mode() {
        let root = temp_root("explicit-saved-refusal");
        for (provider, login, expected) in [
            ("openai", "api-key", "OPENAI_API_KEY"),
            ("anthropic", "api-key", "ANTHROPIC_API_KEY"),
            ("anthropic", "plan", "CLAUDE_CODE_OAUTH_TOKEN"),
        ] {
            for denied in [false, true] {
                let mut calls = Vec::new();
                let choice = ChosenModel {
                    provider: provider.into(),
                    login: login.into(),
                    api_key: Some("synthetic-unselected-billable-key".into()),
                    base_url: None,
                    container_base_url: None,
                    model: None,
                    token: None,
                    saved: Some(true),
                };
                let result = start_stack_credential_with(&root, choice, |_, key| {
                    calls.push(key.to_string());
                    if denied {
                        Err(Problem::plain("synthetic access denied"))
                    } else {
                        Ok(String::new())
                    }
                });
                let problem = result.expect_err("selected credential is unavailable");
                assert!(!problem.said.is_empty());
                assert_eq!(
                    problem.connection,
                    Some(openbot_desktop_lib::problem::Connection::Model)
                );
                if denied {
                    assert_eq!(problem.said, "synthetic access denied");
                }
                assert_eq!(calls, [expected]);
            }
        }
        for denied in [false, true] {
            let result = intelligence_key_for_start(&root, String::new(), |_, key| {
                assert_eq!(key, "INTELLIGENCE_API_KEY");
                if denied {
                    Err(Problem::plain("synthetic access denied"))
                } else {
                    Ok(String::new())
                }
            });
            assert_eq!(
                result.unwrap_err().connection,
                Some(openbot_desktop_lib::problem::Connection::Intelligence)
            );
        }
        // A missing or unreadable ChatGPT file is an action error; no API-key resolver is called.
        std::fs::create_dir_all(&root).unwrap();
        for unreadable in [false, true] {
            if unreadable {
                std::fs::create_dir_all(root.join(openbot_env::CHATGPT_STORE_FILE)).unwrap();
            }
            let choice = ChosenModel {
                provider: "openai".into(),
                login: "plan".into(),
                api_key: Some("synthetic-unselected-key".into()),
                base_url: None,
                container_base_url: None,
                model: None,
                token: None,
                saved: Some(true),
            };
            assert!(start_stack_credential_with(&root, choice, |_, _| panic!(
                "plan must not fall back to an API key"
            ))
            .is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oauth_start_reads_private_session_without_contacting_unstarted_proxy() {
        let root = temp_root("oauth-start");
        std::fs::create_dir_all(root.join(".openbot")).unwrap();
        for provider in ["google", "xai"] {
            let path = root.join(openbot_desktop_lib::provider_oauth::FILE);
            let record = serde_json::json!({"version":1,"sessionId":"synthetic-session","provider":provider,"clientId":"synthetic-client","accessToken":"synthetic-access","refreshToken":"synthetic-refresh","expiresAt":1,"scope":"synthetic","proxyToken":"synthetic-proxy"});
            std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
            let choice = ChosenModel {
                provider: provider.into(),
                login: "oauth".into(),
                api_key: None,
                base_url: None,
                container_base_url: None,
                model: Some("chosen-model".into()),
                token: None,
                saved: Some(true),
            };
            let credential = start_stack_credential_with(&root, choice, |_, _| {
                panic!("OAuth must not resolve an API key")
            })
            .unwrap();
            assert_eq!(
                credential,
                openbot_env::ModelCredential::ProviderOAuth {
                    provider: provider.into(),
                    path: path.to_string_lossy().into_owned(),
                    proxy_token: "synthetic-proxy".into(),
                    model: "chosen-model".into()
                }
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn start_and_ask_resolve_saved_secrets_from_the_selected_root() {
        let root_a = temp_root("selected-saved-root-a");
        let root_b = temp_root("selected-saved-root-b");
        for (root, label) in [(&root_a, "a"), (&root_b, "b")] {
            std::fs::create_dir_all(root).unwrap();
            std::fs::write(
                root.join(".env"),
                format!("MANAGED_AGENT_AG_UI_URL=https://agent-{label}.example\n"),
            )
            .unwrap();
            openbot_desktop_lib::vault::remember(
                root,
                "OPENAI_API_KEY",
                &format!("openai-{label}"),
            )
            .unwrap();
            openbot_desktop_lib::vault::remember(
                root,
                "MANAGED_AGENT_TOKEN",
                &format!("agent-{label}"),
            )
            .unwrap();
        }

        let credential = start_stack_credential_with(
            &root_b,
            ChosenModel {
                provider: "openai".into(),
                login: "api-key".into(),
                api_key: None,
                base_url: None,
                container_base_url: None,
                model: None,
                token: None,
                saved: Some(true),
            },
            saved_secret,
        )
        .unwrap();
        assert_eq!(
            credential,
            openbot_env::ModelCredential::OpenAi {
                api_key: "openai-b".into()
            }
        );

        let settings = ask_saved_settings(&root_b).unwrap();
        assert_eq!(
            settings.get("MANAGED_AGENT_AG_UI_URL").map(String::as_str),
            Some("https://agent-b.example")
        );
        assert_eq!(
            settings.get("MANAGED_AGENT_TOKEN").map(String::as_str),
            Some("agent-b")
        );

        std::fs::remove_dir_all(root_a).unwrap();
        std::fs::remove_dir_all(root_b).unwrap();
    }

    #[test]
    fn saved_api_key_start_reports_unreadable_env_before_store_resolution() {
        let root = temp_root("start-unreadable-env");
        std::fs::create_dir_all(root.join(".env")).unwrap();

        let problem = start_stack_credential(
            &root,
            ChosenModel {
                provider: "openai".into(),
                login: "api-key".into(),
                api_key: None,
                base_url: None,
                container_base_url: None,
                model: None,
                token: None,
                saved: Some(true),
            },
        )
        .expect_err("unreadable .env must stop saved-key resolution");

        assert_eq!(problem.said, "OpenBot could not read its settings.");
        assert!(
            problem
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains(root.join(".env").to_string_lossy().as_ref())),
            "{problem:?}"
        );
        assert!(root.join(".env").is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ask_reports_unreadable_env_before_store_resolution_or_http() {
        let root = temp_root("ask-unreadable-env");
        std::fs::create_dir_all(root.join(".env")).unwrap();

        let problem =
            tauri::async_runtime::block_on(ask_the_bot_inner(root.clone(), "hello".into()))
                .expect_err("unreadable .env must stop Ask before transport");

        assert_eq!(problem.said, "OpenBot could not read its settings.");
        assert!(
            problem
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains(root.join(".env").to_string_lossy().as_ref())),
            "{problem:?}"
        );
        assert!(root.join(".env").is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_installation_rejects_unusable_original_encryption_keys() {
        for marker in ["database", "model"] {
            let root = temp_root(&format!("unusable-existing-encryption-key-{marker}"));
            std::fs::create_dir_all(&root).unwrap();
            if marker == "database" {
                std::fs::write(
                    root.join(".env"),
                    "DATABASE_URL=postgres://synthetic-local\n",
                )
                .unwrap();
            } else {
                std::fs::write(
                    root.join(openbot_desktop_lib::saved_intent::FILE),
                    r#"{"version":1,"categories":[],"model":"open-ai-api-key"}"#,
                )
                .unwrap();
                assert!(openbot_desktop_lib::saved_intent::SavedIntent::read(&root)
                    .model
                    .is_some());
            }
            for original in [
                None,
                Some(""),
                Some("   "),
                Some("not-base64"),
                Some("c2hvcnQ="),
                Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
            ] {
                let secrets = original
                    .map(|value| {
                        std::collections::BTreeMap::from([(
                            "KEY_ENCRYPTION_KEY".into(),
                            value.into(),
                        )])
                    })
                    .unwrap_or_default();
                assert!(
                    require_existing_encryption_key(&root, &secrets, || {
                        panic!("configured roots already require their original key")
                    })
                    .is_err(),
                    "{marker}: {original:?}"
                );
            }
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn configured_root_without_original_key_is_rejected_but_fresh_root_is_allowed() {
        let root = temp_root("valid-existing-encryption-key");
        std::fs::create_dir_all(&root).unwrap();
        assert!(
            require_existing_encryption_key(&root, &std::collections::BTreeMap::new(), || Ok(
                false
            ))
            .is_ok()
        );
        assert!(
            require_existing_encryption_key(&root, &std::collections::BTreeMap::new(), || Ok(true))
                .is_err()
        );
        let unavailable = Problem::plain("selected engine unavailable");
        assert_eq!(
            require_existing_encryption_key(&root, &std::collections::BTreeMap::new(), || Err(
                unavailable.clone()
            )),
            Err(unavailable)
        );
        std::fs::write(
            root.join(".env"),
            "DATABASE_URL=postgres://synthetic-local\n",
        )
        .unwrap();
        let original = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
        let secrets =
            std::collections::BTreeMap::from([("KEY_ENCRYPTION_KEY".into(), original.into())]);
        assert!(require_existing_encryption_key(&root, &secrets, || {
            panic!("normal resume with the original key needs no volume probe")
        })
        .is_ok());
        assert_eq!(secrets["KEY_ENCRYPTION_KEY"], original);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn leftover_database_recovery_is_offered_only_for_a_proven_fresh_root() {
        let root = temp_root("leftover-database-offer");
        std::fs::create_dir_all(&root).unwrap();
        let error = require_existing_encryption_key_with_recovery(
            &root,
            &stack::Secrets::new(),
            || Ok(true),
            || Ok(Some("openbot_postgres-data".into())),
        )
        .unwrap_err();
        assert_eq!(
            serde_json::to_value(error).unwrap()["database_reset"],
            "openbot_postgres-data"
        );
        for (file, content) in [
            (".env", "DATABASE_URL=postgres://fixture\n"),
            (
                openbot_desktop_lib::saved_intent::FILE,
                r#"{"version":1,"categories":[],"model":"open-ai-api-key"}"#,
            ),
            (
                openbot_desktop_lib::saved_intent::FILE,
                "invalid-settings-secret",
            ),
            (
                openbot_desktop_lib::saved_intent::FILE,
                r#"{"version":99,"categories":[],"model":null}"#,
            ),
        ] {
            std::fs::write(root.join(file), content).unwrap();
            let error = require_existing_encryption_key_with_recovery(
                &root,
                &stack::Secrets::new(),
                || Ok(true),
                || panic!("unknown or configured roots must not offer deletion"),
            )
            .unwrap_err();
            assert!(serde_json::to_value(error)
                .unwrap()
                .get("database_reset")
                .is_none());
            std::fs::remove_file(root.join(file)).unwrap();
        }
        let secrets = stack::Secrets::from([(
            "KEY_ENCRYPTION_KEY".into(),
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=".into(),
        )]);
        assert!(require_existing_encryption_key_with_recovery(
            &root,
            &secrets,
            || panic!("original key needs no probe"),
            || panic!("original key needs no reset")
        )
        .is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn leftover_database_reset_rechecks_confirmation_configuration_key_and_ownership() {
        let root = temp_root("leftover-database-command");
        std::fs::create_dir_all(&root).unwrap();
        let shell = Shell::default();
        let offer = || {
            *shell.leftover_database.lock().unwrap() = Some(LeftoverDatabase {
                root: root.clone(),
                volume: "openbot_postgres-data".into(),
                address: engine::Address::new(
                    engine::Engine::Podman,
                    Some("original-machine".into()),
                ),
            });
        };
        offer();
        assert!(reset_leftover_database_with(
            &shell,
            &root,
            "openbot_postgres-data",
            false,
            || panic!("unconfirmed must not access credentials"),
            |_, _| panic!("unconfirmed must not delete")
        )
        .is_err());
        assert!(reset_leftover_database_with(
            &shell,
            &root,
            "openbot_postgres-data",
            true,
            || Ok(stack::Secrets::new()),
            |_, _| Ok(())
        )
        .is_ok());
        offer();
        for (file, content) in [
            (".env", "DATABASE_URL=postgres://fixture\n"),
            (
                openbot_desktop_lib::saved_intent::FILE,
                r#"{"version":1,"categories":[],"model":"open-ai-api-key"}"#,
            ),
            (
                openbot_desktop_lib::saved_intent::FILE,
                "invalid-settings-secret",
            ),
        ] {
            std::fs::write(root.join(file), content).unwrap();
            assert!(reset_leftover_database_with(
                &shell,
                &root,
                "openbot_postgres-data",
                true,
                || Ok(stack::Secrets::new()),
                |_, _| panic!("configured or unknown root must not delete")
            )
            .is_err());
            std::fs::remove_file(root.join(file)).unwrap();
        }
        std::fs::create_dir(root.join(".env")).unwrap();
        assert!(reset_leftover_database_with(
            &shell,
            &root,
            "openbot_postgres-data",
            true,
            || Ok(stack::Secrets::new()),
            |_, _| panic!("unreadable settings must not delete")
        )
        .is_err());
        std::fs::remove_dir(root.join(".env")).unwrap();
        let secrets = stack::Secrets::from([(
            "KEY_ENCRYPTION_KEY".into(),
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=".into(),
        )]);
        assert!(reset_leftover_database_with(
            &shell,
            &root,
            "openbot_postgres-data",
            true,
            || Ok(secrets),
            |_, _| panic!("restored key must prevent deletion")
        )
        .is_err());
        *shell.root.lock().unwrap() = Some(root.clone());
        assert!(reset_leftover_database_with(
            &shell,
            &root,
            "openbot_postgres-data",
            true,
            || panic!("owned hosts must refuse before credential access"),
            |_, _| panic!("owned hosts must prevent deletion")
        )
        .is_err());
        *shell.root.lock().unwrap() = None;
        *shell.containers.lock().unwrap() = Some(ContainerDeployment {
            root: root.clone(),
            address: engine::Address::new(engine::Engine::Podman, Some("fixture".into())),
        });
        assert!(reset_leftover_database_with(
            &shell,
            &root,
            "openbot_postgres-data",
            true,
            || panic!("owned containers must refuse"),
            |_, _| panic!("owned containers must prevent deletion")
        )
        .is_err());
        *shell.containers.lock().unwrap() = None;
        let attempt = StartAttempt::begin(&shell).unwrap();
        assert!(reset_leftover_database_with(
            &shell,
            &root,
            "openbot_postgres-data",
            true,
            || panic!("concurrent startup must refuse"),
            |_, _| panic!("concurrent startup must prevent deletion")
        )
        .is_err());
        drop(attempt);
        assert!(reset_leftover_database_with(
            &shell,
            &root,
            "openbot_postgres-data",
            true,
            || Ok(stack::Secrets::new()),
            |_, _| {
                assert!(
                    shell.startup.try_lock().is_err(),
                    "deletion must retain the startup lock"
                );
                assert!(
                    StartAttempt::begin(&shell).is_err(),
                    "startup must remain excluded during deletion"
                );
                Ok(())
            }
        )
        .is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn leftover_database_reset_keeps_offered_runtime_and_rejects_stale_offers() {
        if crate::test_support::isolated_process(
            "tests::leftover_database_reset_keeps_offered_runtime_and_rejects_stale_offers",
        ) {
            return;
        }
        let root = temp_root("leftover-database-affinity");
        std::fs::create_dir_all(&root).unwrap();
        let shell = Shell::default();
        let original =
            engine::Address::new(engine::Engine::Podman, Some("original-machine".into()));
        let volume = "openbot_postgres-data";
        assert!(reset_leftover_database_with(
            &shell,
            &root,
            volume,
            true,
            || panic!("a missing offer must refuse before reading credentials"),
            |_, _| panic!("a missing offer must not remove anything")
        )
        .is_err());
        *shell.leftover_database.lock().unwrap() = Some(LeftoverDatabase {
            root: root.clone(),
            volume: volume.into(),
            address: original.clone(),
        });
        for (selected_root, selected_volume) in [
            (&root, "other-volume"),
            (&root.join("another-root"), volume),
        ] {
            assert!(reset_leftover_database_with(
                &shell,
                selected_root,
                selected_volume,
                true,
                || panic!("a mismatched offer must refuse before reading credentials"),
                |_, _| panic!("a mismatched offer must not remove anything")
            )
            .is_err());
        }
        // Ambient choices may change while the confirmation is open. Both a new Docker endpoint
        // and a new Podman default remain irrelevant to the already pinned offer.
        std::env::set_var("DOCKER_HOST", "unix:///another-engine.sock");
        std::env::set_var("CONTAINER_CONNECTION", "replacement-machine");
        let unavailable = Problem::plain("the originally offered engine is unavailable");
        assert_eq!(
            reset_leftover_database_with(
                &shell,
                &root,
                volume,
                true,
                || Ok(stack::Secrets::new()),
                |address, _| {
                    assert_eq!(address, &original);
                    Err(unavailable.clone())
                }
            ),
            Err(unavailable)
        );
        reset_leftover_database_with(
            &shell,
            &root,
            volume,
            true,
            || Ok(stack::Secrets::new()),
            |address, _| {
                assert_eq!(address, &original);
                let command = address.command();
                let arguments: Vec<_> = command.get_args().collect();
                assert_eq!(arguments, ["--connection", "original-machine"]);
                Ok(())
            },
        )
        .unwrap();
        assert!(
            shell.leftover_database.lock().unwrap().is_none(),
            "successful reset consumes the offer"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Real engine boundary: all root metadata can disappear while a named volume survives.
    /// Owns one isolated project and empty database; never touches an existing deployment.
    #[test]
    #[ignore = "creates an isolated database volume and starts Postgres on the explicitly selected engine"]
    fn surviving_postgres_volume_blocks_fresh_root_without_key() {
        let root = temp_root("encryption-key-volume-reinstall");
        std::fs::create_dir_all(&root).unwrap();
        let project = format!(
            "openbot-key-reinstall-fixture-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let volume = format!("{project}_postgres-data");
        std::fs::write(
            root.join("docker-compose.yml"),
            format!(
                "name: {project}\nservices:\n  postgres:\n    image: docker.io/pgvector/pgvector:pg17\n    environment:\n      POSTGRES_PASSWORD: isolated-fixture-only\n    volumes:\n      - postgres-data:/var/lib/postgresql/data\n    healthcheck:\n      test: [CMD, pg_isready, -U, postgres]\n      interval: 1s\n      timeout: 5s\n      retries: 45\nvolumes:\n  postgres-data:\n"
            ),
        )
        .unwrap();
        let selected = match std::env::var("OPENBOT_TEST_ENGINE").as_deref() {
            Ok("podman") => engine::Engine::Podman,
            Ok("docker") | Err(_) => engine::Engine::Docker,
            Ok(other) => panic!("unknown explicit test engine: {other}"),
        };
        let address = engine::Address::new(selected, std::env::var("OPENBOT_TEST_CONNECTION").ok())
            .pin()
            .expect("explicit selected test runtime");
        let created = address
            .command()
            .args([
                "volume",
                "create",
                "--label",
                "ai.copilotkit.openbot.fixture=key-reinstall",
                "--label",
                &format!("com.docker.compose.project={project}"),
                "--label",
                "com.docker.compose.volume=postgres-data",
                &volume,
            ])
            .output()
            .expect("create isolated volume");
        assert!(created.status.success(), "fixture volume creation failed");

        // Always clean up this fixture, including when an assertion inside the workflow fails.
        let workflow = std::panic::catch_unwind(|| {
            let secrets = stack::Secrets::new();
            let guarded = require_existing_encryption_key_with_recovery(
                &root,
                &secrets,
                || stack::postgres_volume_exists(&address, &root, &secrets),
                || stack::leftover_database_volume(&address, &root, &secrets),
            )
            .unwrap_err();
            assert_eq!(guarded.database_reset.as_deref(), Some(volume.as_str()));
            let shell = Shell::default();
            *shell.leftover_database.lock().unwrap() = Some(LeftoverDatabase {
                root: root.clone(),
                volume: volume.clone(),
                address: address.clone(),
            });
            assert!(reset_leftover_database_with(
                &shell,
                &root,
                &volume,
                false,
                || Ok(secrets.clone()),
                |address, secrets| stack::reset_leftover_database(address, &root, secrets, &volume)
            )
            .is_err());
            assert!(stack::postgres_volume_exists(&address, &root, &secrets).unwrap());
            assert!(!root.join(".secrets/KEY_ENCRYPTION_KEY.secret").exists());
            assert!(!root.join(".env").exists());
            reset_leftover_database_with(
                &shell,
                &root,
                &volume,
                true,
                || Ok(secrets.clone()),
                |address, secrets| stack::reset_leftover_database(address, &root, secrets, &volume),
            )
            .unwrap();
            require_existing_encryption_key(&root, &secrets, || {
                stack::postgres_volume_exists(&address, &root, &secrets)
            })
            .unwrap();
            let started = address
                .command()
                .current_dir(&root)
                .args([
                    "compose",
                    "up",
                    "--detach",
                    "--wait",
                    "--wait-timeout",
                    "60",
                    "postgres",
                ])
                .output()
                .unwrap();
            assert!(
                started.status.success(),
                "isolated Postgres must start after recovery: {}",
                String::from_utf8_lossy(&started.stderr)
            );
            assert!(
                stack::reset_leftover_database(&address, &root, &secrets, &volume).is_err(),
                "the real engine must refuse an attached database volume"
            );
            let ready = address
                .command()
                .current_dir(&root)
                .args([
                    "compose",
                    "exec",
                    "-T",
                    "postgres",
                    "pg_isready",
                    "-U",
                    "postgres",
                ])
                .output()
                .unwrap();
            assert!(
                ready.status.success(),
                "Postgres must remain ready after the refused attached-volume reset"
            );
        });
        let stopped = address
            .command()
            .current_dir(&root)
            .args(["compose", "down"])
            .output()
            .unwrap();
        let removed = address
            .command()
            .args(["volume", "rm", &volume])
            .output()
            .unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        assert!(
            stopped.status.success(),
            "stop only the isolated fixture project"
        );
        assert!(
            removed.status.success(),
            "remove only the fixture-owned volume"
        );
        if let Err(panic) = workflow {
            std::panic::resume_unwind(panic);
        }
    }

    #[test]
    fn saved_api_key_selection_without_a_saved_key_is_rejected_before_starting_services() {
        for (provider, expected) in [
            (
                "openai",
                "That saved OpenAI API key is no longer available.",
            ),
            (
                "anthropic",
                "That saved Anthropic API key is no longer available.",
            ),
        ] {
            let root = temp_root(&format!("openbot-missing-saved-{provider}"));
            std::fs::create_dir_all(&root).unwrap();
            let mut trace = Vec::new();

            let result = start_stack_credential_with(
                &root,
                ChosenModel {
                    provider: provider.to_string(),
                    login: "api-key".to_string(),
                    api_key: None,
                    base_url: None,
                    container_base_url: None,
                    model: None,
                    token: None,
                    saved: Some(true),
                },
                |_, key| {
                    trace.push(format!("saved-secret:{key}"));
                    Ok(String::new())
                },
            );
            if result.is_ok() {
                trace.push("external-start-boundary".to_string());
            }
            let problem = result.expect_err("missing saved key should stop before compose");

            println!(
                "DTA-004 missing provider={provider} error={} trace={trace:?}",
                problem.said
            );
            assert_eq!(problem.said, expected);
            assert_eq!(trace, [format!("saved-secret:{}", saved_api_key(provider))]);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn saved_api_key_selection_uses_the_saved_key_when_it_still_exists() {
        for (provider, expected_key) in [
            ("openai", "sk-openai-still-saved"),
            ("anthropic", "sk-ant-still-saved"),
        ] {
            let root = temp_root(&format!("openbot-present-saved-{provider}"));
            std::fs::create_dir_all(&root).unwrap();

            let credential = start_stack_credential_with(
                &root,
                ChosenModel {
                    provider: provider.to_string(),
                    login: "api-key".to_string(),
                    api_key: None,
                    base_url: None,
                    container_base_url: None,
                    model: None,
                    token: None,
                    saved: Some(true),
                },
                |_, key| {
                    assert_eq!(key, saved_api_key(provider));
                    Ok(expected_key.to_string())
                },
            )
            .expect("saved key should be accepted");

            match credential {
                openbot_env::ModelCredential::OpenAi { api_key }
                | openbot_env::ModelCredential::Anthropic { api_key } => {
                    assert_eq!(api_key, expected_key);
                    println!(
                        "DTA-004 present provider={provider} saved_key_len={}",
                        api_key.len()
                    );
                }
                other => panic!("unexpected credential: {other:?}"),
            }
            let _ = std::fs::remove_dir_all(root);
        }
    }

    fn saved_api_key(provider: &str) -> &'static str {
        match provider {
            "openai" => "OPENAI_API_KEY",
            "anthropic" => "ANTHROPIC_API_KEY",
            other => panic!("unexpected provider: {other}"),
        }
    }

    fn compatible_choice(base_url: Option<&str>, model: Option<&str>) -> ChosenModel {
        ChosenModel {
            provider: "openai-compatible".into(),
            login: "endpoint".into(),
            api_key: None,
            base_url: base_url.map(String::from),
            container_base_url: None,
            model: model.map(String::from),
            token: None,
            saved: None,
        }
    }

    fn persist_endpoint_fixture(root: &Path, credential: &openbot_env::ModelCredential) {
        let settings = openbot_env::compose(
            &openbot_env::Intelligence {
                api_url: "https://api.example.test".into(),
                gateway_ws_url: "wss://api.example.test".into(),
                api_key: "synthetic-intelligence".into(),
            },
            &openbot_env::Model {
                credential: credential.clone(),
            },
            &engine::EngineStatus {
                engine: None,
                address: None,
                responding: false,
                engine_socket: None,
                detail: "synthetic".into(),
            },
            &openbot_env::Ports::default(),
            &[],
            None,
            &Default::default(),
        );
        let (public, secrets) = openbot_desktop_lib::vault::split(settings);
        openbot_desktop_lib::saved_intent::persist_configuration(
            root, &public, &secrets, &secrets, credential,
        )
        .unwrap();
    }

    #[test]
    fn saved_compatible_endpoint_roundtrips_public_settings_and_scoped_key() {
        let root = temp_root("compatible-roundtrip");
        std::fs::create_dir_all(&root).unwrap();
        let mut chosen = compatible_choice(Some("https://models.example/v1"), Some("local-model"));
        chosen.api_key = Some("synthetic-endpoint-key".into());
        let credential = chosen.into_credential(&root).unwrap();
        persist_endpoint_fixture(&root, &credential);
        let configured = already_configured_for_root(root.to_string_lossy().into_owned());
        assert_eq!(
            configured.values.get("BOT_MODEL").map(String::as_str),
            Some("local-model")
        );
        assert_eq!(configured.saved.model_api_keys.compatible, Some(true));
        assert_eq!(configured.saved.model_api_keys.openai, None);
        assert!(!serde_json::to_string(&configured)
            .unwrap()
            .contains("synthetic-endpoint-key"));
        let mut reopened = compatible_choice(
            configured.values.get("OPENAI_BASE_URL").map(String::as_str),
            configured.values.get("BOT_MODEL").map(String::as_str),
        );
        reopened.saved = Some(true);
        assert_eq!(reopened.into_credential(&root).unwrap(), credential);

        for url in [
            "https://other.example/v1",
            "https://models.example/v2",
            "https://models.example:8443/v1",
        ] {
            let mut changed = compatible_choice(Some(url), Some("local-model"));
            changed.saved = Some(true);
            assert!(changed
                .into_credential_with(&root, |_, _| panic!(
                    "different endpoint must not read a credential"
                ))
                .is_err());
        }
        let other = root.join("other-root");
        let mut changed_root =
            compatible_choice(Some("https://models.example/v1"), Some("local-model"));
        changed_root.saved = Some(true);
        assert!(changed_root
            .into_credential_with(&other, |_, _| panic!(
                "different root must not read a credential"
            ))
            .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_endpoint_hint_cannot_relabel_another_endpoints_stored_key() {
        let root = temp_root("compatible-stale-record");
        std::fs::create_dir_all(&root).unwrap();
        let credential = openbot_env::ModelCredential::Compatible {
            base_url: "https://models.example/v1".into(),
            container_base_url: None,
            api_key: "synthetic-old-key".into(),
            model: "model".into(),
        };
        persist_endpoint_fixture(&root, &credential);
        let mut choice = compatible_choice(Some("https://models.example/v1"), Some("model"));
        choice.saved = Some(true);
        let mut reads = 0;
        let error = choice
            .into_credential_with(&root, |_, key| {
                reads += 1;
                assert_eq!(
                    key,
                    openbot_desktop_lib::saved_intent::COMPATIBLE_CREDENTIAL
                );
                Ok(
                    r#"{"base_url":"https://other.example/v1","api_key":"synthetic-other-key"}"#
                        .into(),
                )
            })
            .unwrap_err();
        assert_eq!(reads, 1);
        assert!(!error.said.contains("synthetic-other-key"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compatible_endpoint_accepts_trimmed_container_url_and_rejects_invalid_one() {
        let mut choice =
            compatible_choice(Some(" http://127.0.0.1:11434/v1 "), Some(" qwen3-vl:2b "));
        choice.container_base_url = Some(" http://ollama:11434/v1 ".into());
        let credential =
            start_stack_credential(Path::new("synthetic-unused-compatible-root"), choice)
                .expect("a valid container endpoint may be stored with the compatible credential");
        let openbot_env::ModelCredential::Compatible {
            base_url,
            container_base_url,
            model,
            ..
        } = credential
        else {
            panic!("the endpoint must retain its compatible credential");
        };
        assert_eq!(base_url, "http://127.0.0.1:11434/v1");
        assert_eq!(
            container_base_url.as_deref(),
            Some("http://ollama:11434/v1")
        );
        assert_eq!(model, "qwen3-vl:2b");

        let mut invalid = compatible_choice(Some("http://127.0.0.1:11434/v1"), Some("qwen3-vl:2b"));
        invalid.container_base_url = Some("ollama:11434/v1".into());
        let problem =
            start_stack_credential(Path::new("synthetic-unused-compatible-root"), invalid)
                .expect_err("a container endpoint URL must be an absolute HTTP(S) URL");
        assert_eq!(
            problem.said,
            "Enter a valid http:// or https:// address for the container model endpoint."
        );
    }

    #[test]
    fn compatible_endpoint_rejects_missing_or_invalid_http_url() {
        for base_url in [
            None,
            Some(""),
            Some(" \t\n "),
            Some("ftp://localhost/v1"),
            Some("file:///tmp/model"),
            Some("httpx://localhost/v1"),
            Some("localhost:11434/v1"),
            Some("http://"),
            Some("https://?query"),
            Some("http://[invalid]/v1"),
        ] {
            let problem = start_stack_credential(
                Path::new("synthetic-unused-compatible-root"),
                compatible_choice(base_url, Some("local-model")),
            )
            .expect_err("a missing or invalid endpoint URL must stop setup");
            assert_eq!(
                problem.said, "Enter a valid http:// or https:// address for your model endpoint.",
                "base_url={base_url:?}"
            );
        }
    }

    #[test]
    fn compatible_endpoint_rejects_missing_or_blank_model() {
        for model in [None, Some(""), Some(" \t\n ")] {
            let problem = start_stack_credential(
                Path::new("synthetic-unused-compatible-root"),
                compatible_choice(Some("http://127.0.0.1:11434/v1"), model),
            )
            .expect_err("a missing model name must stop setup");
            assert_eq!(problem.said, "Enter the model name your endpoint serves.");
        }
    }

    #[test]
    fn compatible_endpoint_accepts_trimmed_http_urls_and_optional_keys() {
        for base_url in [
            "http://127.0.0.1:11434/v1",
            "https://models.example.invalid/v1",
        ] {
            for api_key in [None, Some(" \t "), Some(" synthetic-endpoint-key ")] {
                let mut choice =
                    compatible_choice(Some(&format!(" {base_url} ")), Some(" local-model "));
                choice.api_key = api_key.map(String::from);
                let credential =
                    start_stack_credential(Path::new("synthetic-unused-compatible-root"), choice)
                        .expect("a valid endpoint may run without an API key");
                let openbot_env::ModelCredential::Compatible {
                    base_url: actual_url,
                    api_key: actual_key,
                    model,
                    ..
                } = credential
                else {
                    panic!("the endpoint must retain its compatible credential");
                };
                assert_eq!(actual_url, base_url);
                assert_eq!(model, "local-model");
                assert_eq!(actual_key, api_key.unwrap_or_default().trim());
            }
        }
    }

    #[test]
    fn linux_first_install_redetects_native_podman_without_a_virtual_machine() {
        let missing = engine::EngineStatus {
            engine: None,
            address: None,
            responding: false,
            engine_socket: None,
            detail: "No container engine yet.".into(),
        };
        let trace = std::cell::RefCell::new(Vec::new());
        let ready = ready_responding_engine_after_compose_repair(
            missing,
            true,
            || {
                trace.borrow_mut().push("install");
                Ok("Podman and Compose installed".into())
            },
            || {
                trace.borrow_mut().push("detect");
                engine::EngineStatus {
                    engine: Some(engine::Engine::Podman),
                    address: Some(engine::Address::new(engine::Engine::Podman, None)),
                    responding: true,
                    engine_socket: None,
                    detail: "native Podman answers".into(),
                }
            },
            |_| {
                trace.borrow_mut().push("compose");
                true
            },
        )
        .unwrap()
        .expect("Linux must return its newly installed native engine, not request a VM");
        assert_eq!(ready.address.engine, engine::Engine::Podman);
        assert!(ready.address.connection.is_none());
        assert_eq!(*trace.borrow(), ["install", "detect", "compose"]);
    }

    #[test]
    fn linux_failed_native_engine_is_an_error_instead_of_a_request_for_qemu() {
        let stopped = engine::EngineStatus {
            engine: Some(engine::Engine::Podman),
            address: None,
            responding: false,
            engine_socket: None,
            detail: "podman native operation failed".into(),
        };
        let result = ready_responding_engine_after_compose_repair(
            stopped.clone(),
            true,
            || Ok("installed".into()),
            || stopped.clone(),
            |_| panic!("a failed engine cannot run Compose"),
        );
        assert!(
            result.is_err(),
            "Ok(None) would enter the virtual-machine path"
        );
        assert_eq!(
            result.err().unwrap().detail.as_deref(),
            Some("podman native operation failed")
        );
    }

    #[test]
    fn responding_engine_without_compose_installs_then_redetects_before_returning() {
        let before = engine::EngineStatus {
            engine: Some(engine::Engine::Podman),
            address: Some(engine::Address::new(engine::Engine::Podman, None)),
            responding: true,
            engine_socket: None,
            detail: "podman is answering.".into(),
        };
        let after = engine::EngineStatus {
            engine: Some(engine::Engine::Podman),
            address: Some(engine::Address::new(
                engine::Engine::Podman,
                Some("openbot".into()),
            )),
            responding: true,
            engine_socket: None,
            detail: "podman is answering on openbot.".into(),
        };
        let trace = std::cell::RefCell::new(Vec::new());
        let mut compose_checks = 0;

        let ready = ready_responding_engine_after_compose_repair(
            before,
            false,
            || {
                trace.borrow_mut().push("install-engine".to_string());
                Ok("Compose installed.".into())
            },
            || {
                trace.borrow_mut().push("re-detect".to_string());
                after.clone()
            },
            |_| {
                compose_checks += 1;
                compose_checks > 1
            },
        )
        .expect("missing Compose should be repaired")
        .expect("responding engine should be returned");

        assert_eq!(&*trace.borrow(), &["install-engine", "re-detect"]);
        assert_eq!(ready.installed.as_deref(), Some("Compose installed."));
        assert_eq!(ready.address.connection.as_deref(), Some("openbot"));
    }

    #[test]
    fn disposable_provider_fixture_repairs_missing_compose_at_process_boundary() {
        if crate::test_support::isolated_process(
            "tests::disposable_provider_fixture_repairs_missing_compose_at_process_boundary",
        ) {
            return;
        }
        let path = SerializedPath::set_only_with("podman", "podman");
        let address = engine::Address::new(engine::Engine::Podman, None);
        assert!(address.responds(), "fake podman must answer before repair");
        assert!(
            !address.composes(),
            "fake podman must start without a compose provider"
        );
        let mut installed = false;
        let mut detections = 0;

        let ready = ready_responding_engine_after_compose_repair(
            engine::EngineStatus {
                engine: Some(engine::Engine::Podman),
                address: Some(address.clone()),
                responding: address.responds(),
                engine_socket: None,
                detail: "podman is answering.".into(),
            },
            false,
            || {
                path.write_binary(install::compose_provider_name(), "compose-provider");
                installed = true;
                Ok("Compose installed into disposable PATH.".into())
            },
            || {
                detections += 1;
                engine::EngineStatus {
                    engine: Some(engine::Engine::Podman),
                    address: Some(address.clone()),
                    responding: address.responds(),
                    engine_socket: None,
                    detail: "podman is answering after disposable provider install.".into(),
                }
            },
            engine::Address::composes,
        )
        .expect("disposable provider should repair Compose")
        .expect("responding fake podman should be ready");

        assert!(installed, "install path must run before readiness returns");
        assert_eq!(detections, 1, "readiness must re-detect after install");
        assert_eq!(ready.address.engine, engine::Engine::Podman);
        assert!(
            ready.address.composes(),
            "the later start_stack compose gate should now pass"
        );
        println!(
            "DTA-007 functional proof: installed={installed} detections={detections} composes={}",
            ready.address.composes()
        );
    }

    #[test]
    fn stop_shutdown_uses_the_active_root_at_the_external_command_boundary() {
        if crate::test_support::isolated_process(
            "tests::stop_shutdown_uses_the_active_root_at_the_external_command_boundary",
        ) {
            return;
        }
        let _path = SerializedPath::set();
        let active = temp_root("openbot-active-stop-root");
        let fallback = temp_root("openbot-default-stop-root");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::write(active.join("docker-compose.yml"), "services: {}\n").unwrap();
        std::fs::create_dir_all(&fallback).unwrap();
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(active.clone());
        let selected = shutdown_root(&shell, &fallback);

        let record = temp_root("openbot-stop-record").join("commands.log");
        let engine = fake_engine(&record);
        stack::down(&engine, &selected).expect("fake compose down");

        assert_compose_down_ran_under(&record, &active);
        assert!(shell.root.lock().unwrap().is_none());
        let _ = std::fs::remove_dir_all(active);
        let _ = std::fs::remove_dir_all(fallback);
    }

    #[test]
    fn quit_shutdown_uses_the_active_root_at_the_external_command_boundary() {
        if crate::test_support::isolated_process(
            "tests::quit_shutdown_uses_the_active_root_at_the_external_command_boundary",
        ) {
            return;
        }
        let _path = SerializedPath::set();
        let active = temp_root("openbot-active-quit-root");
        let fallback = temp_root("openbot-default-quit-root");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::write(active.join("docker-compose.yml"), "services: {}\n").unwrap();
        std::fs::create_dir_all(&fallback).unwrap();
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(active.clone());
        let selected = shutdown_root(&shell, &fallback);

        let record = temp_root("openbot-quit-record").join("commands.log");
        let engine = fake_engine(&record);
        stack::down(&engine, &selected).expect("fake compose down");

        assert_compose_down_ran_under(&record, &active);
        assert!(shell.root.lock().unwrap().is_none());
        let _ = std::fs::remove_dir_all(active);
        let _ = std::fs::remove_dir_all(fallback);
    }

    #[test]
    fn stop_reports_cleanup_and_down_failures_after_using_the_active_root() {
        let active = temp_root("openbot-active-stop-failures");
        let fallback = temp_root("openbot-default-stop-failures");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::write(active.join("docker-compose.yml"), "services: {}\n").unwrap();
        std::fs::create_dir_all(&fallback).unwrap();
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(active.clone());
        let phases = std::cell::RefCell::new(Vec::new());

        let problem = stop_everything_with(
            &shell,
            &fallback,
            |root| {
                phases
                    .borrow_mut()
                    .push(format!("cleanup:{}", root.display()));
                Err(Problem::with(
                    "OpenBot could not inspect or stop its host processes.",
                    "lsof exited with status 2",
                ))
            },
            |root| {
                phases.borrow_mut().push(format!("down:{}", root.display()));
                Err("compose refused".to_string())
            },
        )
        .expect_err("Stop must surface both cleanup and Compose failures");

        assert_eq!(
            phases.into_inner(),
            vec![
                format!("cleanup:{}", active.display()),
                format!("down:{}", active.display())
            ]
        );
        assert!(
            problem.contains("OpenBot could not inspect or stop its host processes."),
            "{problem}"
        );
        assert!(problem.contains("lsof exited with status 2"), "{problem}");
        assert!(
            problem.contains("Compose down failed: compose refused"),
            "{problem}"
        );
        assert_eq!(shell.root.lock().unwrap().as_ref(), Some(&active));
        let _ = std::fs::remove_dir_all(active);
        let _ = std::fs::remove_dir_all(fallback);
    }

    #[test]
    fn exit_cleanup_body_records_cleanup_and_down_failures_after_using_the_active_root() {
        let active = temp_root("openbot-active-exit-failures");
        let fallback = temp_root("openbot-default-exit-failures");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::write(active.join("docker-compose.yml"), "services: {}\n").unwrap();
        std::fs::create_dir_all(&fallback).unwrap();
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(active.clone());
        let phases = std::cell::RefCell::new(Vec::new());

        let failures = exit_cleanup_with(
            &shell,
            &fallback,
            |root| {
                phases
                    .borrow_mut()
                    .push(format!("cleanup:{}", root.display()));
                Err(Problem::with(
                    "OpenBot could not inspect or stop its host processes.",
                    "taskkill exited with status 5",
                ))
            },
            |root| {
                phases.borrow_mut().push(format!("down:{}", root.display()));
                Err("compose down refused".to_string())
            },
        );

        assert_eq!(
            phases.into_inner(),
            vec![
                format!("cleanup:{}", active.display()),
                format!("down:{}", active.display())
            ]
        );
        assert_eq!(failures.len(), 2, "{failures:?}");
        assert!(
            failures[0].contains("taskkill exited with status 5"),
            "{failures:?}"
        );
        assert!(
            failures[1].contains("Compose down failed: compose down refused"),
            "{failures:?}"
        );
        assert_eq!(shell.root.lock().unwrap().as_ref(), Some(&active));
        let _ = std::fs::remove_dir_all(active);
        let _ = std::fs::remove_dir_all(fallback);
    }

    const LOCAL_EVAL_PIN: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    fn local_eval_root(label: &str, ownership: Option<local_eval_state::Ownership>) -> PathBuf {
        let root = temp_root(label);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("docker-compose.yml"), "services: {}\n").unwrap();
        if let Some(ownership) = ownership {
            let stack = local_eval::StackId::parse("local-abc123").unwrap();
            local_eval_state::begin(&root, &stack, ownership, LOCAL_EVAL_PIN).unwrap();
        }
        root
    }

    fn local_eval_report(
        outcome: local_eval::Outcome,
        reason: Option<local_eval::Reason>,
    ) -> local_eval::Report {
        local_eval::Report {
            outcome,
            stack: None,
            reason,
            readiness: local_eval::Readiness::Unknown,
            licence: local_eval::Licence::Unknown,
            licence_expires_at: None,
        }
    }

    fn signed_in(
        outcome: local_eval::Outcome,
        reason: Option<local_eval::Reason>,
    ) -> Result<local_eval::SignIn, local_eval::Failure> {
        Ok(local_eval::SignIn { outcome, reason })
    }

    #[test]
    fn opening_intelligence_needs_a_recorded_stack_and_never_asks_the_cli_without_one() {
        let root = local_eval_root("openbot-open-intelligence-unrecorded", None);
        let problem =
            open_local_intelligence_at(&root, |_| panic!("login ran without a stack")).unwrap_err();
        assert_eq!(
            problem,
            Problem::plain("Set up local Intelligence before opening its dashboard.")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn opening_intelligence_signs_in_the_recorded_stack() {
        let root = local_eval_root(
            "openbot-open-intelligence-recorded",
            Some(local_eval_state::Ownership::Shared),
        );
        let mut asked = None;
        open_local_intelligence_at(&root, |stack| {
            asked = Some(stack.as_str().to_owned());
            signed_in(local_eval::Outcome::Completed, None)
        })
        .unwrap();
        assert_eq!(asked.as_deref(), Some("local-abc123"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn opening_intelligence_fails_with_fixed_sentences_only() {
        use local_eval::{Failure, Outcome, Reason};
        let root = local_eval_root(
            "openbot-open-intelligence-failures",
            Some(local_eval_state::Ownership::Created),
        );
        let retry = "OpenBot could not open the Intelligence dashboard. Try again.";
        for (result, said) in [
            (
                signed_in(Outcome::Blocked, Some(Reason::DashboardUnavailable)),
                "The Intelligence dashboard is not responding yet. Try again when Intelligence is ready.",
            ),
            (
                signed_in(Outcome::Blocked, Some(Reason::BrowserOpenFailed)),
                "Your browser did not open. Try again.",
            ),
            (
                signed_in(Outcome::Blocked, Some(Reason::LocalCommandBusy)),
                "Another Intelligence command is still running. Try again when it finishes.",
            ),
            (
                signed_in(Outcome::Blocked, Some(Reason::DockerUnavailable)),
                "The software Intelligence runs on is not running.",
            ),
            (signed_in(Outcome::Blocked, Some(Reason::Unrecognized)), retry),
            (signed_in(Outcome::Blocked, None), retry),
            (signed_in(Outcome::Failed, Some(Reason::LocalCommandFailed)), retry),
            (
                Err(Failure::Unavailable),
                "This version of OpenBot cannot open the Intelligence dashboard.",
            ),
            (
                Err(Failure::Timeout),
                "The Intelligence dashboard took too long to open. Try again.",
            ),
            (
                Err(Failure::Cancelled),
                "Opening the Intelligence dashboard was stopped.",
            ),
            (Err(Failure::InvalidJson), retry),
            (Err(Failure::Unverified), retry),
        ] {
            let problem = open_local_intelligence_at(&root, |_| result).unwrap_err();
            // Nothing but the sentence: no detail, so no CLI text can ride along.
            assert_eq!(problem, Problem::plain(said));
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_intelligence_menu_item_is_offered_only_for_a_recorded_local_stack() {
        let recorded = local_eval_root(
            "openbot-intelligence-menu-recorded",
            Some(local_eval_state::Ownership::Created),
        );
        let unrecorded = local_eval_root("openbot-intelligence-menu-unrecorded", None);
        assert_eq!(
            intelligence_menu_root(&recorded, true),
            Some(recorded.clone())
        );
        // Hosted mode, or local mode with nothing recorded: no item.
        assert_eq!(intelligence_menu_root(&recorded, false), None);
        assert_eq!(intelligence_menu_root(&unrecorded, true), None);
        let _ = std::fs::remove_dir_all(recorded);
        let _ = std::fs::remove_dir_all(unrecorded);
    }

    #[test]
    fn the_intelligence_menu_item_says_it_is_opening_and_cannot_be_chosen_twice() {
        assert_eq!(
            intelligence_menu_item(false),
            ("Open Intelligence dashboard", true)
        );
        assert_eq!(
            intelligence_menu_item(true),
            ("Opening Intelligence dashboard…", false)
        );
    }

    #[test]
    fn opening_the_dashboard_from_the_menu_says_so_before_the_cli_runs_then_how_it_went() {
        use std::sync::{Arc, Mutex};
        for (result, last) in [
            (Ok(()), IntelligenceOpening::Opened),
            (
                Err(DashboardFailure::BrowserFailed),
                IntelligenceOpening::Failed(DashboardFailure::BrowserFailed),
            ),
        ] {
            let opening = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let said = Arc::new(Mutex::new(Vec::new()));
            let work = std::cell::RefCell::new(None);
            let ran = Arc::new(Mutex::new(false));
            let status = {
                let said = Arc::clone(&said);
                move |status: IntelligenceOpening| said.lock().unwrap().push(status)
            };
            let open = {
                let ran = Arc::clone(&ran);
                move || {
                    *ran.lock().unwrap() = true;
                    result
                }
            };
            open_intelligence_reporting(Arc::clone(&opening), status.clone(), open, |job| {
                *work.borrow_mut() = Some(job);
                Ok(())
            });
            // Said on the click itself, before the CLI call has even started.
            assert_eq!(*said.lock().unwrap(), [IntelligenceOpening::Opening]);
            assert!(!*ran.lock().unwrap());
            assert!(opening.load(std::sync::atomic::Ordering::SeqCst));
            // A second click while it runs starts nothing and says nothing new.
            open_intelligence_reporting(
                Arc::clone(&opening),
                status.clone(),
                || panic!("a second opening ran while the first was running"),
                |_| panic!("a second opening was scheduled"),
            );
            assert_eq!(said.lock().unwrap().len(), 1);

            (work.borrow_mut().take().unwrap())();
            assert_eq!(
                *said.lock().unwrap(),
                [IntelligenceOpening::Opening, last.clone()]
            );
            assert!(!opening.load(std::sync::atomic::Ordering::SeqCst));
        }
        assert_eq!(
            serde_json::to_value(IntelligenceOpening::Opening).unwrap(),
            serde_json::json!({"state": "opening", "said": "Opening the Intelligence dashboard…"})
        );
        assert_eq!(
            serde_json::to_value(IntelligenceOpening::Opened).unwrap(),
            serde_json::json!({"state": "opened", "said": "Opened in your browser."})
        );
        assert_eq!(
            serde_json::to_value(IntelligenceOpening::Failed(DashboardFailure::BrowserFailed))
                .unwrap(),
            serde_json::json!({"state": "failed", "said": "Your browser did not open. Try again."})
        );
    }

    #[test]
    fn a_dashboard_opening_that_could_not_be_scheduled_is_not_left_disabled() {
        use std::sync::{Arc, Mutex};
        let opening = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let said = Arc::new(Mutex::new(Vec::new()));
        let status = {
            let said = Arc::clone(&said);
            move |status: IntelligenceOpening| said.lock().unwrap().push(status)
        };
        open_intelligence_reporting(
            Arc::clone(&opening),
            status,
            || Ok(()),
            |_| Err(std::io::Error::other("no threads left")),
        );
        assert_eq!(
            *said.lock().unwrap(),
            [
                IntelligenceOpening::Opening,
                IntelligenceOpening::Failed(DashboardFailure::Failed)
            ]
        );
        assert!(!opening.load(std::sync::atomic::Ordering::SeqCst));
    }

    fn reported_stack(id: &str, dashboard: &str) -> local_eval::Stack {
        local_eval::Stack {
            id: id.into(),
            installed_release: "0.13.14".into(),
            step: "ready".into(),
            urls: local_eval::Urls {
                api: "http://127.0.0.1:4201".into(),
                dashboard: dashboard.into(),
                gateway: "ws://127.0.0.1:4401".into(),
            },
            has_failed_step: false,
            update_in_progress: false,
            observed: None,
        }
    }

    #[test]
    fn the_dashboard_signs_in_once_per_session_then_opens_its_address_with_no_cli_call() {
        use local_eval::{Outcome, Reason};
        use std::cell::RefCell;
        let dashboards = Dashboards::default();
        let stack = local_eval::StackId::parse("local-abc123").unwrap();
        let opened = RefCell::new(Vec::new());
        let open = |address: &str| {
            opened.borrow_mut().push(address.to_owned());
            Ok(())
        };
        dashboards.learn(&reported_stack(
            "local-abc123",
            "http://intelligence.localhost:8080",
        ));

        // A sign-in that did not complete is not remembered.
        let signed = open_or_sign_in(
            &dashboards,
            &stack,
            |_| signed_in(Outcome::Blocked, Some(Reason::DashboardUnavailable)),
            open,
        )
        .unwrap();
        assert_eq!(signed.outcome, Outcome::Blocked);
        // The first completed opening in this session goes through `local login`.
        let logins = RefCell::new(0);
        let login = |_: &local_eval::StackId| {
            *logins.borrow_mut() += 1;
            signed_in(Outcome::Completed, None)
        };
        open_or_sign_in(&dashboards, &stack, login, open).unwrap();
        assert_eq!(*logins.borrow(), 1);
        assert!(
            opened.borrow().is_empty(),
            "local login opens the browser itself"
        );
        // After that: the address, at once, and the CLI is never asked.
        for _ in 0..2 {
            let signed = open_or_sign_in(
                &dashboards,
                &stack,
                |_| panic!("the CLI was asked again"),
                open,
            )
            .unwrap();
            assert_eq!(signed.outcome, Outcome::Completed);
        }
        assert_eq!(
            *opened.borrow(),
            [
                "http://intelligence.localhost:8080",
                "http://intelligence.localhost:8080"
            ]
        );
        // A browser that would not open is the CLI's own category for it.
        let failed =
            open_or_sign_in(&dashboards, &stack, |_| panic!("no CLI"), |_| Err(())).unwrap();
        assert_eq!(
            (failed.outcome, failed.reason),
            (Outcome::Failed, Some(Reason::BrowserOpenFailed))
        );
        // A new address is a new origin with no session: signed in again.
        dashboards.learn(&reported_stack(
            "local-abc123",
            "http://intelligence.localhost:8081",
        ));
        open_or_sign_in(&dashboards, &stack, login, open).unwrap();
        assert_eq!(*logins.borrow(), 2);
        open_or_sign_in(&dashboards, &stack, |_| panic!("no CLI"), open).unwrap();
        assert_eq!(
            opened.borrow().last().map(String::as_str),
            Some("http://intelligence.localhost:8081")
        );
    }

    #[test]
    fn a_signed_in_stack_with_no_reported_address_signs_in_again() {
        let dashboards = Dashboards::default();
        let stack = local_eval::StackId::parse("local-abc123").unwrap();
        let logins = std::cell::Cell::new(0);
        for _ in 0..2 {
            open_or_sign_in(
                &dashboards,
                &stack,
                |_| {
                    logins.set(logins.get() + 1);
                    signed_in(local_eval::Outcome::Completed, None)
                },
                |_| panic!("no address was ever reported"),
            )
            .unwrap();
        }
        assert_eq!(logins.get(), 2);
        // Learning the address keeps the sign-in: the browser holds the session for it.
        dashboards.learn(&reported_stack(
            "local-abc123",
            "http://intelligence.localhost:8080",
        ));
        assert_eq!(
            dashboards.signed_in(&stack).as_deref(),
            Some("http://intelligence.localhost:8080")
        );
        // Another stack's sign-in is its own.
        let other = local_eval::StackId::parse("local-def456").unwrap();
        assert_eq!(dashboards.signed_in(&other), None);
    }

    #[test]
    fn dashboard_failures_reach_the_app_page_as_categories_only() {
        for (failure, category) in [
            (DashboardFailure::NotSetUp, "not_set_up"),
            (DashboardFailure::NotResponding, "not_responding"),
            (DashboardFailure::BrowserFailed, "browser_failed"),
            (DashboardFailure::Busy, "busy"),
            (DashboardFailure::EngineStopped, "engine_stopped"),
            (DashboardFailure::Unsupported, "unsupported"),
            (DashboardFailure::TimedOut, "timed_out"),
            (DashboardFailure::Stopped, "stopped"),
            (DashboardFailure::Failed, "failed"),
        ] {
            assert_eq!(
                serde_json::to_value(intelligence_bridge::Offer::Failed(failure)).unwrap(),
                serde_json::json!({"state": "failed", "reason": category})
            );
        }
        for (offer, state) in [
            (intelligence_bridge::Offer::Unavailable, "unavailable"),
            (intelligence_bridge::Offer::Ready, "ready"),
            (intelligence_bridge::Offer::Opening, "opening"),
        ] {
            assert_eq!(
                serde_json::to_value(offer).unwrap(),
                serde_json::json!({ "state": state })
            );
        }
        assert_eq!(
            intelligence_bridge::Offer::after(&IntelligenceOpening::Opening),
            intelligence_bridge::Offer::Opening
        );
        assert_eq!(
            intelligence_bridge::Offer::after(&IntelligenceOpening::Opened),
            intelligence_bridge::Offer::Ready
        );
        assert_eq!(
            intelligence_bridge::Offer::after(&IntelligenceOpening::Failed(DashboardFailure::Busy)),
            intelligence_bridge::Offer::Failed(DashboardFailure::Busy)
        );
    }

    #[test]
    fn the_setup_window_only_grows_and_never_past_its_screen() {
        // Content taller than the window: grown to fit.
        assert_eq!(grown_height(640.0, 812.4, 900.0), Some(813.0));
        // Taller than the screen allows: grown to the most it may have, and the page scrolls.
        assert_eq!(grown_height(640.0, 1400.0, 900.5), Some(900.0));
        // Content that fits, or a window already as tall as it can be: left alone, never shrunk.
        assert_eq!(grown_height(800.0, 620.0, 900.0), None);
        assert_eq!(grown_height(900.0, 1400.0, 900.0), None);
        assert_eq!(grown_height(799.6, 800.0, 900.0), None);
    }

    #[test]
    fn about_openbot_names_the_commit_branch_and_build_time() {
        assert_eq!(utc_minute(0), "1970-01-01 00:00 UTC");
        assert_eq!(utc_minute(951_782_400), "2000-02-29 00:00 UTC");
        assert_eq!(utc_minute(1_792_647_660), "2026-10-22 05:41 UTC");
        assert_eq!(
            build_description("397d98a-dirty", "dustywusty/x", 1_792_647_660),
            "Built 2026-10-22 05:41 UTC from 397d98a-dirty on dustywusty/x"
        );
        assert_eq!(
            build_description("397d98a", "", 0),
            "Built 1970-01-01 00:00 UTC from 397d98a"
        );
        let about = about_openbot();
        assert_eq!(
            about.short_version.as_deref(),
            Some(env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(about.version.as_deref(), Some(env!("OPENBOT_BUILD_COMMIT")));
        assert!(about.credits.unwrap().starts_with("Built "));
    }

    #[test]
    fn nothing_is_ever_written_in_the_menu_bar() {
        // The status title widened the tray item behind the camera notch, and on macOS
        // clearing the title never took it away. The tray keeps its icon, tooltip and menu only.
        let source = include_str!("main.rs");
        let call = ["set_", "title("].concat();
        assert!(!source.contains(&call), "the tray title is set again");
    }

    #[test]
    fn stop_asks_intelligence_last_even_after_compose_down_failed() {
        let active = local_eval_root("openbot-stop-intelligence-order", None);
        let fallback = temp_root("openbot-default-stop-intelligence-order");
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(active.clone());
        let phases = std::cell::RefCell::new(Vec::new());

        let stopped = stop_everything_then(
            &shell,
            &fallback,
            |root| {
                phases
                    .borrow_mut()
                    .push(format!("cleanup:{}", root.display()));
                Ok(0)
            },
            |root| {
                phases.borrow_mut().push(format!("down:{}", root.display()));
                Err("compose refused".to_string())
            },
            |root| {
                phases
                    .borrow_mut()
                    .push(format!("intelligence:{}", root.display()));
                Err("the CLI timed out".to_string())
            },
        );

        assert_eq!(
            phases.into_inner(),
            vec![
                format!("cleanup:{}", active.display()),
                format!("down:{}", active.display()),
                format!("intelligence:{}", active.display()),
            ]
        );
        assert_eq!(
            stopped,
            Stopped {
                openbot: vec!["Compose down failed: compose refused".into()],
                intelligence: Some("Intelligence stop failed: the CLI timed out".into()),
            }
        );
        assert_eq!(
            stopped.into_result(),
            Err("Compose down failed: compose refused\n\
                 Intelligence stop failed: the CLI timed out"
                .into())
        );
        let _ = std::fs::remove_dir_all(active);
        let _ = std::fs::remove_dir_all(fallback);
    }

    #[test]
    fn quit_asks_intelligence_last_even_after_compose_down_failed() {
        let active = local_eval_root("openbot-exit-intelligence-order", None);
        let fallback = temp_root("openbot-default-exit-intelligence-order");
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(active.clone());
        let phases = std::cell::RefCell::new(Vec::new());

        let failures = exit_cleanup_then(
            &shell,
            &fallback,
            |root| {
                phases
                    .borrow_mut()
                    .push(format!("cleanup:{}", root.display()));
                Ok(0)
            },
            |root| {
                phases.borrow_mut().push(format!("down:{}", root.display()));
                Err("compose down refused".to_string())
            },
            |root| {
                phases
                    .borrow_mut()
                    .push(format!("intelligence:{}", root.display()));
                Err("the CLI timed out".to_string())
            },
        );

        assert_eq!(
            phases.into_inner(),
            vec![
                format!("cleanup:{}", active.display()),
                format!("down:{}", active.display()),
                format!("intelligence:{}", active.display()),
            ]
        );
        assert_eq!(
            failures,
            Stopped {
                openbot: vec!["Compose down failed: compose down refused".into()],
                intelligence: Some("Intelligence stop failed: the CLI timed out".into()),
            }
        );
        let _ = std::fs::remove_dir_all(active);
        let _ = std::fs::remove_dir_all(fallback);
    }

    #[test]
    fn quit_shows_stopping_openbot_then_intelligence_only_for_a_stack_openbot_created() {
        for ownership in [
            Some(local_eval_state::Ownership::Created),
            Some(local_eval_state::Ownership::Shared),
            None,
        ] {
            let root = local_eval_root("openbot-quit-progress-order", ownership);
            let shell = Shell::default();
            *shell.root.lock().unwrap() = Some(root.clone());
            let phases = std::cell::RefCell::new(Vec::new());

            let stopped = exit_cleanup_reporting(
                &shell,
                &root,
                |_| {
                    phases.borrow_mut().push("cleanup".to_string());
                    Ok(0)
                },
                |_| {
                    phases.borrow_mut().push("down".to_string());
                    Ok(())
                },
                |_| {
                    phases.borrow_mut().push("intelligence".to_string());
                    Ok(())
                },
                |step, state| {
                    phases.borrow_mut().push(format!("{}:{state:?}", step.id()));
                },
            );

            assert_eq!(stopped, Stopped::default(), "{ownership:?}");
            let mut expected = vec![
                "stop-openbot:Running",
                "cleanup",
                "down",
                "stop-openbot:Complete",
            ];
            if ownership == Some(local_eval_state::Ownership::Created) {
                expected.extend([
                    "stop-intelligence:Running",
                    "intelligence",
                    "stop-intelligence:Complete",
                ]);
            } else {
                // Still asked, so calls in flight are cancelled; there is no stack to show.
                expected.push("intelligence");
            }
            assert_eq!(phases.into_inner(), expected, "{ownership:?}");
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn quit_marks_failed_rows_and_still_records_each_failure_in_the_notice() {
        let root = local_eval_root(
            "openbot-quit-progress-failures",
            Some(local_eval_state::Ownership::Created),
        );
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(root.clone());
        let phases = std::cell::RefCell::new(Vec::new());

        let stopped = exit_cleanup_reporting(
            &shell,
            &root,
            |_| Ok(0),
            |_| Err("compose down refused".to_string()),
            |_| Err("the CLI timed out".to_string()),
            |step, state| {
                phases.borrow_mut().push(format!("{}:{state:?}", step.id()));
            },
        );

        assert_eq!(
            phases.into_inner(),
            [
                "stop-openbot:Running",
                "stop-openbot:Failed",
                "stop-intelligence:Running",
                "stop-intelligence:Failed",
            ]
        );
        // Unchanged by the screen: the two failures are kept apart.
        assert_eq!(
            stopped,
            Stopped {
                openbot: vec!["Compose down failed: compose down refused".into()],
                intelligence: Some("Intelligence stop failed: the CLI timed out".into()),
            }
        );
        report_exit_cleanup_failures(stopped.lines(), |lines| {
            write_quit_cleanup_notice(&root, &lines)
        })
        .unwrap();
        let openbot = read_quit_cleanup_notice(&root).unwrap().unwrap();
        assert_eq!(openbot.said, "OpenBot had trouble shutting down last time.");
        assert!(openbot
            .detail
            .as_deref()
            .unwrap()
            .contains("containers stopped"));
        assert!(take_local_eval_stop_notice(&root).is_some());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_failure_with_no_stack_recorded_still_gets_a_failed_row() {
        let root = local_eval_root("openbot-quit-progress-untied-failure", None);
        let shell = Shell::default();
        let phases = std::cell::RefCell::new(Vec::new());
        exit_cleanup_reporting(
            &shell,
            &root,
            |_| Ok(0),
            |_| Ok(()),
            |_| Err("the CLI timed out".to_string()),
            |step, state| {
                phases.borrow_mut().push(format!("{}:{state:?}", step.id()));
            },
        );
        // The screen never says everything stopped when something did not.
        assert_eq!(
            phases.into_inner(),
            [
                "stop-openbot:Running",
                "stop-openbot:Complete",
                "stop-intelligence:Failed",
            ]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn quit_status_keeps_one_row_per_step_with_fixed_words_and_a_rising_sequence() {
        let mut status = QuitStatus::default();
        status.begin();
        let started = status.seq;
        status.record(QuitStep::OpenBot, QuitStepState::Running);
        status.record(QuitStep::OpenBot, QuitStepState::Failed);
        status.record(QuitStep::Intelligence, QuitStepState::Running);
        assert!(status.seq > started);
        assert_eq!(
            serde_json::to_value(&status).unwrap()["steps"],
            serde_json::json!([
                {"step": "stop-openbot", "ok": false, "detail": "", "running": false},
                {"step": "stop-intelligence", "ok": true, "detail": "", "running": true},
            ])
        );
        let seq = status.seq;
        status.begin();
        assert!(
            status.seq > seq,
            "a second Quit never looks older than the first"
        );
        assert!(status.steps.is_empty());
    }

    #[test]
    fn quit_puts_the_shutting_down_screen_in_front_and_exits_with_or_without_a_window() {
        use std::sync::{Arc, Mutex};
        use tauri::Listener;
        // Quit closes local evaluation for the rest of the process.
        if test_support::isolated_process(
            "tests::quit_puts_the_shutting_down_screen_in_front_and_exits_with_or_without_a_window",
        ) {
            return;
        }
        for (window_at, listening) in [
            (None, false),
            (Some("http://127.0.0.1:3010/channel/existing"), true),
            (Some("http://tauri.localhost/"), true),
            (Some("http://127.0.0.1:3010/"), false),
        ] {
            let root = local_eval_root(
                "openbot-quit-shutting-down",
                Some(local_eval_state::Ownership::Created),
            );
            // Nothing for Compose to take down; this build has no CLI, so Intelligence fails.
            std::fs::remove_file(root.join("docker-compose.yml")).unwrap();
            let shell = Shell::default();
            *shell.root.lock().unwrap() = Some(root.clone());
            *shell.setup_url.lock().unwrap() = Some("http://tauri.localhost/".into());
            let quit = Arc::clone(&shell.quit);
            let app = tauri::test::mock_builder()
                .manage(shell)
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let window = window_at.map(|url| {
                let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                    .build()
                    .unwrap();
                window.navigate(url.parse().unwrap()).unwrap();
                window.hide().unwrap();
                window
            });
            let seen = Arc::new(Mutex::new(Vec::new()));
            if listening {
                let seen = Arc::clone(&seen);
                app.listen_any(QUIT_PROGRESS_EVENT, move |event| {
                    let status: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
                    let rows = status["steps"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|row| {
                            format!(
                                "{}:{}",
                                row["step"].as_str().unwrap(),
                                if row["running"] == true {
                                    "running"
                                } else if row["ok"] == true {
                                    "complete"
                                } else {
                                    "failed"
                                }
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(",");
                    seen.lock().unwrap().push(rows);
                });
            }
            let exited = Arc::new(Mutex::new(None));
            let cleaning = app.handle().clone();
            let noticed = root.clone();
            let exiting = Arc::clone(&exited);
            request_quit_with(
                quit,
                Some(0),
                || {},
                move || quit_cleanup_shown(&cleaning),
                QuitDiagnostics {
                    sink: move |lines: Vec<String>| write_quit_cleanup_notice(&noticed, &lines),
                    failed: |error: String| panic!("the notice was not written: {error}"),
                },
                move |code| *exiting.lock().unwrap() = Some(code),
                |work| {
                    work();
                    Ok(())
                },
            )
            .unwrap();

            assert_eq!(*exited.lock().unwrap(), Some(0), "{window_at:?}");
            // The Intelligence failure is in its own notice, as before the screen existed, and
            // OpenBot's is not written for it.
            assert!(!quit_cleanup_notice_path(&root).exists(), "{window_at:?}");
            assert!(
                take_local_eval_stop_notice(&root).is_some(),
                "{window_at:?}"
            );
            if listening {
                assert_eq!(
                    *seen.lock().unwrap(),
                    [
                        "stop-openbot:running",
                        "stop-openbot:complete",
                        "stop-openbot:complete,stop-intelligence:running",
                        "stop-openbot:complete,stop-intelligence:failed",
                    ],
                    "{window_at:?}"
                );
            }
            if let Some(window) = window {
                assert!(window.is_visible().unwrap(), "{window_at:?}");
                let expected = if window_at == Some("http://tauri.localhost/") {
                    // Already the setup page: its own listener shows the screen, no reload.
                    "http://tauri.localhost/"
                } else {
                    "http://tauri.localhost/#shutting-down"
                };
                assert_eq!(window.url().unwrap().as_str(), expected, "{window_at:?}");
            }
            let status = quit_status(app.handle().clone()).expect("the page can catch up");
            assert_eq!(status.steps.len(), 2);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn an_intelligence_failure_is_reported_but_does_not_keep_openbot_in_recovery() {
        let active = local_eval_root("openbot-stop-intelligence-recovery", None);
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(active.clone());
        mark_recovery_required(&shell, &active, 0);

        let stopped = stop_everything_then(
            &shell,
            &active,
            |_| Ok(0),
            |_| Ok(()),
            |_| Err("the CLI timed out".to_string()),
        );

        assert!(stopped.openbot.is_empty(), "{stopped:?}");
        assert_eq!(
            stopped.into_result(),
            Err("Intelligence stop failed: the CLI timed out".into()),
            "an Intelligence failure is not a silent success"
        );
        assert!(!recovery_required(&shell, &active));

        *shell.root.lock().unwrap() = Some(active.clone());
        mark_recovery_required(
            &shell,
            &active,
            shell.generation.load(std::sync::atomic::Ordering::SeqCst),
        );
        let failures = exit_cleanup_then(
            &shell,
            &active,
            |_| Ok(0),
            |_| Ok(()),
            |_| Err("the CLI timed out".to_string()),
        );
        assert_eq!(
            failures.lines(),
            ["Intelligence stop failed: the CLI timed out"]
        );
        assert!(!recovery_required(&shell, &active));
        let _ = std::fs::remove_dir_all(active);
    }

    #[test]
    fn a_stack_openbot_did_not_create_is_never_stopped() {
        for ownership in [None, Some(local_eval_state::Ownership::Shared)] {
            let root = local_eval_root("openbot-local-eval-untied", ownership);
            let phases = std::cell::RefCell::new(Vec::new());

            let result = stop_local_eval_with(
                &root,
                || phases.borrow_mut().push("cancel-all".to_string()),
                |stack| {
                    phases.borrow_mut().push(format!("stop:{}", stack.as_str()));
                    Ok(local_eval_report(local_eval::Outcome::Completed, None))
                },
            );

            assert_eq!(result, Ok(()), "{ownership:?}");
            // Its own calls are cancelled; the stack is not stopped.
            assert_eq!(phases.into_inner(), ["cancel-all"], "{ownership:?}");
            // The production adapter too: had it tried, this build's missing CLI would have failed.
            assert_eq!(
                stop_local_eval(&root, local_eval::Limits::for_quit()),
                Ok(()),
                "{ownership:?}"
            );
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn a_stack_openbot_created_is_stopped_after_cancelling_calls_in_flight() {
        let root = local_eval_root(
            "openbot-local-eval-created",
            Some(local_eval_state::Ownership::Created),
        );
        let phases = std::cell::RefCell::new(Vec::new());

        let result = stop_local_eval_with(
            &root,
            || phases.borrow_mut().push("cancel-all".to_string()),
            |stack| {
                phases.borrow_mut().push(format!("stop:{}", stack.as_str()));
                Ok(local_eval_report(local_eval::Outcome::Completed, None))
            },
        );

        assert_eq!(result, Ok(()));
        assert_eq!(phases.into_inner(), ["cancel-all", "stop:local-abc123"]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn every_way_a_stop_can_fail_is_reported_in_fixed_words() {
        let root = local_eval_root(
            "openbot-local-eval-stop-failures",
            Some(local_eval_state::Ownership::Created),
        );
        let failed = |result: Result<local_eval::Report, local_eval::Failure>| {
            stop_local_eval_with(&root, || {}, move |_| result)
                .expect_err("a stop that did not complete is reported")
        };

        assert_eq!(
            failed(Err(local_eval::Failure::Unavailable)),
            "this build has no Intelligence CLI to stop the local Intelligence stack OpenBot created"
        );
        assert_eq!(
            failed(Err(local_eval::Failure::Timeout)),
            "the Intelligence CLI did not stop the local Intelligence stack (timeout)"
        );
        assert_eq!(
            failed(Ok(local_eval_report(
                local_eval::Outcome::Blocked,
                Some(local_eval::Reason::LocalCommandBusy)
            ))),
            "the Intelligence CLI did not stop the local Intelligence stack (blocked: local-command-busy)"
        );
        assert_eq!(
            failed(Ok(local_eval_report(local_eval::Outcome::Failed, None))),
            "the Intelligence CLI did not stop the local Intelligence stack (failed)"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn quit_reports_a_created_stack_this_build_cannot_stop() {
        let root = local_eval_root(
            "openbot-local-eval-quit-no-cli",
            Some(local_eval_state::Ownership::Created),
        );
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(root.clone());

        let failures = exit_cleanup_then(
            &shell,
            &root,
            |_| Ok(0),
            |_| Err("compose down refused".to_string()),
            |root| stop_local_eval(root, local_eval::Limits::for_quit()),
        );

        assert_eq!(
            failures.lines(),
            [
                "Compose down failed: compose down refused",
                "Intelligence stop failed: this build has no Intelligence CLI to stop the local \
                 Intelligence stack OpenBot created"
            ]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    const NO_CLI_LINE: &str = "Intelligence stop failed: this build has no Intelligence CLI to \
                               stop the local Intelligence stack OpenBot created";

    #[test]
    fn an_intelligence_failure_on_quit_is_shown_next_launch_without_recovery() {
        let root = local_eval_root("openbot-quit-intelligence-notice", None);
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(root.clone());
        let failures = exit_cleanup_then(
            &shell,
            &root,
            |_| Ok(0),
            |_| Ok(()),
            |_| Err("the CLI timed out".to_string()),
        );
        // The quit sink, exactly as production wires it.
        report_exit_cleanup_failures(failures.lines(), |lines| {
            write_quit_cleanup_notice(&root, &lines)
        })
        .unwrap();

        // Next launch: nothing about OpenBot's own processes, and nothing holding its start.
        let next = Shell::default();
        assert!(!quit_cleanup_notice_path(&root).exists());
        assert!(!recovery_required_or_pending_quit_notice(&next, &root));
        assert!(!recovery_required(&next, &root));
        assert_eq!(read_quit_cleanup_notice(&root).unwrap(), None);
        let problem =
            take_local_eval_stop_notice(&root).expect("the Intelligence failure is still shown");
        assert!(problem.said.contains("Intelligence"), "{problem:?}");
        assert!(!problem.said.contains("app processes"), "{problem:?}");
        assert_eq!(take_local_eval_stop_notice(&root), None, "shown once");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_quit_notice_keeps_openbot_and_intelligence_failures_apart() {
        let root = local_eval_root("openbot-quit-mixed-notice", None);
        write_quit_cleanup_notice(
            &root,
            &[
                "[exit] cleanup failed: Compose down failed: refused".to_string(),
                format!("[exit] cleanup failed: {NO_CLI_LINE}"),
            ],
        )
        .unwrap();

        let next = Shell::default();
        assert!(recovery_required_or_pending_quit_notice(&next, &root));
        let openbot = read_quit_cleanup_notice(&root).unwrap().unwrap();
        assert_eq!(
            openbot.detail.as_deref(),
            Some("OpenBot could not confirm all containers stopped.")
        );
        assert!(take_local_eval_stop_notice(&root).is_some());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn menu_stop_marks_recovery_only_for_openbot_failures() {
        let root = local_eval_root("openbot-menu-stop-intelligence", None);
        let shell = Shell::default();

        let intelligence_only = Stopped {
            openbot: Vec::new(),
            intelligence: Some(NO_CLI_LINE.into()),
        };
        let problem = settle_menu_stop(&shell, &root, intelligence_only)
            .expect("an Intelligence failure is still said");
        assert!(problem.said.contains("Intelligence"), "{problem:?}");
        assert_eq!(problem.detail.as_deref(), Some(NO_CLI_LINE));
        assert!(!recovery_required(&shell, &root));
        assert_eq!(shell.last_failure.lock().unwrap().as_ref(), Some(&problem));

        let both = Stopped {
            openbot: vec!["Compose down failed: refused".into()],
            intelligence: Some(NO_CLI_LINE.into()),
        };
        let problem = settle_menu_stop(&shell, &root, both).unwrap();
        assert_eq!(
            problem.said,
            "OpenBot could not finish stopping. Try Stop OpenBot again."
        );
        assert_eq!(
            problem.detail.as_deref(),
            Some(format!("Compose down failed: refused\n{NO_CLI_LINE}").as_str())
        );
        assert!(recovery_required(&shell, &root));

        assert_eq!(
            settle_menu_stop(&Shell::default(), &root, Stopped::default()),
            None
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn quit_does_not_wait_behind_a_stop_asking_intelligence_to_stop() {
        let root = local_eval_root("openbot-quit-behind-stop", None);
        let shell = std::sync::Arc::new(Shell::default());
        *shell.root.lock().unwrap() = Some(root.clone());
        let (asking, asked) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let stopping = {
            let (shell, root) = (shell.clone(), root.clone());
            std::thread::spawn(move || {
                stop_everything_then(
                    &shell,
                    &root,
                    |_| Ok(0),
                    |_| Ok(()),
                    |_| {
                        asking.send(()).unwrap();
                        released.recv().unwrap();
                        Ok(())
                    },
                )
            })
        };
        asked.recv().unwrap();
        let quitting = {
            let (shell, root) = (shell.clone(), root.clone());
            std::thread::spawn(move || {
                exit_cleanup_then(&shell, &root, |_| Ok(0), |_| Ok(()), |_| Ok(()))
            })
        };
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !quitting.is_finished() {
            assert!(
                std::time::Instant::now() < until,
                "Quit waited behind Stop's Intelligence step"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        release.send(()).unwrap();
        assert_eq!(quitting.join().unwrap(), Stopped::default());
        assert_eq!(stopping.join().unwrap(), Stopped::default());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stop_closes_local_eval_before_anything_else_and_reopens_after() {
        // Closing is process-wide, and Quit's never reopens.
        if test_support::isolated_process(
            "tests::stop_closes_local_eval_before_anything_else_and_reopens_after",
        ) {
            return;
        }
        let root = local_eval_root("openbot-stop-closes-local-eval", None);
        let shell = Shell::default();
        let stack = local_eval::StackId::parse("local-abc123").unwrap();
        let refused = |when: &str| {
            assert_eq!(
                local_eval::run_installed(when, local_eval::Action::Start, &stack),
                Err(local_eval::Failure::Cancelled),
                "{when}"
            );
        };
        let stopped = stop_everything_then(
            &shell,
            &root,
            |_| {
                refused("during-cleanup");
                Ok(0)
            },
            |_| Ok(()),
            |_| {
                refused("during-intelligence");
                Ok(())
            },
        );
        assert_eq!(stopped, Stopped::default());
        assert_eq!(
            local_eval::run_installed("after-stop", local_eval::Action::Status, &stack),
            Err(local_eval::Failure::Unavailable)
        );

        exit_cleanup_then(
            &shell,
            &root,
            |_| {
                refused("during-quit-cleanup");
                Ok(0)
            },
            |_| Ok(()),
            |_| Ok(()),
        );
        refused("after-quit");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stop_and_quit_choose_their_own_limits_for_the_real_adapter() {
        assert_eq!(
            intelligence_limits(Shutdown::Stop).timeout,
            local_eval::Limits::for_action(local_eval::Action::Stop).timeout
        );
        assert_eq!(
            intelligence_limits(Shutdown::Quit).timeout,
            local_eval::Limits::for_quit().timeout
        );
        let root = local_eval_root(
            "openbot-intelligence-step",
            Some(local_eval_state::Ownership::Created),
        );
        for kind in [Shutdown::Stop, Shutdown::Quit] {
            assert_eq!(
                intelligence_step(kind)(&root),
                Err(NO_CLI_LINE
                    .strip_prefix(INTELLIGENCE_STOP_FAILED)
                    .unwrap()
                    .to_owned()),
                "{kind:?}"
            );
            assert_eq!(
                last_intelligence_timeout(),
                Some(intelligence_limits(kind).timeout),
                "{kind:?}"
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn production_stop_and_quit_ask_intelligence_with_their_own_limits() {
        // Quit closes local evaluation for the rest of the process.
        if test_support::isolated_process(
            "tests::production_stop_and_quit_ask_intelligence_with_their_own_limits",
        ) {
            return;
        }
        let root = local_eval_root(
            "openbot-production-intelligence-wiring",
            Some(local_eval_state::Ownership::Created),
        );
        std::fs::remove_file(root.join("docker-compose.yml")).unwrap();
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(root.clone());

        let stopped = stop_everything_for(&shell, &root);
        assert_eq!(
            stopped,
            Stopped {
                openbot: Vec::new(),
                intelligence: Some(NO_CLI_LINE.into()),
            }
        );
        assert_eq!(
            last_intelligence_timeout(),
            Some(local_eval::Limits::for_action(local_eval::Action::Stop).timeout)
        );

        *shell.root.lock().unwrap() = Some(root.clone());
        let quit = quit_cleanup(&shell, |_, _| {});
        assert_eq!(quit.lines(), [NO_CLI_LINE]);
        assert_eq!(
            last_intelligence_timeout(),
            Some(local_eval::Limits::for_quit().timeout)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    fn local_eval_completed(stack: &str) -> local_eval::Report {
        let listing = serde_json::json!({
            "version": 1,
            "command": "local list",
            "status": "completed",
            "stacks": [{
                "id": stack,
                "installedRelease": "0.13.14",
                "step": "ready",
                "urls": {
                    "api": "http://localhost:64770",
                    "dashboard": "http://localhost:64771",
                    "gateway": "ws://localhost:64772"
                }
            }]
        });
        let listed = local_eval::normalize_list(0, listing.to_string().as_bytes()).unwrap();
        local_eval::Report {
            stack: listed.stacks.into_iter().next(),
            ..local_eval_report(local_eval::Outcome::Completed, None)
        }
    }

    #[test]
    fn a_completed_setup_records_the_stack_as_openbots() {
        let root = local_eval_root("openbot-local-eval-setup-created", None);
        let report = set_up_local_eval_at(&root, |folder| {
            assert_eq!(folder, root.as_path(), "setup runs in the installation");
            Ok((
                local_eval_completed("local-67db320bed3f3e893a4f8122"),
                LOCAL_EVAL_PIN.to_owned(),
            ))
        })
        .unwrap();
        assert_eq!(report.outcome, local_eval::Outcome::Completed);
        let state = local_eval_state::read(&root, Some(LOCAL_EVAL_PIN)).unwrap();
        assert_eq!(state.stack, "local-67db320bed3f3e893a4f8122");
        assert!(state.tied_to_openbot());
        assert_eq!(state.phase, local_eval_state::Phase::Installed);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_setup_that_did_not_complete_records_nothing() {
        let root = local_eval_root("openbot-local-eval-setup-blocked", None);
        let blocked = local_eval_report(
            local_eval::Outcome::Blocked,
            Some(local_eval::Reason::EulaAcceptanceRequired),
        );
        let report =
            set_up_local_eval_at(&root, |_| Ok((blocked, LOCAL_EVAL_PIN.to_owned()))).unwrap();
        assert_eq!(
            report.reason,
            Some(local_eval::Reason::EulaAcceptanceRequired)
        );
        assert_eq!(local_eval_state::read(&root, None), None);
        assert!(matches!(
            set_up_local_eval_at(&root, |_| Err(local_eval::Failure::Timeout)),
            Err(SetupError::Failure(local_eval::Failure::Timeout))
        ));
        assert_eq!(local_eval_state::read(&root, None), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn setting_up_again_keeps_a_stack_openbot_found_shared() {
        let root = local_eval_root(
            "openbot-local-eval-setup-shared",
            Some(local_eval_state::Ownership::Shared),
        );
        set_up_local_eval_at(&root, |_| {
            Ok((
                local_eval_completed("local-abc123"),
                LOCAL_EVAL_PIN.to_owned(),
            ))
        })
        .unwrap();
        assert!(!local_eval_state::read(&root, None)
            .unwrap()
            .tied_to_openbot());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_stack_set_up_but_not_recorded_is_said() {
        let parent = temp_root("openbot-local-eval-setup-unrecorded");
        std::fs::create_dir_all(&parent).unwrap();
        // A file where the installation folder should be: nothing can be written inside it.
        let root = parent.join("not-a-folder");
        std::fs::write(&root, "").unwrap();
        let error = set_up_local_eval_at(&root, |_| {
            Ok((
                local_eval_completed("local-abc123"),
                LOCAL_EVAL_PIN.to_owned(),
            ))
        })
        .expect_err("an unrecorded stack would never be stopped with OpenBot");
        let SetupError::Unrecorded(problem) = error else {
            panic!("{error:?}");
        };
        assert!(problem.said.contains("local evaluation"), "{problem:?}");
        let _ = std::fs::remove_dir_all(parent);
    }

    const LOCAL_KEY: &str = "cpk-synthetic-local-key";

    /// What `local connect` leaves in an installation folder, after a line OpenBot wrote earlier.
    fn local_eval_connected_env(root: &Path) {
        std::fs::write(
            root.join(".env"),
            format!(
                "SERVER_PORT=3001\nINTELLIGENCE_API_URL=http://localhost:64770\nINTELLIGENCE_GATEWAY_WS_URL=ws://localhost:64772\nCPK_INTELLIGENCE_API_KEY={LOCAL_KEY}\nSL_ENABLED=true\n"
            ),
        )
        .unwrap();
    }

    fn local_eval_connection(
        outcome: local_eval::Outcome,
        stack: &str,
        reason: Option<local_eval::Reason>,
        conflicted: bool,
    ) -> local_eval::Connection {
        local_eval::Connection {
            outcome,
            stack: local_eval_completed(stack).stack,
            reason,
            conflicted,
        }
    }

    type FakeVault = std::cell::RefCell<std::collections::BTreeMap<String, String>>;

    fn connect_with_vault(
        root: &Path,
        vault: &FakeVault,
        connection: Result<local_eval::Connection, local_eval::Failure>,
    ) -> Result<local_eval::Connection, ConnectError> {
        connect_local_eval_at(
            root,
            |folder| {
                assert_eq!(folder, root, "connect runs in the installation");
                connection
            },
            |_, name, value| {
                vault.borrow_mut().insert(name.into(), value.into());
                Ok(())
            },
            |_, name| Ok(vault.borrow().get(name).cloned()),
        )
    }

    #[test]
    fn a_completed_connection_moves_its_key_into_the_vault_and_out_of_the_file() {
        let root = local_eval_root(
            "openbot-local-eval-connect-vault",
            Some(local_eval_state::Ownership::Created),
        );
        local_eval_connected_env(&root);
        let vault = FakeVault::default();
        let connection = connect_with_vault(
            &root,
            &vault,
            Ok(local_eval_connection(
                local_eval::Outcome::Completed,
                "local-abc123",
                None,
                false,
            )),
        )
        .unwrap();
        assert_eq!(connection.outcome, local_eval::Outcome::Completed);
        // OpenBot's server reads INTELLIGENCE_API_KEY; the CLI names it for an app's runtime.
        assert_eq!(
            vault
                .borrow()
                .get("INTELLIGENCE_API_KEY")
                .map(String::as_str),
            Some(LOCAL_KEY)
        );
        assert_eq!(vault.borrow().len(), 1);
        let env = std::fs::read_to_string(root.join(".env")).unwrap();
        assert!(!env.contains(LOCAL_KEY), "{env}");
        assert!(!env.contains("CPK_INTELLIGENCE_API_KEY"), "{env}");
        for line in [
            "INTELLIGENCE_API_URL=http://localhost:64770",
            "INTELLIGENCE_GATEWAY_WS_URL=ws://localhost:64772",
            "SL_ENABLED=true",
            "SERVER_PORT=3001",
        ] {
            assert_eq!(
                env.lines().filter(|found| *found == line).count(),
                1,
                "{env}"
            );
        }
        assert!(local_eval_state::read(&root, None).unwrap().connected);
        assert!(!serde_json::to_string(&connection)
            .unwrap()
            .contains(LOCAL_KEY));

        // Start then takes it from the vault exactly like a key pasted earlier.
        let key = intelligence_key_for_start(&root, String::new(), |_, name| {
            Ok(vault.borrow().get(name).cloned().unwrap_or_default())
        })
        .unwrap();
        assert_eq!(key, LOCAL_KEY);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn starting_after_a_connection_neither_clobbers_nor_duplicates_it() {
        let root = local_eval_root(
            "openbot-local-eval-connect-start-env",
            Some(local_eval_state::Ownership::Created),
        );
        local_eval_connected_env(&root);
        let vault = FakeVault::default();
        connect_with_vault(
            &root,
            &vault,
            Ok(local_eval_connection(
                local_eval::Outcome::Completed,
                "local-abc123",
                None,
                false,
            )),
        )
        .unwrap();
        // Start's own write: the same addresses as settings, its credentials purged to the vault.
        let (settings, secrets) = openbot_desktop_lib::vault::split(
            [
                ("INTELLIGENCE_API_URL", "http://localhost:64770"),
                ("INTELLIGENCE_GATEWAY_WS_URL", "ws://localhost:64772"),
                ("INTELLIGENCE_API_KEY", LOCAL_KEY),
                ("SERVER_PORT", "3001"),
            ]
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value.to_owned()))
            .collect(),
        );
        openbot_env::write(&root.join(".env"), &settings, &secrets).unwrap();
        let env = std::fs::read_to_string(root.join(".env")).unwrap();
        for key in [
            "INTELLIGENCE_API_URL=",
            "INTELLIGENCE_GATEWAY_WS_URL=",
            "SL_ENABLED=",
            "SERVER_PORT=",
        ] {
            assert_eq!(
                env.lines().filter(|line| line.starts_with(key)).count(),
                1,
                "{env}"
            );
        }
        assert!(!env.contains(LOCAL_KEY), "{env}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_connection_that_is_not_complete_takes_nothing() {
        for (connection, label) in [
            (
                local_eval_connection(
                    local_eval::Outcome::Blocked,
                    "local-abc123",
                    Some(local_eval::Reason::ConfirmationRequired),
                    false,
                ),
                "confirmation",
            ),
            (
                local_eval_connection(local_eval::Outcome::Blocked, "local-abc123", None, true),
                "conflict",
            ),
            (
                local_eval::Connection {
                    stack: None,
                    ..local_eval_connection(
                        local_eval::Outcome::Failed,
                        "local-abc123",
                        Some(local_eval::Reason::LocalCommandFailed),
                        false,
                    )
                },
                "failed",
            ),
        ] {
            let root = local_eval_root(
                &format!("openbot-local-eval-connect-{label}"),
                Some(local_eval_state::Ownership::Created),
            );
            local_eval_connected_env(&root);
            let before = std::fs::read_to_string(root.join(".env")).unwrap();
            let vault = FakeVault::default();
            let answer = connect_with_vault(&root, &vault, Ok(connection.clone())).unwrap();
            assert_eq!(answer, connection, "{label}");
            assert!(vault.borrow().is_empty(), "{label}");
            assert_eq!(std::fs::read_to_string(root.join(".env")).unwrap(), before);
            assert!(!local_eval_state::read(&root, None).unwrap().connected);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn a_connection_is_taken_only_for_the_recorded_stack_and_its_own_addresses() {
        let completed = |stack: &str| {
            Ok(local_eval_connection(
                local_eval::Outcome::Completed,
                stack,
                None,
                false,
            ))
        };
        // No recorded stack: the CLI is not asked at all.
        let root = local_eval_root("openbot-local-eval-connect-unrecorded", None);
        let vault = FakeVault::default();
        let error = connect_local_eval_at(
            &root,
            |_| panic!("connect ran without a recorded stack"),
            |_, _, _| panic!("stored a key"),
            |_, _| Ok(None),
        )
        .unwrap_err();
        assert!(matches!(error, ConnectError::Unconnected(_)), "{error:?}");
        let _ = std::fs::remove_dir_all(root);

        // Another stack, or addresses that are not the stack's own: nothing is stored.
        for (label, stack, env) in [
            ("other-stack", "local-other", None),
            (
                "other-address",
                "local-abc123",
                Some(format!("INTELLIGENCE_API_URL=http://localhost:9999\nINTELLIGENCE_GATEWAY_WS_URL=ws://localhost:64772\nCPK_INTELLIGENCE_API_KEY={LOCAL_KEY}\n")),
            ),
            (
                "no-address",
                "local-abc123",
                Some(format!("CPK_INTELLIGENCE_API_KEY={LOCAL_KEY}\n")),
            ),
        ] {
            let root = local_eval_root(
                &format!("openbot-local-eval-connect-{label}"),
                Some(local_eval_state::Ownership::Created),
            );
            match env {
                Some(env) => std::fs::write(root.join(".env"), env).unwrap(),
                None => local_eval_connected_env(&root),
            }
            let error = connect_with_vault(&root, &vault, completed(stack)).unwrap_err();
            let ConnectError::Unconnected(problem) = error else {
                panic!("{label}: {error:?}");
            };
            assert!(!format!("{problem:?}").contains(LOCAL_KEY), "{label}");
            assert!(vault.borrow().is_empty(), "{label}");
            assert!(!local_eval_state::read(&root, None).unwrap().connected);
            let _ = std::fs::remove_dir_all(root);
        }

        // A CLI failure is its own static category.
        let root = local_eval_root(
            "openbot-local-eval-connect-timeout",
            Some(local_eval_state::Ownership::Created),
        );
        assert!(matches!(
            connect_with_vault(&root, &vault, Err(local_eval::Failure::Timeout)),
            Err(ConnectError::Failure(local_eval::Failure::Timeout))
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn connecting_again_uses_the_key_already_kept() {
        let root = local_eval_root(
            "openbot-local-eval-connect-again",
            Some(local_eval_state::Ownership::Created),
        );
        // The CLI's second connect changes nothing, and the file no longer holds the key.
        std::fs::write(
            root.join(".env"),
            "INTELLIGENCE_API_URL=http://localhost:64770\nINTELLIGENCE_GATEWAY_WS_URL=ws://localhost:64772\n",
        )
        .unwrap();
        let completed = || {
            Ok(local_eval_connection(
                local_eval::Outcome::Completed,
                "local-abc123",
                None,
                false,
            ))
        };
        let vault = FakeVault::default();
        // Never connected: a key from somewhere else is not this stack's.
        vault
            .borrow_mut()
            .insert("INTELLIGENCE_API_KEY".into(), "hosted-key".into());
        assert!(matches!(
            connect_with_vault(&root, &vault, completed()),
            Err(ConnectError::Unconnected(_))
        ));
        let stack = local_eval::StackId::parse("local-abc123").unwrap();
        local_eval_state::mark_connected(&root, &stack).unwrap();
        vault.borrow_mut().clear();
        assert!(matches!(
            connect_with_vault(&root, &vault, completed()),
            Err(ConnectError::Unconnected(_))
        ));
        vault
            .borrow_mut()
            .insert("INTELLIGENCE_API_KEY".into(), LOCAL_KEY.into());
        assert_eq!(
            connect_with_vault(&root, &vault, completed())
                .unwrap()
                .outcome,
            local_eval::Outcome::Completed
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn already_configured_shows_the_local_evaluation_only_when_there_is_one() {
        let root = local_eval_root("openbot-already-configured-local-eval", None);
        let configured = already_configured_for_root(root.to_string_lossy().into_owned());
        let json = serde_json::to_value(&configured).unwrap();
        assert!(json.get("localEval").is_none(), "{json}");

        let stack = local_eval::StackId::parse("local-abc123").unwrap();
        local_eval_state::begin(
            &root,
            &stack,
            local_eval_state::Ownership::Created,
            LOCAL_EVAL_PIN,
        )
        .unwrap();
        let configured = already_configured_for_root(root.to_string_lossy().into_owned());
        let json = serde_json::to_value(&configured).unwrap();
        assert_eq!(
            json["localEval"],
            serde_json::json!({
                "stack": "local-abc123",
                "ownership": "created",
                "phase": "installed",
                "connected": false
            })
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn production_stop_root_selection_retains_resolved_root_not_menu_fallback() {
        let selected = temp_root("openbot-production-stop-selected-root");
        let fallback = temp_root("openbot-production-stop-default-root");
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(selected.clone());
        remember_selected_root(&shell, &fallback);

        let stop_root = root_for_stop(&shell, &fallback);

        assert_eq!(stop_root, selected);
        assert_eq!(
            shell.selected_root.lock().unwrap().as_ref(),
            Some(&selected)
        );
        let _ = std::fs::remove_dir_all(selected);
        let _ = std::fs::remove_dir_all(fallback);
    }

    #[test]
    fn production_stop_root_selection_retains_stopped_selected_root_not_menu_fallback() {
        let selected = temp_root("openbot-production-stop-stopped-selected-root");
        let fallback = temp_root("openbot-production-stop-stopped-default-root");
        let shell = Shell::default();
        remember_selected_root(&shell, &selected);

        let stop_root = root_for_stop(&shell, &fallback);

        assert_eq!(stop_root, selected);
        assert_eq!(
            shell.selected_root.lock().unwrap().as_ref(),
            Some(&selected)
        );
        let _ = std::fs::remove_dir_all(selected);
        let _ = std::fs::remove_dir_all(fallback);
    }

    #[test]
    fn production_stop_root_selection_uses_menu_fallback_when_no_root_is_known() {
        let fallback = temp_root("openbot-production-stop-only-default-root");
        let shell = Shell::default();

        let stop_root = root_for_stop(&shell, &fallback);

        assert_eq!(stop_root, fallback);
        assert_eq!(
            shell.selected_root.lock().unwrap().as_ref(),
            Some(&fallback)
        );
        let _ = std::fs::remove_dir_all(fallback);
    }

    #[test]
    fn successful_stop_then_exit_uses_the_retained_selected_root_not_default() {
        let selected = temp_root("openbot-selected-stop-exit");
        let fallback = temp_root("openbot-default-stop-exit");
        std::fs::create_dir_all(&selected).unwrap();
        std::fs::create_dir_all(&fallback).unwrap();
        std::fs::write(fallback.join("sentinel"), "default-root-untouched").unwrap();
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(selected.clone());
        remember_selected_root(&shell, &selected);
        let phases = std::cell::RefCell::new(Vec::new());

        stop_everything_with(
            &shell,
            &fallback,
            |root| {
                phases
                    .borrow_mut()
                    .push(format!("stop-cleanup:{}", root.display()));
                Ok(0)
            },
            |root| {
                phases
                    .borrow_mut()
                    .push(format!("stop-down:{}", root.display()));
                Ok(())
            },
        )
        .unwrap();
        assert!(shell.root.lock().unwrap().is_none());

        let failures = exit_cleanup_with(
            &shell,
            &fallback,
            |root| {
                phases
                    .borrow_mut()
                    .push(format!("exit-cleanup:{}", root.display()));
                Ok(0)
            },
            |root| {
                phases
                    .borrow_mut()
                    .push(format!("exit-down:{}", root.display()));
                Ok(())
            },
        );

        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(
            phases.into_inner(),
            vec![
                format!("stop-cleanup:{}", selected.display()),
                format!("stop-down:{}", selected.display()),
                format!("exit-cleanup:{}", selected.display()),
                format!("exit-down:{}", selected.display()),
            ]
        );
        assert_eq!(
            std::fs::read_to_string(fallback.join("sentinel")).unwrap(),
            "default-root-untouched"
        );
        let _ = std::fs::remove_dir_all(selected);
        let _ = std::fs::remove_dir_all(fallback);
    }

    // End-to-end command tests: only the Tauri window and external engine are synthetic.
    // Start, deployment validation, private credential files, Stop and Quit cleanup are real.
    #[cfg(unix)]
    mod container_root {
        use super::*;
        use sha2::{Digest, Sha256};

        struct Fixture {
            base: PathBuf,
            a: PathBuf,
            b: PathBuf,
            path: SerializedPath,
            app: tauri::App<tauri::test::MockRuntime>,
            window: tauri::WebviewWindow<tauri::test::MockRuntime>,
            previous_runtime: Option<std::ffi::OsString>,
        }

        impl Fixture {
            fn new() -> Self {
                // Unix socket paths must remain below sockaddr_un's length limit on macOS too.
                let base = PathBuf::from("/tmp")
                    .join(temp_root("container-root-workflow").file_name().unwrap());
                std::fs::create_dir_all(&base).unwrap();
                let base = base.canonicalize().unwrap();
                let runtime = base.join("runtime");
                std::fs::create_dir_all(&runtime).unwrap();
                let previous_runtime = std::env::var_os("XDG_RUNTIME_DIR");
                std::env::set_var("XDG_RUNTIME_DIR", &runtime);
                let a = base.join("a");
                let b = base.join("b");
                write_installed_deployment(&a);
                std::fs::create_dir_all(&b).unwrap();
                let path = SerializedPath::set_only_with("docker", "shutdown");
                // Both engine names stay inside this subprocess's fixture PATH.
                let source = path.bin().join("container-engine.rs");
                std::fs::write(&source, r#"
use std::{env,fs,io::Write,path::PathBuf};
fn main() {
    let original:Vec<String>=env::args().skip(1).collect();
    let mut args=original.clone();
    let cwd=env::current_dir().unwrap();
    let record=PathBuf::from(env::var_os("OPENBOT_TEST_ENGINE_RECORD").unwrap());
    let base=record.parent().unwrap();
    let engine=PathBuf::from(env::args().next().unwrap()).file_name().unwrap().to_string_lossy().into_owned();
    let default=if engine=="docker" {"docker-context"} else {"podman-connection"};
    let mut target=fs::read_to_string(base.join(default)).unwrap();
    if engine=="podman" && args.first().is_some_and(|a| a=="--remote=false") {
        target="local".into(); args.remove(0);
    } else if args.first().is_some_and(|a| ["--context","--host","--connection","--url"].contains(&a.as_str())) {
        target=args[1].clone(); args.drain(..2);
    } else if engine=="docker" {
        target=env::var("DOCKER_CONTEXT").ok().filter(|s|!s.is_empty())
            .or_else(||env::var("DOCKER_HOST").ok().filter(|s|!s.is_empty())).unwrap_or(target);
    } else {
        target=env::var("CONTAINER_CONNECTION").ok().filter(|s|!s.is_empty()).unwrap_or(target);
    }
    let identity=format!("{engine}:{target}");
    let mut trace=fs::OpenOptions::new().create(true).append(true).open(base.join("affinity.log")).unwrap();
    writeln!(trace,"{}\t{}",identity,original.join(" ")).unwrap();
    let mut log=fs::OpenOptions::new().create(true).append(true).open(&record).unwrap();
    writeln!(log,"{}\t{}",cwd.display(),args.join(" ")).unwrap();
    // Mac Podman adds its port overlay only to service-creating commands. Keep the original
    // arguments in the ownership trace, then dispatch the same fixture behavior for up/run.
    if engine=="podman" && args.iter().any(|arg| arg=="up" || arg=="run") {
        while args.get(1).is_some_and(|arg| arg=="-f") {
            assert!(std::path::Path::new(&args[2]).is_file());
            args.drain(1..3);
        }
    }
    let words:Vec<&str>=args.iter().map(String::as_str).collect();
    if words==["context","show"] { println!("{target}"); return; }
    if words.starts_with(&["context","inspect"]) { println!("unix:///owned-default.sock"); return; }
    if words.starts_with(&["system", "service"]) {
        use std::{io::Read, os::unix::net::UnixListener, time::{Duration, Instant}};
        assert_eq!(engine, "podman");
        assert_eq!(target, "local");
        let socket=PathBuf::from(words.last().unwrap().strip_prefix("unix://").unwrap());
        assert_eq!(socket, PathBuf::from(env::var_os("XDG_RUNTIME_DIR").unwrap()).join("podman/podman.sock"));
        let listener=UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let deadline=Instant::now()+Duration::from_secs(60);
        while Instant::now()<deadline {
            match listener.accept() {
                Ok((mut stream,_)) => {
                    stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
                    stream.set_write_timeout(Some(Duration::from_secs(1))).unwrap();
                    let mut request=Vec::new();
                    while !request.ends_with(b"\r\n\r\n") {
                        let mut byte=[0;1]; stream.read_exact(&mut byte).unwrap(); request.push(byte[0]);
                        assert!(request.len()<4096);
                    }
                    assert!(request.starts_with(b"GET /_ping HTTP/1.1\r\n"));
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK").unwrap();
                }
                Err(error) if error.kind()==std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(10)),
                Err(error) => panic!("fixture API accept failed: {error}"),
            }
        }
        return;
    }
    if words.first()==Some(&"system") { println!("{target}"); return; }
    if words.first()==Some(&"machine") { println!("[]"); return; }
    if !base.join(format!("{engine}-ready")).exists() { eprintln!("synthetic original runtime unavailable"); std::process::exit(74); }
    match words.as_slice() {
        ["image", "inspect", _] => (),
        ["version","--format",_] => println!("1.44"),
        ["info","--format","{{.Host.ServiceIsRemote}}"] => println!("false"),
        ["compose","version"] => println!("Synthetic Compose"),
        ["compose","config","--environment"] => (),
        ["compose","config","--format","json"] => println!("{{\"services\":{{\"postgres\":{{\"volumes\":[{{\"type\":\"volume\",\"source\":\"postgres-data\",\"target\":\"/var/lib/postgresql/data\"}}]}}}},\"volumes\":{{\"postgres-data\":{{\"name\":\"fixture_postgres-data\"}}}}}}"),
        ["volume","ls","--format","{{.Name}}"] => (),
        ["compose","ps","--format",_] => (),
        ["compose","up",..] => {
            fs::write(cwd.join("fixture-containers-running"),&identity).unwrap();
            if cwd.join("fail-up").exists() { eprintln!("synthetic partial up failure");std::process::exit(71); }
        }
        ["compose","run","--rm","--pull","never","migrate"] => { eprintln!("synthetic migration barrier");std::process::exit(72); }
        ["compose","-f","docker-compose.yml","config","--format","json"] => println!("{{\"services\":{{\"supervisor\":{{\"environment\":{{\"COMPUTER_NAMESPACE\":\"fixture\"}}}}}}}}"),
        ["compose","-f","docker-compose.yml","stop","supervisor"] => (),
        ["ps","--quiet","--filter",_,"--filter",_] => (),
        ["compose","-f","docker-compose.yml","--profile","harness","down"] => {
            if cwd.join("fail-down").exists() { eprintln!("synthetic down refusal");std::process::exit(73); }
            if fs::read_to_string(cwd.join("fixture-containers-running")).ok().as_deref()==Some(&identity) {
                fs::remove_file(cwd.join("fixture-containers-running")).unwrap();
            }
        }
        _ => { eprintln!("unexpected fixture command: {args:?}");std::process::exit(99); }
    }
}
"#).unwrap();
                for name in [
                    "DOCKER_CONTEXT",
                    "DOCKER_HOST",
                    "CONTAINER_CONNECTION",
                    "CONTAINER_HOST",
                ] {
                    std::env::remove_var(name);
                }
                std::fs::write(base.join("docker-ready"), "").unwrap();
                std::fs::write(base.join("docker-context"), "alpha").unwrap();
                std::fs::write(base.join("podman-connection"), "alpha").unwrap();
                crate::test_support::compile_fixture(&source, &path.bin().join("docker"));
                std::fs::copy(path.bin().join("docker"), path.bin().join("podman")).unwrap();
                std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", base.join("commands.log"));
                let app = tauri::test::mock_builder()
                    .manage(Shell::default())
                    .invoke_handler(tauri::generate_handler![
                        start_stack,
                        stop_stack,
                        detect_engine
                    ])
                    .build(tauri::test::mock_context(tauri::test::noop_assets()))
                    .unwrap();
                let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                    .build()
                    .unwrap();
                Self {
                    base,
                    a,
                    b,
                    path,
                    app,
                    window,
                    previous_runtime,
                }
            }

            fn invoke(
                &self,
                cmd: &str,
                body: serde_json::Value,
            ) -> Result<serde_json::Value, serde_json::Value> {
                tauri::test::get_ipc_response(
                    &self.window,
                    tauri::webview::InvokeRequest {
                        cmd: cmd.into(),
                        callback: tauri::ipc::CallbackFn(0),
                        error: tauri::ipc::CallbackFn(1),
                        url: "tauri://localhost".parse().unwrap(),
                        body: tauri::ipc::InvokeBody::Json(body),
                        headers: Default::default(),
                        invoke_key: tauri::test::INVOKE_KEY.into(),
                    },
                )
                .map(|body| body.deserialize().unwrap())
            }

            fn start(&self, root: &Path, saved: bool) -> serde_json::Value {
                let model = if saved {
                    serde_json::json!({"provider":"openai","login":"api-key","saved":true})
                } else {
                    serde_json::json!({"provider":"openai","login":"api-key","apiKey":"synthetic-container-root-key"})
                };
                let result = self.invoke("start_stack", serde_json::json!({
                    "root":root,"apiUrl":"https://intelligence.example.test","gatewayWsUrl":"wss://gateway.example.test",
                    "apiKey":"synthetic-intelligence-key","model":model,"harness":null,
                })).expect_err("fixture Start must stop before host startup");
                println!(
                    "CONTAINER_START={}",
                    serde_json::json!({"root":root,"problem":result})
                );
                assert!(!root.join(".logs").exists(), "no hosts may start");
                result
            }

            fn stop(&self) -> Result<serde_json::Value, serde_json::Value> {
                self.invoke("stop_stack", serde_json::json!({"root":self.b}))
            }

            fn quit(&self) {
                assert!(self.quit_failures().is_empty(), "Quit cleanup failed");
            }

            fn quit_failures(&self) -> Vec<String> {
                let app = self.app.handle().clone();
                let fallback = self.b.clone();
                let (sent, received) = std::sync::mpsc::channel();
                let (reported, failures) = std::sync::mpsc::channel();
                request_quit_with(
                    std::sync::Arc::clone(&self.app.state::<Shell>().quit),
                    None,
                    || (),
                    move || {
                        exit_cleanup_with(
                            &app.state::<Shell>(),
                            &fallback,
                            stack::stop_processes_under,
                            |root| down_containers_on_quit(&app.state::<Shell>(), root),
                        )
                    },
                    QuitDiagnostics {
                        sink: move |errors: Vec<String>| {
                            for error in errors {
                                reported.send(error).unwrap();
                            }
                            Ok(())
                        },
                        failed: |_: String| {
                            panic!("container fixture diagnostics should be recorded")
                        },
                    },
                    move |code| sent.send(code).unwrap(),
                    |work| std::thread::Builder::new().spawn(work).map(|_| ()),
                )
                .unwrap();
                assert_eq!(
                    received
                        .recv_timeout(std::time::Duration::from_secs(10))
                        .unwrap(),
                    0
                );
                failures.try_iter().collect()
            }

            fn commands(&self) -> String {
                std::fs::read_to_string(self.base.join("commands.log")).unwrap_or_default()
            }

            fn assert_stopped(&self) {
                let commands = self.commands();
                println!(
                    "CONTAINER_COMMANDS={}",
                    serde_json::json!({"a":self.a,"b":self.b,"commands":commands,"aStillRunning":self.a.join("fixture-containers-running").exists()})
                );
                assert_compose_down_ran_under(&self.base.join("commands.log"), &self.a);
                assert!(!self.a.join("fixture-containers-running").exists());
                assert!(!commands
                    .lines()
                    .any(|line| line.starts_with(&format!("{}\tcompose", self.b.display()))));
            }
        }

        impl Drop for Fixture {
            fn drop(&mut self) {
                #[cfg(target_os = "linux")]
                self.app
                    .state::<Shell>()
                    .podman_api
                    .lock()
                    .unwrap()
                    .stop()
                    .expect("stop owned fixture API before deleting its runtime directory");
                match &self.previous_runtime {
                    Some(runtime) => std::env::set_var("XDG_RUNTIME_DIR", runtime),
                    None => std::env::remove_var("XDG_RUNTIME_DIR"),
                }
                println!(
                    "CONTAINER_CLEANUP={}",
                    serde_json::json!({"base":self.base,"bin":self.path.bin(),"commands":self.commands(),"affinity":std::fs::read_to_string(self.base.join("affinity.log")).unwrap_or_default(),"engineBinarySha256":format!("{:x}",Sha256::digest(std::fs::read(self.path.bin().join("docker")).unwrap())),"persistentFixtureProcesses":0})
                );
                std::fs::remove_dir_all(&self.base).expect("independent private fixture cleanup");
                std::fs::remove_dir_all(self.path.bin())
                    .expect("independent engine fixture cleanup");
                assert!(!self.base.exists());
                assert!(!self.path.bin().exists());
            }
        }

        // Docker live restore permits live containers while its API is unavailable. The compiled
        // fixture models that state; this exercises product IPC and cleanup, not a real daemon.
        fn engine_unavailable(quit: bool, host_error: bool, partial_up: bool) {
            let fixture = Fixture::new();
            if partial_up {
                std::fs::write(fixture.a.join("fail-up"), "").unwrap();
            }
            let problem = fixture.start(&fixture.a, false);
            assert!(problem["detail"].as_str().unwrap().contains(if partial_up {
                "synthetic partial up failure"
            } else {
                "synthetic migration barrier"
            }));
            let owner =
                std::fs::read_to_string(fixture.a.join("fixture-containers-running")).unwrap();
            assert_eq!(owner, "docker:alpha");
            assert!(fixture.commands().contains("\tcompose up "));

            // Neither discovery candidate answers, but losing API access does not delete the
            // containers. Probe through the generated command before independently asking Stop/Quit.
            std::fs::remove_file(fixture.base.join("docker-ready")).unwrap();
            let unavailable = fixture
                .invoke("detect_engine", serde_json::json!({}))
                .unwrap();
            assert_eq!(unavailable["responding"], false);
            assert!(unavailable["address"].is_null());
            assert_eq!(unavailable["engine"], "docker");
            assert!(unavailable["detail"]
                .as_str()
                .unwrap()
                .contains("not answering"));
            if host_error {
                std::fs::create_dir_all(fixture.a.join(".logs")).unwrap();
                std::fs::write(stack::host_pids_path(&fixture.a), "invalid ownership json")
                    .unwrap();
            }
            let before_cleanup = fixture.commands();
            let shell = fixture.app.state::<Shell>();
            let generation = shell
                .start_generation
                .load(std::sync::atomic::Ordering::SeqCst);
            let failures = if quit {
                fixture.quit_failures()
            } else {
                fixture
                    .stop()
                    .err()
                    .map(|error| error.as_str().unwrap().to_owned())
                    .into_iter()
                    .collect()
            };
            let cleanup_commands = fixture
                .commands()
                .strip_prefix(&before_cleanup)
                .unwrap()
                .to_owned();
            let retained = shell.containers.lock().unwrap().is_some();
            let still_live = fixture.a.join("fixture-containers-running").exists();
            println!(
                "ENGINE_UNAVAILABLE_PROOF={}",
                serde_json::json!({
                    "quit":quit,"hostError":host_error,"partialUp":partial_up,"owner":owner,
                    "unavailable":unavailable,"failures":failures,"retained":retained,
                    "stillLive":still_live,"cleanupCommands":cleanup_commands,
                })
            );
            assert!(
                still_live,
                "fixture must model containers surviving the unavailable API"
            );
            let diagnostic = failures.join("\n");
            assert!(
                diagnostic.contains("Compose down failed:"),
                "unavailable owned runtime was reported stopped: {diagnostic:?}"
            );
            // Namespace resolution reports the failed command/status without echoing potentially
            // private Compose output. That failure must survive the shutdown boundary.
            assert!(
                diagnostic.contains("Compose configuration failed (exit status: 74)"),
                "{diagnostic}"
            );
            assert!(retained, "unresolved cleanup must retain run ownership");
            assert!(cleanup_commands.contains("compose -f docker-compose.yml config"));
            assert!(
                !cleanup_commands.contains("version --format"),
                "cleanup must use retained runtime, not rediscover"
            );
            assert!(
                shell
                    .start_generation
                    .load(std::sync::atomic::Ordering::SeqCst)
                    > generation
            );
            if host_error {
                assert!(
                    diagnostic.contains("host-pids.json"),
                    "host cleanup error missing: {diagnostic}"
                );
                assert_eq!(
                    std::fs::read_to_string(stack::host_pids_path(&fixture.a)).unwrap(),
                    "invalid ownership json"
                );
                std::fs::remove_file(stack::host_pids_path(&fixture.a)).unwrap();
            }

            // Recover access and prove that the same run is cleaned, including supervisor stop.
            std::fs::write(fixture.base.join("docker-ready"), "").unwrap();
            fixture.stop().unwrap();
            fixture.assert_stopped();
            assert!(shell.containers.lock().unwrap().is_none());
            let trace = std::fs::read_to_string(fixture.base.join("affinity.log")).unwrap();
            assert!(trace.contains("stop supervisor"));
            for line in trace.lines().filter(|line| line.contains("compose")) {
                assert!(
                    line.starts_with(&format!("{owner}\t")),
                    "runtime changed: {line}"
                );
            }
            let stopped_commands = fixture.commands();
            fixture.stop().unwrap();
            assert_eq!(
                fixture.commands(),
                stopped_commands,
                "repeated Stop must be harmless"
            );
            println!(
                "ENGINE_UNAVAILABLE_RECOVERED={}",
                serde_json::json!({
                    "quit":quit,"hostError":host_error,"partialUp":partial_up,
                    "owner":owner,"stillLive":false,"retained":false,"trace":trace,
                })
            );
        }

        #[test]
        fn engine_unavailable_stop_retains_run_until_retry() {
            if crate::test_support::isolated_process(
                "tests::container_root::engine_unavailable_stop_retains_run_until_retry",
            ) {
                return;
            }
            engine_unavailable(false, false, false);
        }

        #[test]
        fn engine_unavailable_quit_reports_unresolved_run() {
            if crate::test_support::isolated_process(
                "tests::container_root::engine_unavailable_quit_reports_unresolved_run",
            ) {
                return;
            }
            engine_unavailable(true, false, false);
        }

        #[test]
        fn engine_unavailable_stop_preserves_host_cleanup_error() {
            if crate::test_support::isolated_process(
                "tests::container_root::engine_unavailable_stop_preserves_host_cleanup_error",
            ) {
                return;
            }
            engine_unavailable(false, true, false);
        }

        #[test]
        fn engine_unavailable_partial_up_retains_cleanup() {
            if crate::test_support::isolated_process(
                "tests::container_root::engine_unavailable_partial_up_retains_cleanup",
            ) {
                return;
            }
            engine_unavailable(false, false, true);
        }

        #[test]
        fn engine_unavailable_without_deployment_needs_no_cleanup() {
            if crate::test_support::isolated_process(
                "tests::container_root::engine_unavailable_without_deployment_needs_no_cleanup",
            ) {
                return;
            }
            let fixture = Fixture::new();
            std::fs::remove_file(fixture.base.join("docker-ready")).unwrap();
            fixture.stop().unwrap();
            fixture.quit();
            assert!(
                fixture.commands().is_empty(),
                "an empty deployment needs no engine access"
            );
            assert!(fixture
                .app
                .state::<Shell>()
                .containers
                .lock()
                .unwrap()
                .is_none());
        }

        #[test]
        fn local_podman_fixture_serves_api_on_its_private_runtime_socket() {
            if crate::test_support::isolated_process("tests::container_root::local_podman_fixture_serves_api_on_its_private_runtime_socket") { return; }
            use std::io::{Read, Write};
            let fixture = Fixture::new();
            let socket = fixture.base.join("runtime/podman/podman.sock");
            std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
            let mut service = engine::Address::new(engine::Engine::Podman, None)
                .command()
                .args(["--remote=false", "system", "service", "--time=0"])
                .arg(format!("unix://{}", socket.display()))
                .spawn()
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            let response = loop {
                match std::os::unix::net::UnixStream::connect(&socket) {
                    Ok(mut stream) => {
                        stream
                            .set_read_timeout(Some(std::time::Duration::from_secs(1)))
                            .unwrap();
                        stream.write_all(b"GET /_ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();
                        let mut response = String::new();
                        let read = stream.read_to_string(&mut response);
                        break read.map(|_| response);
                    }
                    Err(error) if std::time::Instant::now() >= deadline => break Err(error),
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(10)),
                }
            };
            service.kill().unwrap();
            service.wait().unwrap();
            assert!(response.unwrap().starts_with("HTTP/1.1 200 OK\r\n"));
            assert_eq!(
                std::env::var_os("XDG_RUNTIME_DIR").unwrap(),
                fixture.base.join("runtime")
            );
        }

        #[test]
        fn local_podman_fixture_keeps_linux_selector_independent_of_remote_defaults() {
            if crate::test_support::isolated_process("tests::container_root::local_podman_fixture_keeps_linux_selector_independent_of_remote_defaults") { return; }
            let fixture = Fixture::new();
            std::fs::write(fixture.base.join("podman-ready"), "").unwrap();
            // Exercise Linux's actual pinned argv on every Unix test host. macOS normally
            // selects a named remote connection and would never cover this fixture boundary.
            let run = |root: &Path, args: &[&str]| {
                let output = engine::Address::new(engine::Engine::Podman, None)
                    .command()
                    .args(args)
                    .current_dir(root)
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{args:?}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                output
            };
            let version = run(&fixture.a, &["--remote=false", "compose", "version"]);
            assert_eq!(version.stdout, b"Synthetic Compose\n");
            run(&fixture.a, &["--remote=false", "compose", "up", "-d"]);
            assert_eq!(
                std::fs::read_to_string(fixture.a.join("fixture-containers-running")).unwrap(),
                "podman:local"
            );

            std::fs::write(fixture.base.join("podman-connection"), "remote-beta").unwrap();
            std::env::set_var("CONTAINER_CONNECTION", "ambient-remote");
            run(
                &fixture.b,
                &["--connection", "explicit-remote", "compose", "up", "-d"],
            );
            run(
                &fixture.a,
                &[
                    "--remote=false",
                    "compose",
                    "-f",
                    "docker-compose.yml",
                    "--profile",
                    "harness",
                    "down",
                ],
            );

            assert!(!fixture.a.join("fixture-containers-running").exists());
            assert_eq!(
                std::fs::read_to_string(fixture.b.join("fixture-containers-running")).unwrap(),
                "podman:explicit-remote"
            );
            let trace = std::fs::read_to_string(fixture.base.join("affinity.log")).unwrap();
            assert!(
                trace
                    .lines()
                    .filter(|line| line.contains("--remote=false"))
                    .all(|line| line.starts_with("podman:local\t")),
                "{trace}"
            );
        }

        fn runtime_affinity(case: &str) {
            let fixture = Fixture::new();
            let podman = case.starts_with("podman");
            if podman {
                std::fs::remove_file(fixture.base.join("docker-ready")).unwrap();
                std::fs::write(fixture.base.join("podman-ready"), "").unwrap();
            }
            if case.contains("named") {
                std::env::set_var("CONTAINER_CONNECTION", "named-owned");
            }
            if case.contains("host") {
                std::env::set_var("DOCKER_HOST", "unix:///owned-alpha.sock");
            }
            if case.contains("default") {
                std::fs::write(fixture.base.join("docker-context"), "default").unwrap();
            }
            if case.contains("partial") {
                std::fs::write(fixture.a.join("fail-up"), "").unwrap();
            }
            fixture.start(&fixture.a, false);
            let owner =
                std::fs::read_to_string(fixture.a.join("fixture-containers-running")).unwrap();
            std::fs::write(fixture.base.join("docker-ready"), "").unwrap();
            std::fs::write(fixture.base.join("docker-context"), "beta").unwrap();
            std::fs::write(fixture.base.join("podman-connection"), "beta").unwrap();
            if case.contains("host") {
                std::env::set_var("DOCKER_HOST", "unix:///unrelated-beta.sock");
            }
            if case.contains("named") {
                std::env::set_var("CONTAINER_CONNECTION", "unrelated-named");
            }
            if case.contains("default") {
                std::env::set_var("DOCKER_HOST", "unix:///unrelated-beta.sock");
            }
            if case.contains("retry") {
                std::fs::write(fixture.a.join("fail-down"), "").unwrap();
                assert!(fixture.stop().is_err());
                assert!(fixture.a.join("fixture-containers-running").exists());
                std::fs::remove_file(fixture.a.join("fail-down")).unwrap();
                fixture.start(&fixture.a, false);
                assert_eq!(
                    std::fs::read_to_string(fixture.a.join("fixture-containers-running")).unwrap(),
                    owner
                );
            }
            if case.ends_with("quit") {
                fixture.quit();
            } else {
                fixture.stop().unwrap();
            }
            let trace = std::fs::read_to_string(fixture.base.join("affinity.log")).unwrap();
            println!(
                "AFFINITY_PROOF={}",
                serde_json::json!({"case":case,"owner":owner,"trace":trace,"originalStillLive":fixture.a.join("fixture-containers-running").exists()})
            );
            assert!(
                !fixture.a.join("fixture-containers-running").exists(),
                "original runtime still owns containers"
            );
            for line in trace
                .lines()
                .filter(|line| line.contains(" down") || line.contains("stop supervisor"))
            {
                assert!(
                    line.starts_with(&format!("{owner}\t")),
                    "destructive command addressed unrelated runtime: {line}"
                );
            }
            assert!(fixture
                .app
                .state::<Shell>()
                .containers
                .lock()
                .unwrap()
                .is_none());
        }

        #[test]
        fn runtime_affinity_podman_stop() {
            if crate::test_support::isolated_process(
                "tests::container_root::runtime_affinity_podman_stop",
            ) {
                return;
            }
            runtime_affinity("podman_stop");
        }

        #[test]
        fn runtime_affinity_podman_quit() {
            if crate::test_support::isolated_process(
                "tests::container_root::runtime_affinity_podman_quit",
            ) {
                return;
            }
            runtime_affinity("podman_quit");
        }

        #[test]
        fn runtime_affinity_docker_context_stop() {
            if crate::test_support::isolated_process(
                "tests::container_root::runtime_affinity_docker_context_stop",
            ) {
                return;
            }
            runtime_affinity("docker_context_stop");
        }

        #[test]
        fn runtime_affinity_docker_context_quit() {
            if crate::test_support::isolated_process(
                "tests::container_root::runtime_affinity_docker_context_quit",
            ) {
                return;
            }
            runtime_affinity("docker_context_quit");
        }

        #[test]
        fn runtime_affinity_podman_named_stop() {
            if crate::test_support::isolated_process(
                "tests::container_root::runtime_affinity_podman_named_stop",
            ) {
                return;
            }
            runtime_affinity("podman_named_stop");
        }

        #[test]
        fn runtime_affinity_docker_host_stop() {
            if crate::test_support::isolated_process(
                "tests::container_root::runtime_affinity_docker_host_stop",
            ) {
                return;
            }
            runtime_affinity("docker_host_stop");
        }

        #[test]
        fn runtime_affinity_podman_partial_stop() {
            if crate::test_support::isolated_process(
                "tests::container_root::runtime_affinity_podman_partial_stop",
            ) {
                return;
            }
            runtime_affinity("podman_partial_stop");
        }

        #[test]
        fn runtime_affinity_podman_retry_stop() {
            if crate::test_support::isolated_process(
                "tests::container_root::runtime_affinity_podman_retry_stop",
            ) {
                return;
            }
            runtime_affinity("podman_retry_stop");
        }

        #[test]
        fn runtime_affinity_docker_default_stop() {
            if crate::test_support::isolated_process(
                "tests::container_root::runtime_affinity_docker_default_stop",
            ) {
                return;
            }
            runtime_affinity("docker_default_stop");
        }

        #[test]
        fn quit_after_only_viewing_setup_does_not_report_unowned_containers() {
            if crate::test_support::isolated_process(
                "tests::container_root::quit_after_only_viewing_setup_does_not_report_unowned_containers",
            ) {
                return;
            }
            let fixture = Fixture::new();
            remember_selected_root(&fixture.app.state::<Shell>(), &fixture.a);
            assert!(fixture.a.join("docker-compose.yml").exists());
            fixture.quit();
            assert!(
                fixture.commands().is_empty(),
                "viewing setup must not stop another runtime"
            );
        }

        #[test]
        fn runtime_affinity_unknown_legacy_and_repeated_cleanup() {
            if crate::test_support::isolated_process(
                "tests::container_root::runtime_affinity_unknown_legacy_and_repeated_cleanup",
            ) {
                return;
            }
            let fixture = Fixture::new();
            remember_selected_root(&fixture.app.state::<Shell>(), &fixture.a);
            assert!(fixture
                .stop()
                .unwrap_err()
                .as_str()
                .unwrap()
                .contains("no runtime ownership"));
            assert!(fixture.commands().is_empty());
            fixture.start(&fixture.a, false);
            fixture.stop().unwrap();
            let commands = fixture.commands();
            fixture.stop().unwrap();
            fixture.quit();
            assert_eq!(
                fixture.commands(),
                commands,
                "verified down needs no further engine selection"
            );
        }

        #[test]
        fn runtime_affinity_unavailable_owner_retains_retry_without_fallback() {
            if crate::test_support::isolated_process("tests::container_root::runtime_affinity_unavailable_owner_retains_retry_without_fallback") { return; }
            let fixture = Fixture::new();
            std::fs::remove_file(fixture.base.join("docker-ready")).unwrap();
            std::fs::write(fixture.base.join("podman-ready"), "").unwrap();
            fixture.start(&fixture.a, false);
            std::fs::remove_file(fixture.base.join("podman-ready")).unwrap();
            std::fs::write(fixture.base.join("docker-ready"), "").unwrap();
            let error = fixture.stop().unwrap_err();
            assert!(
                error
                    .as_str()
                    .unwrap()
                    .contains("Compose configuration failed"),
                "{error}"
            );
            assert!(fixture
                .app
                .state::<Shell>()
                .containers
                .lock()
                .unwrap()
                .is_some());
            assert!(fixture.a.join("fixture-containers-running").exists());
            let trace = std::fs::read_to_string(fixture.base.join("affinity.log")).unwrap();
            assert!(!trace
                .lines()
                .any(|line| line.starts_with("docker:") && line.contains("compose")));
            std::fs::write(fixture.base.join("podman-ready"), "").unwrap();
            fixture.stop().unwrap();
            fixture.assert_stopped();
        }

        fn failed_retry(quit: bool, partial_up: bool) {
            let fixture = Fixture::new();
            if partial_up {
                std::fs::write(fixture.a.join("fail-up"), "").unwrap();
            }
            let problem = fixture.start(&fixture.a, false);
            assert!(
                problem["detail"].as_str().unwrap().contains(if partial_up {
                    "synthetic partial up failure"
                } else {
                    "synthetic migration barrier"
                }),
                "{problem}"
            );
            assert!(fixture.a.join("fixture-containers-running").exists());
            let ready = engine::detect();
            assert!(ready.responding);
            assert!(ready.address.unwrap().composes());
            let retry = fixture.start(&fixture.b, true);
            assert!(retry["said"].is_string());
            assert!(!fixture.b.join("docker-compose.yml").exists());
            if quit {
                fixture.quit();
            } else {
                fixture.stop().unwrap();
            }
            fixture.assert_stopped();
        }

        #[test]
        fn stop_retains_a_after_b_preflight_refusal() {
            if crate::test_support::isolated_process(
                "tests::container_root::stop_retains_a_after_b_preflight_refusal",
            ) {
                return;
            }
            failed_retry(false, false);
        }

        #[test]
        fn quit_retains_a_after_b_preflight_refusal() {
            if crate::test_support::isolated_process(
                "tests::container_root::quit_retains_a_after_b_preflight_refusal",
            ) {
                return;
            }
            failed_retry(true, false);
        }

        #[test]
        fn partial_up_retains_a_for_stop() {
            if crate::test_support::isolated_process(
                "tests::container_root::partial_up_retains_a_for_stop",
            ) {
                return;
            }
            failed_retry(false, true);
        }

        #[test]
        fn same_root_retry_reuses_a_and_failed_down_remains_retryable() {
            if crate::test_support::isolated_process(
                "tests::container_root::same_root_retry_reuses_a_and_failed_down_remains_retryable",
            ) {
                return;
            }
            let fixture = Fixture::new();
            for _ in 0..2 {
                assert!(fixture.start(&fixture.a, false)["detail"]
                    .as_str()
                    .unwrap()
                    .contains("synthetic migration barrier"));
            }
            assert_eq!(
                fixture
                    .commands()
                    .lines()
                    .filter(|line| line.contains("\tcompose up "))
                    .count(),
                2
            );
            std::fs::write(fixture.a.join("fail-down"), "").unwrap();
            assert!(fixture
                .stop()
                .unwrap_err()
                .as_str()
                .unwrap()
                .contains("synthetic down refusal"));
            fixture.start(&fixture.b, true);
            std::fs::remove_file(fixture.a.join("fail-down")).unwrap();
            fixture.stop().unwrap();
            fixture.assert_stopped();
        }

        #[test]
        fn successful_down_releases_a_for_a_new_deployment() {
            if crate::test_support::isolated_process(
                "tests::container_root::successful_down_releases_a_for_a_new_deployment",
            ) {
                return;
            }
            let fixture = Fixture::new();
            fixture.start(&fixture.a, false);
            fixture.stop().unwrap();
            write_installed_deployment(&fixture.b);
            let problem = fixture.start(&fixture.b, false);
            assert!(problem["detail"]
                .as_str()
                .unwrap()
                .contains("synthetic migration barrier"));
            fixture.stop().unwrap();
            for root in [&fixture.a, &fixture.b] {
                assert_compose_down_ran_under(&fixture.base.join("commands.log"), root);
                assert!(!root.join("fixture-containers-running").exists());
            }
        }

        #[test]
        fn uninstalled_b_control_does_not_issue_compose_cleanup() {
            if crate::test_support::isolated_process(
                "tests::container_root::uninstalled_b_control_does_not_issue_compose_cleanup",
            ) {
                return;
            }
            let fixture = Fixture::new();
            let problem = fixture.start(&fixture.b, true);
            assert!(problem["said"]
                .as_str()
                .unwrap()
                .contains("saved OpenAI API key"));
            fixture.stop().unwrap();
            assert!(!fixture.commands().contains("compose"));
        }

        #[test]
        fn rejected_concurrent_start_does_not_change_selected_root() {
            if crate::test_support::isolated_process(
                "tests::container_root::rejected_concurrent_start_does_not_change_selected_root",
            ) {
                return;
            }
            let fixture = Fixture::new();
            let shell = fixture.app.state::<Shell>();
            remember_selected_root(&shell, &fixture.a);
            let _attempt = StartAttempt::begin(&shell).unwrap();
            assert!(fixture.start(&fixture.b, true)["said"]
                .as_str()
                .unwrap()
                .contains("already starting"));
            assert_eq!(
                shell.selected_root.lock().unwrap().as_ref(),
                Some(&fixture.a)
            );
            assert!(fixture.commands().is_empty());
        }
    }

    fn harness_start_ipc_case(case: &str) {
        struct Cleanup(Vec<PathBuf>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                for path in &self.0 {
                    std::fs::remove_dir_all(path).expect("remove owned IPC fixture");
                }
            }
        }
        let root = temp_root("openbot-harness-start-ipc");
        write_installed_deployment(&root);
        let mut images: deployment::Images =
            serde_json::from_str(&std::fs::read_to_string(deployment::images_path(&root)).unwrap())
                .unwrap();
        for name in ["agent-langgraph-agui", "agent-claude-sdk"] {
            images.images.insert(
                name.into(),
                deployment::Image {
                    reference: format!("localhost/{name}@sha256:00"),
                },
            );
        }
        std::fs::write(
            deployment::images_path(&root),
            serde_json::to_string(&images).unwrap(),
        )
        .unwrap();
        let _path = SerializedPath::set_only_with("docker", "harness");
        let _cleanup = Cleanup(vec![root.clone(), _path.bin().to_path_buf()]);
        let record = root.join("commands.log");
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        // Reserve only an owned ephemeral loopback endpoint; no service thread until Start returns.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let remote = format!("http://{}/ag-ui", listener.local_addr().unwrap());
        let mut model = serde_json::json!({
            "provider":"openai", "login":"api-key", "apiKey":"synthetic-provider-key"
        });
        let mut choice = serde_json::json!({"id":"byo-url", "agentUrl":remote});
        let (expected_up, expected_image) = match case {
            "remote" | "remote-stale-image" => (
                "compose up -d --no-build --pull never postgres supervisor agent-computer agent-bot agent-langgraph",
                None,
            ),
            "anthropic-api" => {
                model = serde_json::json!({"provider":"anthropic", "login":"api-key", "apiKey":"synthetic-anthropic-key"});
                choice = serde_json::json!({"id":"langgraph"});
                ("compose --profile harness up -d --no-build --pull never postgres supervisor agent-computer agent-langgraph agent-harness", Some("agent-langgraph-agui"))
            }
            "compatible" => {
                model = serde_json::json!({"provider":"openai-compatible", "login":"endpoint", "baseUrl":"http://127.0.0.1:11434/v1", "model":"synthetic-model", "apiKey":""});
                ("compose up -d --no-build --pull never postgres supervisor agent-computer agent-bot agent-langgraph", None)
            }
            "installed" => {
                choice = serde_json::json!({"id":"langgraph"});
                ("compose --profile harness up -d --no-build --pull never postgres supervisor agent-computer agent-bot agent-langgraph agent-harness", Some("agent-langgraph-agui"))
            }
            "none" => {
                choice = serde_json::Value::Null;
                ("compose up -d --no-build --pull never postgres supervisor agent-computer agent-bot agent-langgraph", None)
            }
            "chatgpt-plan" => {
                model = serde_json::json!({"provider":"openai", "login":"plan", "token":"{\"refresh_token\":\"synthetic-plan\"}"});
                ("compose --profile harness up -d --no-build --pull never postgres supervisor agent-computer agent-harness", Some("agent-langgraph-agui"))
            }
            "claude-plan" => {
                model = serde_json::json!({"provider":"anthropic", "login":"plan", "token":"synthetic-claude-plan"});
                ("compose --profile harness up -d --no-build --pull never postgres supervisor agent-computer agent-harness", Some("agent-claude-sdk"))
            }
            _ => panic!("unknown test case"),
        };
        if case.ends_with("-plan") {
            std::fs::write(
                root.join(".env"),
                "MANAGED_AGENT_AG_UI_URL=http://127.0.0.1:4201/ag-ui\n",
            )
            .unwrap();
        }
        if case == "remote-stale-image" {
            std::fs::write(
                root.join(".env"),
                "PICKED_HARNESS_IMAGE=localhost/old-image@sha256:00\nPICKED_HARNESS_PORT=4206\n",
            )
            .unwrap();
        }
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .invoke_handler(tauri::generate_handler![start_stack, ask_the_bot])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let invoke = |command: &str, body: serde_json::Value| {
            tauri::test::get_ipc_response(
                &window,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: if cfg!(any(windows, target_os = "android")) {
                        "http://tauri.localhost"
                    } else {
                        "tauri://localhost"
                    }
                    .parse()
                    .unwrap(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
            .map(|body| body.deserialize::<serde_json::Value>().unwrap())
        };
        let prepared_choice: Option<harness::HarnessChoice> =
            serde_json::from_value(choice.clone()).unwrap();
        preparation::record(
            &root,
            prepared_choice.as_ref(),
            vec!["fixture-image".into()],
        )
        .unwrap();
        let problem = invoke("start_stack", serde_json::json!({
            "root":root, "apiUrl":"https://intelligence.example.test", "gatewayWsUrl":"wss://gateway.example.test",
            "apiKey":"synthetic-intelligence-key", "model":model, "harness":choice,
        })).expect_err("intentional migration barrier prevents host/DB startup");
        let commands = std::fs::read_to_string(&record).unwrap_or_default();
        assert!(
            problem["detail"]
                .as_str()
                .unwrap_or_default()
                .contains("synthetic migration barrier"),
            "{problem:?} {commands}"
        );
        let up: Vec<_> = commands
            .lines()
            .filter_map(|line| {
                let (_, command) = line.split_once('\t')?;
                command.contains(" up -d ").then_some(command)
            })
            .collect();
        assert_eq!(
            up,
            vec![expected_up],
            "case={case}, actual Start IPC commands:\n{commands}"
        );
        assert!(commands.contains("\tcompose run --rm --pull never migrate\n"));
        assert!(!root.join(".logs").exists(), "no host runtime was launched");
        let settings = openbot_env::read_already_set(
            &root.join(".env"),
            &[
                "TENANT_PACKAGE_DIR",
                "MANAGED_AGENT_AG_UI_URL",
                "PICKED_HARNESS_NAME",
                "PICKED_HARNESS_URL",
                "PICKED_HARNESS_KIND",
                "PICKED_HARNESS_IMAGE",
            ],
        )
        .unwrap();
        assert_eq!(
            settings.get("TENANT_PACKAGE_DIR").map(String::as_str),
            Some("../examples/fintech")
        );
        let bundled_url = settings
            .get("MANAGED_AGENT_AG_UI_URL")
            .map(String::as_str)
            .unwrap_or("");
        assert_eq!(
            bundled_url.is_empty(),
            !expected_up
                .split_whitespace()
                .any(|service| service == "agent-langgraph"),
            "case={case}, persisted advertisement must match actual Start services"
        );
        let mut asked = false;
        if case.starts_with("remote") || case == "compatible" {
            assert_eq!(settings.get("PICKED_HARNESS_URL"), Some(&remote));
            assert_eq!(
                settings.get("PICKED_HARNESS_KIND").map(String::as_str),
                Some("remote-ag-ui")
            );
            let server = TestServer::from_listener(listener,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
                 data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m1\",\"delta\":\"D53-BYO-REMOTE-ANSWER\"}\n\n\
                 data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n");
            let answer = invoke(
                "ask_the_bot",
                serde_json::json!({"root":root,"question":"D53 remote IPC question"}),
            )
            .unwrap();
            let request = server.request();
            assert_eq!(answer, "D53-BYO-REMOTE-ANSWER");
            assert_eq!(request.path, "/ag-ui");
            assert!(request.body.contains("D53 remote IPC question"));
            assert!(request
                .headers
                .iter()
                .any(|line| line.starts_with("x-openbot-agent-token: ")));
            asked = true;
        } else if let Some(image) = expected_image {
            assert_eq!(
                settings.get("PICKED_HARNESS_IMAGE"),
                Some(&format!("localhost/{image}@sha256:00"))
            );
            assert_ne!(settings.get("PICKED_HARNESS_URL"), Some(&remote));
        } else {
            assert!(!settings.contains_key("PICKED_HARNESS_URL"));
        }
        println!(
            "D53_START_IPC={}",
            serde_json::json!({
                "case":case, "composeUp":up, "commands":commands, "intentionalMigrationBarrier":true,
                "publicSettings":settings,
                "defaultPackage":"../examples/fintech", "remoteEndpointPersistedAndConsumed":asked,
                "actualAskIpcResponse":asked.then_some("D53-BYO-REMOTE-ANSWER"),
                "noHostStartup":true, "nativeGui":false, "realEngineOrDatabase":false,
            })
        );
    }

    #[test]
    fn remote_harness_start_ipc_skips_local_service_and_asks_persisted_endpoint() {
        if crate::test_support::isolated_process(
            "tests::remote_harness_start_ipc_skips_local_service_and_asks_persisted_endpoint",
        ) {
            return;
        }
        harness_start_ipc_case("remote");
    }

    #[test]
    fn remote_harness_start_ipc_ignores_stale_local_image() {
        if crate::test_support::isolated_process(
            "tests::remote_harness_start_ipc_ignores_stale_local_image",
        ) {
            return;
        }
        harness_start_ipc_case("remote-stale-image");
    }

    #[test]
    fn installed_harness_start_ipc_keeps_local_service() {
        if crate::test_support::isolated_process(
            "tests::installed_harness_start_ipc_keeps_local_service",
        ) {
            return;
        }
        harness_start_ipc_case("installed");
    }

    #[test]
    fn no_harness_start_ipc_keeps_only_core_and_eligible_bundled_services() {
        if crate::test_support::isolated_process(
            "tests::no_harness_start_ipc_keeps_only_core_and_eligible_bundled_services",
        ) {
            return;
        }
        harness_start_ipc_case("none");
    }

    #[test]
    fn chatgpt_plan_harness_start_ipc_overrides_remote_choice() {
        if crate::test_support::isolated_process(
            "tests::chatgpt_plan_harness_start_ipc_overrides_remote_choice",
        ) {
            return;
        }
        harness_start_ipc_case("chatgpt-plan");
    }

    #[test]
    fn claude_plan_harness_start_ipc_overrides_remote_choice() {
        if crate::test_support::isolated_process(
            "tests::claude_plan_harness_start_ipc_overrides_remote_choice",
        ) {
            return;
        }
        harness_start_ipc_case("claude-plan");
    }

    #[test]
    fn anthropic_api_harness_start_ipc_advertises_eligible_bundled_agent() {
        if crate::test_support::isolated_process(
            "tests::anthropic_api_harness_start_ipc_advertises_eligible_bundled_agent",
        ) {
            return;
        }
        harness_start_ipc_case("anthropic-api");
    }

    #[test]
    fn compatible_harness_start_ipc_advertises_eligible_bundled_agent() {
        if crate::test_support::isolated_process(
            "tests::compatible_harness_start_ipc_advertises_eligible_bundled_agent",
        ) {
            return;
        }
        harness_start_ipc_case("compatible");
    }

    #[test]
    fn start_fails_when_required_compose_service_exited_before_host_startup() {
        if crate::test_support::isolated_process(
            "tests::start_fails_when_required_compose_service_exited_before_host_startup",
        ) {
            return;
        }
        let root = temp_root("openbot-dead-compose-start");
        write_installed_deployment(&root);
        let record = temp_root("openbot-dead-compose-record").join("commands.log");
        std::fs::create_dir_all(record.parent().expect("record parent")).unwrap();
        let _path = SerializedPath::set_only_with("docker", "dead-service");
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();

        let problem = tauri::async_runtime::block_on(start_stack_inner(
            app.handle().clone(),
            root.clone(),
            "https://intelligence.example.test".into(),
            "wss://gateway.example.test".into(),
            "synthetic-intelligence-key".into(),
            ChosenModel {
                provider: "openai".into(),
                login: "api-key".into(),
                api_key: Some("synthetic-openai-key".into()),
                base_url: None,
                container_base_url: None,
                model: None,
                token: None,
                saved: Some(false),
            },
            None,
            None,
        ))
        .expect_err("a dead required Compose service must fail Start");

        let commands = std::fs::read_to_string(&record).expect("command record");
        assert_eq!(
            problem.said, "Part of OpenBot stopped during startup.",
            "problem={problem:?} commands={commands}"
        );
        assert_eq!(
            problem.detail.as_deref(),
            Some("agent-computer stopped: agent-computer died after boot")
        );
        println!("SLOT1B dead Compose Start proof:\nproblem={problem:?}\ncommands={commands}");
        assert!(
            commands.contains("\tversion --format {{.Server.APIVersion}}\n"),
            "{commands}"
        );
        assert!(commands.contains("\tcompose version\n"), "{commands}");
        assert!(commands.contains("\tcompose up -d --no-build --pull never postgres supervisor agent-computer agent-bot agent-langgraph\n"), "{commands}");
        assert!(
            commands.contains("\tcompose run --rm --pull never migrate\n"),
            "{commands}"
        );
        assert!(
            commands.contains("\tcompose ps -a --format {{.Service}}\t{{.State}}\n"),
            "{commands}"
        );
        assert!(
            commands.contains("\tcompose logs --tail 3 agent-computer\n"),
            "{commands}"
        );
        assert!(
            !root.join(".logs/server.log").exists(),
            "host processes must not spawn after dead service"
        );
        assert!(
            !root.join("node_modules").exists(),
            "dependency install must not run after dead service"
        );
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(record.parent().expect("record parent"));
    }

    #[test]
    fn anthropic_start_does_not_raise_openai_only_agent_bot_or_fail_on_its_stale_exit() {
        if crate::test_support::isolated_process(
            "tests::anthropic_start_does_not_raise_openai_only_agent_bot_or_fail_on_its_stale_exit",
        ) {
            return;
        }
        let root = temp_root("openbot-anthropic-bot-selection-start");
        write_installed_deployment(&root);
        let record = temp_root("openbot-anthropic-bot-selection-record").join("commands.log");
        std::fs::create_dir_all(record.parent().expect("record parent")).unwrap();
        let _path = SerializedPath::set_only_with("docker", "anthropic");
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();

        let problem = tauri::async_runtime::block_on(start_stack_inner(
            app.handle().clone(),
            root.clone(),
            "https://intelligence.example.test".into(),
            "wss://gateway.example.test".into(),
            "synthetic-intelligence-key".into(),
            ChosenModel {
                provider: "anthropic".into(),
                login: "api-key".into(),
                api_key: Some("synthetic-anthropic-key".into()),
                base_url: None,
                container_base_url: None,
                model: None,
                token: None,
                saved: Some(false),
            },
            None,
            None,
        ))
        .expect_err("dead selected LangGraph service must fail Start");

        let commands = std::fs::read_to_string(&record).expect("command record");
        assert!(
            commands.contains(
                "\tcompose up -d --no-build --pull never postgres supervisor agent-computer agent-langgraph\n"
            ),
            "{commands}"
        );
        assert!(
            !commands
                .contains("compose up -d --no-build --pull never postgres supervisor agent-computer agent-bot"),
            "Anthropic Start must not target the OpenAI-only agent-bot: {commands}"
        );
        assert_eq!(problem.said, "Part of OpenBot stopped during startup.");
        let detail = problem.detail.as_deref().unwrap_or_default();
        assert!(
            detail.contains("agent-langgraph stopped: langgraph died after boot"),
            "{detail}"
        );
        assert!(
            !detail.contains("agent-bot"),
            "stale, unrequested agent-bot exit must not fail this Anthropic Start: {detail}"
        );
        assert!(
            !commands.contains("\tcompose logs --tail 3 agent-bot\n"),
            "stale unrequested agent-bot should not get reported: {commands}"
        );
        assert!(
            commands.contains("\tcompose logs --tail 3 agent-langgraph\n"),
            "selected dead LangGraph service should get reported: {commands}"
        );
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(record.parent().expect("record parent"));
    }

    #[test]
    fn ask_the_bot_uses_native_mastra_for_a_picked_mastra_harness() {
        let server = TestServer::new(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
             data: {\"type\":\"text-delta\",\"payload\":{\"text\":\"391\"}}\n\n\
             data: {\"type\":\"finish\",\"payload\":{\"stepResult\":{\"reason\":\"stop\"}}}\n\n",
        );
        let root = temp_root("openbot-mastra-ask");
        let answer = tauri::async_runtime::block_on(ask_the_bot_with_settings(
            root.clone(),
            "What is 17 times 23?".to_string(),
            std::collections::BTreeMap::from([
                ("PICKED_HARNESS_URL".to_string(), server.url.clone()),
                (
                    "PICKED_HARNESS_KIND".to_string(),
                    "remote-mastra".to_string(),
                ),
                ("PICKED_HARNESS_AGENT_ID".to_string(), "openbot".to_string()),
                (
                    "MANAGED_AGENT_TOKEN".to_string(),
                    "managed-token".to_string(),
                ),
            ]),
        ))
        .expect("answer");

        let request = server.request();
        assert_eq!(answer, "391");
        assert_eq!(request.path, "/api/agents/openbot/stream");
        assert!(
            request
                .headers
                .iter()
                .any(|line| line == "x-openbot-agent-token: managed-token"),
            "{:?}",
            request.headers
        );
        let body: serde_json::Value = serde_json::from_str(&request.body).expect("json body");
        assert_eq!(
            body.pointer("/messages/0/content").and_then(|v| v.as_str()),
            Some("What is 17 times 23?")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ask_the_bot_uses_the_picked_byo_ag_ui_endpoint_before_managed_fallback() {
        let server = TestServer::new(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
             data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m1\",\"delta\":\"391\"}\n\n\
             data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        );
        let root = temp_root("openbot-byo-ask");
        let answer = tauri::async_runtime::block_on(ask_the_bot_with_settings(
            root.clone(),
            "What is 17 times 23?".to_string(),
            std::collections::BTreeMap::from([
                ("PICKED_HARNESS_URL".to_string(), server.url.clone()),
                (
                    "PICKED_HARNESS_KIND".to_string(),
                    "remote-ag-ui".to_string(),
                ),
                (
                    "MANAGED_AGENT_AG_UI_URL".to_string(),
                    "http://127.0.0.1:9/ag-ui".to_string(),
                ),
                (
                    "MANAGED_AGENT_TOKEN".to_string(),
                    "managed-token".to_string(),
                ),
            ]),
        ))
        .expect("answer");

        let request = server.request();
        assert_eq!(answer, "391");
        assert_eq!(request.path, "/");
        assert!(
            request
                .headers
                .iter()
                .any(|line| line == "x-openbot-agent-token: managed-token"),
            "{:?}",
            request.headers
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ask_the_bot_keeps_body_read_errors_out_of_the_empty_answer_path() {
        let body = "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m1\",\"delta\":\"391";
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len() + 64
        );
        let server = TestServer::new(response);
        let root = temp_root("openbot-body-read-ask");

        let problem = tauri::async_runtime::block_on(ask_the_bot_with_settings(
            root.clone(),
            "What is 17 times 23?".to_string(),
            std::collections::BTreeMap::from([
                ("PICKED_HARNESS_URL".to_string(), server.url.clone()),
                (
                    "PICKED_HARNESS_KIND".to_string(),
                    "remote-ag-ui".to_string(),
                ),
                (
                    "MANAGED_AGENT_TOKEN".to_string(),
                    "managed-token".to_string(),
                ),
            ]),
        ))
        .expect_err("body read errors must propagate as real problems");

        assert!(
            problem
                .said
                .contains("The Bot started answering and then stopped"),
            "{}",
            problem.said
        );
        let detail = problem.detail.as_deref().expect("body read detail");
        assert!(detail.contains("kind remote-ag-ui"), "{detail}");
        assert!(detail.contains(&server.url), "{detail}");
        assert!(detail.contains("HTTP 200 OK"), "{detail}");
        assert!(
            detail.contains("body") || detail.contains("error"),
            "{detail}"
        );
        let _ = server.request();
        let _ = std::fs::remove_dir_all(root);
    }

    /// Exercise the generated command and the settings writer/reader, with real loopback HTTP
    /// and a disposable external Compose executable. No model, engine or native GUI is started.
    #[test]
    fn ask_command_attributes_empty_answers_to_the_selected_endpoint() {
        const TEST: &str = "tests::ask_command_attributes_empty_answers_to_the_selected_endpoint";
        if crate::test_support::isolated_process(TEST) {
            return;
        }
        let path = SerializedPath::set_only_with("docker", "empty-answer");
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![ask_the_bot])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let mut failures = Vec::new();
        for case in [
            "byo",
            "installed-to-byo",
            "legacy",
            "unknown",
            "installed-ag-ui",
            "installed-mastra",
            "managed",
        ] {
            let root = temp_root(&format!("ask-provenance-{case}"));
            std::fs::create_dir_all(&root).unwrap();
            let record = root.join("commands.log");
            std::fs::write(&record, "").unwrap();
            std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
            let server = TestServer::new(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
                 data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n\
                 data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
            );
            let endpoint = format!("{}/ag-ui", server.url);
            let installed = openbot_env::PickedHarness::Installed {
                image: "localhost/synthetic-old-harness@sha256:00".into(),
                port: test_server_port(&server),
                name: "Installed fixture".into(),
                mastra: case == "installed-mastra",
                run_path: "/ag-ui".into(),
                remote_agent_id: "fixture-agent".into(),
            };
            let byo = openbot_env::PickedHarness::RemoteAgUi {
                url: format!("  {endpoint}  "),
                name: "An agent you already run".into(),
                remote_agent_id: String::new(),
            };
            let ports = openbot_env::Ports {
                langgraph: test_server_port(&server),
                ..Default::default()
            };
            let compose = |harness| {
                openbot_env::compose(
                    &openbot_env::Intelligence {
                        api_url: "https://intelligence.example.test".into(),
                        gateway_ws_url: "wss://gateway.example.test".into(),
                        api_key: String::new(),
                    },
                    &openbot_env::Model {
                        credential: openbot_env::ModelCredential::OpenAi {
                            api_key: "synthetic-provider-key".into(),
                        },
                    },
                    &engine::EngineStatus {
                        engine: None,
                        address: None,
                        responding: false,
                        engine_socket: None,
                        detail: String::new(),
                    },
                    &ports,
                    &[],
                    harness,
                    &std::collections::BTreeMap::from([(
                        "MANAGED_AGENT_TOKEN".into(),
                        "synthetic-ask-token".into(),
                    )]),
                )
            };
            let file = root.join(".env");
            let write_settings = |values: &std::collections::BTreeMap<String, String>| {
                openbot_env::write(&file, values, &Default::default()).unwrap();
            };
            if ["installed-to-byo", "legacy", "unknown"].contains(&case) {
                write_settings(&compose(Some(&installed)));
            }
            write_settings(&compose(match case {
                "managed" => None,
                "installed-ag-ui" | "installed-mastra" => Some(&installed),
                _ => Some(&byo),
            }));
            // Simulate older/unknown metadata only after the real installed -> BYO writes. The
            // image/port remain stale, and KIND is the same as an installed AG-UI selection.
            if case == "legacy" {
                let text = std::fs::read_to_string(&file).unwrap();
                std::fs::write(
                    &file,
                    text.lines()
                        .filter(|line| !line.starts_with("PICKED_HARNESS_SOURCE="))
                        .collect::<Vec<_>>()
                        .join("\n"),
                )
                .unwrap();
            } else if case == "unknown" {
                write_settings(&std::collections::BTreeMap::from([(
                    "PICKED_HARNESS_SOURCE".into(),
                    "future-source".into(),
                )]));
            }
            let public_settings = openbot_env::read_already_set(
                &file,
                &[
                    "PICKED_HARNESS_URL",
                    "PICKED_HARNESS_KIND",
                    "PICKED_HARNESS_SOURCE",
                    "PICKED_HARNESS_IMAGE",
                    "PICKED_HARNESS_PORT",
                    "MANAGED_AGENT_AG_UI_URL",
                ],
            )
            .unwrap();
            let result = tauri::test::get_ipc_response(
                &window,
                tauri::webview::InvokeRequest {
                    cmd: "ask_the_bot".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: if cfg!(any(windows, target_os = "android")) {
                        "http://tauri.localhost"
                    } else {
                        "tauri://localhost"
                    }
                    .parse()
                    .unwrap(),
                    body: tauri::ipc::InvokeBody::Json(
                        serde_json::json!({"root":root,"question":"F5499 endpoint provenance question"}),
                    ),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            );
            // Join the HTTP fixture and remove the private root before any result assertion.
            let request = server.request();
            let commands = std::fs::read_to_string(&record).unwrap();
            let problem = result.expect_err("completed stream without text is a Problem");
            let said = problem["said"].as_str().unwrap();
            let detail = problem["detail"].as_str().unwrap_or("");
            let local =
                case.starts_with("installed-") && case != "installed-to-byo" || case == "managed";
            let expected_service = if case == "managed" {
                "agent-langgraph"
            } else {
                "agent-harness"
            };
            let correct = if local {
                said.contains("That key was refused")
                    && detail.contains(expected_service)
                    && commands
                        .lines()
                        .filter(|line| line.contains("compose logs"))
                        .count()
                        == 1
                    && commands.contains(&format!("\tcompose logs --tail 40 {expected_service}\n"))
            } else {
                said.contains("selected endpoint")
                    && detail.contains(&endpoint)
                    && !said.contains("key was refused")
                    && !detail.contains("refused the key")
                    && commands.is_empty()
            };
            let request_correct = request.path
                == if case == "installed-mastra" {
                    "/api/agents/fixture-agent/stream"
                } else {
                    "/ag-ui"
                }
                && request.body.contains("F5499 endpoint provenance question")
                && request
                    .headers
                    .iter()
                    .any(|header| header == "x-openbot-agent-token: synthetic-ask-token");
            std::fs::remove_dir_all(&root).unwrap();
            println!(
                "F5499_ASK_IPC={}",
                serde_json::json!({
                    "case":case, "publicSettings":public_settings, "problem":problem, "commands":commands,
                    "requestPath":request.path, "requestBody":request.body, "syntheticTokenHeaderCorrect":request_correct,
                    "expectedBehavior":correct, "httpThreadJoined":true, "rootRemoved":!root.exists(),
                })
            );
            if !correct || !request_correct {
                failures.push(case);
            }
        }
        std::fs::remove_dir_all(path.bin()).unwrap();
        assert!(
            failures.is_empty(),
            "incorrect endpoint diagnostics: {failures:?}"
        );
    }

    #[test]
    fn ask_the_bot_uses_managed_log_for_managed_fallback_empty_answer() {
        if crate::test_support::isolated_process(
            "tests::ask_the_bot_uses_managed_log_for_managed_fallback_empty_answer",
        ) {
            return;
        }
        let _path = SerializedPath::set_with("docker", "empty-answer");
        let record = temp_root("openbot-managed-empty-answer-record").join("commands.log");
        std::fs::create_dir_all(record.parent().expect("record parent")).unwrap();
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        let server = TestServer::new(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
             data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n\
             data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        );
        let root = temp_root("openbot-managed-empty-answer");
        std::fs::create_dir_all(&root).unwrap();

        let problem = tauri::async_runtime::block_on(ask_the_bot_with_settings(
            root.clone(),
            "What is 17 times 23?".to_string(),
            std::collections::BTreeMap::from([
                ("MANAGED_AGENT_AG_UI_URL".to_string(), server.url.clone()),
                (
                    "MANAGED_AGENT_TOKEN".to_string(),
                    "managed-token".to_string(),
                ),
            ]),
        ))
        .expect_err("empty managed answer must be diagnosed from managed Bot logs");

        let request = server.request();
        assert_eq!(request.path, "/");
        assert!(
            problem.said.contains("That key was refused"),
            "{}",
            problem.said
        );
        let detail = problem.detail.as_deref().expect("managed log detail");
        assert!(
            detail.contains("agent-langgraph refused the key"),
            "{detail}"
        );
        let commands = std::fs::read_to_string(&record).expect("command record");
        assert!(
            commands
                .lines()
                .any(|line| line.ends_with("\tcompose logs --tail 40 agent-langgraph")),
            "{commands}"
        );
        assert!(
            !commands
                .lines()
                .any(|line| line.ends_with("\tcompose logs --tail 40 agent-harness")),
            "{commands}"
        );
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(record.parent().expect("record parent"));
    }

    #[test]
    fn ask_the_bot_keeps_harness_log_for_picked_harness_empty_answer() {
        if crate::test_support::isolated_process(
            "tests::ask_the_bot_keeps_harness_log_for_picked_harness_empty_answer",
        ) {
            return;
        }
        let _path = SerializedPath::set_with("docker", "empty-answer");
        let record = temp_root("openbot-picked-empty-answer-record").join("commands.log");
        std::fs::create_dir_all(record.parent().expect("record parent")).unwrap();
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        let server = TestServer::new(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
             data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n\
             data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        );
        let root = temp_root("openbot-picked-empty-answer");
        std::fs::create_dir_all(&root).unwrap();

        let problem = tauri::async_runtime::block_on(ask_the_bot_with_settings(
            root.clone(),
            "What is 17 times 23?".to_string(),
            std::collections::BTreeMap::from([
                ("PICKED_HARNESS_URL".to_string(), server.url.clone()),
                ("PICKED_HARNESS_SOURCE".to_string(), "installed".to_string()),
                (
                    "PICKED_HARNESS_KIND".to_string(),
                    "remote-ag-ui".to_string(),
                ),
                (
                    "MANAGED_AGENT_AG_UI_URL".to_string(),
                    "http://127.0.0.1:9/ag-ui".to_string(),
                ),
                (
                    "MANAGED_AGENT_TOKEN".to_string(),
                    "managed-token".to_string(),
                ),
            ]),
        ))
        .expect_err("picked harness empty answer must still be diagnosed from harness logs");

        let request = server.request();
        assert_eq!(request.path, "/");
        assert!(
            problem.said.contains("That key was refused"),
            "{}",
            problem.said
        );
        let detail = problem.detail.as_deref().expect("harness log detail");
        assert!(detail.contains("agent-harness refused the key"), "{detail}");
        let commands = std::fs::read_to_string(&record).expect("command record");
        assert!(
            commands
                .lines()
                .any(|line| line.ends_with("\tcompose logs --tail 40 agent-harness")),
            "{commands}"
        );
        assert!(
            !commands
                .lines()
                .any(|line| line.ends_with("\tcompose logs --tail 40 agent-langgraph")),
            "{commands}"
        );
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(record.parent().expect("record parent"));
    }

    fn write_installed_deployment(root: &Path) {
        const DEPLOYMENT_VERSION: &str = "v0.0.8";
        std::fs::create_dir_all(root.join("server")).unwrap();
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::create_dir_all(root.join("worker")).unwrap();
        std::fs::create_dir_all(root.join("shared")).unwrap();
        std::fs::create_dir_all(root.join("toolkit")).unwrap();
        std::fs::write(root.join("docker-compose.yml"), "services: {}\n").unwrap();
        std::fs::write(
            root.join("app/package.json"),
            r#"{"scripts":{"serve":"vite preview"}}"#,
        )
        .unwrap();
        let images = deployment::Images {
            version: DEPLOYMENT_VERSION.into(),
            images: std::collections::BTreeMap::from([
                (
                    "server".into(),
                    deployment::Image {
                        reference: "localhost/openbot-server@sha256:00".into(),
                    },
                ),
                (
                    "supervisor".into(),
                    deployment::Image {
                        reference: "localhost/openbot-supervisor@sha256:00".into(),
                    },
                ),
                (
                    "agent-computer".into(),
                    deployment::Image {
                        reference: "localhost/openbot-agent-computer@sha256:00".into(),
                    },
                ),
                (
                    "agent-bot".into(),
                    deployment::Image {
                        reference: "localhost/openbot-agent-bot@sha256:00".into(),
                    },
                ),
                (
                    "agent-langgraph".into(),
                    deployment::Image {
                        reference: "localhost/openbot-agent-langgraph@sha256:00".into(),
                    },
                ),
            ]),
        };
        std::fs::write(
            deployment::images_path(root),
            serde_json::to_string(&images).unwrap(),
        )
        .unwrap();
        deployment::record(root, DEPLOYMENT_VERSION).unwrap();
        for package in ["", "server", "worker", "shared", "toolkit"] {
            std::fs::write(root.join(package).join("package.json"), "{}").unwrap();
        }
        std::fs::write(root.join("bun.lock"), "synthetic-lock").unwrap();
        preparation::record_dependencies(root, Path::new("bun")).unwrap();
        preparation::record(root, None, vec!["fixture-image".into()]).unwrap();
    }

    struct TestRequest {
        path: String,
        headers: Vec<String>,
        body: String,
    }

    struct TestServer {
        url: String,
        received: std::sync::mpsc::Receiver<TestRequest>,
        done: Option<std::thread::JoinHandle<()>>,
    }

    impl TestServer {
        fn new(response: impl Into<String>) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
            Self::from_listener(listener, response)
        }

        fn from_listener(listener: std::net::TcpListener, response: impl Into<String>) -> Self {
            let response = response.into();
            let url = format!("http://{}", listener.local_addr().expect("addr"));
            let (sender, received) = std::sync::mpsc::channel();
            let done = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                loop {
                    let read = stream.read(&mut buffer).expect("read");
                    request.extend_from_slice(&buffer[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                let header_end = request
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .expect("headers")
                    + 4;
                let headers = String::from_utf8_lossy(&request[..header_end]).to_string();
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().expect("content length"))
                    })
                    .unwrap_or(0);
                while request.len() < header_end + content_length {
                    let read = stream.read(&mut buffer).expect("read body");
                    request.extend_from_slice(&buffer[..read]);
                }
                let mut lines = headers.lines();
                let path = lines
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .expect("path")
                    .to_string();
                let headers = lines
                    .filter(|line| !line.trim().is_empty())
                    .map(|line| line.to_ascii_lowercase())
                    .collect();
                let body =
                    String::from_utf8_lossy(&request[header_end..header_end + content_length])
                        .to_string();
                sender
                    .send(TestRequest {
                        path,
                        headers,
                        body,
                    })
                    .expect("send request");
                stream
                    .write_all(response.as_bytes())
                    .expect("write response");
            });
            Self {
                url,
                received,
                done: Some(done),
            }
        }

        fn request(mut self) -> TestRequest {
            let request = self.received.recv().expect("request");
            self.done.take().expect("thread").join().expect("join");
            request
        }
    }

    fn test_server_port(server: &TestServer) -> u16 {
        server
            .url
            .strip_prefix("http://127.0.0.1:")
            .expect("loopback url")
            .parse()
            .expect("port")
    }

    #[test]
    fn already_running_requires_selected_root_ownership_for_loopback_answer() {
        let root_a = temp_root("already-running-root-a");
        let root_b = temp_root("already-running-root-b");
        write_installed_deployment(&root_a);
        write_installed_deployment(&root_b);

        let server_a = TestServer::new("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
        let port_a = test_server_port(&server_a);
        assert!(
            !already_running_on(&root_a, port_a, |root, port| {
                assert_eq!(root, root_a.as_path());
                assert_eq!(port, port_a);
                Ok(false)
            }),
            "an answering shared port without selected-root ownership must not auto-adopt root A"
        );
        assert_eq!(server_a.request().path, "/api/capabilities");

        let server_b = TestServer::new("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
        let port_b = test_server_port(&server_b);
        assert!(already_running_on(&root_b, port_b, |root, port| {
            assert_eq!(root, root_b.as_path());
            assert_eq!(port, port_b);
            Ok(true)
        }));
        assert_eq!(server_b.request().path, "/api/capabilities");

        std::fs::remove_dir_all(root_a).unwrap();
        std::fs::remove_dir_all(root_b).unwrap();
    }

    #[test]
    fn already_running_returns_false_when_ownership_is_unproven() {
        let root = temp_root("already-running-unproven-root");
        write_installed_deployment(&root);
        let server = TestServer::new("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
        let port = test_server_port(&server);
        assert!(!already_running_on(&root, port, |_, _| {
            Err(Problem::with("ownership unavailable", "synthetic failure"))
        }));
        assert_eq!(server.request().path, "/api/capabilities");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    struct InitialHostFixture {
        base: PathBuf,
        root: PathBuf,
        bun: PathBuf,
        pids: std::cell::RefCell<Vec<u32>>,
    }

    #[cfg(unix)]
    impl InitialHostFixture {
        fn new(mode: &str) -> Self {
            use std::os::unix::fs::PermissionsExt;
            let base = temp_root("initial-host-launch");
            let root = base.join("deployment");
            std::fs::create_dir_all(&root).unwrap();
            for process in stack::HOST_PROCESSES {
                if mode == "first-fails"
                    || ((mode == "second-fails" || mode == "cleanup-refuses")
                        && process.name != "server")
                {
                    break;
                }
                std::fs::create_dir(root.join(process.cwd)).unwrap();
            }
            let bun = base.join("bun");
            // The production spawn boundary supplies cwd/argv/log files. Only the executable is
            // synthetic: one direct child with no network, engine, or credential access.
            std::fs::write(
                &bun,
                "#!/bin/sh\nprintf '%s' \"$$\" > child.pid\nexec /bin/sleep 60\n",
            )
            .unwrap();
            std::fs::set_permissions(&bun, std::fs::Permissions::from_mode(0o700)).unwrap();
            Self {
                base,
                root,
                bun,
                pids: std::cell::RefCell::new(Vec::new()),
            }
        }

        fn observe(&self, name: &str) {
            let path = self.root.join(name).join("child.pid");
            let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
            let pid = loop {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    if let Ok(pid) = text.parse::<u32>() {
                        break pid;
                    }
                }
                assert!(std::time::Instant::now() < until, "child did not start");
                std::thread::sleep(std::time::Duration::from_millis(5));
            };
            self.pids.borrow_mut().push(pid);
        }

        fn alive(&self) -> Vec<u32> {
            self.pids
                .borrow()
                .iter()
                .copied()
                .filter(|pid| unsafe { libc::kill(*pid as i32, 0) } == 0)
                .collect()
        }
    }

    #[cfg(unix)]
    impl Drop for InitialHostFixture {
        fn drop(&mut self) {
            // Even an old-code regression failure must not orphan the fixture. waitpid first
            // proves this is still our direct, unreaped child; ECHILD never authorizes a signal.
            for pid in self.pids.get_mut() {
                if unsafe { libc::waitpid(*pid as i32, std::ptr::null_mut(), libc::WNOHANG) } == 0 {
                    unsafe {
                        libc::kill(*pid as i32, libc::SIGKILL);
                        libc::waitpid(*pid as i32, std::ptr::null_mut(), 0);
                    }
                }
            }
            if self.base.is_file() {
                std::fs::remove_file(&self.base).unwrap();
            } else {
                std::fs::remove_dir_all(&self.base).unwrap();
            }
        }
    }

    #[cfg(unix)]
    struct SupervisionFixture {
        host: InitialHostFixture,
        app: tauri::App<tauri::test::MockRuntime>,
        watcher: Option<std::thread::JoinHandle<()>>,
    }

    #[cfg(unix)]
    impl Drop for SupervisionFixture {
        fn drop(&mut self) {
            let shell = self.app.state::<Shell>();
            shell
                .generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            stop_held_process_handles(
                &mut shell
                    .children
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
            )
            .unwrap();
            *shell
                .root
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            if let Some(watcher) = self.watcher.take() {
                watcher.join().unwrap();
            }
            eprintln!(
                "{}",
                serde_json::json!({"supervisionCleanup": self.host.root,
                "heldChildren": shell.children.lock().unwrap_or_else(std::sync::PoisonError::into_inner).len(), "watcherJoined": true})
            );
        }
    }

    #[cfg(unix)]
    fn failed_retry_keeps_survivor_supervised(failed_role: &str) {
        let host = InitialHostFixture::new("success");
        std::fs::write(
            &host.bun,
            "#!/bin/sh\nprintf '%s' \"$$\" > child.pid\nif [ -f fail ]; then exit 71; fi\nexec /bin/sleep 300\n",
        ).unwrap();
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .invoke_handler(tauri::generate_handler![start_stack])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let mut fixture = SupervisionFixture {
            host,
            app,
            watcher: None,
        };
        let shell = fixture.app.state::<Shell>();
        let setup = "tauri://localhost/failed-retry-setup";
        *shell.setup_url.lock().unwrap() = Some(setup.into());
        let attempt = StartAttempt::begin(&shell).unwrap();
        let generation = tauri::async_runtime::block_on(start_host_processes(
            &attempt,
            &fixture.host.root,
            &fixture.host.root.join(".logs"),
            &fixture.host.bun,
            &stack::Secrets::new(),
            |name| fixture.host.observe(name),
            |_| Ok(()),
        ))
        .unwrap();
        drop(attempt);
        fixture.watcher = Some(supervise_host_processes(
            fixture.app.handle().clone(),
            fixture.host.root.clone(),
            fixture.host.root.join(".logs"),
            fixture.host.bun.clone(),
            stack::Secrets::new(),
            generation,
            openbot_env::Ports::default(),
        ));
        // The actual watcher exhausts its actual budget and backoffs after this role fails.
        std::fs::write(fixture.host.root.join(failed_role).join("fail"), "").unwrap();
        {
            let mut children = shell.children.lock().unwrap();
            children
                .iter_mut()
                .find(|(name, _)| *name == failed_role)
                .unwrap()
                .1
                .kill()
                .unwrap();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(70);
        loop {
            if shell
                .last_failure
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|p| p.said.contains("could not be started again"))
                && window.url().unwrap().as_str() == setup
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "watcher did not produce recovery setup"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let survivor_pid = {
            let mut children = shell.children.lock().unwrap();
            assert!(!children.iter().any(|(name, _)| *name == failed_role));
            let (_, survivor) = children
                .iter_mut()
                .find(|(name, _)| *name == "worker")
                .unwrap();
            assert!(survivor.try_wait().unwrap().is_none());
            survivor.id()
        };
        // Deliberate invalid input rejects before saved-secret/deployment/engine access. This is
        // the generated production Start handler, after recovery has exposed ordinary Start.
        let problem = tauri::test::get_ipc_response(&window, tauri::webview::InvokeRequest {
            cmd: "start_stack".into(), callback: tauri::ipc::CallbackFn(0), error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                "root": fixture.host.root, "apiUrl": "https://intelligence.example.test",
                "gatewayWsUrl": "wss://gateway.example.test", "apiKey": "synthetic-unused-key",
                "model": {"provider": "synthetic-invalid-provider", "login": "api-key"}, "harness": null,
            })),
            headers: Default::default(), invoke_key: tauri::test::INVOKE_KEY.into(),
        }).expect_err("credential preflight must reject the synthetic provider");
        assert!(problem["said"]
            .as_str()
            .unwrap()
            .contains("synthetic-invalid-provider"));
        assert_eq!(
            shell.root.lock().unwrap().as_ref(),
            Some(&fixture.host.root)
        );
        assert!(!shell.starting.load(std::sync::atomic::Ordering::SeqCst));
        {
            let mut children = shell.children.lock().unwrap();
            let (_, survivor) = children
                .iter_mut()
                .find(|(name, _)| *name == "worker")
                .unwrap();
            assert_eq!(survivor.id(), survivor_pid);
            assert!(
                survivor.try_wait().unwrap().is_none(),
                "preflight unexpectedly reclaimed survivor"
            );
            survivor.kill().unwrap();
        }
        // A subsequent real child death must still cause the existing watcher to restart it.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        let replacement = loop {
            let replacement = shell
                .children
                .lock()
                .unwrap()
                .iter_mut()
                .find(|(name, child)| *name == "worker" && child.id() != survivor_pid)
                .and_then(|(_, child)| child.try_wait().unwrap().is_none().then_some(child.id()));
            if replacement.is_some()
                || fixture.watcher.as_ref().unwrap().is_finished()
                || std::time::Instant::now() >= deadline
            {
                break replacement;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        eprintln!(
            "{}",
            serde_json::json!({
                "failedRole": failed_role, "recoveryUrl": window.url().unwrap().as_str(),
                "ipcError": problem, "survivorPid": survivor_pid, "replacementPid": replacement,
                "watcherRetired": fixture.watcher.as_ref().unwrap().is_finished(),
                "generationBefore": generation,
                "generationAfterPreflight": shell.generation.load(std::sync::atomic::Ordering::SeqCst),
            })
        );
        assert!(
            replacement.is_some(),
            "failed retry preflight abandoned the surviving host's watcher"
        );
    }

    #[cfg(unix)]
    #[test]
    fn worker_exhaustion_does_not_adopt_healthy_survivors() {
        if crate::test_support::isolated_process(
            "tests::worker_exhaustion_does_not_adopt_healthy_survivors",
        ) {
            return;
        }
        let host = InitialHostFixture::new("success");
        write_installed_deployment(&host.root);
        let source = host.base.join("worker-recovery-host.rs");
        std::fs::write(&source, r#"
use std::{fs,io::{Read,Write},net::TcpListener,time::Duration};
fn main() {
    let cwd=std::env::current_dir().unwrap();
    let role=cwd.file_name().unwrap().to_str().unwrap();
    fs::write("child.pid",std::process::id().to_string()).unwrap();
    let mut starts=fs::OpenOptions::new().create(true).append(true).open("starts.log").unwrap();
    writeln!(starts,"{}",std::process::id()).unwrap();
    if role=="worker" {
        loop {
            if cwd.join("fail").exists() { std::process::exit(71); }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    let port=match role { "server"=>3001,"app"=>3010,_=>panic!("unexpected role") };
    let listener=TcpListener::bind(("127.0.0.1",port)).unwrap();
    for stream in listener.incoming() {
        let mut stream=stream.unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut request=[0;2048];
        if stream.read(&mut request).unwrap_or(0)>0 {
            let _=stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
        }
    }
}
"#).unwrap();
        crate::test_support::compile_fixture(&source, &host.bun);
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .invoke_handler(tauri::generate_handler![
                already_running,
                show_openbot,
                last_failure
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let mut fixture = SupervisionFixture {
            host,
            app,
            watcher: None,
        };
        let shell = fixture.app.state::<Shell>();
        let setup = "tauri://localhost/worker-recovery-setup";
        *shell.setup_url.lock().unwrap() = Some(setup.into());
        let attempt = StartAttempt::begin(&shell).unwrap();
        let logs = fixture.host.root.join(".logs");
        let wait_logs = logs.clone();
        let generation = tauri::async_runtime::block_on(start_host_processes(
            &attempt,
            &fixture.host.root,
            &logs,
            &fixture.host.bun,
            &stack::Secrets::new(),
            |name| fixture.host.observe(name),
            move |children| {
                stack::wait_until_answering(
                    children,
                    &wait_logs,
                    &stack::Ready {
                        api: 3001,
                        app: 3010,
                    },
                    std::time::Duration::from_secs(10),
                )
            },
        ))
        .unwrap();
        drop(attempt);
        fixture.watcher = Some(supervise_host_processes(
            fixture.app.handle().clone(),
            fixture.host.root.clone(),
            logs,
            fixture.host.bun.clone(),
            stack::Secrets::new(),
            generation,
            openbot_env::Ports::default(),
        ));
        std::fs::write(fixture.host.root.join("worker/fail"), "").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(70);
        loop {
            if shell
                .last_failure
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|p| {
                    p.said.contains("(worker)") && p.said.contains("could not be started again")
                })
                && window.url().unwrap().as_str() == setup
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "worker did not exhaust actual restart budget"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(server_capabilities_answer(3001));
        assert!(stack::recorded_server_owns_port(&fixture.host.root, 3001).unwrap());
        assert!(stack::recorded_process_owns_port(&fixture.host.root, "app", 3010).unwrap());
        let invoke = |command: &str, body: serde_json::Value| {
            tauri::test::get_ipc_response(
                &window,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
            .map(|response| response.deserialize::<serde_json::Value>().unwrap())
        };
        let result = invoke(
            "already_running",
            serde_json::json!({"root":fixture.host.root}),
        )
        .unwrap()
        .as_bool()
        .unwrap();
        let children = shell.children.lock().unwrap();
        let survivors: Vec<_> = children
            .iter()
            .map(|(name, child)| (*name, child.id()))
            .collect();
        drop(children);
        let starts = std::fs::read_to_string(fixture.host.root.join("worker/starts.log")).unwrap();
        let failure = shell.last_failure.lock().unwrap().clone();
        println!(
            "WORKER_RECOVERY_PROOF={}",
            serde_json::json!({
                "root":fixture.host.root,"base":fixture.host.base,"generation":generation,
                "setupUrl":window.url().unwrap().as_str(),"alreadyRunning":result,
                "survivors":survivors,"workerStarts":starts,"failure":failure,
            })
        );
        assert_eq!(starts.lines().count(), supervise::MAX_RESTARTS as usize + 1);
        assert!(
            !result,
            "exhausted worker was automatically adopted through generated already_running IPC"
        );
        let notification = invoke("last_failure", serde_json::json!({})).unwrap();
        assert!(notification["said"].as_str().unwrap().contains("(worker)"));
        assert!(invoke("last_failure", serde_json::json!({}))
            .unwrap()
            .is_null());
        assert!(recovery_required(&shell, &fixture.host.root));
        let show_error = invoke("show_openbot", serde_json::json!({})).unwrap_err();
        assert!(show_error["said"]
            .as_str()
            .unwrap()
            .contains("needs recovery"));
        restore_window_on(fixture.app.handle(), &openbot_env::Ports::default());
        assert_eq!(window.url().unwrap().as_str(), setup);
        println!(
            "WORKER_RECOVERY_COMMANDS={}",
            serde_json::json!({
                "notification":notification,"generatedShowError":show_error,
                "recoveryAfterNoticeRead":true,"restoreUrl":window.url().unwrap().as_str(),
            })
        );
    }

    #[cfg(unix)]
    #[test]
    fn recovery_transient_worker_restart_does_not_require_recovery() {
        let host = InitialHostFixture::new("success");
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let mut fixture = SupervisionFixture {
            host,
            app,
            watcher: None,
        };
        let shell = fixture.app.state::<Shell>();
        let attempt = StartAttempt::begin(&shell).unwrap();
        let generation = tauri::async_runtime::block_on(start_host_processes(
            &attempt,
            &fixture.host.root,
            &fixture.host.root.join(".logs"),
            &fixture.host.bun,
            &stack::Secrets::new(),
            |name| fixture.host.observe(name),
            |_| Ok(()),
        ))
        .unwrap();
        drop(attempt);
        fixture.watcher = Some(supervise_host_processes(
            fixture.app.handle().clone(),
            fixture.host.root.clone(),
            fixture.host.root.join(".logs"),
            fixture.host.bun.clone(),
            stack::Secrets::new(),
            generation,
            openbot_env::Ports::default(),
        ));
        let original = {
            let mut children = shell.children.lock().unwrap();
            let (_, worker) = children
                .iter_mut()
                .find(|(name, _)| *name == "worker")
                .unwrap();
            worker.kill().unwrap();
            worker.id()
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        let replacement = loop {
            let replacement = shell
                .children
                .lock()
                .unwrap()
                .iter_mut()
                .find(|(name, child)| *name == "worker" && child.id() != original)
                .and_then(|(_, child)| child.try_wait().unwrap().is_none().then_some(child.id()));
            if let Some(pid) = replacement {
                break pid;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "transient worker was not restarted"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert!(!recovery_required(&shell, &fixture.host.root));
        assert!(shell.last_failure.lock().unwrap().is_none());
        println!(
            "WORKER_TRANSIENT_PROOF={}",
            serde_json::json!({"original":original,"replacement":replacement,"generation":generation,"recoveryRequired":false})
        );
    }

    #[cfg(unix)]
    #[test]
    fn recovery_ready_start_and_completed_stop_resolve_condition() {
        let host = InitialHostFixture::new("success");
        let shell = Shell::default();
        mark_recovery_required(&shell, &host.root, 0);
        *shell.last_failure.lock().unwrap() = Some(Problem::plain("worker exhausted"));
        assert!(recovery_required(&shell, &host.root));
        assert!(!recovery_required(&shell, &host.base.join("other")));
        let attempt = StartAttempt::begin(&shell).unwrap();
        tauri::async_runtime::block_on(start_host_processes(
            &attempt,
            &host.root,
            &host.root.join(".logs"),
            &host.bun,
            &stack::Secrets::new(),
            |name| host.observe(name),
            |_| Ok(()),
        ))
        .unwrap();
        drop(attempt);
        assert!(!recovery_required(&shell, &host.root));
        assert!(shell.last_failure.lock().unwrap().is_none());
        mark_recovery_required(&shell, &host.root, 0);
        assert!(
            stop_everything_with(&shell, &host.root, stack::stop_processes_under, |_| Err(
                "synthetic container cleanup refusal".into()
            ))
            .is_err()
        );
        assert!(
            recovery_required(&shell, &host.root),
            "failed Stop cannot resolve recovery"
        );
        stop_everything_with(&shell, &host.root, stack::stop_processes_under, |_| Ok(())).unwrap();
        assert!(!recovery_required(&shell, &host.root));
        assert!(host.alive().is_empty());
    }

    #[test]
    fn recovery_notice_consumption_and_failed_retry_preserve_gate() {
        let f = RestoreFixture::new();
        let setup = if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost/recovery"
        } else {
            "tauri://localhost/recovery"
        };
        let app = f.app(&f.owned, setup);
        let shell = app.state::<Shell>();
        *shell.root.lock().unwrap() = Some(f.owned.clone());
        {
            let _startup = shell.startup.lock().unwrap();
            mark_recovery_required(&shell, &f.owned, 0);
        }
        *shell.last_failure.lock().unwrap() = Some(Problem::plain("worker exhausted"));
        assert!(last_failure(app.handle().clone()).is_some());
        assert!(last_failure(app.handle().clone()).is_none());
        assert!(recovery_required(&shell, &f.owned));
        write_quit_cleanup_notice(
            &f.owned,
            &["[exit] cleanup failed: Compose down failed: synthetic".into()],
        )
        .unwrap();
        let notice = last_failure(app.handle().clone()).expect("persisted Quit notice");
        assert_eq!(notice.said, "OpenBot had trouble shutting down last time.");
        assert!(notice
            .detail
            .as_ref()
            .unwrap()
            .contains("containers stopped"));
        assert!(!quit_cleanup_notice_path(&f.owned).exists());
        assert!(
            recovery_required(&shell, &f.owned),
            "consuming the persisted notice cannot make survivors adoptable"
        );
        assert!(last_failure(app.handle().clone()).is_none());
        let window = app.get_webview_window("main").unwrap();
        let problem = tauri::test::get_ipc_response(&window, tauri::webview::InvokeRequest {
            cmd: "start_stack".into(), callback: tauri::ipc::CallbackFn(0), error: tauri::ipc::CallbackFn(1),
            url: setup.parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                "root": f.owned, "apiUrl": "https://intelligence.example.test",
                "gatewayWsUrl": "wss://gateway.example.test", "apiKey": "synthetic-unused-key",
                "model": {"provider": "synthetic-invalid-provider", "login": "api-key"}, "harness": null,
            })), headers: Default::default(), invoke_key: tauri::test::INVOKE_KEY.into(),
        }).expect_err("synthetic credential preflight must reject before store access");
        assert!(problem["said"]
            .as_str()
            .unwrap()
            .contains("synthetic-invalid-provider"));
        assert_eq!(
            shell.generation.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert!(recovery_required(&shell, &f.owned));
        assert!(
            owned_app_url(&f.owned, &f.ports).is_some(),
            "survivors must still answer"
        );
        assert!(show_openbot_on(app.handle().clone(), &f.ports).is_err());
        restore_window_on(app.handle(), &f.ports);
        assert_eq!(window.url().unwrap().as_str(), setup);
        // Reclaim may advance the active generation before a later Start failure. It still
        // cannot clear the recovery marker; only accepted readiness can do that.
        let attempt = StartAttempt::begin(&shell).unwrap();
        cleanup_before_start(app.handle(), &attempt, &f.owned, |_| Ok(0)).unwrap();
        assert!(recovery_required(&shell, &f.owned));
    }

    #[test]
    fn pending_quit_notice_blocks_restore_before_react_consumes_it() {
        let f = RestoreFixture::new();
        let setup = if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost/recovery"
        } else {
            "tauri://localhost/recovery"
        };
        write_quit_cleanup_notice(
            &f.owned,
            &["[exit] cleanup failed: Compose down failed: synthetic".into()],
        )
        .unwrap();
        let app = f.app(&f.owned, setup);
        let shell = app.state::<Shell>();
        let window = app.get_webview_window("main").unwrap();
        assert!(
            owned_app_url(&f.owned, &f.ports).is_some(),
            "survivors must still answer before restore"
        );
        assert!(!recovery_required(&shell, &f.owned));

        restore_window_on(app.handle(), &f.ports);

        assert_eq!(window.url().unwrap().as_str(), setup);
        assert!(recovery_required(&shell, &f.owned));
        assert!(
            quit_cleanup_notice_path(&f.owned).exists(),
            "restore must not consume the persisted notice before React asks for it"
        );
        let notice = last_failure(app.handle().clone()).expect("persisted Quit notice");
        assert_eq!(notice.said, "OpenBot had trouble shutting down last time.");
        assert!(notice
            .detail
            .as_ref()
            .unwrap()
            .contains("containers stopped"));
        assert!(!quit_cleanup_notice_path(&f.owned).exists());
        assert!(recovery_required(&shell, &f.owned));
    }

    #[test]
    fn quit_notice_sink_failure_marks_recovery_and_shows_setup() {
        let f = RestoreFixture::new();
        let setup = if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost/recovery"
        } else {
            "tauri://localhost/recovery"
        };
        let app = f.app(&f.owned, setup);
        let shell = app.state::<Shell>();
        *shell.root.lock().unwrap() = Some(f.owned.clone());
        let window = app.get_webview_window("main").unwrap();
        window
            .navigate("http://127.0.0.1:3010/running".parse().unwrap())
            .unwrap();
        window.hide().unwrap();

        publish_quit_notice_failure(app.handle().clone(), "notice path is unavailable".into());

        assert!(recovery_required(&shell, &f.owned));
        let failure = last_failure(app.handle().clone()).expect("volatile sink failure");
        assert_eq!(failure.said, "OpenBot could not record a shutdown problem.");
        assert!(failure
            .detail
            .as_ref()
            .unwrap()
            .contains("notice path is unavailable"));
        assert_eq!(window.url().unwrap().as_str(), setup);
        assert!(window.is_visible().unwrap());
    }

    #[test]
    fn recovery_publication_wins_over_restore_already_probing() {
        let f = RestoreFixture::new();
        let app = f.app(&f.owned, "tauri://localhost/recovery");
        std::fs::write(f.owned.join("pause-response"), "").unwrap();
        let restoring = app.handle().clone();
        let ports = openbot_env::Ports {
            server: f.ports.server,
            app: f.ports.app,
            ..Default::default()
        };
        let restore = std::thread::spawn(move || restore_window_on(&restoring, &ports));
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !f.owned.join("response-entered").exists() {
            assert!(
                std::time::Instant::now() < until,
                "restore did not reach owned responder"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        // The actual probe holds startup until its navigation completes. Exhaustion publication
        // uses that same lock, so it must follow the stale probe and leave setup as the destination.
        assert!(app.state::<Shell>().startup.try_lock().is_err());
        let recovering = app.handle().clone();
        let root = f.owned.clone();
        let recovery = std::thread::spawn(move || {
            let shell = recovering.state::<Shell>();
            let _startup = shell.startup.lock().unwrap();
            mark_recovery_required(&shell, &root, 0);
            show_setup(recovering.clone()).unwrap();
        });
        std::fs::remove_file(f.owned.join("pause-response")).unwrap();
        restore.join().unwrap();
        recovery.join().unwrap();
        assert_eq!(
            app.get_webview_window("main")
                .unwrap()
                .url()
                .unwrap()
                .as_str(),
            "tauri://localhost/recovery"
        );
        assert!(recovery_required(&app.state::<Shell>(), &f.owned));
    }

    #[cfg(unix)]
    #[test]
    fn failed_retry_after_server_exhaustion_keeps_survivor_supervised() {
        failed_retry_keeps_survivor_supervised("server");
    }

    #[cfg(unix)]
    #[test]
    fn failed_retry_after_app_exhaustion_keeps_survivor_supervised() {
        failed_retry_keeps_survivor_supervised("app");
    }

    #[cfg(unix)]
    fn initial_host_case(mode: &'static str) {
        let fixture = InitialHostFixture::new(mode);
        let shell = Shell::default();
        let attempt = StartAttempt::begin(&shell).unwrap();
        let result = tauri::async_runtime::block_on(start_host_processes(
            &attempt,
            &fixture.root,
            &fixture.root.join(".logs"),
            &fixture.bun,
            &stack::Secrets::new(),
            |name| {
                fixture.observe(name);
                if mode == "cleanup-refuses" {
                    // A real filesystem failure prevents both the second spawn and verification
                    // of the first child's deployment. No cleanup failure is mocked away.
                    std::fs::remove_dir_all(&fixture.base).unwrap();
                    std::fs::write(&fixture.base, b"blocked fixture parent").unwrap();
                }
            },
            move |_| match mode {
                "wait-fails" => Err("synthetic readiness failure".into()),
                "wait-panics" => panic!("synthetic readiness task panic"),
                "success" => Ok(()),
                _ => panic!("readiness must not run after a spawn failure"),
            },
        ));
        let alive = fixture.alive();
        eprintln!(
            "{}",
            serde_json::json!({
                "initialHostCase": mode,
                "spawned": fixture.pids.borrow().len(),
                "aliveAfterStart": alive,
                "heldAfterStart": shell.children.lock().unwrap().len(),
                "error": result.as_ref().err().map(|problem| &problem.said),
            })
        );
        if mode == "success" {
            assert!(result.is_ok(), "{result:?}");
            assert_eq!(alive.len(), 3);
            assert_eq!(stack::recorded_host_pids(&fixture.root).unwrap().len(), 3);
        } else {
            let problem = result.unwrap_err();
            let expected = match mode {
                "first-fails" => "could not start server:",
                "second-fails" | "cleanup-refuses" => "could not start app:",
                "wait-fails" => "synthetic readiness failure",
                "wait-panics" => "the wait did not run:",
                _ => unreachable!(),
            };
            if matches!(mode, "wait-fails" | "wait-panics") {
                assert!(
                    problem.said.contains("could not finish starting"),
                    "{problem:?}"
                );
                assert!(
                    problem
                        .detail
                        .as_deref()
                        .unwrap_or_default()
                        .starts_with(expected),
                    "{problem:?}"
                );
            } else {
                assert!(problem.said.starts_with(expected), "{problem:?}");
            }
            if mode == "cleanup-refuses" {
                assert_eq!(alive.len(), 1);
                assert_eq!(shell.children.lock().unwrap().len(), 1);
                assert_eq!(shell.root.lock().unwrap().as_ref(), Some(&fixture.root));
                assert!(
                    problem.detail.is_some(),
                    "cleanup failure must remain visible"
                );
                std::fs::remove_file(&fixture.base).unwrap();
                std::fs::create_dir_all(&fixture.root).unwrap();
            } else {
                assert!(
                    alive.is_empty(),
                    "failed Start left owned children alive: {alive:?}"
                );
                assert!(shell.children.lock().unwrap().is_empty());
                assert!(shell.root.lock().unwrap().is_none());
            }
        }
        if mode == "success" || mode == "cleanup-refuses" {
            retire_host_processes(&shell, &fixture.root, stack::stop_processes_under).unwrap();
            assert!(fixture.alive().is_empty());
            assert!(shell.children.lock().unwrap().is_empty());
            assert!(shell.root.lock().unwrap().is_none());
        }
    }

    #[cfg(unix)]
    #[test]
    fn initial_start_stopped_during_readiness_cannot_publish_and_cleans_real_children() {
        use std::sync::{atomic::Ordering::SeqCst, Arc, Barrier};
        let fixture = InitialHostFixture::new("success");
        let shell = Arc::new(Shell::default());
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let starter = {
            let (shell, root, bun, entered, release) = (
                shell.clone(),
                fixture.root.clone(),
                fixture.bun.clone(),
                entered.clone(),
                release.clone(),
            );
            std::thread::spawn(move || {
                let attempt = StartAttempt::begin(&shell).unwrap();
                tauri::async_runtime::block_on(start_host_processes(
                    &attempt,
                    &root,
                    &root.join(".logs"),
                    &bun,
                    &stack::Secrets::new(),
                    |_| {},
                    move |_| {
                        entered.wait();
                        release.wait();
                        Ok(())
                    },
                ))
            })
        };
        entered.wait();
        for process in stack::HOST_PROCESSES {
            fixture.observe(process.cwd);
        }
        assert_eq!(
            stack::recorded_host_pids(&fixture.root).unwrap().len(),
            stack::HOST_PROCESSES.len()
        );
        stop_everything_with(&shell, &fixture.root, stack::stop_processes_under, |_| {
            Ok(())
        })
        .unwrap();
        let stopped_generation = shell.generation.load(SeqCst);
        assert!(shell.children.lock().unwrap().is_empty());
        assert!(shell.root.lock().unwrap().is_none());
        release.wait();
        let result = starter.join().unwrap();
        let published = shell.children.lock().unwrap().len();
        let active_root = shell.root.lock().unwrap().clone();
        let completed_generation = shell.generation.load(SeqCst);
        let alive = fixture.alive();
        // The old-code run must also leave no fixture processes behind.
        retire_host_processes(&shell, &fixture.root, stack::stop_processes_under).unwrap();
        eprintln!(
            "{}",
            serde_json::json!({
                "stoppedGeneration": stopped_generation,
                "completedGeneration": completed_generation,
                "publishedAfterStop": published,
                "aliveAfterStartFinished": alive,
                "result": result.as_ref().err().map(|problem| &problem.said),
            })
        );
        assert!(
            result.is_err(),
            "Start succeeded after Stop completed: {result:?}"
        );
        assert_eq!(completed_generation, stopped_generation);
        assert_eq!(published, 0);
        assert!(active_root.is_none());
        assert!(
            alive.is_empty(),
            "cancelled Start leaked its children: {alive:?}"
        );
    }

    #[test]
    fn initial_start_cancelled_during_preparation_never_launches_hosts() {
        let shell = Shell::default();
        let attempt = StartAttempt::begin(&shell).unwrap();
        // Deployment/download or dependency preparation returns after Stop has completed.
        stop_everything_with(&shell, Path::new("unused-root"), |_| Ok(0), |_| Ok(())).unwrap();
        let problem = tauri::async_runtime::block_on(start_host_processes(
            &attempt,
            Path::new("unused-root"),
            Path::new("unused-logs"),
            Path::new("must-not-be-launched"),
            &stack::Secrets::new(),
            |_| panic!("cancelled preparation launched a host"),
            |_| panic!("cancelled preparation reached readiness"),
        ))
        .unwrap_err();
        assert_eq!(problem.said, StartAttempt::cancelled().said);
        assert!(shell.root.lock().unwrap().is_none());
        assert!(shell.children.lock().unwrap().is_empty());
        assert!(
            StartAttempt::begin(&shell).is_err(),
            "cancelled attempt is still unwinding"
        );
        drop(attempt);
        assert!(
            StartAttempt::begin(&shell).is_ok(),
            "a fresh Start can proceed after cleanup"
        );
    }

    #[test]
    fn initial_start_side_effects_serialize_with_stop_and_quit_cleanup() {
        use std::sync::Arc;
        for quitting in [false, true] {
            let shell = Arc::new(Shell::default());
            let attempt = StartAttempt::begin(&shell).unwrap();
            let startup = attempt.lock_current().unwrap();
            let (sent, completed) = std::sync::mpsc::channel();
            let stopper = {
                let shell = shell.clone();
                std::thread::spawn(move || {
                    let cleanup = |_: &Path| Ok(0);
                    let down = |_: &Path| {
                        sent.send(()).unwrap();
                        Ok(())
                    };
                    if quitting {
                        assert!(
                            exit_cleanup_with(&shell, Path::new("unused-root"), cleanup, down)
                                .is_empty()
                        );
                    } else {
                        stop_everything_with(&shell, Path::new("unused-root"), cleanup, down)
                            .unwrap();
                    }
                })
            };
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while attempt.require_current().is_ok() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "shutdown did not invalidate Start"
                );
                std::thread::yield_now();
            }
            assert!(attempt.require_current().is_err());
            let cleanup_waited = matches!(
                completed.try_recv(),
                Err(std::sync::mpsc::TryRecvError::Empty)
            );
            drop(startup);
            completed
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            stopper.join().unwrap();
            assert!(
                cleanup_waited,
                "shutdown completed before the startup side effect released its lock"
            );
            assert!(
                attempt.lock_current().is_err(),
                "a cancelled Start resumed a side effect"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn initial_host_second_spawn_failure_cleans_the_real_first_child() {
        initial_host_case("second-fails");
    }

    #[cfg(unix)]
    #[test]
    fn initial_host_first_spawn_failure_never_waits_or_publishes() {
        initial_host_case("first-fails");
    }

    #[cfg(unix)]
    #[test]
    fn initial_host_success_records_then_stops_all_children() {
        initial_host_case("success");
    }

    #[cfg(unix)]
    #[test]
    fn initial_host_readiness_failure_preserves_error_and_cleans_children() {
        initial_host_case("wait-fails");
    }

    #[cfg(unix)]
    #[test]
    fn initial_host_wait_panic_keeps_children_available_for_cleanup() {
        initial_host_case("wait-panics");
    }

    #[cfg(unix)]
    #[test]
    fn initial_host_cleanup_refusal_keeps_original_error_and_stop_ownership() {
        initial_host_case("cleanup-refuses");
    }

    #[cfg(unix)]
    #[test]
    fn failed_host_recording_retires_children_and_preserves_recording_failure() {
        let root = temp_root("failed-recording-lifecycle");
        std::fs::create_dir_all(&root).unwrap();
        let worker = std::process::Command::new("/bin/sleep")
            .arg("60")
            .current_dir(&root)
            .spawn()
            .unwrap();
        let children = vec![("bogus", worker)];
        let shell = Shell::default();
        let attempt = StartAttempt::begin(&shell).unwrap();
        let result = finish_host_start(&attempt, &root, children, Ok(())).unwrap_err();
        assert_eq!(
            result.said,
            "OpenBot could not verify its host process ownership."
        );
        assert!(
            result
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("invalid host launch bogus")),
            "{result:?}"
        );
        assert!(shell.children.lock().unwrap().is_empty());
        assert!(shell.root.lock().unwrap().is_none());
        assert_eq!(
            shell.generation.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert!(
            !restart_host_process_with(&shell, &root, "worker", 0, || panic!(
                "failed recording attempt restarted"
            ))
            .unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_host_recording_keeps_root_and_handles_when_forced_cleanup_fails() {
        let root = temp_root("failed-recording-stubborn-child");
        std::fs::create_dir_all(&root).unwrap();
        let child = std::process::Command::new("/bin/sleep")
            .arg("60")
            .current_dir(&root)
            .spawn()
            .unwrap();
        let pid = child.id();
        let mut children = vec![("server", child)];
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(root.clone());
        let result = cleanup_after_host_recording_failure(
            &shell,
            &root,
            &mut children,
            Problem::with("recording failed", "recording detail"),
            |_, _| {
                Err(Problem::with(
                    "normal cleanup failed",
                    "normal cleanup detail",
                ))
            },
            |_| {
                Err(Problem::with(
                    "forced cleanup failed",
                    "forced cleanup detail",
                ))
            },
        )
        .unwrap_err();

        assert_eq!(result.said, "recording failed");
        let detail = result.detail.as_deref().unwrap_or_default();
        assert!(detail.contains("recording detail"), "{detail}");
        assert!(detail.contains("normal cleanup detail"), "{detail}");
        assert!(detail.contains("forced cleanup detail"), "{detail}");
        assert_eq!(shell.root.lock().unwrap().as_deref(), Some(root.as_path()));
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].1.id(), pid);
        for (_, child) in children.iter_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_host_recording_clears_root_and_handles_when_forced_cleanup_succeeds() {
        let root = temp_root("failed-recording-forced-cleanup");
        std::fs::create_dir_all(&root).unwrap();
        let child = std::process::Command::new("/bin/sleep")
            .arg("60")
            .current_dir(&root)
            .spawn()
            .unwrap();
        let mut children = vec![("server", child)];
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(root.clone());
        let result = cleanup_after_host_recording_failure(
            &shell,
            &root,
            &mut children,
            Problem::with("recording failed", "recording detail"),
            |_, _| {
                Err(Problem::with(
                    "normal cleanup failed",
                    "normal cleanup detail",
                ))
            },
            |children| {
                for (_, child) in children.iter_mut() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                children.clear();
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(result.said, "recording failed");
        let detail = result.detail.as_deref().unwrap_or_default();
        assert!(detail.contains("recording detail"), "{detail}");
        assert!(detail.contains("normal cleanup detail"), "{detail}");
        assert!(!detail.contains("forced cleanup"), "{detail}");
        assert!(shell.root.lock().unwrap().is_none());
        assert!(children.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_readiness_retires_children_and_preserves_original_failure() {
        let root = temp_root("failed-readiness-lifecycle");
        std::fs::create_dir_all(&root).unwrap();
        let mut failed = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 71"])
            .spawn()
            .unwrap();
        failed.wait().unwrap();
        let worker = std::process::Command::new("/bin/sleep")
            .arg("60")
            .current_dir(&root)
            .spawn()
            .unwrap();
        let mut children = vec![("server", failed), ("worker", worker)];
        let original = stack::wait_until_answering(
            &mut children,
            &root,
            &stack::Ready { api: 0, app: 0 },
            std::time::Duration::from_secs(1),
        )
        .unwrap_err();
        let shell = Shell::default();
        let attempt = StartAttempt::begin(&shell).unwrap();
        let result =
            finish_host_start(&attempt, &root, children, Err(original.clone())).unwrap_err();
        assert_eq!(result.said, original);
        assert!(result.detail.is_none());
        assert!(shell.children.lock().unwrap().is_empty());
        assert!(shell.root.lock().unwrap().is_none());
        assert_eq!(
            shell.generation.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert!(
            !restart_host_process_with(&shell, &root, "server", 0, || panic!(
                "failed attempt restarted"
            ))
            .unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stop_serializes_with_a_restart_already_inside_spawn() {
        use std::sync::{atomic::Ordering::SeqCst, Arc, Barrier};
        let root = temp_root("restart-stop-barrier");
        std::fs::create_dir_all(&root).unwrap();
        let shell = Arc::new(Shell::default());
        *shell.root.lock().unwrap() = Some(root.clone());
        shell.generation.store(1, SeqCst);
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let restart = {
            let (shell, root, entered, release) = (
                shell.clone(),
                root.clone(),
                entered.clone(),
                release.clone(),
            );
            std::thread::spawn(move || {
                restart_host_process_with(&shell, &root, "server", 1, || {
                    entered.wait();
                    release.wait();
                    std::process::Command::new("/bin/sleep")
                        .arg("60")
                        .current_dir(&root)
                        .spawn()
                })
            })
        };
        entered.wait();
        let (sent, completed) = std::sync::mpsc::channel();
        let stop = {
            let (shell, root) = (shell.clone(), root.clone());
            std::thread::spawn(move || {
                let result =
                    stop_everything_with(&shell, &root, stack::stop_processes_under, |_| Ok(()));
                sent.send(()).unwrap();
                result
            })
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while shell.generation.load(SeqCst) == 1 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert!(matches!(
            completed.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        release.wait();
        assert!(!restart.join().unwrap().unwrap());
        stop.join().unwrap().unwrap();
        assert!(shell.children.lock().unwrap().is_empty());
        assert!(shell.root.lock().unwrap().is_none());
        assert!(
            !restart_host_process_with(&shell, &root, "server", 1, || panic!(
                "retired restart spawned"
            ))
            .unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_retry_cleanup_retires_generation_and_retains_selected_root() {
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let shell = app.state::<Shell>();
        let root = temp_root("retry-cleanup-failure");
        *shell.root.lock().unwrap() = Some(root.clone());
        shell
            .generation
            .store(4, std::sync::atomic::Ordering::SeqCst);
        let attempt = StartAttempt::begin(&shell).unwrap();
        let _startup = attempt.lock_current().unwrap();
        assert_eq!(
            shell.generation.load(std::sync::atomic::Ordering::SeqCst),
            4
        );
        assert!(
            StartAttempt::begin(&shell).is_err(),
            "replacement Starts must remain serialized"
        );
        let problem = cleanup_before_start(
            app.handle(),
            &attempt,
            Path::new("unused-fallback"),
            |selected| {
                assert_eq!(selected, root);
                Err(Problem::plain("synthetic cleanup refused"))
            },
        )
        .unwrap_err();
        assert_eq!(problem.said, "synthetic cleanup refused");
        assert!(
            attempt.require_current().is_ok(),
            "reclaim must not cancel its own Start"
        );
        assert_eq!(
            shell.generation.load(std::sync::atomic::Ordering::SeqCst),
            5
        );
        assert_eq!(shell.root.lock().unwrap().as_ref(), Some(&root));
        assert!(
            !restart_host_process_with(&shell, &root, "server", 4, || panic!(
                "old generation resumed"
            ))
            .unwrap()
        );
    }

    fn temp_root(name: &str) -> PathBuf {
        static NEXT_TEMP_ROOT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let next = NEXT_TEMP_ROOT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut path = std::env::temp_dir();
        path.push(format!("{name}-{}-{next}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    struct SerializedPath {
        previous: Option<std::ffi::OsString>,
        previous_record: Option<std::ffi::OsString>,
        bin: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl SerializedPath {
        fn set() -> Self {
            Self::set_with("docker", "shutdown")
        }

        fn set_with(binary: &str, scenario: &str) -> Self {
            Self::set_with_path(binary, scenario, true)
        }

        fn set_only_with(binary: &str, scenario: &str) -> Self {
            Self::set_with_path(binary, scenario, false)
        }

        fn set_with_path(binary: &str, scenario: &str, inherit_path: bool) -> Self {
            static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let previous = std::env::var_os("PATH");
            let previous_record = std::env::var_os("OPENBOT_TEST_ENGINE_RECORD");
            let bin = temp_root("openbot-fake-engine-bin");
            std::fs::create_dir_all(&bin).unwrap();
            Self::write_binary_under(&bin, binary, scenario);
            Self::write_binary_under(&bin, "bun", "runtime");
            let mut path = std::ffi::OsString::from(bin.clone());
            if inherit_path {
                if let Some(previous) = previous.as_ref().filter(|previous| !previous.is_empty()) {
                    path.push(if cfg!(windows) { ";" } else { ":" });
                    path.push(previous);
                }
            }
            #[cfg(windows)]
            if !inherit_path {
                // Start saves synthetic credentials through DPAPI. Keep its OS interpreter
                // available without exposing real engines from the inherited developer PATH.
                let system_root = std::env::var_os("SystemRoot")
                    .filter(|root| !root.is_empty())
                    .expect("Windows fixtures require SystemRoot to locate Windows PowerShell");
                path.push(";");
                path.push(
                    PathBuf::from(system_root)
                        .join("System32")
                        .join("WindowsPowerShell")
                        .join("v1.0"),
                );
            }
            std::env::set_var("PATH", path);
            Self {
                previous,
                previous_record,
                bin,
                _guard: guard,
            }
        }

        fn bin(&self) -> &Path {
            &self.bin
        }

        fn write_binary(&self, name: &str, scenario: &str) {
            Self::write_binary_under(&self.bin, name, scenario);
        }

        fn write_binary_under(bin: &Path, name: &str, scenario: &str) {
            let source = bin.join(format!("{name}.rs"));
            std::fs::write(
                &source,
                format!(
                    "const SCENARIO: &str = {scenario:?};\n{}",
                    include_str!("../tests/fixtures/engine.rs")
                ),
            )
            .unwrap();
            let binary = bin.join(if cfg!(windows) && !name.ends_with(".exe") {
                format!("{name}.exe")
            } else {
                name.to_string()
            });
            crate::test_support::compile_fixture(&source, &binary);
        }
    }

    impl Drop for SerializedPath {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                std::env::set_var("PATH", previous);
            } else {
                std::env::remove_var("PATH");
            }
            if let Some(previous) = &self.previous_record {
                std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", previous);
            } else {
                std::env::remove_var("OPENBOT_TEST_ENGINE_RECORD");
            }
        }
    }

    fn fake_engine(record: &Path) -> engine::Address {
        std::fs::create_dir_all(record.parent().expect("record parent")).unwrap();
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", record);
        engine::Address::new(engine::Engine::Docker, None)
    }

    fn assert_compose_down_ran_under(record: &Path, root: &Path) {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let lines = std::fs::read_to_string(record).expect("command record");
        assert!(
            lines.lines().any(|line| line
                == format!(
                    "{}\tcompose -f docker-compose.yml --profile harness down",
                    root.display()
                )),
            "{lines}"
        );
    }
    /// Real loopback responder in a separate process, so root/PID ownership checks use the same
    /// OS inventory as production. The Tauri mock replaces only the window, never the HTTP/PID path.
    struct RestoreFixture {
        base: PathBuf,
        selected: PathBuf,
        owned: PathBuf,
        child: std::process::Child,
        app_child: std::process::Child,
        app_descendant_pid: Option<u32>,
        ports: openbot_env::Ports,
    }

    impl RestoreFixture {
        fn new() -> Self {
            Self::with_app_descendant(false)
        }

        fn with_app_descendant(descendant: bool) -> Self {
            let base = temp_root("restore-owned-loopback");
            let selected = base.join("selected");
            let owned = base.join("owned");
            write_installed_deployment(&selected);
            write_installed_deployment(&owned);
            let source = base.join("listener.rs");
            std::fs::write(&source, r#"
use std::io::{Read, Write};
use std::net::TcpListener;
fn serve(listener: TcpListener) {
    for stream in listener.incoming() {
        let mut stream = stream.unwrap();
        stream.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
        let mut request = [0; 2048];
        if stream.read(&mut request).unwrap_or(0) > 0 {
            if std::path::Path::new("pause-response").exists() {
                std::fs::write("response-entered", "").unwrap();
                while std::path::Path::new("pause-response").exists() {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
        }
    }
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--parent") {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--record-pid").arg(&args[2]).stdin(std::process::Stdio::null()).spawn().unwrap();
        let mut stop = [0; 1];
        let _ = std::io::stdin().read(&mut stop);
        let _ = child.kill();
        let _ = child.wait();
        return;
    }
    if args.get(1).map(String::as_str) == Some("--record-pid") {
        std::fs::write(&args[2], std::process::id().to_string()).unwrap();
    }
    let api = TcpListener::bind("127.0.0.1:0").unwrap();
    let app = TcpListener::bind("127.0.0.1:0").unwrap();
    println!("{} {}", api.local_addr().unwrap().port(), app.local_addr().unwrap().port());
    std::io::stdout().flush().unwrap();
    std::thread::spawn(move || serve(api));
    serve(app);
}
"#).unwrap();
            let binary = base.join(if cfg!(windows) {
                "listener.exe"
            } else {
                "listener"
            });
            crate::test_support::compile_fixture(&source, &binary);
            let mut child = std::process::Command::new(&binary)
                .current_dir(&owned)
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let mut line = String::new();
            std::io::BufRead::read_line(
                &mut std::io::BufReader::new(child.stdout.take().unwrap()),
                &mut line,
            )
            .unwrap();
            let numbers: Vec<u16> = line
                .split_whitespace()
                .map(|n| n.parse().unwrap())
                .collect();
            let mut app_command = std::process::Command::new(&binary);
            let descendant_file = base.join("app-listener.pid");
            if descendant {
                app_command.arg("--parent").arg(&descendant_file);
            }
            let mut app_child = app_command
                .stdin(std::process::Stdio::piped())
                .current_dir(&owned)
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let mut app_line = String::new();
            std::io::BufRead::read_line(
                &mut std::io::BufReader::new(app_child.stdout.take().unwrap()),
                &mut app_line,
            )
            .unwrap();
            let app_numbers: Vec<u16> = app_line
                .split_whitespace()
                .map(|n| n.parse().unwrap())
                .collect();
            let app_descendant_pid = descendant.then(|| {
                std::fs::read_to_string(descendant_file)
                    .unwrap()
                    .parse()
                    .unwrap()
            });
            let fixture = Self {
                base,
                selected,
                owned,
                child,
                app_child,
                app_descendant_pid,
                ports: openbot_env::Ports {
                    server: numbers[0],
                    app: app_numbers[1],
                    ..Default::default()
                },
            };
            stack::record_host_processes(
                &fixture.owned,
                &[
                    ("server", fixture.child.id()),
                    ("app", fixture.app_child.id()),
                ],
            )
            .unwrap();
            fixture
        }

        fn app(&self, root: &Path, setup: &str) -> tauri::App<tauri::test::MockRuntime> {
            let shell = Shell::default();
            remember_selected_root(&shell, root);
            *shell.setup_url.lock().unwrap() = Some(setup.into());
            let app = tauri::test::mock_builder()
                .manage(shell)
                .invoke_handler(tauri::generate_handler![start_stack])
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap();
            window
                .navigate("http://127.0.0.1:9/stale-page".parse().unwrap())
                .unwrap();
            app
        }
    }

    impl Drop for RestoreFixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            if self.app_descendant_pid.is_some() {
                // Dropping the pipe asks the fixture launcher to kill and reap its own child.
                drop(self.app_child.stdin.take());
            } else {
                let _ = self.app_child.kill();
            }
            let _ = self.app_child.wait();
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[cfg(windows)]
    #[test]
    fn restricted_engine_path_keeps_windows_credential_storage_available() {
        if crate::test_support::isolated_process(
            "tests::restricted_engine_path_keeps_windows_credential_storage_available",
        ) {
            return;
        }
        let path = SerializedPath::set_only_with("docker", "shutdown");
        let root = temp_root("openbot-restricted-path-credential-store");
        std::fs::create_dir_all(&root).unwrap();
        let saved = openbot_desktop_lib::vault::remember(
            &root,
            "OPENAI_API_KEY",
            "synthetic-path-regression-key",
        );
        std::fs::remove_dir_all(&root).expect("remove owned credential fixture");
        std::fs::remove_dir_all(path.bin()).expect("remove owned engine fixture");
        saved.expect("restricted engine PATH must retain Windows protected-storage support");
    }

    #[test]
    fn fixture_compilation_works_while_engine_path_is_replaced() {
        if crate::test_support::isolated_process(
            "tests::fixture_compilation_works_while_engine_path_is_replaced",
        ) {
            return;
        }
        let path = SerializedPath::set_only_with("docker", "shutdown");
        path.write_binary("provider", "compose-provider");
        let binary = path.bin().join(if cfg!(windows) {
            "provider.exe"
        } else {
            "provider"
        });
        let output = std::process::Command::new(binary).output().unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout)
            .contains("Docker Compose version disposable-provider"));
    }

    fn setup_navigation_config() -> tauri::utils::config::Config {
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
    }

    #[test]
    fn setup_navigation_bundled_destination_uses_platform_scheme_and_ignores_dev_server() {
        let mut config = setup_navigation_config();
        for (windows, https, expected) in [
            (false, false, "tauri://localhost/"),
            (false, true, "tauri://localhost/"),
            (true, false, "http://tauri.localhost/"),
            (true, true, "https://tauri.localhost/"),
        ] {
            config.app.windows[0].use_https_scheme = https;
            assert_eq!(
                configured_setup_url(&config, false, windows)
                    .unwrap()
                    .as_str(),
                expected,
            );
        }
    }

    #[test]
    fn setup_navigation_development_uses_configured_url_and_app_path() {
        let mut config = setup_navigation_config();
        config.build.dev_url = Some("http://localhost:4137/desktop/".parse().unwrap());
        assert_eq!(
            configured_setup_url(&config, true, true).unwrap().as_str(),
            "http://localhost:4137/desktop/",
        );
        config.app.windows[0].url = tauri::WebviewUrl::App("setup.html".into());
        assert_eq!(
            configured_setup_url(&config, true, false).unwrap().as_str(),
            "http://localhost:4137/desktop/setup.html",
        );
    }

    #[test]
    fn setup_navigation_hosted_frontend_uses_configured_production_url() {
        let mut config = setup_navigation_config();
        config.build.frontend_dist = Some(tauri::utils::config::FrontendDist::Url(
            "https://setup.example/desktop/".parse().unwrap(),
        ));
        assert_eq!(
            configured_setup_url(&config, false, true).unwrap().as_str(),
            "https://setup.example/desktop/",
        );
    }

    #[test]
    fn setup_navigation_missing_main_config_is_reported() {
        let mut config = setup_navigation_config();
        config.app.windows[0].label = "another-window".into();
        assert_eq!(
            configured_setup_url(&config, true, true).unwrap_err(),
            "the OpenBot setup window is not configured",
        );
    }

    #[test]
    fn setup_navigation_ignores_initial_blank_and_returns_after_deployment_navigation() {
        for setup in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
            "http://localhost:3020/",
        ] {
            let mut context = tauri::test::mock_context(tauri::test::noop_assets());
            context.config_mut().app.windows = vec![tauri::utils::config::WindowConfig {
                url: serde_json::from_value(serde_json::json!(setup)).unwrap(),
                ..Default::default()
            }];
            let app = tauri::test::mock_builder()
                .manage(Shell::default())
                .build(context)
                .unwrap();
            let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap();
            window.navigate("about:blank".parse().unwrap()).unwrap();
            // Restore can arrive before startup has initialized the cached destination.
            show_setup(app.handle().clone()).unwrap();
            assert_eq!(window.url().unwrap().as_str(), setup);
            window.navigate("about:blank".parse().unwrap()).unwrap();
            remember_setup_url(app.handle()).unwrap();
            show_setup(app.handle().clone()).unwrap();
            assert_eq!(window.url().unwrap().as_str(), setup);
            // Initial setup eventually loads, then a running deployment replaces it.
            window.navigate(setup.parse().unwrap()).unwrap();
            window
                .navigate("http://127.0.0.1:3000/ask".parse().unwrap())
                .unwrap();
            show_setup(app.handle().clone()).unwrap();
            assert_eq!(window.url().unwrap().as_str(), setup);
        }
    }

    #[test]
    fn restore_matches_only_the_destination_app() {
        for destination in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
            "http://localhost:3020/",
            "http://127.0.0.1:3010/",
        ] {
            let destination: tauri::Url = destination.parse().unwrap();
            assert!(
                same_window_app(&destination, &destination),
                "even identical navigation reloads the page"
            );
            assert!(same_window_app(
                &destination.join("ask?thread=existing#message").unwrap(),
                &destination
            ));
            for unrelated in [
                "about:blank",
                "http://127.0.0.1:9/stale-page",
                "https://example.com/",
            ] {
                assert!(!same_window_app(&unrelated.parse().unwrap(), &destination));
            }
        }
        assert!(!same_window_app(
            &"http://localhost:3020/".parse().unwrap(),
            &"http://localhost:3010/".parse().unwrap()
        ));
        assert!(!same_window_app(
            &"http://tauri.localhost/".parse().unwrap(),
            &"https://tauri.localhost/".parse().unwrap()
        ));
    }

    #[test]
    fn restore_window_preserves_setup_location_when_runtime_is_unavailable() {
        let f = RestoreFixture::new();
        for setup in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "http://localhost:3020/",
        ] {
            let app = f.app(&f.selected, setup);
            let window = app.get_webview_window("main").unwrap();
            let current = format!("{setup}#credentials");
            window.navigate(current.parse().unwrap()).unwrap();
            window.hide().unwrap();
            restore_window_on(app.handle(), &f.ports);
            assert_eq!(window.url().unwrap().as_str(), current);
            assert!(window.is_visible().unwrap());
        }
    }

    #[test]
    fn restore_window_preserves_owned_app_route() {
        let f = RestoreFixture::new();
        let app = f.app(&f.owned, "tauri://localhost/");
        let window = app.get_webview_window("main").unwrap();
        let current = format!(
            "http://127.0.0.1:{}/ask?thread=existing#message",
            f.ports.app
        );
        window.navigate(current.parse().unwrap()).unwrap();
        restore_window_on(app.handle(), &f.ports);
        assert_eq!(window.url().unwrap().as_str(), current);
    }

    #[test]
    fn reopening_uses_persisted_ports_and_still_requires_deployment_ownership() {
        let f = RestoreFixture::new();
        for root in [&f.owned, &f.selected] {
            openbot_env::write(
                &root.join(".env"),
                &f.ports.settings(),
                &std::collections::BTreeMap::new(),
            )
            .unwrap();
        }
        let app = f.app(&f.owned, "tauri://localhost/");
        assert_eq!(ports_for_shell(app.handle()).unwrap(), f.ports);
        assert!(already_running(
            app.handle().clone(),
            f.owned.to_string_lossy().into_owned()
        ));
        tauri::async_runtime::block_on(show_openbot(app.handle().clone())).unwrap();
        assert_eq!(
            app.get_webview_window("main")
                .unwrap()
                .url()
                .unwrap()
                .port(),
            Some(f.ports.app)
        );
        let other = f.app(&f.selected, "tauri://localhost/");
        assert!(!already_running(
            other.handle().clone(),
            f.selected.to_string_lossy().into_owned()
        ));
        assert!(tauri::async_runtime::block_on(show_openbot(other.handle().clone())).is_err());
    }

    #[test]
    fn restore_window_refuses_answering_other_deployment_and_shows_recorded_setup() {
        let f = RestoreFixture::new();
        assert!(server_capabilities_answer(f.ports.server));
        assert!(stack::app_url(f.ports.app).is_some());
        assert!(!stack::recorded_server_owns_port(&f.selected, f.ports.server).unwrap());
        assert!(stack::recorded_server_owns_port(&f.owned, f.ports.server).unwrap());
        for setup in ["tauri://localhost/", "http://tauri.localhost/"] {
            let app = f.app(&f.selected, setup);
            restore_window_on(app.handle(), &f.ports);
            assert_eq!(
                app.get_webview_window("main")
                    .unwrap()
                    .url()
                    .unwrap()
                    .as_str(),
                setup,
                "tray/reopen must not adopt an unrelated successful app-port responder"
            );
        }
    }

    #[test]
    fn showing_owned_organization_app_requires_its_session_without_forgetting_installation() {
        let f = RestoreFixture::new();
        std::fs::write(
            f.owned.join(".env"),
            "OPENBOT_ORGANIZATION_AUTH_URL=https://company.example\n",
        )
        .unwrap();
        let app = f.app(&f.owned, "tauri://localhost/");
        let window = app.get_webview_window("main").unwrap();
        let before = window.url().unwrap();
        let failure = show_openbot_on(app.handle().clone(), &f.ports).unwrap_err();
        assert_eq!(
            failure.connection,
            Some(openbot_desktop_lib::problem::Connection::Organization)
        );
        assert_eq!(
            window.url().unwrap(),
            before,
            "no unauthenticated navigation"
        );
        assert_eq!(
            app.state::<Shell>().selected_root.lock().unwrap().as_ref(),
            Some(&f.owned)
        );
        assert!(stack::recorded_server_owns_port(&f.owned, f.ports.server).unwrap());
    }

    #[test]
    fn restore_window_owned_runtime_opens_app_and_active_root_takes_precedence() {
        let f = RestoreFixture::new();
        for active in [false, true] {
            let app = f.app(
                if active { &f.selected } else { &f.owned },
                "tauri://localhost/",
            );
            if active {
                *app.state::<Shell>().root.lock().unwrap() = Some(f.owned.clone());
            }
            restore_window_on(app.handle(), &f.ports);
            assert_eq!(
                app.get_webview_window("main")
                    .unwrap()
                    .url()
                    .unwrap()
                    .as_str(),
                format!("http://127.0.0.1:{}/", f.ports.app)
            );
        }
    }

    #[test]
    fn restore_window_unavailable_runtime_replaces_stale_page_with_setup() {
        let mut f = RestoreFixture::new();
        f.child.kill().unwrap();
        f.child.wait().unwrap();
        let app = f.app(&f.owned, "tauri://localhost/");
        restore_window_on(app.handle(), &f.ports);
        assert_eq!(
            app.get_webview_window("main")
                .unwrap()
                .url()
                .unwrap()
                .as_str(),
            "tauri://localhost/"
        );
    }

    #[test]
    fn restore_window_unproven_identity_shows_setup_without_losing_selected_root() {
        let f = RestoreFixture::new();
        std::fs::write(f.owned.join(".logs/host-pids.json"), "not-json").unwrap();
        let app = f.app(&f.owned, "tauri://localhost/");
        restore_window_on(app.handle(), &f.ports);
        assert_eq!(
            app.get_webview_window("main")
                .unwrap()
                .url()
                .unwrap()
                .as_str(),
            "tauri://localhost/"
        );
        assert_eq!(
            app.state::<Shell>()
                .selected_root
                .lock()
                .unwrap()
                .as_deref(),
            Some(f.owned.as_path())
        );
    }
    #[test]
    fn app_adoption_and_restore_refuse_foreign_app_with_owned_api_still_running() {
        let f = RestoreFixture::new();
        stack::record_host_processes(&f.owned, &[("server", f.child.id())]).unwrap();
        stack::record_host_processes(&f.selected, &[("app", f.app_child.id())]).unwrap();
        assert!(already_running_on(
            &f.owned,
            f.ports.server,
            stack::recorded_server_owns_port
        ));
        assert!(stack::app_url(f.ports.app).is_some());
        let initial_adoption = already_running_at(&f.owned, &f.ports);
        let app = f.app(&f.owned, "tauri://localhost/");
        let shown = show_openbot_on(app.handle().clone(), &f.ports);
        restore_window_on(app.handle(), &f.ports);
        let destination = app.get_webview_window("main").unwrap().url().unwrap();
        assert!(!initial_adoption && shown.is_err() && destination.as_str() == "tauri://localhost/",
            "owned API must not authorize a foreign app: initial={initial_adoption}, shown={shown:?}, restore={destination}");
    }

    #[test]
    fn app_adoption_and_restore_allow_owned_app_direct_and_launcher_descendant() {
        for descendant in [false, true] {
            let f = RestoreFixture::with_app_descendant(descendant);
            assert_ne!(f.child.id(), f.app_child.id());
            if descendant {
                assert_ne!(f.app_descendant_pid.unwrap(), f.app_child.id());
            }
            assert!(already_running_at(&f.owned, &f.ports));
            let app = f.app(&f.owned, "tauri://localhost/");
            show_openbot_on(app.handle().clone(), &f.ports).unwrap();
            restore_window_on(app.handle(), &f.ports);
            assert_eq!(
                app.get_webview_window("main")
                    .unwrap()
                    .url()
                    .unwrap()
                    .as_str(),
                format!("http://127.0.0.1:{}/", f.ports.app)
            );
        }
    }
}
