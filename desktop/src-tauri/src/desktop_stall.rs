//! The native side of `stall`: which steps it times, how it reads whether the window is on screen,
//! and what it records and logs. Nothing here waits on the window, and nothing holds setup up.
use std::sync::Mutex;
use std::time::{Duration, Instant};

use openbot_desktop_lib::{local_eval, local_images, stall, telemetry};
use tauri::Manager;

use crate::desktop_telemetry;

/// How often the watch looks at the running steps and the window.
const EVERY: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct Stalls {
    steps: Mutex<stall::StepWatch>,
    ui: Mutex<stall::UiWatch>,
    /// The bytes the running setup or update's download had at the last look, by its attempt.
    bytes: Mutex<Option<(String, u64)>>,
    /// The window's handle, read when its page loads. Whether it is shown and minimised is read from
    /// the handle, without asking the window's own thread, which is the one that may be stuck.
    #[cfg(windows)]
    hwnd: std::sync::atomic::AtomicIsize,
    /// A look at the window on its own thread is under way.
    #[cfg(target_os = "macos")]
    looking: std::sync::atomic::AtomicBool,
}

fn lock<T>(held: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    held.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Start watching, on a thread of its own.
pub fn initialize<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    app.manage(Stalls::default());
    let app = app.clone();
    let watching = std::thread::Builder::new()
        .name("openbot-stall-watch".into())
        .spawn(move || loop {
            std::thread::sleep(EVERY);
            let on_screen = on_screen(&app);
            follow_cli(&app, Instant::now());
            tick(&app, Instant::now(), on_screen);
        });
    if watching.is_err() {
        log::warn!("[stall] the watch for steps that run long could not start");
    }
}

/// A setup row is running: OpenBot's own start, or the release row OpenBot updating itself says.
pub fn row_running<R: tauri::Runtime>(app: &tauri::AppHandle<R>, step: &str, said: &str) {
    row_running_at(app, step, said, Instant::now());
}

fn row_running_at<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    step: &str,
    said: &str,
    now: Instant,
) {
    let Some(stalls) = app.try_state::<Stalls>() else {
        return;
    };
    let mut steps = lock(&stalls.steps);
    if step == "release" {
        steps.now_in(telemetry::StallPart::Release, said, "", now);
    } else {
        steps.now_in(telemetry::StallPart::Start, step, "", now);
    }
}

/// A download the running row `step` waits on brought in more bytes: the machine image or OpenBot's
/// images the first screen started (`early_downloads`). Its clock restarts, as a moving download
/// restarts the clock of the CLI step it holds up (`follow_cli`).
pub fn moved<R: tauri::Runtime>(app: &tauri::AppHandle<R>, step: &str) {
    moved_at(app, step, Instant::now());
}

fn moved_at<R: tauri::Runtime>(app: &tauri::AppHandle<R>, step: &str, now: Instant) {
    let Some(stalls) = app.try_state::<Stalls>() else {
        return;
    };
    let mut steps = lock(&stalls.steps);
    if steps.timing(telemetry::StallPart::Start) == Some(step) {
        steps.moved(telemetry::StallPart::Start, now);
    }
}

/// A setup row finished, or failed.
pub fn row_done<R: tauri::Runtime>(app: &tauri::AppHandle<R>, step: &str) {
    let Some(stalls) = app.try_state::<Stalls>() else {
        return;
    };
    let mut steps = lock(&stalls.steps);
    if step == "release" {
        steps.done(telemetry::StallPart::Release);
    } else if steps.timing(telemetry::StallPart::Start) == Some(step) {
        steps.done(telemetry::StallPart::Start);
    }
}

/// A progress event about the row `step` is going to the setup page: its number, which the page's
/// heartbeat says back once it has it.
pub fn sent<R: tauri::Runtime>(app: &tauri::AppHandle<R>, step: &str) -> u64 {
    sent_at(app, step, Instant::now())
}

fn sent_at<R: tauri::Runtime>(app: &tauri::AppHandle<R>, step: &str, now: Instant) -> u64 {
    app.try_state::<Stalls>().map_or(0, |stalls| {
        lock(&stalls.ui).sent(telemetry::FailingStep::from_row(step), now)
    })
}

/// The setup page's heartbeat: the highest progress number it has taken, and whether it has just
/// loaded.
pub fn heartbeat<R: tauri::Runtime>(app: &tauri::AppHandle<R>, seen: u64, fresh: bool) {
    #[cfg(windows)]
    know_hwnd(app);
    heartbeat_at(app, seen, fresh, Instant::now());
}

/// The window's handle, if its page loaded before the watch began: asked once, while the page is
/// plainly answering.
#[cfg(windows)]
fn know_hwnd<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use std::sync::atomic::Ordering;
    let Some(stalls) = app.try_state::<Stalls>() else {
        return;
    };
    if stalls.hwnd.load(Ordering::SeqCst) != 0 {
        return;
    }
    if let Some(hwnd) = app
        .get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
    {
        stalls.hwnd.store(hwnd.0 as isize, Ordering::SeqCst);
    }
}

fn heartbeat_at<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    seen: u64,
    fresh: bool,
    now: Instant,
) {
    let Some(stalls) = app.try_state::<Stalls>() else {
        return;
    };
    let news = lock(&stalls.ui).heartbeat(seen, fresh, now);
    say(app, news);
}

/// The main window loaded a page. Until that page sends a heartbeat nothing is expected of it: it
/// may be OpenBot itself, which sends none.
pub fn page_loaded<R: tauri::Runtime>(window: &tauri::Webview<R>) {
    let app = window.app_handle();
    let Some(stalls) = app.try_state::<Stalls>() else {
        return;
    };
    #[cfg(windows)]
    if let Ok(hwnd) = window.window().hwnd() {
        stalls
            .hwnd
            .store(hwnd.0 as isize, std::sync::atomic::Ordering::SeqCst);
    }
    let news = lock(&stalls.ui).page_left(Instant::now());
    say(app, news);
}

/// OpenBot is quitting: a stall still going is recorded now, before the usage data is flushed.
pub fn at_quit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(stalls) = app.try_state::<Stalls>() else {
        return;
    };
    let news = lock(&stalls.ui).quit(Instant::now());
    say(app, news);
}

/// The `local setup` or `local update` running now, from the CLI's log, and its download's bytes.
fn follow_cli<R: tauri::Runtime>(app: &tauri::AppHandle<R>, now: Instant) {
    let Some(stalls) = app.try_state::<Stalls>() else {
        return;
    };
    let trail = local_eval::trail_now();
    let mut steps = lock(&stalls.steps);
    let mut bytes = lock(&stalls.bytes);
    let part = trail.as_ref().and_then(|trail| match trail.kind {
        local_eval::TrailKind::Setup => Some(telemetry::StallPart::Setup),
        local_eval::TrailKind::Update => Some(telemetry::StallPart::Update),
        local_eval::TrailKind::Other => None,
    });
    for other in [telemetry::StallPart::Setup, telemetry::StallPart::Update] {
        if Some(other) != part {
            steps.done(other);
        }
    }
    let (Some(trail), Some(part)) = (trail, part) else {
        *bytes = None;
        return;
    };
    steps.cli(part, &trail.attempt, &trail.ended, trail.since);
    if let Some(download) = local_images::downloading(&trail.attempt) {
        let moved = !matches!(&*bytes, Some((attempt, done))
            if *attempt == trail.attempt && *done >= download.done);
        if moved {
            steps.moved(part, now);
        }
        *bytes = Some((trail.attempt, download.done));
    }
}

/// One look: steps past their limit, and the window. `on_screen` is None when it could not be read.
fn tick<R: tauri::Runtime>(app: &tauri::AppHandle<R>, now: Instant, on_screen: Option<bool>) {
    let Some(stalls) = app.try_state::<Stalls>() else {
        return;
    };
    let stalled = lock(&stalls.steps).tick(now);
    for stalled in stalled {
        log::warn!(
            "[stall] {} step {} has run {}s; it typically takes {}s",
            stalled.part.as_str(),
            stalled.key,
            stalled.elapsed_seconds,
            stalled.typical_seconds
        );
        desktop_telemetry::record(
            app,
            telemetry::EventData::SetupStalled {
                part: stalled.part,
                step: stalled.step,
                typical_seconds: stalled.typical_seconds,
                elapsed_seconds: stalled.elapsed_seconds,
            },
        );
    }
    let news = {
        let mut ui = lock(&stalls.ui);
        let left = on_screen.and_then(|on_screen| ui.window(on_screen, now));
        left.or_else(|| ui.tick(now))
    };
    if let Some(news) = news {
        say_at(app, news, now);
    }
}

fn say<R: tauri::Runtime>(app: &tauri::AppHandle<R>, news: Option<stall::UiNews>) {
    if let Some(news) = news {
        say_at(app, news, Instant::now());
    }
}

/// A stall begun goes in the log; one over goes in the log and the usage data.
fn say_at<R: tauri::Runtime>(app: &tauri::AppHandle<R>, news: stall::UiNews, now: Instant) {
    match news {
        stall::UiNews::Stopped { step, since } => log::warn!(
            "[ui] the window has not answered for {}s during {}",
            now.saturating_duration_since(since).as_secs(),
            step_name(step)
        ),
        stall::UiNews::Answered { step, seconds } => {
            log::warn!(
                "[ui] the window stopped answering for {seconds}s during {}",
                step_name(step)
            );
            desktop_telemetry::record(
                app,
                telemetry::EventData::UiStalled {
                    step,
                    stalled_seconds: seconds,
                },
            );
        }
    }
}

fn step_name(step: telemetry::FailingStep) -> String {
    serde_json::to_value(step)
        .ok()
        .and_then(|name| name.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// Whether the main window is shown and not minimised, read from its handle on this thread.
#[cfg(windows)]
fn on_screen<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<bool> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindowVisible};
    let stalls = app.try_state::<Stalls>()?;
    let hwnd = stalls.hwnd.load(std::sync::atomic::Ordering::SeqCst);
    if hwnd == 0 {
        return None;
    }
    let hwnd = HWND(hwnd as *mut core::ffi::c_void);
    // SAFETY: two read-only questions about a handle this window gave. A handle that has gone
    // since answers false to both; neither sends the window a message.
    Some(unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() })
}

/// Whether the main window is shown, not minimised and not covered: a covered window's page is
/// held back by WebKit (its timers slowed), so what it misses then is not a stall. Read on the
/// main thread, as AppKit requires, never waiting more than two seconds, one look at a time.
#[cfg(target_os = "macos")]
fn on_screen<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<bool> {
    use std::sync::atomic::Ordering;
    let stalls = app.try_state::<Stalls>()?;
    if stalls.looking.swap(true, Ordering::SeqCst) {
        return None;
    }
    let (tell, told) = std::sync::mpsc::channel();
    let handle = app.clone();
    let asked = app.run_on_main_thread(move || {
        let _ = tell.send(main_window_on_screen(&handle));
        if let Some(stalls) = handle.try_state::<Stalls>() {
            stalls.looking.store(false, Ordering::SeqCst);
        }
    });
    if asked.is_err() {
        stalls.looking.store(false, Ordering::SeqCst);
        return None;
    }
    told.recv_timeout(Duration::from_secs(2)).ok().flatten()
}

#[cfg(target_os = "macos")]
fn main_window_on_screen<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<bool> {
    use objc2_app_kit::{NSWindow, NSWindowOcclusionState};
    let window = app.get_webview_window("main")?;
    let ns_window = window.ns_window().ok()?;
    if ns_window.is_null() {
        return None;
    }
    // SAFETY: on the main thread, the live NSWindow this window gave, only read.
    let ns_window = unsafe { &*(ns_window as *const NSWindow) };
    Some(
        ns_window.isVisible()
            && !ns_window.isMiniaturized()
            && ns_window
                .occlusionState()
                .contains(NSWindowOcclusionState::Visible),
    )
}

/// Whether the main window is shown and not minimised.
#[cfg(not(any(windows, target_os = "macos")))]
fn on_screen<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<bool> {
    let window = app.get_webview_window("main")?;
    Some(window.is_visible().ok()? && !window.is_minimized().ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;
    use desktop_telemetry::{sink::Sink, DesktopTelemetry};

    fn app(label: &str, sharing: bool, sink: &Sink) -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .manage(DesktopTelemetry::for_tests_sending(
                temp_root(label),
                sharing,
                sink.endpoint.clone(),
            ))
            .manage(Stalls::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    fn at(start: Instant, seconds: u64) -> Instant {
        start + Duration::from_secs(seconds)
    }

    /// OpenBot's services typically start in 9 seconds (Start's journey): past 129 seconds it is one
    /// `setup_stalled`, however long it then runs, and nothing when it finishes.
    fn services_run_long(app: &tauri::AppHandle<tauri::test::MockRuntime>, start: Instant) {
        row_running_at(app, "services", "Starting OpenBot's services.", start);
        for second in (0..=129).step_by(5) {
            row_running_at(
                app,
                "services",
                "Starting OpenBot's services.",
                at(start, second),
            );
            tick(app, at(start, second), Some(true));
        }
        tick(app, at(start, 129), Some(true));
        assert!(app.state::<DesktopTelemetry>().queued().is_empty());
        for second in [130, 200, 600] {
            tick(app, at(start, second), Some(true));
        }
        row_done(app, "services");
        tick(app, at(start, 700), Some(true));
    }

    /// The setup page stops taking what the native side sends while the engine machine starts, with
    /// the window on screen, and catches up 42 seconds later.
    fn window_stops_answering(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        start: Instant,
        on_screen: bool,
    ) {
        tick(app, start, Some(on_screen));
        heartbeat_at(app, 0, true, start);
        let mut seq = 0;
        for second in 1..=10 {
            seq = sent_at(app, "start-machine", at(start, second));
            heartbeat_at(app, seq, false, at(start, second));
        }
        // From 11 the page takes nothing; its timers keep beating with what it last took.
        for second in 11..=52 {
            sent_at(app, "start-machine", at(start, second));
            if second % 5 == 0 {
                heartbeat_at(app, seq, false, at(start, second));
            }
            tick(app, at(start, second), Some(on_screen));
        }
        assert!(app.state::<DesktopTelemetry>().queued().is_empty());
        let seq = sent_at(app, "start-machine", at(start, 53));
        heartbeat_at(app, seq, false, at(start, 53));
        tick(app, at(start, 120), Some(on_screen));
    }

    #[test]
    fn a_step_running_three_times_over_is_recorded_once() {
        let sink = Sink::start();
        let app = app("stall-step", true, &sink);
        services_run_long(app.handle(), Instant::now());
        app.state::<DesktopTelemetry>().deliver();
        let (_, sent) = sink
            .next(Duration::from_secs(10))
            .expect("setup_stalled reached the ingest");
        assert_eq!(sent["event"], "oss.desktop.setup_stalled");
        assert_eq!(
            sent["properties"],
            serde_json::json!({
                "kind": "setup_stalled",
                "part": "start",
                "step": "services",
                "typical_seconds": 9,
                "elapsed_seconds": 130
            })
        );
        // The platform rides on every event, as the context's.
        assert_eq!(sent["global_properties"]["openbot_platform"], "macos");
        assert!(sink.next(Duration::from_secs(2)).is_none(), "said twice");
    }

    #[test]
    fn a_window_that_stops_taking_progress_is_recorded_with_its_length() {
        let sink = Sink::start();
        let app = app("stall-window", true, &sink);
        window_stops_answering(app.handle(), Instant::now(), true);
        app.state::<DesktopTelemetry>().deliver();
        let (_, sent) = sink
            .next(Duration::from_secs(10))
            .expect("ui_stalled reached the ingest");
        assert_eq!(sent["event"], "oss.desktop.ui_stalled");
        assert_eq!(
            sent["properties"],
            serde_json::json!({
                "kind": "ui_stalled",
                "step": "start_machine",
                "stalled_seconds": 42
            })
        );
        assert!(sink.next(Duration::from_secs(2)).is_none(), "said twice");
    }

    /// A step that waits on a download the first screen started is not stuck while its bytes come
    /// in: each one restarts its clock. Once they stop coming, it is said as any step is.
    #[test]
    fn a_step_whose_download_keeps_moving_is_not_recorded() {
        let sink = Sink::start();
        let app = app("stall-moving", true, &sink);
        let app = app.handle();
        let start = Instant::now();
        row_running_at(app, "installation", "Finishing the installation.", start);
        // Ten minutes of a download moving under a step that typically takes 4 seconds.
        for second in (0..=600).step_by(5) {
            moved_at(app, "installation", at(start, second));
            tick(app, at(start, second), Some(true));
        }
        assert!(app.state::<DesktopTelemetry>().queued().is_empty());
        // A row that is not the one being timed restarts nothing.
        moved_at(app, "services", at(start, 700));
        tick(app, at(start, 730), Some(true));
        assert_eq!(app.state::<DesktopTelemetry>().queued().len(), 1);
    }

    /// Minimised or hidden, the page may be held back by the system: nothing it misses is a stall.
    #[test]
    fn a_minimised_or_hidden_window_records_nothing() {
        let sink = Sink::start();
        let app = app("stall-window-hidden", true, &sink);
        window_stops_answering(app.handle(), Instant::now(), false);
        app.state::<DesktopTelemetry>().deliver();
        assert!(sink.next(Duration::from_secs(2)).is_none());
    }

    /// Usage data turned off: the same step and the same window send nothing at all.
    #[test]
    fn opted_out_nothing_is_sent() {
        let sink = Sink::start();
        let app = app("stall-opted-out", false, &sink);
        let start = Instant::now();
        services_run_long(app.handle(), start);
        window_stops_answering(app.handle(), at(start, 1000), true);
        app.state::<DesktopTelemetry>().deliver();
        assert!(app.state::<DesktopTelemetry>().queued().is_empty());
        assert!(
            sink.next(Duration::from_secs(2)).is_none(),
            "an opted-out desktop sent a stall"
        );
    }
}
