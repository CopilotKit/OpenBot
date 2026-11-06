//! Telling a person a newer OpenBot exists once the window shows OpenBot itself.
//!
//! The setup screen offers an update at launch (`UpdateOffer.tsx`), but the window leaves the
//! setup screen for the running app seconds later, and the offer goes with it. So the shell offers
//! the same update natively: once per launch when the window has handed over with the offer still
//! unanswered, and whenever somebody chooses Check for Updates… from the OpenBot or tray menu.
//!
//! The check, the download, the signature check and the restart are the ones the setup screen
//! uses: the same registered `tauri-plugin-updater` with the same configuration, then the same
//! `request_restart` that `@tauri-apps/plugin-process`'s `relaunch` asks for.

use std::sync::atomic::{AtomicBool, Ordering::SeqCst};

/// The menu item's id in both menus, and its label.
pub const MENU_ID: &str = "check-updates";
pub const MENU_LABEL: &str = "Check for Updates…";

/// What this launch has already asked, shared by the setup screen, the menus and the handover.
#[derive(Default)]
pub struct Offer {
    /// Somebody answered an offer this launch, in the window or in a dialog.
    answered: AtomicBool,
    /// The launch offer has been made natively after handover, or checked for and not found.
    asked_after_handover: AtomicBool,
    /// An update is downloading; it restarts when done.
    installing: AtomicBool,
}

impl Offer {
    /// The window's offer was answered: Not now, or Update and restart.
    pub fn answered(&self) {
        self.answered.store(true, SeqCst);
    }

    /// True once per launch: the first time the window shows OpenBot while nobody has answered an
    /// offer. The setup screen's offer is gone by then, so this is the only chance left to ask.
    pub fn ask_after_handover(&self) -> bool {
        !self.answered.load(SeqCst) && !self.asked_after_handover.swap(true, SeqCst)
    }

    /// True for the one caller allowed to start installing; false while one already is.
    fn begin_install(&self) -> bool {
        !self.installing.swap(true, SeqCst)
    }

    fn install_failed(&self) {
        self.installing.store(false, SeqCst);
    }

    fn installing(&self) -> bool {
        self.installing.load(SeqCst)
    }
}

/// What a check found.
#[derive(Debug, PartialEq)]
pub enum Checked {
    Available { version: String, current: String },
    UpToDate { current: String },
    Failed,
    Installing,
}

/// A native dialog: its title, its text, and the two buttons when it asks something.
#[derive(Debug, PartialEq)]
pub struct Prompt {
    pub title: String,
    pub message: String,
    pub buttons: Option<(&'static str, &'static str)>,
}

pub const UPDATE: &str = "Update and restart";
pub const NOT_NOW: &str = "Not now";

/// The words for each result, in the setup screen's own words where it has them.
pub fn prompt(checked: &Checked) -> Prompt {
    match checked {
        Checked::Available { version, current } => Prompt {
            title: format!("OpenBot {version} is available"),
            message: format!(
                "You are running {current}. Updating downloads the new version and restarts OpenBot."
            ),
            buttons: Some((UPDATE, NOT_NOW)),
        },
        Checked::UpToDate { current } => Prompt {
            title: "OpenBot is up to date".into(),
            message: format!("You are running {current}, the newest version."),
            buttons: None,
        },
        Checked::Failed => Prompt {
            title: "OpenBot couldn't check for updates".into(),
            message: "Make sure you're online, then try again.".into(),
            buttons: None,
        },
        Checked::Installing => Prompt {
            title: "OpenBot is downloading the update".into(),
            message: "OpenBot restarts when the download finishes.".into(),
            buttons: None,
        },
    }
}

/// The words for an install that did not happen. By then somebody asked for it, so it is said.
pub fn install_failed(error: &str) -> Prompt {
    Prompt {
        title: "OpenBot couldn't install the update".into(),
        message: format!("{error}\n\nTry again with Check for Updates…"),
        buttons: None,
    }
}

/// Whether this build registered the updater. `main` registers it from this same block, and only
/// then; asking an unregistered updater panics.
pub fn configured<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    app.config().plugins.0.contains_key("updater")
}

/// Check for Updates… from either menu: always answers, whatever it found.
pub fn check_from_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if offer_state(&app).is_some_and(Offer::installing) {
            show(&app, prompt(&Checked::Installing), |_| {});
            return;
        }
        match check(&app).await {
            Ok(Some(update)) => offer(&app, update),
            Ok(None) => show(
                &app,
                prompt(&Checked::UpToDate {
                    current: app.package_info().version.to_string(),
                }),
                |_| {},
            ),
            Err(error) => {
                eprintln!("[updater] check failed: {error}");
                show(&app, prompt(&Checked::Failed), |_| {});
            }
        }
    });
}

/// The window now shows OpenBot. Offer an update natively if the setup screen's offer was never
/// answered, once per launch. A check that fails here says nothing, as the setup screen's does.
pub fn after_handover<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if !configured(app) || !offer_state(app).is_some_and(Offer::ask_after_handover) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match check(&app).await {
            Ok(Some(update)) => offer(&app, update),
            Ok(None) => {}
            Err(error) => eprintln!("[updater] launch check failed: {error}"),
        }
    });
}

fn offer_state<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<&Offer> {
    use tauri::Manager;
    app.try_state::<Offer>().map(|state| state.inner())
}

/// The check the setup screen's `check()` makes: the registered updater, its configuration as is.
async fn check<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    use tauri_plugin_updater::UpdaterExt;
    if !configured(app) {
        return Err("this build has no updater".into());
    }
    app.updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())
}

fn offer<R: tauri::Runtime>(app: &tauri::AppHandle<R>, update: tauri_plugin_updater::Update) {
    if let Some(state) = offer_state(app) {
        state.answered();
    }
    let checked = Checked::Available {
        version: update.version.clone(),
        current: update.current_version.clone(),
    };
    let installer = app.clone();
    show(app, prompt(&checked), move |yes| {
        if yes {
            install(&installer, update);
        }
    });
}

/// The setup screen's install: download and verify, write it, then restart into it.
fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>, update: tauri_plugin_updater::Update) {
    if offer_state(app).is_some_and(|state| !state.begin_install()) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match update.download_and_install(|_, _| {}, || {}).await {
            Ok(()) => app.request_restart(),
            Err(error) => {
                eprintln!("[updater] install failed: {error}");
                if let Some(state) = offer_state(&app) {
                    state.install_failed();
                }
                show(&app, install_failed(&error.to_string()), |_| {});
            }
        }
    });
}

fn show<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    prompt: Prompt,
    answered: impl FnOnce(bool) + Send + 'static,
) {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The bug: the setup screen's offer left with the setup screen, and a running OpenBot never
    /// mentioned the update again. Handing over with the offer unanswered asks, once per launch.
    #[test]
    fn an_unanswered_offer_is_asked_once_after_the_window_shows_openbot() {
        let offer = Offer::default();
        assert!(offer.ask_after_handover());
        // The window comes back to OpenBot after a stop and a start, or a Show Window: not again.
        assert!(!offer.ask_after_handover());
    }

    /// A running OpenBot had no way to reach an update: the menus had About, Show Window, Status…
    /// and Quit. AppKit menus cannot be built under the mock runtime (see `refresh_menus`), so
    /// this reads the shell's own wiring: both menus carry the item, a choice of it checks, the
    /// handover asks, and the setup screen's answer reaches the shell.
    #[test]
    fn a_running_openbot_can_reach_an_update() {
        let main = include_str!("main.rs");
        let menus = &main[main.find("fn install_menus").unwrap()..];
        let menus = &menus[..menus.find("app.set_menu(").unwrap()];
        assert_eq!(menus.matches("update_offer::MENU_ID,").count(), 2);
        assert!(main.contains("update_offer::MENU_ID => update_offer::check_from_menu(app)"));
        let page_load = &main[main.find(".on_page_load(").unwrap()..];
        let page_load = &page_load[..page_load.find(".on_window_event(").unwrap()];
        assert!(page_load.contains("update_offer::after_handover(window.app_handle())"));
        assert!(main.contains(".manage(update_offer::Offer::default())"));
        assert!(main.contains("answer_update_offer,"));
    }

    /// Answered on the setup screen, Not now or Update and restart: the dialog does not ask twice.
    #[test]
    fn an_offer_answered_in_the_window_is_not_asked_again() {
        let offer = Offer::default();
        offer.answered();
        assert!(!offer.ask_after_handover());
    }

    #[test]
    fn one_install_at_a_time_and_another_after_a_failure() {
        let offer = Offer::default();
        assert!(offer.begin_install());
        assert!(offer.installing());
        assert!(!offer.begin_install());
        offer.install_failed();
        assert!(!offer.installing());
        assert!(offer.begin_install());
    }

    #[test]
    fn each_result_says_what_it_found() {
        assert_eq!(
            prompt(&Checked::Available {
                version: "0.3.1".into(),
                current: "0.3.0".into()
            }),
            Prompt {
                title: "OpenBot 0.3.1 is available".into(),
                message: "You are running 0.3.0. Updating downloads the new version and restarts OpenBot.".into(),
                buttons: Some(("Update and restart", "Not now")),
            }
        );
        assert_eq!(
            prompt(&Checked::UpToDate {
                current: "0.3.1".into()
            })
            .title,
            "OpenBot is up to date"
        );
        let failed = prompt(&Checked::Failed);
        assert_eq!(failed.title, "OpenBot couldn't check for updates");
        assert_eq!(failed.buttons, None);
    }
}
