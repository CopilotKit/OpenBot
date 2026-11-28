/*!
View → Reload, with Command-R (Ctrl+R on Linux): OpenBot's page in the main window loaded again, as a
browser's Reload does.

Found in dogfooding: the app had no reload, and Command-R did nothing. Only OpenBot's own page is
reloaded: on this computer (OpenBot (Self-Contained)) or through the relay (OpenBot Cloud, or
another OpenBot the app is connected to). Never the setup screens, which have their own watchdog
(`desktop_stall`) and whose state a reload would throw away mid-install, and never another page.

Nor while a field the person typed into still holds text: that page decides (`reload-page.js`),
because only it knows what was typed. A click on a notice never reloads either; it moves within the
page (`navigate_to_notice_page`).

Windows has no menu bar, and its webview answers Ctrl+R and F5 itself.
*/

use crate::WindowPage;
use tauri::Manager;

/// The View menu's item, and the menu handler's name for it.
pub const MENU_ID: &str = "reload";
pub const MENU_LABEL: &str = "Reload";
pub const MENU_ACCELERATOR: &str = "CmdOrCtrl+R";

/// Injected into OpenBot's pages as they load: what typing a reload would lose, and the reload.
pub const PAGE: &str = include_str!("reload-page.js");

/// What Reload asks of the page. A page loaded before `PAGE` was injected has nothing typed that
/// it knows of, and is loaded again.
const RELOAD: &str = "typeof window.__openbotReload === \"function\" ? window.__openbotReload() : window.location.reload();";

/// What Reload did.
#[derive(Debug, PartialEq, Eq)]
pub enum Reloaded {
    /// OpenBot's page was asked to load again (it keeps itself when something typed would be lost).
    Asked,
    /// The window shows the setup screens or another page: left as it is.
    NotOpenBot,
    /// There is no main window, or it can't say where it is.
    NoWindow,
}

/// Reload the main window's page, when it is OpenBot's.
pub fn reload<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Reloaded {
    let Some(window) = app.get_webview_window("main") else {
        return Reloaded::NoWindow;
    };
    let Ok(url) = window.url() else {
        return Reloaded::NoWindow;
    };
    match crate::window_page(app, &url) {
        WindowPage::OwnedApp | WindowPage::LocalApp => {
            if let Err(error) = window.eval(RELOAD) {
                log::warn!("[window] could not reload OpenBot's page: {error}");
            }
            Reloaded::Asked
        }
        WindowPage::Setup | WindowPage::Other => {
            log::info!("[window] Reload left the window as it is: it isn't on OpenBot's page");
            Reloaded::NotOpenBot
        }
    }
}
