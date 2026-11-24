//! What OpenBot's own Settings page ("This computer") may ask this desktop app.
//!
//! The same facts and actions as the Status window, reached from the app instead: what is running,
//! how much memory each part takes, Restart and Stop for OpenBot, and Start, Stop and status for
//! the local Intelligence stack. Also the update banner's offer, close and install, and Check for
//! updates. An inline plugin, so each command carries a permission of its own,
//! granted at runtime to the exact origin of the OpenBot this app started and to nothing else.
//!
//! And narration's speech recognition, on this computer (`speech`): the window's web view has none
//! that stays on the device, so the page's narration listens through these instead.
//!
//! And Open log folder (`open_logs`): the folder of this app's log file, in the system's file
//! manager. The page never names a path; the shell opens its own log folder and nothing else.
//!
//! And the page's own problems as they happen (`record_problem`): a request that failed or got no
//! answer, an error it threw, a promise nobody handled, a run that failed, for Get Troubleshooting
//! Logs… (`page_problems`). Connected to an OpenBot elsewhere, this is the only way they reach a
//! file on this computer. And the web app's own Get troubleshooting logs
//! (`save_logs`), which saves the menus' file and shows it.
//!
//! And Settings' AI model row (`ai_connection`, `change_ai_connection`): which provider and sign-in
//! OpenBot starts with, never a key, and Change, which stops OpenBot and opens the setup window at
//! its AI screen. Kept for a page on an older server, which cannot change the connection itself.
//!
//! And the AI connection changed in the app with no stop (`ai_providers`, `begin_plan_sign_in`,
//! `finish_plan_sign_in`, `cancel_plan_sign_in`, `begin_provider_sign_in`,
//! `finish_provider_sign_in`, `cancel_provider_sign_in`, `prepare_ai_connection`,
//! `settle_ai_connection`): the sign-ins that run here, which keep what they get here and never hand
//! a token to the page (an Unbiased AI sign-in's key excepted, which the page sends straight to the
//! server like a typed one), and the plan engines and the picked Bot, started, stopped or restarted
//! one container at a time while everything else keeps running. A key or an address never passes
//! through here: the page sends it to the server.
//!
//! And a provider's sign-in redirect, caught on this computer for a sign-in OpenBot Cloud's server
//! runs (`begin_sign_in_redirect`, `await_sign_in_redirect`, `cancel_sign_in_redirect`): the
//! browser comes back to `localhost`, and the code goes to the page, which sends it to the server.
//! These work while connected too: that is where they are used.
//!
//! And Settings' Share usage data row (`usage_data`, `set_usage_data`): the opt-out the
//! environment variables give, as a switch kept for the next launch. Setup's last screen asks the
//! same two (`capabilities/default.json`), so its checkbox and Settings' switch are one setting.
//!
//! And Quit (`quit`), for Ctrl+Q in the window on Windows (`QUIT_SHORTCUT_PAGE`), and Zoom
//! (`zoom`), for the zoom keys no menu carries (`zoom::SHORTCUT_PAGE`). The setup and Status pages
//! are granted both too (`capabilities/default.json`).
//!
//! And where OpenBot runs (`connection`, `sign_out`, `change_connection`, `set_organization`): on
//! this computer, or at an address the app is connected to (`desktop_connected`). While it is
//! connected, `status` answers the app's own facts only, and what is about an OpenBot on this
//! computer (`restart`, `stop`, `intelligence`, `ai_connection`, `change_ai_connection`) is refused.
//!
//! And Settings' Move to OpenBot Cloud (`move_to_cloud`): the setup window at the move, with
//! OpenBot left running here (`desktop_move`).

use openbot_desktop_lib::{app_update, local_eval, local_eval_state, speech, stack};
use tauri::Manager;

pub const PLUGIN: &str = "openbot-desktop";

/// Injected into the window's pages on Windows: Ctrl+Q asks `quit`. See the script.
pub const QUIT_SHORTCUT_PAGE: &str = include_str!("quit-shortcut.js");

/// The permissions a page needs for every command here.
pub const PERMISSIONS: [&str; 40] = [
    "openbot-desktop:allow-connection",
    "openbot-desktop:allow-sign-out",
    "openbot-desktop:allow-change-connection",
    "openbot-desktop:allow-set-organization",
    "openbot-desktop:allow-appearance",
    "openbot-desktop:allow-status",
    "openbot-desktop:allow-restart",
    "openbot-desktop:allow-stop",
    "openbot-desktop:allow-intelligence",
    "openbot-desktop:allow-update-offer",
    "openbot-desktop:allow-check-update",
    "openbot-desktop:allow-dismiss-update",
    "openbot-desktop:allow-install-update",
    "openbot-desktop:allow-speech-available",
    "openbot-desktop:allow-speech-start",
    "openbot-desktop:allow-speech-stop",
    "openbot-desktop:allow-speech-abort",
    "openbot-desktop:allow-open-logs",
    "openbot-desktop:allow-record-problem",
    "openbot-desktop:allow-save-logs",
    "openbot-desktop:allow-notify",
    "openbot-desktop:allow-ai-connection",
    "openbot-desktop:allow-change-ai-connection",
    "openbot-desktop:allow-ai-providers",
    "openbot-desktop:allow-begin-plan-sign-in",
    "openbot-desktop:allow-finish-plan-sign-in",
    "openbot-desktop:allow-cancel-plan-sign-in",
    "openbot-desktop:allow-begin-provider-sign-in",
    "openbot-desktop:allow-finish-provider-sign-in",
    "openbot-desktop:allow-cancel-provider-sign-in",
    "openbot-desktop:allow-begin-sign-in-redirect",
    "openbot-desktop:allow-await-sign-in-redirect",
    "openbot-desktop:allow-cancel-sign-in-redirect",
    "openbot-desktop:allow-prepare-ai-connection",
    "openbot-desktop:allow-settle-ai-connection",
    "openbot-desktop:allow-usage-data",
    "openbot-desktop:allow-set-usage-data",
    "openbot-desktop:allow-quit",
    "openbot-desktop:allow-zoom",
    "openbot-desktop:allow-move-to-cloud",
];

/**
The page's own light or dark, for the window: macOS draws a window's outline from the window's
appearance, and a dark one is a black line around a light page.

`system` says the page is following the system, and then the window follows it too and is not
pinned (`window_theme`). An OpenBot from before it followed the system sends none, and is pinned.

Its own command rather than the window plugin's `set_theme`: granted to this origin, that call was
refused (the window stayed dark), and this one is ours to see.

Async, like every command here: on Windows a sync one deadlocked the window (see the test below).
*/
#[tauri::command]
async fn appearance(window: tauri::Window, dark: bool, system: Option<bool>) -> Result<(), String> {
    let system = system.unwrap_or(false);
    window
        .set_theme(crate::window_theme(dark, system))
        .map_err(|error| error.to_string())?;
    crate::page_appearance(&window, dark, system);
    Ok(())
}

/// `memory` false answers in milliseconds without container memory; see `read_desktop_status`.
#[tauri::command]
async fn status(
    app: tauri::AppHandle,
    memory: Option<bool>,
) -> Result<crate::DesktopStatus, String> {
    crate::desktop_status(app, memory).await
}

#[tauri::command]
pub async fn restart<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    crate::desktop_connected::nothing_here(&app)?;
    // The page has always been given a sentence. What lay beneath it follows, as it did.
    crate::restart_openbot_from(app, crate::AskedFrom::Settings)
        .await
        .map_err(|problem| match problem.detail {
            Some(detail) => format!("{} {detail}", problem.said),
            None => problem.said,
        })
}

/// Stops everything, as the menu's Stop did. The page asking goes with it; the window shows setup.
/// Refused while the app is connected to an OpenBot that runs elsewhere: there is none here.
#[tauri::command]
pub async fn stop<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    crate::desktop_connected::nothing_here(&app)?;
    crate::stop_from_menu(app, crate::AskedFrom::Settings);
    Ok(())
}

/// Where OpenBot runs: on this computer, or at an address this app is connected to, with the
/// organisation picked there. Never a token.
#[tauri::command]
async fn connection(app: tauri::AppHandle) -> crate::desktop_connected::Connection {
    crate::desktop_connected::connection_now(&app, false)
}

/// Settings' Sign out, while connected: signed out of that OpenBot, and the setup window. The
/// page asking goes with it.
#[tauri::command]
async fn sign_out(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::desktop_connected::sign_out_now(&app);
        crate::show_setup(app)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Settings' Change on where OpenBot runs: the setup window at that choice, after signing out of
/// the OpenBot the app is connected to, or after stopping the one on this computer.
#[tauri::command]
async fn change_connection(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::desktop_connected::change_connection_now(&app)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The organisation the person picked in the switcher, which every request names from now on.
/// None for no choice. Something that is not an organisation's id is refused.
#[tauri::command]
async fn set_organization(
    app: tauri::AppHandle,
    organization_id: Option<String>,
) -> Result<(), String> {
    crate::desktop_connected::set_organization_now(&app, organization_id)
}

/// Settings' Move to OpenBot Cloud: the setup window, at the move, with OpenBot left running here
/// (the move reads what it has). Refused where the move isn't offered (`moveToCloud` on
/// `connection`). The page asking goes with it.
#[tauri::command]
async fn move_to_cloud(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::desktop_move::ask_from_settings(&app))
        .await
        .map_err(|error| error.to_string())?
}

/// `local status`, `start` or `stop` for the stack recorded for this installation.
#[tauri::command]
async fn intelligence(
    app: tauri::AppHandle,
    action: local_eval::Action,
) -> Result<local_eval::Report, local_eval::Failure> {
    // Connected to an OpenBot that runs elsewhere: there is no backend on this computer to ask.
    if crate::desktop_connected::is_connected(&app) {
        return Err(local_eval::Failure::Unavailable);
    }
    let root = crate::cleanup_root(&app.state::<crate::Shell>(), &stack::default_root());
    let stack = local_eval_state::read(&root, None)
        .ok_or(local_eval::Failure::Unavailable)?
        .stack_id();
    // Named so it cannot be mistaken for the setup window's own calls in the CLI's log.
    let attempt = format!(
        "page-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_nanos())
            .unwrap_or_default()
    );
    crate::run_local_eval(app, attempt, action, stack.as_str().to_owned()).await
}

/// The update banner: a newer OpenBot Desktop, as the shell last read its update feed, unless
/// this person closed it. Answered from memory; the page never reaches the feed itself.
#[tauri::command]
async fn update_offer(app: tauri::AppHandle) -> app_update::Status {
    crate::app_update_status(&app)
}

/// Settings → This computer's Check for updates: the update feed read now, and what it found.
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<app_update::Asked, String> {
    crate::check_app_update_for_page(app)
        .await
        .map_err(|problem| problem.said)
}

/// The banner's close button: hidden until a newer version than `version` comes out.
#[tauri::command]
async fn dismiss_update(app: tauri::AppHandle, version: String) -> Result<(), String> {
    crate::dismiss_app_update_for(&app, &version).map_err(|problem| problem.said)
}

/// The banner's Update and restart. Returns only when it failed: on success the app restarts.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    crate::install_app_update_now(app)
        .await
        .map_err(|problem| problem.said)
}

/// Whether `language` can be recognised on this computer, as `SpeechRecognition.available()`
/// answers. The first time, the system asks the person for the microphone and speech recognition,
/// and this says `downloading` until they have answered.
#[tauri::command]
async fn speech_available(language: String) -> speech::Availability {
    tauri::async_runtime::spawn_blocking(move || speech::available(&language))
        .await
        .unwrap_or(speech::Availability::Unavailable)
}

/// Start listening in `language`; what is heard arrives through `on_event`. `refused` are the
/// languages the page asked about first and this computer turned down, for speech.log; a page from
/// before the fallback sends none. Returns the session's number, for `speech_stop` and
/// `speech_abort`. A session already listening ends.
#[tauri::command]
async fn speech_start(
    language: String,
    refused: Option<Vec<String>>,
    on_event: tauri::ipc::Channel<speech::Event>,
) -> u64 {
    speech::start(&language, &refused.unwrap_or_default(), move |event| {
        on_event.send(event).is_ok()
    })
}

/// Hand over the phrase in progress, then end.
#[tauri::command]
async fn speech_stop(session: u64) {
    speech::control(session, speech::Control::Stop);
}

/// End now.
#[tauri::command]
async fn speech_abort(session: u64) {
    speech::control(session, speech::Control::Abort);
}

/// Settings → This computer's Open log folder: the shell's own log folder, which the page cannot
/// choose.
#[tauri::command]
async fn open_logs(app: tauri::AppHandle) -> Result<(), String> {
    crate::open_log_folder_now(&app)
}

/// A problem the page saw as it happened: a request that failed or got no answer, an error it threw,
/// a promise nobody handled, a run that failed. Kept for Get Troubleshooting Logs… and written to the
/// log (`page_problems`), checked, cut to length and redacted whatever the page sent. Answered on
/// this computer at once; the page never waits on it.
#[tauri::command]
pub async fn record_problem<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    problem: openbot_desktop_lib::page_problems::Reported,
) -> Result<(), String> {
    crate::record_page_problem(&app, &problem)
}

/// The web app's Get troubleshooting logs, inside this app: the same file the menus' Get
/// Troubleshooting Logs… saves, in the log folder, shown in Finder or Explorer. The page never names
/// a path and never receives the file. Answers once it is saved, or with why it couldn't be.
#[tauri::command]
pub async fn save_logs<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::save_troubleshooting_logs_now(&app, None))
        .await
        .map_err(|error| format!("the logs could not be saved: {error}"))?
        .map_err(|_| "OpenBot couldn't save the troubleshooting logs. Try again.".to_owned())
}

/// A Bot's notification: shown by the system, and opening OpenBot at `path` when it is clicked,
/// from the notification centre too. See `notice.rs`.
#[tauri::command]
async fn notify(
    app: tauri::AppHandle,
    title: String,
    body: Option<String>,
    path: Option<String>,
    tag: Option<String>,
) -> Result<(), String> {
    crate::show_notice(
        &app,
        &title,
        body.as_deref().unwrap_or(""),
        path.as_deref(),
        tag.as_deref(),
    )
}

/// Settings' AI model row: the provider and sign-in OpenBot starts with, the model when one was
/// named, and a custom address's host. Never a key or a token.
#[tauri::command]
async fn ai_connection(
    app: tauri::AppHandle,
) -> Result<openbot_desktop_lib::ai_connection::AiConnection, String> {
    crate::desktop_connected::nothing_here(&app)?;
    Ok(crate::ai_connection_now(&app))
}

/// The AI model row's Change: Stop, then the setup window at its AI screen, the one its Change AI
/// connection opens. The page asking goes with OpenBot, as with Stop.
#[tauri::command]
async fn change_ai_connection(app: tauri::AppHandle) -> Result<(), String> {
    crate::desktop_connected::nothing_here(&app)?;
    crate::change_ai_connection_from_settings(app);
    Ok(())
}

/// The AI dialog's providers and their ways in, in the setup window's order.
#[tauri::command]
async fn ai_providers() -> Vec<openbot_desktop_lib::provider::Provider> {
    openbot_desktop_lib::provider::catalogue()
}

/// The address a plan's sign-in sent the browser to.
#[derive(serde::Serialize)]
struct SignInAddress {
    url: String,
}

/**
Start a Claude or ChatGPT plan's sign-in in the browser, while OpenBot keeps running.

`redirect: "loopback"` sends a Claude plan's browser back to this computer, and `finish_plan_sign_in`
then finishes it with no code. A page older than that sends no `redirect`, and gets Claude's code
page to paste from, as it always has. The page tells which it got from the address's
`redirect_uri`, so a newer page in an older Desktop pastes too.
*/
#[tauri::command]
async fn begin_plan_sign_in(
    app: tauri::AppHandle,
    plan: openbot_desktop_lib::ai_connection::Plan,
    redirect: Option<String>,
) -> Result<SignInAddress, String> {
    let loopback = redirect.as_deref() == Some("loopback");
    let url = crate::begin_plan_sign_in_now(app, plan, loopback).await?;
    Ok(SignInAddress { url })
}

/// Finish it: the Claude plan once the browser comes back, or with the code Claude's page showed
/// for a page that pastes it; the ChatGPT plan by waiting for the browser to come back. The token
/// is kept on this computer and never returned.
#[tauri::command]
async fn finish_plan_sign_in(
    app: tauri::AppHandle,
    plan: openbot_desktop_lib::ai_connection::Plan,
    code: Option<String>,
) -> Result<(), String> {
    crate::finish_plan_sign_in_now(app, plan, code).await
}

#[tauri::command]
async fn cancel_plan_sign_in(
    app: tauri::AppHandle,
    plan: openbot_desktop_lib::ai_connection::Plan,
) -> Result<(), String> {
    crate::cancel_plan_sign_in_now(app, plan).await
}

/// Start a Google, xAI or Unbiased AI sign-in in the browser.
#[tauri::command]
async fn begin_provider_sign_in(
    app: tauri::AppHandle,
    provider: String,
) -> Result<openbot_desktop_lib::provider_oauth::Authorization, String> {
    crate::begin_provider_sign_in_now(app, provider).await
}

/// What a provider's sign-in gave the page: for Unbiased AI, the key it minted, which the page
/// sends straight to the server as an address's key and keeps nowhere. Nothing for Google or xAI,
/// whose sign-in stays in the file the server reads.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderSignedIn {
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
}

#[tauri::command]
async fn finish_provider_sign_in(
    app: tauri::AppHandle,
    attempt_id: String,
) -> Result<ProviderSignedIn, String> {
    crate::desktop_connected::nothing_here(&app)?;
    let api_key = tauri::async_runtime::spawn_blocking(move || {
        openbot_desktop_lib::provider_oauth::finish(&attempt_id)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(ProviderSignedIn { api_key })
}

#[tauri::command]
async fn cancel_provider_sign_in(attempt_id: String) {
    openbot_desktop_lib::provider_oauth::cancel(&attempt_id);
}

/*
 * A provider's redirect, caught on this computer for a sign-in OpenBot Cloud's server runs
 * (`sign_in_redirect`). Unlike the sign-ins above, these never go through `nothing_here`: the app
 * connected to OpenBot Cloud (`desktop_connected`) is exactly where they are used. They touch no
 * installation, only a loopback port, and the code goes to the page that asked, once.
 */

/// Listen for `provider`'s redirect: `anthropic` on a random loopback port, `openai` on 1455.
/// Refused with a sentence when the port is taken, and the page then falls back to the paste.
#[tauri::command]
async fn begin_sign_in_redirect(
    provider: String,
) -> Result<openbot_desktop_lib::sign_in_redirect::Begun, String> {
    tauri::async_runtime::spawn_blocking(move || {
        openbot_desktop_lib::sign_in_redirect::begin(&provider)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Wait, up to 15 minutes, for the redirect whose state is `state`. The browser is told OpenBot has
/// the sign-in, and OpenBot comes forward.
#[tauri::command]
async fn await_sign_in_redirect(
    app: tauri::AppHandle,
    attempt_id: String,
    state: String,
) -> Result<openbot_desktop_lib::sign_in_redirect::Redirected, String> {
    tauri::async_runtime::spawn_blocking(move || {
        openbot_desktop_lib::sign_in_redirect::wait(&attempt_id, &state, || {
            crate::bring_to_front(&app, "a sign-in came back to OpenBot");
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn cancel_sign_in_redirect(attempt_id: String) {
    openbot_desktop_lib::sign_in_redirect::cancel(&attempt_id);
}

/// What `prepare_ai_connection` answers once the connection's engine is ready.
#[derive(serde::Serialize)]
struct Prepared {
    ready: bool,
}

/// Start the one plan engine the connection needs, alone, and wait until it answers. Nothing else
/// is started, stopped or restarted. Ready at once for a connection with no engine of its own.
#[tauri::command]
async fn prepare_ai_connection(
    app: tauri::AppHandle,
    provider: String,
    login: String,
) -> Result<Prepared, String> {
    crate::prepare_ai_connection_now(app, provider, login).await?;
    Ok(Prepared { ready: true })
}

/// Settle on the connection the server now has: recorded for the next start, a plan engine no
/// longer needed stopped, and the picked Bot moved to an engine that can use it, alone.
#[tauri::command]
async fn settle_ai_connection(
    app: tauri::AppHandle,
    provider: String,
    login: String,
    model: Option<String>,
    endpoint_host: Option<String>,
) -> Result<(), String> {
    crate::settle_ai_connection_now(
        app,
        openbot_desktop_lib::ai_connection::Change {
            provider,
            login,
            model,
            endpoint_host,
        },
    )
    .await
}

/// Settings' Share usage data: whether this installation shares, and whether the app's own
/// environment turned it off.
#[tauri::command]
async fn usage_data() -> crate::desktop_telemetry::UsageData {
    crate::desktop_telemetry::usage_data_now()
}

/// Settings' Share usage data, switched. Off is the same opt-out as `COPILOTKIT_TELEMETRY_DISABLED`,
/// kept for the next launch. The desktop's own events and the CLI follow at once; the server, the
/// next time OpenBot starts. Refused when the environment turned sharing off.
#[tauri::command]
async fn set_usage_data(
    app: tauri::AppHandle,
    share: bool,
) -> Result<crate::desktop_telemetry::UsageData, String> {
    crate::desktop_telemetry::set_usage_data(&app, share)
}

/// Quit, by the same path as the tray's Quit: Ctrl+Q in the window on Windows, where no menu
/// carries the shortcut.
#[tauri::command]
async fn quit(app: tauri::AppHandle) {
    crate::chose(&app, "quit");
}

/// Zoom In, Zoom Out or Actual Size, by the same path as the View menu's: the zoom keys no menu
/// carries, every one on Windows and Command and + on macOS (`zoom-shortcut.js`).
#[tauri::command]
async fn zoom(app: tauri::AppHandle, step: crate::zoom::Step) {
    crate::zoom_windows(&app, step);
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new(PLUGIN)
        .invoke_handler(tauri::generate_handler![
            appearance,
            status,
            restart,
            stop,
            intelligence,
            update_offer,
            check_update,
            dismiss_update,
            install_update,
            speech_available,
            speech_start,
            speech_stop,
            speech_abort,
            open_logs,
            record_problem,
            save_logs,
            notify,
            ai_connection,
            change_ai_connection,
            ai_providers,
            begin_plan_sign_in,
            finish_plan_sign_in,
            cancel_plan_sign_in,
            begin_provider_sign_in,
            finish_provider_sign_in,
            cancel_provider_sign_in,
            begin_sign_in_redirect,
            await_sign_in_redirect,
            cancel_sign_in_redirect,
            prepare_ai_connection,
            settle_ai_connection,
            usage_data,
            set_usage_data,
            quit,
            zoom,
            connection,
            sign_out,
            change_connection,
            set_organization,
            move_to_cloud
        ])
        .build()
}

#[cfg(test)]
mod tests {
    /// Setup's last screen switches usage data with Settings' own commands, so the setup window is
    /// granted them: without the grant its checkbox would be refused, and Settings' choice and setup's
    /// would be two settings.
    #[test]
    fn the_setup_window_may_read_and_switch_usage_data() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let granted: Vec<&str> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|permission| permission.as_str())
            .collect();
        for permission in [
            "openbot-desktop:allow-usage-data",
            "openbot-desktop:allow-set-usage-data",
        ] {
            assert!(super::PERMISSIONS.contains(&permission));
            assert!(granted.contains(&permission), "{permission} not granted");
        }
        assert!(capability["windows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|window| window == "main"));
    }

    /// Every command here is async. Tauri runs a plugin's command holding its plugin store, and a
    /// sync one runs on the main thread: a window change made there (the theme, a size, focus) is
    /// delivered on Windows as a window event before the call returns, and dispatching that event
    /// takes the plugin store again. `appearance` was sync, and the window stopped responding the
    /// first time OpenBot's page reported its theme. An async command runs on a worker, so the
    /// window change is queued for the main thread instead.
    #[test]
    fn every_command_runs_off_the_main_thread() {
        let source = include_str!("desktop_page.rs");
        let mut lines = source.lines();
        let mut commands = 0;
        while let Some(line) = lines.next() {
            if line.trim() != "#[tauri::command]" {
                continue;
            }
            let signature = lines.next().unwrap_or_default().trim();
            commands += 1;
            assert!(
                signature.starts_with("async fn ") || signature.starts_with("pub async fn "),
                "a plugin command must be async: {signature}"
            );
        }
        assert_eq!(
            commands,
            super::PERMISSIONS.len(),
            "one command per permission"
        );
    }
}
