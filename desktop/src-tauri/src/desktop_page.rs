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
//! And Settings' AI model row (`ai_connection`, `change_ai_connection`): which provider and sign-in
//! OpenBot starts with, never a key, and Change, which stops OpenBot and opens the setup window at
//! its AI screen.
//!
//! And Settings' Share usage data row (`usage_data`, `set_usage_data`): the opt-out the
//! environment variables give, as a switch kept for the next launch.
//!
//! And Quit (`quit`), for Ctrl+Q in the window on Windows (`QUIT_SHORTCUT_PAGE`), and Zoom
//! (`zoom`), for the zoom keys no menu carries (`zoom::SHORTCUT_PAGE`). The setup and Status pages
//! are granted both too (`capabilities/default.json`).

use openbot_desktop_lib::{app_update, local_eval, local_eval_state, speech, stack};
use tauri::Manager;

pub const PLUGIN: &str = "openbot-desktop";

/// Injected into the window's pages on Windows: Ctrl+Q asks `quit`. See the script.
pub const QUIT_SHORTCUT_PAGE: &str = include_str!("quit-shortcut.js");

/// The permissions a page needs for every command here.
pub const PERMISSIONS: [&str; 21] = [
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
    "openbot-desktop:allow-notify",
    "openbot-desktop:allow-ai-connection",
    "openbot-desktop:allow-change-ai-connection",
    "openbot-desktop:allow-usage-data",
    "openbot-desktop:allow-set-usage-data",
    "openbot-desktop:allow-quit",
    "openbot-desktop:allow-zoom",
];

/**
The page's own light or dark, for the window: macOS draws a window's outline from the window's
appearance, and a dark one is a black line around a light page.

Its own command rather than the window plugin's `set_theme`: granted to this origin, that call was
refused (the window stayed dark), and this one is ours to see.

Async, like every command here: on Windows a sync one deadlocked the window (see the test below).
*/
#[tauri::command]
async fn appearance(window: tauri::Window, dark: bool) -> Result<(), String> {
    window
        .set_theme(Some(if dark {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }))
        .map_err(|error| error.to_string())?;
    crate::page_appearance(&window, dark);
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
    crate::restart_openbot_from(app, crate::AskedFrom::Settings).await
}

/// Stops everything, as the menu's Stop did. The page asking goes with it; the window shows setup.
#[tauri::command]
pub async fn stop<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    crate::stop_from_menu(app, crate::AskedFrom::Settings);
}

/// `local status`, `start` or `stop` for the stack recorded for this installation.
#[tauri::command]
async fn intelligence(
    app: tauri::AppHandle,
    action: local_eval::Action,
) -> Result<local_eval::Report, local_eval::Failure> {
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

/// Start listening in `language`; what is heard arrives through `on_event`. Returns the session's
/// number, for `speech_stop` and `speech_abort`. A session already listening ends.
#[tauri::command]
async fn speech_start(language: String, on_event: tauri::ipc::Channel<speech::Event>) -> u64 {
    speech::start(&language, move |event| on_event.send(event).is_ok())
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
async fn ai_connection(app: tauri::AppHandle) -> openbot_desktop_lib::ai_connection::AiConnection {
    crate::ai_connection_now(&app)
}

/// The AI model row's Change: Stop, then the setup window at its AI screen, the one its Change AI
/// connection opens. The page asking goes with OpenBot, as with Stop.
#[tauri::command]
async fn change_ai_connection(app: tauri::AppHandle) {
    crate::change_ai_connection_from_settings(app);
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
            notify,
            ai_connection,
            change_ai_connection,
            usage_data,
            set_usage_data,
            quit,
            zoom
        ])
        .build()
}

#[cfg(test)]
mod tests {
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
