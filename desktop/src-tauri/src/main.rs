// A window, not a console. Release builds on Windows must not open one behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

mod desktop_connection;
mod desktop_host_access;
mod desktop_page;
mod desktop_stall;
mod desktop_status;
mod desktop_telemetry;
mod intelligence_bridge;
mod notice;
mod outside_links;
mod zoom;

#[cfg(test)]
mod test_support;

use openbot_desktop_lib::{
    acquire, app_update, deployment, deployment_release, docker_config, early_downloads, engine,
    engine_versions, env as openbot_env, harness, host_access, install, local_eval,
    local_eval_state, logging, own_machine, preparation,
    problem::{LeftoverReset, Problem},
    provider, pull_metrics, quiet, recorder_external, recorder_host, recorder_install, stack,
    telemetry, tray, troubleshooting, update_ready, upgrade, windows as win,
};

const QUIT_CLEANUP_NOTICE_FILE: &str = ".openbot-quit-cleanup-notice";
/// Kept apart from the quit cleanup notice, whose presence alone means OpenBot needs recovery.
const LOCAL_EVAL_STOP_NOTICE_FILE: &str = ".openbot-local-eval-stop-notice";
/// How an Intelligence failure starts, so Stop and Quit can tell it from OpenBot's own.
const INTELLIGENCE_STOP_FAILED: &str = "Backend stop failed: ";
const QUIT_MENU_ACCELERATOR: &str = "CmdOrCtrl+KeyQ";
const QUIT_CLEANUP_NOTICE_LIMIT: usize = 16 * 1024;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// What the shell is running, so the window and the tray say the same thing.
#[derive(Default)]
struct Shell {
    /// An upgrade, or the app updating itself, excludes ordinary Start/Repair without replacing
    /// the supervisor.
    updating: std::sync::atomic::AtomicBool,
    update_cancelled: std::sync::atomic::AtomicBool,
    /// Session-only local folder authority; shutdown retires it before stopping the API server.
    host_access: Mutex<Option<host_access::HostAccess>>,
    /// Native Linux engine API owned by this desktop session, kept through Stop/Start.
    #[cfg(target_os = "linux")]
    podman_api: Mutex<engine::local_api::Service>,
    /// Which run is the current one.
    ///
    /// Stopping and starting again inside two seconds would otherwise leave the previous run's
    /// connection watcher alive beside the new one, both sending the window back to setup for the
    /// same refusal, and a recovery marked by the old run would outlive the run that cleared it.
    generation: std::sync::atomic::AtomicU64,
    /// Cancellation of pending Start is independent of the hosts still serving the previous run.
    start_generation: std::sync::atomic::AtomicU64,
    /// Stop serializes with synchronous startup side effects, never with an async wait.
    startup: Mutex<()>,
    /// A cancelled attempt must finish unwinding before another starts.
    starting: std::sync::atomic::AtomicBool,
    /// An explicit Stop must survive setup navigation; a new app session may resume again.
    stopped_in_session: std::sync::atomic::AtomicBool,
    /// Settings asked to change the AI connection, and the Stop it asked for finished: the setup
    /// page opens at its AI screen, once, instead of at Start.
    change_ai_connection: std::sync::atomic::AtomicBool,
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
    /// An explicit reset remains bound to the engine and the exact volumes it offered.
    leftover_database: Mutex<Option<LeftoverDatabase>>,
    selected_root: Mutex<Option<PathBuf>>,
    root: Mutex<Option<PathBuf>>,
    /// Containers may outlive a failed Start before any host root is published.
    containers: Mutex<Option<ContainerDeployment>>,
    /// A verified down allows a following Stop/Quit to be an idempotent no-op.
    stopped_container_root: Mutex<Option<PathBuf>>,
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
    /// The installation whose back end dashboard the app page may open (`intelligence_bridge`),
    /// while the window is in local mode with a recorded stack. None offers nothing.
    intelligence_menu: Mutex<Option<PathBuf>>,
    /// An opening is running; another asked for meanwhile does nothing.
    intelligence_opening: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Dashboard addresses and this session's sign-ins, so a later opening needs no CLI call.
    dashboards: Dashboards,
    /// The OpenBot app page's sidebar row, and the app origins allowed to reach it.
    intelligence_bridge: intelligence_bridge::Bridge,
    /// The origins of the OpenBot app this shell verified it owns (`trust_owned_app`). Only a page
    /// from one of these is treated as OpenBot and gets the window's controls; any other page on
    /// a loopback port is someone else's.
    owned_app_origins: Mutex<Vec<String>>,
    /// The origins already given the window's controls (`allow_app_page`).
    app_page_grants: Mutex<Vec<String>>,
    /// Whether the app was built with the permissions `allow_app_page` grants (`generate_context!`),
    /// so `trust_owned_app` can grant them ahead of the page. Tauri panics on a grant of a
    /// permission it does not know, as in a test app built from a mock context.
    app_page_grants_known: std::sync::atomic::AtomicBool,
    /// The page a click on a notification asked for while OpenBot's page was not there yet.
    waiting_notice_page: Mutex<Option<String>>,
    /// A newer OpenBot Desktop, as the feed last said, and an install of it under way.
    app_update: app_update::Known,
    /// Wakes the thread that gets a newer version ready when the feed names one.
    update_ready: update_ready::Nudge,
}

/// The deployment whose Compose up may have created containers, including a partial failure.
/// Independent of the editable selection and host ownership. Change this ownership while
/// holding `Shell::startup`; capture before up and release only after its down succeeds. Keeping
/// it in one record lets shutdown carry further deployment identity without changing host state.
struct ContainerDeployment {
    root: PathBuf,
    address: engine::Address,
}

#[derive(Clone)]
struct LeftoverDatabase {
    root: PathBuf,
    /// Sorted, exactly as offered: the only set a confirmation may remove.
    volumes: Vec<String>,
    /// Sorted names of the stopped containers removed before those volumes.
    containers: Vec<String>,
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
        if shell.updating.load(SeqCst) && shell.update_cancelled.load(SeqCst) {
            return Err(Self::cancelled());
        }
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
    /// Install's image downloads, while they run: see `pull_metrics::Downloads`.
    #[serde(skip_serializing_if = "Option::is_none")]
    downloads: Option<pull_metrics::Downloads>,
    /// The detail sends the person to another app's window: see `engine::StepLine`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    elsewhere: bool,
    /// The step waits for the person's go-ahead in this window: see `install::GoAhead`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    asks: bool,
    /// The engine itself is being updated: see `engine::StepLine::updating`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    updating: bool,
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

/// The engine the install step left answering, if it left one.
///
/// Starting Docker Desktop leaves Docker answering, and the machine steps after the install step
/// are Podman's: on a Mac or a PC without Podman, the first of them fails at `podman machine list`
/// with Docker already running. A Podman the step installed or found answers only once its
/// machine is up, so it is `None` here and the machine steps run.
fn answering_after_install(
    ready: &engine::EngineStatus,
    composes: impl FnOnce(&engine::Address) -> bool,
) -> Result<Option<engine::Address>, Problem> {
    let Some(address) = ready.address.clone().filter(|_| ready.responding) else {
        return Ok(None);
    };
    if !composes(&address) {
        return Err(Problem::plain(acquire::missing_compose(
            address.engine.binary(),
        )));
    }
    Ok(Some(address))
}

struct ReadyRespondingEngine {
    address: engine::Address,
    detail: String,
    installed: Option<String>,
}

/// What Start does first, so the engine this installation runs on is answering.
///
/// Install brings the engine up; Start used to only look for it. So after a restart a Podman
/// installation's machine was stopped and Start failed with "podman is installed but not
/// answering", which nobody this app is for can act on. Now the saved engine is brought up:
///
/// - Docker: a stopped Docker Desktop is opened. It answered for this installation before.
/// - Podman, or an installation from before engines were saved: OpenBot's own machine is
///   started, when it exists. A machine is never created here, and nobody else's is started.
///
/// An engine that still does not answer is reported by the check after this one. An older
/// installation that was on Docker cannot land on an empty machine: Start requires the
/// installation's images on the engine it uses before it runs or saves anything.
fn wake_saved_engine(
    saved: Option<engine::Engine>,
    engine_in_a_machine: bool,
    answers: impl FnOnce() -> bool,
    open_docker_desktop: impl FnOnce() -> Result<(), Problem>,
    our_machine_exists: impl FnOnce() -> bool,
    start_our_machine: impl FnOnce() -> Result<(), Problem>,
) -> Result<(), Problem> {
    if answers() {
        return Ok(());
    }
    match saved {
        Some(engine::Engine::Docker) => open_docker_desktop(),
        Some(engine::Engine::Podman) | None => {
            if engine_in_a_machine && our_machine_exists() {
                start_our_machine()
            } else {
                Ok(())
            }
        }
    }
}

/// What Start does to the engine before Compose reads the project, in this order: bring the
/// installation's engine up (`wake_saved_engine`), then make sure it is new enough to run OpenBot,
/// updating it for the person when it is not (`engine_new_enough`).
///
/// Before Compose, because an old Compose stops at its first look at the project ("Compose config
/// exited with exit status: 15"). Not while OpenBot's own containers are up: the caller skips this,
/// so Docker Desktop is never quit from under a running OpenBot. An engine still not answering is
/// left to the check after this one, which says so.
async fn engine_before_compose(
    wake: impl AsyncFnOnce() -> Result<(), Problem>,
    answering: impl AsyncFnOnce() -> Option<engine::Address>,
    new_enough: impl AsyncFnOnce(engine::Address) -> Result<(), Problem>,
) -> Result<(), Problem> {
    wake().await?;
    match answering().await {
        Some(address) => new_enough(address).await,
        None => Ok(()),
    }
}

/// `wake_saved_engine` on this machine, each line said on the setup window's rows. Opening Docker
/// Desktop says the hand-off and brings OpenBot back once Docker answers: see
/// `docker_desktop::start`.
async fn wake_installation_engine<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    saved: Option<engine::Engine>,
) -> Result<(), Problem> {
    let progress_app = app.clone();
    let ticket = app
        .state::<Shell>()
        .start_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        wake_saved_engine(
            saved,
            cfg!(any(target_os = "macos", target_os = "windows")),
            || engine::detect_saved(saved).responding,
            || {
                let mut said = false;
                let started = openbot_desktop_lib::docker_desktop::start_saved(
                    &mut |line| {
                        said = true;
                        report_running_line(&progress_app, "engine", line, None)
                    },
                    &|| bring_to_front(&progress_app, "Docker Desktop answers"),
                );
                // The row that said the hand-off ends, so the window stops saying it.
                if said {
                    match &started {
                        Ok(()) => report_plain(
                            &progress_app,
                            "engine",
                            true,
                            "Docker Desktop is running.",
                        ),
                        Err(problem) => {
                            report_plain(&progress_app, "engine", false, problem.said.clone())
                        }
                    }
                }
                started
            },
            || acquire::machine_exists().unwrap_or(false),
            || {
                // On a Mac where the person's own Podman machine is running again, only once they
                // said yes to pausing it. Stop or Quit while that waits ends it, said on its row.
                let started = start_own_machine(&progress_app, &|| {
                    progress_app
                        .state::<Shell>()
                        .start_generation
                        .load(std::sync::atomic::Ordering::SeqCst)
                        != ticket
                })?;
                report(
                    &progress_app,
                    "start-machine",
                    started.ok,
                    started.said.clone(),
                );
                if started.ok {
                    Ok(())
                } else {
                    Err(started.problem())
                }
            },
        )
    })
    .await
    .map_err(|error| {
        Problem::with(
            "OpenBot could not start the software it runs on. Try again.",
            error.to_string(),
        )
    })?
}

/**
The installation's engine, brought up before the back end is set up, connected or waited on.

A relaunch after a restart finds Docker Desktop quit, or OpenBot's Podman machine stopped, and every
Intelligence CLI call needs the engine. The window's relaunch sequence starts with the CLI, so
before this, the CLI answered "docker-unavailable" and setup stopped at "Waiting for the back end",
never reaching Start, which is where the engine used to be woken. Nothing is done while OpenBot's
own containers are up, or when the engine already answers.
*/
#[tauri::command]
async fn wake_engine(app: tauri::AppHandle, root: String) -> Result<(), Problem> {
    let root = stack::root_from(&root);
    if app.state::<Shell>().containers.lock().unwrap().is_some() {
        return Ok(());
    }
    let asked = std::time::Instant::now();
    let saved = preparation::saved_engine(&root);
    let woken = match wake_installation_engine(&app, saved).await {
        Ok(()) => heal_installation_engine(&app, saved).await,
        failed => failed,
    };
    logging::outcome("wake engine", asked, &woken);
    woken
}

/**
A Podman machine that answers `podman` while its Docker API has gone, stopped and started once
before the back end is asked (`engine_versions::answering_now`).

The back end's own check reaches the engine through that API and says only "docker_unavailable",
and setup then waited on it. Setup and Start heal it in their own check (`engine_new_enough`); this
is the same for a relaunch, and for Retry after it, which runs this again. Said on the machine's row.
*/
async fn heal_installation_engine<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    saved: Option<engine::Engine>,
) -> Result<(), Problem> {
    if !cfg!(any(target_os = "macos", target_os = "windows"))
        || saved == Some(engine::Engine::Docker)
    {
        return Ok(());
    }
    let progress_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let found = engine::detect_saved(saved);
        let Some(address) = found.address.filter(|_| found.responding) else {
            return Ok(());
        };
        let engine = address.engine;
        let back = || {};
        let cancelled = || false;
        let mut updates = engine_versions::OnThisMachine {
            address,
            cache: stack::default_root(),
            back: &back,
            cancelled: &cancelled,
        };
        let mut said = false;
        let healed = engine_versions::answering_now(
            engine,
            std::env::consts::OS,
            &mut updates,
            &mut |line| {
                said = true;
                report_running_line(&progress_app, "start-machine", line, None)
            },
        );
        if said {
            match &healed {
                Ok(_) => report_plain(
                    &progress_app,
                    "start-machine",
                    true,
                    engine::engine_ready_line().said,
                ),
                Err(problem) => {
                    report_plain(&progress_app, "start-machine", false, problem.said.clone())
                }
            }
        }
        healed.map(|_| ())
    })
    .await
    .map_err(|error| {
        Problem::with(
            "OpenBot could not start the software it runs on. Try again.",
            error.to_string(),
        )
    })?
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
                "OpenBot installed the software it runs on, but it isn't answering yet. Try again."
            } else {
                "OpenBot installed a piece it needs, but the software it runs on isn't answering yet. \
                 Try again."
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

/// Every row step the native side reports, each with a plain line of its own (`plain_row`). The
/// tests hold each step in this file to it.
#[cfg(test)]
const ROW_STEPS: [&str; 17] = [
    "engine",
    "install-engine",
    "create-machine",
    "start-machine",
    "health-gate",
    "deployment",
    "images",
    "installation",
    "env",
    "services",
    "carry-over",
    "answering",
    "release",
    "cleanup",
    "stopped",
    "open",
    "quit",
];

/**
What a row says in the window when its step gives no plain line of its own: by the step, and
whether it is running, done or stopped. The text it was given goes to the log only.

Found on Windows F: "Downloading OpenBot internal-d2df1b062ac0." reached the Account step's
background row, because the deployment step's line was sent as it was, a release name and all. A
row's raw text can be a release, an engine's output or an error, so it is never what the window
says unless it comes as a plain line (`report_line`, `report_running_line`).
*/
fn plain_row(step: &str, ok: bool, running: bool) -> &'static str {
    if !ok {
        return "This part stopped. What happened is said below.";
    }
    if running {
        return match step {
            "engine" | "install-engine" | "create-machine" | "start-machine" | "health-gate" => {
                "Preparing this computer to run OpenBot."
            }
            "deployment" | "images" => "Downloading OpenBot.",
            "installation" => "Finishing the installation.",
            "env" => "Saving your settings.",
            "services" => "Starting OpenBot's services.",
            "carry-over" => "Bringing your Bots' files and sign-ins across.",
            "answering" => "Waiting for OpenBot to respond.",
            "release" => "Updating OpenBot.",
            "cleanup" | "stopped" | "quit" => "Stopping OpenBot.",
            "open" => "Opening OpenBot.",
            _ => "Working on it.",
        };
    }
    match step {
        "engine" | "install-engine" | "create-machine" | "start-machine" | "health-gate" => {
            "This computer is ready to run OpenBot."
        }
        "deployment" | "images" => "OpenBot is downloaded.",
        "installation" => "OpenBot is installed.",
        "env" => "Your settings are saved.",
        "services" => "OpenBot's services are running.",
        "carry-over" => "Your Bots' files and sign-ins are in place.",
        "answering" | "open" => "OpenBot is ready.",
        "release" => "OpenBot is updated.",
        "cleanup" | "stopped" | "quit" => "OpenBot has stopped.",
        _ => "Done.",
    }
}

/// A row whose text has no plain register of its own: `plain_row` in the window, and the text it
/// was given in the log beside it.
fn unregistered_line(step: &str, ok: bool, running: bool, text: String) -> engine::StepLine {
    engine::StepLine::here(plain_row(step, ok, running)).logged(text)
}

fn report<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    step: &str,
    ok: bool,
    detail: impl Into<String>,
) {
    report_line(
        app,
        step,
        ok,
        unregistered_line(step, ok, false, detail.into()),
    );
}

/// A finished step's line, said plainly in the window, with its technical detail in the log only.
fn report_line<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    step: &str,
    ok: bool,
    line: engine::StepLine,
) {
    let entry = line.log_entry();
    let detail = line.said;
    // Every row setup shows goes in the log too, so the file reads as the window did.
    if ok {
        log::info!("[step {step}] {entry}");
    } else {
        log::error!("[step {step}] failed: {entry}");
    }
    forget_running_logged();
    desktop_stall::row_done(app, step);
    if !ok {
        // The row's step, and a class from the step or, where the step says nothing, its words.
        // Only the two enums are recorded, never the words.
        let failing = telemetry::FailingStep::from_row(step);
        desktop_telemetry::setup_failed(
            app,
            desktop_telemetry::SetupFailure::new(
                failing,
                desktop_telemetry::class_of_row(failing, &detail),
            ),
        );
    }
    emit_progress(
        app,
        Progress {
            step: step.into(),
            ok,
            detail,
            running: false,
            download_bytes: None,
            downloads: None,
            elsewhere: false,
            asks: false,
            updating: false,
        },
    );
}

/// A row's progress to the setup page, numbered: the page's heartbeat says back the highest number
/// it has taken, so a page that stops taking them is noticed (`desktop_stall`).
fn emit_progress<R: tauri::Runtime>(app: &tauri::AppHandle<R>, progress: Progress) {
    #[derive(Serialize, Clone)]
    struct Numbered {
        seq: u64,
        #[serde(flatten)]
        progress: Progress,
    }
    let seq = desktop_stall::sent(app, &progress.step);
    let _ = app.emit("setup:progress", Numbered { seq, progress });
}

/// The setup page's heartbeat, every few seconds while its setup, start or update screens show and
/// as soon as a row's progress reaches it: the highest progress number it has taken, and whether it
/// has just loaded. Off the main thread, and it waits on nothing.
#[tauri::command]
async fn setup_heartbeat(app: tauri::AppHandle, seen: u64, fresh: bool) {
    desktop_stall::heartbeat(&app, seen, fresh);
}

/// The running step last written to the log, so a step that says the same thing on every poll
/// (an engine that is still starting) is one entry rather than one a second.
static RUNNING_LOGGED: Mutex<Option<(String, String)>> = Mutex::new(None);

/// The part of a Start or install under way, by its row's name, for the usage data of a failure
/// that returns before any row says it failed (`desktop_telemetry::unreported_failure`). Set by
/// every running row, and by `setup_phase` where Start does work no row shows.
static SETUP_PHASE: Mutex<Option<telemetry::FailingStep>> = Mutex::new(None);

fn setup_phase(step: &str) {
    *SETUP_PHASE.lock().unwrap_or_else(|held| held.into_inner()) =
        Some(telemetry::FailingStep::from_row(step));
}

fn current_setup_phase() -> telemetry::FailingStep {
    SETUP_PHASE
        .lock()
        .unwrap_or_else(|held| held.into_inner())
        .unwrap_or(telemetry::FailingStep::Start)
}

/// Refusals that are not a failure of setup: Start cancelled by Stop, one already under way, or an
/// update in progress. None of them is recorded as `setup_failed`.
fn refused_not_failed(problem: &Problem) -> bool {
    problem.said == StartAttempt::cancelled().said
        || problem.said.starts_with("OpenBot is already starting")
        || problem.said.starts_with("OpenBot is updating.")
}

fn forget_running_logged() {
    *RUNNING_LOGGED
        .lock()
        .unwrap_or_else(|held| held.into_inner()) = None;
}

/// Each running step's latest line, so a download added to its row keeps what the row says.
static RUNNING_SAID: Mutex<std::collections::BTreeMap<String, engine::StepLine>> =
    Mutex::new(std::collections::BTreeMap::new());

fn report_running<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    step: &str,
    detail: impl Into<String>,
    download_bytes: Option<u64>,
) {
    report_running_line(
        app,
        step,
        unregistered_line(step, true, true, detail.into()),
        download_bytes,
    );
}

/// A row's own plain line, said as it is: for a sentence written for the window, or a `Problem`'s
/// headline, which is plain by construction.
fn report_plain<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    step: &str,
    ok: bool,
    said: impl Into<String>,
) {
    report_line(app, step, ok, engine::StepLine::here(said));
}

/// A running row's own plain line, said as it is.
fn report_running_plain<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    step: &str,
    said: impl Into<String>,
) {
    report_running_line(app, step, engine::StepLine::here(said), None);
}

/// A running step's line, marked when it sends the person to another app's window.
fn report_running_line<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    step: &str,
    line: engine::StepLine,
    download_bytes: Option<u64>,
) {
    RUNNING_SAID
        .lock()
        .unwrap_or_else(|held| held.into_inner())
        .insert(step.to_owned(), line.clone());
    // The window shows the plain line; the log keeps the technical detail beside it.
    let entry = line.log_entry();
    let engine::StepLine {
        said: detail,
        elsewhere,
        asks,
        updating,
        detail: _,
    } = line;
    setup_phase(step);
    desktop_stall::row_running(app, step, &detail);
    {
        let mut logged = RUNNING_LOGGED
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let now = (step.to_owned(), entry.clone());
        if logged.as_ref() != Some(&now) {
            log::info!("[step {step}] {entry}");
            *logged = Some(now);
        }
    }
    emit_progress(
        app,
        Progress {
            step: step.into(),
            ok: true,
            detail,
            running: true,
            download_bytes,
            downloads: None,
            elsewhere,
            asks,
            updating,
        },
    );
}

/// OpenBot's window in front of whatever is there, at a moment setup needs the person: Docker
/// Desktop has answered, the system's password prompt has closed, the installation failed or is
/// done, OpenBot has started. `why` goes in the log.
///
/// On macOS that means activating the app, not only ordering its window to the front. A window an
/// inactive app orders front stays behind the active app's. Tauri's `set_focus` does both: tao
/// sends `makeKeyAndOrderFront:` and then `activateIgnoringOtherApps:YES`. macOS 14 deprecated that
/// call for `activate`, which is cooperative: it works only if the app in front yields, and Docker
/// Desktop does not. Measured on macOS 26.6 with Finder in front: `activateIgnoringOtherApps:YES`
/// brought a regular app forward, while `activate` and `NSRunningApplication`'s `activate` left it
/// behind. So the deprecated call, through `set_focus`, is the one used. `AppHandle::show` first
/// unhides an app hidden with Command-H, which `set_focus` does not.
///
/// On Windows it is `SetForegroundWindow`, and when Windows refuses it (another app holds the
/// foreground, as the browser does during sign-in) the taskbar button flashes instead. Never tao's
/// `set_focus` there: past a refusal it presses and releases Alt to get by the foreground lock
/// (`force_window_active`), and a lone Alt can put a WebView2 window into menu mode, which only a
/// click, Alt+Tab or Esc ends. On Windows F setup froze for minutes right after "[front] the engine
/// machine is prepared" with the browser in front. `set_focus` does nothing to a hidden or
/// minimised window, hence `show` and `unminimize` first.
fn bring_to_front<R: tauri::Runtime>(app: &tauri::AppHandle<R>, why: &str) {
    if held_back(why) {
        return;
    }
    log::info!("[front] {why}");
    #[cfg(target_os = "macos")]
    let _ = app.show();
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().ok().map(|hwnd| hwnd.0 as isize);
        let why = why.to_owned();
        // On the window's own thread, as `notice::bring_to_front` is.
        let _ = app.run_on_main_thread(move || {
            let front = come_forward(
                || {
                    hwnd.is_some_and(|hwnd| {
                        use windows::Win32::Foundation::HWND;
                        use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
                        // SAFETY: `hwnd` is this window's live handle, read just now.
                        unsafe { SetForegroundWindow(HWND(hwnd as *mut core::ffi::c_void)) }
                            .as_bool()
                    })
                },
                || {
                    let _ = window
                        .request_user_attention(Some(tauri::UserAttentionType::Informational));
                },
            );
            if front == Front::Flashed {
                log::info!(
                    "[front] {why}: Windows kept another window in front; flashed the taskbar"
                );
            }
        });
    }
    #[cfg(not(windows))]
    let _ = window.set_focus();
}

/// The browser sign-in is open (`sign_in_to_copilotkit`): the person is in their browser.
static SIGN_IN_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/**
Whether `bring_to_front` holds OpenBot back, and says so in the log: while the browser sign-in is
open, nothing setup does is the person's next step. On Windows F, "[front] the engine machine is
prepared" brought OpenBot in front of the browser while the person typed their email to sign in.
When the sign-in ends, OpenBot comes forward once (`while_signing_in`): the license agreement is
the person's next step then.
*/
fn held_back(why: &str) -> bool {
    let held = SIGN_IN_OPEN.load(std::sync::atomic::Ordering::SeqCst);
    if held {
        log::info!("[front] held back: sign-in open in the browser ({why})");
    }
    held
}

/// Marks the browser sign-in open while it lives, and closed when it is dropped, however the
/// sign-in ends.
struct SignInOpen;

impl SignInOpen {
    fn begin() -> Self {
        SIGN_IN_OPEN.store(true, std::sync::atomic::Ordering::SeqCst);
        Self
    }
}

impl Drop for SignInOpen {
    fn drop(&mut self) {
        SIGN_IN_OPEN.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Run the browser sign-in, with OpenBot held back from the front meanwhile, then bring it forward
/// once, whatever the sign-in's outcome: what comes next is the person's.
fn while_signing_in<T>(sign_in: impl FnOnce() -> T, come_forward: impl FnOnce()) -> T {
    let open = SignInOpen::begin();
    let ended = sign_in();
    drop(open);
    come_forward();
    ended
}

/// How OpenBot's window came forward on Windows (`bring_to_front`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
enum Front {
    /// `SetForegroundWindow` put it in front.
    Came,
    /// Windows refused, and the taskbar button flashes for the person to come to it.
    Flashed,
}

/// Bring the window forward with `set_foreground`, and if Windows refuses, `flash` its taskbar
/// button. Nothing else: no key pressed or released on the person's behalf.
#[cfg_attr(not(windows), allow(dead_code))]
fn come_forward(set_foreground: impl FnOnce() -> bool, flash: impl FnOnce()) -> Front {
    if set_foreground() {
        Front::Came
    } else {
        flash();
        Front::Flashed
    }
}

/// The setup window asks to come to the front: its installation finished or failed, and the next
/// step is the person's. See `bring_to_front`.
#[tauri::command]
fn bring_setup_to_front(app: tauri::AppHandle, why: String) {
    bring_to_front(&app, &why);
}

/// The person said yes to pausing their Podman while OpenBot runs. See `own_machine`. False when
/// nothing was waiting for it.
#[tauri::command]
fn allow_pause_podman() -> bool {
    let waiting = own_machine::allow_pause();
    log::info!(
        "[engine] the go-ahead to pause the person's Podman{}",
        if waiting {
            ""
        } else {
            ", with nothing waiting for it"
        }
    );
    waiting
}

/**
OpenBot's own machine started, as setup and a relaunch start it, each line said on the window's rows.

On a Mac, where Podman runs one machine at a time, a machine of the person's that is running keeps
it from starting. The window then says why on its `own_machine::PAUSE_STEP` row and waits for the
person's yes, and only then is theirs paused. Quit starts it again (`give_back_paused_podman`).
`cancelled` (Stop or Quit) ends that wait with nothing paused. Elsewhere it simply starts.
*/
fn start_own_machine<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    cancelled: &dyn Fn() -> bool,
) -> Result<acquire::StepOutcome, Problem> {
    let paused = std::cell::Cell::new(false);
    let started = own_machine::start_own_with(
        &mut own_machine::ThisComputer,
        &own_machine::record_path(),
        own_machine::one_machine_at_a_time(std::env::consts::OS),
        acquire::MACHINE,
        &mut |theirs| {
            let offer = own_machine::pause_offer(theirs);
            let given = own_machine::PAUSE_GATE.wait(
                || {
                    report_running_line(app, own_machine::PAUSE_STEP, offer, None);
                    bring_to_front(app, "OpenBot asks to pause the person's Podman");
                },
                cancelled,
            );
            if let Err(problem) = &given {
                report_plain(app, own_machine::PAUSE_STEP, false, problem.said.clone());
            }
            given
        },
        &mut |line| {
            paused.set(true);
            report_running_line(app, own_machine::PAUSE_STEP, line, None)
        },
        &mut || {
            report_running_line(app, "start-machine", engine::starting_machine_line(), None);
            acquire::start_machine()
        },
    );
    match &started {
        Ok(_) if paused.get() => {
            report_plain(app, own_machine::PAUSE_STEP, true, own_machine::PAUSED)
        }
        Err(problem) if paused.get() => {
            report_plain(app, own_machine::PAUSE_STEP, false, problem.said.clone())
        }
        _ => {}
    }
    started
}

/// Quit's last part on a Mac whose Podman OpenBot paused: OpenBot's machine stopped, and the
/// person's started again with its containers. See `own_machine::give_back_with`. Nothing at all
/// when OpenBot paused nothing.
fn give_back_paused_podman(progress: &mut dyn FnMut(QuitStep, QuitStepState)) {
    let record = own_machine::record_path();
    if !own_machine::has_paused(&record) {
        return;
    }
    progress(QuitStep::GiveBackPodman, QuitStepState::Running);
    let given =
        own_machine::give_back_with(&mut own_machine::ThisComputer, &record, acquire::MACHINE);
    if let Err(error) = &given {
        log::warn!("[quit] could not start the person's Podman again: {error}");
    }
    progress(QuitStep::GiveBackPodman, QuitStepState::of(&given));
}

/// The person chose Try again after closing the password prompt, so Install asks again now rather
/// than after its short wait. See `install::GoAhead`. False when nothing was waiting for it.
#[tauri::command]
fn allow_podman_install() -> bool {
    let waiting = install::allow_podman_install();
    log::info!(
        "[install] Try again to install Podman{}",
        if waiting {
            ""
        } else {
            ", with nothing waiting for it"
        }
    );
    waiting
}

/// Install's running image downloads: the step's sentence, the overall bytes as `downloadBytes`
/// for anything that reads only that, and the per-image detail.
/// A running step's download, on the row it is already showing: the engine machine image while
/// Install waits for it. The row keeps its line; only the download is added.
fn report_running_downloads<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    step: &str,
    downloads: pull_metrics::Downloads,
) {
    let line = RUNNING_SAID
        .lock()
        .unwrap_or_else(|held| held.into_inner())
        .get(step)
        .cloned()
        .unwrap_or_else(|| engine::StepLine::here(""));
    // Bytes moving restart the step's clock, so a long download is not a step that looks stuck.
    if downloads_moved(step, downloads.bytes) {
        desktop_stall::moved(app, step);
    }
    emit_progress(
        app,
        Progress {
            step: step.into(),
            ok: true,
            detail: line.said,
            running: true,
            download_bytes: (downloads.bytes > 0).then_some(downloads.bytes),
            downloads: Some(downloads),
            elsewhere: line.elsewhere,
            asks: line.asks,
            updating: line.updating,
        },
    );
}

/// Whether `step`'s download has more bytes than the last time it said.
fn downloads_moved(step: &str, bytes: u64) -> bool {
    static SEEN: Mutex<std::collections::BTreeMap<String, u64>> =
        Mutex::new(std::collections::BTreeMap::new());
    let mut seen = SEEN.lock().unwrap_or_else(|held| held.into_inner());
    let before = seen.insert(step.to_owned(), bytes);
    before.is_none_or(|before| bytes > before)
}

fn report_downloads<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    downloads: pull_metrics::Downloads,
) {
    if downloads_moved("images", downloads.bytes) {
        desktop_stall::moved(app, "images");
    }
    emit_progress(
        app,
        Progress {
            step: "images".into(),
            ok: true,
            detail: "Downloading OpenBot.".into(),
            running: true,
            download_bytes: (downloads.bytes > 0).then_some(downloads.bytes),
            downloads: Some(downloads),
            elsewhere: false,
            asks: false,
            updating: false,
        },
    );
}

fn remember_selected_root(shell: &Shell, root: &Path) {
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
    let root = app
        .try_state::<Shell>()
        .and_then(|shell| shell.selected_root.lock().unwrap().clone());
    let status = engine::detect_saved(preparation::saved_engine(
        &root.unwrap_or_else(stack::default_root),
    ));
    desktop_telemetry::observe_engine(&app, &status);
    status
}

#[tauri::command]
fn windows_blocker<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<win::Blocker>, Problem> {
    // The rest of the machine is ready: ask WSL whether it can start a VM at all, unless Docker
    // already answers, which proves it can.
    let result = win::blocker().map(|found| {
        found.or_else(|| {
            (!openbot_desktop_lib::docker_desktop::answers())
                .then(win::nested_virtualization_blocker)
                .flatten()
        })
    });
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
            Ok(Some(win::Blocker::NestedVirtualizationUnavailable)) => {
                Outcome::NestedVirtualizationUnavailable
            }
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

/// Clear a Windows blocker by running its fix, behind Windows's own administrator prompt.
///
/// A fix that needs a restart is recorded against this boot, so the next launch knows whether the
/// restart has happened rather than trusting a feature that reads as on but is not yet running.
#[tauri::command]
async fn windows_fix(app: tauri::AppHandle, blocker: win::Blocker) -> Result<win::Fixed, Problem> {
    let failed = |detail: String| {
        Problem::with(
            "OpenBot could not set up Windows Subsystem for Linux. Try again, or run the commands \
             yourself.",
            detail,
        )
    };
    let fix = blocker.fix().ok_or_else(|| {
        Problem::plain("OpenBot cannot change this setting. Follow the steps on this screen.")
    })?;
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| failed(error.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let fixed = win::run_fix(fix, &data)?;
        if fixed == win::Fixed::RestartNeeded {
            win::record_restart_needed(&data, &win::boot()?)
                .map_err(|error| failed(error.to_string()))?;
        }
        Ok(fixed)
    })
    .await
    .map_err(|error| failed(error.to_string()))?
}

/// Whether a fix made earlier is still waiting for Windows to restart.
#[tauri::command]
async fn windows_restart_pending(app: tauri::AppHandle) -> Result<bool, Problem> {
    if !cfg!(target_os = "windows") {
        return Ok(false);
    }
    let Ok(data) = app.path().app_local_data_dir() else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || Ok(win::restart_pending(&data, &win::boot()?)))
        .await
        .map_err(|error| {
            Problem::with("OpenBot could not check Windows setup.", error.to_string())
        })?
}

/// Restart Windows to finish a fix, with OpenBot set to open again afterwards.
#[tauri::command]
fn windows_restart() -> Result<(), Problem> {
    win::restart()
}

/// Bring the engine up: create the machine if it is missing, start it, then prove it answers.
///
/// Reported step by step rather than as one result, because these take minutes and a window with
/// nothing moving in it reads as a hang.
/// Update work uses the existing startup/stop ownership, plus one session exclusion for the
/// gaps between preparation and startup. It never creates another process supervisor.
struct RuntimeUpdateGuard<R: tauri::Runtime>(tauri::AppHandle<R>);
impl<R: tauri::Runtime> RuntimeUpdateGuard<R> {
    fn begin(app: &tauri::AppHandle<R>) -> Result<Self, Problem> {
        let shell = app.state::<Shell>();
        let _startup = shell.startup.lock().unwrap();
        if shell.starting.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Problem::plain(
                "Wait for the current startup or installation to finish.",
            ));
        }
        shell
            .updating
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .map_err(|_| Problem::plain("OpenBot is already updating."))?;
        shell
            .update_cancelled
            .store(false, std::sync::atomic::Ordering::SeqCst);
        Ok(Self(app.clone()))
    }
}
impl<R: tauri::Runtime> Drop for RuntimeUpdateGuard<R> {
    fn drop(&mut self) {
        self.0
            .state::<Shell>()
            .updating
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
}
fn require_update_root(shell: &Shell, root: &Path) -> Result<(), Problem> {
    let wanted = std::fs::canonicalize(root).map_err(|e| Problem::from(e.to_string()))?;
    for selected in [
        shell.root.lock().unwrap().clone(),
        shell.selected_root.lock().unwrap().clone(),
        shell
            .containers
            .lock()
            .unwrap()
            .as_ref()
            .map(|c| c.root.clone()),
    ]
    .into_iter()
    .flatten()
    {
        if std::fs::canonicalize(selected).map_err(|e| Problem::from(e.to_string()))? != wanted {
            return Err(Problem::plain(
                "Select this installation and stop the other installation before updating.",
            ));
        }
    }
    Ok(())
}
/// Said while an upgrade the app stopped part way waits for its previous version to go back, on
/// the screen a failed Start leaves, whose Retry runs Start again: `upgrade_due` sends it to
/// `upgrade_and_start`, which puts the previous version back first.
const UPGRADE_INTERRUPTED: &str =
    "OpenBot's last update did not finish. Choose Retry to put the previous version back.";

/// The same, on the installation screen a failed Install or Repair leaves, whose button installs
/// again, which puts the previous version back first (`put_back_interrupted_upgrade`).
const UPGRADE_INTERRUPTED_INSTALL: &str =
    "OpenBot's last update did not finish. Choose Retry installation to put the previous version back.";

/// The same, on the running screen, where Show OpenBot is refused and Stop OpenBot leads to Start.
const UPGRADE_INTERRUPTED_SHOWING: &str =
    "OpenBot's last update did not finish. Choose Stop OpenBot, then Start OpenBot, to put the previous version back.";

/// What Start is given, for an upgrade to start the version it leaves in place.
struct StartWith {
    api_url: String,
    gateway_ws_url: String,
    model: ChosenModel,
}

/// An upgrade's steps, each run the way Install and Start run it from this window (see `upgrade`).
/// `start` is `None` when the upgrade only puts an interrupted one back, for Install.
struct DesktopSteps {
    app: tauri::AppHandle,
    root: PathBuf,
    address: engine::Address,
    harness: Option<harness::HarnessChoice>,
    start: Option<StartWith>,
}

impl DesktopSteps {
    /// Own this installation's Compose project, so Stop and the database's own service can be
    /// taken down. Containers a closed window left running are this installation's, on its saved
    /// engine, and nobody else's: `require_update_root` checked no other one is selected.
    fn own_containers(&self) {
        let shell = self.app.state::<Shell>();
        let _startup = shell.startup.lock().unwrap();
        *shell.containers.lock().unwrap() = Some(ContainerDeployment {
            root: self.root.clone(),
            address: self.address.clone(),
        });
    }

    /// Run `work` with only this installation's database, and stop it again afterwards, volumes
    /// kept, whatever `work` did.
    fn with_database(
        &self,
        work: impl FnOnce(&engine::Address, &Path, &stack::Secrets) -> Result<(), String>,
    ) -> Result<(), String> {
        let secrets = openbot_desktop_lib::vault::already_given_no_ui(
            &self.root,
            &self.root.join(".env"),
            &openbot_env::MINTED[..],
        )
        .map_err(problem_detail)?;
        self.own_containers();
        let shell = self.app.state::<Shell>();
        let _startup = shell.startup.lock().unwrap();
        let worked = work(&self.address, &self.root, &secrets);
        let stopped = down_containers_with(&shell, &self.root, |root| {
            down_owned_containers(&shell, root)
        });
        match (worked, stopped) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), _) => Err(error),
            (Ok(()), Err(error)) => Err(format!("the database did not stop: {error}")),
        }
    }
}

impl upgrade::Steps for DesktopSteps {
    /// The release row's sentence, which is the line under Start's rows while it upgrades.
    fn now(&mut self, now: upgrade::Now) {
        report_running_line(
            &self.app,
            "release",
            upgrade::now_said(now, &self.root, &upgrade::own()),
            None,
        );
    }

    fn stop(&mut self) -> Result<(), Problem> {
        self.own_containers();
        stop_for_update(&self.app, &self.root)
            .map_err(|error| Problem::with("OpenBot could not stop to update.", error))
    }

    fn has_database(&mut self) -> Result<bool, Problem> {
        let secrets = openbot_desktop_lib::vault::already_given_no_ui(
            &self.root,
            &self.root.join(".env"),
            &openbot_env::MINTED[..],
        )?;
        stack::postgres_volume_exists(&self.address, &self.root, &secrets)
    }

    fn back_up(&mut self, to: &Path) -> Result<(), Problem> {
        self.with_database(|engine, root, secrets| {
            stack::backup_runtime_database(engine, root, secrets, to)
        })
        .map_err(|error| {
            Problem::with(
                "OpenBot could not back up its database, so it did not update.",
                error,
            )
        })
    }

    fn lay_out(&mut self) -> Result<(), Problem> {
        let own = upgrade::own();
        match deployment::pinned() {
            Some(pin) => deployment::fetch_pinned(&self.root, &pin),
            None => deployment::fetch(&self.root, &own.version),
        }
        .map_err(|error| {
            report(&self.app, "deployment", false, error.clone());
            Problem::with(
                "OpenBot could not download its new version. Check the internet connection and \
                 try again.",
                error,
            )
        })
    }

    fn install(&mut self) -> Result<(), Problem> {
        tauri::async_runtime::block_on(prepare_installation_inner(
            self.app.clone(),
            self.root.to_string_lossy().into(),
            self.harness.clone(),
        ))
    }

    fn start(&mut self) -> Result<(), Problem> {
        let Some(with) = &self.start else {
            return Ok(());
        };
        tauri::async_runtime::block_on(start_stack_inner(
            self.app.clone(),
            self.root.clone(),
            with.api_url.clone(),
            with.gateway_ws_url.clone(),
            with.model.clone(),
            self.harness.clone(),
        ))
    }

    fn restore(&mut self, from: &Path) -> Result<(), Problem> {
        self.with_database(|engine, root, secrets| {
            stack::start_runtime_database(engine, root, secrets)?;
            stack::restore_runtime_database(engine, root, secrets, from)
        })
        .map_err(|error| Problem::with("OpenBot could not put its database back.", error))
    }
}

/// The upgrade Start makes first: this installation is not on this app's own release (see
/// `upgrade`), or an upgrade the app stopped part way has to be put back. `None` when it starts as
/// it is.
#[tauri::command]
async fn upgrade_due(root: String) -> Option<upgrade::Move> {
    let root = stack::root_from(&root);
    let own = upgrade::own();
    if upgrade::interrupted(&root) {
        return Some(upgrade::Move {
            from: upgrade::previous_version(&root).unwrap_or_default(),
            to: own.version,
        });
    }
    upgrade::due(&root, &own)
}

/// Start, upgrading the installation to this app's own release first: stop, back up the database,
/// set the previous version aside, lay out and pull the new one, start. A failed upgrade puts the
/// previous version and its database back and starts that, and the outcome says so in one
/// sentence. An upgrade the app stopped part way is put back first. Takes what `start_stack` takes.
#[tauri::command]
async fn upgrade_and_start(
    app: tauri::AppHandle,
    root: String,
    api_url: String,
    gateway_ws_url: String,
    model: ChosenModel,
    harness: Option<harness::HarnessChoice>,
) -> Result<upgrade::Outcome, Problem> {
    let asked = std::time::Instant::now();
    log::info!("[update] asked to update the installation in {root} and start it");
    let ran = upgrade_and_start_now(app, root, api_url, gateway_ws_url, model, harness).await;
    if let Ok(outcome) = &ran {
        log::info!(
            "[update] {} from {} to {}{}",
            if outcome.moved { "moved" } else { "stayed" },
            outcome.from,
            outcome.to,
            outcome
                .notice
                .as_ref()
                .map(|notice| format!(": {}", logging::Failure::described(notice)))
                .unwrap_or_default()
        );
    }
    logging::outcome("update", asked, &ran);
    ran
}

async fn upgrade_and_start_now(
    app: tauri::AppHandle,
    root: String,
    api_url: String,
    gateway_ws_url: String,
    model: ChosenModel,
    harness: Option<harness::HarnessChoice>,
) -> Result<upgrade::Outcome, Problem> {
    let selected = stack::root_from(&root);
    if app
        .state::<Shell>()
        .updating
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err(Problem::plain(
            "OpenBot is already updating. Wait for it to finish before starting.",
        ));
    }
    let ran = {
        let _update = RuntimeUpdateGuard::begin(&app)?;
        require_update_root(&app.state::<Shell>(), &selected)?;
        let handle = app.clone();
        let target = selected.clone();
        let with = StartWith {
            api_url: api_url.clone(),
            gateway_ws_url: gateway_ws_url.clone(),
            model: model.clone(),
        };
        let chosen = harness.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let saved = preparation::saved_engine(&target);
            let address = tauri::async_runtime::block_on(engine_ready(&handle, saved))?.pin()?;
            let mut steps = DesktopSteps {
                app: handle.clone(),
                root: target.clone(),
                address,
                harness: chosen,
                start: Some(with),
            };
            let recovering = upgrade::interrupted(&target);
            if recovering {
                report_running_plain(
                    &handle,
                    "release",
                    "Putting back the version OpenBot was updating from.",
                );
                upgrade::recover(&target, &mut steps).map_err(|problem| {
                    Problem::with(UPGRADE_INTERRUPTED, upgrade::detail(&problem))
                })?;
            }
            let Some(planned) = upgrade::due(&target, &upgrade::own()) else {
                // Put back, and nothing to move: an ordinary Start, with no step of putting back
                // still said under its rows.
                if recovering {
                    report_line(&handle, "release", true, upgrade::put_back_said(&target));
                }
                return Ok::<_, Problem>(None);
            };
            report_running_line(&handle, "release", upgrade::moving_said(&planned), None);
            let ran = upgrade::run(&target, &mut steps);
            Ok(Some((planned, ran)))
        })
        .await
        .map_err(|e| Problem::from(e.to_string()))??
    };
    let Some((planned, ran)) = ran else {
        // Nothing to move (put back, decided meanwhile, or newer): an ordinary Start.
        let kept = deployment::installed(&selected)
            .map(|found| found.version)
            .unwrap_or_default();
        start_stack(app, root, api_url, gateway_ws_url, model, harness).await?;
        return Ok(upgrade::Outcome::unchanged(kept));
    };
    refresh_menus(&app);
    // Stop or Quit during the upgrade outranks it: the previous version is back, and nothing
    // starts again on its own.
    let cancelled = app
        .state::<Shell>()
        .update_cancelled
        .load(std::sync::atomic::Ordering::SeqCst);
    match ran {
        upgrade::Ran::Moved => {
            report_line(
                &app,
                "release",
                true,
                engine::StepLine::here("OpenBot is updated.")
                    .logged(format!("OpenBot is on {}.", planned.to)),
            );
            desktop_telemetry::record(&app, telemetry::EventData::Activated);
            Ok(upgrade::Outcome::moved(&planned))
        }
        upgrade::Ran::Kept(failed) => {
            report_line(
                &app,
                "release",
                false,
                engine::StepLine::here(upgrade::kept_said(&planned))
                    .logged(upgrade::moved_log(&planned)),
            );
            desktop_telemetry::record(&app, telemetry::EventData::Activated);
            Ok(upgrade::Outcome::kept(&planned, &failed))
        }
        upgrade::Ran::Back { failed, .. } if cancelled => Err(Problem::with(
            "OpenBot stopped before it finished updating, and the version it had is back in place.",
            format!(
                "{}: {}",
                upgrade::moved_log(&planned),
                upgrade::detail(&failed)
            ),
        )),
        upgrade::Ran::Back { failed, start } => {
            let said = upgrade::back_said(&planned, &start);
            report_line(
                &app,
                "release",
                false,
                engine::StepLine::here(said.clone()).logged(upgrade::moved_log(&planned)),
            );
            Err(Problem {
                said,
                detail: Some(format!(
                    "{}\nupdate: {}",
                    upgrade::detail(&start),
                    upgrade::detail(&failed)
                )),
                ..start
            })
        }
        upgrade::Ran::Stuck { failed, undo } => {
            let said = upgrade::stuck_said(&planned);
            report_line(
                &app,
                "release",
                false,
                engine::StepLine::here(said.clone()).logged(upgrade::moved_log(&planned)),
            );
            Err(Problem::with(
                said,
                format!(
                    "{}\nputting back: {}",
                    upgrade::detail(&failed),
                    upgrade::detail(&undo)
                ),
            ))
        }
    }
}

/// Put back an upgrade the app stopped part way, before Install changes anything. No start: Install
/// goes on to prepare the version that is back.
async fn put_back_interrupted_upgrade(app: &tauri::AppHandle, root: &Path) -> Result<(), Problem> {
    if !upgrade::interrupted(root) {
        return Ok(());
    }
    let _update = RuntimeUpdateGuard::begin(app)?;
    require_update_root(&app.state::<Shell>(), root)?;
    let handle = app.clone();
    let target = root.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let saved = preparation::saved_engine(&target);
        let address = tauri::async_runtime::block_on(engine_ready(&handle, saved))?.pin()?;
        let mut steps = DesktopSteps {
            app: handle.clone(),
            root: target.clone(),
            address,
            harness: None,
            start: None,
        };
        upgrade::recover(&target, &mut steps)
            .map(|_| {
                // Install goes on from the version that is back, with no step of putting back
                // still said as its own.
                report_line(&handle, "release", true, upgrade::put_back_said(&target));
            })
            .map_err(|problem| {
                Problem::with(UPGRADE_INTERRUPTED_INSTALL, upgrade::detail(&problem))
            })
    })
    .await
    .map_err(|e| Problem::from(e.to_string()))?
}

/// Read the update feed at launch and every six hours, on a thread of its own, when this build is
/// offered updates at all: a stable, unpinned build with the updater (see `app_update`). Any other
/// build never reads the feed.
fn watch_for_app_updates<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(feed) = app_update_feed(app) else {
        let version = &app.package_info().version;
        log::info!("[app update] {version} is offered no updates; no update check");
        if let Some(folder) = app_update_test_feed(app) {
            watch_test_feed(app, folder);
        }
        return;
    };
    let handle = app.clone();
    let watching = std::thread::Builder::new()
        .name("openbot-app-update".into())
        .spawn(move || {
            app_update::watch(
                app_update::Schedule::new(app_update::EVERY),
                std::time::SystemTime::now,
                |tick| {
                    std::thread::sleep(tick);
                    true
                },
                || {
                    let answer = feed.read();
                    match &answer {
                        Ok(Some(newer)) => log::info!("[app update] {newer} is available"),
                        Ok(None) => log::info!("[app update] up to date"),
                        Err(error) => {
                            log::warn!("[app update] could not read the update feed: {error}")
                        }
                    }
                    handle.state::<Shell>().app_update.record(&answer);
                    if matches!(answer, Ok(Some(_))) {
                        handle.state::<Shell>().update_ready.nudge();
                    }
                },
            )
        });
    if let Err(error) = watching {
        log::error!("[app update] could not start checking for updates: {error}");
    }
}

/**
Get the newer version the feed names ready while this one runs (`update_ready`), on a thread of its
own: a try as soon as the feed names one, and every `app_update::TICK` after, until it is ready. A
try waits while OpenBot is not running, or while something the person started needs the engine
(`update_ready_paused`), so the first one after a launch comes once Start is done. Once ready, each
try only checks that it still is. A build that is offered no updates never starts it.
*/
fn get_updates_ready<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    // An internal build pointed at a test feed reads its list from there.
    let test = app_update_test_feed(app);
    if app_update_feed(app).is_none() && test.is_none() {
        return;
    }
    let handle = app.clone();
    let getting = std::thread::Builder::new()
        .name("openbot-update-ready".into())
        .spawn(move || {
            let mut lists: Option<(semver::Version, update_ready::Announced)> = None;
            let mut said: Option<String> = None;
            loop {
                handle.state::<Shell>().update_ready.wait(app_update::TICK);
                try_getting_update_ready(&handle, test.as_deref(), &mut lists, &mut said);
            }
        });
    if let Err(error) = getting {
        log::error!("[update ready] could not start getting updates ready: {error}");
    }
}

/// Whether a try at getting an update ready waits, or stops before its next image: OpenBot is not
/// running, or is starting, stopping, updating or quitting.
fn update_ready_paused<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    use std::sync::atomic::Ordering::SeqCst;
    let shell = app.state::<Shell>();
    shell.starting.load(SeqCst)
        || shell.updating.load(SeqCst)
        || shell.app_update.installing()
        || !matches!(*shell.quit.phase.lock().unwrap(), QuitPhase::Idle)
        || shell.root.lock().unwrap().is_none()
        || shell.containers.lock().unwrap().is_none()
}

/// One try at getting the newer version ready, said in the log once per change of outcome.
fn try_getting_update_ready<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    test: Option<&Path>,
    lists: &mut Option<(semver::Version, update_ready::Announced)>,
    said: &mut Option<String>,
) {
    let mut say = |line: String, warn: bool| {
        if said.as_deref() != Some(line.as_str()) {
            if warn {
                log::warn!("{line}");
            } else {
                log::info!("{line}");
            }
            *said = Some(line);
        }
    };
    let shell = app.state::<Shell>();
    let Some(version) = shell.app_update.newer() else {
        shell.app_update.not_ready();
        return;
    };
    if update_ready_paused(app) {
        return;
    }
    let Some((root, address)) = shell
        .containers
        .lock()
        .unwrap()
        .as_ref()
        .map(|running| (running.root.clone(), running.address.clone()))
    else {
        return;
    };
    let list = match lists.as_ref().filter(|(listed, _)| *listed == version) {
        Some((_, list)) => list.clone(),
        None => {
            let repository = deployment_release::distribution(&root)
                .map(|policy| policy.repository)
                .unwrap_or_else(|_| "CopilotKit/OpenBot".into());
            let read = match test {
                Some(folder) => update_ready::read_test_list(folder),
                None => deployment::get(&update_ready::list_url(&repository, &version))
                    .and_then(|body| update_ready::read_list(&body, &version)),
            };
            match read {
                Ok(list) => {
                    *lists = Some((version.clone(), list.clone()));
                    list
                }
                Err(error) => {
                    say(
                        format!("[update ready] could not read what {version} downloads: {error}"),
                        true,
                    );
                    return;
                }
            }
        }
    };
    let installed = preparation::installed_images(&root).unwrap_or_default();
    let engine = local_eval::node_engine();
    let node = local_eval_state::read(&root, None)
        .map(|state| openbot_desktop_lib::local_images::Node::for_stack(&engine, &state.stack));
    let current = local_eval::bundled_cli_images();
    let ahead = update_ready::Ahead {
        version: &version,
        list: &list,
        engine: &address,
        installed: &installed,
        back_end: node.as_ref().zip(current.as_ref()),
        disk: &|| local_eval::engine_disk(&address),
        computer_free: &|| update_ready::computer_free(&address),
        limits: openbot_desktop_lib::local_images::Limits::standard(),
    };
    // Stopped when OpenBot needs the engine, or the feed names another version meanwhile.
    let stop = || update_ready_paused(app) || shell.app_update.newer().as_ref() != Some(&version);
    let outcome = update_ready::get_ready(&ahead, &stop, &mut |done, total| {
        shell
            .app_update
            .readying(&version, app_update::Readiness::Preparing { done, total })
    });
    match outcome {
        update_ready::Outcome::Ready => {
            shell
                .app_update
                .readying(&version, app_update::Readiness::Ready);
            say(
                format!("[update ready] {version} is ready to install"),
                false,
            );
        }
        update_ready::Outcome::Skipped(why) => {
            shell.app_update.not_ready();
            say(
                format!(
                    "[update ready] not downloading {version} ahead of the update: {why}; the update downloads it"
                ),
                true,
            );
        }
        update_ready::Outcome::Stopped => {
            shell.app_update.not_ready();
            log::info!("[update ready] stopped getting {version} ready; it goes on later");
        }
        update_ready::Outcome::NotYet(why) => {
            shell.app_update.not_ready();
            say(
                format!("[update ready] {version} is not ready yet: {why}; trying again later"),
                true,
            );
        }
    }
}

/// The test feed an internal build was pointed at (`app_update::TEST_FEED`), from the environment
/// the app was started in. None on a stable or candidate build, whatever the environment says.
fn app_update_test_feed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    app_update::test_feed(&app.package_info().version, |name| std::env::var_os(name))
}

/**
Read an internal build's test feed (`app_update::TEST_FEED`) at launch and every `app_update::TICK`,
as a release build reads its update feed, and keep what it names newer, so the background download
(`get_updates_ready`) runs for it. Nothing installs from it: an internal build has no updater.
*/
fn watch_test_feed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, folder: PathBuf) {
    log::info!("[update ready] using a test feed from {}", folder.display());
    let handle = app.clone();
    let watching = std::thread::Builder::new()
        .name("openbot-test-feed".into())
        .spawn(move || {
            let current = handle.package_info().version.clone();
            let mut said: Option<String> = None;
            app_update::watch(
                app_update::Schedule::new(app_update::TICK),
                std::time::SystemTime::now,
                |tick| {
                    std::thread::sleep(tick);
                    true
                },
                || {
                    let answer = app_update::test_newer(&current, &folder);
                    let line = match &answer {
                        Ok(Some(newer)) => format!("[update ready] the test feed names {newer}"),
                        Ok(None) => "[update ready] the test feed names nothing newer".into(),
                        Err(error) => {
                            format!("[update ready] could not read the test feed: {error}")
                        }
                    };
                    if said.as_deref() != Some(line.as_str()) {
                        log::info!("{line}");
                        said = Some(line);
                    }
                    handle.state::<Shell>().app_update.record(&answer);
                    if matches!(answer, Ok(Some(_))) {
                        handle.state::<Shell>().update_ready.nudge();
                    }
                },
            )
        });
    if let Err(error) = watching {
        log::error!("[update ready] could not start reading the test feed: {error}");
    }
}

/// This build's update feed, or `None` when it is offered no updates (see `app_update::Feed::of`).
/// The schedule, the windows' Check for updates and the menus' Check for Updates… all ask this.
fn app_update_feed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<app_update::Feed> {
    app_update::Feed::of(
        &app.package_info().version,
        deployment::pinned().is_some(),
        app.config().plugins.0.get("updater"),
    )
}

/// Read the update feed now, because somebody asked, and keep the answer for the banner too.
async fn check_app_update_now<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<app_update::Asked, String> {
    let handle = app.clone();
    let asked = tauri::async_runtime::spawn_blocking(move || {
        app_update::ask(
            app_update_feed(&handle).as_ref(),
            &handle.package_info().version,
            &handle.state::<Shell>().app_update,
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    if let Ok(found) = &asked {
        log::info!("[app update] checked when asked: {found:?}");
    }
    // Got ready at once, rather than at the next tick.
    if let Ok(app_update::Asked::Available { .. }) = &asked {
        app.state::<Shell>().update_ready.nudge();
    }
    asked
}

/// What a window's Check for updates shows. Unlike the schedule's, a check that fails is said.
async fn check_app_update_for_page<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<app_update::Asked, Problem> {
    check_app_update_now(app).await.map_err(|error| {
        log::warn!("[app update] could not read the update feed: {error}");
        Problem::with(
            "OpenBot couldn't check for updates. Check your internet connection and try again.",
            error,
        )
    })
}

/// Check for Updates… in the tray or the OpenBot menu. Always answers, in a native dialog: the
/// offer with Update and restart, up to date, or couldn't check. Not now closes the offer on that
/// version, as it does in the windows.
fn check_for_updates_from_menu(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let asked = check_app_update_now(app.clone()).await;
        if let Err(error) = &asked {
            log::warn!("[app update] could not read the update feed: {error}");
        }
        let offered = match &asked {
            Ok(app_update::Asked::Available { version, .. }) => Some(version.clone()),
            _ => None,
        };
        let answering = app.clone();
        show_prompt(&app, app_update::prompt(&asked), move |update| {
            let Some(version) = offered else {
                return;
            };
            if !update {
                if let Err(problem) = dismiss_app_update_for(&answering, &version) {
                    log::warn!("[app update] could not close the offer: {}", problem.said);
                }
                return;
            }
            tauri::async_runtime::spawn(async move {
                // Returns only when it failed: on success the app restarts into the new version.
                if let Err(problem) = install_app_update_now(answering.clone()).await {
                    show_prompt(
                        &answering,
                        app_update::install_failed(&problem.said),
                        |_| {},
                    );
                }
            });
        });
    });
}

/// A Check for Updates… answer, in a native alert. `answered` hears whether the first button was
/// chosen, off the main thread.
///
/// On macOS, OpenBot's own alert, with OpenBot's icon (`native_alert`): the dialog plugin shows a
/// message with no parent window in an alert the system draws, with its grey note icon. Elsewhere,
/// the dialog plugin's message, which on Windows carries the information icon a message box should.
fn show_prompt(
    app: &tauri::AppHandle,
    prompt: app_update::Prompt,
    answered: impl FnOnce(bool) + Send + 'static,
) {
    #[cfg(target_os = "macos")]
    {
        let shown = app.run_on_main_thread(move || {
            let Some(mtm) = objc2::MainThreadMarker::new() else {
                log::error!("[app update] the update alert was not on the main thread");
                return;
            };
            let ahead = openbot_desktop_lib::native_alert::ask(
                mtm,
                &prompt.title,
                &prompt.message,
                prompt.buttons,
            );
            std::thread::spawn(move || answered(ahead));
        });
        if let Err(error) = shown {
            log::warn!("[app update] could not show the update alert: {error}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        let dialog = app.dialog().message(prompt.message).title(prompt.title);
        let dialog = match prompt.buttons {
            Some((yes, no)) => {
                dialog.buttons(MessageDialogButtons::OkCancelCustom(yes.into(), no.into()))
            }
            None => dialog,
        };
        dialog.show(answered);
    }
}

/// What the banner and the setup window offer: the newer version, unless this person closed it.
fn app_update_status<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> app_update::Status {
    let config = app.path().app_config_dir().ok();
    app_update::status(
        &app.state::<Shell>().app_update,
        &app.package_info().version,
        config.as_deref(),
        app_update_feed(app).is_some(),
    )
}

/// Close the offer on `version` until a newer one comes out.
fn dismiss_app_update_for<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    version: &str,
) -> Result<(), Problem> {
    let version = semver::Version::parse(version)
        .map_err(|_| Problem::plain("That isn't a version of OpenBot."))?;
    let config = app
        .path()
        .app_config_dir()
        .map_err(|e| Problem::from(e.to_string()))?;
    app_update::dismiss(&config, &version)
        .map_err(|e| Problem::from(format!("OpenBot couldn't remember that: {e}")))
}

/**
Install the newer OpenBot that the banner or the setup window offered, then restart into it.

The archive is downloaded, and its signature verified by the updater, while OpenBot keeps running,
then installed over this app. Only then is OpenBot stopped, as for an upgrade (the local
Intelligence keeps running), so a download or install that fails leaves everything as it was. The
restart starts OpenBot again, and that Start upgrades the installation to the new app's release
(`upgrade_due`, then `upgrade_and_start`: `upgrade::run`, with its backup and its way back). Not
while an upgrade or a Start is under way (`RuntimeUpdateGuard`).

On Windows the order differs, because Windows will not replace a running app: the updater starts
the downloaded NSIS installer in update mode and exits this process at once, and the installer
starts the new version when it is done. Nothing after `install` runs there, so OpenBot is stopped
just before the installer starts (`stop_before_installer`), once the download is verified and
written out. A download that fails still leaves everything as it was.

Nothing here decides whether the download is genuine: the updater refuses an archive whose
minisign signature does not match the public key compiled into this build.
*/
async fn install_app_update_now<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), Problem> {
    log::info!("[app update] asked to install the update");
    // Returns only when it failed: on success the app has restarted.
    let installed = install_app_update_steps(app).await;
    if let Err(problem) = &installed {
        log::error!(
            "[app update] install failed: {}",
            logging::Failure::described(problem)
        );
    }
    installed
}

async fn install_app_update_steps<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), Problem> {
    use tauri_plugin_updater::UpdaterExt;
    // The one condition the updater plugin is registered on (see `setup`).
    if !app.config().plugins.0.contains_key("updater") {
        return Err(Problem::plain("This build of OpenBot can't update itself."));
    }
    let _update = RuntimeUpdateGuard::begin(&app)?;
    let stopped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let feeds = app_update::endpoints(app.config().plugins.0.get("updater")).unwrap_or_default();
    let installed = async {
        let (update, bytes) = download_app_update(
            &feeds,
            |feed| {
                let handle = app.clone();
                let stopped_by_installer = stopped.clone();
                let mut builder = app
                    .updater_builder()
                    // Runs on Windows only, in place of the updater's own cleanup, which this
                    // ends with.
                    .on_before_exit(move || {
                        stopped_by_installer.store(true, std::sync::atomic::Ordering::SeqCst);
                        stop_before_installer(&handle);
                    });
                if let Some(feed) = feed {
                    builder = builder.endpoints(vec![feed])?;
                }
                builder.build()
            },
            || app.state::<Shell>().app_update.begin_install(),
            |chunk, total| app.state::<Shell>().app_update.downloaded(chunk, total),
        )
        .await?;
        if app
            .state::<Shell>()
            .update_cancelled
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(Problem::plain(
                "OpenBot was stopped before the update was installed.",
            ));
        }
        app.state::<Shell>().app_update.restarting();
        tauri::async_runtime::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(|e| Problem::from(e.to_string()))?
            .map_err(|e| Problem::from(e.to_string()))
    }
    .await;
    if let Err(problem) = installed {
        if stopped.load(std::sync::atomic::Ordering::SeqCst) {
            // Windows could not start the installer after OpenBot was stopped and the app's
            // windows and tray were taken down for the exit. Tauri allows nothing after that but
            // an exit, so start this same version again; its Start brings OpenBot back, and the
            // offer stays.
            log::error!(
                "[app update] the installer did not start: {}",
                problem.detail.as_deref().unwrap_or(&problem.said)
            );
            restart_into_update(&app);
        }
        app.state::<Shell>().app_update.end_install();
        return Err(problem);
    }
    let handle = app.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        stop_for_update(&handle, &stack::default_root())
    })
    .await
    {
        Ok(Ok(())) => {}
        // The new version is already installed, and restarting into it is still right: its Start
        // finds whatever is left running.
        Ok(Err(error)) => log::warn!("[app update] stopping OpenBot before the restart: {error}"),
        Err(error) => log::warn!("[app update] stopping OpenBot before the restart: {error}"),
    }
    log::info!("[app update] installed; restarting into it");
    restart_into_update(&app)
}

/**
Check for the newer OpenBot and download it, verified, from the feeds `updater(None)` reads; then,
when that download fails and a later feed in `feeds` is on another host (`app_update::feed_after`),
once more from that feed alone, built by `updater(Some(feed))`.

The updater moves on to its next feed only when reading a feed fails, not when a download does. The
first feed is downloads.copilotkit.ai's, which names its own copy of the archive, so without this a
mirror that served the feed but not the archive left the update failing until the mirror was fixed,
though GitHub's feed names the same signed archive. Any other failure is returned as it is.

`begin` is called before each download, and `on_chunk` with what each one receives, so the window's
progress starts again for the second.
*/
async fn download_app_update(
    feeds: &[reqwest::Url],
    updater: impl Fn(
        Option<reqwest::Url>,
    ) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater>,
    begin: impl Fn(),
    on_chunk: impl Fn(usize, Option<u64>),
) -> Result<(tauri_plugin_updater::Update, Vec<u8>), Problem> {
    let failed = |e: tauri_plugin_updater::Error| Problem::from(e.to_string());
    let check = |feed: Option<reqwest::Url>| {
        let built = updater(feed);
        async move {
            built
                .map_err(failed)?
                .check()
                .await
                .map_err(failed)?
                .ok_or_else(|| Problem::plain("OpenBot is already up to date."))
        }
    };
    let downloaded = |update: &tauri_plugin_updater::Update| {
        log::info!(
            "[app update] downloaded {} from {}",
            update.version,
            update.download_url
        )
    };
    let update = check(None).await?;
    log::info!(
        "[app update] downloading {} from {}",
        update.version,
        update.download_url
    );
    begin();
    let error = match update.download(&on_chunk, || {}).await {
        Ok(bytes) => {
            downloaded(&update);
            return Ok((update, bytes));
        }
        Err(error) => error,
    };
    let Some(feed) = app_update::feed_after(&update.download_url, feeds) else {
        return Err(failed(error));
    };
    log::warn!(
        "[app update] downloading from {} failed: {error}; trying the feed at {feed}",
        update.download_url
    );
    let update = check(Some(feed)).await?;
    log::info!(
        "[app update] downloading {} from {}",
        update.version,
        update.download_url
    );
    begin();
    let bytes = update.download(&on_chunk, || {}).await.map_err(failed)?;
    downloaded(&update);
    Ok((update, bytes))
}

/**
What Windows needs done before the updater starts the installer and exits the process: OpenBot
stopped, as on a Mac after the install (the local Intelligence keeps running), then the cleanup the
updater does by default, which takes down the windows and the tray icon so none is left behind.

The exit that follows runs no exit handler, so Quit's cleanup never starts. The installer then
stops anything still running from the bundled CLI (`windows/hooks.nsh`), replaces the app, and
starts the new version, whose Start moves the installation to its release (`follow`).
*/
fn stop_before_installer<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Err(error) = stop_for_update(app, &stack::default_root()) {
        // The installer runs either way: the new version's Start finds whatever is left running.
        log::warn!("[app update] stopping OpenBot before the installer: {error}");
    }
    app.cleanup_before_exit();
}

/**
Restart into the version just installed, without Quit's cleanup.

OpenBot was already stopped for the update, and the local Intelligence is meant to keep running
(`stop_for_update`). Tauri ignores `prevent_exit` for a restart, so a cleanup started by the exit it
sends would be cut off halfway, possibly in the middle of stopping Intelligence. Marking Quit done
for the restart's exit code makes the exit handler let it through untouched.
*/
fn restart_into_update<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> ! {
    quit_done_for_restart(&app.state::<Shell>().quit);
    app.restart()
}

fn quit_done_for_restart(quit: &QuitState) {
    *quit.phase.lock().unwrap() = QuitPhase::Complete(tauri::RESTART_EXIT_CODE);
}

/// The setup window's update offer: the same answer the banner in OpenBot's page reads.
#[tauri::command]
async fn app_update_offer(app: tauri::AppHandle) -> app_update::Status {
    app_update_status(&app)
}

/// The setup window's Check for updates: the feed read now, and what it found.
#[tauri::command]
async fn check_app_update<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<app_update::Asked, Problem> {
    check_app_update_for_page(app).await
}

#[tauri::command]
async fn dismiss_app_update(app: tauri::AppHandle, version: String) -> Result<(), Problem> {
    dismiss_app_update_for(&app, &version)
}

#[tauri::command]
async fn install_app_update(app: tauri::AppHandle) -> Result<(), Problem> {
    install_app_update_now(app).await
}

#[tauri::command]
async fn prepare_engine(app: tauri::AppHandle) -> Result<engine::EngineStatus, Problem> {
    let asked = std::time::Instant::now();
    let saved = {
        let shell = app.state::<Shell>();
        let root = shell.selected_root.lock().unwrap().clone();
        preparation::saved_engine(&root.unwrap_or_else(stack::default_root))
    };
    let ready = engine_ready(&app, saved).await;
    logging::outcome("engine", asked, &ready);
    Ok(engine::detect_saved(Some(ready?.engine)))
}

/// The first setup screen is showing: start the big downloads now, before Install is clicked, for
/// the installation in `root`. Once per run of the app. See `early_downloads`.
#[tauri::command]
fn start_early_downloads(app: tauri::AppHandle, root: String) {
    let telemetry_app = app.clone();
    early_downloads::start(
        stack::root_from(&root),
        early_downloads::Hooks {
            said: Box::new(move |summary| {
                let _ = app.emit("setup:downloads", summary);
            }),
            pulled: Box::new(move |metrics| {
                desktop_telemetry::pull_completed(&telemetry_app, metrics)
            }),
        },
    );
}

/// Where the early downloads are now, for a window that opens after they started.
#[tauri::command]
fn early_downloads_now() -> early_downloads::Summary {
    early_downloads::summary()
}

/// Complete all local software acquisition before either authentication screen is available.
#[tauri::command]
async fn prepare_installation(
    app: tauri::AppHandle,
    root: String,
    harness: Option<harness::HarnessChoice>,
) -> Result<(), Problem> {
    if app
        .state::<Shell>()
        .updating
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err(Problem::plain(
            "OpenBot is updating. Wait for it to finish before repairing.",
        ));
    }
    let asked = std::time::Instant::now();
    log::info!(
        "[install] asked in {root}, Bot {}",
        harness.as_ref().map_or("none", |chosen| chosen.id.as_str())
    );
    let selected = stack::root_from(&root);
    let failures = desktop_telemetry::failures_recorded(&app);
    setup_phase("installation");
    let telemetry_app = app.clone();
    // Repair after an interrupted upgrade prepares the version that is back.
    let prepared = match put_back_interrupted_upgrade(&app, &selected).await {
        Ok(()) => prepare_installation_inner(app, root, harness).await,
        Err(problem) => Err(problem),
    };
    logging::outcome("install", asked, &prepared);
    // As for Start: one `setup_failed` for an install that failed without a row saying so.
    if let Err(problem) = &prepared {
        desktop_telemetry::unreported_failure(
            &telemetry_app,
            failures,
            current_setup_phase(),
            problem,
            refused_not_failed(problem),
        );
    }
    prepared
}

async fn prepare_installation_inner(
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
        let saved = preparation::saved_engine(&root);
        let address = tauri::async_runtime::block_on(engine_ready(&app, saved))?.pin()?;
        attempt.require_current()?;
        tauri::async_runtime::block_on(deployment_ready(&app, &root))?;
        // Made now, minutes before the first Start mounts it: Docker Desktop's file sharing refused
        // one made a moment before `up` (`stack::make_sign_in_folder`).
        stack::make_sign_in_folder(&root)?;
        // Saved once the folder is there, before any image is pulled into the engine. Every later
        // install and start uses this engine: see `preparation::saved_engine`.
        if saved.is_none() {
            preparation::save_engine(&root, address.engine)?;
        }
        // And the Compose project it runs as, decided once on that engine and recorded beside it,
        // before anything is created under it. See `stack::project`.
        stack::project(&address, &root)?;
        harness::picked(harness.as_ref(), &root).map_err(Problem::from)?;
        let handle = app.clone();
        let _startup = attempt.lock_current()?;
        if preparation::require(&root, Some(&harness), &address).is_ok() {
            preparation::save_selected_root(
                &app.path()
                    .app_config_dir()
                    .map_err(|e| Problem::from(e.to_string()))?,
                &root,
            )?;
            report_plain(
                &handle,
                "installation",
                true,
                "OpenBot is already installed.",
            );
            return Ok(());
        }
        preparation::invalidate(&root)?;
        if let Some(problem) = stack::deployment_problem(&root) {
            return Err(Problem::from(problem));
        }
        /*
         * NO BUN, NO `bun install`, NO APP BUILD.
         *
         * The server, the app and the worker run from the published server image, so installing
         * OpenBot is pulling images and nothing else. This step used to download Bun and install
         * the app's packages here, on every machine, and on a fresh Windows machine that took longer
         * than everything else in the install together: Defender scans each of the thousands of
         * small files it writes. Nothing on the host needs them now: the person's own browser runs
         * on the one computer, from its image, with the Recorder built into that image.
         */
        report_running_plain(
            &handle,
            "images",
            "Checking what OpenBot needs to download.",
        );
        // The first screen may have started pulling these already: wait for it, showing its
        // download, and the pulls below find them there.
        early_downloads::wait_for_images(|downloads| report_downloads(&handle, downloads.clone()));
        // Downloaded before the engine answered: loaded into it now, so the pulls below find them.
        early_downloads::load_offline_images(&address, |downloads| {
            report_downloads(&handle, downloads)
        });
        // Only what this installation runs: see `installation_pull_set`.
        let images = preparation::installation_pull_set(&address, &root, &root, harness.as_ref())?;
        // Several pulls run at once. Stop is checked before each pull starts; running pulls finish.
        let pacer = Mutex::new(pull_metrics::Pacer::default());
        // How big the download is, from each image's registry, while the pulls start.
        let sizes = {
            let address = address.clone();
            pull_metrics::size_images(&images, move |image| {
                preparation::image_present(&address, image).unwrap_or(false)
            })
        };
        pull_metrics::pull_images_limited(
            &images,
            pull_metrics::IMAGE_PULLS_AT_ONCE,
            sizes,
            |_, image, on_layer| {
                pull_metrics::pull_image(&address, image, on_layer, |metrics| {
                    desktop_telemetry::pull_completed(&handle, metrics)
                })
            },
            || attempt.require_current(),
            |downloads| {
                // `done` counts FINISHED pulls; the bytes and the size are over every image.
                // Paced to a few reports a second, which also measures the speed.
                let paced = pacer
                    .lock()
                    .unwrap()
                    .offer(std::time::Instant::now(), downloads);
                if let Some(downloads) = paced {
                    report_downloads(&handle, downloads);
                }
            },
        )?;
        report_line(
            &handle,
            "images",
            true,
            engine::StepLine::here("OpenBot is downloaded.").logged(format!(
                "Local software is downloaded ({}/{}).",
                images.len(),
                images.len()
            )),
        );
        report_running_plain(&handle, "installation", "Finishing the installation.");
        attempt.require_current()?;
        preparation::complete(&root, harness.as_ref(), images, &address)?;
        preparation::save_selected_root(
            &app.path()
                .app_config_dir()
                .map_err(|e| Problem::from(e.to_string()))?,
            &root,
        )?;
        report_plain(&handle, "installation", true, "OpenBot is installed.");
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
/// `saved` is the engine the installation was set up on: only that one is looked at, started or
/// installed. With none saved, `install::install_engine_with` chooses.
///
/// Answering is not enough: the engine is then checked for versions new enough to run OpenBot,
/// and updated for the person when it is not (`engine_new_enough`).
async fn engine_ready(
    app: &tauri::AppHandle,
    saved: Option<engine::Engine>,
) -> Result<engine::Address, Problem> {
    let (address, answering) = engine_answering(app, saved).await?;
    // The row is said done once the engine is also new enough, not when it first answers. The
    // window starts the account's licence check and Intelligence's setup on it, and an engine about
    // to be updated refuses both: Docker Desktop 4.31 calls itself "Docker Desktop (containerized)",
    // which the CLI does not run on, and a Windows tester was told to switch to Docker Desktop
    // while OpenBot was updating it.
    if !engine_new_enough(app, address.clone()).await? {
        report_line(app, "engine", true, answering);
    }
    Ok(address)
}

/**
The engine at `address` new enough to run OpenBot, updated for the person when it is not.

At setup and at every Start, before Compose reads the project: an older Compose stops there with
"Compose config exited with exit status: 15", which nobody can act on. Docker Desktop and OpenBot's
Podman are updated here; only what cannot be updated for them is one plain step on the row. Said on
the `engine` row, and nothing is said when nothing needed doing: whether the row was said, which
`engine_ready` needs to know. See `engine_versions`.
*/
async fn engine_new_enough<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    address: engine::Address,
) -> Result<bool, Problem> {
    let engine = address.engine;
    let progress_app = app.clone();
    let back_app = app.clone();
    // Stop and Quit move the ticket on: a wait for the person ends with them.
    let watching = app.clone();
    let ticket = app
        .state::<Shell>()
        .start_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    let checked = tauri::async_runtime::spawn_blocking(move || {
        let back = || {
            bring_to_front(
                &back_app,
                "the engine update no longer needs another window",
            )
        };
        let cancelled = || {
            watching
                .state::<Shell>()
                .start_generation
                .load(std::sync::atomic::Ordering::SeqCst)
                != ticket
        };
        let mut updates = engine_versions::OnThisMachine {
            address,
            cache: stack::default_root(),
            back: &back,
            cancelled: &cancelled,
        };
        engine_versions::ensure(
            engine,
            std::env::consts::OS,
            win::machine_arch(),
            &mut updates,
            &mut |line| report_running_line(&progress_app, "engine", line, None),
        )
    })
    .await
    .map_err(|error| {
        Problem::with(
            "OpenBot could not check the software it runs on. Try again.",
            format!("the engine version check did not run: {error}"),
        )
    })?;
    match checked {
        Ok(engine_versions::Checked::NewEnough(readings)) => {
            log::info!("[engine] versions: {}", readings.said(engine));
            Ok(false)
        }
        // Its machine was stopped and started on the row: the row ends, saying it is ready.
        Ok(engine_versions::Checked::Restarted(readings)) => {
            log::info!(
                "[engine] versions: {}; answering after its machine restarted",
                readings.said(engine)
            );
            report_plain(app, "engine", true, engine::engine_ready_line().said);
            Ok(true)
        }
        Ok(engine_versions::Checked::Updated { said, .. }) => {
            report_plain(app, "engine", true, said);
            Ok(true)
        }
        Err(problem) => {
            report_plain(app, "engine", false, problem.said.clone());
            Err(problem)
        }
    }
}

/// The engine answering, and the `engine` row's line for when it is also new enough, which
/// `engine_ready` says once it is.
async fn engine_answering(
    app: &tauri::AppHandle,
    saved: Option<engine::Engine>,
) -> Result<(engine::Address, engine::StepLine), Problem> {
    report_running_plain(app, "engine", "Checking the software OpenBot needs.");
    let found = engine::detect_saved(saved);
    desktop_telemetry::observe_engine(app, &found);
    let root = stack::default_root();
    let existing = tauri::async_runtime::spawn_blocking(move || {
        ready_responding_engine_after_compose_repair(
            found,
            cfg!(target_os = "linux"),
            || install::install_engine(&root, saved),
            || engine::detect_saved(saved),
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
                        "OpenBot couldn't start the software it runs on. Try again.",
                        error.to_string(),
                    )
                })??;
            }
            local_eval::use_engine(&ready.address);
            let line = unregistered_line("engine", true, false, ready.detail);
            return Ok((ready.address, line));
        }
        Ok(None) => {}
        Err(problem) => {
            report_plain(app, "install-engine", false, problem.said.clone());
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
    let back_app = app.clone();
    // Stop and Quit move the ticket on: a wait for the person's go-ahead ends with them.
    let watching = app.clone();
    let ticket = app
        .state::<Shell>()
        .start_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    let installed = tauri::async_runtime::spawn_blocking(move || {
        install::install_engine_observed(
            &stack::default_root(),
            saved,
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
            // Installing Podman or starting Docker Desktop can take minutes; each line says where it is.
            &mut |line| report_running_line(&progress_app, "install-engine", line, None),
            // Docker Desktop's window, or the password prompt, came to the front over OpenBot's.
            &|| bring_to_front(&back_app, "the engine no longer needs another app's window"),
            &|| {
                watching
                    .state::<Shell>()
                    .start_generation
                    .load(std::sync::atomic::Ordering::SeqCst)
                    != ticket
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
    let chosen = match installed {
        Ok(chosen) => {
            report(app, "install-engine", true, chosen.said);
            chosen.engine
        }
        Err(problem) => {
            report_plain(app, "install-engine", false, problem.said.clone());
            return Err(problem);
        }
    };

    // Only the engine the install step settled on: a Docker that started answering meanwhile is
    // not the one a Podman installation's machine steps are for.
    let after = engine::detect_saved(Some(chosen));
    if let Some(address) = answering_after_install(&after, engine::Address::composes)? {
        desktop_telemetry::observe_engine(app, &after);
        local_eval::use_engine(&address);
        let line = unregistered_line("engine", true, false, after.detail);
        return Ok((address, line));
    }

    // One at a time, and each only if the last one worked. Written as a loop over an array once,
    // which ran all three before the first was checked: a failed `machine init` was still followed
    // by `machine start`.
    // On Windows, Podman's own installer for WSL may come first: see `preparing_machine_line`.
    report_running_line(
        app,
        "create-machine",
        engine::preparing_machine_line(std::env::consts::OS),
        None,
    );
    // The machine image the first screen started downloading: waited for with its download shown
    // on this row, and the machine built from it. Without one, Podman pulls its own. On a blocking
    // thread, as the deployment's download is: a blocking HTTP client must not be dropped here.
    let progress_app = app.clone();
    let image = tauri::async_runtime::spawn_blocking(move || {
        early_downloads::machine_image_for_init(|downloads| {
            report_running_downloads(&progress_app, "create-machine", downloads)
        })
    })
    .await
    .unwrap_or_else(|error| {
        log::warn!("[early downloads] the machine image wait did not run: {error}");
        None
    });
    log::info!(
        "[early downloads] creating the machine {}",
        image.as_deref().map_or_else(
            || "with the image Podman pulls itself".to_string(),
            |image| format!("from {}", image.display())
        )
    );
    // Downloaded: the row says the machine's own line again, without the download, since that line
    // is what a Windows prompt during `machine init` needs said.
    report_running_line(
        app,
        "create-machine",
        engine::preparing_machine_line(std::env::consts::OS),
        None,
    );
    let created = acquire::create_machine(4, 6144, 60, image.as_deref());
    if created.ok && image.is_some() {
        early_downloads::forget_machine_image();
    }
    if cfg!(target_os = "windows") {
        bring_to_front(app, "the engine machine is prepared");
    }
    report(app, "create-machine", created.ok, created.said.clone());
    if !created.ok {
        return Err(created.problem());
    }

    // On a Mac where the person's own Podman machine is running, only once they said yes to
    // pausing it. A wait ended by Stop or Quit, or a pause that failed, is said on its own row.
    let watching = app.clone();
    let ticket = app
        .state::<Shell>()
        .start_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    let starting = app.clone();
    let started = tauri::async_runtime::spawn_blocking(move || {
        start_own_machine(&starting, &|| {
            watching
                .state::<Shell>()
                .start_generation
                .load(std::sync::atomic::Ordering::SeqCst)
                != ticket
        })
    })
    .await
    .map_err(|error| {
        Problem::with(
            "OpenBot couldn't start the software it runs on. Try again.",
            format!("the machine start did not run: {error}"),
        )
    })??;
    report(app, "start-machine", started.ok, started.said.clone());
    if !started.ok {
        return Err(started.problem());
    }

    report_running_line(app, "health-gate", engine::checking_engine_line(), None);
    let gate = acquire::health_gate(&acquire::address());
    report(app, "health-gate", gate.ok, gate.said.clone());
    if !gate.ok {
        return Err(gate.problem());
    }

    let ready = engine::detect_saved(Some(chosen));
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
    local_eval::use_engine(&address);
    Ok((address, engine::engine_ready_line()))
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

/// Who the server container runs as on Linux, given who owns the deployment folder.
///
/// Rootful Docker keeps the host's numbers across a bind mount, so the owner's own uid and gid are
/// what reads the owner-only sign-in folder. Rootless Podman does not: it runs every container in a
/// user namespace where root is the person who started it and any other uid is one of their
/// subordinate ids, so the owner's uid inside the container is a stranger on the host and cannot
/// open `.openbot`. Root inside that namespace is the owner, with no more reach than the owner has.
#[cfg(any(target_os = "linux", test))]
fn linux_server_user(engine: engine::Engine, uid: u32, gid: u32) -> String {
    match engine {
        engine::Engine::Podman => "0:0".into(),
        engine::Engine::Docker => format!("{uid}:{gid}"),
    }
}

/// Install the latest published deployment on first use, then keep its recorded version.
///
/// Local preparation fetches the manifest needed by both launch and plan sign-in images. An
/// installed deployment keeps its exact release without consulting GitHub again; one that is not
/// this app's own release is left exactly as it is, for Start to upgrade (see `upgrade`).
async fn deployment_ready<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    root: &Path,
) -> Result<(), Problem> {
    if let Some(planned) = upgrade::due(root, &upgrade::own()) {
        report(
            app,
            "deployment",
            true,
            format!(
                "{} in {}. Start updates it to {}.",
                planned.from,
                root.display(),
                planned.to
            ),
        );
        return Ok(());
    }
    report_running_line(
        app,
        "deployment",
        engine::StepLine::here("Checking which version of OpenBot to download.")
            .logged("Checking the OpenBot release."),
        None,
    );
    // Both release discovery and downloading use blocking HTTP. Keeping them in a blocking task
    // avoids dropping reqwest's runtime inside this async context.
    let target = root.to_path_buf();
    let handle = app.clone();
    let version = tauri::async_runtime::spawn_blocking(move || {
        // The first screen may be laying the same deployment out: one at a time.
        let _laying_out = early_downloads::hold_deployment();
        let version = deployment_release::resolve_version(&target)?;
        if deployment::needs_fetch(&target, &version) {
            report_running_line(
                &handle,
                "deployment",
                engine::StepLine::here("Downloading OpenBot.")
                    .logged(format!("Downloading OpenBot {version}.")),
                None,
            );
            // A pinned build lays out the commit it was cut from; any other release is a tag.
            match deployment::pinned().filter(|pin| pin.version == version) {
                Some(pin) => deployment::fetch_pinned(&target, &pin)?,
                None => deployment::fetch(&target, &version)?,
            }
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
    // Only reachable when the latest release itself still ran the server on the host, which is an
    // app published ahead of the release it needs. Saying so beats the Compose error that follows.
    if deployment::predates_containers(root) {
        let detail = format!(
            "OpenBot {version} runs its server on the host; this app runs it in a container."
        );
        report(app, "deployment", false, detail.clone());
        return Err(Problem::with(
            "This OpenBot app needs a newer OpenBot release than the latest one. Try again \
             once it is published.",
            detail,
        ));
    }
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
    let status = engine::detect_saved(preparation::saved_engine(root));
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
#[derive(Clone, serde::Deserialize)]
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

/// The key `local connect` gave OpenBot for its local Intelligence stack, from the credential store.
fn intelligence_key_for_start(
    root: &Path,
    mut resolve: impl FnMut(&Path, &str) -> Result<String, Problem>,
) -> Result<String, Problem> {
    let key = resolve(root, "INTELLIGENCE_API_KEY").map_err(|problem| {
        problem.connection(openbot_desktop_lib::problem::Connection::Intelligence)
    })?;
    if key.trim().is_empty() {
        return Err(Problem::plain(
            "OpenBot's connection to its services on this computer is missing. Start OpenBot to set \
             it up again.",
        )
        .connection(openbot_desktop_lib::problem::Connection::Intelligence));
    }
    Ok(key)
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

/**
Refuse a Start that would mint a key for, or reattach, a previous installation's data.

A deleted installation folder takes `.env` and the vault with it, but the engine keeps every
volume. Without this, a new installation reattaches the previous one's Bots' workspace files and
browser profiles by name, and only the database was ever checked. An installation with its usable
key is a returning one and is never probed: it keeps its data.
*/
fn require_existing_encryption_key_with_recovery(
    root: &Path,
    secrets: &stack::Secrets,
    existing_postgres_volume: impl FnOnce() -> Result<bool, Problem>,
    leftovers: impl FnOnce() -> Result<stack::LeftoverVolumes, Problem>,
) -> Result<(), Problem> {
    if secrets
        .get("KEY_ENCRYPTION_KEY")
        .is_some_and(|value| openbot_env::usable_encryption_key(value))
    {
        return Ok(());
    }
    let mut volume_exists = false;
    let guarded = require_existing_encryption_key(root, secrets, || {
        volume_exists = existing_postgres_volume()?;
        Ok(volume_exists)
    });
    let mut problem = match guarded {
        // A failed probe is not proof of an existing volume. Configured roots never reach here.
        Err(problem) if !volume_exists => return Err(problem),
        Err(problem) => problem,
        Ok(()) => {
            // No database, so a key would be minted. Anything else left behind would be reused.
            let found = leftovers()?;
            if found.volumes.is_empty() {
                return Ok(());
            }
            let mut problem = Problem::plain("OpenBot found data from a previous installation, such as Bots' files and browser sign-ins. OpenBot will not reuse it in a new installation. Restore the previous installation's folder to keep it, or choose Start fresh to delete it.");
            match fresh_root_without_encryption_key(root, secrets) {
                Ok(true) if found.resettable() => {
                    problem.leftover = Some(Box::new(LeftoverReset {
                        containers: found.container_names(),
                        volumes: found.volumes,
                    }));
                }
                Ok(true) => {
                    if let Some(running) = found.running_said() {
                        problem.said = format!("{} {running}", problem.said);
                    }
                }
                Ok(false) => {}
                Err(verification) => problem.detail = Some(verification_detail(verification)),
            }
            return Err(problem);
        }
    };
    let recovery = fresh_root_without_encryption_key(root, secrets).and_then(|fresh| {
        if fresh {
            leftovers().map(Some)
        } else {
            Ok(None)
        }
    });
    match recovery {
        Ok(Some(found)) if found.database.is_some() && found.resettable() => {
            problem.said = if found.volumes.len() > 1 {
                "OpenBot found a database and other data from a previous installation, but its encryption key is unavailable. Restore the original key to keep its saved data, or choose Start fresh to delete it."
            } else {
                "OpenBot found a database from a previous installation, but its encryption key is unavailable. Restore the original key to keep its saved data, or choose Start fresh to delete it."
            }
            .into();
            problem.leftover = Some(Box::new(LeftoverReset {
                containers: found.container_names(),
                volumes: found.volumes,
            }));
            problem.database_reset = found.database;
        }
        Ok(Some(found)) if found.database.is_some() => {
            if let Some(running) = found.running_said() {
                problem.said = format!("{} {running}", problem.said);
            }
        }
        Ok(_) => {}
        Err(verification) => problem.detail = Some(verification_detail(verification)),
    }
    Err(problem)
}

/// The reset a refused Start offered, bound to the exact containers and volumes it named.
fn leftover_offer(
    problem: &Problem,
    root: &Path,
    address: &engine::Address,
) -> Option<LeftoverDatabase> {
    (!problem.leftover_volumes().is_empty()).then(|| LeftoverDatabase {
        root: root.to_path_buf(),
        volumes: problem.leftover_volumes().to_vec(),
        containers: problem.leftover_containers().to_vec(),
        address: address.clone(),
    })
}

fn verification_detail(verification: Problem) -> String {
    match verification.detail {
        Some(detail) => format!("{}\n{detail}", verification.said),
        None => verification.said,
    }
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
        Problem::plain("OpenBot could not verify that this is an unconfigured installation. Its leftover data cannot be reset here.")
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
    volumes: &[String],
    containers: &[String],
    confirmed: bool,
    read_secrets: impl FnOnce() -> Result<stack::Secrets, Problem>,
    reset: impl FnOnce(&LeftoverDatabase, &stack::Secrets) -> Result<(), Problem>,
) -> Result<(), Problem> {
    if !confirmed {
        return Err(Problem::plain(
            "Confirm that you want to permanently delete the leftover data before resetting it.",
        ));
    }
    let attempt = StartAttempt::begin(shell)?;
    let _startup = attempt.lock_current()?;
    if shell.containers.lock().unwrap().is_some() || shell.root.lock().unwrap().is_some() {
        return Err(Problem::plain("OpenBot still owns running services. Choose Stop OpenBot before resetting leftover data."));
    }
    if shell
        .selected_root
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|selected| selected != root)
    {
        return Err(Problem::plain(
            "The selected installation changed. Try Start again.",
        ));
    }
    let sorted = |names: &[String]| {
        let mut names = names.to_vec();
        names.sort();
        names
    };
    let (volumes, containers) = (sorted(volumes), sorted(containers));
    // The removal receives the offer itself, so it can only remove the set this check matched.
    let offer = shell.leftover_database.lock().unwrap().as_ref()
        .filter(|offer| {
            offer.root == root
                && !volumes.is_empty()
                && offer.volumes == volumes
                && offer.containers == containers
        })
        .cloned()
        .ok_or_else(|| Problem::plain("The leftover data changed after it was shown. Try Start again to see what is left now."))?;
    let secrets = read_secrets()?;
    if !fresh_root_without_encryption_key(root, &secrets)? {
        return Err(Problem::plain("This installation is already configured or has its original encryption key. Its data cannot be reset here."));
    }
    reset(&offer, &secrets)?;
    *shell.leftover_database.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
async fn reset_leftover_database<R: tauri::Runtime>(
    root: String,
    volumes: Vec<String>,
    containers: Vec<String>,
    confirmed: bool,
    app: tauri::AppHandle<R>,
) -> Result<(), Problem> {
    let root = stack::root_from(&root);
    let shell = app.state::<Shell>();
    reset_leftover_database_with(
        &shell,
        &root,
        &volumes,
        &containers,
        confirmed,
        || {
            openbot_desktop_lib::vault::already_given_no_ui(
                &root,
                &root.join(".env"),
                &openbot_env::MINTED[..],
            )
        },
        |offer, secrets| {
            stack::reset_leftover_volumes(
                &offer.address,
                &root,
                secrets,
                &offer.volumes,
                &offer.containers,
            )
        },
    )
}

/// Write the `.env`, raise the containers, migrate, then wait for the server container to answer.
///
/// `api_url` and `gateway_ws_url` are the local Intelligence stack's addresses; its key is the one
/// `local connect` gave OpenBot, read from the credential store.
#[tauri::command]
async fn start_stack<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: String,
    api_url: String,
    gateway_ws_url: String,
    model: ChosenModel,
    // The row the person picked, with the address only for the bring-your-own row.
    harness: Option<harness::HarnessChoice>,
    // Both registers on the way out: see `problem.rs`. Anything that still returns a bare string
    // converts to the plain half, so a path without its own sentence reads as it always did.
) -> Result<(), openbot_desktop_lib::problem::Problem> {
    let asked = std::time::Instant::now();
    // The choices, never the values: which provider and how, not the key or the address.
    log::info!(
        "[start] asked in {root}: model {} by {}, Bot {}",
        model.provider,
        model.login,
        harness.as_ref().map_or("none", |chosen| chosen.id.as_str())
    );
    let failures = desktop_telemetry::failures_recorded(&app);
    setup_phase("start");
    let telemetry_app = app.clone();
    let started = start_stack_now(app, root, api_url, gateway_ws_url, model, harness).await;
    logging::outcome("start", asked, &started);
    // Every way Start can fail sends one `setup_failed`: a row that failed has sent it already,
    // and any other return (a failed `compose up` among them) sends it here.
    if let Err(problem) = &started {
        desktop_telemetry::unreported_failure(
            &telemetry_app,
            failures,
            current_setup_phase(),
            problem,
            refused_not_failed(problem),
        );
    }
    started
}

async fn start_stack_now<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: String,
    api_url: String,
    gateway_ws_url: String,
    model: ChosenModel,
    harness: Option<harness::HarnessChoice>,
) -> Result<(), Problem> {
    if app
        .state::<Shell>()
        .updating
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err(Problem::plain(
            "OpenBot is updating. Wait for it to finish before starting.",
        ));
    }
    let root = stack::root_from(&root);
    // Only the upgrade puts its previous version back (`upgrade_and_start`).
    if upgrade::interrupted(&root) {
        return Err(Problem::plain(UPGRADE_INTERRUPTED));
    }
    let menus = app.clone();
    let started = start_stack_inner(app, root, api_url, gateway_ws_url, model, harness).await;
    // The menu bar says whether OpenBot is running.
    refresh_menus(&menus);
    // Setup is done once OpenBot starts: the window hands over to it at once. Recorded once.
    if started.is_ok() {
        desktop_telemetry::record(&menus, telemetry::EventData::Activated);
        // Attribution after Start, in the background: OpenBot is already open.
        desktop_telemetry::link_account_after_start(&menus);
    }
    started
}

async fn start_stack_inner<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: PathBuf,
    api_url: String,
    gateway_ws_url: String,
    model: ChosenModel,
    harness: Option<harness::HarnessChoice>,
) -> Result<(), Problem> {
    let shell = app.state::<Shell>();
    let attempt = StartAttempt::begin(&shell)?;
    install_recorder_host_at_start();
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

    // The installation's own engine, brought up when it is stopped: here, before startup is held,
    // because it can take minutes and Quit must not wait on it. See `wake_saved_engine`.
    let saved = preparation::saved_engine(&root);
    let owned = shell.containers.lock().unwrap().is_some();
    if !owned {
        engine_before_compose(
            async || {
                wake_installation_engine(&app, saved).await?;
                attempt.require_current()
            },
            async || {
                tauri::async_runtime::spawn_blocking(move || engine::detect_saved(saved))
                    .await
                    .ok()
                    .and_then(|status| status.address.filter(|_| status.responding))
            },
            async |address| {
                engine_new_enough(&app, address).await?;
                attempt.require_current()
            },
        )
        .await?;
    }

    // Minted before Compose, because the server is a container now and Compose is how it gets its
    // environment. Never persisted: it goes into `secrets` only after they are written to the
    // credential store, and the Compose file names it for the `server` service alone, so model
    // workers, Bots and the worker cannot impersonate the native approval transport.
    use base64::Engine as _;
    let host_token =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());

    let (found, secrets, ports) = {
        let _startup = attempt.lock_current()?;

        // Belt and braces: a fetch that reported success and left something out is still not a
        // deployment, and Compose's own error would not say which part was missing.
        setup_phase("deployment");
        if let Some(problem) = stack::deployment_problem(&root) {
            report(&app, "deployment", false, problem.clone());
            return Err(problem.into());
        }
        setup_phase("engine");

        let owned_address = shell
            .containers
            .lock()
            .unwrap()
            .as_ref()
            .map(|owned| owned.address.clone());
        let status = match owned_address {
            Some(address) => address.status(),
            None => engine::detect_saved(saved),
        };
        let Some(found) = status.address.clone().filter(|_| status.responding) else {
            return Err(status.detail.into());
        };
        let found = found.pin()?;
        // Decided here, before anything below runs Compose, so a project that cannot be decided
        // stops Start with the reason instead of starting under a name. Never the folder's name
        // alone: a source checkout called `openbot` runs as that too. See `stack::project`.
        stack::project(&found, &root)?;
        // Intelligence runs on the engine OpenBot is about to run on. See `local_eval::use_engine`.
        local_eval::use_engine(&found);
        #[cfg(target_os = "linux")]
        ensure_linux_podman_api(&shell, &found)?;
        /*
         * A rootless network namespace that predates the host loopback configuration keeps the old
         * options for as long as any container holds it, and an OpenBot left running by an earlier
         * version does. Taken down once, here, so the containers about to start build a new one,
         * and acknowledged only once that worked, so "Try Start again" tries the teardown again.
         * See `engine::local_api::Service::host_loopback_reset_pending`.
         */
        #[cfg(target_os = "linux")]
        if shell
            .podman_api
            .lock()
            .unwrap()
            .host_loopback_reset_pending()
        {
            stack::down(&found, &root).map_err(|error| {
                Problem::with(
                    "OpenBot couldn't restart with its new network settings. Try Start again.",
                    error,
                )
            })?;
            shell
                .podman_api
                .lock()
                .unwrap()
                .acknowledge_host_loopback_reset()?;
        }
        #[cfg(target_os = "linux")]
        let status = found.status();
        acquire::prepare_for_compose(&found)?;
        preparation::require(&root, Some(&requested_harness), &found)?;
        // An installation from before engines were saved is pinned to the one its images were
        // just found on. Best effort: Start does not fail over a hint for next time.
        if saved.is_none() {
            let _ = preparation::save_engine(&root, found.engine);
        }

        // Checked here as well as in the health gate, because the gate only runs when an engine had to
        // be installed. A machine that already had Podman skips all of that and arrives at Compose,
        // which is exactly the machine this was found on.
        if !found.composes() {
            let problem = acquire::missing_compose(found.engine.binary());
            report(&app, "engine", false, problem.clone());
            return Err(problem.into());
        }

        setup_phase("env");
        let api_key = intelligence_key_for_start(&root, saved_secret)?;
        let existing_secrets = openbot_desktop_lib::vault::already_given_no_ui(
            &root,
            &root.join(".env"),
            &openbot_env::MINTED[..],
        )?;
        require_existing_encryption_key_with_recovery(
            &root,
            &existing_secrets,
            || stack::postgres_volume_exists(&found, &root, &existing_secrets),
            || stack::leftover_volumes(&found, &root, &existing_secrets),
        )
        .inspect_err(|problem| {
            *shell.leftover_database.lock().unwrap() = leftover_offer(problem, &root, &found);
        })?;

        /*
         * Only this deployment's recorded hosts are reclaimed; its existing containers are reusable.
         *
         * THIS IS ALSO THE UPGRADE. An installation from before the server was a container still
         * has its Bun server, app and worker on the host, recorded in `host-pids.json` and holding
         * the very ports the `server` container is about to publish. Stopping them here, and waiting
         * for their sockets to close, is what lets that `up` bind them.
         */
        let previous_ports = openbot_env::Ports::read(&root).map_err(|error| {
            Problem::with("OpenBot could not read its local ports.", error.to_string())
        })?;
        setup_phase("cleanup");
        let reclaimed = cleanup_before_start(&app, &attempt, &root, stack::stop_processes_under)?;
        if reclaimed > 0 {
            stack::wait_for_ports_to_clear(
                &[previous_ports.server, previous_ports.app],
                std::time::Duration::from_secs(5),
            );
        }
        setup_phase("ports");
        let ours = stack::ports_we_already_publish(&found, &root);
        // The last run's own ports are waited for before anything moves off them (`for_start`).
        let own = openbot_env::Ports::recorded(&root).map_err(|error| {
            Problem::with("OpenBot could not read its local ports.", error.to_string())
        })?;
        let ports = previous_ports
            .for_start(
                &own,
                &ours,
                picked.as_ref().and_then(|picked| picked.installed_port()),
                openbot_env::OWN_PORTS_PATIENCE,
            )
            .map_err(|error| {
                Problem::with(
                    "OpenBot could not find available local ports. Try Start again.",
                    error.to_string(),
                )
            })?;

        setup_phase("env");
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
        for (key, value) in openbot_env::read_already_set(
            &root.join(".env"),
            &[
                "TENANT_PACKAGE_DIR",
                "COMPUTER_NAMESPACE",
                "COMPOSE_PROJECT_NAME",
                "COMPOSE_PROFILES",
                "COMPOSE_FILE",
            ],
        )
        .map_err(|e| Problem::from(e.to_string()))?
        {
            settings.insert(key, value);
        }
        /*
         * Each Bot's computer on the network the server container is on.
         *
         * The supervisor publishes a computer on a loopback port of the host unless this names a
         * network to attach it to instead, and a loopback port on the host is not one the server
         * container can open. `default` is the network the server shares with the Bots, under the
         * project this installation runs as. See `stack::project`.
         */
        settings.insert(
            "COMPUTER_NETWORK".into(),
            format!("{}_default", stack::project(&found, &root)?),
        );
        /*
         * On Linux the server runs as the person, not as the image's user.
         *
         * The model sign-in file is theirs and readable by nobody else, and a bind mount on Linux
         * keeps the host's numbers, so the image's 1001 could not read it. The deployment folder is
         * the one this app made for them, so its owner is who that is, with no call out to `id`.
         * Docker Desktop on macOS and Windows maps ownership itself, and there the default stays.
         * Rootless Podman is the exception on Linux; see `linux_server_user`.
         */
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::MetadataExt as _;
            let owner = std::fs::metadata(&root).map_err(|error| {
                Problem::with(
                    "OpenBot could not read its installation folder.",
                    format!("{}: {error}", root.display()),
                )
            })?;
            settings.insert(
                "OPENBOT_SERVER_USER".into(),
                linux_server_user(found.engine, owner.uid(), owner.gid()),
            );
        }
        let (settings, mut secrets) = persist_start_environment(&root, settings, &credential)?;
        report_plain(&app, "env", true, "Your settings are saved.");
        // Compose gives inherited environment precedence over .env. Pin this run's chosen ports.
        secrets.extend(ports.settings());
        for key in [
            "PICKED_HARNESS_PORT",
            "OPENBOT_TOOL_URL",
            "COMPUTER_NETWORK",
            "OPENBOT_SERVER_USER",
        ] {
            if let Some(value) = settings.get(key) {
                secrets.insert(key.into(), value.clone());
            }
        }
        // The identity as it stands: Start never waits for `telemetry link`, which runs after it.
        // Handed to Compose with the rest; a service receives only what the Compose file names.
        secrets.extend(desktop_telemetry::runtime_env(&app));
        // After the credential store has been written, so the token never is. See where it is
        // minted above.
        secrets.insert("OPENBOT_DESKTOP_HOST_TOKEN".into(), host_token.clone());

        // Compose's bind mount of the sign-in folder does not create it. Installation made it;
        // made again here in case it went since. See `stack::make_sign_in_folder`.
        stack::make_sign_in_folder(&root)?;

        // Installation already verified these images. Start only raises the local containers;
        // its no-pull policy sends missing assets back to the installation step.
        report_running_plain(&app, "services", "Starting OpenBot's services.");

        // Only an installed harness needs the local service; a BYO endpoint is already running elsewhere.
        let installed_harness = picked
            .as_ref()
            .and_then(|picked| picked.installed_port())
            .is_some();
        attempt.require_current()?;
        // Even a failed up can have started some services. Keep their root until down succeeds.
        *shell.containers.lock().unwrap() = Some(ContainerDeployment {
            root: root.clone(),
            address: found.clone(),
        });
        let requested_services = stack::up(&found, &root, installed_harness, &secrets)?;
        // The migrations ran with that: `migrate` is the dependency Compose completes before it
        // starts `server`, once, and a failed one fails the `up`.
        report_plain(&app, "services", true, "OpenBot's services are running.");

        // `compose up` succeeds once it has asked for everything. A service that then exits is not its
        // problem, and both Bots exit immediately without a model key. Reported and made fatal here;
        // otherwise the window can show a healthy stack while nothing can answer a question.
        require_no_exited_compose_services(&found, &root, &requested_services, |detail| {
            report(&app, "services", false, detail);
        })?;

        /*
         * The personal edition shares one computer, so a Bot's files and logins from the computer
         * the supervisor made for its person are brought into it, once (`stack::
         * carry_over_person_computers`). On every Start, the first one after an upgrade included,
         * and cheap once done. Not fatal: OpenBot runs, the old volumes keep everything, and the next
         * Start tries again.
         */
        let carried = deployment::reference(&root, "agent-computer")
            .and_then(|image| stack::carry_over_person_computers(&found, &root, &image));
        match carried {
            // How many, never whose: the person and their volumes are named after them.
            Ok(carried) => {
                if !carried.is_empty() {
                    log::info!(
                        "[start] carried {} people's Bots' files and sign-ins into the shared \
                         computer; the old volumes are left in place",
                        carried.len()
                    );
                }
            }
            Err(error) => {
                log::warn!("[start] could not carry Bots' files and sign-ins over: {error}");
                report_plain(
                    &app,
                    "carry-over",
                    false,
                    "Your Bots' files and sign-ins from before are not in place yet. OpenBot tries \
                     again the next time it starts.",
                );
            }
        }

        (found, secrets, ports)
    };

    /*
     * The server container answering, on both of the host ports it was given.
     *
     * No port check before this, as there was before spawning host processes: these ports are now
     * published by this deployment's own `server` container, which `Ports::available` already
     * counts as ours, and anybody else on them was avoided when the ports were chosen. Docker's
     * restart policy keeps it up from here, so there is nothing to supervise after it answers.
     */
    report_running_plain(
        &app,
        "answering",
        "Starting OpenBot. This can take a few minutes the first time.",
    );
    let ticket = attempt.generation;
    let waiting = app.clone();
    let ready = stack::Ready {
        api: ports.server,
        app: ports.app,
    };
    let answered = tauri::async_runtime::spawn_blocking(move || {
        stack::wait_until_healthy(&ready, std::time::Duration::from_secs(180), || {
            waiting
                .state::<Shell>()
                .start_generation
                .load(std::sync::atomic::Ordering::SeqCst)
                == ticket
        })
    })
    .await
    .unwrap_or_else(|error| Err(format!("the wait did not run: {error}")));
    // A Stop during the wait is the reason it ended, whatever the wait itself says.
    attempt.require_current()?;
    if let Err(error) = answered {
        // What the server said while it was not answering, from Compose's log, with every
        // credential this run handed out taken out of it.
        let log = stack::service_log(&found, &root, "server", 40);
        let detail = if log.is_empty() {
            "The server container wrote nothing to its log.".to_string()
        } else {
            format!("Last from the server container (up to 40 lines):\n{log}")
        };
        let problem = stack::startup_problem(Problem::with(error, detail), &secrets);
        report_plain(&app, "answering", false, problem.said.clone());
        return Err(problem);
    }
    // Stop must not finish between accepting readiness and reporting a successful Start.
    let _startup = attempt.lock_current()?;
    *shell.root.lock().unwrap() = Some(root.clone());
    clear_recovery_required(&shell, &root);
    let generation = shell.generation.load(std::sync::atomic::Ordering::SeqCst);
    let address = shell
        .containers
        .lock()
        .unwrap()
        .as_ref()
        .map(|owned| owned.address.clone())
        .ok_or_else(|| {
            Problem::with(
                "The software OpenBot runs on isn't running. Try Start again.",
                "the local container runtime is unavailable",
            )
        })?;
    let broker = start_host_access(&app, &root, ports.server, address, host_token.clone())?;
    *shell.host_access.lock().unwrap() = Some(broker);
    preparation::record_launch(&root, requested_harness.as_ref())?;
    let config = app.path().app_config_dir().map_err(|error| {
        Problem::with(
            "OpenBot could not remember this installation for next time.",
            error.to_string(),
        )
    })?;
    preparation::save_selected_root(&config, &root)?;
    give_learning_its_model(
        app.clone(),
        root.clone(),
        found.clone(),
        credential,
        ports.server,
        secrets
            .get(openbot_desktop_lib::learning_model::TOKEN)
            .cloned()
            .unwrap_or_default(),
    );
    watch_connections(app.clone(), root, host_token, generation, ports.server);

    report_plain(&app, "answering", true, "OpenBot is ready.");
    Ok(())
}

/**
Give local Intelligence's Learning agent the model the person signed in to, once OpenBot answers.
See `learning_model`.

In the background, on its own thread. Learning is not what Start waits on, and a CLI call that
fails here leaves OpenBot running, Settings saying why Learning can't run, and the next Start trying
again. The CLI takes its turn with the window's own calls (`local_eval::one_at_a_time`).
*/
fn give_learning_its_model<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: PathBuf,
    engine: engine::Address,
    credential: openbot_env::ModelCredential,
    server_port: u16,
    token: String,
) {
    use openbot_desktop_lib::learning_model;
    std::thread::spawn(move || {
        let attempt = format!("learning-model-{:016x}", rand::random::<u64>());
        let given = learning_model::apply(
            &root,
            &credential,
            server_port,
            &token,
            || stack::host_gateway_ipv4(&engine, &root),
            |stack| local_eval::run_installed(&attempt, local_eval::Action::Status, stack),
            |file| local_eval::configure_learning_model_installed(&attempt, &root, file),
        );
        match given {
            learning_model::Given::Nothing => {}
            learning_model::Given::Given => {
                log::info!("[learning] the Learning agent has the model this sign-in gives it")
            }
            other => {
                log::warn!("[learning] the Learning agent's model was not changed: {other:?}");
                if let Some(failure) = learning_failure(&other) {
                    desktop_telemetry::setup_failed(&app, failure);
                }
            }
        }
    });
}

/// A Learning model the CLI did not take, as usage data. Waiting for the stack is not a failure.
fn learning_failure(
    given: &openbot_desktop_lib::learning_model::Given,
) -> Option<desktop_telemetry::SetupFailure> {
    use openbot_desktop_lib::learning_model::Given;
    use telemetry::{FailingStep, SetupErrorClass};
    let step = FailingStep::LearningModel;
    match given {
        Given::Nothing | Given::NotReady | Given::Given => None,
        Given::Refused(_) => Some(desktop_telemetry::SetupFailure::new(
            step,
            SetupErrorClass::Unknown,
        )),
        Given::NoAddress => Some(desktop_telemetry::SetupFailure::new(
            step,
            SetupErrorClass::InvalidConfiguration,
        )),
        Given::Failed(said) => Some(desktop_telemetry::SetupFailure::new(
            step,
            desktop_telemetry::class_of_row(step, said),
        )),
    }
}

/// Local folder access for the deployment at `root`, answering to its server with the per-run
/// host token that server was given.
fn start_host_access<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    root: &Path,
    server_port: u16,
    address: engine::Address,
    host_token: String,
) -> Result<host_access::HostAccess, Problem> {
    let config = host_access::HostAccessConfig::new(
        format!("http://127.0.0.1:{server_port}"),
        host_token,
        address,
        deployment::reference(root, "agent-computer")?,
        vec![root.to_path_buf()],
    );
    host_access::HostAccess::start_with_approval(
        config,
        std::sync::Arc::new(desktop_host_access::NativeApproval(app.clone())),
    )
    .map_err(|error| Problem::with("Local folder access could not start.", error.to_string()))
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
    let asked = std::time::Instant::now();
    log_stop_asked(
        &app.state::<Shell>(),
        &stack::root_from(&root),
        AskedFrom::SetupWindow,
    );
    // Inventory, held-child cleanup and Compose all block. Keep the complete shutdown off both
    // Tauri's event loop and its async workers, and resolve IPC only when shutdown has finished.
    let stopped = tauri::async_runtime::spawn_blocking(move || {
        stop_everything(&app, &stack::root_from(&root)).into_result()
    })
    .await
    .map_err(|error| format!("the shutdown did not run: {error}"))
    .and_then(|stopped| stopped);
    logging::outcome("stop", asked, &stopped);
    stopped
}

/// Where Stop or Restart was asked from, for its first entry in the log. Each is reached from
/// several places, and a log that cannot say which leaves the reader guessing what was pressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AskedFrom {
    /// The setup window's Stop.
    SetupWindow,
    /// Settings > This computer, in OpenBot's own page.
    Settings,
    StatusWindow,
    /// Stop OpenBot in the tray or the window menu.
    Menu,
    Quit,
}

impl AskedFrom {
    fn said(self) -> &'static str {
        match self {
            AskedFrom::SetupWindow => "from the setup window",
            AskedFrom::Settings => "from Settings",
            AskedFrom::StatusWindow => "from the Status window",
            AskedFrom::Menu => "from the menu",
            AskedFrom::Quit => "by Quit",
        }
    }
}

/// Stop's first entry, as Start's: `[stop] asked in ~/OpenBot from Settings`, naming the
/// installation it is about to stop. `logging::outcome` writes its last.
fn log_stop_asked(shell: &Shell, fallback_root: &Path, from: AskedFrom) {
    let root = cleanup_root(shell, fallback_root);
    log::info!("[stop] asked in {} {}", root.display(), from.said());
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

/// Take the whole stack down: any host processes an installation from before the server was a
/// container left running, the containers, and the local Intelligence stack if OpenBot created it.
///
/// One implementation, because there are three ways to ask for it (the button, the menu bar, and
/// quitting) and a person who used one of them and got a different amount of stopping would be
/// right to call that a bug.
fn stop_everything<R: tauri::Runtime>(app: &tauri::AppHandle<R>, fallback_root: &Path) -> Stopped {
    let shell = app.state::<Shell>();
    // A person's stop outranks an update that is under way.
    shell
        .update_cancelled
        .store(true, std::sync::atomic::Ordering::SeqCst);
    stop_everything_for(&shell, fallback_root)
}

/// Stop OpenBot's own processes and containers so an update can replace their files, without
/// cancelling that update. The local Intelligence stack is left running: an update does
/// not touch it, and the restart that follows finds it already up.
fn stop_for_update<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    fallback_root: &Path,
) -> Result<(), String> {
    let shell = app.state::<Shell>();
    let root = root_for_stop(&shell, fallback_root);
    stop_everything_then(
        &shell,
        &root,
        stack::stop_processes_under,
        |root| down_owned_containers(&shell, root),
        |_| Ok(()),
    )
    .into_result()
}

/// Stop as the button and the menu bar run it.
fn stop_everything_for(shell: &Shell, fallback_root: &Path) -> Stopped {
    let root = root_for_stop(shell, fallback_root);
    let (down, intelligence) = healed_once_before(
        |root: &Path| {
            if let Some(address) = engine_for_stop(shell, root) {
                answering_before_stop(&address);
            }
        },
        |root: &Path| down_owned_containers(shell, root),
        intelligence_step(Shutdown::Stop),
    );
    stop_everything_then(
        shell,
        &root,
        stack::stop_processes_under,
        down,
        intelligence,
    )
}

/// Quit's cleanup as the exit handler runs it, telling `progress` as each part starts and ends.
fn quit_cleanup<P>(shell: &Shell, mut progress: P) -> Stopped
where
    P: FnMut(QuitStep, QuitStepState),
{
    // A ChatGPT sign-in left waiting would keep its container, and the callback port, after Quit.
    openbot_desktop_lib::plan::release_chatgpt_callback_port();
    let (down, intelligence) = healed_once_before(
        |root: &Path| {
            if let Some(address) = engine_for_stop(shell, root) {
                answering_before_stop(&address);
            }
        },
        |root: &Path| down_containers_on_quit(shell, root),
        intelligence_step(Shutdown::Quit),
    );
    let stopped = exit_cleanup_reporting(
        shell,
        &stack::default_root(),
        stack::stop_processes_under,
        down,
        intelligence,
        &mut progress,
    );
    // Last, once nothing of OpenBot's runs in its machine: the person's Podman OpenBot paused.
    give_back_paused_podman(&mut progress);
    stopped
}

/**
Quit with the Shutting down screen in front: the window comes back and shows each part of the
cleanup as it runs, then the app exits as it always has.

The window only listens. Nothing here waits for it: with no window, or a page that never loads,
the same cleanup runs in the same order and the exit follows.
*/
fn quit_cleanup_shown<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<String> {
    // A setup window that stopped answering and still has not: said before the flush below.
    desktop_stall::at_quit(app);
    show_shutting_down(app);
    desktop_telemetry::shutdown(app);
    let shell = app.state::<Shell>();
    let asked = std::time::Instant::now();
    log_stop_asked(&shell, &stack::default_root(), AskedFrom::Quit);
    let failures = quit_cleanup(&shell, |step, state| report_quit(app, step, state)).lines();
    let stopped = if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("\n"))
    };
    logging::outcome("stop", asked, &stopped);
    failures
}

/// The window event that carries the Shutting down screen's rows, the whole list each time.
const QUIT_PROGRESS_EVENT: &str = "quit:progress";

/// The setup page's fragment that opens it on the Shutting down screen alone.
const SHUTTING_DOWN_FRAGMENT: &str = "shutting-down";

/// A row on the Shutting down screen. Fixed ids and fixed words: nothing the CLI said reaches it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QuitStep {
    /// A back end update past the point it can stop safely, let finish first
    /// (`local_eval::close_for_quit_reporting`).
    FinishUpdate,
    /// Host processes, Compose down, and on Linux the Podman API.
    OpenBot,
    /// The local Intelligence stack OpenBot created.
    Intelligence,
    /// On a Mac, the person's Podman that OpenBot paused while it ran, started again. See
    /// `own_machine`.
    GiveBackPodman,
}

impl QuitStep {
    fn id(self) -> &'static str {
        match self {
            QuitStep::FinishUpdate => "finish-update",
            QuitStep::OpenBot => "stop-openbot",
            QuitStep::Intelligence => "stop-intelligence",
            QuitStep::GiveBackPodman => "start-your-podman",
        }
    }

    /// What the row says while it runs: its name says it, and the Shutting down screen's journey
    /// says why ("Finishing the update so nothing is left half done").
    fn running_detail(self) -> &'static str {
        match self {
            QuitStep::FinishUpdate
            | QuitStep::OpenBot
            | QuitStep::Intelligence
            | QuitStep::GiveBackPodman => "",
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
            detail: if state == QuitStepState::Running {
                step.running_detail().into()
            } else {
                String::new()
            },
            running: state == QuitStepState::Running,
            download_bytes: None,
            downloads: None,
            elsewhere: false,
            asks: false,
            updating: false,
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
    log::info!("[quit] {step:?}: {state:?}");
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
    let not_stopped =
        |why: String| format!("the backend's command-line tool did not stop the backend ({why})");
    match stop(&state.stack_id()) {
        Ok(report) => match report.outcome {
            local_eval::Outcome::Completed => Ok(()),
            outcome => Err(not_stopped(match report.reason {
                Some(reason) => format!("{}: {}", wire_name(outcome), wire_name(reason)),
                None => wire_name(outcome),
            })),
        },
        Err(local_eval::Failure::Unavailable) => {
            Err("this build has no command-line tool to stop the backend OpenBot created".into())
        }
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
/**
A Podman machine whose Docker API has gone, stopped and started once before Stop or Quit stops
anything (`engine_versions::answering_now`). Both stops reach the engine through that API:
OpenBot's `compose down`, and the back end's `local stop`, which the CLI refuses as
"docker_unavailable" without it. The containers that were running in the machine, OpenBot's and the
back end's among them, are started with it, and the two stops then stop them as they always do.

On a live Windows run, with the machine's `win-sshproxy` gone, Quit failed both, and the next launch
opened on "When OpenBot last quit, some of its services didn't stop". What still fails after this
is reported as before.
*/
fn answering_before_stop(address: &engine::Address) {
    // Only a machine that answers `podman` while its API has gone. One that does not answer at all
    // may have been stopped by the person, and Quit never starts it.
    if address.engine != engine::Engine::Podman || !address.responds() {
        return;
    }
    let back = || {};
    let cancelled = || false;
    let mut updates = engine_versions::OnThisMachine {
        address: address.clone(),
        cache: stack::default_root(),
        back: &back,
        cancelled: &cancelled,
    };
    match engine_versions::answering_now(
        address.engine,
        std::env::consts::OS,
        &mut updates,
        &mut |line| log::info!("[stop] {}", line.log_entry()),
    ) {
        Ok(true) => log::info!("[stop] the engine answers again after its machine restarted"),
        Ok(false) => {}
        Err(problem) => log::warn!(
            "[stop] the engine does not answer: {}",
            problem.detail.as_deref().unwrap_or(&problem.said)
        ),
    }
}

/// The engine Stop and Quit stop things on: OpenBot's own containers' while they run, otherwise
/// the one the installation at `root` was set up on, when it answers.
fn engine_for_stop(shell: &Shell, root: &Path) -> Option<engine::Address> {
    // Only a Podman machine on a Mac or a PC has an API of its own to lose.
    if !cfg!(any(target_os = "macos", target_os = "windows")) {
        return None;
    }
    let owned = shell
        .containers
        .lock()
        .unwrap()
        .as_ref()
        .map(|owned| owned.address.clone());
    // Without OpenBot's own containers, only an installation on Podman is asked about: nothing else
    // has a machine to restart, and a Stop with nothing to stop runs no engine command.
    owned.or_else(|| {
        if preparation::saved_engine(root) != Some(engine::Engine::Podman) {
            return None;
        }
        let found = engine::detect_saved(Some(engine::Engine::Podman));
        found.address.filter(|_| found.responding)
    })
}

/// `down` and `intelligence`, the two stops, each after one `heal` shared between them: whichever
/// runs first heals, and the other finds it done. Both stops need the engine's API, and a machine
/// is restarted at most once for the two.
/// One of Stop's stops, as `stop_everything_then` and `exit_cleanup_reporting` take it.
type StopStep<'a> = Box<dyn FnOnce(&Path) -> Result<(), String> + 'a>;

fn healed_once_before<'a, H, D, I>(
    heal: H,
    down: D,
    intelligence: I,
) -> (StopStep<'a>, StopStep<'a>)
where
    H: FnOnce(&Path) + 'a,
    D: FnOnce(&Path) -> Result<(), String> + 'a,
    I: FnOnce(&Path) -> Result<(), String> + 'a,
{
    let heal = std::rc::Rc::new(std::cell::RefCell::new(Some(heal)));
    let once = {
        let heal = heal.clone();
        move |root: &Path| {
            if let Some(heal) = heal.borrow_mut().take() {
                heal(root);
            }
        }
    };
    let again = once.clone();
    (
        Box::new(move |root: &Path| {
            once(root);
            down(root)
        }),
        Box::new(move |root: &Path| {
            again(root);
            intelligence(root)
        }),
    )
}

fn down_containers_on_quit(shell: &Shell, root: &Path) -> Result<(), String> {
    if shell.containers.lock().unwrap().is_none() {
        return Ok(());
    }
    down_owned_containers(shell, root)
}

/// Stop what this session holds and then what the deployment's records name. The records are
/// how an installation from before the server was a container still has Bun processes on the
/// host to stop; a current one has none, and the cleanup finds nothing. Keep failed cleanup
/// owned for a later Stop.
fn cleanup_host_state<C>(shell: &Shell, root: &Path, cleanup: C) -> Result<usize, Problem>
where
    C: FnOnce(&Path) -> Result<usize, Problem>,
{
    // Also runs for startup replacement and failure recovery, so a retired authorization session
    // cannot leave a job running beside a new server.
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
    let selected = shell
        .root
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| root.to_path_buf());
    let result = cleanup(&selected);
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

/// Write this run's settings, store its credentials, and answer with what the host processes get.
fn persist_start_environment(
    root: &Path,
    settings: std::collections::BTreeMap<String, String>,
    credential: &openbot_env::ModelCredential,
) -> Result<(std::collections::BTreeMap<String, String>, stack::Secrets), Problem> {
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
    for key in openbot_env::REMOVED_WHEN_UNSET {
        if !settings.contains_key(key) {
            purge.insert(key.into(), String::new());
        }
    }
    openbot_desktop_lib::saved_intent::persist_configuration(
        root, &settings, &secrets, &purge, credential,
    )?;
    /*
     * This installation's Composio project, for an installation signed in to CopilotKit with no
     * key yet: one signed in under 0.3.0, which never asked, or one whose sign-in-time attempt
     * failed. Asks nobody when a key is supplied or already kept. Never fatal.
     */
    if local_eval_state::read(root, None).is_some() {
        static STARTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let attempt = format!(
            "apps-start-{}",
            STARTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        if let Err(problem) = connect_apps(root, &attempt) {
            log::warn!("[apps] {}", problem.said);
        }
    }
    /*
     * The app broker's settings, read where the person keeps them and handed over at runtime only.
     *
     * None of them is written, moved or purged. A Composio key in `.env` stays in `.env` and wins;
     * a provisioned one stays in the protected store. Pinning them here also beats a blank value
     * inherited from this app's own environment, which Bun would otherwise prefer to `.env`.
     * Never fatal: without them, OpenBot starts with apps unavailable.
     */
    match openbot_desktop_lib::composio::resolve(root) {
        Ok(brokers) => secrets.extend(brokers.runtime()),
        Err(problem) => log::warn!("[apps] {}", problem.said),
    }
    Ok((settings, secrets))
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
    // Preflight can fail while the previous run is still serving. Retire its connection watcher
    // only when replacement actually begins, so a refusal it finds now cannot be published
    // against the run that replaces it.
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
                "{}: could not write the backend shutdown notice: {error}",
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
        "When OpenBot last quit, some of its services didn't stop. They may still be running. \
         Stopping OpenBot again asks them to stop.",
        "the backend stack did not stop when OpenBot last quit",
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
    // A back end update that has begun changing the release is let finish, and its row says so:
    // stopping it there left a back end no later update could get past.
    if local_eval::close_for_quit_reporting(|| {
        progress(QuitStep::FinishUpdate, QuitStepState::Running)
    }) {
        progress(QuitStep::FinishUpdate, QuitStepState::Complete);
    }
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
    let asked = std::time::Instant::now();
    log::info!("[show] asked");
    let shown = tauri::async_runtime::spawn_blocking(move || {
        let ports = ports_for_shell(&app)?;
        show_openbot_on(app, &ports)
    })
    .await
    .map_err(|error| Problem::with("OpenBot could not open its window.", error.to_string()))
    .and_then(|shown| shown);
    logging::outcome("show", asked, &shown);
    shown
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
    if upgrade::interrupted(&root) {
        return Err(Problem::plain(UPGRADE_INTERRUPTED_SHOWING));
    }
    if recovery_required_or_pending_quit_notice(&shell, &root) {
        return Err("Part of OpenBot needs recovery. Try starting OpenBot once more.".into());
    }
    let (url, address) = owned_app(&shell, &root, ports).ok_or_else(|| {
        format!("OpenBot could not verify its app on port {port} belongs to this installation. Try starting OpenBot again.")
    })?;
    hold_shown_deployment(&app, &shell, &root, address, ports.server);
    refresh_menus(&app);
    // Only the owned app itself.
    trust_owned_app(&app, &url);
    // A debug build may show a developer's own app in its place, on this installation's back end.
    let destination = match dev_app_url() {
        Some(dev) => {
            trust_owned_app(&app, &dev);
            log::info!(
                "[show] showing the developer's app at {dev} in place of the installation's"
            );
            dev
        }
        None => url,
    };
    log::info!("[show] navigating to the owned OpenBot app");
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
    log::info!("[show] navigate returned {outcome:?}");
    // Setup is over and OpenBot is what the person uses now: in front, wherever they had gone
    // while it started.
    if outcome.is_ok() {
        bring_to_front(&app, "OpenBot is showing");
    }
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
/// show. The same values as `--surface-main` in styles.css (OpenBot's `--sidebar`, in sRGB).
#[cfg(any(target_os = "macos", target_os = "windows"))]
const SETUP_BACKGROUND: tauri::window::Color = tauri::window::Color(0xed, 0xed, 0xf5, 0xff);
#[cfg(any(target_os = "macos", target_os = "windows"))]
const SETUP_BACKGROUND_DARK: tauri::window::Color = tauri::window::Color(0x0d, 0x0b, 0x13, 0xff);

/// Whether `url` is the setup page rather than OpenBot.
fn on_setup_page<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &tauri::Url) -> bool {
    let setup = app.state::<Shell>().setup_url.lock().unwrap().clone();
    setup
        .and_then(|setup| setup.parse::<tauri::Url>().ok())
        .is_some_and(|setup| same_window_app(&setup, url))
}

/**
The appearance the setup screens use: OpenBot's own light or dark, the last time its page reported
one (`page_appearance`), and the system's until then. Both themes exist; the page follows the
window's appearance through `prefers-color-scheme`, so `Some(Dark)` or `Some(Light)` pins one.

OpenBot's, not the system's: somebody who set OpenBot to light on a Mac in dark mode saw setup in
dark, then OpenBot in light, as if they were two apps.
*/
fn setup_theme<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<tauri::Theme> {
    let record = app.path().app_config_dir().ok()?.join(APPEARANCE_FILE);
    theme_from_record(std::fs::read_to_string(record).ok().as_deref())
}

/// Where OpenBot's last light or dark is kept, in the app's own configuration folder.
const APPEARANCE_FILE: &str = "appearance.json";

/// The theme a saved record names, or None for no record or one that cannot be read.
fn theme_from_record(record: Option<&str>) -> Option<tauri::Theme> {
    let record: serde_json::Value = serde_json::from_str(record?).ok()?;
    match record.get("dark")?.as_bool()? {
        true => Some(tauri::Theme::Dark),
        false => Some(tauri::Theme::Light),
    }
}

/// Keep OpenBot's light or dark for the next setup screen. Best effort: a record that cannot be
/// written only means setup follows the system next time.
fn remember_appearance<R: tauri::Runtime>(app: &tauri::AppHandle<R>, dark: bool) {
    let Ok(directory) = app.path().app_config_dir() else {
        return;
    };
    let record = directory.join(APPEARANCE_FILE);
    let wanted = serde_json::json!({ "dark": dark }).to_string();
    if std::fs::read_to_string(&record).ok().as_deref() == Some(wanted.as_str()) {
        return;
    }
    let _ = std::fs::create_dir_all(&directory).and_then(|()| std::fs::write(&record, wanted));
}

/// What the window is showing, as far as its chrome is concerned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowPage {
    Setup,
    /// The OpenBot this shell verified it owns, served from this machine: its sidebar takes the
    /// title bar's place. A page on another loopback origin is `Other`.
    OwnedApp,
    /// OpenBot served from this machine, from a release whose styles make no room for the window
    /// buttons: the system's title bar, still in the app's own light or dark.
    LocalApp,
    /// Anything else: the system's title bar.
    Other,
}

/// The main window's guard: from OpenBot's own pages, a site outside OpenBot opens in the person's
/// default browser and the window stays where it is. The booking calendar a page embeds loads in
/// its frame. See `outside_links`.
fn outside_links_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("outside-links")
        .on_navigation(|webview, destination| {
            // A file dropped where nothing takes it opens nowhere (`outside_links::opens_a_file`).
            if webview.label() == "main" && outside_links::opens_a_file(destination) {
                log::info!("[window] kept the page; a dropped file does not replace it");
                return false;
            }
            if webview.label() != "main"
                || !outside_links::leaves(destination)
                || outside_links::loads_in_a_frame(destination)
            {
                return true;
            }
            let from_openbot = webview.url().is_ok_and(|current| {
                matches!(
                    window_page(webview.app_handle(), &current),
                    WindowPage::OwnedApp | WindowPage::LocalApp
                )
            });
            if !from_openbot {
                return true;
            }
            use tauri_plugin_opener::OpenerExt;
            let _ = webview
                .app_handle()
                .opener()
                .open_url(destination.as_str(), None::<&str>);
            false
        })
        .build()
}

/**
The main window, as `tauri.conf.json` describes it, built here rather than from the configuration so
it gets a new-window handler, which only a builder can attach: a new window asked for from it (a
link in the booking calendar's frame, which the page's shim can't reach) opens in the person's
browser for a site outside OpenBot, and nowhere otherwise. Without one, macOS opened nothing and
Windows opened a bare browser window of its own. The configuration says `"create": false`.
*/
/**
Where the main window's buttons sit on macOS: 20pt in from the left, and low enough that their middle
lines up with the first row of OpenBot's sidebar header (its name and +), which the page
moves right to clear them (app/src/styles.css, `data-desktop-titlebar`). That row's middle is 32pt
down (the inset sidebar's 8pt, the header's 8pt, then half its 32pt row), and on macOS 26 the
circles' middle lands about 1.5pt below `y`, so `y` is 31.

Set on the builder, not per page, because tao keeps it and puts the buttons back after anything that
moves them (a resize, leaving full screen), and Tauri 2.12 can't change it after the window exists.
So the setup screens have the buttons here too, where nothing of theirs is near them.
*/
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS: tauri::LogicalPosition<f64> = tauri::LogicalPosition { x: 20.0, y: 31.0 };

fn build_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
    else {
        return Ok(());
    };
    let opener = app.clone();
    let builder = tauri::WebviewWindowBuilder::from_config(app, &config)?;
    // The window's buttons on the same row as the OpenBot name and + in the sidebar's header, rather
    // than above them (`TRAFFIC_LIGHTS`, and the page's styles that make room beside them).
    #[cfg(target_os = "macos")]
    let builder = builder.traffic_light_position(TRAFFIC_LIGHTS);
    /*
     * Built visible, as the configured window always was, and built where it was last: the size
     * and place `tauri_plugin_window_state` saved go to the builder, so the first frame is already
     * there. Built at the system's default spot and moved after, a reopened window showed blank at
     * 104,104 for about 230 ms on Windows, then jumped to its saved 400,90. The plugin's own restore
     * then finds it already in place. Never built hidden to avoid that: on Windows a WebView2 page
     * under a window first created hidden stopped taking native updates mid-setup, for minutes,
     * until the window was activated or clicked.
     */
    let builder = match saved_main_window(app) {
        Some(place) => builder
            .position(place.x, place.y)
            .inner_size(place.width, place.height)
            .maximized(place.maximized),
        None => builder,
    };
    let window = builder
        .on_new_window(move |destination, _features| {
            outside_links::new_window(&destination, |to| {
                use tauri_plugin_opener::OpenerExt;
                let _ = opener.opener().open_url(to, None::<&str>);
            });
            tauri::webview::NewWindowResponse::Deny
        })
        .build()?;
    // At the level kept from the last launch before anything paints (`zoom`).
    let _ = window.set_zoom(saved_zoom(app));
    fit_main_window_to_screen(app);
    Ok(())
}

/// A window's state as `tauri_plugin_window_state` saves it (its `WindowState`): the outer
/// position and the inner size in physical pixels, and where it was before it was maximized.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Deserialize)]
#[serde(default)]
struct SavedWindow {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    prev_x: i32,
    prev_y: i32,
    maximized: bool,
}

/// A monitor as placing a window needs it: its whole area and work area in physical pixels, and
/// its scale.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Screen {
    position: (i32, i32),
    size: (u32, u32),
    work: (i32, i32, u32, u32),
    scale: f64,
}

/// Where to build a window, in logical pixels, as the builder takes it.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Place {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    maximized: bool,
}

/**
Where to build the main window from its saved state, on `screens` (the primary first): where it
was, on the screen it was on, in that screen's logical pixels; or, when no screen it was on is
there any more, the middle of the primary screen's work area. None when nothing is saved.
*/
fn place_saved_window(saved: SavedWindow, screens: &[Screen]) -> Option<Place> {
    if saved == SavedWindow::default() || saved.width == 0 || saved.height == 0 {
        return None;
    }
    let (x, y) = if saved.maximized {
        (saved.prev_x, saved.prev_y)
    } else {
        (saved.x, saved.y)
    };
    // The screen the window's top-left area is on, as the plugin checks it.
    let on = screens.iter().find(|screen| {
        let (left, top) = screen.position;
        let (width, height) = screen.size;
        let right = left + width as i32;
        let bottom = top + height as i32;
        x + saved.width as i32 > left && x < right && y + saved.height as i32 > top && y < bottom
    });
    match on {
        Some(screen) => Some(Place {
            x: f64::from(x) / screen.scale,
            y: f64::from(y) / screen.scale,
            width: f64::from(saved.width) / screen.scale,
            height: f64::from(saved.height) / screen.scale,
            maximized: saved.maximized,
        }),
        None => {
            let primary = screens.first()?;
            let (left, top, width, height) = primary.work;
            let fit_width = saved.width.min(width);
            let fit_height = saved.height.min(height);
            Some(Place {
                x: f64::from(left + (width - fit_width) as i32 / 2) / primary.scale,
                y: f64::from(top + (height - fit_height) as i32 / 2) / primary.scale,
                width: f64::from(fit_width) / primary.scale,
                height: f64::from(fit_height) / primary.scale,
                maximized: saved.maximized,
            })
        }
    }
}

/// The main window's saved place (`place_saved_window`), from the window-state plugin's file.
fn saved_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<Place> {
    // Tests build the window on Tauri's mock runtime, which has no monitors, and must not read
    // the developer's own saved window: `place_saved_window` is tested on its own.
    if cfg!(test) {
        return None;
    }
    let file = app
        .path()
        .app_config_dir()
        .ok()?
        .join(tauri_plugin_window_state::DEFAULT_FILENAME);
    let saved: std::collections::HashMap<String, SavedWindow> =
        serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    let saved = *saved.get("main")?;
    let primary = app.primary_monitor().ok().flatten();
    let mut monitors = app.available_monitors().unwrap_or_default();
    if let Some(primary) = &primary {
        monitors.sort_by_key(|monitor| monitor.name() != primary.name());
    }
    let screens: Vec<Screen> = monitors
        .iter()
        .map(|monitor| {
            let work = monitor.work_area();
            Screen {
                position: (monitor.position().x, monitor.position().y),
                size: (monitor.size().width, monitor.size().height),
                work: (
                    work.position.x,
                    work.position.y,
                    work.size.width,
                    work.size.height,
                ),
                scale: monitor.scale_factor(),
            }
        })
        .collect();
    let place = place_saved_window(saved, &screens);
    log::info!("[window] built at its saved place: {place:?}");
    place
}

fn window_page<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &tauri::Url) -> WindowPage {
    if on_setup_page(app, url) {
        WindowPage::Setup
    } else if url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        && is_owned_app_origin(app, url)
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
system's title bar. Every release that runs its server in a container (v0.3.0 on) has it, and this
app runs no other, so the deployment's Compose file answers: the app's source is in the server
image, not on disk.
*/
fn app_makes_room_for_window_buttons(root: &Path) -> bool {
    root.join("docker-compose.yml").is_file() && !deployment::predates_containers(root)
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
            let _ = window.set_theme(setup_theme(window.app_handle()));
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
        let ground = match setup_theme(window.app_handle()).or_else(|| window.theme().ok()) {
            Some(tauri::Theme::Dark) => SETUP_BACKGROUND_DARK,
            _ => SETUP_BACKGROUND,
        };
        let _ = window.set_background_color((page == WindowPage::Setup).then_some(ground));
        show_window_title(window, page != WindowPage::OwnedApp);
    }
    // OpenBot's own page tints the bar to its own light or dark through `appearance`.
    #[cfg(target_os = "windows")]
    match page {
        WindowPage::Setup => {
            let dark = setup_theme(window.app_handle()).or_else(|| window.theme().ok())
                == Some(tauri::Theme::Dark);
            tint_title_bar(window, Some(dark));
        }
        WindowPage::OwnedApp => {}
        WindowPage::LocalApp | WindowPage::Other => tint_title_bar(window, None),
    }
}

/// OpenBot's own page reporting its light or dark (`APP_THEME_PAGE`). On Windows the title bar
/// takes the page's ground, when the page is one whose ground that is: an OpenBot from before the
/// reskin keeps Windows's own bar, in the page's light or dark.
pub(crate) fn page_appearance<R: tauri::Runtime>(window: &tauri::Window<R>, dark: bool) {
    remember_appearance(window.app_handle(), dark);
    #[cfg(target_os = "windows")]
    {
        let app = window.app_handle();
        let owned = app
            .get_webview_window(window.label())
            .and_then(|own| own.url().ok())
            .is_some_and(|url| window_page(app, &url) == WindowPage::OwnedApp);
        if owned {
            tint_title_bar(window, Some(dark));
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (window, dark);
}

/**
Windows 11's title bar in the ground of the page under it, or Windows's own colours for `None`.

`Some(dark)` is the setup screens' ground, which OpenBot's own pages share (`--background` in the
app's styles): the bar, its text and the window's border become one surface with the page instead
of a white band across its top. Windows 10 has no such attributes and keeps its bar; the calls fail
there and are ignored.
*/
#[cfg(target_os = "windows")]
fn tint_title_bar<R: tauri::Runtime>(window: &tauri::Window<R>, dark: Option<bool>) {
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            window: *mut std::ffi::c_void,
            attribute: u32,
            value: *const std::ffi::c_void,
            size: u32,
        ) -> i32;
    }
    const BORDER_COLOR: u32 = 34;
    const CAPTION_COLOR: u32 = 35;
    const TEXT_COLOR: u32 = 36;
    /// `DWMWA_COLOR_DEFAULT`: give the attribute back to Windows.
    const DEFAULT: u32 = 0xFFFF_FFFF;
    // COLORREF is 0x00BBGGRR.
    let colorref = |tauri::window::Color(r, g, b, _): tauri::window::Color| {
        u32::from(r) | u32::from(g) << 8 | u32::from(b) << 16
    };
    let (caption, text) = match dark {
        Some(true) => (colorref(SETUP_BACKGROUND_DARK), 0x00F9_F7F7),
        Some(false) => (colorref(SETUP_BACKGROUND), colorref(SETUP_BACKGROUND_DARK)),
        None => (DEFAULT, DEFAULT),
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = hwnd.0;
    for (attribute, value) in [
        (CAPTION_COLOR, caption),
        (BORDER_COLOR, caption),
        (TEXT_COLOR, text),
    ] {
        // SAFETY: `hwnd` is this window's live handle, and `value` is a u32 that outlives the call,
        // which is the size and type these three attributes take.
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                attribute,
                (&value as *const u32).cast(),
                std::mem::size_of::<u32>() as u32,
            );
        }
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
buttons, and the header becomes the drag handle, as does the strip the main column keeps above
itself while the sidebar is hidden, and onboarding's header, which has no sidebar beside it. The
sidebar renders after the page loads and again on navigation, so new headers are marked as they
appear, at most once a frame. Run on macOS only: Windows has its own title bar to drag.
*/
const OVERLAY_TITLE_BAR_PAGE: &str = r#"(() => {
  document.documentElement.dataset.desktopTitlebar = "overlay";
  const DRAG = "data-tauri-drag-region";
  const mark = () => {
    // Bare attributes: only a press on the element itself drags, never on its contents.
    for (const header of document.querySelectorAll(`[data-slot="sidebar-header"]:not([${DRAG}])`)) {
      header.setAttribute(DRAG, "");
    }
    // Onboarding has no sidebar. Its header starts below the window's buttons, and that strip is
    // the header's own, so it drags while Back and the steps inside it stay buttons.
    for (const header of document.querySelectorAll(`[data-onboarding-frame] > header:not([${DRAG}])`)) {
      header.setAttribute(DRAG, "");
    }
    // The main column only while the sidebar is hidden, when its top strip is the one handle left.
    // With the sidebar showing, a press in its empty margins must not move the window.
    for (const main of document.querySelectorAll('[data-slot="sidebar-wrapper"] > main')) {
      const hidden = main.parentElement.querySelector(
        ':scope > [data-slot="sidebar"][data-state="collapsed"]',
      );
      if (hidden) main.setAttribute(DRAG, "");
      else main.removeAttribute(DRAG);
    }
  };
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; mark(); });
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state"],
  });
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

/**
Record `address` as the OpenBot app this shell verified it owns, and let it use the Intelligence row.

Called with an address `owned_app_url` verified, before the window navigates there. Its origin is
then the only loopback origin the window treats as OpenBot (`window_page`) and gives the window's
controls to (`allow_app_page`).

They are granted here, before the page exists, and not only once it has loaded: the notification
plugin's script asks `is_permission_granted` as the page starts, and a page whose origin was not yet
granted was refused, kept "default" as its answer for as long as it stayed open, and never showed a
notification. MEASURED on a Mac: no Bot's notice reached the system (usernoted never heard from the
app) while the offer to turn them on, asked later, was rightly hidden.
*/
fn trust_owned_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>, address: &str) {
    if let Some(origin) = intelligence_bridge::app_origin(address) {
        let shell = app.state::<Shell>();
        let mut trusted = shell.owned_app_origins.lock().unwrap();
        if !trusted.contains(&origin) {
            trusted.push(origin);
        }
    }
    let known = app
        .state::<Shell>()
        .app_page_grants_known
        .load(std::sync::atomic::Ordering::SeqCst);
    if let (true, Ok(url)) = (known, address.parse::<tauri::Url>()) {
        allow_app_page(app, &url);
    }
    intelligence_bridge::allow(app, address);
}

/// Lets `trust_owned_app` grant OpenBot's page its permissions before the page loads. Only for an
/// app built by `generate_context!`, which compiles them in.
fn know_app_page_grants<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    app.state::<Shell>()
        .app_page_grants_known
        .store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Whether `url` is on the origin of the OpenBot app this shell verified it owns.
fn is_owned_app_origin<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &tauri::Url) -> bool {
    let origin = url.origin().ascii_serialization();
    app.state::<Shell>()
        .owned_app_origins
        .lock()
        .unwrap()
        .contains(&origin)
}

/**
The page's Notification API, which the notification plugin's script stands in for in this window:
whether notifications are on, turning them on, and showing one. Nothing else of the plugin's.

MEASURED: the window's own Notification API cannot be granted. In a WKWebView set up as wry sets it
up, `Notification.requestPermission()` answers "denied" at once with no prompt, and the next launch
reads "default" again, so the page's offer to turn them on came back after every yes. The plugin
shows them through the system instead, and answers that they are allowed: a desktop app needs no
permission of its own to post one (tauri-plugin-notification, `desktop.rs`).
*/
const APP_PAGE_NOTIFICATIONS: [&str; 3] = [
    "notification:allow-is-permission-granted",
    "notification:allow-request-permission",
    "notification:allow-notify",
];

/**
Lets OpenBot's own page move and zoom the window from its drag handle, set the window's appearance
to its own theme, use Settings → This computer (`desktop_page`), and show a Bot's notifications
(`APP_PAGE_NOTIFICATIONS`), and nothing more.

Only the origin this shell verified as its own OpenBot (`trust_owned_app`). A page on any other
loopback port, which a link in a reply can open in this window, gets none of it: Settings → This
computer can stop OpenBot and the local Intelligence.
*/
fn allow_app_page<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &tauri::Url) {
    if !is_owned_app_origin(app, url) {
        return;
    }
    let origin = url.origin().ascii_serialization();
    let shell = app.state::<Shell>();
    let mut granted = shell.app_page_grants.lock().unwrap();
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
    for permission in desktop_page::PERMISSIONS
        .iter()
        .chain(&APP_PAGE_NOTIFICATIONS)
    {
        capability = capability.permission(*permission);
    }
    match app.add_capability(capability) {
        Ok(()) => granted.push(origin),
        Err(error) => log::warn!("[window] could not let the app page drag the window: {error}"),
    }
}

#[cfg(test)]
mod app_page_tests {
    use super::*;

    /// A stand-in for `desktop_page` under its own name, so the Tauri ACL that guards the real
    /// commands guards these: a command answers only when the page's origin was granted it.
    fn app() -> (
        tauri::App<tauri::test::MockRuntime>,
        tauri::WebviewWindow<tauri::test::MockRuntime>,
    ) {
        let stand_in =
            tauri::plugin::Builder::<tauri::test::MockRuntime>::new(desktop_page::PLUGIN)
                .invoke_handler(|invoke| {
                    invoke.resolver.resolve(());
                    true
                })
                .build();
        let app = tauri::test::mock_builder()
            .plugin(stand_in)
            .plugin(tauri_plugin_notification::init())
            .plugin(intelligence_bridge::plugin())
            .manage(Shell::default())
            .build(tauri::generate_context!(test = true))
            .unwrap();
        // As the app's setup does: this context compiles the page's permissions in.
        know_app_page_grants(app.handle());
        let window = app.get_webview_window("main").unwrap_or_else(|| {
            tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap()
        });
        (app, window)
    }

    fn ask(
        window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        from: &str,
        cmd: &str,
    ) -> Result<serde_json::Value, serde_json::Value> {
        tauri::test::get_ipc_response(
            window,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: from.parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize().unwrap())
    }

    const STOP: &str = "plugin:openbot-desktop|stop";

    /// Settings → This computer can stop OpenBot and the local Intelligence. A page on another
    /// loopback port that this window loads, from a link in a reply for instance, used to get the
    /// same controls as OpenBot's own page.
    #[test]
    fn only_the_owned_app_origin_can_stop_openbot_from_its_page() {
        let (app, window) = app();
        let foreign: tauri::Url = "http://127.0.0.1:3011/".parse().unwrap();
        let owned: tauri::Url = "http://127.0.0.1:3010/settings/this-computer"
            .parse()
            .unwrap();

        // Loaded before any OpenBot was verified: not OpenBot, and granted nothing.
        assert_eq!(window_page(app.handle(), &foreign), WindowPage::Other);
        allow_app_page(app.handle(), &foreign);
        assert!(ask(&window, foreign.as_str(), STOP).is_err());

        trust_owned_app(app.handle(), "http://127.0.0.1:3010");
        assert!(matches!(
            window_page(app.handle(), &owned),
            WindowPage::OwnedApp | WindowPage::LocalApp
        ));
        allow_app_page(app.handle(), &owned);
        assert_eq!(
            ask(&window, owned.as_str(), STOP),
            Ok(serde_json::Value::Null)
        );

        // Another port on the same address, and another name for it, stay someone else's.
        for other in [
            "http://127.0.0.1:3011/",
            "http://localhost:3010/",
            "http://[::1]:3010/",
        ] {
            let other: tauri::Url = other.parse().unwrap();
            assert_eq!(
                window_page(app.handle(), &other),
                WindowPage::Other,
                "{other}"
            );
            allow_app_page(app.handle(), &other);
            assert!(ask(&window, other.as_str(), STOP).is_err(), "{other}");
        }
    }

    /// On Windows the tray said "Quit  Ctrl+Q" and Ctrl+Q in the window did nothing: a tray menu's
    /// shortcut is only a label there, and the window has no menu bar. The window's pages now ask
    /// to quit themselves (`quit-shortcut.js`), so the setup screens and OpenBot's own page must be
    /// able to, and a page on another loopback port must not.
    #[test]
    fn ctrl_q_on_windows_can_quit_from_setup_and_openbot_but_not_another_page() {
        const QUIT: &str = "plugin:openbot-desktop|quit";
        let (app, window) = app();
        // The setup screens, served by the app itself, at the address each platform gives them.
        let setup = if cfg!(windows) {
            "http://tauri.localhost/"
        } else {
            "tauri://localhost/"
        };
        assert_eq!(ask(&window, setup, QUIT), Ok(serde_json::Value::Null));
        let foreign = "http://127.0.0.1:3011/";
        allow_app_page(app.handle(), &foreign.parse().unwrap());
        assert!(ask(&window, foreign, QUIT).is_err());
        trust_owned_app(app.handle(), "http://127.0.0.1:3010");
        let owned = "http://127.0.0.1:3010/";
        allow_app_page(app.handle(), &owned.parse().unwrap());
        assert_eq!(ask(&window, owned, QUIT), Ok(serde_json::Value::Null));

        // Read as text, as the outside-links test does: the real webview cannot be built here.
        let main = include_str!("main.rs");
        assert!(main.contains(
            "if cfg!(target_os = \"windows\") && page != WindowPage::Other {\n                let _ = window.eval(desktop_page::QUIT_SHORTCUT_PAGE);"
        ));
        assert!(desktop_page::QUIT_SHORTCUT_PAGE.contains("\"plugin:openbot-desktop|quit\""));
    }

    /// "The text is too small and you can't zoom in." The window now zooms as a browser does: the
    /// View menu on macOS and Linux, and the page's own shortcut (`zoom-shortcut.js`) for what no
    /// menu carries, every key on Windows and Command and + on macOS, which the setup screens and
    /// OpenBot's own page may ask and a page on another loopback port may not. Every window's page
    /// starts at the level kept from the last launch.
    #[test]
    fn the_window_zooms_from_the_view_menu_or_the_page_and_starts_at_the_kept_level() {
        const ZOOM: &str = "plugin:openbot-desktop|zoom";
        let (app, window) = app();
        let setup = if cfg!(windows) {
            "http://tauri.localhost/"
        } else {
            "tauri://localhost/"
        };
        assert_eq!(ask(&window, setup, ZOOM), Ok(serde_json::Value::Null));
        let foreign = "http://127.0.0.1:3011/";
        allow_app_page(app.handle(), &foreign.parse().unwrap());
        assert!(ask(&window, foreign, ZOOM).is_err());
        trust_owned_app(app.handle(), "http://127.0.0.1:3010");
        let owned = "http://127.0.0.1:3010/";
        allow_app_page(app.handle(), &owned.parse().unwrap());
        assert_eq!(ask(&window, owned, ZOOM), Ok(serde_json::Value::Null));
        assert!(zoom::SHORTCUT_PAGE.contains("\"plugin:openbot-desktop|zoom\""));

        // Read as text: the real webview and AppKit's menus cannot be built here. Each anchor and
        // each line looked for is put together here, so this test's own text never matches it.
        let main = include_str!("main.rs");
        let at = |pieces: &[&str]| main.find(&pieces.concat()).unwrap();
        let menus = &main[at(&["\nfn install", "_menus"])..];
        let menus = &menus[..menus.find("app.set_menu(").unwrap()];
        let view = &menus[menus.find("\"View\",").expect("a View menu")..];
        for (id, label, keys) in [
            (
                "zoom::MENU_ACTUAL_SIZE",
                "\"Actual Size\"",
                "\"CmdOrCtrl+0\"",
            ),
            ("zoom::MENU_IN", "\"Zoom In\"", "\"CmdOrCtrl+=\""),
            ("zoom::MENU_OUT", "\"Zoom Out\"", "\"CmdOrCtrl+-\""),
        ] {
            let item = &view[view.find(id).unwrap_or_else(|| panic!("{id}"))..];
            let item = &item[..item.find(")?").unwrap()];
            assert!(item.contains(label) && item.contains(keys), "{item}");
        }
        assert!(main.contains(
            &[
                "\n    app.set_menu(",
                "Menu::with_items(app, &[&openbot, &edit, &view])?)?;"
            ]
            .concat()
        ));
        assert!(main.contains(
            "if let Some(step) = zoom::Step::of_menu(other) {\n                zoom_windows(app, step);"
        ));
        assert!(main.contains(
            "if cfg!(any(target_os = \"windows\", target_os = \"macos\")) && page != WindowPage::Other {\n                let _ = window.eval(zoom::shortcut_page());"
        ));
        assert_eq!(
            zoom::shortcut_page().starts_with("window.__openbotZoomMenu = true;"),
            cfg!(target_os = "macos")
        );
        let page_load = &main[at(&[".on_page_load(", "|window, payload| {"])..];
        let page_load = &page_load[..page_load.find("\n        })").unwrap()];
        assert!(page_load.contains("let _ = window.set_zoom(saved_zoom(window.app_handle()));"));
        let build = &main[at(&["\nfn build_main", "_window"])..];
        let build = &build[..build.find("\n}\n").unwrap()];
        assert!(build.contains("let _ = window.set_zoom(saved_zoom(app));"));
    }

    /// Every command OpenBot's page may ask, the update banner's among them (installing an update
    /// stops OpenBot and restarts the app), answers only the OpenBot this shell owns.
    #[test]
    fn every_page_command_answers_only_the_owned_app_origin() {
        let (app, window) = app();
        let commands: Vec<String> = desktop_page::PERMISSIONS
            .iter()
            .map(|permission| {
                let name = permission
                    .strip_prefix("openbot-desktop:allow-")
                    .unwrap()
                    .replace('-', "_");
                format!("plugin:openbot-desktop|{name}")
            })
            .collect();
        for update in [
            "update_offer",
            "check_update",
            "dismiss_update",
            "install_update",
            // Open log folder opens the shell's own folder, but only for its own OpenBot.
            "open_logs",
        ] {
            assert!(commands.contains(&format!("plugin:openbot-desktop|{update}")));
        }
        let foreign = "http://127.0.0.1:3011/";
        allow_app_page(app.handle(), &foreign.parse().unwrap());
        trust_owned_app(app.handle(), "http://127.0.0.1:3010");
        let owned = "http://127.0.0.1:3010/";
        allow_app_page(app.handle(), &owned.parse().unwrap());
        for command in &commands {
            assert!(ask(&window, foreign, command).is_err(), "{command}");
            assert_eq!(
                ask(&window, owned, command),
                Ok(serde_json::Value::Null),
                "{command}"
            );
        }
    }

    /// Open log folder (the Status window's and Settings → This computer's) opens the folder the log
    /// plugin writes to (`TargetKind::LogDir`): where each platform keeps an application's logs,
    /// under this app's identifier. Pinned per platform, since that is what support asks for.
    #[test]
    fn the_log_folder_is_the_platforms_own_log_folder_for_this_app() {
        let (app, _) = app();
        let folder = logging::folder(app.handle()).unwrap();
        assert_eq!(folder, app.path().app_log_dir().unwrap());
        let identifier = app.config().identifier.clone();
        assert_eq!(identifier, "ai.copilotkit.openbot.desktop");
        let home = PathBuf::from(
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap(),
        );
        if cfg!(target_os = "macos") {
            assert_eq!(folder, home.join("Library").join("Logs").join(&identifier));
        } else if cfg!(windows) {
            let local = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap());
            assert_eq!(folder, local.join(&identifier).join("logs"));
        } else {
            let data = std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .filter(|data| data.is_absolute())
                .unwrap_or_else(|| home.join(".local").join("share"));
            assert_eq!(folder, data.join(&identifier).join("logs"));
        }
    }

    /// OpenBot's own page turns notifications on and shows them through the notification plugin,
    /// whose script stands in for the page's Notification API. It answers that they are on, as the
    /// plugin does on every desktop, so the page's offer to turn them on does not come back. A page
    /// on another port gets none of it: it could post notices in OpenBot's name.
    #[test]
    fn only_the_owned_app_origin_can_turn_on_and_show_notifications() {
        let (app, window) = app();
        let foreign: tauri::Url = "http://127.0.0.1:3011/".parse().unwrap();
        let owned: tauri::Url = "http://127.0.0.1:3010/channel/c-1".parse().unwrap();
        allow_app_page(app.handle(), &foreign);
        trust_owned_app(app.handle(), "http://127.0.0.1:3010");
        allow_app_page(app.handle(), &owned);
        for command in ["is_permission_granted", "request_permission", "notify"] {
            let command = format!("plugin:notification|{command}");
            let refused = ask(&window, foreign.as_str(), &command).unwrap_err();
            assert!(
                refused.to_string().contains("not allowed"),
                "{command} from another page: {refused}"
            );
        }
        assert_eq!(
            ask(
                &window,
                owned.as_str(),
                "plugin:notification|is_permission_granted"
            ),
            Ok(serde_json::json!(true))
        );
        assert_eq!(
            ask(
                &window,
                owned.as_str(),
                "plugin:notification|request_permission"
            ),
            Ok(serde_json::json!("granted"))
        );
        // Showing one is the page's to ask. Asked with no notice, so the command is reached (it
        // refuses the arguments, not the page) and a test run posts nothing to the system.
        let reached = ask(&window, owned.as_str(), "plugin:notification|notify").unwrap_err();
        assert!(
            !reached.to_string().contains("not allowed") && reached.to_string().contains("options"),
            "{reached}"
        );
    }

    /// The notification plugin's script asks whether notifications are on as OpenBot's page
    /// starts, before it has loaded. Its origin is granted when the shell trusts it, ahead of the
    /// window going there, so that first question is answered. It used to be granted only once the
    /// page had loaded: the question was refused, and the page never showed a notification.
    #[test]
    fn the_owned_app_page_is_answered_from_its_first_moment() {
        let (app, window) = app();
        let starting = "http://127.0.0.1:3010/";
        trust_owned_app(app.handle(), "http://127.0.0.1:3010");
        // No page load has finished: nothing but the trust has happened.
        assert_eq!(
            ask(
                &window,
                starting,
                "plugin:notification|is_permission_granted"
            ),
            Ok(serde_json::json!(true))
        );
        assert!(ask(
            &window,
            "http://127.0.0.1:3011/",
            "plugin:notification|is_permission_granted"
        )
        .is_err());
    }

    /// A click on a Bot's notification opens the page it names, on the OpenBot the window shows,
    /// and nowhere else: not another site, not another port, and not while the window shows setup.
    #[test]
    fn a_click_on_a_notification_opens_only_a_page_of_the_shown_openbot() {
        let current: tauri::Url = "http://127.0.0.1:3010/channel/c-1".parse().unwrap();
        let open = |owned, path| {
            notification_destination(&current, owned, path).map(|url| url.to_string())
        };
        assert_eq!(
            open(true, Some("/bots/expenses")).as_deref(),
            Some("http://127.0.0.1:3010/bots/expenses")
        );
        assert_eq!(
            open(true, Some("/bots")).as_deref(),
            Some("http://127.0.0.1:3010/bots")
        );
        for path in [
            "//example.com/bots",
            "https://example.com/",
            "http://127.0.0.1:3011/bots",
            "bots",
            "/\\example.com",
            "javascript:alert(1)",
        ] {
            assert_eq!(open(true, Some(path)), None, "{path}");
        }
        assert_eq!(open(true, None), None);
        assert_eq!(open(false, Some("/bots")), None);
    }

    /// A toast from an app Windows did not install from a package is shown under the app whose
    /// AppUserModelID it names, and only when a Start menu shortcut carries that ID. The
    /// notification plugin names the bundle identifier in an installed app (`desktop.rs`,
    /// `notification.app_id(&self.identifier)`), and Tauri's own NSIS template stamps the same
    /// `${BUNDLEID}` on the Start menu shortcut it names after the product (`installer.nsi`,
    /// `SetLnkAppUserModelId`). So a toast reads "OpenBot" as long as the installer is that template
    /// and the identifier and product name stay what they are.
    #[test]
    fn windows_toasts_name_the_app_the_start_menu_shortcut_carries() {
        let (app, _) = app();
        let config = app.config();
        assert_eq!(config.identifier, "ai.copilotkit.openbot.desktop");
        assert_eq!(config.product_name.as_deref(), Some("OpenBot"));
        // Read from the files the installer is built from, the base and every overlay a build
        // passes with --config: the app's runtime config leaves the bundle settings out.
        let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut checked = 0;
        for entry in std::fs::read_dir(folder).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if !(name.starts_with("tauri.") && name.ends_with(".json")) {
                continue;
            }
            let file: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let nsis = &file["bundle"]["windows"]["nsis"];
            assert!(
                nsis.get("template").is_none(),
                "{name}: a custom NSIS template has to stamp the Start menu shortcut's \
                 AppUserModelID itself"
            );
            if let Some(identifier) = file.get("identifier") {
                assert_eq!(identifier, "ai.copilotkit.openbot.desktop", "{name}");
            }
            if let Some(product) = file.get("productName") {
                assert_eq!(product, "OpenBot", "{name}");
            }
            checked += 1;
        }
        assert!(checked >= 2, "found {checked} Tauri config files");
        // The installer registers the scheme a toast's link opens by: a click in the notification
        // centre can only bring an unpackaged app back by protocol (`notice.rs`).
        let base: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(folder.join("tauri.conf.json")).unwrap())
                .unwrap();
        assert_eq!(
            base["plugins"]["deep-link"]["desktop"]["schemes"],
            serde_json::json!([notice::SCHEME])
        );
        let hooks = std::fs::read_to_string(folder.join("windows/hooks.nsh")).unwrap();
        assert!(
            !hooks.contains("CreateShortcut"),
            "a shortcut the hooks make carries no AppUserModelID"
        );
    }

    /// Narration listens through the shell's speech recognition from OpenBot's own page, and from
    /// no other: a page that could start it could listen to the person.
    #[test]
    fn only_the_owned_app_origin_can_listen_through_the_shell() {
        let (app, window) = app();
        let foreign: tauri::Url = "http://127.0.0.1:3011/".parse().unwrap();
        let owned: tauri::Url = "http://127.0.0.1:3010/browser".parse().unwrap();
        allow_app_page(app.handle(), &foreign);
        trust_owned_app(app.handle(), "http://127.0.0.1:3010");
        allow_app_page(app.handle(), &owned);
        for command in [
            "speech_available",
            "speech_start",
            "speech_stop",
            "speech_abort",
        ] {
            let command = format!("plugin:openbot-desktop|{command}");
            assert!(
                ask(&window, foreign.as_str(), &command).is_err(),
                "{command} from another page"
            );
            assert_eq!(
                ask(&window, owned.as_str(), &command),
                Ok(serde_json::Value::Null),
                "{command} from OpenBot"
            );
        }
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
    match built {
        // At the level the main window has (`zoom`).
        Ok(window) => {
            let _ = window.set_zoom(saved_zoom(app));
        }
        Err(error) => log::warn!("[status] could not open the Status window: {error}"),
    }
}

/// Where OpenBot's Settings → This computer lives, in releases that have it.
///
/// Not `/settings/computer`: the personal edition's Computers page (the Bots' computers) has that
/// address, and its guard sends every other edition to General.
const COMPUTER_SETTINGS_PATH: &str = "/settings/this-computer";

/**
Status in OpenBot itself, Settings → This computer, when the OpenBot running here has that page:
the main window goes there. True when it did. Otherwise, with OpenBot stopped or from a release
without the page, the Status window does the job.
*/
fn show_status_in_app(app: &tauri::AppHandle) -> bool {
    let root = cleanup_root(&app.state::<Shell>(), &stack::default_root());
    if !root
        .join("app/src/routes/_authed/settings/this-computer.tsx")
        .is_file()
    {
        return false;
    }
    let Some(mut url) = ports_for_shell(app)
        .ok()
        .and_then(|ports| owned_app_url(&app.state::<Shell>(), &root, &ports))
        .and_then(|url| url.parse::<tauri::Url>().ok())
    else {
        return false;
    };
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    url.set_path(COMPUTER_SETTINGS_PATH);
    trust_owned_app(app, url.as_str());
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
    /// OpenBot answers on its own address, whoever started it.
    openbot_running: bool,
    /// This session of the desktop app started the OpenBot that is running, so it can restart it.
    /// False for an OpenBot left running by an earlier session that ended without its Quit.
    openbot_held: bool,
    /// Always empty now: OpenBot's server and worker are containers and are listed with them.
    /// Kept so a Status window from before that still reads the shape it expects.
    processes: Vec<desktop_status::Part>,
    containers: Vec<desktop_status::Part>,
    /// The local Intelligence stack recorded for this installation, if any.
    intelligence_stack: Option<String>,
    intelligence_containers: Vec<desktop_status::Part>,
    /// "docker" or "podman", answering now; None when nothing answers.
    engine: Option<&'static str>,
    root: String,
    app_port: Option<u16>,
    /// The version this build was packaged as; see `desktop_version`.
    version: String,
    build: String,
    /// The folder this app's log file is in (`logging`), for Open log folder. Absent from a desktop
    /// app older than the log, so a page can tell the button would have nothing to open.
    log_folder: Option<String>,
}

#[tauri::command]
async fn desktop_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    memory: Option<bool>,
) -> Result<DesktopStatus, String> {
    let memory = memory.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || read_desktop_status(&app, memory))
        .await
        .map_err(|error| format!("the status could not be read: {error}"))
}

/**
`memory` false lists the containers without measuring them, in milliseconds: `docker stats` waits
about two seconds to sample, which left the page blank that long. The page asks without it first, so
its rows appear at once, and with it after, filling the figures in.
*/
fn read_desktop_status<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    memory: bool,
) -> DesktopStatus {
    let shell = app.state::<Shell>();
    let root = cleanup_root(&shell, &stack::default_root());
    let held = shell.root.lock().unwrap().is_some() && shell.containers.lock().unwrap().is_some();
    let stack_id =
        local_eval_state::read(&root, None).map(|state| state.stack_id().as_str().to_owned());
    let found = engine::detect();
    let running = found.engine.filter(|_| found.responding);
    let (containers, intelligence_containers) = match running {
        Some(running) => {
            let mut stats = quiet::command(
                engine::program(running).unwrap_or_else(|| PathBuf::from(running.binary())),
            );
            if memory {
                stats.args([
                    "stats",
                    "--no-stream",
                    "--format",
                    "{{.Name}}\t{{.MemUsage}}",
                ]);
            } else {
                // The same two columns, the second empty, so one parser reads both.
                stats.args(["ps", "--format", "{{.Names}}\t"]);
            }
            if let Some(path) = engine::path_with_docker() {
                stats.env("PATH", path);
            }
            let stats = stats
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
                .unwrap_or_default();
            // This installation's own, by their Compose project label, never by a name prefix
            // another project can share. See `stack::running_containers_of`.
            let owned = found
                .address
                .as_ref()
                .map(|address| stack::running_containers_of(address, &root))
                .unwrap_or_default();
            desktop_status::containers(&stats, &owned, stack_id.as_deref())
        }
        None => (Vec::new(), Vec::new()),
    };
    let ports = ports_for_shell(app).ok();
    // Whether this installation's OpenBot answers, shown in the window or not: one behind this app
    // that waits for Start to upgrade it is still running.
    let answering = ports.as_ref().is_some_and(|ports| {
        app_url_published_by(held_engine(&shell, &root).as_ref(), &root, ports).is_some()
    });
    DesktopStatus {
        openbot_running: held || answering,
        openbot_held: held,
        processes: Vec::new(),
        containers,
        intelligence_stack: stack_id,
        intelligence_containers,
        engine: running.map(|engine| engine.binary()),
        root: root.display().to_string(),
        app_port: ports.map(|ports| ports.app),
        version: desktop_version(app),
        build: build_description(
            env!("OPENBOT_BUILD_COMMIT"),
            env!("OPENBOT_BUILD_BRANCH"),
            env!("OPENBOT_BUILD_TIME").parse().unwrap_or_default(),
        ),
        log_folder: logging::folder(app)
            .ok()
            .map(|folder| folder.display().to_string()),
    }
}

/// Open log folder, in the Status window and in Settings → This computer: the folder the log file
/// is in, in the system's file manager, so a person can send us the file.
#[tauri::command]
async fn open_log_folder<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    open_log_folder_now(&app)
}

fn open_log_folder_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let folder = logging::folder(app).map_err(|error| error.to_string())?;
    log::info!("[logs] opening the log folder");
    logging::open_folder(&folder, |folder| {
        tauri_plugin_opener::open_path(folder, None::<&str>).map_err(|error| error.to_string())
    })
    .inspect_err(|error| log::warn!("[logs] could not open the log folder: {error}"))
}

/**
Get troubleshooting logs: the version, the system, what failed, what the container engine says about
itself, and the end of this app's log and the CLI's, redacted, as one block of text. `failure` is
what the window that asked was showing, when it was showing one. See `troubleshooting`.
*/
#[tauri::command]
async fn troubleshooting_logs<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    failure: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || gather_troubleshooting_logs(&app, failure))
        .await
        .map_err(|error| format!("the logs could not be gathered: {error}"))
}

/// The same logs, saved as a file in the log folder and shown in Finder or Explorer.
#[tauri::command]
async fn save_troubleshooting_logs<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    failure: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_troubleshooting_logs_now(&app, failure))
        .await
        .map_err(|error| format!("the logs could not be saved: {error}"))?
}

fn save_troubleshooting_logs_now<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    failure: Option<String>,
) -> Result<(), String> {
    use time::macros::format_description;
    let text = gather_troubleshooting_logs(app, failure);
    let folder = logging::folder(app).map_err(|error| error.to_string())?;
    let stamp = time::OffsetDateTime::now_utc()
        .format(format_description!(
            "[year]-[month]-[day]T[hour]-[minute]-[second]Z"
        ))
        .unwrap_or_default();
    let saved = troubleshooting::save(&folder, &text, &stamp)
        .map_err(|error| format!("could not save the logs: {error}"))
        .inspect_err(|error| log::warn!("[logs] {error}"))?;
    // The stamp, not the file name: the log's own scrubbing takes a name that long and mixed for a
    // key.
    log::info!("[logs] saved troubleshooting logs in the log folder, stamped {stamp}");
    tauri_plugin_opener::reveal_item_in_dir(&saved)
        .map_err(|error| error.to_string())
        .inspect_err(|error| log::warn!("[logs] could not show the saved logs: {error}"))
}

fn gather_troubleshooting_logs<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    failure: Option<String>,
) -> String {
    let home = logging::home_folder();
    let folder = logging::folder(app).ok();
    // The engine the back end runs on; before setup has chosen one, whichever is answering.
    let engine = local_eval::engine_in_use().or_else(|| {
        let found = engine::detect();
        found.address.filter(|_| found.responding)
    });
    let text = troubleshooting::gather(troubleshooting::Sources {
        desktop: format!(
            "OpenBot Desktop {} ({})",
            desktop_version(app),
            build_description(
                env!("OPENBOT_BUILD_COMMIT"),
                env!("OPENBOT_BUILD_BRANCH"),
                env!("OPENBOT_BUILD_TIME").parse().unwrap_or_default(),
            )
        ),
        failure,
        log_folder: folder.as_deref(),
        home: home.as_deref(),
        engine,
    });
    log::info!("[logs] gathered troubleshooting logs");
    text
}

/**
Restart OpenBot itself: the server and the worker containers, through Compose. The other
containers, its database among them, keep running, so nothing is lost and the restart takes seconds.
Only an OpenBot this session started, whose engine it knows.
*/
#[tauri::command]
async fn restart_openbot<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    restart_openbot_from(app, AskedFrom::StatusWindow).await
}

async fn restart_openbot_from<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    from: AskedFrom,
) -> Result<(), String> {
    let asked = std::time::Instant::now();
    log::info!("[restart] asked {}", from.said());
    // Compose takes seconds to restart a container. Off Tauri's threads, as Stop is.
    let restarted = tauri::async_runtime::spawn_blocking(move || restart_openbot_now(&app))
        .await
        .map_err(|error| format!("the restart did not run: {error}"))
        .and_then(|restarted| restarted);
    logging::outcome("restart", asked, &restarted);
    restarted
}

fn restart_openbot_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let shell = app.state::<Shell>();
    let root = shell.root.lock().unwrap().clone();
    let address = shell
        .containers
        .lock()
        .unwrap()
        .as_ref()
        .filter(|owned| Some(&owned.root) == root.as_ref())
        .map(|owned| owned.address.clone());
    let (Some(root), Some(address)) = (root, address) else {
        return Err("OpenBot is not running.".into());
    };
    stack::restart_openbot(&address, &root)
        .map_err(|error| format!("OpenBot could not restart: {error}"))
}

/// Stop, as the menu used to offer it: everything, Intelligence included if OpenBot started it.
#[tauri::command]
fn stop_openbot_from_status(app: tauri::AppHandle) {
    stop_from_menu(app, AskedFrom::StatusWindow);
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

/// Off the event-loop thread: installation holds startup for the whole download, and waiting for it
/// there froze the window until the download finished.
#[tauri::command]
async fn already_running<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || already_running_now(&app, &root))
        .await
        .unwrap_or(false)
}

fn already_running_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>, root: &str) -> bool {
    let root = stack::root_from(root);
    let shell = app.state::<Shell>();
    let _startup = shell.startup.lock().unwrap();
    !recovery_required_or_pending_quit_notice(&shell, &root)
        && openbot_env::Ports::read(&root)
            .is_ok_and(|ports| already_running_at(&shell, &root, &ports))
}

fn already_running_at(shell: &Shell, root: &Path, ports: &openbot_env::Ports) -> bool {
    owned_app_url(shell, root, ports).is_some()
}

/// Neither an owned API nor an answering app port alone authorizes showing a deployment: this
/// root's own `server` container has to be the one publishing both.
///
/// Nor does a deployment an earlier app left running (an installer that closed the app without its
/// Quit, a crash, a force quit) that is behind this app's release: Start upgrades it first
/// (`upgrade::due`), and showing it as it is kept the person on the old release for good. One this
/// session holds is shown whatever its release, because Start decided it: a failed upgrade starts
/// the previous version again on purpose.
fn owned_app_url(shell: &Shell, root: &Path, ports: &openbot_env::Ports) -> Option<String> {
    owned_app(shell, root, ports).map(|(url, _)| url)
}

/// [`owned_app_url`], with the engine whose `server` container publishes it.
fn owned_app(
    shell: &Shell,
    root: &Path,
    ports: &openbot_env::Ports,
) -> Option<(String, engine::Address)> {
    let held = held_engine(shell, root);
    if held.is_none() && upgrade::due(root, &upgrade::own()).is_some() {
        return None;
    }
    app_published_by(held.as_ref(), root, ports)
}

/// The engine this session holds `root`'s containers on, when it holds them.
fn held_engine(shell: &Shell, root: &Path) -> Option<engine::Address> {
    shell
        .containers
        .lock()
        .unwrap()
        .as_ref()
        .filter(|owned| owned.root == root)
        .map(|owned| owned.address.clone())
}

/// A deployment the window shows as its own is this session's from then on, as one Start raised
/// is: the menus say it is running, and Stop, Restart and Quit take its containers down. Shown and
/// not held, one an earlier app left running stayed up through Quit and was shown again at the next
/// launch. Called holding `Shell::startup`, with the engine that verified the deployment; a session
/// that already holds a deployment keeps it.
fn hold_shown_deployment<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    shell: &Shell,
    root: &Path,
    address: engine::Address,
    server_port: u16,
) {
    let free = shell.containers.lock().unwrap().is_none();
    let free = free && shell.root.lock().unwrap().is_none();
    if !free {
        return;
    }
    *shell.containers.lock().unwrap() = Some(ContainerDeployment {
        root: root.to_path_buf(),
        address: address.clone(),
    });
    *shell.root.lock().unwrap() = Some(root.to_path_buf());
    serve_shown_deployment(app, shell, root, address, server_port);
}

/// The rest of what Start gives the deployment it raised, given to one the window took over: local
/// folder access, and the watcher that sends the window to setup when the server reports a
/// connection refused. Both answer to the server with the per-run host token, and the session that
/// minted it is gone, so it is read back from the `server` container, the one place it is kept.
/// Without them, a deployment shown after a crash, a force quit or an installer that closed the app
/// looked running while neither worked until the person quit and started again. A failure here
/// leaves the deployment shown and held, as before, and says why in the log.
fn serve_shown_deployment<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    shell: &Shell,
    root: &Path,
    address: engine::Address,
    server_port: u16,
) {
    let token = match server_host_token(&address, root) {
        Ok(Some(token)) => token,
        Ok(None) => {
            log::warn!("[show] the server was given no host token: local folder access and the connection watcher are off until Start");
            return;
        }
        Err(error) => {
            log::warn!("[show] could not read the server's host token, so local folder access and the connection watcher are off until Start: {error}");
            return;
        }
    };
    match start_host_access(app, root, server_port, address, token.clone()) {
        Ok(broker) => *shell.host_access.lock().unwrap() = Some(broker),
        Err(problem) => log::warn!("[show] {}", problem_detail(problem)),
    }
    let generation = shell.generation.load(std::sync::atomic::Ordering::SeqCst);
    watch_connections(
        app.clone(),
        root.to_path_buf(),
        token,
        generation,
        server_port,
    );
}

/// The host token `root`'s running `server` container was given, asked of the engine that holds it.
#[cfg(not(test))]
fn server_host_token(address: &engine::Address, root: &Path) -> Result<Option<String>, String> {
    stack::server_host_token(address, root)
}

/// Tests never ask a real engine. They say which token a root's server container was given.
#[cfg(test)]
fn server_host_token(_address: &engine::Address, root: &Path) -> Result<Option<String>, String> {
    Ok(tests::host_token_given_to_server(root))
}

/// [`owned_app_url`] without a window: the Recorder's native host is a process of its own, started
/// by the browser, so it holds no engine and asks whichever one answers.
fn app_url_published_by(
    owned: Option<&engine::Address>,
    root: &Path,
    ports: &openbot_env::Ports,
) -> Option<String> {
    app_published_by(owned, root, ports).map(|(url, _)| url)
}

/// The app's address, with the engine whose `server` container publishes it and the API.
fn app_published_by(
    owned: Option<&engine::Address>,
    root: &Path,
    ports: &openbot_env::Ports,
) -> Option<(String, engine::Address)> {
    // An interrupted upgrade outranks surviving process ownership after a shell crash. Every
    // passive adoption, tray restore and Recorder handoff shares this boundary.
    if upgrade::interrupted(root) {
        return None;
    }
    let mut publisher = None;
    if !already_running_on(root, ports.server, |root, server| {
        publisher = server_container_publisher(owned, root, &[server, ports.app])?;
        Ok(publisher.is_some())
    }) {
        return None;
    }
    Some((stack::app_url(ports.app)?, publisher?))
}

/// An address the Recorder's native host answers in place of a Desktop deployment's own, so a test
/// can drive the whole handoff against an OpenBot it started itself. Debug builds only: a release
/// binary never reads the variable.
#[cfg(debug_assertions)]
fn recorder_host_test_app_url() -> Option<String> {
    std::env::var("OPENBOT_RECORDER_HOST_TEST_APP_URL")
        .ok()
        .filter(|url| !url.is_empty())
}

#[cfg(not(debug_assertions))]
fn recorder_host_test_app_url() -> Option<String> {
    None
}

/// An OpenBot this window shows as its own at launch, so a test can drive OpenBot's page inside the
/// real Desktop window, with the shell's plugin granted to it, against an OpenBot it started itself
/// and no installation. Debug builds only: a release binary never reads the variable.
#[cfg(debug_assertions)]
fn desktop_test_app_url() -> Option<String> {
    std::env::var("OPENBOT_DESKTOP_TEST_APP_URL")
        .ok()
        .filter(|url| !url.is_empty())
}

#[cfg(not(debug_assertions))]
fn desktop_test_app_url() -> Option<String> {
    None
}

/// An OpenBot app a developer runs from source (`OPENBOT_DEV_APP_URL`, such as `cd app && SERVER_PORT=3001 bun run dev
/// --port 3030`, whose `/api` goes to this installation's server), shown in place of the installation's own once it has
/// started, so a change to the app shows in the real window as it is saved. Unlike `OPENBOT_DESKTOP_TEST_APP_URL` it
/// waits for the installation: setup and Start run as they always do. Debug builds only: a release binary never reads
/// the variable.
///
/// `localhost` is read as `127.0.0.1`. Only a loopback IP is trusted as OpenBot's own page
/// (`intelligence_bridge::app_origin`), so at `localhost` the window drew the system's title bar over a page that never
/// made room for the buttons.
#[cfg(debug_assertions)]
fn dev_app_url() -> Option<String> {
    let address = std::env::var("OPENBOT_DEV_APP_URL")
        .ok()
        .filter(|url| !url.is_empty())?;
    Some(loopback_ip(&address))
}

#[cfg(not(debug_assertions))]
fn dev_app_url() -> Option<String> {
    None
}

/// `address` with a `localhost` host written as `127.0.0.1`, and unchanged otherwise.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn loopback_ip(address: &str) -> String {
    match tauri::Url::parse(address) {
        Ok(mut url) if url.host_str() == Some("localhost") => {
            let _ = url.set_host(Some("127.0.0.1"));
            url.into()
        }
        _ => address.to_owned(),
    }
}

/// Trust `address` as this shell's OpenBot and show it, the way `show_openbot` shows a verified one.
fn show_test_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>, address: &str) {
    let (Some(window), Ok(url)) = (
        app.get_webview_window("main"),
        address.parse::<tauri::Url>(),
    ) else {
        return;
    };
    trust_owned_app(app, address);
    if let Err(error) = window.navigate(url) {
        log::warn!("[window] could not show the test OpenBot: {error}");
    }
}

/// The ping's one question to the app: does `/api/capabilities` answer through the app's port, on either loopback.
fn recorder_ping_app_answers(port: u16) -> bool {
    stack::answering_within(
        port,
        "/api/capabilities",
        recorder_host::PING_PROBE_PATIENCE,
    )
    .is_some()
}

/// What the Recorder's native host knows about this computer's OpenBot.
///
/// The browser starts the host as a fresh process with no app around it, so it finds the deployment
/// the way the app's setup does: the root last launched, read from Tauri's config directory.
fn recorder_host_environment() -> recorder_host::HostEnvironment {
    let home = recorder_home().unwrap_or_else(|| PathBuf::from("."));
    let config = recorder_host::app_config_dir(
        recorder_os(),
        &home,
        std::env::var_os("XDG_CONFIG_HOME")
            .as_deref()
            .map(Path::new),
        std::env::var_os("APPDATA").as_deref().map(Path::new),
    );
    let root = preparation::selected_root(&config);
    if let Some(url) = recorder_host_test_app_url() {
        let port = reqwest::Url::parse(&url)
            .ok()
            .and_then(|url| url.port_or_known_default());
        return recorder_host::HostEnvironment {
            installed: Box::new(|| true),
            app_answers: Box::new(move || port.is_some_and(recorder_ping_app_answers)),
            app_url: Box::new(move || Some(url.clone())),
        };
    }
    let installed = root.is_some();
    let ping_root = root.clone();
    recorder_host::HostEnvironment {
        installed: Box::new(move || installed),
        // No ownership check: a ping proves nothing and sends nothing secret, and the handoff checks before it does.
        app_answers: Box::new(move || {
            ping_root
                .as_deref()
                .and_then(|root| openbot_env::Ports::read(root).ok())
                .is_some_and(|ports| recorder_ping_app_answers(ports.app))
        }),
        app_url: Box::new(move || {
            let root = root.as_deref()?;
            let ports = openbot_env::Ports::read(root).ok()?;
            app_url_published_by(None, root, &ports)
        }),
    }
}

/// The engine on which `root`'s `server` container publishes `ports`, if it does: asked of the
/// engine this session raised it on when there is one, and otherwise of whichever engine answers:
/// an OpenBot left running by an earlier session is still this deployment's, and its restart policy
/// kept it up.
#[cfg(not(test))]
fn server_container_publisher(
    owned: Option<&engine::Address>,
    root: &Path,
    ports: &[u16],
) -> Result<Option<engine::Address>, Problem> {
    let address = match owned {
        Some(address) => address.clone(),
        None => {
            let status = engine::detect();
            match status.address.filter(|_| status.responding) {
                Some(address) => address,
                None => return Ok(None),
            }
        }
    };
    Ok(stack::server_publishes(&address, root, ports)?.then_some(address))
}

/// Tests never ask a real engine. They say which roots' server containers publish which ports, on
/// the engine this session holds or else the plain Docker one (`tests::fake_engine`'s).
#[cfg(test)]
fn server_container_publisher(
    owned: Option<&engine::Address>,
    root: &Path,
    ports: &[u16],
) -> Result<Option<engine::Address>, Problem> {
    Ok(tests::published_by_server(root, ports).then(|| {
        owned
            .cloned()
            .unwrap_or_else(|| engine::Address::new(engine::Engine::Docker, None))
    }))
}

#[cfg(test)]
fn server_container_publishes(
    owned: Option<&engine::Address>,
    root: &Path,
    ports: &[u16],
) -> Result<bool, Problem> {
    Ok(server_container_publisher(owned, root, ports)?.is_some())
}

/// What stopped the stack, if anything did, and forget it once it has been read.
///
/// Cleared on reading so a failure from an hour ago does not greet somebody who has since fixed it.
/// Off the event-loop thread for the same reason as `already_running`.
#[tauri::command]
async fn last_failure<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Option<openbot_desktop_lib::problem::Problem> {
    tauri::async_runtime::spawn_blocking(move || last_failure_now(&app))
        .await
        .unwrap_or_else(|error| {
            Some(Problem::with(
                "OpenBot could not read what stopped it.",
                error.to_string(),
            ))
        })
}

fn last_failure_now<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
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
            /*
             * The model credentials, so the wizard never asks twice for one of these.
             *
             * A key already in the file is one somebody has already produced, and making them find
             * it again means opening a dotfile in an editor. Read back because it is their own file,
             * on their own machine, and this is the screen that asks for it. Intelligence's settings
             * are not read: they belong to the local stack, which Start is given afresh.
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
    /*
     * A provider's API key, known either way: in the `.env`, or in the vault (read for the file's
     * presence alone) when the choice recorded beside it says it is that provider's. A compatible
     * endpoint keeps its key in the same OPENAI_API_KEY slot and takes the OpenAI record away, so
     * the vault alone would offer an endpoint's key as OpenAI's.
     */
    let api_key = |key: &str, category| {
        Some(
            values.contains_key(key)
                || (intent.categories.contains(&category)
                    && openbot_desktop_lib::vault::stored(&root, key)),
        )
    };
    let local_eval = local_eval_state::read(&root, None);
    AlreadyConfigured {
        /*
         * A launch only with the local Intelligence stack it launched with.
         *
         * An installation set up by an earlier app against hosted or self-hosted Intelligence has a
         * launch record and no local stack. Offering that launch would reopen it against a service
         * this app no longer connects to, so it is not offered: the window starts the local setup,
         * and the installation, its settings and its data are all left where they are.
         */
        launch: preparation::launch(&root).filter(|_| local_eval.is_some()),
        installation: preparation::installation(&root),
        auto_start: true,
        local_eval,
        saved: SavedConfiguration {
            model_api_keys: SavedModelApiKeys {
                openai: api_key("OPENAI_API_KEY", Category::OpenAiApiKey),
                anthropic: api_key("ANTHROPIC_API_KEY", Category::AnthropicApiKey),
                compatible: values
                    .get("OPENAI_BASE_URL")
                    .is_some_and(|url| intent.has_compatible_key_for(url))
                    .then_some(true),
            },
            model_sessions: SavedModelSessions {
                // Known either way, from the token store the sign-in wrote: Start reads that file
                // and nothing else, and a choice recorded without it is not a saved sign-in.
                openai: Some(openbot_env::saved_chatgpt_plan_store(&root)),
                // Known either way, never guessed from a choice recorded before it was saved: the
                // token is in the vault (a file, read here for its presence alone) or the `.env`.
                anthropic: Some(
                    claude_plan
                        || openbot_desktop_lib::vault::stored(&root, "CLAUDE_CODE_OAUTH_TOKEN"),
                ),
                google: hint(Category::GoogleOauth, false),
                xai: hint(Category::XaiOauth, false),
            },
            model: intent.model,
        },
        values,
    }
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

/**
Stop a ChatGPT sign-in the person has left: another provider, Back, Escape.

Whoever is waiting in `finish_chatgpt_sign_in` gets an error, which the screen it came from has
already stopped listening for. The browser tab gets OpenBot's page saying the sign-in ended.
*/
#[tauri::command]
async fn cancel_chatgpt_sign_in(app: tauri::AppHandle) -> Result<(), String> {
    // Started but not yet waited on: dropping it removes its container.
    let held = app
        .state::<Shell>()
        .signing_in_to_chatgpt
        .lock()
        .unwrap()
        .take();
    tauri::async_runtime::spawn_blocking(move || {
        drop(held);
        openbot_desktop_lib::plan::cancel_chatgpt_sign_in();
    })
    .await
    .map_err(|error| format!("The sign-in did not stop: {error}"))
}

/// The model screen's rows. Independent of the Bot, and required to stay that way: no harness is
/// tied to a vendor's models, so the Bot may not narrow this.
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

/// Nothing for a provider whose session stays in the native credential file; the minted API key
/// for one whose sign-in produces a key (Unbiased), which the window carries on as a typed one.
#[tauri::command]
async fn finish_model_oauth(attempt_id: String) -> Result<Option<String>, String> {
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
async fn run_local_eval<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    attempt: String,
    action: local_eval::Action,
    stack: String,
) -> Result<local_eval::Report, local_eval::Failure> {
    let stack = local_eval::StackId::parse(&stack)?;
    let root = {
        let shell = app.state::<Shell>();
        let selected = shell.selected_root.lock().unwrap().clone();
        selected.unwrap_or_else(stack::default_root)
    };
    let report = tauri::async_runtime::spawn_blocking(move || {
        local_eval_answer(&root, &attempt, action, &stack)
    })
    .await
    .map_err(|_| local_eval::Failure::Spawn)
    .and_then(|answered| answered);
    // A `local start` or `local update` that stops the back end from running is a setup failure.
    let failing = match action {
        local_eval::Action::Start => Some(telemetry::FailingStep::LocalStart),
        local_eval::Action::Update => Some(telemetry::FailingStep::LocalUpdate),
        local_eval::Action::Status | local_eval::Action::Stop => None,
    };
    if let Some(failure) = failing.and_then(|step| desktop_telemetry::report_failure(step, &report))
    {
        desktop_telemetry::setup_failed(&app, failure);
    }
    if action == local_eval::Action::Status {
        for line in
            local_eval::status_waited(&mut back_end_wait(), std::time::Instant::now(), &report)
        {
            log::info!("{line}");
        }
    }
    let report = report?;
    learn_dashboards(&app, report.stack.iter());
    Ok(report)
}

/// The window's wait for the back end to report ready, as the log says it (`logging::WaitLog`):
/// every `local status` answer as it changes, and why the wait ended. A Start on Windows waited
/// five minutes and gave up with nothing in the log between.
static BACK_END_WAIT: Mutex<Option<openbot_desktop_lib::logging::WaitLog>> = Mutex::new(None);

fn back_end_wait() -> std::sync::MutexGuard<'static, Option<openbot_desktop_lib::logging::WaitLog>>
{
    BACK_END_WAIT
        .lock()
        .unwrap_or_else(|held| held.into_inner())
}

/// The window stopped waiting for the back end, and why: the sentence it shows (`waitForReady`),
/// such as "OpenBot didn't get ready in time. Retry to check again." Written with how long it
/// waited and the last status, so the log says why Start gave up.
#[tauri::command]
fn back_end_wait_ended(why: String) {
    let mut wait = back_end_wait();
    let now = std::time::Instant::now();
    match wait.take() {
        Some(waited) => log::warn!("{}", waited.ended(now, &format!("gave up: {why}"))),
        None => log::warn!("[wait] the backend: gave up before any status answered: {why}"),
    }
}

/// The back end update last written to the log, so a status polled every few seconds says it once.
static UPDATE_LOGGED: Mutex<Option<String>> = Mutex::new(None);

/// The release the back end is on, the one the window updates it to, and the CLI's step an earlier
/// update stopped at. The window says only "Updating OpenBot", and where it stopped in plain words:
/// the versions and the step's name are for whoever reads the log.
fn log_update_due(from: &str, to: &str, stopped_at: Option<&str>) {
    let entry = update_due_entry(from, to, stopped_at);
    let mut logged = UPDATE_LOGGED
        .lock()
        .unwrap_or_else(|held| held.into_inner());
    if logged.as_deref() != Some(entry.as_str()) {
        log::info!("{entry}");
        *logged = Some(entry);
    }
}

fn update_due_entry(from: &str, to: &str, stopped_at: Option<&str>) -> String {
    let mut entry = format!("[local update] the backend is on {from}, due an update to {to}");
    if let Some(step) = stopped_at {
        entry.push_str(&format!("; the last update stopped at {step}"));
    }
    entry
}

/// What `run_local_eval` answers the window for one CLI call, from the installed CLI.
fn local_eval_answer(
    root: &Path,
    attempt: &str,
    action: local_eval::Action,
    stack: &local_eval::StackId,
) -> Result<local_eval::Report, local_eval::Failure> {
    know_cli_engine(root);
    let mut report = local_eval::run_installed(attempt, action, stack)?;
    // An Intelligence an older app installed, behind the release this app's CLI installs, or one
    // whose update did not finish: the window updates it before it starts OpenBot on it.
    if action == local_eval::Action::Status {
        report.update_to =
            local_eval::update_due(&report, local_eval::bundled_release().as_deref());
        // The window says "Updating OpenBot"; the log keeps the releases, once per update due,
        // and the step an update that did not finish stopped at.
        if let (Some(to), Some(stack)) = (&report.update_to, &report.stack) {
            let stopped_at = stack
                .unfinished_update
                .as_ref()
                .and_then(|unfinished| unfinished.failed_step.as_deref());
            log_update_due(&stack.installed_release, to, stopped_at);
        }
    }
    Ok(report)
}

/**
The engine for the Intelligence CLI when nothing this run has named one yet.

A relaunched OpenBot can ask Intelligence for its status before Start has pinned an engine, and the
account screen asks the CLI before Install has found one (Install does not run again over an
installation already prepared). On Windows Podman also answers on Docker's pipe, and a CLI not told
which engine it is on declines with `engine_mismatch`. The
answer is the one Start would reach with no containers of its own: the engine `root` was set up on
if it saved one (see `preparation::saved_engine`), otherwise whatever `engine::detect` finds
answering. Blocking, so only from a blocking thread.
*/
fn know_cli_engine(root: &Path) {
    if local_eval::engine_known() {
        return;
    }
    let found = engine::detect_saved(preparation::saved_engine(root));
    if let Some(address) = found.address.filter(|_| found.responding) {
        local_eval::use_engine(&address);
    }
}

/**
Whether the person's own Podman machine answers while OpenBot's is still on its way, so the CLI must
not be asked yet.

The CLI, told no engine, takes the Podman machine that answers, and that is the person's. On a live
Windows run it refused theirs ("Rootless Podman is not supported. Switch to rootful Podman ...") and
the account step showed that as a change the person had to make. OpenBot passes theirs over and
makes its own (`engine::passed_over_machine`), so until that answers, the account step waits as it
waits for any engine coming up. Asked only while no engine is known, after `know_cli_engine`.
*/
fn own_machine_on_its_way(root: &Path) -> bool {
    own_machine_on_its_way_with(
        local_eval::engine_known(),
        preparation::saved_engine(root),
        || engine::passed_over_machine(&engine::Address::new(engine::Engine::Podman, None)),
    )
}

/// `own_machine_on_its_way`, with what it reads passed in: whether an engine is known, the engine
/// the installation saved, and the person's machine behind Podman's default connection that OpenBot
/// passes over, if any.
fn own_machine_on_its_way_with(
    engine_known: bool,
    saved: Option<engine::Engine>,
    passed_over: impl FnOnce() -> Option<String>,
) -> bool {
    !engine_known && saved != Some(engine::Engine::Docker) && passed_over().is_some()
}

/// The account step's check: the CLI's own answer, or, while OpenBot's machine is on its way, that
/// the engine is not ready yet, without asking the CLI.
fn account_terms(
    on_its_way: bool,
    ask_the_cli: impl FnOnce() -> Result<local_eval::Terms, local_eval::Failure>,
) -> Result<local_eval::Terms, local_eval::Failure> {
    if on_its_way {
        return Ok(local_eval::Terms::EngineNotReady {
            cause: "own_machine",
        });
    }
    ask_the_cli()
}

/// Keep the dashboard address of every stack a CLI report described, for `Dashboards`.
fn learn_dashboards<'a, R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
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

impl From<local_eval::Failure> for SetupError {
    fn from(failure: local_eval::Failure) -> Self {
        SetupError::Failure(failure)
    }
}

/// A setup OpenBot stopped itself is said like a stack it could not record: in plain words.
impl From<local_eval::SetupStopped> for SetupError {
    fn from(stopped: local_eval::SetupStopped) -> Self {
        match stopped {
            local_eval::SetupStopped::Failure(failure) => SetupError::Failure(failure),
            local_eval::SetupStopped::Said(problem) => SetupError::Unrecorded(problem),
        }
    }
}

/**
`local setup` for this installation, and the stack it made recorded as OpenBot's.

Blocked is a normal answer here, not an error: the first one is the evaluation agreement, which the
person accepts in their own terminal before the window asks again. Only a completed setup is
recorded, and only then does Stop or Quit stop that stack.
*/
#[tauri::command]
async fn set_up_local_eval<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
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
        know_cli_engine(&root);
        set_up_local_eval_at(&root, |folder| {
            local_eval::setup_installed(&attempt, folder, accepted.as_ref()).map_err(Into::into)
        })
    })
    .await
    .map_err(|_| SetupError::Failure(local_eval::Failure::Spawn))
    .and_then(|set_up| set_up);
    // A failed `local setup` is a setup failure, sent from here: the window hands it on only.
    let failing = telemetry::FailingStep::LocalSetup;
    let failure = match &report {
        Ok(report) => desktop_telemetry::report_failure(failing, &Ok(report.clone())),
        Err(SetupError::Failure(failure)) => {
            desktop_telemetry::report_failure(failing, &Err(*failure))
        }
        Err(SetupError::Unrecorded(problem)) => Some(desktop_telemetry::SetupFailure::new(
            failing,
            desktop_telemetry::class_of_row(failing, &problem.said),
        )),
    };
    if let Some(failure) = failure {
        desktop_telemetry::setup_failed(&app, failure);
    }
    let report = report?;
    learn_dashboards(&app, report.stack.iter());
    Ok(report)
}

/**
Sign in to CopilotKit, which local evaluation needs to issue its licence: `login --json`.

The CLI opens the approval page in the browser and waits for it; this returns once the person has
approved it there, or it failed. `attempt` lets `cancel_local_eval` stop the wait, and
`copilotkit_sign_in_page` show the page it is waiting on.
*/
#[tauri::command]
async fn sign_in_to_copilotkit<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    attempt: String,
) -> Result<local_eval::AccountSignIn, local_eval::Failure> {
    let root = selected_root_or_default(&app);
    let started_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        know_cli_engine(&root);
        // The person is in their browser for as long as this takes, minutes at times.
        log::info!("[account] browser sign-in started");
        desktop_telemetry::sign_in_started(&started_app);
        let asked = std::time::Instant::now();
        let signed_in = while_signing_in(
            || local_eval::account_sign_in_installed(&attempt),
            || bring_to_front(&started_app, "the browser sign-in ended"),
        );
        let took = asked.elapsed();
        match &signed_in {
            Ok(said) => log::info!(
                "[account] browser sign-in ended after {}s, signed in: {}",
                took.as_secs(),
                said.signed_in
            ),
            Err(failure) => log::info!(
                "[account] browser sign-in ended after {}s: {failure:?}",
                took.as_secs()
            ),
        }
        // What the `[account]` lines say, as usage data: how it ended and how long it took.
        desktop_telemetry::sign_in_ended(&started_app, &signed_in, took);
        signed_in
    })
    .await
    .map_err(|_| local_eval::Failure::Spawn)?;
    desktop_telemetry::finish_sign_in(&app, result)
}

/// The approval page and code `sign_in_to_copilotkit`'s `attempt` is waiting on, once the CLI has
/// opened it, so the window can show the code and open the page again.
#[tauri::command]
fn copilotkit_sign_in_page(attempt: String) -> Option<local_eval::SignInPage> {
    local_eval::shown_sign_in_page(&attempt)
}

/// The CLI's steps the running setup, start or update `attempt` has finished, by name, so its row
/// can say what it is doing now and how far along it is. Step names and seconds only.
#[tauri::command]
fn local_eval_steps(attempt: String) -> Option<local_eval::Steps> {
    local_eval::steps(&attempt)
}

/// How much of the back end's download the setup or update `attempt` has, of how much,
/// while it downloads, so its row can show a slow line moving. Bytes only.
#[tauri::command]
fn local_eval_download(attempt: String) -> Option<openbot_desktop_lib::local_images::Download> {
    local_eval::downloading(&attempt)
}

/// The step the back end update `attempt` is in and for how long, once it is in one that waits,
/// so a step that takes minutes is never a silent row. A fixed step name and seconds only.
#[tauri::command]
fn local_eval_update_step(
    attempt: String,
) -> Option<openbot_desktop_lib::local_update::UpdateStep> {
    local_eval::update_step(&attempt)
}

/// The evaluation agreement local setup needs accepted, for the window to show before Accept.
#[tauri::command]
async fn local_eval_terms(
    app: tauri::AppHandle,
    attempt: String,
) -> Result<local_eval::Terms, local_eval::Failure> {
    let root = selected_root_or_default(&app);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let asked = std::time::Instant::now();
        // The CLI checks its engine before it answers. See `know_cli_engine`.
        know_cli_engine(&root);
        // An engine too small for local setup is said here, before Start fails on it.
        let terms =
            account_terms(
                own_machine_on_its_way(&root),
                || match local_eval::engine_size_terms() {
                    Some(too_small) => Ok(too_small),
                    None => local_eval::terms_installed(&attempt),
                },
            );
        // What the step waits on, said in the log when it changes. See `AccountWait`.
        let step = RUNNING_LOGGED
            .lock()
            .unwrap_or_else(|held| held.into_inner())
            .as_ref()
            .map(|(step, _)| step.clone());
        let entry = ACCOUNT_WAIT
            .lock()
            .unwrap_or_else(|held| held.into_inner())
            .heard(
                std::time::Instant::now(),
                asked.elapsed(),
                &terms,
                step.as_deref(),
            );
        if let Some(entry) = entry {
            log::info!("{entry}");
        }
        terms
    })
    .await
    .map_err(|_| local_eval::Failure::Spawn)?;
    desktop_telemetry::finish_account_check(&app, result)
}

/// What the Account step's sign-in check has been waiting on, between one check and the next.
static ACCOUNT_WAIT: Mutex<local_eval::AccountWait> = Mutex::new(local_eval::AccountWait::new());

/// The folder this window is installing into, or the default one.
fn selected_root_or_default<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    let shell = app.state::<Shell>();
    let selected = shell.selected_root.lock().unwrap().clone();
    selected.unwrap_or_else(stack::default_root)
}

/**
Connect this installation's apps with the CopilotKit sign-in that just finished, and again on
Connect apps.

Only adds a key, and never fails the sign-in: the window offers Continue without apps, and every
Start tries again. `attempt` lets `cancel_local_eval` stop the CLI call.
*/
#[tauri::command]
async fn connect_copilotkit_apps<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    attempt: String,
    root: String,
) -> Result<(), Problem> {
    let root = stack::root_from(&root);
    if !root.is_absolute() {
        return Err(apps_unavailable());
    }
    let result = tauri::async_runtime::spawn_blocking(move || connect_apps(&root, &attempt))
        .await
        .map_err(|_| apps_unavailable())?;
    desktop_telemetry::finish_account_setup(&app, result)
}

/// Ask CopilotKit for this installation's Composio project through the CLI, and keep its key.
/// See `composio::connect`.
fn connect_apps(root: &Path, attempt: &str) -> Result<(), Problem> {
    openbot_desktop_lib::composio::connect(root, |installation, env_file| {
        local_eval::provision_apps_installed(attempt, installation, env_file)
            .map_err(|_| apps_unavailable())
    })
}

fn apps_unavailable() -> Problem {
    openbot_desktop_lib::composio::setup_problem()
}

/**
Run `setup` in `root` and record what it made.

A stack set up here was made for OpenBot, so it starts and stops with it. It is OpenBot's only when
the CLI records it for `root` itself (`appPaths`): a stack recorded for another folder is another
app's, whatever setup reported, and is kept as shared, so Stop and Quit never stop it. A record that
already calls the same stack shared stays shared: setting up again resumes that stack, it does not
make OpenBot its owner.
*/
fn set_up_local_eval_at<S>(root: &Path, setup: S) -> Result<local_eval::Report, SetupError>
where
    S: FnOnce(&Path) -> Result<(local_eval::Report, String), SetupError>,
{
    let (report, cli_sha256) = setup(root)?;
    let Some(stack) = report
        .stack
        .as_ref()
        .filter(|_| report.outcome == local_eval::Outcome::Completed)
    else {
        return Ok(report);
    };
    let ours = stack.lists_folder(root);
    let stack = local_eval::StackId::parse(&stack.id).map_err(SetupError::Failure)?;
    let ownership = match local_eval_state::read(root, None) {
        _ if !ours => local_eval_state::Ownership::Shared,
        Some(state) if state.stack_id() == stack => state.ownership,
        _ => local_eval_state::Ownership::Created,
    };
    if !ours {
        log::warn!(
            "[local setup] {} is recorded for another folder; OpenBot keeps it as shared and never stops it",
            stack.as_str()
        );
    }
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
async fn connect_local_eval<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
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
    .map_err(|_| ConnectError::Failure(local_eval::Failure::Spawn))
    .and_then(|connected| connected);
    let failing = telemetry::FailingStep::LocalConnect;
    let failure = match &connection {
        Ok(connection) => desktop_telemetry::connection_failure(&Ok(connection.clone())),
        Err(ConnectError::Failure(failure)) => {
            desktop_telemetry::connection_failure(&Err(*failure))
        }
        Err(ConnectError::Unconnected(problem)) => Some(desktop_telemetry::SetupFailure::new(
            failing,
            desktop_telemetry::class_of_row(failing, &problem.said),
        )),
    };
    if let Some(failure) = failure {
        desktop_telemetry::setup_failed(&app, failure);
    }
    let connection = connection?;
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
        .ok_or_else(|| unconnected("Set up the backend before connecting OpenBot to it."))?;
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
            "A different backend was connected. OpenBot did not use it.",
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
            "OpenBot could not read the connection settings for its backend.",
            format!("{}: {}", env_file.display(), error.kind()),
        ))
    })?;
    /*
     * Compared and kept at `127.0.0.1` where the CLI says `localhost`, as Start writes them
     * (`numeric_loopback`), so a file Start already rewrote still matches the stack it names, and
     * the address the browser is handed never says `localhost`.
     */
    let addresses = [
        (
            "INTELLIGENCE_API_URL",
            openbot_env::numeric_loopback(&stack.urls.api),
        ),
        (
            "INTELLIGENCE_GATEWAY_WS_URL",
            openbot_env::numeric_loopback(&stack.urls.gateway),
        ),
    ];
    if addresses.iter().any(|(name, reported)| {
        written
            .get(*name)
            .map(|value| openbot_env::numeric_loopback(value))
            .as_ref()
            != Some(reported)
    }) {
        return Err(unconnected(
            "The connection settings do not match the backend that was set up. OpenBot did not use them.",
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
                .map(|(name, value)| ((*name).to_owned(), value.clone()))
                .collect();
            let purge = [(LOCAL_EVAL_CONNECTED_KEY.to_owned(), String::new())].into();
            openbot_env::write(&env_file, &settings, &purge).map_err(|error| {
                ConnectError::Unconnected(Problem::with(
                    "OpenBot kept the backend's key but could not remove it from its settings file.",
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
                    "The backend connected, but OpenBot has no key for it.",
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

/// Why the dashboard did not open: a fixed category, which is all the OpenBot app's page is told.
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
"Open back end dashboard" opens its address directly and at once. OpenBot does not read the
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
The window says whether it is in local mode for `root`, and the app page's dashboard offer follows.

The window decides local mode, as it does for its own link. The menus have no dashboard item: the
dashboard is the back end's own, under another product's name, and a menu of OpenBot's does not
send a person there.
*/
#[tauri::command]
fn offer_local_intelligence(app: tauri::AppHandle, root: String, offered: bool) {
    let next = intelligence_menu_root(&stack::root_from(&root), offered);
    let shell = app.state::<Shell>();
    let mut current = shell.intelligence_menu.lock().unwrap();
    if *current == next {
        return;
    }
    *current = next;
    drop(current);
    intelligence_bridge::tell(&app, intelligence_bridge::current(&app));
}

/**
Open the dashboard of the stack the app page is offered (`intelligence_bridge`).

Answered at once, before any CLI call, and how it went after, both to the page's row.
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

/// How a dashboard opening is going, as the app page's row is told it.
#[derive(Clone, Debug, PartialEq, Eq)]
enum IntelligenceOpening {
    Opening,
    Opened,
    Failed(DashboardFailure),
}

/**
Say `Opening` now, run `open` through `spawn`, then say how it went.

Once at a time: one asked for while another runs does nothing. `opening` is clear again before
the outcome is said, so the row offers it again.
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

/// Tell the app page's row how the opening is going.
fn show_intelligence_opening<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    status: IntelligenceOpening,
) {
    let _ = intelligence_bridge::tell(app, intelligence_bridge::Offer::after(&status));
}

/// Room left between a grown or clamped window and the edge of its monitor's work area.
const SCREEN_MARGIN: f64 = 24.0;

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
    lift_into_work_area(window, area, frame, height);
}

/// Move the window up if its bottom edge, for a content area `height` logical pixels tall, is past
/// its monitor's work area. Its size and its left edge stay.
fn lift_into_work_area<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    area: &tauri::LogicalRect<f64, f64>,
    frame: f64,
    height: f64,
) {
    let (Ok(scale), Ok(position)) = (window.scale_factor(), window.outer_position()) else {
        return;
    };
    let position = position.to_logical::<f64>(scale);
    if let Some(top) = lifted_top(position.y, frame + height, area) {
        let _ = window.set_position(tauri::LogicalPosition::new(position.x, top));
    }
}

/// Where a window whose top is at `top` and whose outer height is `outer` moves to so its bottom
/// stays `SCREEN_MARGIN` inside the work area, never above the area's top. None when it already fits.
fn lifted_top(top: f64, outer: f64, area: &tauri::LogicalRect<f64, f64>) -> Option<f64> {
    let bottom = area.position.y + area.size.height - SCREEN_MARGIN;
    (top + outer > bottom).then(|| (bottom - outer).max(area.position.y))
}

/**
On launch: a window taller than its monitor's work area is brought within it, and one whose bottom
edge is past the work area is moved up.

The window has no position of its own (`tauri.conf.json` gives none, and never did), so Windows
places it with `CW_USEDEFAULT`, which cascades each new window down and right. A few launches in, a
1000 by 800 window's bottom was behind the taskbar, and with it the sidebar's account row.
*/
fn fit_main_window_to_screen<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    bring_onto_a_screen(&window);
    let (Some((area, frame)), Ok(scale), Ok(inner)) = (
        screen_room(&window),
        window.scale_factor(),
        window.inner_size(),
    ) else {
        return;
    };
    let tallest = area.size.height - frame - 2.0 * SCREEN_MARGIN;
    let height = inner.to_logical::<f64>(scale).height;
    if height > tallest {
        set_window_height(&window, &area, frame, tallest.floor());
    } else {
        lift_into_work_area(&window, &area, frame, height);
    }
}

/**
Where a window at `window` goes so that its title bar is on one of `areas` (each monitor's work
area, the primary first), or None when it already is. A window put back where it was last time
(`tauri_plugin_window_state`) can be on a monitor that is no longer there: it goes to the middle of
the primary one, as far as it fits.
*/
fn onto_a_screen(
    window: tauri::LogicalRect<f64, f64>,
    areas: &[tauri::LogicalRect<f64, f64>],
) -> Option<tauri::LogicalPosition<f64>> {
    // Enough of the title bar to take hold of: 120 by 24 logical pixels of it.
    let reachable = |area: &tauri::LogicalRect<f64, f64>| {
        let left = window.position.x.max(area.position.x);
        let right = (window.position.x + window.size.width).min(area.position.x + area.size.width);
        let top = window.position.y.max(area.position.y);
        let bottom = (window.position.y + 24.0).min(area.position.y + area.size.height);
        right - left >= 120.0 && bottom - top >= 24.0
    };
    if areas.iter().any(reachable) {
        return None;
    }
    let area = areas.first()?;
    Some(tauri::LogicalPosition::new(
        area.position.x + ((area.size.width - window.size.width) / 2.0).max(0.0),
        area.position.y + ((area.size.height - window.size.height) / 2.0).max(0.0),
    ))
}

/// Move `window` onto a screen that is there, if it was put back somewhere that is not.
fn bring_onto_a_screen<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let (Ok(scale), Ok(position), Ok(size)) = (
        window.scale_factor(),
        window.outer_position(),
        window.outer_size(),
    ) else {
        return;
    };
    let primary = window.primary_monitor().ok().flatten();
    let mut monitors = window.available_monitors().unwrap_or_default();
    // The primary monitor first: where a window with no screen of its own goes.
    if let Some(primary) = &primary {
        monitors.sort_by_key(|monitor| monitor.name() != primary.name());
    }
    let areas: Vec<_> = monitors
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            tauri::LogicalRect {
                position: area.position.to_logical(monitor.scale_factor()),
                size: area.size.to_logical(monitor.scale_factor()),
            }
        })
        .collect();
    let rect = tauri::LogicalRect {
        position: position.to_logical(scale),
        size: size.to_logical(scale),
    };
    if let Some(onto) = onto_a_screen(rect, &areas) {
        log::info!("[window] put back off every screen; moved onto the primary one");
        let _ = window.set_position(onto);
    }
}

/// Mark this run as needing its connection refreshed, and send the window to setup to do it.
///
/// False when the run it was found for is no longer the current one, which a Stop or a new Start
/// in the meantime makes it.
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
        openbot_desktop_lib::problem::Connection::Intelligence => "Your OpenBot account connection was refused. Refresh it to continue using your existing OpenBot.",
        openbot_desktop_lib::problem::Connection::Installation => "Part of OpenBot has to be installed again. OpenBot does that, then you can continue using your existing OpenBot.",
    };
    mark_recovery_required(&shell, root, generation);
    if let Some(recovery) = shell.recovery_required.lock().unwrap().as_mut() {
        recovery.connection = Some(connection.clone());
    }
    *shell.last_failure.lock().unwrap() = Some(Problem::plain(said).connection(connection));
    show_setup_and_focus(app.clone())?;
    Ok(true)
}

/**
Watch a running OpenBot for a connection it reports refused, and send the window back to setup to
refresh it.

What is left of the host-process supervisor. Docker's restart policy keeps the server and the worker
up now, so nothing here starts anything. The server still knows, as only it can, when the model, the
Intelligence it was given has been refused, and it tells the desktop
through the token minted for this run. The watcher ends with the run it was started for: a Stop or
another Start moves the generation on, and clearing the root says there is no run at all.
*/
fn watch_connections<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: PathBuf,
    // Carried rather than fetched again: it was minted for this run and is kept nowhere else.
    token: String,
    generation: u64,
    server_port: u16,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let Ok(client) = desktop_connection::client().map_err(|error| {
            log::warn!("[watch] {error}");
        }) else {
            return;
        };
        let mut notice_sent = false;
        let mut poll_failed = false;

        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let shell = app.state::<Shell>();
            // Not this run's any more, or no run at all.
            if shell.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
                || shell.root.lock().unwrap().is_none()
            {
                return;
            }

            if notice_sent && !recovery_required(&shell, &root) {
                notice_sent = false;
            }
            if notice_sent {
                continue;
            }
            match desktop_connection::poll(&client, server_port, &token) {
                Ok(Some(connection)) => {
                    match publish_connection_failure(&app, &root, generation, connection) {
                        Ok(published) => notice_sent = published,
                        Err(error) => {
                            log::warn!("[watch] could not show connection refresh: {error}")
                        }
                    }
                }
                Ok(None) => poll_failed = false,
                Err(error) => {
                    if !poll_failed {
                        log::warn!("[watch] {error}");
                    }
                    poll_failed = true;
                }
            }
        }
    })
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
                log::warn!("[window] could not show setup: {error}");
            }
        }
    }
}

fn restore_window_on<R: tauri::Runtime>(app: &tauri::AppHandle<R>, ports: &openbot_env::Ports) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let shell = app.state::<Shell>();
    // Reopen and the menus call this on the event-loop thread, and installation holds startup for
    // the whole download. Waiting for it there froze the window until the download finished. A
    // busy lock means setup is at work and the window is already on its screen, so show it as it
    // is and leave which page it belongs on to the next restore.
    let startup = match shell.startup.try_lock() {
        Ok(guard) => Some(guard),
        Err(std::sync::TryLockError::WouldBlock) => None,
        Err(std::sync::TryLockError::Poisoned(error)) => panic!("{error}"),
    };
    // Restore has the same deployment ownership requirement as the setup page's passive probe.
    // A successful app-port response alone may belong to another installation or application.
    let destination = startup.as_ref().and_then(|_| {
        let root = cleanup_root(&shell, &stack::default_root());
        if let Some((url, address)) = (!recovery_required_or_pending_quit_notice(&shell, &root))
            .then(|| owned_app(&shell, &root, ports))
            .flatten()
        {
            hold_shown_deployment(app, &shell, &root, address, ports.server);
            refresh_menus(app);
            trust_owned_app(app, &url);
            url.parse().ok()
        } else {
            setup_destination(app).ok()
        }
    });
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

/**
Where a click on one of a Bot's notifications takes the window: the page the notice names
(`extra.path`, which OpenBot's page sets as it posts it), on the OpenBot the window shows. Nothing
when the window shows anything else, or for a path that is not one of that OpenBot's own pages.
*/
fn notification_destination(
    current: &tauri::Url,
    owned: bool,
    path: Option<&str>,
) -> Option<tauri::Url> {
    let path = path.filter(|path| owned && path.starts_with('/') && !path.starts_with("//"))?;
    if path.contains('\\') {
        return None;
    }
    let target = current.join(path).ok()?;
    (target.origin() == current.origin()).then_some(target)
}

/**
A Bot's notification, shown by the system: OpenBot's page asks for it (`desktop_page::notify`) with
the page a click opens.

On Windows a toast of our own, which opens an `openbot://` link by protocol: the only way an app
installed without a package is brought back from the notification centre (see `notice.rs`). On
macOS and Linux the notification plugin's, carrying the page in `extra.path` for its click report.

Each one is logged, shown or not, so the log says whether the page asked and what the system
answered. Never the notice's words or page: they are the person's.
*/
fn show_notice<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    title: &str,
    body: &str,
    path: Option<&str>,
    tag: Option<&str>,
) -> Result<(), String> {
    #[cfg(windows)]
    let shown = {
        let link = path.map_or_else(|| format!("{}://open", notice::SCHEME), notice::open_link);
        notice::show_toast(
            &app.config().identifier,
            &notice::toast_xml(title, body, &link),
            tag.map(notice::toast_tag).as_deref(),
        )
    };
    #[cfg(not(windows))]
    let shown = {
        // The plugin has no tag to replace a notice by: the page sends one notice per moment.
        let _ = tag;
        use tauri_plugin_notification::NotificationExt;
        let mut builder = app.notification().builder().title(title).body(body);
        if let Some(path) = path {
            builder = builder.extra("path", path);
        }
        builder.show().map_err(|error| error.to_string())
    };
    match &shown {
        Ok(()) => log::info!("[notification] shown"),
        Err(error) => log::warn!("[notification] not shown: {error}"),
    }
    shown
}

/**
A click on one of a Bot's notifications, as the notification plugin reports it (`tap`): opens the
page it names. The plugin reports one only for notices it showed; on macOS, with notify-rust 4.18
and mac-notification-sys 0.6.15, not even then (a notice without buttons is sent without waiting
for a response).
*/
fn open_from_notification(
    app: &tauri::AppHandle,
    performed: &tauri_plugin_notification::ActionPerformed,
) {
    if performed.action_id() != "tap" {
        return;
    }
    let path = performed
        .notification()
        .and_then(|notification| notification.extra().get("path"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    open_notice_page(app, path);
}

/// An `openbot://open?path=…` link, which a click on a Windows toast opens, from the notification
/// centre too: Windows starts OpenBot.exe with it and the single-instance plugin hands it here.
fn open_from_link(app: &tauri::AppHandle, link: &tauri::Url) {
    if link.scheme() != notice::SCHEME {
        return;
    }
    open_notice_page(app, notice::path_of(link));
}

/**
OpenBot comes forward, as it does for a second launch, at the page a notice is about. While the
window does not show this OpenBot yet (it is still starting, from a click that launched it), the
page waits for it: `open_waiting_notice_page` opens it once OpenBot's page has loaded.
*/
fn open_notice_page(app: &tauri::AppHandle, path: Option<String>) {
    show_whichever_applies(app);
    // On the window's own thread, which is the thread `AttachThreadInput` lends the foreground's
    // input to. Logged with how the click's launch fared passing the foreground on.
    #[cfg(windows)]
    if let Some(hwnd) = app
        .get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
    {
        let hwnd = hwnd.0 as isize;
        let _ = app.run_on_main_thread(move || {
            let handoff = notice::take_handoff();
            let forward = notice::bring_to_front(hwnd as *mut core::ffi::c_void);
            log::info!(
                "[notification] to the front: {forward:?} (the click's launch: {})",
                handoff.as_deref().unwrap_or("no record")
            );
        });
    }
    let Some(path) = path else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(current) = window.url() else {
        return;
    };
    let owned = matches!(
        window_page(app, &current),
        WindowPage::OwnedApp | WindowPage::LocalApp
    );
    if !owned {
        *app.state::<Shell>().waiting_notice_page.lock().unwrap() = Some(path);
        return;
    }
    navigate_to_notice_page(&current, &path, |script| window.eval(script));
}

/// The page a click asked for before OpenBot's page was there, now that it is.
fn open_waiting_notice_page<R: tauri::Runtime>(window: &tauri::Webview<R>, loaded: &tauri::Url) {
    let waiting = window
        .app_handle()
        .state::<Shell>()
        .waiting_notice_page
        .lock()
        .unwrap()
        .take();
    if let Some(path) = waiting {
        navigate_to_notice_page(loaded, &path, |script| window.eval(script));
    }
}

/**
Goes to `path` on the OpenBot at `current`, unless it is there already or `path` is not one of its
pages (`notification_destination`).

As a route change in the page (`notice::open_script`), never by loading the page again: a click on a
notice used to reload OpenBot and lose what the person was in the middle of. A page from before the
page handled it is loaded at the target instead.
*/
fn navigate_to_notice_page(
    current: &tauri::Url,
    path: &str,
    eval: impl FnOnce(String) -> tauri::Result<()>,
) {
    if let Some(target) = notification_destination(current, true, Some(path)) {
        if &target != current {
            if let Err(error) = eval(notice::open_script(path, target.as_str())) {
                log::warn!("[notification] could not open the page it named: {error}");
            }
        }
    }
}

fn restore_after_second_instance(app: &tauri::AppHandle) {
    let app = app.clone();
    let reporting_app = app.clone();
    if let Err(error) = schedule_second_instance_restore(app, |app| {
        show_whichever_applies(&app);
    }) {
        log::warn!("[single-instance] restore scheduling failed: {error}");
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

/// Stop in the background, then the setup window: the menu's Stop, and the Status window's and
/// Settings > This computer's, which `from` tells apart in the log.
fn stop_from_menu<R: tauri::Runtime>(app: tauri::AppHandle<R>, from: AskedFrom) {
    stop_then_show_setup(app, from, false);
}

/// Settings' Change on the AI model row: the same Stop, then the setup window at its AI screen,
/// where the setup window's own Change AI connection goes. A Stop that failed shows setup as any
/// failed Stop does, with its failure and Start, since OpenBot may still be running.
pub(crate) fn change_ai_connection_from_settings<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    stop_then_show_setup(app, AskedFrom::Settings, true);
}

/// The setup page's one question on load: was it opened to change the AI connection? Answered
/// once, so a later visit to setup opens at Start as usual.
#[tauri::command]
fn take_ai_connection_change<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> bool {
    take_change_ai_connection(&app.state::<Shell>())
}

fn take_change_ai_connection(shell: &Shell) -> bool {
    shell
        .change_ai_connection
        .swap(false, std::sync::atomic::Ordering::SeqCst)
}

/// Asked for only once everything stopped: the AI screen then starts OpenBot with the new choice.
fn settle_change_ai_connection(shell: &Shell, stopped: bool, change_ai_connection: bool) {
    shell.change_ai_connection.store(
        stopped && change_ai_connection,
        std::sync::atomic::Ordering::SeqCst,
    );
}

/// What Settings' AI model row says: the provider and sign-in this installation starts with.
pub(crate) fn ai_connection_now<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> openbot_desktop_lib::ai_connection::AiConnection {
    let root = cleanup_root(&app.state::<Shell>(), &stack::default_root());
    openbot_desktop_lib::ai_connection::read(&root)
}

fn stop_then_show_setup<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    from: AskedFrom,
    change_ai_connection: bool,
) {
    std::thread::spawn(move || {
        let asked = std::time::Instant::now();
        let root = stack::default_root();
        let shell = app.state::<Shell>();
        log_stop_asked(&shell, &root, from);
        let stopped = stop_everything(&app, &root);
        refresh_menus(&app);
        let settled = match settle_menu_stop(&shell, &root, stopped) {
            None => Ok(()),
            Some(problem) => Err(problem),
        };
        logging::outcome("stop", asked, &settled);
        settle_change_ai_connection(&shell, settled.is_ok(), change_ai_connection);
        match settled {
            Ok(()) => report_plain(&app, "stopped", true, "OpenBot has stopped."),
            // Said rather than swallowed. A menu item that fails silently is worse than one
            // that is not there: the person believes the stack is down and it is not.
            Err(problem) => report_plain(&app, "stopped", false, problem.said),
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
            "OpenBot stopped, but some of its services didn't. They may still be running.",
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

/// What each menu item does, wherever it was chosen from.
///
/// The tray and the window menu carry the same items, so they share one function: two copies would
/// be two chances for Stop to mean something different depending on where somebody clicked.
fn chose(app: &tauri::AppHandle, item: &str) {
    match item {
        "open" => show_whichever_applies(app),
        // Stop without quitting: the stack is what costs something to leave running, and somebody
        // who wants it stopped does not necessarily want the application gone.
        "stop" => stop_from_menu(app.clone(), AskedFrom::Menu),
        "status" => show_status_window(app),
        "logs" => {
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = save_troubleshooting_logs_now(&app, None);
            });
        }
        app_update::MENU_ID => check_for_updates_from_menu(app.clone()),
        // Exit rather than hide: quitting is a decision to stop, and the exit handler is what stops
        // the processes with it.
        "quit" => {
            app.exit(0);
        }
        other => {
            if let Some(step) = zoom::Step::of_menu(other) {
                zoom_windows(app, step);
            }
        }
    }
}

/**
Zoom In, Zoom Out or Actual Size, from the View menu or the page's own shortcut (`zoom-shortcut.js`):
every window's page at the new level, kept for the next launch (`zoom`).
*/
pub(crate) fn zoom_windows<R: tauri::Runtime>(app: &tauri::AppHandle<R>, step: zoom::Step) {
    let Ok(directory) = app.path().app_config_dir() else {
        return;
    };
    let level = match zoom::step(&directory, step) {
        Ok(level) => level,
        Err(error) => {
            log::warn!("[zoom] could not keep the zoom level: {error}");
            zoom::next(zoom::saved(&directory), step)
        }
    };
    for window in app.webview_windows().values() {
        let _ = window.set_zoom(level);
    }
    log::info!("[zoom] {}%", (level * 100.0).round());
}

/// The zoom level kept from the last launch (`zoom`), for a window's page as it is built and loads.
fn saved_zoom<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> f64 {
    app.path()
        .app_config_dir()
        .map(|directory| zoom::saved(&directory))
        .unwrap_or(zoom::ACTUAL_SIZE)
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
The version this build was packaged as, which the installer, the system's list of apps and the
update check all name: `0.3.4-internal.892.g0c140734ecf0` for an internal build after 0.3.3, and
exactly `0.3.3` for that release. The Status window, Settings → This computer, About and the log
say this one too.

Not `CARGO_PKG_VERSION`: Cargo.toml always names the last release, and an internal build's own
version is set only in the Tauri configuration it is built with (`desktop-version.ts internal`
writes `tauri.build-version.conf.json`). Reading Cargo's, an internal build after 0.3.3 called
itself 0.3.3 while Windows called it 0.3.4-internal.
*/
fn desktop_version<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    app.package_info().version.to_string()
}

/**
What About OpenBot says: the version, and which build this is.

The build is the commit it was built from, marked `-dirty` when the tree had uncommitted changes,
and when; see `build_identity` in build.rs. macOS shows the version and the build on one line and
the credits under them; Windows and Linux show the comments.
*/
fn about_openbot(version: String) -> tauri::menu::AboutMetadata<'static> {
    let built = build_description(
        env!("OPENBOT_BUILD_COMMIT"),
        env!("OPENBOT_BUILD_BRANCH"),
        env!("OPENBOT_BUILD_TIME").parse().unwrap_or_default(),
    );
    tauri::menu::AboutMetadata {
        name: Some("OpenBot".into()),
        short_version: Some(version),
        version: Some(env!("OPENBOT_BUILD_COMMIT").into()),
        credits: Some(built.clone()),
        comments: Some(built),
        ..Default::default()
    }
}

/// The first entry of each launch in the log file: which build, on what, where the log's UTC times
/// stand against the person's clock, and where the file is.
fn log_launch<R: tauri::Runtime>(app: &tauri::AppHandle<R>, local_offset: Option<time::UtcOffset>) {
    let local = local_offset.map_or_else(
        || "unknown".to_owned(),
        |offset| {
            let (hours, minutes, _) = offset.as_hms();
            format!(
                "UTC{}{:02}:{:02}",
                if offset.is_negative() { '-' } else { '+' },
                hours.unsigned_abs(),
                minutes.unsigned_abs()
            )
        },
    );
    let folder = logging::folder(app)
        .map(|folder| folder.display().to_string())
        .unwrap_or_else(|error| format!("unknown ({error})"));
    log::info!(
        "[launch] OpenBot Desktop {} ({}) on {} {}; local time is {local}; logs in {folder}",
        desktop_version(app),
        build_description(
            env!("OPENBOT_BUILD_COMMIT"),
            env!("OPENBOT_BUILD_BRANCH"),
            env!("OPENBOT_BUILD_TIME").parse().unwrap_or_default(),
        ),
        std::env::consts::OS,
        std::env::consts::ARCH,
    );
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

/// The menu item that saves the troubleshooting logs and shows the file, in the tray and the
/// window's menu alike.
const TROUBLESHOOTING_MENU_LABEL: &str = "Get Troubleshooting Logs…";

/**
The tray menu and the window's menu bar.

Built again whenever the state or the appearance changes, because a menu item cannot be changed
in place on every platform.
*/
fn install_menus<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    use tauri::menu::{IconMenuItem, Menu, MenuItem, NativeIcon, PredefinedMenuItem, Submenu};

    // The menu bar menu follows the system's appearance; its icons are drawn for each.
    let dark = system_is_dark(app);
    let running = app.state::<Shell>().root.lock().unwrap().is_some();
    // Check for Updates… only in a build offered updates: anywhere else it could only say no.
    let updates = app_update_feed(app).is_some();
    let check_for_updates = || {
        MenuItem::with_id(
            app,
            app_update::MENU_ID,
            app_update::MENU_LABEL,
            true,
            None::<&str>,
        )
        .map(MenuEntry::Plain)
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
        entries.push(MenuEntry::Icon(IconMenuItem::with_id(
            app,
            "status",
            "Status…",
            true,
            icon("status"),
            None::<&str>,
        )?));
        entries.push(MenuEntry::Plain(MenuItem::with_id(
            app,
            "logs",
            TROUBLESHOOTING_MENU_LABEL,
            true,
            None::<&str>,
        )?));
        entries.push(MenuEntry::Native(PredefinedMenuItem::separator(app)?));
        entries.push(MenuEntry::Native(PredefinedMenuItem::about(
            app,
            Some("About"),
            Some(about_openbot(desktop_version(app))),
        )?));
        if updates {
            entries.push(check_for_updates()?);
        }
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
        let mut entries = vec![MenuEntry::Native(PredefinedMenuItem::about(
            app,
            Some("About OpenBot"),
            Some(about_openbot(desktop_version(app))),
        )?)];
        // Where every Mac app keeps it: under About.
        if updates {
            entries.push(check_for_updates()?);
        }
        entries.push(MenuEntry::Native(PredefinedMenuItem::separator(app)?));
        entries.push(MenuEntry::Plain(MenuItem::with_id(
            app,
            "open",
            "Show Window",
            true,
            None::<&str>,
        )?));
        entries.push(MenuEntry::Plain(MenuItem::with_id(
            app,
            "status",
            "Status…",
            true,
            None::<&str>,
        )?));
        entries.push(MenuEntry::Plain(MenuItem::with_id(
            app,
            "logs",
            TROUBLESHOOTING_MENU_LABEL,
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

    /*
     * No menu bar on Windows. Windows draws it as a white strip of its own that no colour reaches,
     * between a title bar tinted to the page and the page itself. Nothing is lost: the Edit menu is
     * there for macOS, which routes Command-V through the menu bar, while WebView2 handles Ctrl+V
     * itself; and the OpenBot menu's items are in the tray and in Settings → This computer.
     */
    if cfg!(target_os = "windows") {
        return Ok(());
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
    /*
     * A VIEW MENU, FOR THE TEXT THAT WAS TOO SMALL.
     *
     * The page zooms as a browser's does, in the order and with the keys a Mac's View menu has
     * them. Items of our own, not the predefined zoom items: those ask the first responder, and a
     * web view has no zoom of its own to answer them. See `zoom`.
     */
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(
                app,
                zoom::MENU_ACTUAL_SIZE,
                "Actual Size",
                true,
                Some("CmdOrCtrl+0"),
            )?,
            &MenuItem::with_id(app, zoom::MENU_IN, "Zoom In", true, Some("CmdOrCtrl+="))?,
            &MenuItem::with_id(app, zoom::MENU_OUT, "Zoom Out", true, Some("CmdOrCtrl+-"))?,
        ],
    )?;
    app.set_menu(Menu::with_items(app, &[&openbot, &edit, &view])?)?;
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

/// Rebuild both menus on the main thread, for a new state or appearance.
fn refresh_menus<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    // The mock runtime runs "main thread" work on a worker, where AppKit menus panic. The menus
    // are not what the tests that start and stop a stack are about.
    if cfg!(test) {
        return;
    }
    let menus_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(error) = install_menus(&menus_app) {
            log::warn!("[menu] could not update the menus: {error}");
        }
    });
}

fn quit_menu_accelerator() -> Option<&'static str> {
    Some(QUIT_MENU_ACCELERATOR)
}

/// The Recorder host install's real side effects on this computer.
struct RecorderInstallWriter;

impl recorder_install::InstallWriter for RecorderInstallWriter {
    fn write_file(&mut self, path: &Path, contents: &str) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, contents)
    }

    fn read_file(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }

    fn remove_file(&mut self, path: &Path) -> std::io::Result<()> {
        match std::fs::remove_file(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            done => done,
        }
    }

    // Output is captured, never inherited: `reg.exe` prints a success line, and the install command's
    // own output is only the manifest paths.
    fn run(&mut self, argv: &[String]) -> std::io::Result<()> {
        // The registry is the developer's own, whatever folder a test points the install at.
        if cfg!(debug_assertions) {
            return Err(std::io::Error::other(
                "a debug build never writes the Windows registry",
            ));
        }
        let (program, arguments) = argv
            .split_first()
            .ok_or_else(|| std::io::Error::other("an empty command"))?;
        let output = quiet::command(program)
            .args(arguments)
            .stdin(std::process::Stdio::null())
            .output()?;
        if output.status.success() {
            return Ok(());
        }
        Err(std::io::Error::other(format!(
            "{program} exited with {}: {}",
            output.status,
            quiet::said(&output.stderr)
        )))
    }

    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }
}

fn recorder_os() -> recorder_install::Os {
    if cfg!(windows) {
        recorder_install::Os::Windows
    } else if cfg!(target_os = "macos") {
        recorder_install::Os::Mac
    } else {
        recorder_install::Os::Linux
    }
}

/// The person's home folder, read as `stack.rs` reads it.
fn recorder_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

/// The variable a debug build's Recorder host install reads its home folder from.
const RECORDER_HOST_TEST_HOME: &str = "OPENBOT_RECORDER_HOST_TEST_HOME";

fn non_empty_var(name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(name).filter(|value| !value.is_empty())
}

/// Lets each browser's Recorder find this app (one host manifest per browser present for this user), and registers the
/// Recorder from its stores with this person's Chrome and Edge once it is published there (`recorder_external`).
/// Returns the files in place.
///
/// A release build writes into this person's own browser folders. A debug build is a developer's binary, rebuilt on
/// every change, and must never be registered as the host in the developer's own browsers, so it writes only under
/// the folder `OPENBOT_RECORDER_HOST_TEST_HOME` names (a test's), takes every other folder from there too, never
/// writes the Windows registry, and without the variable writes nothing.
///
/// One round at a time: the launch's rounds and a Start's may overlap, and both read and write Desktop's note of what
/// it registered.
fn install_recorder_host_for_this_user() -> Result<Vec<PathBuf>, Problem> {
    static ONE_ROUND: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _round = ONE_ROUND
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let current_exe = std::env::current_exe().map_err(|error| {
        Problem::with(
            "OpenBot Desktop could not set up the Recorder.",
            error.to_string(),
        )
    })?;
    let stable = recorder_install::stable_host_path(
        recorder_os(),
        &current_exe,
        std::env::var_os("APPIMAGE").as_deref().map(Path::new),
    )?;
    let (home, xdg_config_home, chrome_config_home, local_app_data) = if cfg!(debug_assertions) {
        let home = non_empty_var(RECORDER_HOST_TEST_HOME)
            .map(PathBuf::from)
            .ok_or_else(|| {
                Problem::plain(format!(
                    "A debug build sets up the Recorder only under {RECORDER_HOST_TEST_HOME}, never in your own browsers."
                ))
            })?;
        (home, None, None, None)
    } else {
        let home = recorder_home()
            .ok_or_else(|| Problem::plain("OpenBot Desktop could not find your home folder."))?;
        (
            home,
            non_empty_var("XDG_CONFIG_HOME").map(PathBuf::from),
            non_empty_var("CHROME_CONFIG_HOME").map(PathBuf::from),
            non_empty_var("LOCALAPPDATA").map(PathBuf::from),
        )
    };
    let dirs = recorder_install::UserDirs {
        home: &home,
        xdg_config_home: xdg_config_home.as_deref(),
        chrome_config_home: chrome_config_home.as_deref(),
        local_app_data: local_app_data.as_deref(),
    };
    // Both run, whatever became of the other: a browser that cannot take the Recorder's entry still gets its host,
    // and the other way round.
    let hosts = recorder_install::install(&stable, dirs, recorder_os(), &mut RecorderInstallWriter);
    let entries = recorder_external::register(
        dirs,
        recorder_os(),
        recorder_install::store_ids(),
        &mut RecorderInstallWriter,
    );
    let mut in_place = hosts?;
    in_place.extend(entries?);
    Ok(in_place)
}

/// The install at launch, on its own thread so setup never waits on it, and again every minute where a browser
/// installed since needs its own manifest. Never in a debug build (see `install_recorder_host_for_this_user`).
#[cfg(not(debug_assertions))]
fn keep_recorder_host_installed() -> Option<std::thread::JoinHandle<()>> {
    Some(recorder_install::keep_recorder_host_installed(
        install_recorder_host_for_this_user,
        recorder_install::recheck_interval(recorder_os()),
    ))
}

#[cfg(debug_assertions)]
fn keep_recorder_host_installed() -> Option<std::thread::JoinHandle<()>> {
    None
}

/// The same install once more at every Start, on its own thread so the Start never waits on it: a version that brought
/// a store id registers the Recorder then, on Windows too, where the launch's round is the only other. Never in a debug
/// build.
#[cfg(not(debug_assertions))]
fn install_recorder_host_at_start() -> Option<std::thread::JoinHandle<()>> {
    Some(recorder_install::keep_recorder_host_installed(
        install_recorder_host_for_this_user,
        None,
    ))
}

#[cfg(debug_assertions)]
fn install_recorder_host_at_start() -> Option<std::thread::JoinHandle<()>> {
    None
}

fn main() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    // Windows opening a notification's link: pass the foreground on, before the single-instance plugin
    // hands the link to the OpenBot already running and this launch exits. See `notice.rs`.
    #[cfg(windows)]
    if notice::launched_by_link(args.iter().map(|arg| arg.to_string_lossy().into_owned())) {
        notice::let_running_openbot_come_forward();
    }
    // Chrome, Edge or Chromium starting the Recorder's native messaging host: answer it and exit, before
    // anything of the app (the single-instance plugin would forward this launch to a running app).
    if let Some(origin) = recorder_host::caller_origin(&args) {
        std::process::exit(recorder_host::run(&origin, recorder_host_environment()));
    }
    // The same install the app's setup runs, as a command, so it can be tested and run by hand.
    if args.get(1).is_some_and(|a| a == "--install-recorder-host") {
        std::process::exit(match install_recorder_host_for_this_user() {
            Ok(paths) => {
                for p in paths {
                    println!("{}", p.display());
                }
                0
            }
            Err(problem) => {
                eprintln!("{}", problem.said);
                if let Some(detail) = problem.detail {
                    eprintln!("{detail}");
                }
                1
            }
        });
    }
    // The local time's offset from UTC, for the log's first line. Read now, while this is the only
    // thread: on macOS and Linux the time crate refuses to read it once there are others.
    let local_offset = time::UtcOffset::current_local_offset().ok();
    let context = tauri::generate_context!();
    // A `shell-updater` build with compiled trust supplies `plugins.updater` when no bundled block
    // (such as the signed Mac overlay) already does. Registration itself happens once, in `setup`.
    #[cfg(feature = "shell-updater")]
    let context = {
        let mut context = context;
        use openbot_desktop_lib::shell_updates;
        shell_updates::configure_plugin(
            &mut context.config_mut().plugins,
            shell_updates::compiled_trust().ok().flatten().as_ref(),
        );
        context
    };
    tauri::Builder::default()
        // A second launch is somebody looking for the window they already have, not a request for a
        // second stack. Without this both copies bind the same ports and the loser reports a
        // failure that belongs to the winner.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            restore_after_second_instance(app);
        }))
        // The `openbot://` links a click on a Windows notification opens. Right after the
        // single-instance plugin, whose `deep-link` feature hands it a second launch's link.
        .plugin(tauri_plugin_deep_link::init())
        // The log file, before anything that logs. After the single-instance plugin, so a second
        // launch, which that plugin ends, never opens (or rotates) the file the first one writes.
        .plugin(logging::plugin())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // A reopened window comes back with the size and place it had, not where Windows puts a
        // new one. `fit_main_window_to_screen` then brings it onto a screen that is still there.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(intelligence_bridge::plugin())
        .plugin(desktop_page::plugin())
        .plugin(outside_links_guard())
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![
            back_end_wait_ended,
            start_early_downloads,
            early_downloads_now,
            record_setup_event,
            bring_setup_to_front,
            allow_podman_install,
            allow_pause_podman,
            wake_engine,
            detect_engine,
            windows_blocker,
            windows_blocker_instruction,
            windows_fix,
            windows_restart_pending,
            windows_restart,
            prepare_engine,
            prepare_installation,
            check_app_update,
            app_update_offer,
            dismiss_app_update,
            install_app_update,
            upgrade_due,
            upgrade_and_start,
            start_stack,
            reset_leftover_database,
            stop_stack,
            show_openbot,
            show_setup,
            already_running,
            last_failure,
            take_ai_connection_change,
            default_root,
            selected_root,
            providers,
            already_configured,
            begin_claude_sign_in,
            finish_claude_sign_in,
            begin_chatgpt_sign_in,
            begin_model_oauth,
            finish_model_oauth,
            cancel_model_oauth,
            finish_chatgpt_sign_in,
            cancel_chatgpt_sign_in,
            run_local_eval,
            list_local_eval,
            cancel_local_eval,
            offer_local_intelligence,
            set_up_local_eval,
            sign_in_to_copilotkit,
            copilotkit_sign_in_page,
            local_eval_download,
            local_eval_steps,
            local_eval_update_step,
            setup_heartbeat,
            local_eval_terms,
            connect_copilotkit_apps,
            connect_local_eval,
            last_local_eval_stop_failure,
            quit_status,
            desktop_status,
            restart_openbot,
            stop_openbot_from_status,
            open_log_folder,
            troubleshooting_logs,
            save_troubleshooting_logs,
        ])
        // A packaged application is not a browser tab. Left alone, WebView2 answers a right-click
        // with Back, Refresh, Save as and Print: Back walks the window out of OpenBot with nothing
        // to walk it home, and Save as offers to write the page to disk as `Webpage, complete`.
        // macOS never showed this because Tauri suppresses it there in release builds; Windows has
        // no such setting, and Tauri has no configuration option for it either, so the page is
        // asked to refuse. Every navigation, because the window navigates to OpenBot and back.
        .on_page_load(|window, payload| {
            // A new page in the main window is not the setup page until it sends a heartbeat.
            if window.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started
            {
                desktop_stall::page_loaded(window);
            }
            let _ = window
                .eval("document.addEventListener('contextmenu', e => e.preventDefault(), true)");
            let page = window_page(window.app_handle(), payload.url());
            match_title_bar(&window.window(), page);
            // The level kept from the last launch, on every page this window loads (`zoom`).
            let _ = window.set_zoom(saved_zoom(window.app_handle()));
            if matches!(page, WindowPage::OwnedApp | WindowPage::LocalApp) {
                let _ = window.eval(outside_links::PAGE);
            }
            // Ctrl+Q quits, as the tray says. Windows only: no menu there carries the shortcut.
            if cfg!(target_os = "windows") && page != WindowPage::Other {
                let _ = window.eval(desktop_page::QUIT_SHORTCUT_PAGE);
            }
            // A browser's zoom keys: all of them on Windows, and on macOS the one the View menu
            // never receives, Command and +.
            if cfg!(any(target_os = "windows", target_os = "macos")) && page != WindowPage::Other {
                let _ = window.eval(zoom::shortcut_page());
            }
            if matches!(page, WindowPage::OwnedApp | WindowPage::LocalApp)
                && payload.event() == tauri::webview::PageLoadEvent::Finished
            {
                allow_app_page(window.app_handle(), payload.url());
                open_waiting_notice_page(window, payload.url());
                // macOS draws the window's outline from it; Windows tints the title bar with it.
                if cfg!(any(target_os = "macos", target_os = "windows")) {
                    let _ = window.eval(APP_THEME_PAGE);
                }
                if cfg!(target_os = "macos") && page == WindowPage::OwnedApp {
                    let _ = window.eval(OVERLAY_TITLE_BAR_PAGE);
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
        .setup(move |app| {
            build_main_window(app.handle())?;
            log_launch(app.handle(), local_offset);
            // Built by `generate_context!`, so the permissions OpenBot's page is granted are
            // compiled in. First, before anything that could trust an app and open it.
            know_app_page_grants(app.handle());
            {
                use tauri_plugin_notification::NotificationExt;
                let handle = app.handle().clone();
                app.notification()
                    .on_action(move |performed| open_from_notification(&handle, performed))?;
            }
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for link in event.urls() {
                        open_from_link(&handle, &link);
                    }
                });
                // OpenBot started by a click on a notification: its page, once OpenBot shows.
                if let Ok(Some(links)) = app.deep_link().get_current() {
                    for link in links {
                        if let Some(path) = notice::path_of(&link) {
                            *app.state::<Shell>().waiting_notice_page.lock().unwrap() = Some(path);
                        }
                    }
                }
            }
            // A signed Mac or Windows build updates itself. The window asks once at launch and
            // installs only if the person says yes; the plugin refuses anything whose minisign
            // signature does not match the public key compiled in from the signing overlay
            // (`tauri.macos-signing.conf.json`, `tauri.windows-signing.conf.json`), so the
            // endpoint is a place to look rather than something to trust. Only those overlays carry
            // `plugins.updater`, so every other build (desktop CI, local, the unsigned release
            // installers) has no updater: it cannot verify anything, and offering an update it
            // would then refuse is worse than offering none. The window's check finds no plugin
            // and stays silent. A `shell-updater` build may also have filled the block in from its
            // compiled trust before the app was built (see above); either way the block decides,
            // and this is the one place the plugin is registered.
            if app.config().plugins.0.contains_key("updater") {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            } else {
                log::info!("[updater] not configured in this build; no update check");
            }
            // The banner and the setup window's offer both read this, never the network.
            watch_for_app_updates(app.handle());
            get_updates_ready(app.handle());
            desktop_telemetry::initialize(app.handle());
            desktop_stall::initialize(app.handle());
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
            // Where OpenBot's own Docker configuration lives, the one without the person's
            // credential helper (see `docker_config`). Before anything runs a container command.
            if let Ok(data) = app.path().app_local_data_dir() {
                docker_config::lives_in(data.join("docker-config"));
                // The registry mirror k3d writes into a new back end node (`local_images::Mirror`).
                openbot_desktop_lib::local_images::registries_file_lives_at(
                    data.join("registries.yaml"),
                );
            }

            remember_setup_url(app.handle())?;
            if let Some(main) = app.get_webview_window("main") {
                match_title_bar(&main.as_ref().window(), WindowPage::Setup);
            }
            fit_main_window_to_screen(app.handle());
            // Built by `generate_context!`, so the bridge plugin's permissions are compiled in.
            intelligence_bridge::enable(app.handle());

            // On its own thread: setup never waits on it, and a failure is logged.
            keep_recorder_host_installed();

            // The status menu lets somebody open the window, stop the stack, or quit the app.
            tauri::tray::TrayIconBuilder::with_id("openbot")
                .icon(tray::icon())
                .icon_as_template(false)
                .tooltip("OpenBot")
                .build(app)?;
            install_menus(app.handle())?;
            app.on_menu_event(|app, event| chose(app, event.id().as_ref()));
            #[cfg(target_os = "macos")]
            macos_quit::install(app.handle());
            if let Some(address) = desktop_test_app_url() {
                show_test_app(app.handle(), &address);
            }
            Ok(())
        })
        .build(context)
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
                                    log::error!("[quit] {failure}");
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
                        log::error!("[exit] could not start cleanup: {error}");
                        report_plain(
                            app,
                            "quit",
                            false,
                            "OpenBot couldn't start shutting down. Try Quit again.",
                        );
                    }
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod background_launch_tests {
    use tauri::utils::config::BackgroundThrottlingPolicy;

    /// OpenBot that opens at login, or that somebody launches and switches away from, starts with
    /// its window behind other windows. WebKit counts an occluded window's page as not visible,
    /// and its default inactive policy (`WKInactiveSchedulingPolicySuspend`) lets RunningBoard
    /// suspend the page's web content process. The setup page then never loads, its JavaScript
    /// never runs, and nothing starts until the window is brought forward: a blank white window
    /// that runs nothing. A page already running goes blank the same way once it has sat hidden
    /// long enough to be suspended. The window's configuration, as compiled into the app, must keep
    /// the page running while nobody is looking at it.
    #[test]
    fn main_window_page_keeps_running_while_the_window_is_hidden_or_covered() {
        let context: tauri::Context<tauri::test::MockRuntime> =
            tauri::generate_context!(test = true);
        let main = context
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .expect("tauri.conf.json declares the main window");
        assert_eq!(
            main.background_throttling,
            Some(BackgroundThrottlingPolicy::Disabled),
        );
    }

    /// A screenshot dragged onto a conversation attached nothing: the cursor showed a plus, the
    /// drop vanished, and the Bot never saw the image. Tauri's own drag-and-drop handler, on by
    /// default, takes every file dropped on the window to raise its `DragDropEvent`s (on macOS it
    /// answers WebKit's dragging calls itself and never passes them on; on Windows it replaces
    /// WebView2's drop target), so the page's HTML `drop` never fires and the composer never sees
    /// the file. Nothing in this app listens for those events; the page handles drops itself, as it
    /// does in a browser. The window's configuration, as compiled into the app, must leave them to it.
    #[test]
    fn main_window_leaves_dropped_files_to_the_page() {
        let context: tauri::Context<tauri::test::MockRuntime> =
            tauri::generate_context!(test = true);
        let main = context
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .expect("tauri.conf.json declares the main window");
        assert!(
            !main.drag_drop_enabled,
            "Tauri's drag-and-drop handler is on, so a file dropped on the composer never reaches it"
        );
    }
}

#[cfg(test)]
mod check_for_updates_tests {
    use super::*;
    use tauri::test::MockRuntime;

    /// A feed on 127.0.0.1 that answers every read with a release at `version` for this machine.
    fn feed_at(version: &str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://127.0.0.1:{}/latest/latest.json",
            listener.local_addr().unwrap().port()
        );
        let mut platforms = serde_json::Map::new();
        platforms.insert(
            app_update::platform().unwrap(),
            serde_json::json!({
                "url": "https://downloads.copilotkit.ai/OpenBot.tar.gz",
                "signature": "signed"
            }),
        );
        let body = serde_json::json!({ "version": version, "platforms": platforms }).to_string();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut request = [0u8; 4096];
                let _ = std::io::Read::read(&mut stream, &mut request);
                let _ = std::io::Write::write_all(
                    &mut stream,
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                );
            }
        });
        url
    }

    /// An app configured as a signed release is (`tauri.windows-signing.conf.json`'s updater block),
    /// its feed read from `feed`; with no feed, a build without the updater, as internal builds are.
    fn app(feed: Option<&str>) -> (tauri::App<MockRuntime>, tauri::WebviewWindow<MockRuntime>) {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        if let Some(feed) = feed {
            let overlay: serde_json::Value =
                serde_json::from_str(include_str!("../tauri.windows-signing.conf.json")).unwrap();
            let mut updater = overlay["plugins"]["updater"].clone();
            updater["endpoints"] = serde_json::json!([feed]);
            updater["dangerousInsecureTransportProtocol"] = true.into();
            context
                .config_mut()
                .plugins
                .0
                .insert("updater".into(), updater);
        }
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .invoke_handler(tauri::generate_handler![check_app_update])
            .build(context)
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        (app, window)
    }

    fn check(
        window: &tauri::WebviewWindow<MockRuntime>,
    ) -> Result<serde_json::Value, serde_json::Value> {
        tauri::test::get_ipc_response(
            window,
            tauri::webview::InvokeRequest {
                cmd: "check_app_update".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize().unwrap())
    }

    /// The test feed reaches only an internal build, through the start the app itself makes: a
    /// stable build started with `OPENBOT_TEST_UPDATE_FEED` set is offered nothing from it, and an
    /// internal build started the same way is offered what it names.
    #[test]
    fn only_an_internal_build_is_offered_what_the_test_feed_names() {
        let folder = crate::test_support::temp_root("test-feed-wiring");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("latest.json"), r#"{"version": "9.9.9"}"#).unwrap();
        std::env::set_var(app_update::TEST_FEED, &folder);
        let started = |version: &str| {
            let mut context = tauri::test::mock_context(tauri::test::noop_assets());
            context.package_info_mut().version = semver::Version::parse(version).unwrap();
            let app = tauri::test::mock_builder()
                .manage(Shell::default())
                .build(context)
                .unwrap();
            watch_for_app_updates(app.handle());
            app
        };
        let stable = started("1.0.1");
        let candidate = started("1.0.1-rc.2");
        let internal = started("1.0.1-internal.731.gabc123456789");
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while internal.state::<Shell>().app_update.newer().is_none() {
            assert!(
                std::time::Instant::now() < until,
                "the internal build read its test feed"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        std::env::remove_var(app_update::TEST_FEED);
        assert_eq!(
            internal.state::<Shell>().app_update.newer(),
            Some(semver::Version::parse("9.9.9").unwrap())
        );
        assert_eq!(stable.state::<Shell>().app_update.newer(), None);
        assert_eq!(candidate.state::<Shell>().app_update.newer(), None);
        assert_eq!(app_update_status(stable.handle()).version, None);
        std::fs::remove_dir_all(folder).unwrap();
    }

    /// The bug: on a signed 0.3.2, the setup window's Check desktop shell update asked an old
    /// mechanism release builds do not carry, and said "Signed desktop shell updates are not
    /// configured." A release build now answers from the feed its updater installs from.
    #[test]
    fn a_release_build_answers_check_for_updates_from_its_update_feed() {
        let (_app, window) = app(Some(&feed_at("0.1.0")));
        assert_eq!(
            check(&window),
            Ok(serde_json::json!({ "found": "upToDate", "current": "0.1.0" }))
        );
        let (app, window) = app(Some(&feed_at("0.3.3")));
        assert_eq!(
            check(&window),
            Ok(
                serde_json::json!({ "found": "available", "version": "0.3.3", "current": "0.1.0", "ready": null })
            )
        );
        // Kept, so the banner offers the same version.
        assert_eq!(
            app_update_status(app.handle()).version.as_deref(),
            Some("0.3.3")
        );
    }

    #[test]
    fn a_build_without_the_updater_says_it_does_not_update_itself() {
        let (_app, window) = app(None);
        assert_eq!(
            check(&window),
            Ok(serde_json::json!({ "found": "notOffered", "current": "0.1.0" }))
        );
    }

    #[test]
    fn a_feed_that_cannot_be_read_is_said_in_a_sentence() {
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let feed = format!("http://{}/latest.json", closed.local_addr().unwrap());
        drop(closed);
        let (_app, window) = app(Some(&feed));
        let failure = check(&window).unwrap_err();
        assert_eq!(
            failure["said"],
            "OpenBot couldn't check for updates. Check your internet connection and try again."
        );
        assert!(failure["detail"].as_str().is_some_and(|d| !d.is_empty()));
    }

    /// One way to ask, in every place OpenBot offers it: the windows' command is the feed's, the old
    /// shell update commands are gone, and both menus carry Check for Updates…, which the menu
    /// handler routes to the same check. AppKit menus cannot be built under the mock runtime (see
    /// `refresh_menus`), so this reads the shell's own wiring.
    #[test]
    fn every_way_to_ask_for_an_update_reads_the_update_feed() {
        let main = include_str!("main.rs");
        let handler = &main[main.find("\nfn main() {").unwrap()..];
        let handler = &handler[handler.find(".invoke_handler(").unwrap()..];
        let handler = &handler[..handler.find("])").unwrap()];
        assert!(handler.contains("check_app_update,"));
        for gone in ["check_shell", "apply_shell"] {
            assert!(!main.contains(&format!("{gone}_update")), "{gone}_update");
        }
        let menus = &main[main.find("fn install_menus").unwrap()..];
        let menus = &menus[..menus.find("app.set_menu(").unwrap()];
        assert_eq!(
            menus.matches("entries.push(check_for_updates()?);").count(),
            2
        );
        assert!(main.contains("app_update::MENU_ID => check_for_updates_from_menu(app.clone()),"));
    }

    /// Check for Updates…'s answers carry OpenBot's icon on the Mac. The dialog plugin shows a
    /// message with no parent window through `CFUserNotificationDisplayAlert`, which draws the
    /// system's grey note icon, so on macOS `show_prompt` runs OpenBot's own alert
    /// (`native_alert`, tested in `tests/native_alert.rs`) and leaves the plugin to the others.
    #[test]
    fn the_update_answers_show_openbots_icon_on_the_mac() {
        let main = include_str!("main.rs");
        let shown = &main[main.find("\nfn show_prompt(").unwrap()..];
        let shown = &shown[..shown.find("\n}\n").unwrap()];
        let mac = &shown[shown.find("#[cfg(target_os = \"macos\")]").unwrap()..];
        let mac = &mac[..mac.find("#[cfg(not(target_os = \"macos\"))]").unwrap()];
        assert!(mac.contains("native_alert::ask("));
        assert!(!mac.contains(".dialog()"));
        for asked in [
            "show_prompt(&app, app_update::prompt(&asked)",
            "show_prompt(\n",
        ] {
            assert!(main.contains(asked), "{asked}");
        }
    }
}

/// The update's download through the real updater plugin: its builder, `check` and `download`,
/// signature verification included, against feeds on 127.0.0.1.
#[cfg(test)]
mod update_download_fallback_tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A test signing key's public half, as `tauri signer generate` writes it. Its secret half was
    /// used once, to sign `PACKAGE`, and is kept nowhere.
    const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ3ODJGM0QyNDNFRTk4QUYKUldTdm1PNUQwdk9DUjJWTWEyaHJFWjNkck9KK0N6emtZcmVZVDIxTm1UaGhPNy9YRmMyYTRQRVgK";
    const PACKAGE: &[u8] = b"OpenBot update fallback test package\n";
    /// `tauri signer sign` of `PACKAGE` with that key.
    const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTdm1PNUQwdk9DUjBYZFFYWnQrWVZDMXNqbjY1TEdsQ0xDNHhjUnZvdEl4L2RaSEgwbVdadEpEVHcxYUVXb0lseG1mYkpQc2xjQzNydWxOS0JGcjBsRGh0NzUrTzI2ZEFVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0MTgwNDYzCWZpbGU6cGF5bG9hZC5iaW4KaFF5azhkUzRYNW1LWk1SRW5YRk53SVVyTXlUbmdoOXFYMmVYa3FEangwRzF3d08zWTc0dDg4alBOTmVMZ2Vid0dheldNRzVRRFB3UDJRRDB3TVBpQkE9PQo=";

    /// A server on 127.0.0.1 answering each path in `routes` with its body, and 404 for any other,
    /// as a bucket answers for a key it does not have. Its address, and every path it was asked.
    fn serve(
        routes: impl Fn(&str) -> Option<Vec<u8>> + Send + 'static,
    ) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let asked = Arc::new(Mutex::new(Vec::new()));
        let seen = asked.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut request = [0u8; 8192];
                let read = std::io::Read::read(&mut stream, &mut request).unwrap_or(0);
                let head = String::from_utf8_lossy(&request[..read]).into_owned();
                let path = head
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_owned();
                seen.lock().unwrap().push(path.clone());
                let (status, body) = match routes(&path) {
                    Some(body) => ("200 OK", body),
                    None => ("404 Not Found", b"missing".to_vec()),
                };
                let _ = std::io::Write::write_all(
                    &mut stream,
                    format!(
                        "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                );
                let _ = std::io::Write::write_all(&mut stream, &body);
            }
        });
        (base, asked)
    }

    /// A feed offering 99.0.0 for this machine, its archive at `url`.
    fn feed(url: &str) -> Vec<u8> {
        let mut platforms = serde_json::Map::new();
        platforms.insert(
            app_update::platform().unwrap(),
            serde_json::json!({ "url": url, "signature": SIGNATURE }),
        );
        serde_json::json!({ "version": "99.0.0", "platforms": platforms })
            .to_string()
            .into_bytes()
    }

    /// Every line logged, kept for the test to read.
    static LOGGED: Mutex<Vec<String>> = Mutex::new(Vec::new());
    struct Keep;
    impl log::Log for Keep {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }
        fn log(&self, record: &log::Record) {
            LOGGED.lock().unwrap().push(record.args().to_string());
        }
        fn flush(&self) {}
    }

    /**
    The mirror's feed names the mirror's copy of the archive, and the mirror does not have it. The
    updater would not move on to GitHub's feed for that, since only reading a feed moves it on, and
    the update failed until the mirror was fixed. Now the archive GitHub's feed names is downloaded
    once, verified against the configured key, and the log says where it came from.
    */
    #[test]
    fn a_download_the_mirror_cannot_give_comes_from_githubs_feed() {
        if test_support::isolated_process(
            "update_download_fallback_tests::a_download_the_mirror_cannot_give_comes_from_githubs_feed",
        ) {
            return;
        }
        log::set_boxed_logger(Box::new(Keep)).unwrap();
        log::set_max_level(log::LevelFilter::Info);
        let mirror_archive = Arc::new(Mutex::new(String::new()));
        let mirror_feed = mirror_archive.clone();
        let (mirror, mirror_asked) = serve(move |path| {
            (path == "/latest/latest.json").then(|| feed(&mirror_feed.lock().unwrap()))
        });
        *mirror_archive.lock().unwrap() = format!("{mirror}/releases/v99.0.0/OpenBot.app.tar.gz");
        let github_archive = Arc::new(Mutex::new(String::new()));
        let github_feed = github_archive.clone();
        let (github, github_asked) = serve(move |path| match path {
            "/releases/latest/download/latest.json" => Some(feed(&github_feed.lock().unwrap())),
            "/releases/download/v99.0.0/OpenBot.app.tar.gz" => Some(PACKAGE.to_vec()),
            _ => None,
        });
        *github_archive.lock().unwrap() =
            format!("{github}/releases/download/v99.0.0/OpenBot.app.tar.gz");

        // Configured as a signed release is, with the test key and these two feeds in its order.
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "pubkey": PUBKEY,
                "endpoints": [
                    format!("{mirror}/latest/latest.json"),
                    format!("{github}/releases/latest/download/latest.json"),
                ],
                "dangerousInsecureTransportProtocol": true,
            }),
        );
        // The plugin as `main` registers it, on a test app (`shell_updates` counts the one
        // registration in the real app by its spelling, so this one is spelled differently).
        use tauri_plugin_updater as updater_plugin;
        let app = tauri::test::mock_builder()
            .plugin(updater_plugin::Builder::new().build())
            .build(context)
            .unwrap();
        let feeds = app_update::endpoints(app.config().plugins.0.get("updater")).unwrap();
        let begun = std::sync::atomic::AtomicUsize::new(0);
        let received = std::sync::atomic::AtomicUsize::new(0);
        let (update, bytes) = tauri::async_runtime::block_on(download_app_update(
            &feeds,
            |feed| {
                use tauri_plugin_updater::UpdaterExt;
                let mut builder = app.updater_builder().on_before_exit(|| {});
                if let Some(feed) = feed {
                    builder = builder.endpoints(vec![feed])?;
                }
                builder.build()
            },
            || {
                begun.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            },
            |chunk, _| {
                received.fetch_add(chunk, std::sync::atomic::Ordering::SeqCst);
            },
        ))
        .expect("the update downloads from GitHub's feed");

        assert_eq!(bytes, PACKAGE);
        assert_eq!(update.version, "99.0.0");
        assert_eq!(
            update.download_url.as_str(),
            github_archive.lock().unwrap().as_str()
        );
        assert_eq!(
            *mirror_asked.lock().unwrap(),
            [
                "/latest/latest.json",
                "/releases/v99.0.0/OpenBot.app.tar.gz"
            ],
            "the mirror's feed was read and its archive asked for once"
        );
        assert_eq!(
            *github_asked.lock().unwrap(),
            [
                "/releases/latest/download/latest.json",
                "/releases/download/v99.0.0/OpenBot.app.tar.gz"
            ],
            "GitHub's archive was downloaded exactly once"
        );
        assert_eq!(begun.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(
            received.load(std::sync::atomic::Ordering::SeqCst),
            PACKAGE.len()
        );
        let logged = LOGGED.lock().unwrap().clone();
        let source = format!(
            "[app update] downloaded 99.0.0 from {}",
            github_archive.lock().unwrap()
        );
        assert!(
            logged.contains(&source),
            "the log names where it came from: {logged:#?}"
        );
    }
}

#[cfg(test)]
mod runtime_update_tests {
    use super::*;
    #[test]
    fn runtime_update_backup_down_clears_temporary_ownership_before_preparation() {
        let shell = Shell::default();
        let root = PathBuf::from("/fixture/customer-installation");
        *shell.containers.lock().unwrap() = Some(ContainerDeployment {
            root: root.clone(),
            address: engine::Address::new(engine::Engine::Docker, None),
        });
        down_containers_with(&shell, &root, |_| Ok(())).unwrap();
        assert!(shell.containers.lock().unwrap().is_none());
        assert_eq!(
            shell.stopped_container_root.lock().unwrap().as_ref(),
            Some(&root)
        );
    }
    #[test]
    fn runtime_update_user_stop_prevents_a_later_new_start_attempt() {
        use std::sync::atomic::Ordering::SeqCst;
        let shell = Shell::default();
        shell.updating.store(true, SeqCst);
        shell.update_cancelled.store(true, SeqCst);
        assert!(StartAttempt::begin(&shell).is_err());
        assert!(!shell.starting.load(SeqCst));
    }
}

#[cfg(test)]
mod tests {
    /// The window says "Updating OpenBot" and where an update stopped in plain words; the log
    /// keeps the releases and the CLI's own name for the step.
    #[test]
    fn the_log_keeps_the_back_end_releases_and_the_step_an_update_stopped_at() {
        assert_eq!(
            update_due_entry("0.16.0-rc.9", "0.16.0-rc.10", Some("update-quiesce")),
            "[local update] the backend is on 0.16.0-rc.9, due an update to 0.16.0-rc.10; the last \
             update stopped at update-quiesce"
        );
        assert_eq!(
            update_due_entry("0.16.0-rc.9", "0.16.0-rc.10", None),
            "[local update] the backend is on 0.16.0-rc.9, due an update to 0.16.0-rc.10"
        );
    }

    #[test]
    fn only_an_app_that_makes_room_gets_the_overlay_title_bar() {
        let root = test_support::temp_root("titlebar-room");
        assert!(!app_makes_room_for_window_buttons(&root));
        std::fs::create_dir_all(&root).unwrap();
        // v0.2.0 and before: the server on the host, and no room made.
        std::fs::write(
            root.join("docker-compose.yml"),
            "services:\n  postgres: {}\n  supervisor: {}\n",
        )
        .unwrap();
        assert!(!app_makes_room_for_window_buttons(&root));
        std::fs::write(
            root.join("docker-compose.yml"),
            "services:\n  server: {}\n  worker: {}\n",
        )
        .unwrap();
        assert!(app_makes_room_for_window_buttons(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Every release whose server runs in a container makes the room, which is what lets the
    /// Compose file answer for the styles that are now inside the server image.
    #[test]
    fn this_releases_app_makes_room_for_the_window_buttons() {
        let styles = include_str!("../../../app/src/styles.css");
        assert!(styles.contains("data-desktop-titlebar"));
    }

    use super::*;

    /// Setup opens in OpenBot's own light or dark once its page has reported one, and in the
    /// system's before that or when the record cannot be read.
    #[test]
    fn setup_takes_openbots_last_light_or_dark() {
        assert_eq!(
            theme_from_record(Some(r#"{"dark":false}"#)),
            Some(tauri::Theme::Light)
        );
        assert_eq!(
            theme_from_record(Some(r#"{"dark":true}"#)),
            Some(tauri::Theme::Dark)
        );
        for unreadable in [
            None,
            Some(""),
            Some("not json"),
            Some("{}"),
            Some(r#"{"dark":"yes"}"#),
        ] {
            assert_eq!(theme_from_record(unreadable), None, "{unreadable:?}");
        }
        // What `remember_appearance` writes is what this reads.
        let written = serde_json::json!({ "dark": false }).to_string();
        assert_eq!(theme_from_record(Some(&written)), Some(tauri::Theme::Light));
    }
    use std::io::{Read, Write};

    include!("stop_ipc_tests.rs");
    include!("composio_ipc_tests.rs");
    include!("local_eval_ipc_tests.rs");
    include!("logging_file_tests.rs");

    // The release half (it starts the install thread) is the app's own launch; a test runs a debug build.
    #[cfg(debug_assertions)]
    #[test]
    fn a_debug_build_never_starts_the_recorder_host_install_at_launch() {
        assert!(keep_recorder_host_installed().is_none());
        assert!(install_recorder_host_at_start().is_none());
    }

    // The registration's real side effects, in a folder standing in for a person's home: the entries written once
    // published, left alone while unchanged, and taken back out, note and all, when the ids empty. Windows writes the
    // registry, which a debug build refuses, so this is proved where the entries are files.
    #[cfg(unix)]
    #[test]
    fn the_store_registration_writes_and_takes_out_real_files() {
        let home = temp_root("recorder-store-registration");
        let os = recorder_os();
        let dirs = recorder_install::UserDirs::at(&home);
        let edge = recorder_install::data_directory(os, recorder_install::Browser::Edge, dirs);
        std::fs::create_dir_all(&edge).unwrap();
        let edge_id = "ponmlkjihgfedcbaponmlkjihgfedcba";
        let published = recorder_install::StoreIds {
            chrome: Some("abcdefghijklmnopabcdefghijklmnop".into()),
            edge: Some(edge_id.into()),
        };
        // Another application's entry beside the Recorder's.
        let folder = edge.join("External Extensions");
        std::fs::create_dir_all(&folder).unwrap();
        let theirs = folder.join("hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh.json");
        std::fs::write(
            &theirs,
            recorder_external::entry_contents(recorder_install::Browser::Edge),
        )
        .unwrap();

        let placed =
            recorder_external::register(dirs, os, &published, &mut RecorderInstallWriter).unwrap();
        let ours = folder.join(format!("{edge_id}.json"));
        assert_eq!(placed, vec![ours.clone()]);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(&ours).unwrap())
                .unwrap(),
            serde_json::json!({
                "external_update_url": "https://edge.microsoft.com/extensionwebstorebase/v1/crx"
            })
        );
        // Chrome is not installed in this home: nothing of Chrome's was made.
        assert!(
            !recorder_install::data_directory(os, recorder_install::Browser::Chrome, dirs).exists()
        );
        let note = recorder_external::record_location(os, dirs);
        assert!(note.is_file());
        let modified = std::fs::metadata(&ours).unwrap().modified().unwrap();
        recorder_external::register(dirs, os, &published, &mut RecorderInstallWriter).unwrap();
        assert_eq!(
            std::fs::metadata(&ours).unwrap().modified().unwrap(),
            modified
        );

        recorder_external::register(
            dirs,
            os,
            &recorder_install::StoreIds::default(),
            &mut RecorderInstallWriter,
        )
        .unwrap();
        assert!(!ours.exists());
        assert!(!note.exists());
        assert!(theirs.is_file());
        // Taking out what is already gone is not a failure.
        recorder_external::register(
            dirs,
            os,
            &recorder_install::StoreIds::default(),
            &mut RecorderInstallWriter,
        )
        .unwrap();
        let _ = std::fs::remove_dir_all(&home);
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

    /// An update restarts the app after stopping OpenBot itself. Tauri sends that restart through the
    /// exit handler and ignores `prevent_exit` for it, so a Quit cleanup started there would be cut
    /// off halfway, possibly while stopping the local Intelligence the update meant to keep.
    #[test]
    fn an_update_restart_passes_the_exit_handler_without_quits_cleanup() {
        let state = std::sync::Arc::new(QuitState::default());
        quit_done_for_restart(&state);
        request_quit_with(
            state,
            Some(tauri::RESTART_EXIT_CODE),
            || panic!("an update restart must not be held"),
            || panic!("an update restart must not run Quit's cleanup"),
            QuitDiagnostics {
                sink: |_: Vec<String>| panic!("an update restart reports no cleanup"),
                failed: |_: String| panic!("an update restart reports no cleanup"),
            },
            |_| panic!("an update restart is already exiting"),
            |_| panic!("an update restart starts no cleanup worker"),
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
            last_failure_now(app.handle()).unwrap().connection,
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
            last_failure_now(app.handle()).is_none(),
            "one refresh per run; a second signal cannot replace the pending screen"
        );
    }

    #[test]
    fn stop_retains_completed_installation_and_disables_only_automatic_start() {
        let root = local_eval_root(
            "stopped-completed-installation",
            Some(local_eval_state::Ownership::Created),
        );
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
            "OPENAI_BASE_URL=https://synthetic.example\n",
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
                std::fs::write(root.join(".env"), format!("OPENAI_BASE_URL=https://synthetic.example\n{legacy}")).unwrap();
                let configured = already_configured_for_root(root.to_string_lossy().into_owned());
                assert_eq!(configured.values["OPENAI_BASE_URL"], "https://synthetic.example");
                assert!(!configured.values.contains_key("INTELLIGENCE_API_KEY"));
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
        let up = stack::up(&address, &root, false, &secrets);
        std::fs::remove_dir_all(root).unwrap();
        assert!(up.is_ok(), "{up:?}");
    }

    #[test]
    fn the_linux_server_runs_as_the_owner_under_docker_and_as_namespace_root_under_podman() {
        assert_eq!(
            linux_server_user(engine::Engine::Docker, 1000, 1000),
            "1000:1000"
        );
        assert_eq!(linux_server_user(engine::Engine::Podman, 1000, 1000), "0:0");
    }

    #[test]
    fn deployment_ready_preserves_the_installed_release() {
        let root = temp_root("deployment-ready-pinned");
        write_installed_deployment(&root);
        deployment::record(&root, "v0.0.7", false).unwrap();
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();

        tauri::async_runtime::block_on(deployment_ready(app.handle(), &root)).unwrap();

        assert_eq!(deployment::installed(&root).unwrap().version, "v0.0.7");
        assert_eq!(
            std::fs::read_to_string(root.join("docker-compose.yml")).unwrap(),
            INSTALLED_COMPOSE
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
    fn already_configured_trims_pasted_root_and_preserves_interior_spaces() {
        let root = temp_root("openbot-pasted-root My Files");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(".env"),
            "OPENAI_BASE_URL=https://trim.example.test\n",
        )
        .unwrap();
        let typed = format!(" \n{}\t ", root.display());
        let configured = already_configured_for_root(typed);
        let normal = already_configured_for_root(root.to_string_lossy().into_owned());
        assert_eq!(configured.values, normal.values);
        assert_eq!(
            configured.values.get("OPENAI_BASE_URL"),
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

        assert!(!configured.values.contains_key("INTELLIGENCE_API_KEY"));
        assert_eq!(
            configured.values.get("OPENAI_API_KEY"),
            Some(&"file-openai".to_string())
        );
        assert_eq!(configured.saved.model_api_keys.openai, Some(true));
        assert_eq!(configured.saved.model_sessions.openai, Some(true));
        assert_eq!(configured.saved.model_sessions.anthropic, Some(false));
        let _ = std::fs::remove_dir_all(root);
    }

    /// An installation an earlier app set up against hosted or self-hosted Intelligence, or behind
    /// an organization's sign-in: its launch is not offered, so the window starts the local setup,
    /// and nothing of it is read back or removed.
    #[test]
    fn a_hosted_installation_is_not_offered_as_a_launch_and_is_left_in_place() {
        let root = temp_root("openbot-already-configured-hosted");
        std::fs::create_dir_all(&root).unwrap();
        let env = "INTELLIGENCE_API_KEY=synthetic-hosted-key\nINTELLIGENCE_API_URL=https://api.intelligence.copilotkit.ai\nINTELLIGENCE_GATEWAY_WS_URL=wss://realtime.intelligence.copilotkit.ai\nOPENBOT_ORGANIZATION_AUTH_URL=https://openbot.company.example\nOPENAI_API_KEY=synthetic-openai\n";
        std::fs::write(root.join(".env"), env).unwrap();
        std::fs::write(root.join(preparation::FILE), "{}").unwrap();
        preparation::record_launch(&root, None).unwrap();
        assert!(preparation::launch(&root).is_some());

        let configured = already_configured_for_root(root.to_string_lossy().into_owned());
        let json = serde_json::to_value(&configured).unwrap();
        assert!(json.get("launch").is_none(), "{json}");
        assert!(json.get("localEval").is_none(), "{json}");
        assert!(json["saved"].get("intelligenceApiKey").is_none(), "{json}");
        for hosted in [
            "INTELLIGENCE_API_KEY",
            "INTELLIGENCE_API_URL",
            "INTELLIGENCE_GATEWAY_WS_URL",
            "OPENBOT_ORGANIZATION_AUTH_URL",
        ] {
            assert!(!configured.values.contains_key(hosted), "{json}");
        }
        assert!(!json.to_string().contains("synthetic-hosted-key"));
        // The model answer is still read back, and the saved files are untouched.
        assert_eq!(configured.saved.model_api_keys.openai, Some(true));
        assert_eq!(std::fs::read_to_string(root.join(".env")).unwrap(), env);
        assert!(preparation::launch(&root).is_some());

        // Once the local stack is recorded, the same installation's launch is offered again.
        let stack = local_eval::StackId::parse("local-abc123").unwrap();
        local_eval_state::begin(
            &root,
            &stack,
            local_eval_state::Ownership::Created,
            LOCAL_EVAL_PIN,
        )
        .unwrap();
        let configured = already_configured_for_root(root.to_string_lossy().into_owned());
        assert!(configured.launch.is_some());
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

    /// "Use a saved Claude sign-in" is offered only for a sign-in that is saved. A Claude plan
    /// chosen in an installation whose Start never ran (every 0.3.1 one on Windows) left the choice
    /// recorded and no token: the offer was made, Start answered "That Claude plan was not signed
    /// in to.", and an upgrade went back to the old version over it.
    #[test]
    fn a_claude_sign_in_is_offered_as_saved_only_when_its_token_is() {
        let root = temp_root("openbot-claude-plan-saved-only-when-stored");
        std::fs::create_dir_all(&root).unwrap();
        let anthropic = |root: &Path| {
            already_configured_for_root(root.to_string_lossy().into_owned())
                .saved
                .model_sessions
                .anthropic
        };
        assert_eq!(anthropic(&root), Some(false), "nothing saved");
        std::fs::write(
            root.join(openbot_desktop_lib::saved_intent::FILE),
            r#"{"version":1,"categories":["intelligence","claude-plan"],"model":"claude-plan"}"#,
        )
        .unwrap();
        assert_eq!(anthropic(&root), Some(false), "chosen, never saved");
        let extension = if cfg!(target_os = "windows") {
            "dpapi"
        } else {
            "secret"
        };
        std::fs::create_dir_all(root.join(".secrets")).unwrap();
        std::fs::write(
            root.join(".secrets")
                .join(format!("CLAUDE_CODE_OAUTH_TOKEN.{extension}")),
            "sealed",
        )
        .unwrap();
        assert_eq!(anthropic(&root), Some(true), "saved in the vault");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// "Use a saved ChatGPT sign-in", and "Use a saved OpenAI API key" or "Use a saved Anthropic
    /// API key", are offered only for what is saved. The window offers each one unless the shell
    /// says there is none, and on a freshly reset Windows machine the shell said nothing: the offer
    /// was made, it lit Continue, and Start answered "That ChatGPT plan was not signed in to."
    #[test]
    fn a_chatgpt_sign_in_or_an_api_key_is_offered_as_saved_only_when_it_is() {
        let root = temp_root("openbot-saved-only-when-stored");
        std::fs::create_dir_all(&root).unwrap();
        // (ChatGPT sign-in, OpenAI API key, Anthropic API key)
        let saved = |root: &Path| {
            let saved = already_configured_for_root(root.to_string_lossy().into_owned()).saved;
            (
                saved.model_sessions.openai,
                saved.model_api_keys.openai,
                saved.model_api_keys.anthropic,
            )
        };
        let none = (Some(false), Some(false), Some(false));
        assert_eq!(saved(&root), none, "nothing saved");
        std::fs::write(
            root.join(openbot_desktop_lib::saved_intent::FILE),
            r#"{"version":1,"categories":["intelligence","chat-gpt-plan","open-ai-api-key","anthropic-api-key"],"model":"chat-gpt-plan"}"#,
        )
        .unwrap();
        assert_eq!(saved(&root), none, "chosen, never saved");

        // Saved by Start, each in turn. Choosing one clears the one before it.
        persist_endpoint_fixture(
            &root,
            &openbot_env::ModelCredential::ChatGptPlan {
                store: r#"{"refresh_token":"synthetic-refresh"}"#.into(),
            },
        );
        assert_eq!(saved(&root), (Some(true), Some(false), Some(false)));
        persist_endpoint_fixture(
            &root,
            &openbot_env::ModelCredential::OpenAi {
                api_key: "synthetic-openai".into(),
            },
        );
        assert_eq!(saved(&root), (Some(false), Some(true), Some(false)));
        persist_endpoint_fixture(
            &root,
            &openbot_env::ModelCredential::Anthropic {
                api_key: "synthetic-anthropic".into(),
            },
        );
        assert_eq!(saved(&root), (Some(false), Some(false), Some(true)));
        std::fs::remove_dir_all(root).unwrap();
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
            assert_eq!(unknown.saved.model_sessions.anthropic, Some(false));
        }
        std::fs::write(
            root.join(openbot_desktop_lib::saved_intent::FILE),
            r#"{"version":1,"categories":["intelligence","claude-plan"],"model":"claude-plan"}"#,
        )
        .unwrap();
        let recorded = already_configured_for_root(root.to_string_lossy().into_owned());
        // A recorded choice is not a saved sign-in.
        assert_eq!(recorded.saved.model_sessions.anthropic, Some(false));
        assert_eq!(recorded.saved.model_api_keys.anthropic, Some(false));
        assert_eq!(recorded.saved.model_sessions.openai, Some(false));
        assert!(recorded.values.is_empty());
        let fresh = already_configured_for_root(
            temp_root("different-public-root")
                .to_string_lossy()
                .into_owned(),
        );
        assert_eq!(fresh.saved.model_sessions.anthropic, Some(false));
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
            let result = intelligence_key_for_start(&root, |_, key| {
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
    fn start_resolves_saved_secrets_from_the_selected_root() {
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
            || Ok(database_leftovers(&[])),
        )
        .unwrap_err();
        let offered = serde_json::to_value(error).unwrap();
        assert_eq!(offered["database_reset"], "openbot_postgres-data");
        assert_eq!(
            offered["leftover_reset"],
            serde_json::json!(["openbot_postgres-data"])
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
            let refused = serde_json::to_value(error).unwrap();
            assert!(refused.get("database_reset").is_none());
            assert!(refused.get("leftover_reset").is_none());
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

    fn database_leftovers(others: &[&str]) -> stack::LeftoverVolumes {
        let mut volumes: Vec<String> = others.iter().map(|name| name.to_string()).collect();
        volumes.push("openbot_postgres-data".into());
        volumes.sort();
        stack::LeftoverVolumes {
            database: Some("openbot_postgres-data".into()),
            database_exists: true,
            volumes,
            ..Default::default()
        }
    }

    fn leftovers_without_database(volumes: &[&str]) -> stack::LeftoverVolumes {
        stack::LeftoverVolumes {
            database: None,
            database_exists: false,
            volumes: volumes.iter().map(|name| name.to_string()).collect(),
            ..Default::default()
        }
    }

    const BOT_LEFTOVERS: [&str; 3] = [
        "openbot-profile-general-assistant",
        "openbot-workspace-general-assistant",
        "openbot_agent-profiles",
    ];

    /// Deleting the folder leaves Bots' files and sign-ins in the engine even with no database.
    #[test]
    fn a_fresh_root_refuses_to_reattach_any_leftover_volume() {
        let root = temp_root("leftover-volumes-offer");
        std::fs::create_dir_all(&root).unwrap();

        let error = require_existing_encryption_key_with_recovery(
            &root,
            &stack::Secrets::new(),
            || Ok(false),
            || Ok(leftovers_without_database(&BOT_LEFTOVERS)),
        )
        .unwrap_err();
        assert!(
            error.said.contains("previous installation"),
            "{}",
            error.said
        );
        let offered = serde_json::to_value(error).unwrap();
        assert!(offered.get("database_reset").is_none());
        assert_eq!(offered["leftover_reset"], serde_json::json!(BOT_LEFTOVERS));

        // Nothing left behind starts exactly as before.
        assert!(require_existing_encryption_key_with_recovery(
            &root,
            &stack::Secrets::new(),
            || Ok(false),
            || Ok(stack::LeftoverVolumes::default()),
        )
        .is_ok());

        // A probe that fails is not permission to reattach whatever is there.
        assert!(require_existing_encryption_key_with_recovery(
            &root,
            &stack::Secrets::new(),
            || Ok(false),
            || Err(Problem::plain("inventory failed")),
        )
        .is_err());

        // A database joins the same confirmation as everything else it would be reset with.
        let error = require_existing_encryption_key_with_recovery(
            &root,
            &stack::Secrets::new(),
            || Ok(true),
            || Ok(database_leftovers(&BOT_LEFTOVERS)),
        )
        .unwrap_err();
        assert_eq!(
            error.database_reset.as_deref(),
            Some("openbot_postgres-data")
        );
        assert_eq!(
            error.leftover_volumes(),
            database_leftovers(&BOT_LEFTOVERS).volumes
        );

        // A database OpenBot cannot verify keeps the existing refusal, with nothing offered.
        let mut unverified = leftovers_without_database(&BOT_LEFTOVERS);
        unverified.database_exists = true;
        let error = require_existing_encryption_key_with_recovery(
            &root,
            &stack::Secrets::new(),
            || Ok(true),
            || Ok(unverified),
        )
        .unwrap_err();
        assert_eq!(error.database_reset, None);
        assert!(error.leftover_volumes().is_empty());
        assert!(error
            .said
            .contains("OpenBot will not replace the key automatically"));

        // Stopped containers that hold the volumes join the confirmation; running ones block it.
        let mut held = leftovers_without_database(&BOT_LEFTOVERS);
        held.containers = vec![stack::LeftoverContainer {
            name: "openbot-computer-general-assistant".into(),
            id: "c-computer".into(),
        }];
        let error = require_existing_encryption_key_with_recovery(
            &root,
            &stack::Secrets::new(),
            || Ok(false),
            || Ok(held.clone()),
        )
        .unwrap_err();
        assert_eq!(error.leftover_volumes(), BOT_LEFTOVERS);
        assert_eq!(
            error.leftover_containers(),
            ["openbot-computer-general-assistant"]
        );
        assert_eq!(
            serde_json::to_value(&error).unwrap()["leftover_containers"],
            serde_json::json!(["openbot-computer-general-assistant"])
        );
        held.running = vec!["openbot-agent-computer-1".into()];
        let error = require_existing_encryption_key_with_recovery(
            &root,
            &stack::Secrets::new(),
            || Ok(false),
            || Ok(held),
        )
        .unwrap_err();
        assert!(error.leftover_volumes().is_empty() && error.leftover_containers().is_empty());
        assert!(
            error.said.contains("openbot-agent-computer-1") && error.said.contains("still running"),
            "{}",
            error.said
        );

        // Unknown root metadata refuses Start but never offers deletion.
        std::fs::write(
            root.join(openbot_desktop_lib::saved_intent::FILE),
            "invalid-settings-secret",
        )
        .unwrap();
        let error = require_existing_encryption_key_with_recovery(
            &root,
            &stack::Secrets::new(),
            || Ok(false),
            || Ok(leftovers_without_database(&BOT_LEFTOVERS)),
        )
        .unwrap_err();
        assert!(error.leftover_volumes().is_empty());
        assert!(!format!("{error:?}").contains("invalid-settings-secret"));
        std::fs::remove_file(root.join(openbot_desktop_lib::saved_intent::FILE)).unwrap();

        // A returning installation with its key keeps its data and is never probed.
        let secrets = stack::Secrets::from([(
            "KEY_ENCRYPTION_KEY".into(),
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=".into(),
        )]);
        std::fs::write(root.join(".env"), "DATABASE_URL=postgres://fixture\n").unwrap();
        assert!(require_existing_encryption_key_with_recovery(
            &root,
            &secrets,
            || panic!("original key needs no probe"),
            || panic!("original key keeps its volumes")
        )
        .is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_refused_start_offers_exactly_the_containers_and_volumes_it_named() {
        let root = temp_root("leftover-offer");
        let address = engine::Address::new(engine::Engine::Docker, None);
        assert!(leftover_offer(&Problem::plain("refused"), &root, &address).is_none());
        let mut problem = Problem::plain("refused");
        problem.leftover = Some(Box::new(LeftoverReset {
            volumes: BOT_LEFTOVERS.map(String::from).to_vec(),
            containers: vec!["openbot-computer-general-assistant".into()],
        }));
        let offer = leftover_offer(&problem, &root, &address).unwrap();
        assert_eq!(offer.root, root);
        assert_eq!(offer.volumes, BOT_LEFTOVERS);
        assert_eq!(offer.containers, ["openbot-computer-general-assistant"]);
        assert_eq!(offer.address, address);
    }

    #[test]
    fn leftover_reset_is_bound_to_the_exact_offered_set() {
        let root = temp_root("leftover-volumes-command");
        std::fs::create_dir_all(&root).unwrap();
        let shell = Shell::default();
        let offered: Vec<String> = BOT_LEFTOVERS.map(String::from).to_vec();
        *shell.leftover_database.lock().unwrap() = Some(LeftoverDatabase {
            root: root.clone(),
            volumes: offered.clone(),
            containers: vec!["openbot-computer-general-assistant".into()],
            address: engine::Address::new(engine::Engine::Docker, None),
        });
        let mut superset = offered.clone();
        superset.push("other-profile-knowledge".into());
        let containers = ["openbot-computer-general-assistant".to_string()];
        for (stale, stale_containers) in [
            (offered[..2].to_vec(), &containers[..]),
            (superset, &containers[..]),
            (Vec::new(), &containers[..]),
            (offered.clone(), &[][..]),
            (
                offered.clone(),
                &[containers[0].clone(), "other-computer-knowledge".into()][..],
            ),
        ] {
            assert!(reset_leftover_database_with(
                &shell,
                &root,
                &stale,
                stale_containers,
                true,
                || panic!("a changed set must refuse before reading credentials"),
                |_, _| panic!("a changed set must not remove anything")
            )
            .is_err());
        }
        let mut reordered = offered.clone();
        reordered.reverse();
        reset_leftover_database_with(
            &shell,
            &root,
            &reordered,
            &containers,
            true,
            || Ok(stack::Secrets::new()),
            |offer, _| {
                assert_eq!(offer.volumes, offered, "removal gets the confirmed volumes");
                assert_eq!(offer.containers, containers, "and the confirmed containers");
                Ok(())
            },
        )
        .unwrap();
        assert!(shell.leftover_database.lock().unwrap().is_none());
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
                volumes: vec!["openbot_postgres-data".into()],
                containers: Vec::new(),
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
            &["openbot_postgres-data".to_string()],
            &[],
            false,
            || panic!("unconfirmed must not access credentials"),
            |_, _| panic!("unconfirmed must not delete")
        )
        .is_err());
        assert!(reset_leftover_database_with(
            &shell,
            &root,
            &["openbot_postgres-data".to_string()],
            &[],
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
                &["openbot_postgres-data".to_string()],
                &[],
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
            &["openbot_postgres-data".to_string()],
            &[],
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
            &["openbot_postgres-data".to_string()],
            &[],
            true,
            || Ok(secrets),
            |_, _| panic!("restored key must prevent deletion")
        )
        .is_err());
        *shell.root.lock().unwrap() = Some(root.clone());
        assert!(reset_leftover_database_with(
            &shell,
            &root,
            &["openbot_postgres-data".to_string()],
            &[],
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
            &["openbot_postgres-data".to_string()],
            &[],
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
            &["openbot_postgres-data".to_string()],
            &[],
            true,
            || panic!("concurrent startup must refuse"),
            |_, _| panic!("concurrent startup must prevent deletion")
        )
        .is_err());
        drop(attempt);
        assert!(reset_leftover_database_with(
            &shell,
            &root,
            &["openbot_postgres-data".to_string()],
            &[],
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
        let volume = &["openbot_postgres-data".to_string()][..];
        assert!(reset_leftover_database_with(
            &shell,
            &root,
            volume,
            &[],
            true,
            || panic!("a missing offer must refuse before reading credentials"),
            |_, _| panic!("a missing offer must not remove anything")
        )
        .is_err());
        *shell.leftover_database.lock().unwrap() = Some(LeftoverDatabase {
            root: root.clone(),
            volumes: volume.to_vec(),
            containers: Vec::new(),
            address: original.clone(),
        });
        for (selected_root, selected_volume) in [
            (&root, &["other-volume".to_string()][..]),
            (&root.join("another-root"), volume),
        ] {
            assert!(reset_leftover_database_with(
                &shell,
                selected_root,
                selected_volume,
                &[],
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
                &[],
                true,
                || Ok(stack::Secrets::new()),
                |offer, _| {
                    assert_eq!(offer.address, original);
                    Err(unavailable.clone())
                }
            ),
            Err(unavailable)
        );
        reset_leftover_database_with(
            &shell,
            &root,
            volume,
            &[],
            true,
            || Ok(stack::Secrets::new()),
            |offer, _| {
                assert_eq!(offer.address, original);
                let command = offer.address.command();
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
        // Recorded as this root's project, which every Compose command the app runs is given and
        // which outranks the file's `name:`. See `stack::project`.
        std::fs::write(
            root.join(stack::PROJECT_FILE),
            serde_json::json!({ "project": project }).to_string(),
        )
        .unwrap();
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
                || stack::leftover_volumes(&address, &root, &secrets),
            )
            .unwrap_err();
            assert_eq!(guarded.database_reset.as_deref(), Some(volume.as_str()));
            let volumes = [volume.clone()];
            assert_eq!(guarded.leftover_volumes(), volumes);
            let shell = Shell::default();
            *shell.leftover_database.lock().unwrap() = Some(LeftoverDatabase {
                root: root.clone(),
                volumes: volumes.to_vec(),
                containers: Vec::new(),
                address: address.clone(),
            });
            assert!(reset_leftover_database_with(
                &shell,
                &root,
                &volumes,
                &[],
                false,
                || Ok(secrets.clone()),
                |offer, secrets| stack::reset_leftover_volumes(
                    &offer.address,
                    &root,
                    secrets,
                    &offer.volumes,
                    &offer.containers
                )
            )
            .is_err());
            assert!(stack::postgres_volume_exists(&address, &root, &secrets).unwrap());
            assert!(!root.join(".secrets/KEY_ENCRYPTION_KEY.secret").exists());
            assert!(!root.join(".env").exists());
            reset_leftover_database_with(
                &shell,
                &root,
                &volumes,
                &[],
                true,
                || Ok(secrets.clone()),
                |offer, secrets| {
                    stack::reset_leftover_volumes(
                        &offer.address,
                        &root,
                        secrets,
                        &offer.volumes,
                        &offer.containers,
                    )
                },
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
                stack::reset_leftover_volumes(&address, &root, &secrets, &volumes, &[]).is_err(),
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
        // The endpoint's key shares the OPENAI_API_KEY slot, and is never offered as OpenAI's.
        assert_eq!(configured.saved.model_api_keys.openai, Some(false));
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
    fn a_docker_desktop_started_by_the_install_step_skips_the_podman_machine() {
        let docker = engine::EngineStatus {
            engine: Some(engine::Engine::Docker),
            address: Some(engine::Address::new(engine::Engine::Docker, None)),
            responding: true,
            engine_socket: None,
            detail: "docker is answering.".into(),
        };
        let address = answering_after_install(&docker, |_| true)
            .unwrap()
            .expect("an answering Docker needs no Podman machine");
        assert_eq!(address.engine, engine::Engine::Docker);

        let problem = answering_after_install(&docker, |_| false).unwrap_err();
        assert_eq!(
            problem.said,
            acquire::missing_compose(engine::Engine::Docker.binary())
        );
    }

    #[test]
    fn a_podman_without_its_machine_still_gets_the_machine_steps() {
        let podman = engine::EngineStatus {
            engine: Some(engine::Engine::Podman),
            address: None,
            responding: false,
            engine_socket: None,
            detail: "podman is installed but not answering. Start it and try again.".into(),
        };
        assert!(
            answering_after_install(&podman, |_| panic!("nothing answers to run Compose"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn start_brings_up_the_engine_this_installation_runs_on() {
        use engine::Engine::{Docker, Podman};
        use std::cell::RefCell;
        // (saved, in a machine, answers, our machine exists) -> what was done
        let run = |saved, in_machine, answers, exists| {
            let done = RefCell::new(Vec::new());
            wake_saved_engine(
                saved,
                in_machine,
                || answers,
                || {
                    done.borrow_mut().push("open Docker Desktop");
                    Ok(())
                },
                || exists,
                || {
                    done.borrow_mut().push("start our machine");
                    Ok(())
                },
            )
            .unwrap();
            done.into_inner()
        };
        let none: [&str; 0] = [];
        // Answering: nothing is done, whatever was saved.
        for saved in [Some(Docker), Some(Podman), None] {
            assert_eq!(run(saved, true, true, true), none, "{saved:?}");
        }
        // A saved Docker opens Docker Desktop, never a Podman machine.
        assert_eq!(
            run(Some(Docker), true, false, true),
            ["open Docker Desktop"]
        );
        // A saved Podman after a restart: OpenBot's machine is started.
        assert_eq!(run(Some(Podman), true, false, true), ["start our machine"]);
        // An installation from before engines were saved, with nothing answering: the same.
        assert_eq!(run(None, true, false, true), ["start our machine"]);
        // No machine of ours: none is created and nobody else's is started.
        assert_eq!(run(Some(Podman), true, false, false), none);
        assert_eq!(run(None, true, false, false), none);
        // Linux runs Podman natively: there is no machine to start.
        assert_eq!(run(Some(Podman), false, false, true), none);
    }

    /// The tester's Start: Docker Desktop 4.27.2 answered, and Compose v2.24.5 stopped at its first
    /// look at the project. The engine is now woken, then checked and updated, before Compose.
    #[test]
    fn start_wakes_the_engine_then_makes_it_new_enough_before_compose() {
        use std::cell::RefCell;
        let docker = || engine::Address::new(engine::Engine::Docker, None);
        let run = |answers: bool, wake: Result<(), Problem>, check: Result<(), Problem>| {
            let done = RefCell::new(Vec::new());
            let result = tauri::async_runtime::block_on(engine_before_compose(
                async || {
                    done.borrow_mut().push("wake");
                    wake
                },
                async || {
                    done.borrow_mut().push("look");
                    answers.then(docker)
                },
                async |address| {
                    assert_eq!(
                        address,
                        docker(),
                        "the engine that answered is the one checked"
                    );
                    done.borrow_mut().push("new enough");
                    check
                },
            ));
            (result, done.into_inner())
        };

        let (result, done) = run(true, Ok(()), Ok(()));
        assert!(result.is_ok());
        assert_eq!(done, ["wake", "look", "new enough"]);

        // An update that could not be made stops Start there, with its own words, before Compose.
        let (result, done) = run(
            true,
            Ok(()),
            Err(Problem::plain(
                "Docker on this computer is too old to run OpenBot. Update Docker, then start \
                 OpenBot again.",
            )),
        );
        assert!(result
            .unwrap_err()
            .said
            .starts_with("Docker on this computer is too old"));
        assert_eq!(done, ["wake", "look", "new enough"]);

        // A wake that failed is the failure; nothing is checked.
        let (result, done) = run(true, Err(Problem::plain("machine did not start")), Ok(()));
        assert_eq!(result.unwrap_err().said, "machine did not start");
        assert_eq!(done, ["wake"]);

        // Nothing answering: the check after this one says so, and no update is tried.
        let (result, done) = run(false, Ok(()), Ok(()));
        assert!(result.is_ok());
        assert_eq!(done, ["wake", "look"]);
    }

    #[test]
    fn a_machine_that_fails_to_start_stops_start_with_its_own_words() {
        let problem = wake_saved_engine(
            Some(engine::Engine::Podman),
            true,
            || false,
            || panic!("a Podman installation never opens Docker Desktop"),
            || true,
            || Err(Problem::plain("machine did not start")),
        )
        .unwrap_err();
        assert_eq!(problem.said, "machine did not start");
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
            update_to: None,
            checks_passed: false,
            shortfall: None,
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
        let failure =
            open_dashboard_at(&root, |_| panic!("login ran without a stack")).unwrap_err();
        assert_eq!(failure, DashboardFailure::NotSetUp);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn opening_intelligence_signs_in_the_recorded_stack() {
        let root = local_eval_root(
            "openbot-open-intelligence-recorded",
            Some(local_eval_state::Ownership::Shared),
        );
        let mut asked = None;
        open_dashboard_at(&root, |stack| {
            asked = Some(stack.as_str().to_owned());
            signed_in(local_eval::Outcome::Completed, None)
        })
        .unwrap();
        assert_eq!(asked.as_deref(), Some("local-abc123"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn opening_intelligence_fails_with_a_fixed_category_only() {
        use local_eval::{Failure, Outcome, Reason};
        let root = local_eval_root(
            "openbot-open-intelligence-failures",
            Some(local_eval_state::Ownership::Created),
        );
        for (result, category) in [
            (
                signed_in(Outcome::Blocked, Some(Reason::DashboardUnavailable)),
                DashboardFailure::NotResponding,
            ),
            (
                signed_in(Outcome::Blocked, Some(Reason::BrowserOpenFailed)),
                DashboardFailure::BrowserFailed,
            ),
            (
                signed_in(Outcome::Blocked, Some(Reason::LocalCommandBusy)),
                DashboardFailure::Busy,
            ),
            (
                signed_in(Outcome::Blocked, Some(Reason::DockerUnavailable)),
                DashboardFailure::EngineStopped,
            ),
            (
                signed_in(Outcome::Blocked, Some(Reason::Unrecognized)),
                DashboardFailure::Failed,
            ),
            (signed_in(Outcome::Blocked, None), DashboardFailure::Failed),
            (
                signed_in(Outcome::Failed, Some(Reason::LocalCommandFailed)),
                DashboardFailure::Failed,
            ),
            (Err(Failure::Unavailable), DashboardFailure::Unsupported),
            (Err(Failure::Timeout), DashboardFailure::TimedOut),
            (Err(Failure::Cancelled), DashboardFailure::Stopped),
            (Err(Failure::InvalidJson), DashboardFailure::Failed),
            (Err(Failure::Unverified), DashboardFailure::Failed),
        ] {
            // Nothing but a fixed category, so no CLI text can ride along.
            assert_eq!(open_dashboard_at(&root, |_| result).unwrap_err(), category);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_dashboard_is_offered_only_for_a_recorded_local_stack() {
        let recorded = local_eval_root(
            "openbot-intelligence-menu-recorded",
            Some(local_eval_state::Ownership::Created),
        );
        let unrecorded = local_eval_root("openbot-intelligence-menu-unrecorded", None);
        assert_eq!(
            intelligence_menu_root(&recorded, true),
            Some(recorded.clone())
        );
        // Hosted mode, or local mode with nothing recorded: nothing offered.
        assert_eq!(intelligence_menu_root(&recorded, false), None);
        assert_eq!(intelligence_menu_root(&unrecorded, true), None);
        let _ = std::fs::remove_dir_all(recorded);
        let _ = std::fs::remove_dir_all(unrecorded);
    }

    #[test]
    fn opening_the_dashboard_says_so_before_the_cli_runs_then_how_it_went() {
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
            unfinished_update: None,
            observed: None,
            app_paths: Vec::new(),
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

    /// Words a person setting OpenBot up does not know, and a release's name.
    fn technical(said: &str) -> Option<&'static str> {
        let lower = said.to_lowercase();
        [
            "podman",
            "wsl",
            "engine",
            "backend",
            "backend",
            "container",
            "compose",
            "helm",
            "k3s",
            "image",
            "internal-",
            "local software",
        ]
        .into_iter()
        .find(|word| lower.contains(word))
        .or_else(|| {
            regex::Regex::new(r"\bv?\d+\.\d+")
                .unwrap()
                .is_match(said)
                .then_some("a version")
        })
    }

    /// Every row step the native side reports has a plain line for each state, so a row whose
    /// text was not written for the window (a release name, an engine's output, an error) still
    /// says something plain there.
    #[test]
    fn every_row_the_native_side_can_show_has_a_plain_line() {
        for step in ROW_STEPS {
            for (ok, running) in [(true, true), (true, false), (false, false)] {
                let said = plain_row(step, ok, running);
                assert!(!said.is_empty(), "{step}");
                assert_eq!(technical(said), None, "{step}: {said}");
            }
        }
    }

    /// Found on Windows F: "Downloading OpenBot internal-d2df1b062ac0." reached the Account
    /// step's background row for two seconds, the one step line of the run with no plain line of
    /// its own. Its text is the log's now, and the window says the step's plain line.
    #[test]
    fn a_row_with_no_plain_line_of_its_own_never_shows_its_text() {
        for (step, running, text) in [
            (
                "deployment",
                true,
                "Downloading OpenBot internal-d2df1b062ac0.",
            ),
            ("deployment", false, "v1.0.1 in C:\\Users\\you\\OpenBot"),
            ("install-engine", false, "Compose 5.5.1 installed."),
            ("health-gate", false, "engine API 6.1.4"),
        ] {
            let line = unregistered_line(step, true, running, text.into());
            assert_eq!(technical(&line.said), None, "{step}: {}", line.said);
            assert!(!line.said.contains(text), "{step}: {}", line.said);
            assert!(line.log_entry().contains(text), "{}", line.log_entry());
        }
        assert_eq!(
            unregistered_line(
                "deployment",
                true,
                true,
                "Downloading OpenBot internal-d2df1b062ac0.".into()
            )
            .said,
            "Downloading OpenBot."
        );
    }

    /// Every step this file reports a row for is one `plain_row` knows, so a new step gets a line
    /// of its own rather than the catch-all.
    #[test]
    fn every_step_reported_has_a_plain_line_of_its_own() {
        let source = include_str!("main.rs");
        let tests = source
            .find("#[cfg(test)]\nmod tests")
            .unwrap_or(source.len());
        let reported = regex::Regex::new(
            r#"\b(?:report|report_running|report_plain|report_running_plain|report_line|report_running_line)\(\s*&?[\w.]+,\s*"([\w-]+)""#,
        )
        .unwrap();
        let steps: std::collections::BTreeSet<&str> = reported
            .captures_iter(&source[..tests])
            .filter_map(|found| found.get(1).map(|step| step.as_str()))
            .collect();
        assert!(steps.contains("deployment"), "{steps:?}");
        for step in steps {
            assert!(
                ROW_STEPS.contains(&step),
                "{step} has no plain line of its own"
            );
        }
    }

    /// A window put back where it was last time stays there while its title bar is on a screen,
    /// and goes to the middle of the primary screen when that screen is gone.
    #[test]
    fn a_window_put_back_off_every_screen_comes_onto_the_primary_one() {
        let rect = |x: f64, y: f64, width: f64, height: f64| tauri::LogicalRect {
            position: tauri::LogicalPosition::new(x, y),
            size: tauri::LogicalSize::new(width, height),
        };
        let primary = rect(0.0, 0.0, 1920.0, 1032.0);
        let left = rect(-1280.0, 0.0, 1280.0, 760.0);
        // Where it was left, on the primary screen or the second one: it stays.
        assert_eq!(
            onto_a_screen(rect(78.0, 24.0, 1016.0, 992.0), &[primary, left]),
            None
        );
        assert_eq!(
            onto_a_screen(rect(-1100.0, 40.0, 1016.0, 839.0), &[primary, left]),
            None
        );
        // Mostly off the right edge, with its title bar still reachable: it stays.
        assert_eq!(
            onto_a_screen(rect(1700.0, 100.0, 1016.0, 839.0), &[primary]),
            None
        );
        // The second screen is unplugged: onto the primary one, in the middle.
        assert_eq!(
            onto_a_screen(rect(-1100.0, 40.0, 1016.0, 839.0), &[primary]),
            Some(tauri::LogicalPosition::new(452.0, 96.5))
        );
        // Its title bar above the top of every screen: the same.
        assert!(onto_a_screen(rect(200.0, -500.0, 1016.0, 839.0), &[primary]).is_some());
        // No screen known: left as it is.
        assert_eq!(onto_a_screen(rect(-5000.0, 0.0, 1016.0, 839.0), &[]), None);
    }

    /// Another app holds the foreground (the browser, signing in): Windows refuses
    /// `SetForegroundWindow`, and the taskbar button flashes. Nothing else happens: no key is
    /// pressed or released on the person's behalf. tao's `set_focus` pressed Alt there, and a lone
    /// Alt can leave a WebView2 window in menu mode; on Windows F setup froze for minutes after
    /// "[front] the engine machine is prepared" with the browser in front.
    #[test]
    fn coming_forward_with_another_window_in_front_flashes_and_sends_no_input() {
        let done = std::cell::RefCell::new(Vec::new());
        let front = come_forward(
            || {
                done.borrow_mut().push("set foreground");
                false
            },
            || done.borrow_mut().push("flash the taskbar"),
        );
        assert_eq!(front, Front::Flashed);
        assert_eq!(*done.borrow(), ["set foreground", "flash the taskbar"]);
        // Allowed in front: nothing flashes.
        let done = std::cell::RefCell::new(Vec::new());
        let front = come_forward(
            || {
                done.borrow_mut().push("set foreground");
                true
            },
            || done.borrow_mut().push("flash the taskbar"),
        );
        assert_eq!(front, Front::Came);
        assert_eq!(*done.borrow(), ["set foreground"]);
        // On Windows, `bring_to_front` never reaches tao's `set_focus` (its Alt press), and
        // nothing in this file sends key input of its own.
        let main = include_str!("main.rs");
        let body = &main[main.find("fn bring_to_front<").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let windows = &body[body.find("#[cfg(windows)]").unwrap()..];
        let windows = &windows[..windows.find("#[cfg(not(windows))]").unwrap()];
        assert!(!windows.contains("set_focus"), "{windows}");
        assert!(body.contains("#[cfg(not(windows))]\n    let _ = window.set_focus();"));
        let tests = main.find("#[cfg(test)]\nmod tests").unwrap_or(main.len());
        for input in ["SendInput", "keybd_event", "VK_MENU"] {
            assert!(!main[..tests].contains(input), "{input}");
        }
    }

    /// A reopened window showed blank at Windows' default spot (104,104) for about 230 ms, then
    /// jumped to its saved 400,90. It is built at its saved place now, in that screen's logical
    /// pixels, and never hidden.
    #[test]
    fn the_main_window_is_built_at_its_saved_place_and_never_hidden() {
        let screen = |x: i32, width: u32, scale: f64| Screen {
            position: (x, 0),
            size: (width, 1080),
            work: (x, 0, width, 1032),
            scale,
        };
        let saved = SavedWindow {
            width: 1016,
            height: 839,
            x: 400,
            y: 90,
            ..SavedWindow::default()
        };
        // Where it was, on the primary screen.
        assert_eq!(
            place_saved_window(saved, &[screen(0, 1920, 1.0)]),
            Some(Place {
                x: 400.0,
                y: 90.0,
                width: 1016.0,
                height: 839.0,
                maximized: false,
            })
        );
        // On a screen at 150%, in its logical pixels.
        assert_eq!(
            place_saved_window(saved, &[screen(0, 2880, 1.5)]),
            Some(Place {
                x: 400.0 / 1.5,
                y: 60.0,
                width: 1016.0 / 1.5,
                height: 839.0 / 1.5,
                maximized: false,
            })
        );
        // On a second screen that is still there.
        let left = SavedWindow { x: -1500, ..saved };
        assert_eq!(
            place_saved_window(left, &[screen(0, 1920, 1.0), screen(-1920, 1920, 1.0)])
                .map(|place| (place.x, place.y)),
            Some((-1500.0, 90.0))
        );
        // That screen unplugged: the middle of the primary one's work area.
        assert_eq!(
            place_saved_window(left, &[screen(0, 1920, 1.0)]).map(|place| (place.x, place.y)),
            Some((452.0, 96.0))
        );
        // Maximized: where it was before, and maximized again.
        let maximized = SavedWindow {
            x: -8,
            y: -8,
            prev_x: 300,
            prev_y: 80,
            maximized: true,
            ..saved
        };
        assert_eq!(
            place_saved_window(maximized, &[screen(0, 1920, 1.0)]).map(|place| (
                place.x,
                place.y,
                place.maximized
            )),
            Some((300.0, 80.0, true))
        );
        // Nothing saved: the configured window as it is.
        assert_eq!(
            place_saved_window(SavedWindow::default(), &[screen(0, 1920, 1.0)]),
            None
        );
        // The plugin's own file reads as saved here.
        let file: std::collections::HashMap<String, SavedWindow> = serde_json::from_str(
            r#"{"main":{"width":1016,"height":839,"x":400,"y":90,"prev_x":400,"prev_y":90,"maximized":false,"visible":true,"decorated":true,"fullscreen":false}}"#,
        )
        .unwrap();
        assert_eq!(
            file["main"],
            SavedWindow {
                prev_x: 400,
                prev_y: 90,
                ..saved
            }
        );
        // The builder takes the saved place, and the window is never built hidden.
        let main = include_str!("main.rs");
        let body = &main[main.find("fn build_main_window").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("match saved_main_window(app)"), "{body}");
        assert!(
            body.contains(".position(place.x, place.y)")
                && body.contains(".inner_size(place.width, place.height)"),
            "{body}"
        );
        assert!(!body.contains(".visible(false)"), "{body}");
        assert!(!body.contains(".show()"), "{body}");
    }

    /// Windows F: "[front] the engine machine is prepared" brought OpenBot in front of the
    /// browser while the person typed their email to sign in. While the sign-in is open, setup's
    /// own moments hold back; when it ends, OpenBot comes forward once.
    #[test]
    fn nothing_comes_forward_while_the_browser_sign_in_is_open_and_once_when_it_ends() {
        if crate::test_support::isolated_process(
            "tests::nothing_comes_forward_while_the_browser_sign_in_is_open_and_once_when_it_ends",
        ) {
            return;
        }
        let forward = std::cell::Cell::new(0);
        let during = while_signing_in(
            || {
                // Setup's moments while the person is in the browser.
                [
                    "the engine machine is prepared",
                    "Docker Desktop answers",
                    "the engine no longer needs another app's window",
                ]
                .map(held_back)
            },
            || forward.set(forward.get() + 1),
        );
        assert_eq!(during, [true, true, true]);
        assert_eq!(forward.get(), 1);
        // Signed in: the next moment comes forward as before.
        assert!(!held_back("the engine machine is prepared"));
        // However the sign-in ends, the hold ends with it.
        let failed = std::panic::catch_unwind(|| {
            while_signing_in(|| panic!("the sign-in failed"), || {});
        });
        assert!(failed.is_err());
        assert!(!held_back("OpenBot is showing"));
        // `bring_to_front` asks before it does anything, and the sign-in runs inside the hold.
        let main = include_str!("main.rs");
        let body = &main[main.find("fn bring_to_front<").unwrap()..];
        assert!(body.starts_with(
            "fn bring_to_front<R: tauri::Runtime>(app: &tauri::AppHandle<R>, why: &str) {\n    if held_back(why) {\n        return;\n    }"
        ));
        let sign_in = &main[main.find("async fn sign_in_to_copilotkit<").unwrap()..];
        let sign_in = &sign_in[..sign_in.find("\n}\n").unwrap()];
        assert!(sign_in.contains(
            "while_signing_in(\n            || local_eval::account_sign_in_installed(&attempt),\n            || bring_to_front(&started_app, \"the browser sign-in ended\"),"
        ));
    }

    /// Windows cascades a window with no position of its own down and right on every launch. On
    /// a 1080p screen with a 48 px taskbar the third launch put a 1016 by 839 window's top at 234,
    /// its bottom at 1073, past the work area's 1032, and the account row behind the taskbar.
    #[test]
    fn a_window_whose_bottom_is_past_the_work_area_is_moved_up_into_it() {
        let area = tauri::LogicalRect {
            position: tauri::LogicalPosition::new(0.0, 0.0),
            size: tauri::LogicalSize::new(1920.0, 1032.0),
        };
        assert_eq!(lifted_top(234.0, 839.0, &area), Some(169.0));
        // The first two launches (52 and 156) fit, and stay where Windows put them.
        assert_eq!(lifted_top(52.0, 839.0, &area), None);
        assert_eq!(lifted_top(156.0, 839.0, &area), None);
        // Never above the work area, on a monitor below the primary one as on the primary.
        let lower = tauri::LogicalRect {
            position: tauri::LogicalPosition::new(0.0, 1080.0),
            size: tauri::LogicalSize::new(1280.0, 760.0),
        };
        assert_eq!(lifted_top(1500.0, 839.0, &lower), Some(1080.0));
    }

    /// The main window is built in setup, not from the configuration, so it can carry a
    /// new-window handler. It has to come out exactly as the configured window did: the same
    /// entry, every property in it, built the way Tauri builds a configured window at startup
    /// (`WebviewWindowBuilder::from_config(..)?.build()` in tauri's `app::setup`).
    #[test]
    fn the_main_window_built_in_setup_keeps_every_property_the_configured_window_had() {
        // The entry as it stood while Tauri created the window from it.
        let pinned = serde_json::json!({
            "title": "OpenBot",
            "width": 1000,
            "height": 800,
            "minWidth": 720,
            "minHeight": 560,
            "resizable": true,
            "titleBarStyle": "Transparent",
            "backgroundThrottling": "disabled",
            "dragDropEnabled": false
        });
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mut entry = config["app"]["windows"][0].clone();
        assert_eq!(
            entry.as_object_mut().unwrap().remove("create"),
            Some(serde_json::Value::Bool(false))
        );
        assert_eq!(entry, pinned, "a property was added, changed or dropped");

        let main = include_str!("main.rs");
        assert!(main.contains("tauri::WebviewWindowBuilder::from_config(app, &config)?"));
        assert!(main.contains("build_main_window(app.handle())?;"));

        let app = tauri::test::mock_builder()
            .build(tauri::generate_context!(test = true))
            .unwrap();
        assert!(app.get_webview_window("main").is_none());
        build_main_window(app.handle()).unwrap();
        let window = app.get_webview_window("main").expect("setup built it");
        let built = app
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .unwrap();
        assert_eq!(built.title, "OpenBot");
        assert_eq!((built.width, built.height), (1000.0, 800.0));
        assert_eq!(
            (built.min_width, built.min_height),
            (Some(720.0), Some(560.0))
        );
        assert_eq!(window.label(), "main");

        // Never built hidden: on Windows a WebView2 page under a window first created hidden
        // stopped taking native updates mid-setup, for minutes, until the window was activated
        // (1.0.1 release candidate). Built visible, then put on a screen.
        let body = &main[main.find("fn build_main_window").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(!body.contains(".visible(false)"), "{body}");
        assert!(!body.contains(".show()"), "{body}");
        assert!(body.contains("fit_main_window_to_screen(app)"), "{body}");
        assert!(window.is_visible().unwrap_or(true));
    }

    /// The developer's app is trusted only at a loopback IP, so `localhost` is read as `127.0.0.1`.
    #[test]
    fn the_developers_app_at_localhost_is_shown_at_127_0_0_1() {
        assert_eq!(
            loopback_ip("http://localhost:3030"),
            "http://127.0.0.1:3030/"
        );
        assert_eq!(
            loopback_ip("http://127.0.0.1:3030"),
            "http://127.0.0.1:3030"
        );
        assert_eq!(loopback_ip("http://[::1]:3030"), "http://[::1]:3030");
        assert!(intelligence_bridge::app_origin(&loopback_ip("http://localhost:3030")).is_some());
        assert!(intelligence_bridge::app_origin("http://localhost:3030").is_none());
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
        let about = about_openbot("0.3.4-internal.892.g0c140734ecf0".into());
        assert_eq!(
            about.short_version.as_deref(),
            Some("0.3.4-internal.892.g0c140734ecf0")
        );
        assert_eq!(about.version.as_deref(), Some(env!("OPENBOT_BUILD_COMMIT")));
        assert!(about.credits.unwrap().starts_with("Built "));
    }

    /// An internal build after 0.3.3 is packaged as `0.3.4-internal.892.g0c140734ecf0`, and the
    /// installer, the system's list of apps and the update check all named it so, while the Status
    /// window and Settings → This computer said "Version 0.3.3": `status` answered Cargo.toml's
    /// version, which is always the last release. This builds the app with that version, as
    /// `tauri build` with `tauri.build-version.conf.json` does, and reads the real status command
    /// against a fake engine. A release still names exactly its own version.
    #[test]
    fn status_names_the_version_this_build_was_packaged_as() {
        if crate::test_support::isolated_process(
            "tests::status_names_the_version_this_build_was_packaged_as",
        ) {
            return;
        }
        let _path = SerializedPath::set_only_with("docker", "desktop-status");
        let status_of = |packaged: &str| {
            let root = temp_root("desktop-status-version");
            std::fs::create_dir_all(&root).unwrap();
            let mut context = tauri::test::mock_context(tauri::test::noop_assets());
            context.package_info_mut().version = packaged.parse().unwrap();
            let app = tauri::test::mock_builder()
                .manage(Shell::default())
                .build(context)
                .unwrap();
            *app.state::<Shell>().root.lock().unwrap() = Some(root);
            let status = serde_json::to_value(read_desktop_status(app.handle(), false)).unwrap();
            // The fake engine answered, so nothing on this machine was asked.
            assert_eq!(status["engine"], "docker");
            assert!(status["build"].as_str().unwrap().starts_with("Built "));
            let about = about_openbot(desktop_version(app.handle()));
            assert_eq!(about.short_version.as_deref(), Some(packaged));
            status["version"].as_str().unwrap().to_owned()
        };

        let internal = "0.3.4-internal.892.g0c140734ecf0";
        assert_ne!(internal, env!("CARGO_PKG_VERSION"));
        assert_eq!(status_of(internal), internal);
        // A release build's Tauri version is the root package.json's, which Cargo.toml matches.
        assert_eq!(
            status_of(env!("CARGO_PKG_VERSION")),
            env!("CARGO_PKG_VERSION")
        );
    }

    /// Windows: Podman also answers on Docker's pipe, so a CLI not told the engine finds "the Docker
    /// address answers with Podman" and declines (`engine_mismatch`), which the account screen shows
    /// as "Couldn't check your CopilotKit account". Over an installation already prepared, Install
    /// does not run again and nothing else names the engine before Start, so Try again never
    /// helped. Every command the account screen runs names the engine first, as Start and setup do.
    #[test]
    fn the_account_screen_tells_the_cli_its_engine_first() {
        let source = include_str!("main.rs");
        for command in [
            "async fn local_eval_terms(",
            "async fn sign_in_to_copilotkit<R: tauri::Runtime>(",
        ] {
            let start = source.find(command).expect(command);
            let body = &source[start..];
            let body = &body[..body.find("\n}\n").expect("the end of the command")];
            let named = body.find("know_cli_engine(").unwrap_or(usize::MAX);
            let runs = body.find("_installed(").expect("the CLI call");
            assert!(
                named < runs,
                "{command} runs the CLI before naming its engine"
            );
        }
    }

    /// The live Windows run: the person's own `podman-machine-default` answered, the CLI was told no
    /// engine and took it, and the account step showed its refusal ("Rootless Podman is not
    /// supported. Switch to rootful Podman ...") as a change the person had to make, with Try again
    /// repeating it. While OpenBot's own machine is on its way the step waits instead, as it waits
    /// for any engine coming up, and the CLI is not asked. Once an engine is known, or on an
    /// installation that is on Docker, the CLI is asked as before.
    #[test]
    fn the_account_step_waits_for_openbots_own_machine_without_asking_the_cli() {
        let theirs = || Some("podman-machine-default".to_string());
        assert!(own_machine_on_its_way_with(false, None, theirs));
        assert!(own_machine_on_its_way_with(
            false,
            Some(engine::Engine::Podman),
            theirs
        ));
        assert!(!own_machine_on_its_way_with(true, None, theirs));
        assert!(!own_machine_on_its_way_with(
            false,
            Some(engine::Engine::Docker),
            theirs
        ));
        assert!(!own_machine_on_its_way_with(false, None, || None));

        let waiting = account_terms(true, || panic!("the CLI is not asked yet"));
        assert!(matches!(
            waiting,
            Ok(local_eval::Terms::EngineNotReady {
                cause: "own_machine"
            })
        ));
        assert!(matches!(
            account_terms(false, || Ok(local_eval::Terms::SignedOut)),
            Ok(local_eval::Terms::SignedOut)
        ));
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
                intelligence: Some("Backend stop failed: the CLI timed out".into()),
            }
        );
        assert_eq!(
            stopped.into_result(),
            Err("Compose down failed: compose refused\n\
                 Backend stop failed: the CLI timed out"
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
                intelligence: Some("Backend stop failed: the CLI timed out".into()),
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

    /// D's Quit: the machine's API pipe had gone, so OpenBot's compose down and the back end's
    /// local stop both failed ("docker_unavailable") and the next launch said some services didn't
    /// stop. Now one heal comes first, shared by both stops: the machine is restarted once, both
    /// stops succeed, and there is no failure to record.
    #[test]
    fn quit_with_the_api_gone_heals_once_then_both_stops_succeed() {
        let root = local_eval_root(
            "openbot-quit-heals-first",
            Some(local_eval_state::Ownership::Created),
        );
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(root.clone());
        let api = std::cell::Cell::new(false);
        let restarts = std::cell::Cell::new(0);
        let needs_api = |which: &str| {
            if api.get() {
                Ok(())
            } else {
                Err(format!("{which}: blocked, docker_unavailable"))
            }
        };
        let (down, intelligence) = healed_once_before(
            |_: &Path| {
                restarts.set(restarts.get() + 1);
                api.set(true);
            },
            |_: &Path| needs_api("compose down"),
            |_: &Path| needs_api("local stop"),
        );
        let stopped =
            exit_cleanup_reporting(&shell, &root, |_| Ok(0), down, intelligence, |_, _| {});
        assert_eq!(restarts.get(), 1);
        assert_eq!(stopped.lines(), Vec::<String>::new());

        // OpenBot already stopped, as on D: the back end's stop still comes after the heal.
        api.set(false);
        restarts.set(0);
        let (down, intelligence) = healed_once_before(
            |_: &Path| {
                restarts.set(restarts.get() + 1);
                api.set(true);
            },
            |_: &Path| Ok(()),
            |_: &Path| needs_api("local stop"),
        );
        let stopped =
            exit_cleanup_reporting(&shell, &root, |_| Ok(0), down, intelligence, |_, _| {});
        assert_eq!(restarts.get(), 1);
        assert_eq!(stopped.lines(), Vec::<String>::new());
        let _ = std::fs::remove_dir_all(root);
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
                intelligence: Some("Backend stop failed: the CLI timed out".into()),
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
            Err("Backend stop failed: the CLI timed out".into()),
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
        assert_eq!(failures.lines(), ["Backend stop failed: the CLI timed out"]);
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
            "this build has no command-line tool to stop the backend OpenBot created"
        );
        assert_eq!(
            failed(Err(local_eval::Failure::Timeout)),
            "the backend's command-line tool did not stop the backend (timeout)"
        );
        assert_eq!(
            failed(Ok(local_eval_report(
                local_eval::Outcome::Blocked,
                Some(local_eval::Reason::LocalCommandBusy)
            ))),
            "the backend's command-line tool did not stop the backend (blocked: local-command-busy)"
        );
        assert_eq!(
            failed(Ok(local_eval_report(local_eval::Outcome::Failed, None))),
            "the backend's command-line tool did not stop the backend (failed)"
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
                "Backend stop failed: this build has no command-line tool to stop the backend \
                 OpenBot created"
            ]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    const NO_CLI_LINE: &str =
        "Backend stop failed: this build has no command-line tool to stop the backend OpenBot created";

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
        // Said in the window's words: the part of OpenBot that did not stop, not its product name.
        assert_eq!(
            problem.said,
            "When OpenBot last quit, some of its services didn't stop. They may still be running. \
             Stopping OpenBot again asks them to stop."
        );
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
        assert_eq!(
            problem.said,
            "OpenBot stopped, but some of its services didn't. They may still be running."
        );
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
        local_eval_completed_for(stack, &[])
    }

    /// `local_eval_completed`, for a stack the CLI records for `folders` (`appPaths`).
    fn local_eval_completed_for(stack: &str, folders: &[&Path]) -> local_eval::Report {
        let app_paths: Vec<_> = folders
            .iter()
            .map(|folder| serde_json::json!({ "path": folder, "missing": false }))
            .collect();
        let listing = serde_json::json!({
            "version": 1,
            "command": "local list",
            "status": "completed",
            "stacks": [{
                "id": stack,
                "appPaths": app_paths,
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
                local_eval_completed_for("local-67db320bed3f3e893a4f8122", &[&root]),
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
            set_up_local_eval_at(&root, |_| Err(local_eval::Failure::Timeout.into())),
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
                local_eval_completed_for("local-abc123", &[&root]),
                LOCAL_EVAL_PIN.to_owned(),
            ))
        })
        .unwrap();
        assert!(!local_eval_state::read(&root, None)
            .unwrap()
            .tied_to_openbot());
        let _ = std::fs::remove_dir_all(root);
    }

    /**
    A stack `local setup` reported that the CLI records for another folder is never OpenBot's.

    Found with a CLI that resumed the stack someone set up in their home folder for `~/OpenBot`:
    Desktop recorded it as one it created, so Stop and Quit would have stopped another app's
    stack. It is kept as shared, even over an earlier record that called it OpenBot's, and a stack
    recorded for OpenBot's folder alongside others is still OpenBot's.
    */
    #[test]
    fn a_stack_recorded_for_another_folder_is_never_recorded_as_openbots() {
        let home = temp_root("openbot-local-eval-setup-foreign");
        let root = home.join("OpenBot");
        std::fs::create_dir_all(&root).unwrap();
        let foreign = local_eval_completed_for("local-abc123", &[&home]);
        set_up_local_eval_at(&root, |_| Ok((foreign.clone(), LOCAL_EVAL_PIN.to_owned()))).unwrap();
        let state = local_eval_state::read(&root, None).unwrap();
        assert_eq!(state.stack, "local-abc123");
        assert!(!state.tied_to_openbot());

        // An earlier OpenBot recorded it as its own: setting up again takes that back.
        local_eval_state::begin(
            &root,
            &local_eval::StackId::parse("local-abc123").unwrap(),
            local_eval_state::Ownership::Created,
            LOCAL_EVAL_PIN,
        )
        .unwrap();
        set_up_local_eval_at(&root, |_| Ok((foreign, LOCAL_EVAL_PIN.to_owned()))).unwrap();
        assert!(!local_eval_state::read(&root, None)
            .unwrap()
            .tied_to_openbot());

        // A report that names no folder is not OpenBot's either.
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

        // OpenBot's own folder among the stack's folders: OpenBot's.
        local_eval_state::clear(&root).unwrap();
        set_up_local_eval_at(&root, |_| {
            Ok((
                local_eval_completed_for("local-def456", &[&home, &root]),
                LOCAL_EVAL_PIN.to_owned(),
            ))
        })
        .unwrap();
        let state = local_eval_state::read(&root, None).unwrap();
        assert_eq!(state.stack, "local-def456");
        assert!(state.tied_to_openbot());
        let _ = std::fs::remove_dir_all(home);
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
        // Kept at 127.0.0.1 where the CLI wrote `localhost`: the browser is handed the gateway's.
        for line in [
            "INTELLIGENCE_API_URL=http://127.0.0.1:64770",
            "INTELLIGENCE_GATEWAY_WS_URL=ws://127.0.0.1:64772",
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
        let key = intelligence_key_for_start(&root, |_, name| {
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
                ("INTELLIGENCE_API_URL", "http://127.0.0.1:64770"),
                ("INTELLIGENCE_GATEWAY_WS_URL", "ws://127.0.0.1:64772"),
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
        // Start wrote the CLI's `localhost` addresses as 127.0.0.1: still this stack's own.
        std::fs::write(
            root.join(".env"),
            "INTELLIGENCE_API_URL=http://127.0.0.1:64770\nINTELLIGENCE_GATEWAY_WS_URL=ws://127.0.0.1:64772\n",
        )
        .unwrap();
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

    /// Settings › This computer › Details said "Installed in \\?\C:\Users\Administrator\OpenBot" on
    /// Windows. The folder there is the one the app remembered, read at launch into the shell and
    /// named by `read_desktop_status`; this follows it the same way.
    #[test]
    fn details_name_the_installation_folder_without_the_windows_extended_length_prefix() {
        let config = temp_root("openbot-details-installed-in");
        let root = config.join("OpenBot");
        std::fs::create_dir_all(&root).unwrap();
        preparation::save_selected_root(&config, &root).unwrap();
        let shown = |config: &Path| {
            let shell = Shell::default();
            remember_selected_root(&shell, &preparation::selected_root(config).unwrap());
            cleanup_root(&shell, &stack::default_root())
                .display()
                .to_string()
        };

        let installed_in = shown(&config);
        assert!(!installed_in.starts_with(r"\\?\"), "{installed_in}");
        assert_eq!(
            std::fs::canonicalize(&installed_in).unwrap(),
            std::fs::canonicalize(&root).unwrap()
        );

        // What an app before this fix left saved on Windows.
        #[cfg(windows)]
        {
            std::fs::write(
                config.join("last-launched-root.json"),
                r#""\\\\?\\C:\\Users\\Administrator\\OpenBot""#,
            )
            .unwrap();
            assert_eq!(shown(&config), r"C:\Users\Administrator\OpenBot");
        }
        std::fs::remove_dir_all(config).unwrap();
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
                    // macOS accepts inherit the listener's nonblocking mode. Only accept polls;
                    // a connected fixture request uses the bounded blocking I/O below.
                    stream.set_nonblocking(false).unwrap();
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
        ["ps","--all","--quiet","--no-trunc","--filter",_] => (),
        ["compose","ps","--format",_] => (),
        ["compose","up",..] => {
            fs::write(cwd.join("fixture-containers-running"),&identity).unwrap();
            if cwd.join("fail-up").exists() { eprintln!("synthetic partial up failure");std::process::exit(71); }
        }
        ["compose","ps","-a",..] => { eprintln!("synthetic start barrier");std::process::exit(72); }
        ["compose","-f","docker-compose.yml","config","--format","json"] => println!("{{\"services\":{{\"supervisor\":{{\"environment\":{{\"COMPUTER_NAMESPACE\":\"fixture\"}}}}}}}}"),
        ["compose","-f","docker-compose.yml","stop","supervisor"] => (),
        ["ps","--quiet","--filter",_,"--filter",_] => (),
        ["compose","-f","docker-compose.yml","--profile","harness","--profile","openbot","down"] => {
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
                remember_local_intelligence_key(root);
                let result = self.invoke("start_stack", serde_json::json!({
                    "root":root,"apiUrl":"https://intelligence.example.test","gatewayWsUrl":"wss://gateway.example.test",
                    "model":model,"harness":null,
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
                "synthetic start barrier"
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
                    "--profile",
                    "openbot",
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
                    "synthetic start barrier"
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
                    .contains("synthetic start barrier"));
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
                .contains("synthetic start barrier"));
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
                "compose up -d --no-build --pull never postgres agent-computer server worker",
                None,
            ),
            "anthropic-api" => {
                model = serde_json::json!({"provider":"anthropic", "login":"api-key", "apiKey":"synthetic-anthropic-key"});
                choice = serde_json::json!({"id":"langgraph"});
                ("compose --profile harness up -d --no-build --pull never postgres agent-computer server worker agent-harness", Some("agent-langgraph-agui"))
            }
            "compatible" => {
                model = serde_json::json!({"provider":"openai-compatible", "login":"endpoint", "baseUrl":"http://127.0.0.1:11434/v1", "model":"synthetic-model", "apiKey":""});
                (
                    "compose up -d --no-build --pull never postgres agent-computer server worker",
                    None,
                )
            }
            "installed" => {
                choice = serde_json::json!({"id":"langgraph"});
                ("compose --profile harness up -d --no-build --pull never postgres agent-computer server worker agent-harness", Some("agent-langgraph-agui"))
            }
            "none" => {
                choice = serde_json::Value::Null;
                (
                    "compose up -d --no-build --pull never postgres agent-computer server worker",
                    None,
                )
            }
            "chatgpt-plan" => {
                model = serde_json::json!({"provider":"openai", "login":"plan", "token":"{\"refresh_token\":\"synthetic-plan\"}"});
                ("compose --profile harness up -d --no-build --pull never postgres agent-computer server worker agent-harness", Some("agent-langgraph-agui"))
            }
            "claude-plan" => {
                model = serde_json::json!({"provider":"anthropic", "login":"plan", "token":"synthetic-claude-plan"});
                ("compose --profile harness up -d --no-build --pull never postgres agent-computer server worker agent-harness", Some("agent-claude-sdk"))
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
            .invoke_handler(tauri::generate_handler![start_stack])
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
        remember_local_intelligence_key(&root);
        let problem = invoke("start_stack", serde_json::json!({
            "root":root, "apiUrl":"https://intelligence.example.test", "gatewayWsUrl":"wss://gateway.example.test",
            "model":model, "harness":choice,
        })).expect_err("intentional barrier after up prevents host startup");
        let commands = std::fs::read_to_string(&record).unwrap_or_default();
        assert!(
            problem["detail"]
                .as_str()
                .unwrap_or_default()
                .contains("synthetic start barrier"),
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
        // Migrations run once, as the dependency `up` starts before `server`: never a second
        // `compose run migrate` after it.
        assert!(!commands.contains("migrate"), "{commands}");
        assert!(!root.join(".logs").exists(), "no host runtime was launched");
        // The server container's own credential reaches Compose for `up`, and only Compose.
        assert_eq!(
            std::fs::read_to_string(root.join("host-token-at-up")).ok(),
            Some("43".to_string()),
            "case={case}: Compose must be handed the host token before it starts the server"
        );
        assert!(!std::fs::read_to_string(root.join(".env"))
            .unwrap()
            .contains("OPENBOT_DESKTOP_HOST_TOKEN"));
        // Compose's bind mount does not create the sign-in folder, so Start must have.
        assert!(root.join(".openbot").is_dir());
        // Each Bot's computer goes on the network the server container is on.
        assert_eq!(
            openbot_env::read_already_set(&root.join(".env"), &["COMPUTER_NETWORK"])
                .unwrap()
                .get("COMPUTER_NETWORK"),
            Some(&format!("{}_default", stack::DESKTOP_PROJECT))
        );
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
            Some("../examples/personal")
        );
        // The personal edition raises no bundled Bot, so none is advertised, whatever the model.
        assert_eq!(
            settings
                .get("MANAGED_AGENT_AG_UI_URL")
                .map(String::as_str)
                .unwrap_or(""),
            "",
            "case={case}, persisted advertisement must match actual Start services"
        );
        if case.starts_with("remote") || case == "compatible" {
            assert_eq!(settings.get("PICKED_HARNESS_URL"), Some(&remote));
            assert_eq!(
                settings.get("PICKED_HARNESS_KIND").map(String::as_str),
                Some("remote-ag-ui")
            );
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
                "defaultPackage":"../examples/fintech",
                "noHostStartup":true, "nativeGui":false, "realEngineOrDatabase":false,
            })
        );
    }

    #[test]
    fn remote_harness_start_ipc_skips_local_service_and_persists_the_endpoint() {
        if crate::test_support::isolated_process(
            "tests::remote_harness_start_ipc_skips_local_service_and_persists_the_endpoint",
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
        remember_local_intelligence_key(&root);
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
        assert!(
            commands.contains(
                "\tcompose up -d --no-build --pull never postgres agent-computer server worker\n"
            ),
            "{commands}"
        );
        assert!(!commands.contains("compose run"), "{commands}");
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

    /// Start never waits for account attribution. A CLI that takes longer than the handshake's
    /// eight-second budget to answer `telemetry link` must not show in how long Start takes: the
    /// runtime is handed the identity as it stands, and the link runs after Start, in the
    /// background.
    #[test]
    fn start_does_not_wait_for_a_slow_telemetry_link() {
        if crate::test_support::isolated_process(
            "tests::start_does_not_wait_for_a_slow_telemetry_link",
        ) {
            return;
        }
        std::env::remove_var("COPILOTKIT_TELEMETRY_DISABLED");
        std::env::remove_var("DO_NOT_TRACK");
        let cli = desktop_telemetry::fake_cli::FakeCli::pinned("openbot-slow-link-cli", true);
        let root = temp_root("openbot-slow-link-start");
        write_installed_deployment(&root);
        remember_local_intelligence_key(&root);
        let record = temp_root("openbot-slow-link-record").join("commands.log");
        std::fs::create_dir_all(record.parent().expect("record parent")).unwrap();
        let _path = SerializedPath::set_only_with("docker", "dead-service");
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .manage(desktop_telemetry::DesktopTelemetry::for_tests(
                temp_root("openbot-slow-link-telemetry"),
                true,
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();

        let asked = std::time::Instant::now();
        let problem = tauri::async_runtime::block_on(start_stack_inner(
            app.handle().clone(),
            root.clone(),
            "https://intelligence.example.test".into(),
            "wss://gateway.example.test".into(),
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
        ))
        .expect_err("the fixture's dead service fails Start after the identity handoff");
        let took = asked.elapsed();

        assert_eq!(problem.said, "Part of OpenBot stopped during startup.");
        let commands = std::fs::read_to_string(&record).expect("command record");
        assert!(
            commands.contains(
                "\tcompose up -d --no-build --pull never postgres agent-computer server worker\n"
            ),
            "Start reached the runtime handoff: {commands}"
        );
        // Not on Start's path at all: when Start returns, the link has not been asked for. (Before,
        // Start ran it and joined it, so the call was there and Start took its 8-second budget.)
        // How long Start itself takes depends on the platform's fake engine, so that is bounded
        // only by the fake CLI's own 30 seconds.
        assert_eq!(
            cli.calls(),
            "",
            "Start ran `telemetry link` and waited {took:?} for it"
        );
        assert!(
            took < std::time::Duration::from_secs(30),
            "Start waited {took:?} on a slow telemetry link"
        );
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(record.parent().expect("record parent"));
        let _ = std::fs::remove_dir_all(&cli.dir);
    }

    /// The personal edition raises no bundled Bot, so one an earlier Start left exited is neither
    /// raised nor blamed: Start fails for the service it did raise, and only for that one.
    #[test]
    fn start_raises_no_bundled_bot_and_is_not_failed_by_a_stale_ones_exit() {
        if crate::test_support::isolated_process(
            "tests::start_raises_no_bundled_bot_and_is_not_failed_by_a_stale_ones_exit",
        ) {
            return;
        }
        let root = temp_root("openbot-anthropic-bot-selection-start");
        write_installed_deployment(&root);
        remember_local_intelligence_key(&root);
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
        ))
        .expect_err("a dead agent-computer must fail Start");

        let commands = std::fs::read_to_string(&record).expect("command record");
        assert!(
            commands.contains(
                "\tcompose up -d --no-build --pull never postgres agent-computer server worker\n"
            ),
            "{commands}"
        );
        assert_eq!(problem.said, "Part of OpenBot stopped during startup.");
        let detail = problem.detail.as_deref().unwrap_or_default();
        assert!(
            detail.contains("agent-computer stopped: agent-computer died after boot"),
            "{detail}"
        );
        for bot in ["agent-bot", "agent-langgraph"] {
            assert!(
                !detail.contains(bot),
                "a stale, unrequested {bot} exit must not fail Start: {detail}"
            );
            assert!(
                !commands.contains(&format!("\tcompose logs --tail 3 {bot}\n")),
                "a stale, unrequested {bot} should not get reported: {commands}"
            );
        }
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(record.parent().expect("record parent"));
    }

    /// What a Start through the app's own command sends: `start_stack`, on the fake engine.
    fn start_through_the_command(
        app: &tauri::App<tauri::test::MockRuntime>,
        root: &Path,
    ) -> Result<(), Problem> {
        tauri::async_runtime::block_on(start_stack(
            app.handle().clone(),
            root.display().to_string(),
            "https://intelligence.example.test".into(),
            "wss://gateway.example.test".into(),
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
        ))
    }

    fn setup_failures(app: &tauri::App<tauri::test::MockRuntime>) -> Vec<telemetry::EventData> {
        app.state::<desktop_telemetry::DesktopTelemetry>()
            .queued()
            .into_iter()
            .filter(|event| matches!(event, telemetry::EventData::SetupFailed { .. }))
            .collect()
    }

    /// A failed `compose up` returned from Start with no row saying it failed, and no event: of
    /// the installs that never ran, most sent no error at all. Every failed Start now sends one
    /// `setup_failed`, at the step it was in, classed by what the engine said, and one only: a
    /// row that already said it failed (a service that exited) is not counted twice.
    #[test]
    fn every_failed_start_sends_one_setup_failed() {
        if crate::test_support::isolated_process("tests::every_failed_start_sends_one_setup_failed")
        {
            return;
        }
        std::env::remove_var("COPILOTKIT_TELEMETRY_DISABLED");
        std::env::remove_var("DO_NOT_TRACK");
        for (scenario, error_class, said) in [
            (
                "up-fails",
                telemetry::SetupErrorClass::PermissionDenied,
                // The sentence is the engine's to choose (`problem::said_about`).
                "",
            ),
            (
                "dead-service",
                telemetry::SetupErrorClass::Unknown,
                "Part of OpenBot stopped during startup.",
            ),
        ] {
            let root = temp_root(&format!("openbot-failed-start-{scenario}"));
            write_installed_deployment(&root);
            remember_local_intelligence_key(&root);
            let _path = SerializedPath::set_only_with("docker", scenario);
            let app = tauri::test::mock_builder()
                .manage(Shell::default())
                .manage(desktop_telemetry::DesktopTelemetry::for_tests(
                    temp_root(&format!("openbot-failed-start-telemetry-{scenario}")),
                    true,
                ))
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let problem = start_through_the_command(&app, &root).expect_err(scenario);
            assert!(problem.said.starts_with(said), "{scenario}: {problem:?}");
            assert_eq!(
                setup_failures(&app),
                vec![telemetry::EventData::SetupFailed {
                    step: telemetry::Step::Install,
                    error_class,
                    failing_step: Some(telemetry::FailingStep::Services),
                    cli_reason: None,
                    cli_failure: None,
                    resources: None,
                }],
                "{scenario}: {problem:?}"
            );
            let _ = std::fs::remove_dir_all(root);
        }

        // Opted out: a failed Start sends nothing.
        let root = temp_root("openbot-failed-start-opted-out");
        write_installed_deployment(&root);
        remember_local_intelligence_key(&root);
        let _path = SerializedPath::set_only_with("docker", "up-fails");
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .manage(desktop_telemetry::DesktopTelemetry::for_tests(
                temp_root("openbot-failed-start-telemetry-off"),
                false,
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        assert!(start_through_the_command(&app, &root).is_err());
        assert_eq!(setup_failures(&app), vec![]);
        let _ = std::fs::remove_dir_all(root);
    }

    /// The CLI's answer to a `local setup` refused for resources, as the 4.34.0 CLI prints it.
    const SETUP_REFUSED_FOR_DISK: &str = r#"{"version":1,"command":"local setup","status":"failed","error":{"code":"LOCAL_DOCKER_RESOURCES_SHORT","message":"Docker available resources: 9.871234 CPUs (requires 4), 18.9 GiB RAM available (requires 4), 0 GiB free storage (requires 40). Stop other container workloads or increase Docker resources, then retry local setup."},"nextAction":{"reason":"local_command_failed","summary":"The local command did not finish.","instructions":[],"resumeCommand":"npx --yes copilotkit local setup --json","url":null,"linkLabel":null,"linkFile":null,"caveats":[],"requiredEnvVars":[],"artifacts":[]},"diagnostics":[]}"#;

    /// A failed `local setup` was handed back to the window and recorded nowhere. It is sent now,
    /// by the desktop, as one `setup_failed` at `local_setup` with the CLI's reason and what the
    /// engine had against what setup needs, to the ingest as JSON. Only closed values and numbers:
    /// not the folder, the user's name, nor the CLI's message. Opted out, in the environment or in
    /// Settings, nothing reaches the ingest.
    #[test]
    fn a_failed_local_setup_sends_setup_failed_to_the_ingest() {
        if crate::test_support::isolated_process(
            "tests::a_failed_local_setup_sends_setup_failed_to_the_ingest",
        ) {
            return;
        }
        std::env::remove_var("COPILOTKIT_TELEMETRY_DISABLED");
        std::env::remove_var("DO_NOT_TRACK");
        // No engine to find: the CLI's own answer is the whole of the failure.
        let empty = temp_root("openbot-local-setup-no-engine");
        std::fs::create_dir_all(&empty).unwrap();
        std::env::set_var("PATH", &empty);
        let cli = desktop_telemetry::fake_cli::FakeCli::pinned("openbot-local-setup-cli", false);
        cli.answer(SETUP_REFUSED_FOR_DISK, 1);
        let sink = desktop_telemetry::sink::Sink::start();
        let set_up = |sharing: bool, label: &str| {
            let root = temp_root(label);
            let app = tauri::test::mock_builder()
                .manage(Shell::default())
                .manage(desktop_telemetry::DesktopTelemetry::for_tests_sending(
                    temp_root(&format!("{label}-telemetry")),
                    sharing,
                    sink.endpoint.clone(),
                ))
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let report = tauri::async_runtime::block_on(set_up_local_eval(
                app.handle().clone(),
                format!("{label}-attempt"),
                root.display().to_string(),
                None,
            ));
            (app, root, report)
        };

        let (app, root, report) = set_up(true, "openbot-local-setup-failed");
        let report = report.expect("the CLI answered");
        assert_eq!(report.outcome, local_eval::Outcome::Failed);
        assert!(cli.calls().contains("local setup"), "{}", cli.calls());
        app.state::<desktop_telemetry::DesktopTelemetry>().deliver();
        let (id, sent) = sink
            .next(std::time::Duration::from_secs(10))
            .expect("setup_failed reached the ingest");
        println!(
            "SAMPLE PAYLOAD (failed local setup), X-CopilotKit-Telemetry-Id: {id}\n{}",
            serde_json::to_string_pretty(&sent).unwrap()
        );
        assert_eq!(sent["event"], "oss.desktop.setup_failed");
        assert_eq!(
            sent["properties"],
            serde_json::json!({
                "kind": "setup_failed",
                "step": "install",
                "error_class": "insufficient_resources",
                "failing_step": "local_setup",
                "cli_reason": "resources_short",
                "resources": {
                    "cpu_short": false, "memory_short": false, "disk_short": true,
                    "cpu_needed_millis": 4000, "cpu_available_millis": 9800,
                    "memory_needed_mib": 4096, "memory_available_mib": 19353,
                    "disk_needed_mib": 40960, "disk_available_mib": 0
                }
            })
        );
        let wire = sent.to_string();
        let user = std::env::var("USER").unwrap_or_default();
        for private in [
            root.display().to_string(),
            "Docker available resources".to_owned(),
            "npx".to_owned(),
            "@".to_owned(),
        ]
        .into_iter()
        .chain((user.len() > 2).then_some(user))
        {
            assert!(!wire.contains(&private), "{private} in {wire}");
        }
        assert_eq!(
            sent.as_object().unwrap().keys().collect::<Vec<_>>(),
            [
                "event",
                "event_id",
                "global_properties",
                "package",
                "properties",
                "ts"
            ]
        );

        // Opted out in the environment: the same failure, and nothing reaches the ingest.
        let (app, _, report) = set_up(false, "openbot-local-setup-opted-out");
        assert_eq!(report.unwrap().outcome, local_eval::Outcome::Failed);
        app.state::<desktop_telemetry::DesktopTelemetry>().deliver();
        assert!(sink.next(std::time::Duration::from_secs(2)).is_none());

        // Turned off in Settings after the launch: nothing either.
        let settings = temp_root("openbot-local-setup-settings");
        let (app, _, _) = set_up(true, "openbot-local-setup-settings-on");
        let _ = sink.next(std::time::Duration::from_secs(10));
        desktop_telemetry::set_usage_data_in(
            &settings,
            Some(&app.state::<desktop_telemetry::DesktopTelemetry>()),
            false,
        )
        .unwrap();
        let report = tauri::async_runtime::block_on(set_up_local_eval(
            app.handle().clone(),
            "openbot-local-setup-settings-off".into(),
            temp_root("openbot-local-setup-settings-root")
                .display()
                .to_string(),
            None,
        ));
        assert_eq!(report.unwrap().outcome, local_eval::Outcome::Failed);
        app.state::<desktop_telemetry::DesktopTelemetry>().deliver();
        assert!(sink.next(std::time::Duration::from_secs(2)).is_none());
        let _ = std::fs::remove_dir_all(&cli.dir);
    }

    /// A CLI that finds a folder's stack as the CopilotKit CLI does: `.copilotkit/local.json` in the
    /// folder it runs in, then in every folder above it, or with `--app-path <folder>` only in that
    /// folder. `local setup` resumes the stack it finds, else the stack recorded for the folder, else
    /// makes one for the folder; `local connect` writes the `.env` of the folder whose reference it
    /// found. Its JSON is the CLI's, as it printed `local setup`, `local connect` and `local list` for
    /// these stacks. Stacks are kept in `stacks` beside it, one per line: id, app folder, API port;
    /// the gateway and dashboard ports follow the API's. Every call goes to `calls`.
    #[cfg(unix)]
    const FOLDER_CLI: &str = r##"
use std::path::{Path, PathBuf};

const MADE: &str = "local-eeeeeeeeeeeeeeeeeeeeeeee";

fn main() {
    let dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--warm") {
        return;
    }
    let mut calls = std::fs::read_to_string(dir.join("calls")).unwrap_or_default();
    calls.push_str(&args.join(" "));
    calls.push('\n');
    std::fs::write(dir.join("calls"), calls).unwrap();
    let named = args
        .iter()
        .position(|arg| arg == "--app-path")
        .map(|at| PathBuf::from(&args[at + 1]));
    let folder = named
        .clone()
        .unwrap_or_else(|| std::env::current_dir().unwrap())
        .canonicalize()
        .unwrap();
    let reference = folder
        .ancestors()
        .take(if named.is_some() { 1 } else { usize::MAX })
        .find_map(|at| {
            let text = std::fs::read_to_string(at.join(".copilotkit/local.json")).ok()?;
            Some((at.to_path_buf(), field(&text, "stackId")))
        });
    let mut stacks: Vec<(String, PathBuf, u16)> = std::fs::read_to_string(dir.join("stacks"))
        .unwrap_or_default()
        .lines()
        .map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            (parts[0].to_owned(), PathBuf::from(parts[1]), parts[2].parse().unwrap())
        })
        .collect();
    let described = |stacks: &[(String, PathBuf, u16)], id: &str| {
        let (_, app, api) = stacks.iter().find(|stack| stack.0 == id).unwrap();
        format!(
            r#"{{"id":"{id}","appPaths":[{{"path":"{}","missing":false}}],"installedRelease":"0.16.0-rc.10","step":"ready","engine":"docker-desktop","urls":{{"api":"http://localhost:{api}","dashboard":"http://localhost:{}","gateway":"ws://localhost:{}"}},"failedStep":null,"update":null}}"#,
            escaped(app),
            api + 2,
            api + 1
        )
    };
    match args.get(1).map(String::as_str) {
        Some("list") => {
            let listed: Vec<String> = stacks.iter().map(|stack| described(&stacks, &stack.0)).collect();
            println!(
                r#"{{"version":1,"command":"local list","status":"completed","stacks":[{}],"nextAction":null,"error":null,"diagnostics":[]}}"#,
                listed.join(",")
            );
        }
        Some("setup") => {
            let id = match reference {
                Some((_, id)) => id,
                None => {
                    let id = match stacks.iter().find(|stack| stack.1 == folder) {
                        Some(stack) => stack.0.clone(),
                        None => {
                            stacks.push((MADE.to_owned(), folder.clone(), 51796));
                            let kept: Vec<String> = stacks
                                .iter()
                                .map(|(id, app, api)| format!("{id}\t{}\t{api}", app.display()))
                                .collect();
                            std::fs::write(dir.join("stacks"), kept.join("\n")).unwrap();
                            MADE.to_owned()
                        }
                    };
                    std::fs::create_dir_all(folder.join(".copilotkit")).unwrap();
                    std::fs::write(
                        folder.join(".copilotkit/local.json"),
                        format!(r#"{{"stackId":"{id}","appPath":"{}"}}"#, escaped(&folder)),
                    )
                    .unwrap();
                    id
                }
            };
            println!(
                r#"{{"version":1,"command":"local setup","status":"completed","stack":{},"learning":{{"configuration":"incomplete","verified":false}},"samples":null,"samplesError":null,"nextAction":{{"reason":"confirmation_required","summary":"The stack is ready. Review and approve this app connection separately.","instructions":["Run local connect to review the app settings that will change. Prior settings are saved privately before replacement.","Run npx --prefer-offline --yes https://pkg.pr.new/CopilotKit/Intelligence/copilotkit@f5c45eb local login --stack {id} to open the dashboard signed in."],"resumeCommand":"copilotkit local connect --approve-connection","url":null,"linkLabel":null,"linkFile":null,"caveats":[],"requiredEnvVars":[],"artifacts":[]}},"error":null,"diagnostics":[]}}"#,
                described(&stacks, &id)
            );
        }
        Some("connect") => {
            let Some((at, id)) = reference else {
                println!(r#"{{"version":1,"command":"local connect","status":"failed","error":{{"code":"LOCAL_COMMAND_FAILED","message":"No recorded local stack was found. Run `copilotkit local list` or start local setup."}},"nextAction":{{"reason":"local_command_failed","summary":"The local command did not finish. Check local status for the recorded failed step, then resume the command. No automatic rollback was requested.","instructions":[],"resumeCommand":"copilotkit local connect --json","url":null,"linkLabel":null,"linkFile":null,"caveats":[],"requiredEnvVars":[],"artifacts":[]}},"diagnostics":[]}}"#);
                std::process::exit(1);
            };
            let api = stacks.iter().find(|stack| stack.0 == id).unwrap().2;
            let written = [
                format!("INTELLIGENCE_API_URL=http://localhost:{api}"),
                format!("INTELLIGENCE_GATEWAY_WS_URL=ws://localhost:{}", api + 1),
                format!("CPK_INTELLIGENCE_API_KEY=cpk-42_1111111111111111_{}", "e".repeat(64)),
                "SL_ENABLED=true".to_owned(),
            ];
            let mut env: Vec<String> = std::fs::read_to_string(at.join(".env"))
                .unwrap_or_default()
                .lines()
                .filter(|line| !written.iter().any(|set| set.split('=').next() == line.split('=').next()))
                .map(str::to_owned)
                .collect();
            env.extend(written);
            std::fs::write(at.join(".env"), env.join("\n") + "\n").unwrap();
            println!(
                r#"{{"version":1,"command":"local connect","status":"completed","stack":{},"conflicts":[],"nextAction":null,"error":null,"diagnostics":[]}}"#,
                described(&stacks, &id)
            );
        }
        _ => std::process::exit(3),
    }
}

fn field(json: &str, name: &str) -> String {
    let start = json.find(&format!("\"{name}\":\"")).unwrap() + name.len() + 4;
    json[start..start + json[start..].find('"').unwrap()].to_owned()
}

fn escaped(path: &Path) -> String {
    path.display().to_string().replace('\\', "\\\\").replace('"', "\\\"")
}
"##;

    /**
    Someone who once ran `copilotkit local setup` in their home folder, then started OpenBot
    Desktop, which keeps its installation in `~/OpenBot`.

    The CLI found `~/.copilotkit/local.json` above `~/OpenBot` and resumed the home folder's stack
    for it; `local connect` then wrote the home folder's `.env`, and Start stopped with "The
    connection settings do not match the backend that was set up". Desktop also recorded the home
    folder's stack as one it created, so Stop and Quit would have stopped it.

    Through the window's own `set_up_local_eval` and `connect_local_eval`, against a CLI that finds
    stacks as the real one does: OpenBot passes `--app-path`, gets a stack of its own, recorded as
    its own, `~/OpenBot/.env` names it, and Start takes its key. The home folder's stack, reference
    and `.env` are left alone.
    */
    #[cfg(unix)]
    #[test]
    fn a_backend_set_up_in_a_folder_above_openbots_never_becomes_openbots() {
        if crate::test_support::isolated_process(
            "tests::a_backend_set_up_in_a_folder_above_openbots_never_becomes_openbots",
        ) {
            return;
        }
        const HOME_STACK: &str = "local-dddddddddddddddddddddddd";
        const OPENBOT_STACK: &str = "local-eeeeeeeeeeeeeeeeeeeeeeee";
        let empty = temp_root("openbot-parent-stack-path");
        std::fs::create_dir_all(&empty).unwrap();
        std::env::set_var("PATH", &empty);
        let cli = temp_root("openbot-parent-stack-cli");
        std::fs::create_dir_all(&cli).unwrap();
        std::fs::write(cli.join("cli.rs"), FOLDER_CLI).unwrap();
        let program = cli.join("cli");
        crate::test_support::compile_fixture(&cli.join("cli.rs"), &program);
        assert!(std::process::Command::new(&program)
            .arg("--warm")
            .status()
            .unwrap()
            .success());
        use sha2::Digest;
        let digest: String = sha2::Sha256::digest(std::fs::read(&program).unwrap())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_PROGRAM", &program);
        std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_PROGRAM_SHA256", digest);
        std::env::remove_var("OPENBOT_DEV_LOCAL_EVAL_ENTRY");

        // The home folder, where `copilotkit local setup` once ran, and OpenBot's folder in it.
        let home = temp_root("openbot-parent-stack-home");
        std::fs::create_dir_all(home.join(".copilotkit")).unwrap();
        let home = home.canonicalize().unwrap();
        std::env::set_var("HOME", &home);
        std::env::remove_var("XDG_CONFIG_HOME");
        let reference = format!(
            r#"{{"stackId":"{HOME_STACK}","appPath":"{}"}}"#,
            home.display()
        );
        std::fs::write(home.join(".copilotkit/local.json"), &reference).unwrap();
        std::fs::write(
            cli.join("stacks"),
            format!("{HOME_STACK}\t{}\t52796", home.display()),
        )
        .unwrap();
        let root = home.join("OpenBot");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(".env"),
            "INTELLIGENCE_API_URL=https://hosted.example\nSERVER_PORT=3001\n",
        )
        .unwrap();

        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .manage(desktop_telemetry::DesktopTelemetry::for_tests(
                temp_root("openbot-parent-stack-telemetry"),
                false,
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let calls = || std::fs::read_to_string(cli.join("calls")).unwrap_or_default();

        let report = tauri::async_runtime::block_on(set_up_local_eval(
            app.handle().clone(),
            "openbot-parent-stack-setup".into(),
            root.display().to_string(),
            None,
        ))
        .unwrap_or_else(|error| panic!("{error:?}\n{}", calls()));
        let stack = report.stack.as_ref().expect("setup reported its stack");
        assert_eq!(stack.id, OPENBOT_STACK, "{}", calls());
        assert!(stack.lists_folder(&root));
        let state = local_eval_state::read(&root, None).unwrap();
        assert_eq!(state.stack, OPENBOT_STACK);
        assert!(state.tied_to_openbot());

        let connection = tauri::async_runtime::block_on(connect_local_eval(
            app.handle().clone(),
            "openbot-parent-stack-connect".into(),
            root.display().to_string(),
        ))
        .unwrap_or_else(|error| panic!("{error:?}\n{}", calls()));
        assert_eq!(connection.outcome, local_eval::Outcome::Completed);
        let env = std::fs::read_to_string(root.join(".env")).unwrap();
        for line in [
            "INTELLIGENCE_API_URL=http://127.0.0.1:51796",
            "INTELLIGENCE_GATEWAY_WS_URL=ws://127.0.0.1:51797",
            "SERVER_PORT=3001",
        ] {
            assert!(env.lines().any(|found| found == line), "{line}\n{env}");
        }
        assert!(!env.contains("CPK_INTELLIGENCE_API_KEY"), "{env}");
        assert!(local_eval_state::read(&root, None).unwrap().connected);

        // Start takes the key `local connect` gave OpenBot's own stack.
        let key = intelligence_key_for_start(&root, |root, name| {
            Ok(openbot_desktop_lib::vault::recall(root, name)?.unwrap_or_default())
        })
        .unwrap();
        assert_eq!(key, format!("cpk-42_1111111111111111_{}", "e".repeat(64)));

        // The home folder's stack is as it was.
        assert!(!home.join(".env").exists());
        assert_eq!(
            std::fs::read_to_string(home.join(".copilotkit/local.json")).unwrap(),
            reference
        );
        // Both calls name OpenBot's folder exactly.
        assert!(
            calls().contains(&format!(
                "local setup --defer-model --json --app-path {}",
                root.display()
            )),
            "{}",
            calls()
        );
        assert!(
            calls().contains(&format!(
                "local connect --approve-connection --json --app-path {}",
                root.display()
            )),
            "{}",
            calls()
        );
        let _ = std::fs::remove_dir_all(&cli);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A CLI that answers each `local` command it is asked with what the pinned CLI (6bfaa0f)
    /// printed for it, from the file of that name beside it. After a `local delete`, `list` and
    /// `setup` answer from their `-after` files. Every call is written to `calls`.
    #[cfg(unix)]
    const SCRIPTED_CLI: &str = r#"
fn main() {
    let dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--warm") {
        return;
    }
    let mut calls = std::fs::read_to_string(dir.join("calls")).unwrap_or_default();
    calls.push_str(&args.join(" "));
    calls.push('\n');
    std::fs::write(dir.join("calls"), calls).unwrap();
    let deleted = dir.join("deleted").exists();
    let (file, code) = match args.get(1).map(String::as_str) {
        Some("list") => (if deleted { "list-after" } else { "list" }, 0),
        Some("setup") if deleted => ("setup-after", 2),
        Some("setup") => ("setup", 1),
        Some("delete") => {
            std::fs::write(dir.join("deleted"), "").unwrap();
            ("delete", 0)
        }
        _ => std::process::exit(3),
    };
    print!("{}", std::fs::read_to_string(dir.join(file)).unwrap());
    std::process::exit(code);
}
"#;

    /**
    OpenBot Desktop 1.0.0, installed again after the earlier installation's `~/OpenBot`, app data
    and back end were deleted: the CopilotKit CLI still recorded a stack for `~/OpenBot`, whose
    private folder was gone. Every `local setup` stopped with "Restore the private setup and
    credentials files before resuming this stack", and the window said "Back end setup stopped".

    Through the window's own `set_up_local_eval`, against the CLI's real answers:
    - files gone, the stack this folder's alone: the CLI forgets that stack and setup starts fresh,
      here as far as the CopilotKit sign-in. Another stack the CLI records is never touched.
    - files there: the failure is the CLI's, as before. Nothing is deleted.
    - files damaged, or another app on the stack: plain words, and nothing is deleted.
    */
    #[cfg(unix)]
    #[test]
    fn a_stack_that_lost_its_private_files_is_set_up_again() {
        if crate::test_support::isolated_process(
            "tests::a_stack_that_lost_its_private_files_is_set_up_again",
        ) {
            return;
        }
        const STACK: &str = "local-0123456789abcdef01234567";
        const OTHER: &str = "local-5c600753e1ea594f035cb25c";
        // As the pinned CLI printed them on a Mac, for a stack whose private folder was deleted.
        const SETUP_FAILED: &str = r#"{"version":1,"command":"local setup","status":"failed","error":{"code":"LOCAL_COMMAND_FAILED","message":"Restore the private setup and credentials files before resuming this stack. Saved data was not changed."},"nextAction":{"reason":"local_command_failed","summary":"The local command did not finish. Check local status for the recorded failed step, then resume the command. No automatic rollback was requested.","instructions":["Inspect the recorded stack with npx --prefer-offline --yes https://pkg.pr.new/CopilotKit/Intelligence/copilotkit@6bfaa0f local status --json."],"resumeCommand":"npx --prefer-offline --yes https://pkg.pr.new/CopilotKit/Intelligence/copilotkit@6bfaa0f local setup --json","url":null,"linkLabel":null,"linkFile":null,"caveats":[],"requiredEnvVars":[],"artifacts":[]},"diagnostics":[]}"#;
        const SETUP_FRESH: &str = r#"{"version":1,"command":"local setup","status":"blocked","error":null,"nextAction":{"reason":"authentication_required","summary":"Run `copilotkit login`, then resume local setup to obtain an evaluation license.","instructions":["Complete sign-in, then rerun the local command with the same inputs."],"resumeCommand":"copilotkit login","url":null,"linkLabel":null,"linkFile":null,"caveats":[],"requiredEnvVars":[],"artifacts":[]},"diagnostics":[]}"#;
        let listed = |id: &str, paths: &[&Path]| {
            serde_json::json!({
                "id": id,
                "appPaths": paths.iter().map(|path| serde_json::json!({ "path": path, "missing": false })).collect::<Vec<_>>(),
                "installedRelease": "0.16.0-rc.10", "step": "ready", "engine": "docker-desktop",
                "urls": { "api": "http://localhost:51622", "dashboard": "http://localhost:51623", "gateway": "ws://localhost:51624" },
                "failedStep": null, "update": null,
            })
        };
        let listing = |stacks: Vec<serde_json::Value>| {
            serde_json::json!({ "version": 1, "command": "local list", "status": "completed", "stacks": stacks, "nextAction": null, "error": null, "diagnostics": [] }).to_string()
        };

        let empty = temp_root("openbot-lost-stack-path");
        std::fs::create_dir_all(&empty).unwrap();
        std::env::set_var("PATH", &empty);
        let cli = temp_root("openbot-lost-stack-cli");
        std::fs::create_dir_all(&cli).unwrap();
        std::fs::write(cli.join("cli.rs"), SCRIPTED_CLI).unwrap();
        let program = cli.join("cli");
        crate::test_support::compile_fixture(&cli.join("cli.rs"), &program);
        assert!(std::process::Command::new(&program)
            .arg("--warm")
            .status()
            .unwrap()
            .success());
        use sha2::Digest;
        let digest: String = sha2::Sha256::digest(std::fs::read(&program).unwrap())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_PROGRAM", &program);
        std::env::set_var("OPENBOT_DEV_LOCAL_EVAL_PROGRAM_SHA256", digest);
        std::env::remove_var("OPENBOT_DEV_LOCAL_EVAL_ENTRY");
        let home = temp_root("openbot-lost-stack-home");
        std::env::set_var("HOME", &home);
        std::env::remove_var("XDG_CONFIG_HOME");
        let private = openbot_desktop_lib::local_update::stack_dir(STACK).unwrap();
        let other_private = openbot_desktop_lib::local_update::stack_dir(OTHER).unwrap();
        std::fs::create_dir_all(&other_private).unwrap();

        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .manage(desktop_telemetry::DesktopTelemetry::for_tests(
                temp_root("openbot-lost-stack-telemetry"),
                false,
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let root = temp_root("openbot-lost-stack-installation");
        std::fs::create_dir_all(&root).unwrap();
        let kite = temp_root("openbot-lost-stack-another-app");
        std::fs::create_dir_all(&kite).unwrap();
        let set_up = |label: &str, here: Vec<serde_json::Value>| {
            for file in ["calls", "deleted"] {
                let _ = std::fs::remove_file(cli.join(file));
            }
            let mut stacks = here.clone();
            stacks.push(listed(OTHER, &[&kite]));
            std::fs::write(cli.join("list"), listing(stacks)).unwrap();
            std::fs::write(
                cli.join("list-after"),
                listing(vec![listed(OTHER, &[&kite])]),
            )
            .unwrap();
            std::fs::write(cli.join("setup"), SETUP_FAILED).unwrap();
            std::fs::write(cli.join("setup-after"), SETUP_FRESH).unwrap();
            std::fs::write(
                cli.join("delete"),
                serde_json::json!({ "version": 1, "command": "local delete", "status": "completed", "stack": here.first(), "connections": { "restored": [], "conflicts": [], "preserved": [] }, "clusterAlreadyAbsent": true, "nextAction": null, "error": null, "diagnostics": [] }).to_string(),
            )
            .unwrap();
            let report = tauri::async_runtime::block_on(set_up_local_eval(
                app.handle().clone(),
                format!("openbot-lost-stack-{label}"),
                root.display().to_string(),
                None,
            ));
            let calls = std::fs::read_to_string(cli.join("calls")).unwrap_or_default();
            (report, calls)
        };
        let deletes = |calls: &str| {
            calls
                .lines()
                .filter(|call| call.contains(" delete "))
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };

        // Gone, and this folder's alone: forgotten by the CLI, then set up from the start.
        let (report, calls) = set_up("gone", vec![listed(STACK, &[&root])]);
        let report = report.unwrap_or_else(|error| panic!("{error:?}\n{calls}"));
        assert_eq!(report.outcome, local_eval::Outcome::Blocked, "{calls}");
        assert_eq!(
            report.reason,
            Some(local_eval::Reason::AuthenticationRequired)
        );
        assert_eq!(
            deletes(&calls),
            [format!(
                "local delete --stack {STACK} --confirm-delete {STACK} --json"
            )],
            "{calls}"
        );
        assert_eq!(calls.matches("local setup").count(), 2, "{calls}");
        assert!(
            other_private.is_dir(),
            "another stack's files are never touched"
        );

        // There: the CLI's own failure, as before, and nothing deleted.
        std::fs::create_dir_all(&private).unwrap();
        std::fs::write(
            private.join("setup.json"),
            r#"{"licenseToken":"synthetic"}"#,
        )
        .unwrap();
        std::fs::write(private.join("secrets.json"), "{}").unwrap();
        let (report, calls) = set_up("there", vec![listed(STACK, &[&root])]);
        let report = report.unwrap_or_else(|error| panic!("{error:?}\n{calls}"));
        assert_eq!(report.outcome, local_eval::Outcome::Failed);
        assert_eq!(report.reason, Some(local_eval::Reason::LocalCommandFailed));
        assert!(deletes(&calls).is_empty(), "{calls}");

        // Damaged: plain words naming the folder, and nothing deleted.
        std::fs::write(private.join("setup.json"), "{").unwrap();
        let (report, calls) = set_up("damaged", vec![listed(STACK, &[&root])]);
        let Err(SetupError::Unrecorded(problem)) = report else {
            panic!("{report:?}\n{calls}");
        };
        assert!(
            problem.said.starts_with(
                "The saved settings of OpenBot's services on this computer can't be read."
            ),
            "{problem:?}"
        );
        assert!(
            problem.said.contains(&private.display().to_string()),
            "{problem:?}"
        );
        assert!(deletes(&calls).is_empty(), "{calls}");
        assert!(private.join("setup.json").is_file());

        // Gone, but another app uses the stack too: plain words, and nothing deleted.
        std::fs::remove_dir_all(&private).unwrap();
        let (report, calls) = set_up("shared", vec![listed(STACK, &[&root, &kite])]);
        let Err(SetupError::Unrecorded(problem)) = report else {
            panic!("{report:?}\n{calls}");
        };
        assert!(
            problem
                .said
                .contains("another app on this computer uses them too"),
            "{problem:?}"
        );
        assert!(deletes(&calls).is_empty(), "{calls}");

        for folder in [empty, cli, home, root, kite] {
            let _ = std::fs::remove_dir_all(folder);
        }
    }

    /// The Account step's sign-in said nothing: 22 installs that stopped there sent no event. A
    /// sign-in now sends `sign_in` started, and how it ended. Here the person cancels it while
    /// the CLI waits on the browser, and the ingest gets `started` then `cancelled`, with how long
    /// it took and nothing else.
    #[test]
    fn a_cancelled_sign_in_sends_started_then_cancelled() {
        if crate::test_support::isolated_process(
            "tests::a_cancelled_sign_in_sends_started_then_cancelled",
        ) {
            return;
        }
        std::env::remove_var("COPILOTKIT_TELEMETRY_DISABLED");
        std::env::remove_var("DO_NOT_TRACK");
        let empty = temp_root("openbot-sign-in-no-engine");
        std::fs::create_dir_all(&empty).unwrap();
        std::env::set_var("PATH", &empty);
        // A CLI that waits on the browser for longer than the test does.
        let cli = desktop_telemetry::fake_cli::FakeCli::pinned("openbot-sign-in-cli", true);
        let sink = desktop_telemetry::sink::Sink::start();
        let sign_in = |sharing: bool, attempt: &'static str| {
            let app = tauri::test::mock_builder()
                .manage(Shell::default())
                .manage(desktop_telemetry::DesktopTelemetry::for_tests_sending(
                    temp_root(&format!("{attempt}-telemetry")),
                    sharing,
                    sink.endpoint.clone(),
                ))
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let handle = app.handle().clone();
            let waiting = std::thread::spawn(move || {
                tauri::async_runtime::block_on(sign_in_to_copilotkit(handle, attempt.into()))
            });
            // The person cancels once the CLI is waiting on the browser.
            let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
            while !cli.calls().contains("login") && std::time::Instant::now() < until {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            cli.forget_calls();
            local_eval::cancel(attempt);
            let result = waiting.join().unwrap();
            app.state::<desktop_telemetry::DesktopTelemetry>().deliver();
            (app, result)
        };

        let (_app, result) = sign_in(true, "openbot-sign-in-cancelled");
        assert_eq!(result, Err(local_eval::Failure::Cancelled));
        let mut sent = Vec::new();
        while let Some((_, event)) = sink.next(std::time::Duration::from_secs(10)) {
            sent.push(event);
            if sent.len() == 2 {
                break;
            }
        }
        for event in &sent {
            println!(
                "SAMPLE PAYLOAD (cancelled sign-in)\n{}",
                serde_json::to_string_pretty(event).unwrap()
            );
        }
        assert_eq!(sent.len(), 2, "{sent:?}");
        assert_eq!(sent[0]["event"], "oss.desktop.sign_in");
        assert_eq!(
            sent[0]["properties"],
            serde_json::json!({ "kind": "sign_in", "outcome": "started" })
        );
        assert_eq!(sent[1]["event"], "oss.desktop.sign_in");
        let ended = sent[1]["properties"].as_object().unwrap();
        assert_eq!(ended["outcome"], "cancelled");
        assert!(ended["duration_ms"].is_u64());
        assert_eq!(
            ended.keys().collect::<Vec<_>>(),
            ["duration_ms", "kind", "outcome"]
        );

        // Opted out: the same sign-in, and nothing reaches the ingest.
        let (_app, result) = sign_in(false, "openbot-sign-in-opted-out");
        assert_eq!(result, Err(local_eval::Failure::Cancelled));
        assert!(sink.next(std::time::Duration::from_secs(2)).is_none());
        let _ = std::fs::remove_dir_all(&cli.dir);
    }

    /// A Compose file from a release that runs the server and worker as services.
    const INSTALLED_COMPOSE: &str = "services:\n  server: {}\n  worker: {}\n";

    /// The key `local connect` would have stored, which Start reads from the credential store.
    fn remember_local_intelligence_key(root: &Path) {
        openbot_desktop_lib::vault::remember(
            root,
            "INTELLIGENCE_API_KEY",
            "synthetic-intelligence-key",
        )
        .unwrap();
    }

    fn write_installed_deployment(root: &Path) {
        const DEPLOYMENT_VERSION: &str = "v0.0.8";
        std::fs::create_dir_all(root).unwrap();
        std::fs::write(root.join("docker-compose.yml"), INSTALLED_COMPOSE).unwrap();
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
        deployment::record(root, DEPLOYMENT_VERSION, false).unwrap();
        // Installed by this app, so its Compose project is decided and recorded already. Choosing
        // one is `stack::project`'s, tested in `stack`.
        std::fs::write(
            root.join(stack::PROJECT_FILE),
            serde_json::json!({ "project": stack::DESKTOP_PROJECT }).to_string(),
        )
        .unwrap();
        preparation::record(root, None, vec!["fixture-image".into()]).unwrap();
    }

    struct TestRequest {
        path: String,
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
                let path = headers
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .expect("path")
                    .to_string();
                sender.send(TestRequest { path }).expect("send request");
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

    #[test]
    fn recovery_is_resolved_only_by_a_completed_stop() {
        let root = temp_root("recovery-completed-stop");
        let shell = Shell::default();
        mark_recovery_required(&shell, &root, 0);
        *shell.last_failure.lock().unwrap() = Some(Problem::plain("server refused"));
        assert!(recovery_required(&shell, &root));
        assert!(!recovery_required(&shell, &root.join("other")));
        assert!(stop_everything_with(
            &shell,
            &root,
            |_| Ok(0),
            |_| Err("synthetic container cleanup refusal".into())
        )
        .is_err());
        assert!(
            recovery_required(&shell, &root),
            "failed Stop cannot resolve recovery"
        );
        stop_everything_with(&shell, &root, |_| Ok(0), |_| Ok(())).unwrap();
        assert!(!recovery_required(&shell, &root));
        assert!(shell.last_failure.lock().unwrap().is_none());
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
        assert!(last_failure_now(app.handle()).is_some());
        assert!(last_failure_now(app.handle()).is_none());
        assert!(recovery_required(&shell, &f.owned));
        write_quit_cleanup_notice(
            &f.owned,
            &["[exit] cleanup failed: Compose down failed: synthetic".into()],
        )
        .unwrap();
        let notice = last_failure_now(app.handle()).expect("persisted Quit notice");
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
        assert!(last_failure_now(app.handle()).is_none());
        let window = app.get_webview_window("main").unwrap();
        let problem = tauri::test::get_ipc_response(&window, tauri::webview::InvokeRequest {
            cmd: "start_stack".into(), callback: tauri::ipc::CallbackFn(0), error: tauri::ipc::CallbackFn(1),
            url: setup.parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                "root": f.owned, "apiUrl": "https://intelligence.example.test",
                "gatewayWsUrl": "wss://gateway.example.test",
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
            owned_app_url(&shell, &f.owned, &f.ports).is_some(),
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
            owned_app_url(&shell, &f.owned, &f.ports).is_some(),
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
        let notice = last_failure_now(app.handle()).expect("persisted Quit notice");
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
        let failure = last_failure_now(app.handle()).expect("volatile sink failure");
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

    #[test]
    fn initial_start_cancelled_during_preparation_cannot_take_the_startup_lock() {
        let shell = Shell::default();
        let attempt = StartAttempt::begin(&shell).unwrap();
        // Deployment/download or dependency preparation returns after Stop has completed.
        stop_everything_with(&shell, Path::new("unused-root"), |_| Ok(0), |_| Ok(())).unwrap();
        let problem = attempt
            .lock_current()
            .expect_err("a cancelled Start resumed a side effect");
        assert_eq!(problem.said, StartAttempt::cancelled().said);
        assert!(shell.root.lock().unwrap().is_none());
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
    }

    /// Which roots' `server` containers publish which host ports, as far as the code under test
    /// can tell. Keyed by root, and every test root is its own temporary folder, so tests running
    /// side by side cannot see each other's.
    static PUBLISHED_BY_SERVER: Mutex<Vec<(PathBuf, Vec<u16>)>> = Mutex::new(Vec::new());

    pub(super) fn published_by_server(root: &Path, ports: &[u16]) -> bool {
        PUBLISHED_BY_SERVER
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .any(|(published, by)| {
                published == root && !ports.is_empty() && ports.iter().all(|port| by.contains(port))
            })
    }

    fn publish_from_server(root: &Path, ports: &[u16]) {
        let mut published = PUBLISHED_BY_SERVER
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        published.retain(|(published, _)| published != root);
        if !ports.is_empty() {
            published.push((root.to_path_buf(), ports.to_vec()));
        }
    }

    /// Which host token each root's `server` container was given, as far as the code under test
    /// can tell. Keyed by root, as `PUBLISHED_BY_SERVER` is.
    static HOST_TOKEN_GIVEN_TO_SERVER: Mutex<Vec<(PathBuf, String)>> = Mutex::new(Vec::new());

    pub(super) fn host_token_given_to_server(root: &Path) -> Option<String> {
        HOST_TOKEN_GIVEN_TO_SERVER
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .find(|(given, _)| given == root)
            .map(|(_, token)| token.clone())
    }

    /// The token `root`'s server container was started with, which the fixture's server responder
    /// also checks, as the real server checks the one in its environment.
    fn give_server_host_token(root: &Path, token: &str) {
        std::fs::write(root.join("server-host-token"), token).unwrap();
        let mut given = HOST_TOKEN_GIVEN_TO_SERVER
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        given.retain(|(given, _)| given != root);
        given.push((root.to_path_buf(), token.to_owned()));
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
                    "{}\tcompose -f docker-compose.yml --profile harness --profile openbot down",
                    root.display()
                )),
            "{lines}"
        );
    }
    /// Real loopback responders in separate processes, so the HTTP probes are the production ones.
    /// The Tauri mock replaces only the window, and `publish_from_server` only the engine's word on
    /// which root's `server` container publishes the two ports.
    struct RestoreFixture {
        base: PathBuf,
        selected: PathBuf,
        owned: PathBuf,
        child: std::process::Child,
        app_child: std::process::Child,
        ports: openbot_env::Ports,
    }

    impl RestoreFixture {
        fn new() -> Self {
            let base = temp_root("restore-owned-loopback");
            let selected = base.join("selected");
            let owned = base.join("owned");
            write_installed_deployment(&selected);
            write_installed_deployment(&owned);
            // Running on this app's own release, as a deployment it installed and started is. One
            // behind it is not shown as it is (`owned_app_url`), and the tests about that say so.
            let own = upgrade::own();
            for root in [&selected, &owned] {
                deployment::record(root, &own.version, own.pinned).unwrap();
            }
            let source = base.join("listener.rs");
            std::fs::write(&source, r#"
use std::io::{Read, Write};
use std::net::TcpListener;
fn serve(listener: TcpListener) {
    for stream in listener.incoming() {
        let mut stream = stream.unwrap();
        stream.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
        let mut request = [0; 2048];
        let read = stream.read(&mut request).unwrap_or(0);
        if read > 0 {
            if std::path::Path::new("pause-response").exists() {
                std::fs::write("response-entered", "").unwrap();
                while std::path::Path::new("pause-response").exists() {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
            let (status, body) = desktop_answer(&String::from_utf8_lossy(&request[..read]))
                .unwrap_or(("200 OK", "{}".into()));
            let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        }
    }
}
// What the server answers the desktop's folder access and connection watcher: only with the host
// token it was started with (`server-host-token`), and each request recorded as one or the other.
fn desktop_answer(request: &str) -> Option<(&'static str, String)> {
    let path = request.split_whitespace().nth(1)?;
    let empty = match path {
        "/api/host-access/desktop/next" => "{\"operations\":[],\"leaseMs\":30000}",
        "/api/desktop/connection-failure" => "null",
        _ => return None,
    };
    let token = std::fs::read_to_string("server-host-token").unwrap_or_default();
    let offered = request.lines().filter_map(|line| line.split_once(':')).find_map(|(name, value)| {
        let value = value.trim();
        if name.eq_ignore_ascii_case("authorization") {
            value.strip_prefix("Bearer ")
        } else if name.eq_ignore_ascii_case("x-openbot-desktop-host-token") {
            Some(value)
        } else {
            None
        }
    });
    let authorized = !token.is_empty() && offered == Some(token.as_str());
    let mut log = std::fs::OpenOptions::new().create(true).append(true).open("server-requests.log").unwrap();
    writeln!(log, "{} {path}", if authorized { "authorized" } else { "refused" }).unwrap();
    Some(if authorized { ("200 OK", empty.into()) } else { ("401 Unauthorized", "{}".into()) })
}
fn main() {
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
            let mut app_child = std::process::Command::new(&binary)
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
            let fixture = Self {
                base,
                selected,
                owned,
                child,
                app_child,
                ports: openbot_env::Ports {
                    server: numbers[0],
                    app: app_numbers[1],
                    ..Default::default()
                },
            };
            publish_from_server(&fixture.owned, &[fixture.ports.server, fixture.ports.app]);
            fixture
        }

        fn app(&self, root: &Path, setup: &str) -> tauri::App<tauri::test::MockRuntime> {
            let shell = Shell::default();
            remember_selected_root(&shell, root);
            *shell.setup_url.lock().unwrap() = Some(setup.into());
            let app = tauri::test::mock_builder()
                .manage(shell)
                .invoke_handler(tauri::generate_handler![
                    start_stack,
                    already_running,
                    last_failure
                ])
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
            let _ = self.app_child.kill();
            let _ = self.app_child.wait();
            publish_from_server(&self.owned, &[]);
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
    fn an_interrupted_upgrade_blocks_owned_answering_runtime_reopen() {
        let f = RestoreFixture::new();
        openbot_env::write(
            &f.owned.join(".env"),
            &f.ports.settings(),
            &std::collections::BTreeMap::new(),
        )
        .unwrap();
        assert!(server_capabilities_answer(f.ports.server));
        // This root's own server container publishes both ports, so before the journal it is
        // adoptable.
        assert!(
            server_container_publishes(None, &f.owned, &[f.ports.server, f.ports.app]).unwrap()
        );
        assert!(stack::app_url(f.ports.app).is_some());
        let before = Shell::default();
        assert!(already_running_at(&before, &f.owned, &f.ports));
        std::fs::create_dir_all(f.owned.join(upgrade::PREVIOUS)).unwrap();
        // A new shell has no in-memory recovery flag, while its previously owned processes live.
        let app = f.app(&f.owned, "tauri://localhost/");
        assert!(app
            .state::<Shell>()
            .recovery_required
            .lock()
            .unwrap()
            .is_none());
        assert!(!already_running_now(
            app.handle(),
            &f.owned.to_string_lossy()
        ));
        assert!(!already_running_at(
            &app.state::<Shell>(),
            &f.owned,
            &f.ports
        ));
        assert!(owned_app_url(&app.state::<Shell>(), &f.owned, &f.ports).is_none());
        let error = show_openbot_on(app.handle().clone(), &f.ports).unwrap_err();
        assert_eq!(error.said, UPGRADE_INTERRUPTED_SHOWING);
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

    /// An installer that closed the app without its Quit, a crash or a force quit leaves the
    /// containers up. The newer app that opens next must not show that server as its own: Start
    /// upgrades it (`upgrade::due`), and showing it kept the person on the old release for good.
    #[test]
    fn a_deployment_left_running_behind_this_app_is_left_to_start_to_upgrade() {
        let f = RestoreFixture::new();
        openbot_env::write(
            &f.owned.join(".env"),
            &f.ports.settings(),
            &std::collections::BTreeMap::new(),
        )
        .unwrap();
        let own = upgrade::own();
        let root = f.owned.to_string_lossy().into_owned();
        let shown = format!("http://127.0.0.1:{}/", f.ports.app);
        let window_url = |app: &tauri::App<tauri::test::MockRuntime>| {
            app.get_webview_window("main")
                .unwrap()
                .url()
                .unwrap()
                .to_string()
        };

        // Behind this app: the window stays on setup, whose Start upgrades it.
        deployment::record(&f.owned, "v0.0.1", false).unwrap();
        assert!(upgrade::due(&f.owned, &own).is_some());
        let app = f.app(&f.owned, "tauri://localhost/");
        assert!(!already_running_now(app.handle(), &root));
        assert!(show_openbot_on(app.handle().clone(), &f.ports).is_err());
        restore_window_on(app.handle(), &f.ports);
        assert_eq!(window_url(&app), "tauri://localhost/");

        // On this app's release, or newer (never moved back): shown as it is.
        for version in [own.version.as_str(), "v999.0.0"] {
            deployment::record(&f.owned, version, own.pinned).unwrap();
            assert!(upgrade::due(&f.owned, &own).is_none());
            let app = f.app(&f.owned, "tauri://localhost/");
            assert!(already_running_now(app.handle(), &root), "{version}");
            show_openbot_on(app.handle().clone(), &f.ports).unwrap();
            assert_eq!(window_url(&app), shown, "{version}");
        }

        // Behind, but this session raised it: a failed upgrade started the previous version again,
        // and the window shows it.
        deployment::record(&f.owned, "v0.0.1", false).unwrap();
        let app = f.app(&f.owned, "tauri://localhost/");
        *app.state::<Shell>().containers.lock().unwrap() = Some(ContainerDeployment {
            root: f.owned.clone(),
            address: engine::Address::new(engine::Engine::Docker, None),
        });
        show_openbot_on(app.handle().clone(), &f.ports).unwrap();
        assert_eq!(window_url(&app), shown);
    }

    /// A deployment shown as the window's own is this session's, as one Start raised is: the menus
    /// say it is running, local folder access and the connection watcher answer to its server, and
    /// Quit takes its containers down. Shown and not held, the tray said "Not running", Quit left
    /// every container up, and the next launch showed them again. Held without the host token only
    /// Start had, the window looked fine while folder access and the watcher never ran.
    #[test]
    fn a_deployment_shown_at_launch_is_held_so_the_menus_and_quit_act_on_it() {
        if crate::test_support::isolated_process(
            "tests::a_deployment_shown_at_launch_is_held_so_the_menus_and_quit_act_on_it",
        ) {
            return;
        }
        let _path = SerializedPath::set();
        let record = temp_root("openbot-adopted-quit-record").join("commands.log");
        let _engine = fake_engine(&record);
        let f = RestoreFixture::new();
        openbot_env::write(
            &f.owned.join(".env"),
            &f.ports.settings(),
            &std::collections::BTreeMap::new(),
        )
        .unwrap();
        // Minted by the session that started it, which is gone: only its server container has it.
        give_server_host_token(&f.owned, "earlier-session-token");
        let app = f.app(&f.owned, "tauri://localhost/");
        let shell = app.state::<Shell>();
        assert!(already_running_now(
            app.handle(),
            &f.owned.to_string_lossy()
        ));
        show_openbot_on(app.handle().clone(), &f.ports).unwrap();

        // What the tray and the menu bar read for "Running".
        assert_eq!(
            shell.root.lock().unwrap().as_deref(),
            Some(f.owned.as_path())
        );
        // Local folder access and the connection watcher, each let in by the server.
        assert!(
            shell.host_access.lock().unwrap().is_some(),
            "local folder access is not running for the deployment shown"
        );
        let requests = f.owned.join("server-requests.log");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let seen = std::fs::read_to_string(&requests).unwrap_or_default();
            if [
                "authorized /api/host-access/desktop/next",
                "authorized /api/desktop/connection-failure",
            ]
            .iter()
            .all(|wanted| seen.lines().any(|line| line == *wanted))
            {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "{seen}");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let stopped = exit_cleanup_then(
            &shell,
            &f.owned,
            |_| Ok(0),
            |root| down_containers_on_quit(&shell, root),
            |_| Ok(()),
        );
        assert!(stopped.openbot.is_empty(), "{:?}", stopped.openbot);
        assert_compose_down_ran_under(&record, &f.owned);
        assert!(shell.root.lock().unwrap().is_none());
        assert!(shell.containers.lock().unwrap().is_none());
        assert!(shell.host_access.lock().unwrap().is_none());
        let seen = std::fs::read_to_string(&requests).unwrap();
        assert!(!seen.contains("refused"), "{seen}");
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
        assert!(tauri::async_runtime::block_on(already_running(
            app.handle().clone(),
            f.owned.to_string_lossy().into_owned()
        )));
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
        assert!(!tauri::async_runtime::block_on(already_running(
            other.handle().clone(),
            f.selected.to_string_lossy().into_owned()
        )));
        assert!(tauri::async_runtime::block_on(show_openbot(other.handle().clone())).is_err());
    }

    #[test]
    fn setup_page_probes_do_not_wait_on_the_event_loop_for_startup_held_by_installation() {
        let f = RestoreFixture::new();
        openbot_env::write(
            &f.owned.join(".env"),
            &f.ports.settings(),
            &std::collections::BTreeMap::new(),
        )
        .unwrap();
        let app = f.app(&f.owned, "tauri://localhost/");
        let window = app.get_webview_window("main").unwrap();
        let shell = app.state::<Shell>();
        let held = shell.startup.lock().unwrap();
        let (answered, answers) = std::sync::mpsc::channel();
        let (dispatched, dispatches) = std::sync::mpsc::channel();
        let webview = window.as_ref().clone();
        let root = f.owned.clone();
        // `on_message` is where the window's invoke lands. A synchronous command runs inside it,
        // which is the event-loop thread in the real app.
        std::thread::spawn(move || {
            for (command, body) in [
                ("already_running", serde_json::json!({ "root": root })),
                ("last_failure", serde_json::json!({})),
            ] {
                let answered = answered.clone();
                webview.clone().on_message(
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
                    Box::new(move |_, _, response, _, _| {
                        let _ = answered.send((command, response));
                    }),
                );
            }
            let _ = dispatched.send(());
        });
        let returned = dispatches.recv_timeout(std::time::Duration::from_secs(5));
        let early = answers.try_recv();
        drop(held);
        returned.expect("the window's invoke waited on the startup lock installation was holding");
        assert!(early.is_err(), "a probe answered before startup was free");
        let mut answered: Vec<_> = (0..2)
            .map(|_| {
                let (command, response) = answers
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                let tauri::ipc::InvokeResponse::Ok(body) = response else {
                    panic!("{command} failed");
                };
                (command, body.deserialize::<serde_json::Value>().unwrap())
            })
            .collect();
        answered.sort_by_key(|(command, _)| *command);
        assert_eq!(
            answered,
            [
                ("already_running", serde_json::json!(true)),
                ("last_failure", serde_json::Value::Null),
            ]
        );
    }

    #[test]
    fn restore_window_refuses_answering_other_deployment_and_shows_recorded_setup() {
        let f = RestoreFixture::new();
        assert!(server_capabilities_answer(f.ports.server));
        assert!(stack::app_url(f.ports.app).is_some());
        assert!(!published_by_server(&f.selected, &[f.ports.server]));
        assert!(published_by_server(&f.owned, &[f.ports.server]));
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
    fn restore_window_shows_setup_without_waiting_for_startup_held_by_installation() {
        let f = RestoreFixture::new();
        let app = f.app(&f.owned, "tauri://localhost/");
        let window = app.get_webview_window("main").unwrap();
        let installing = "tauri://localhost/#installing";
        window.navigate(installing.parse().unwrap()).unwrap();
        window.hide().unwrap();
        let shell = app.state::<Shell>();
        let held = shell.startup.lock().unwrap();
        let (done, finished) = std::sync::mpsc::channel();
        let restoring = app.handle().clone();
        let ports = f.ports;
        std::thread::spawn(move || {
            restore_window_on(&restoring, &ports);
            let _ = done.send(());
        });
        let returned = finished.recv_timeout(std::time::Duration::from_secs(5));
        drop(held);
        returned.expect("restore waited on the startup lock an installation was holding");
        assert_eq!(window.url().unwrap().as_str(), installing);
        assert!(window.is_visible().unwrap());

        // Free again, the next restore makes the decision it skipped.
        window.hide().unwrap();
        restore_window_on(app.handle(), &f.ports);
        assert_eq!(
            window.url().unwrap().as_str(),
            format!("http://127.0.0.1:{}/", f.ports.app)
        );
        assert!(window.is_visible().unwrap());
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
        // Answering on both ports, but the engine does not say this root's server publishes them.
        publish_from_server(&f.owned, &[]);
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
        // This root's server publishes the API port; something else has the app port.
        publish_from_server(&f.owned, &[f.ports.server]);
        assert!(already_running_on(
            &f.owned,
            f.ports.server,
            |root, port| { server_container_publishes(None, root, &[port]) }
        ));
        assert!(stack::app_url(f.ports.app).is_some());
        let app = f.app(&f.owned, "tauri://localhost/");
        let initial_adoption = already_running_at(&app.state::<Shell>(), &f.owned, &f.ports);
        let shown = show_openbot_on(app.handle().clone(), &f.ports);
        restore_window_on(app.handle(), &f.ports);
        let destination = app.get_webview_window("main").unwrap().url().unwrap();
        assert!(!initial_adoption && shown.is_err() && destination.as_str() == "tauri://localhost/",
            "owned API must not authorize a foreign app: initial={initial_adoption}, shown={shown:?}, restore={destination}");
    }

    #[test]
    fn app_adoption_and_restore_allow_the_app_its_own_server_container_publishes() {
        let f = RestoreFixture::new();
        let app = f.app(&f.owned, "tauri://localhost/");
        assert!(already_running_at(
            &app.state::<Shell>(),
            &f.owned,
            &f.ports
        ));
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
