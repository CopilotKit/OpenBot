//! The main window's size: one size, which the person can't change, while it shows setup, and the
//! person's own once OpenBot's page is up.
//!
//! "For the install process the UI should start out at a specific fixed size, and then when we
//! transition it can be resized" (Dusty, on a real build). Setup's screens are laid out for the
//! window `tauri.conf.json` opens (1000 by 800), or smaller to fit a smaller screen; a window
//! stretched to fill a large screen left the inset page a wide empty field around a narrow column.
//!
//! So while setup shows, the window can't be resized or zoomed (the green button is off, and on
//! Windows the maximize box and the resize border are gone). When the window hands over to
//! OpenBot's own page it can be resized again, and it gets back the size the person last gave
//! OpenBot: the one the window-state plugin saved at the last quit, or the one it had when setup
//! came back in this session (a stop, a change of connection). A first install has no such size and
//! opens at 1120 by 860, or smaller to fit the screen, so onboarding has room for its two columns.
//!
//! The window-state plugin saves the window as it is when OpenBot quits. Quit while setup shows, that
//! is setup's size, not OpenBot's, so the size kept for OpenBot is written back over it
//! (`keep_app_size`).

use std::sync::Mutex;

/// The size OpenBot's own page last had, in logical pixels, and whether it was maximized (zoomed
/// on macOS). Windows captures its restored size before setup changes it. No size when a platform
/// cannot read that size synchronously (macOS), so it is maximized again and left at that.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AppSize {
    pub size: Option<(f64, f64)>,
    pub maximized: bool,
}

/// Capture the normal dimensions before setup replaces them. Windows restores synchronously;
/// platforms with asynchronous restore must keep the maximized flag without reading that size.
pub fn capture_app_size(
    maximized: bool,
    synchronous_restore: bool,
    restore: impl FnOnce() -> Option<()>,
    size: impl FnOnce() -> Option<(f64, f64)>,
) -> Option<AppSize> {
    if maximized {
        if !synchronous_restore {
            return Some(AppSize {
                size: None,
                maximized,
            });
        }
        restore()?;
    }
    Some(AppSize {
        size: Some(size()?),
        maximized,
    })
}

/// What the window is sized for.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Sizing {
    /// Setup's fixed size, and the size to give OpenBot's page when it comes, if one is known.
    Setup { app: Option<AppSize> },
    /// OpenBot's page: the person sizes the window.
    App,
}

/// The window starts on setup (`tauri.conf.json` builds it fixed).
impl Default for Sizing {
    fn default() -> Self {
        Sizing::Setup { app: None }
    }
}

/// What a page that loaded asks of the window.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Change {
    /// Nothing moves: the window is already sized for the page.
    Stays,
    /// From OpenBot's page to setup: fixed, at setup's size.
    ToSetup,
    /// From setup to OpenBot's page: resizable again, at the size it had, when one is known.
    ToApp(Option<AppSize>),
}

/// The main window's sizing, kept for the session.
#[derive(Default)]
pub struct State(Mutex<Sizing>);

impl State {
    fn sizing(&self) -> std::sync::MutexGuard<'_, Sizing> {
        self.0.lock().unwrap_or_else(|held| held.into_inner())
    }

    /// At launch: the size OpenBot's page had when OpenBot last quit, for when setup hands over.
    pub fn remember_app(&self, app: AppSize) {
        let mut sizing = self.sizing();
        if let Sizing::Setup { .. } = *sizing {
            *sizing = Sizing::Setup { app: Some(app) };
        }
    }

    /// A page loaded: setup's, or anything else. `current` reads OpenBot's size off the window, and
    /// is asked only when setup takes over from it.
    pub fn show(&self, setup: bool, current: impl FnOnce() -> Option<AppSize>) -> Change {
        let mut sizing = self.sizing();
        match (*sizing, setup) {
            (Sizing::Setup { .. }, true) | (Sizing::App, false) => Change::Stays,
            (Sizing::App, true) => {
                *sizing = Sizing::Setup { app: current() };
                Change::ToSetup
            }
            (Sizing::Setup { app }, false) => {
                *sizing = Sizing::App;
                Change::ToApp(app)
            }
        }
    }

    /// Whether the window is held at setup's size.
    pub fn fixed(&self) -> bool {
        matches!(*self.sizing(), Sizing::Setup { .. })
    }

    /// OpenBot's size to keep for the next launch: only while setup holds the window, which then
    /// is not the size OpenBot had.
    pub fn app_size_to_keep(&self) -> Option<AppSize> {
        match *self.sizing() {
            Sizing::Setup { app } => app,
            Sizing::App => None,
        }
    }
}

/// Room left between setup's window and the edge of its screen's work area (`SCREEN_MARGIN`).
pub const MARGIN: f64 = 24.0;

/**
Setup's size, in logical pixels: the configured window's (`wanted`, 1000 by 800), or less where the
screen's work area (`room`, with `frame` the title bar's height, which macOS's overlay bar makes 0)
can't hold it with `MARGIN` around it. Never larger than configured, whatever the screen.
*/
pub fn setup_size(wanted: (f64, f64), room: Option<(f64, f64)>, frame: f64) -> (f64, f64) {
    let Some((width, height)) = room else {
        return wanted;
    };
    let widest = (width - 2.0 * MARGIN).floor();
    let tallest = (height - frame - 2.0 * MARGIN).floor();
    (
        wanted.0.min(widest).max(1.0),
        wanted.1.min(tallest).max(1.0),
    )
}

/**
The window-state plugin's file (`saved`) with `label`'s window given OpenBot's size back: `app`,
at `scale` physical pixels per logical one, as the plugin keeps sizes. A maximized window keeps
its place as where it was before it was maximized (`prev_x`, `prev_y`), which is where the plugin
reads it from. None when the file can't be read or has no such window: nothing is written then.
*/
pub fn keep_app_size(saved: &str, label: &str, app: AppSize, scale: f64) -> Option<String> {
    let mut states: serde_json::Value = serde_json::from_str(saved).ok()?;
    let window = states.get_mut(label)?.as_object_mut()?;
    if let Some((width, height)) = app.size {
        let physical = |logical: f64| (logical * scale).round().max(1.0) as u64;
        window.insert("width".into(), physical(width).into());
        window.insert("height".into(), physical(height).into());
    }
    window.insert("maximized".into(), app.maximized.into());
    if app.maximized {
        let x = window.get("x").cloned()?;
        let y = window.get("y").cloned()?;
        window.insert("prev_x".into(), x);
        window.insert("prev_y".into(), y);
    }
    serde_json::to_string_pretty(&states).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FREE: AppSize = AppSize {
        size: Some((1400.0, 900.0)),
        maximized: false,
    };

    /// Dusty's ask, in order: setup at one size, OpenBot resizable at the size it had, setup back
    /// (a stop) at setup's size again with OpenBot's kept, and OpenBot again at that.
    #[test]
    fn setup_holds_the_window_and_openbot_gets_its_own_size_back() {
        let state = State::default();
        assert!(state.fixed(), "the window opens on setup");
        // Launch: the size the plugin saved at the last quit.
        state.remember_app(FREE);
        // The setup page loads, and loads again (a reload): nothing moves.
        let never = || -> Option<AppSize> { panic!("setup is not OpenBot's size") };
        assert_eq!(state.show(true, never), Change::Stays);
        assert_eq!(state.show(true, never), Change::Stays);
        // The handover: OpenBot gets its size back.
        assert_eq!(state.show(false, never), Change::ToApp(Some(FREE)));
        assert!(!state.fixed());
        assert_eq!(
            state.app_size_to_keep(),
            None,
            "the plugin saves the live size"
        );
        // OpenBot's own pages, one after the other: nothing moves.
        assert_eq!(state.show(false, never), Change::Stays);
        // A stop: setup comes back. OpenBot's size, as the person left it, is kept.
        let resized = AppSize {
            size: Some((1200.0, 760.0)),
            maximized: false,
        };
        assert_eq!(state.show(true, || Some(resized)), Change::ToSetup);
        assert!(state.fixed());
        assert_eq!(state.app_size_to_keep(), Some(resized));
        // Started again: OpenBot at that size.
        assert_eq!(state.show(false, never), Change::ToApp(Some(resized)));
        // Once the window has been OpenBot's, the launch's saved size is not put back.
        state.remember_app(FREE);
        assert!(!state.fixed());
    }

    /// A first install: nothing saved, so OpenBot keeps setup's size and can then be resized.
    #[test]
    fn a_first_install_hands_over_at_setups_size() {
        let state = State::default();
        assert_eq!(state.app_size_to_keep(), None);
        assert_eq!(state.show(false, || None), Change::ToApp(None));
    }

    #[test]
    fn a_maximized_app_keeps_its_normal_size_through_setup_and_quit() {
        let state = State::default();
        state.show(false, || None);
        // Windows reads the normal size after restoring the maximized window, before setup
        // replaces it with 1000 by 800. Keep both the size and the original maximized flag.
        let live_size = std::cell::Cell::new((2560.0, 1440.0));
        let maximized = capture_app_size(
            true,
            true,
            || {
                live_size.set(FREE.size.unwrap());
                Some(())
            },
            || Some(live_size.get()),
        )
        .unwrap();
        assert_eq!(maximized.size, FREE.size);
        assert!(maximized.maximized);
        assert_eq!(state.show(true, || Some(maximized)), Change::ToSetup);
        let setup_saved =
            r#"{"main":{"width":1000,"height":800,"x":400,"y":90,"maximized":false}}"#;
        let kept: serde_json::Value = serde_json::from_str(
            &keep_app_size(setup_saved, "main", state.app_size_to_keep().unwrap(), 1.5).unwrap(),
        )
        .unwrap();
        assert_eq!(kept["main"]["width"], 2100);
        assert_eq!(kept["main"]["height"], 1350);
        assert_eq!(kept["main"]["maximized"], true);
        // Returning to the app supplies its normal size before maximizing again. Unmaximizing
        // then stopping keeps that same normal size, now without the maximized flag.
        assert_eq!(state.show(false, || None), Change::ToApp(Some(maximized)));
        assert_eq!(state.show(true, || Some(FREE)), Change::ToSetup);
        let kept: serde_json::Value = serde_json::from_str(
            &keep_app_size(setup_saved, "main", state.app_size_to_keep().unwrap(), 1.0).unwrap(),
        )
        .unwrap();
        assert_eq!(kept["main"]["width"], 1400);
        assert_eq!(kept["main"]["height"], 900);
        assert_eq!(kept["main"]["maximized"], false);
    }

    #[test]
    fn capture_only_restores_when_the_normal_size_can_be_read_synchronously() {
        assert_eq!(
            capture_app_size(false, true, || panic!("already normal"), || FREE.size),
            Some(FREE)
        );
        assert_eq!(
            capture_app_size(
                true,
                false,
                || panic!("asynchronous restore"),
                || panic!("still maximized"),
            ),
            Some(AppSize {
                size: None,
                maximized: true
            })
        );
        assert_eq!(
            capture_app_size(true, true, || None, || panic!("restore failed")),
            None
        );
    }

    /// Setup's size: the configured one on any screen that holds it, never larger on a large one,
    /// and smaller on a small one.
    #[test]
    fn setup_is_the_configured_size_or_less_to_fit_the_screen() {
        let wanted = (1000.0, 800.0);
        assert_eq!(setup_size(wanted, None, 0.0), wanted);
        // A 27-inch screen: still 1000 by 800.
        assert_eq!(setup_size(wanted, Some((2560.0, 1415.0)), 0.0), wanted);
        // A MacBook Air's 1440 by 900 less the 33-point menu bar and the Dock: 800 tall fits in
        // 821, with the margins.
        assert_eq!(
            setup_size(wanted, Some((1440.0, 821.0)), 0.0),
            (1000.0, 773.0)
        );
        // A 1366 by 768 Windows laptop, the taskbar's 40 below and a 31-pixel title bar.
        assert_eq!(
            setup_size(wanted, Some((1366.0, 728.0)), 31.0),
            (1000.0, 649.0)
        );
        // A screen narrower than the window.
        assert_eq!(
            setup_size(wanted, Some((960.0, 1040.0)), 31.0),
            (912.0, 800.0)
        );
    }

    /// Quit while setup shows: the plugin saved setup's size, and OpenBot's goes back over it.
    #[test]
    fn quitting_on_setup_keeps_openbots_size_for_the_next_launch() {
        let saved = r#"{"main":{"width":1000,"height":800,"x":400,"y":90,"prev_x":380,"prev_y":70,"maximized":false,"visible":true,"decorated":true,"fullscreen":false},"other":{"width":5,"height":5,"x":0,"y":0,"prev_x":0,"prev_y":0,"maximized":false,"visible":true,"decorated":true,"fullscreen":false}}"#;
        let kept: serde_json::Value =
            serde_json::from_str(&keep_app_size(saved, "main", FREE, 2.0).unwrap()).unwrap();
        assert_eq!(kept["main"]["width"], 2800);
        assert_eq!(kept["main"]["height"], 1800);
        assert_eq!(kept["main"]["maximized"], false);
        // Where it is stays where it is; nothing else changes.
        assert_eq!(
            (kept["main"]["x"].clone(), kept["main"]["y"].clone()),
            (400.into(), 90.into())
        );
        assert_eq!(kept["main"]["prev_x"], 380);
        assert_eq!(kept["main"]["fullscreen"], false);
        assert_eq!(kept["other"]["width"], 5);
        // Maximized: it opens maximized where it is (the plugin reads a maximized window's place
        // from `prev_x` and `prev_y`), and keeps the size it had under that.
        let maximized = AppSize {
            size: Some((1400.0, 900.0)),
            maximized: true,
        };
        let kept: serde_json::Value =
            serde_json::from_str(&keep_app_size(saved, "main", maximized, 1.0).unwrap()).unwrap();
        assert_eq!(kept["main"]["maximized"], true);
        assert_eq!(
            (
                kept["main"]["prev_x"].clone(),
                kept["main"]["prev_y"].clone()
            ),
            (400.into(), 90.into())
        );
        assert_eq!(kept["main"]["width"], 1400);
        // macOS's asynchronous unzoom cannot supply a normal size here: keep the saved size.
        let zoomed = AppSize {
            size: None,
            maximized: true,
        };
        let kept: serde_json::Value =
            serde_json::from_str(&keep_app_size(saved, "main", zoomed, 1.0).unwrap()).unwrap();
        assert_eq!(
            (
                kept["main"]["width"].clone(),
                kept["main"]["maximized"].clone()
            ),
            (1000.into(), true.into())
        );
        // Nothing to write over.
        assert_eq!(keep_app_size("not json", "main", FREE, 1.0), None);
        assert_eq!(keep_app_size(r#"{"status":{}}"#, "main", FREE, 1.0), None);
    }
}
