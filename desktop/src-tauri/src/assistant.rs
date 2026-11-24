/*!
Compact view: OpenBot as a small bubble over every other app, in place of its window.

Settings → General → Compact view (`desktop_page::compact_view`, `set_compact_view`) turns it on and
off, and the choice is kept for the next launch beside `zoom.json` (`FILE`). While it is on, OpenBot's
page shows in a second window, `assistant`, at the app's `/assistant`: a bubble the person drags
anywhere, above other windows and on every desktop, which opens into a small panel with the person's
conversations down its left side and a chat beside them (`expand`, `collapse`). The main window stays
loaded and hidden. Show Window, the Dock icon and the panel's Open OpenBot bring it back.

The window is transparent, so only the orb shows while it is a bubble, and it is left out of screen
capture (`content_protected`), so a Bot using this Mac (`person_computer`) never sees it in a
screenshot. While that Bot clicks, types and takes its screenshot, the window lets the mouse through
(`step_aside`), so a click meant for the app beneath reaches that app.

The panel opens toward the middle of the screen from the bubble's corner, and folds back into a bubble
at the corner it opened from, wherever the panel was dragged since (`panel_from`, `bubble_from`).

macOS only for now, like the Bot using this Mac it is made for.

Geometry is in points (logical pixels) throughout: macOS lays its screens out in points, so a place
in points means the same spot on every screen, whatever their scale.
*/
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::Manager as _;

/// The window's label.
pub const LABEL: &str = "assistant";
/// Where the choice and the bubble's place are kept, beside `zoom.json`.
pub const FILE: &str = "compact-view.json";
/// The page the window shows, on the OpenBot the main window shows.
pub const PAGE: &str = "/assistant";

/// The bubble's window, in points: the app's 60 point orb, and the room its glow needs
/// (`ORB_GLOW_REACH` in the app's orb, 0.4 of the orb on every side) when it grows under the pointer.
const BUBBLE: f64 = 120.0;
/// The panel's window, in points, its shadow's margin included.
const PANEL_WIDTH: f64 = 720.0;
const PANEL_HEIGHT: f64 = 540.0;
/// The bubble's first place: this far in from the bottom right of the main screen.
const MARGIN: f64 = 24.0;
/// How long the bubble has to stay put before its place is written down.
const SAVE_AFTER: Duration = Duration::from_millis(500);
/// The longest an action of a Bot waits for the bubble to let the mouse through, or take it back.
const STEP_ASIDE_LIMIT: Duration = Duration::from_millis(500);

/// Told to the page when its window changes shape without the page asking (`tell_page`).
const LAYOUT_EVENT: &str = "openbot:assistant-layout";

const NOT_OPEN: &str = "Compact view isn't open.";
const NOT_SHOWING: &str = "OpenBot isn't showing yet. Try again once it has started.";
const UNAVAILABLE: &str = "Compact view works only on a Mac, with OpenBot running on it.";

/// A place in points, from the main screen's top left.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// What `FILE` keeps.
#[derive(Debug, Default, Clone, Copy, PartialEq, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    on: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bubble: Option<Point>,
}

/// A rectangle in points.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// The corner of the panel the bubble sits at: the panel opens from it toward the screen's middle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl Corner {
    fn right(self) -> bool {
        matches!(self, Corner::TopRight | Corner::BottomRight)
    }

    fn bottom(self) -> bool {
        matches!(self, Corner::BottomLeft | Corner::BottomRight)
    }
}

/// What the page draws: the bubble, or the panel, opened from `corner`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub expanded: bool,
    pub corner: Corner,
}

/// Settings' Compact view row: whether it is on, and whether this computer can have it at all.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactView {
    pub on: bool,
    pub available: bool,
}

struct State {
    /// `FILE` is read once, at the first question.
    loaded: bool,
    on: bool,
    /// The bubble's top left, while it is a bubble and as it was when the panel opened.
    bubble: Option<Point>,
    expanded: bool,
    corner: Corner,
    /// Actions of a Bot using this Mac under way, each with the bubble stepped aside (`Aside`).
    aside: u32,
}

static STATE: Mutex<State> = Mutex::new(State {
    loaded: false,
    on: false,
    bubble: None,
    expanded: false,
    corner: Corner::BottomRight,
    aside: 0,
});

/// Never held while a window is asked anything: a window's answer comes from the main thread, and
/// the main thread takes this lock when the bubble moves (`moved`).
fn state<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> MutexGuard<'static, State> {
    let mut state = STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !state.loaded {
        state.loaded = true;
        if let Ok(directory) = app.path().app_config_dir() {
            let saved = read(&directory);
            state.on = saved.on;
            state.bubble = saved.bubble;
        }
    }
    state
}

fn read(directory: &Path) -> Saved {
    std::fs::read_to_string(directory.join(FILE))
        .ok()
        .and_then(|record| serde_json::from_str(&record).ok())
        .unwrap_or_default()
}

fn write(directory: &Path, saved: &Saved) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)?;
    let record = serde_json::to_string(saved).map_err(std::io::Error::other)?;
    std::fs::write(directory.join(FILE), record)
}

fn save_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let saved = {
        let state = state(app);
        Saved {
            on: state.on,
            bubble: state.bubble,
        }
    };
    write(&directory, &saved).map_err(|error| error.to_string())
}

/// Moves come many times a second while the bubble is dragged: its place is written once it stays.
static MOVES: AtomicU64 = AtomicU64::new(0);
static SAVING: AtomicBool = AtomicBool::new(false);

fn save_soon<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    MOVES.fetch_add(1, Ordering::SeqCst);
    if SAVING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        let seen = MOVES.load(Ordering::SeqCst);
        std::thread::sleep(SAVE_AFTER);
        if MOVES.load(Ordering::SeqCst) != seen {
            continue;
        }
        if let Err(error) = save_now(&app) {
            log::warn!("[assistant] could not keep the bubble's place: {error}");
        }
        SAVING.store(false, Ordering::SeqCst);
        // A move between the write and the flag would otherwise wait for the next move.
        if MOVES.load(Ordering::SeqCst) == seen || SAVING.swap(true, Ordering::SeqCst) {
            break;
        }
    });
}

/// Whether this computer can have compact view: a Mac, showing the OpenBot that runs on it.
pub fn available<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    cfg!(target_os = "macos") && !crate::desktop_connected::is_connected(app)
}

/// Whether compact view is on and can be.
pub fn is_on<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    available(app) && state(app).on
}

pub fn compact_view<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> CompactView {
    CompactView {
        on: state(app).on,
        available: available(app),
    }
}

/**
Compact view switched from Settings, at once. On: the bubble shows at OpenBot's `/assistant`, on the
OpenBot the main window shows, and the main window hides. Off: the bubble goes and the main window
comes back in front. Kept for the next launch either way.
*/
pub fn switch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    on: bool,
) -> Result<CompactView, String> {
    if on && !available(app) {
        return Err(UNAVAILABLE.into());
    }
    let main = app.get_webview_window("main");
    // Where the bubble's page is, before anything changes: the OpenBot the main window shows.
    let page = match (on, &main) {
        (true, Some(window)) => Some(page_on(&window.url().map_err(|_| NOT_SHOWING)?)),
        (true, None) => return Err(NOT_SHOWING.into()),
        (false, _) => None,
    };
    state(app).on = on;
    save_now(app)?;
    match page {
        Some(page) => {
            open(app, page)?;
            if let Some(main) = main {
                let _ = main.hide();
            }
        }
        None => {
            close(app);
            crate::bring_to_front(app, "compact view is off");
        }
    }
    Ok(compact_view(app))
}

/// The bubble's page on the OpenBot at `shown`: its origin, at `PAGE`.
pub fn page_on(shown: &tauri::Url) -> tauri::Url {
    let mut page = shown.clone();
    page.set_path(PAGE);
    page.set_query(None);
    page.set_fragment(None);
    page
}

/**
Shows the bubble at `page`, building its window the first time. A window already there keeps what
it shows, unless OpenBot has moved to another address since (a restart on other ports).
*/
pub fn open<R: tauri::Runtime>(app: &tauri::AppHandle<R>, page: tauri::Url) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        let same_openbot = window
            .url()
            .is_ok_and(|current| current.origin() == page.origin());
        if !same_openbot {
            window.navigate(page).map_err(|error| error.to_string())?;
        }
        window.show().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let bubble = {
        let screens = screens(app);
        let main = main_screen(app)
            .or_else(|| screens.first().copied())
            .unwrap_or(FALLBACK_SCREEN);
        let saved = state(app).bubble;
        bubble_at(saved, &screens, main)
    };
    {
        let mut state = state(app);
        state.expanded = false;
        state.bubble = Some(Point {
            x: bubble.x,
            y: bubble.y,
        });
    }
    let title = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .map(|window| window.title.clone())
        .unwrap_or_else(|| "OpenBot".into());
    let opener = app.clone();
    let window = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::External(page))
        .title(title)
        .inner_size(BUBBLE, BUBBLE)
        .position(bubble.x, bubble.y)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        // Shown without taking the keyboard from the app the person is in.
        .focused(false)
        // A click on the bubble while another app is in front opens it, rather than only
        // bringing OpenBot forward.
        .accept_first_mouse(true)
        // Never in a screenshot, a Bot's (`person_computer`) or anyone's.
        .content_protected(true)
        .on_new_window(move |destination, _features| {
            // As the main window does: a site outside OpenBot opens in the person's browser.
            crate::outside_links::new_window(&destination, |_| {
                crate::open_in_browser(&opener, &destination);
            });
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    over_full_screen_apps(&window);
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Moved(position) = event {
            moved(&handle, *position);
        }
    });
    Ok(())
}

/// The bubble gone, until compact view shows it again. Its place is kept.
pub fn close<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
    state(app).expanded = false;
}

/// What the page draws now.
pub fn layout<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Layout {
    let state = state(app);
    Layout {
        expanded: state.expanded,
        corner: state.corner,
    }
}

/// The bubble opened into the panel, toward the screen's middle, and given the keyboard.
pub fn expand<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Layout, String> {
    let window = app.get_webview_window(LABEL).ok_or(NOT_OPEN)?;
    let current = layout(app);
    if current.expanded {
        let _ = window.set_focus();
        return Ok(current);
    }
    let shown = frame(&window)?;
    let bubble = Rect {
        width: BUBBLE,
        height: BUBBLE,
        ..shown
    };
    let area = screen_for(bubble, &screens(app)).unwrap_or(FALLBACK_SCREEN);
    let (panel, corner) = panel_from(bubble, area);
    {
        let mut state = state(app);
        state.expanded = true;
        state.corner = corner;
        state.bubble = Some(Point {
            x: bubble.x,
            y: bubble.y,
        });
    }
    save_soon(app);
    reshape(&window, panel)?;
    let _ = window.set_focus();
    Ok(Layout {
        expanded: true,
        corner,
    })
}

/// The panel folded back into the bubble, at the corner it opened from.
pub fn collapse<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Layout, String> {
    let window = app.get_webview_window(LABEL).ok_or(NOT_OPEN)?;
    let current = layout(app);
    if !current.expanded {
        return Ok(current);
    }
    let panel = frame(&window)?;
    let area = screen_for(panel, &screens(app)).unwrap_or(FALLBACK_SCREEN);
    let bubble = bubble_from(panel, current.corner, area);
    {
        let mut state = state(app);
        state.expanded = false;
        state.bubble = Some(Point {
            x: bubble.x,
            y: bubble.y,
        });
    }
    save_soon(app);
    reshape(&window, bubble)?;
    Ok(Layout {
        expanded: false,
        corner: current.corner,
    })
}

/// Close Window (Command-W) on the panel folds it into the bubble; the bubble itself stays.
pub fn close_requested<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let (Ok(layout), Some(window)) = (collapse(app), app.get_webview_window(LABEL)) {
        tell_page(&window, layout);
    }
}

/// The panel's Open OpenBot: the panel folds into the bubble, and the main window comes forward,
/// at `path` when the panel names one of OpenBot's pages (the conversation it shows).
pub fn open_full<R: tauri::Runtime>(app: &tauri::AppHandle<R>, path: Option<String>) {
    if let (Ok(layout), Some(window)) = (collapse(app), app.get_webview_window(LABEL)) {
        tell_page(&window, layout);
    }
    crate::bring_to_front(app, "the compact view's panel opened OpenBot");
    let (Some(path), Some(main)) = (path, app.get_webview_window("main")) else {
        return;
    };
    if let Ok(current) = main.url() {
        crate::navigate_to_notice_page(&current, &path, |script| main.eval(script));
    }
}

/**
The window a Bot's question to use this Mac is asked over, when the bubble's page asked
(`person_computer::allow`): the panel, in front. None while it is a bubble, too small to hold the
question, which is then asked on its own, with OpenBot brought forward first.
*/
pub fn asking_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<tauri::WebviewWindow<R>> {
    let window = app.get_webview_window(LABEL)?;
    let _ = window.set_focus();
    layout(app).expanded.then_some(window)
}

/**
While an action of a Bot using this Mac runs (`person_computer`), from its first event to its
screenshot: the bubble lets the mouse through, so a click meant for the app beneath it reaches that
app. Back as it was when the guard goes, however the action ended. Actions that overlap share one
step aside.
*/
pub struct Aside<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

pub fn step_aside<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Aside<R> {
    let first = {
        let mut state = STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.aside += 1;
        state.aside == 1
    };
    if first {
        let_mouse_through(app, true);
    }
    Aside { app: app.clone() }
}

impl<R: tauri::Runtime> Drop for Aside<R> {
    fn drop(&mut self) {
        let last = {
            let mut state = STATE
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.aside = state.aside.saturating_sub(1);
            state.aside == 0
        };
        if last {
            let_mouse_through(&self.app, false);
        }
    }
}

/// Applied on the main thread and waited for, so it holds before the action's first event is posted.
fn let_mouse_through<R: tauri::Runtime>(app: &tauri::AppHandle<R>, through: bool) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let (done, applied) = std::sync::mpsc::channel();
    let target = window.clone();
    let asked = window.run_on_main_thread(move || {
        let _ = target.set_ignore_cursor_events(through);
        let _ = done.send(());
    });
    if asked.is_ok() {
        let _ = applied.recv_timeout(STEP_ASIDE_LIMIT);
    }
}

/// The page told of a change it did not ask for, as a DOM event (`LAYOUT_EVENT`).
fn tell_page<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, layout: Layout) {
    if let Ok(detail) = serde_json::to_string(&layout) {
        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent({LAYOUT_EVENT:?}, {{ detail: {detail} }}))"
        ));
    }
}

/// The bubble dragged: its new place is kept, while it is a bubble. The panel's moves are not: it
/// folds back at its corner (`collapse`).
fn moved<R: tauri::Runtime>(app: &tauri::AppHandle<R>, position: tauri::PhysicalPosition<i32>) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let at = position.to_logical::<f64>(scale);
    {
        let mut state = state(app);
        if state.expanded {
            return;
        }
        state.bubble = Some(Point { x: at.x, y: at.y });
    }
    save_soon(app);
}

/// The window's frame, in points.
fn frame<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<Rect, String> {
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let at = window
        .outer_position()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    let size = window
        .outer_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    Ok(Rect {
        x: at.x,
        y: at.y,
        width: size.width,
        height: size.height,
    })
}

/// Size and place in one turn of the main thread, so the window never shows one without the other.
fn reshape<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, to: Rect) -> Result<(), String> {
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = target.set_size(tauri::LogicalSize::new(to.width, to.height));
            let _ = target.set_position(tauri::LogicalPosition::new(to.x, to.y));
        })
        .map_err(|error| error.to_string())
}

/// Over an app in full screen too, as the menu bar's own windows are.
#[cfg(target_os = "macos")]
fn over_full_screen_apps<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    // NSWindowCollectionBehaviorCanJoinAllSpaces and NSWindowCollectionBehaviorFullScreenAuxiliary.
    const BEHAVIOR: usize = (1 << 0) | (1 << 8);
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(ns_window) = target.ns_window() else {
            return;
        };
        // SAFETY: `ns_window` is this window's live NSWindow, used on the main thread.
        unsafe {
            let ns_window = ns_window.cast::<objc2::runtime::AnyObject>();
            let behavior: usize = objc2::msg_send![ns_window, collectionBehavior];
            let _: () = objc2::msg_send![ns_window, setCollectionBehavior: behavior | BEHAVIOR];
        }
    });
}

/// Used when no screen answers, which only a machine with no display does.
const FALLBACK_SCREEN: Rect = Rect {
    x: 0.0,
    y: 0.0,
    width: 1440.0,
    height: 900.0,
};

fn in_points(area: &tauri::PhysicalRect<i32, u32>, scale: f64) -> Rect {
    Rect {
        x: f64::from(area.position.x) / scale,
        y: f64::from(area.position.y) / scale,
        width: f64::from(area.size.width) / scale,
        height: f64::from(area.size.height) / scale,
    }
}

/// Every screen's usable part: below the menu bar and clear of the Dock.
fn screens<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<Rect> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| in_points(monitor.work_area(), monitor.scale_factor()))
        .collect()
}

fn main_screen<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<Rect> {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| in_points(monitor.work_area(), monitor.scale_factor()))
}

fn overlap(a: Rect, b: Rect) -> f64 {
    let width = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let height = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    if width <= 0.0 || height <= 0.0 {
        0.0
    } else {
        width * height
    }
}

/// The screen holding most of `rect`, if any holds part of it.
fn screen_for(rect: Rect, screens: &[Rect]) -> Option<Rect> {
    screens
        .iter()
        .copied()
        .filter(|screen| overlap(rect, *screen) > 0.0)
        .max_by(|a, b| overlap(rect, *a).total_cmp(&overlap(rect, *b)))
}

/// `rect` moved, never resized, until it is inside `area` (or at its top left, when larger).
fn clamp(rect: Rect, area: Rect) -> Rect {
    Rect {
        x: rect.x.min(area.x + area.width - rect.width).max(area.x),
        y: rect.y.min(area.y + area.height - rect.height).max(area.y),
        ..rect
    }
}

/// The bubble's first place: the bottom right of the main screen, `MARGIN` in from its edges.
fn first_bubble(main: Rect) -> Rect {
    clamp(
        Rect {
            x: main.x + main.width - BUBBLE - MARGIN,
            y: main.y + main.height - BUBBLE - MARGIN,
            width: BUBBLE,
            height: BUBBLE,
        },
        main,
    )
}

/// Where the bubble shows: its saved place, kept on the screen it was on, or its first place when
/// that screen is gone.
fn bubble_at(saved: Option<Point>, screens: &[Rect], main: Rect) -> Rect {
    saved
        .map(|point| Rect {
            x: point.x,
            y: point.y,
            width: BUBBLE,
            height: BUBBLE,
        })
        .and_then(|rect| screen_for(rect, screens).map(|screen| clamp(rect, screen)))
        .unwrap_or_else(|| first_bubble(main))
}

/// The panel opened from `bubble`: toward the middle of `area`, with the bubble's corner of it
/// where the bubble's own corner was, moved in only as far as the screen's edges need.
fn panel_from(bubble: Rect, area: Rect) -> (Rect, Corner) {
    let right = bubble.x + bubble.width / 2.0 > area.x + area.width / 2.0;
    let bottom = bubble.y + bubble.height / 2.0 > area.y + area.height / 2.0;
    let width = PANEL_WIDTH.min(area.width);
    let height = PANEL_HEIGHT.min(area.height);
    let panel = Rect {
        x: if right {
            bubble.x + bubble.width - width
        } else {
            bubble.x
        },
        y: if bottom {
            bubble.y + bubble.height - height
        } else {
            bubble.y
        },
        width,
        height,
    };
    let corner = match (bottom, right) {
        (false, false) => Corner::TopLeft,
        (false, true) => Corner::TopRight,
        (true, false) => Corner::BottomLeft,
        (true, true) => Corner::BottomRight,
    };
    (clamp(panel, area), corner)
}

/// The bubble folded from `panel` at `corner`, the corner it opened from.
fn bubble_from(panel: Rect, corner: Corner, area: Rect) -> Rect {
    clamp(
        Rect {
            x: if corner.right() {
                panel.x + panel.width - BUBBLE
            } else {
                panel.x
            },
            y: if corner.bottom() {
                panel.y + panel.height - BUBBLE
            } else {
                panel.y
            },
            width: BUBBLE,
            height: BUBBLE,
        },
        area,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 1512 by 982 point MacBook screen, below a 33 point menu bar and beside no Dock.
    const LAPTOP: Rect = Rect {
        x: 0.0,
        y: 33.0,
        width: 1512.0,
        height: 949.0,
    };
    /// A second screen to the laptop's right.
    const BESIDE: Rect = Rect {
        x: 1512.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };

    fn bubble(x: f64, y: f64) -> Rect {
        Rect {
            x,
            y,
            width: BUBBLE,
            height: BUBBLE,
        }
    }

    #[test]
    fn the_bubble_starts_at_the_bottom_right_of_the_main_screen() {
        let first = bubble_at(None, &[LAPTOP, BESIDE], LAPTOP);
        assert_eq!(
            first,
            bubble(1512.0 - BUBBLE - MARGIN, 982.0 - BUBBLE - MARGIN)
        );
    }

    #[test]
    fn a_saved_place_is_kept_on_its_screen_and_dropped_with_the_screen() {
        let saved = Some(Point {
            x: 2000.0,
            y: 300.0,
        });
        assert_eq!(
            bubble_at(saved, &[LAPTOP, BESIDE], LAPTOP),
            bubble(2000.0, 300.0)
        );
        // Half off the screen's edge: moved back on.
        let edge = Some(Point {
            x: 3400.0,
            y: 1050.0,
        });
        assert_eq!(
            bubble_at(edge, &[LAPTOP, BESIDE], LAPTOP),
            bubble(3432.0 - BUBBLE, 1080.0 - BUBBLE)
        );
        // The screen it was on is unplugged: back to its first place.
        assert_eq!(
            bubble_at(saved, &[LAPTOP], LAPTOP),
            bubble_at(None, &[LAPTOP], LAPTOP)
        );
    }

    #[test]
    fn the_panel_opens_toward_the_middle_and_keeps_the_bubbles_corner() {
        let bottom_right = bubble(1360.0, 840.0);
        let (panel, corner) = panel_from(bottom_right, LAPTOP);
        assert_eq!(corner, Corner::BottomRight);
        assert_eq!(panel.x + panel.width, bottom_right.x + bottom_right.width);
        assert_eq!(panel.y + panel.height, bottom_right.y + bottom_right.height);
        assert_eq!((panel.width, panel.height), (PANEL_WIDTH, PANEL_HEIGHT));

        let top_left = bubble(40.0, 60.0);
        let (panel, corner) = panel_from(top_left, LAPTOP);
        assert_eq!(corner, Corner::TopLeft);
        assert_eq!((panel.x, panel.y), (40.0, 60.0));
    }

    #[test]
    fn a_panel_that_would_leave_the_screen_is_moved_onto_it() {
        // Bottom left, near the edge, on a screen too short for the panel above the bubble.
        let short = Rect {
            x: 0.0,
            y: 25.0,
            width: 1280.0,
            height: 500.0,
        };
        let (panel, corner) = panel_from(bubble(10.0, 400.0), short);
        assert_eq!(corner, Corner::BottomLeft);
        assert_eq!(panel.height, 500.0, "never taller than the screen");
        assert_eq!(panel.y, 25.0);
        assert_eq!(panel.x, 10.0);
    }

    #[test]
    fn the_bubble_folds_back_at_the_corner_the_panel_opened_from() {
        let start = bubble(1360.0, 840.0);
        let (panel, corner) = panel_from(start, LAPTOP);
        assert_eq!(bubble_from(panel, corner, LAPTOP), start);
        // The panel dragged elsewhere: the bubble folds at the same corner of where it is now.
        let moved = Rect {
            x: 200.0,
            y: 100.0,
            ..panel
        };
        assert_eq!(
            bubble_from(moved, corner, LAPTOP),
            bubble(200.0 + PANEL_WIDTH - BUBBLE, 100.0 + PANEL_HEIGHT - BUBBLE)
        );
    }

    #[test]
    fn the_page_is_on_the_origin_the_main_window_shows() {
        let shown: tauri::Url = "http://127.0.0.1:3010/channel/abc?settings=true#top"
            .parse()
            .unwrap();
        assert_eq!(page_on(&shown).as_str(), "http://127.0.0.1:3010/assistant");
    }

    #[test]
    fn the_choice_and_the_place_are_kept_for_the_next_launch() {
        let directory = crate::test_support::temp_root("compact-view");
        assert_eq!(read(&directory), Saved::default(), "off, with no place yet");
        let saved = Saved {
            on: true,
            bubble: Some(Point { x: 12.5, y: 40.0 }),
        };
        write(&directory, &saved).unwrap();
        assert_eq!(read(&directory), saved);
        std::fs::write(directory.join(FILE), "not json").unwrap();
        assert_eq!(read(&directory), Saved::default());
    }

    #[test]
    fn the_page_reads_its_layout_in_its_own_words() {
        let layout = Layout {
            expanded: true,
            corner: Corner::BottomRight,
        };
        assert_eq!(
            serde_json::to_value(layout).unwrap(),
            serde_json::json!({ "expanded": true, "corner": "bottom-right" })
        );
        assert_eq!(
            serde_json::to_value(CompactView {
                on: false,
                available: true
            })
            .unwrap(),
            serde_json::json!({ "on": false, "available": true })
        );
    }
}
