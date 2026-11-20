//! Zoom In, Zoom Out and Actual Size for OpenBot's windows, as a browser has them, kept for the
//! next launch.
//!
//! "The text is too small and you can't zoom in": the window answered none of a browser's zoom
//! keys. One level for the whole app: every window's page is shown at it, from the setup screens to
//! OpenBot itself, and it is kept in the app's configuration folder and applied again to each page
//! as it loads. macOS and Linux reach it through the View menu, whose items carry Command or Ctrl
//! with =, - and 0; Windows, which has no menu bar, through the page (`zoom-shortcut.js`), as macOS
//! does for Command and +, which never reaches the menu.
//!
//! Not Tauri's `zoomHotkeysEnabled`. On Windows that turns on WebView2's own zoom keys, and WebView2
//! keeps a zoom made with them for that one page: it is gone on the next navigation (the setup
//! screens to OpenBot) and nothing can keep it for the next launch. On macOS and Linux it injects a
//! script that keeps its level in the page, so it counts from 100% again on every load while the
//! view keeps showing the last level (MEASURED: a WKWebView keeps its zoom across navigations), and
//! that script asks the webview plugin, which OpenBot's own page is not granted.

use std::path::Path;
use std::sync::Mutex;

/// The levels a step moves between, as a browser's are. From 90%: on macOS the window's buttons
/// sit over the top-left corner of OpenBot's page, which makes room for them in its own pixels
/// (the sidebar's header, onboarding's Back), so a page zoomed much further out slides under them.
/// To 200%: the narrowest window (720 points) is then 360 of the page's pixels wide, a phone's.
pub const LEVELS: [f64; 7] = [0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];

/// Actual Size.
pub const ACTUAL_SIZE: f64 = 1.0;

/// Where the level is kept, in the app's own configuration folder.
pub const FILE: &str = "zoom.json";

/// The View menu's items, and the menu handler's names for them.
pub const MENU_IN: &str = "zoom-in";
pub const MENU_OUT: &str = "zoom-out";
pub const MENU_ACTUAL_SIZE: &str = "zoom-actual-size";

/// The page's half of the zoom keys: Ctrl with +, - or 0 on Windows, and on macOS Command and +,
/// which the View menu's Command-= never receives. See the script.
pub const SHORTCUT_PAGE: &str = include_str!("zoom-shortcut.js");

/// Injected into the window's pages on macOS and Windows: `SHORTCUT_PAGE`, told whether the View
/// menu answers the rest of the keys (macOS) or the page answers all of them (Windows).
pub fn shortcut_page() -> String {
    format!(
        "window.__openbotZoomMenu = {};\n{SHORTCUT_PAGE}",
        cfg!(target_os = "macos")
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Step {
    In,
    Out,
    Reset,
}

impl Step {
    /// The View menu item `id` names, if it is one of them.
    pub fn of_menu(id: &str) -> Option<Self> {
        match id {
            MENU_IN => Some(Self::In),
            MENU_OUT => Some(Self::Out),
            MENU_ACTUAL_SIZE => Some(Self::Reset),
            _ => None,
        }
    }
}

/// The level one step from `current`, held at the first and last levels.
pub fn next(current: f64, step: Step) -> f64 {
    const SAME: f64 = 1e-6;
    match step {
        Step::Reset => ACTUAL_SIZE,
        Step::In => LEVELS
            .into_iter()
            .find(|level| *level > current + SAME)
            .unwrap_or(LEVELS[LEVELS.len() - 1]),
        Step::Out => LEVELS
            .into_iter()
            .rev()
            .find(|level| *level < current - SAME)
            .unwrap_or(LEVELS[0]),
    }
}

/// The level kept in `directory`, or Actual Size for none, or for a record that names anything
/// other than one of `LEVELS`.
pub fn saved(directory: &Path) -> f64 {
    std::fs::read_to_string(directory.join(FILE))
        .ok()
        .and_then(|record| level_of(&record))
        .unwrap_or(ACTUAL_SIZE)
}

fn level_of(record: &str) -> Option<f64> {
    let record: serde_json::Value = serde_json::from_str(record).ok()?;
    let level = record.get("level")?.as_f64()?;
    LEVELS
        .into_iter()
        .find(|known| (known - level).abs() < 1e-6)
}

/// One step from the level kept in `directory`, kept there in its place: the new level. The menu
/// and the page can both ask at once, and each step counts.
pub fn step(directory: &Path, step: Step) -> std::io::Result<f64> {
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
    let _turn = ONE_AT_A_TIME
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let level = next(saved(directory), step);
    std::fs::create_dir_all(directory)?;
    std::fs::write(
        directory.join(FILE),
        serde_json::json!({ "level": level }).to_string(),
    )?;
    Ok(level)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Zoom In and Zoom Out walk the levels a step at a time and stop at the ends; Actual Size goes
    /// back to 100% from anywhere.
    #[test]
    fn steps_walk_the_levels_and_stop_at_the_ends() {
        let mut level = ACTUAL_SIZE;
        let mut seen = vec![];
        for _ in 0..8 {
            level = next(level, Step::In);
            seen.push(level);
        }
        assert_eq!(seen, [1.1, 1.25, 1.5, 1.75, 2.0, 2.0, 2.0, 2.0]);
        assert_eq!(next(1.25, Step::Out), 1.1);
        assert_eq!(next(ACTUAL_SIZE, Step::Out), 0.9);
        assert_eq!(next(0.9, Step::Out), 0.9);
        assert_eq!(next(1.75, Step::Reset), ACTUAL_SIZE);
        assert_eq!(next(0.9, Step::Reset), ACTUAL_SIZE);
    }

    /// The level set in one launch is the level the next one starts at: every step is kept, and a
    /// fresh read finds it. No record, or one this app did not write, is Actual Size.
    #[test]
    fn the_level_is_kept_for_the_next_launch() {
        let config = crate::test_support::temp_root("zoom").join("ai.copilotkit.openbot.desktop");
        assert_eq!(saved(&config), ACTUAL_SIZE);

        assert_eq!(step(&config, Step::In).unwrap(), 1.1);
        assert_eq!(step(&config, Step::In).unwrap(), 1.25);
        assert_eq!(saved(&config), 1.25);
        assert_eq!(step(&config, Step::Out).unwrap(), 1.1);
        assert_eq!(saved(&config), 1.1);
        assert_eq!(step(&config, Step::Reset).unwrap(), ACTUAL_SIZE);
        assert_eq!(saved(&config), ACTUAL_SIZE);

        for record in [
            "",
            "{",
            r#"{"level":"big"}"#,
            r#"{"level":7}"#,
            r#"{"level":0}"#,
        ] {
            std::fs::write(config.join(FILE), record).unwrap();
            assert_eq!(saved(&config), ACTUAL_SIZE, "{record}");
        }
        let _ = std::fs::remove_dir_all(config.parent().unwrap());
    }

    /// The View menu's three items, by the ids `chose` hands on, and nothing else.
    #[test]
    fn the_view_menu_items_name_their_steps() {
        assert_eq!(Step::of_menu(MENU_IN), Some(Step::In));
        assert_eq!(Step::of_menu(MENU_OUT), Some(Step::Out));
        assert_eq!(Step::of_menu(MENU_ACTUAL_SIZE), Some(Step::Reset));
        assert_eq!(Step::of_menu("quit"), None);
    }
}
