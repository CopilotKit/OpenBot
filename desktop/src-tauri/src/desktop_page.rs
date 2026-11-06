//! What OpenBot's own Settings page ("This computer") may ask this desktop app.
//!
//! The same facts and actions as the Status window, reached from the app instead: what is running,
//! how much memory each part takes, Restart and Stop for OpenBot, and Start, Stop and status for
//! the local Intelligence stack. Also the update banner's offer, close and install. An inline plugin, so each command carries a permission of its own,
//! granted at runtime to the exact origin of the OpenBot this app started and to nothing else.
//!
//! And narration's speech recognition, on this computer (`speech`): the window's web view has none
//! that stays on the device, so the page's narration listens through these instead.

use openbot_desktop_lib::{app_update, local_eval, local_eval_state, speech, stack};
use tauri::Manager;

pub const PLUGIN: &str = "openbot-desktop";

/// The permissions a page needs for every command here.
pub const PERMISSIONS: [&str; 12] = [
    "openbot-desktop:allow-appearance",
    "openbot-desktop:allow-status",
    "openbot-desktop:allow-restart",
    "openbot-desktop:allow-stop",
    "openbot-desktop:allow-intelligence",
    "openbot-desktop:allow-update-offer",
    "openbot-desktop:allow-dismiss-update",
    "openbot-desktop:allow-install-update",
    "openbot-desktop:allow-speech-available",
    "openbot-desktop:allow-speech-start",
    "openbot-desktop:allow-speech-stop",
    "openbot-desktop:allow-speech-abort",
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
async fn restart(app: tauri::AppHandle) -> Result<(), String> {
    crate::restart_openbot(app).await
}

/// Stops everything, as the menu's Stop did. The page asking goes with it; the window shows setup.
#[tauri::command]
async fn stop(app: tauri::AppHandle) {
    crate::stop_openbot_from_status(app);
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

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new(PLUGIN)
        .invoke_handler(tauri::generate_handler![
            appearance,
            status,
            restart,
            stop,
            intelligence,
            update_offer,
            dismiss_update,
            install_update,
            speech_available,
            speech_start,
            speech_stop,
            speech_abort
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
