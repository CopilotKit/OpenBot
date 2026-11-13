/*!
The main window before its page has painted: OpenBot's own ground with "Getting OpenBot ready" on
it, never a blank white window.

The main window is built visible (`build_main_window`), and everything inside it is the webview's.
On Windows, WebView2 shows its default background until the page paints, and that default is white
([`DefaultBackgroundColor`][background]). On a clean Windows Server 2022 that had just installed
WebView2 with OpenBot (box H, public 1.0.2), the window stayed blank white for about a minute after
the installer's Finish: WebView2 started its processes within two seconds, then took most of a
minute to write its new profile and load the setup page, with Microsoft Defender watching each of
its processes as children of an OpenBot it had not seen before.

So on Windows the window is built on the setup screens' ground, which WebView2 also takes as its
default background (Tauri's [`background_color`][tauri]), and from the moment the window first shows
a native window of OpenBot's own sits over the webview and says "Getting OpenBot ready", until the
setup page's first heartbeat says it has painted (`setup_heartbeat`). It is a child of the main
window, so it moves, resizes, hides and closes with it; the webview under it keeps loading, never
hidden, so nothing here brings back the hidden window that stopped taking updates (PR 1416).

`build()` shows the window and then waits for WebView2's environment and controller, handing on the
thread's messages while it waits (webview2-com's `wait_with_pump`), so that is where the cover has
to appear. An out-of-context WinEvent hook on the main thread hears the window being shown and runs
there, on the thread that installed it, from that same message loop ([`SetWinEventHook`][hook]).

[background]: https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/icorewebview2controller2#put_defaultbackgroundcolor
[tauri]: https://docs.rs/tauri/2/tauri/webview/struct.WebviewWindowBuilder.html#method.background_color
[hook]: https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-setwineventhook
*/

/// The cover's heading: the words the setup page uses while OpenBot gets ready.
pub const HEADING: &str = "Getting OpenBot ready";
/// The cover's second line.
#[cfg_attr(not(windows), allow(dead_code))]
pub const LINE: &str = "This can take a minute.";

/// The setup screens' colours, as RGB: the ground (`--surface-main`, which is `--sidebar`), the
/// heading's ink (`--foreground`) and the line's (`--muted-foreground`), from `desktop/src/styles.css`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Palette {
    pub ground: (u8, u8, u8),
    pub ink: (u8, u8, u8),
    pub soft: (u8, u8, u8),
}

/// Light: `oklch(0.948 0.011 286.2)`, `oklch(0.108 0.015 220.9)`, `oklch(0.506 0.013 285.9)`.
pub const LIGHT: Palette = Palette {
    ground: (0xed, 0xed, 0xf5),
    ink: (0x01, 0x05, 0x07),
    soft: (0x64, 0x64, 0x6c),
};

/// Dark: `oklch(0.156 0.017 295.8)`, `oklch(0.956 0.005 286.3)`, `oklch(0.69 0.017 285.9)`.
pub const DARK: Palette = Palette {
    ground: (0x0d, 0x0b, 0x13),
    ink: (0xf0, 0xf0, 0xf4),
    soft: (0x9a, 0x9a, 0xa6),
};

pub fn palette(dark: bool) -> Palette {
    if dark {
        DARK
    } else {
        LIGHT
    }
}

/// Whether Windows is set to dark for apps, which the setup screens follow when OpenBot's own page
/// has not said yet (`AppsUseLightTheme` 0, as tao reads it for the window's theme).
#[cfg(windows)]
pub fn system_dark() -> bool {
    windows_registry::CURRENT_USER
        .open(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|key| key.get_u32("AppsUseLightTheme"))
        .is_ok_and(|light| light == 0)
}

#[cfg(not(windows))]
pub fn system_dark() -> bool {
    false
}

#[cfg(windows)]
pub use native::{cover_now, page_painted, shown_after_start, uncover_unless_painted, watch};

#[cfg(not(windows))]
pub use elsewhere::{page_painted, shown_after_start, uncover_unless_painted, watch};

/// Off Windows nothing is covered: WebKit draws the window's own background until the page paints.
#[cfg(not(windows))]
mod elsewhere {
    use super::Palette;
    use std::time::Duration;

    pub struct Watch;
    impl Drop for Watch {
        fn drop(&mut self) {
            // Nothing was watched.
        }
    }
    pub fn watch(_palette: Palette) -> Watch {
        Watch
    }
    pub fn page_painted() -> Option<Duration> {
        None
    }
    pub fn uncover_unless_painted(_after: Duration) {}
    pub fn shown_after_start() -> Option<Duration> {
        None
    }
}

#[cfg(windows)]
mod native {
    use super::{Palette, HEADING, LINE};
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{
        COLORREF, FILETIME, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM,
    };
    use windows::Win32::Graphics::Gdi::{
        BeginPaint, CreateFontW, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect,
        SelectObject, SetBkMode, SetTextColor, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS,
        DEFAULT_CHARSET, DT_CALCRECT, DT_CENTER, DT_NOPREFIX, DT_SINGLELINE, HFONT,
        OUT_DEFAULT_PRECIS, PAINTSTRUCT, TRANSPARENT,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::SystemInformation::GetSystemTimeAsFileTime;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId, GetProcessTimes,
    };
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, GetAncestor, GetClientRect, IsWindow, LoadCursorW,
        PostMessageW, RegisterClassExW, SetWindowPos, CS_HREDRAW, CS_VREDRAW, EVENT_OBJECT_SHOW,
        GA_ROOT, HWND_TOP, IDC_APPSTARTING, OBJID_WINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        WINEVENT_OUTOFCONTEXT, WM_CLOSE, WM_DESTROY, WM_ERASEBKGND, WM_PAINT, WM_SIZE, WNDCLASSEXW,
        WS_CHILD, WS_CLIPSIBLINGS, WS_EX_NOPARENTNOTIFY, WS_VISIBLE,
    };

    /// The cover's window class.
    const CLASS: PCWSTR = w!("OpenBotGettingReady");
    /// The cover's id among the main window's subclasses, which keep it the window's size.
    const FOLLOW: usize = 0x0B07;

    /// The cover, while it is up.
    static COVER: AtomicIsize = AtomicIsize::new(0);
    /// The window it covers.
    static COVERED: AtomicIsize = AtomicIsize::new(0);
    static PALETTE: Mutex<Palette> = Mutex::new(super::LIGHT);
    /// When the cover went up, and how long after this process started that was.
    static SHOWN: Mutex<Option<(Instant, Option<Duration>)>> = Mutex::new(None);

    fn hwnd(raw: isize) -> HWND {
        HWND(raw as *mut _)
    }

    /// Watching this thread for the main window's first show. Dropped, it stops watching.
    pub struct Watch(Option<HWINEVENTHOOK>);

    impl Drop for Watch {
        fn drop(&mut self) {
            if let Some(hook) = self.0.take() {
                // SAFETY: the hook this thread installed in `watch` and nothing has removed.
                let _ = unsafe { UnhookWinEvent(hook) };
            }
        }
    }

    /**
    Before the main window is built, on the thread that builds it: the first top-level window this
    thread shows gets the cover, in `palette`. Only events from this process and this thread
    (`SetWinEventHook`'s `idProcess` and `idThread`), out of context, so the callback runs on this
    thread while `build()` waits for WebView2.
    */
    pub fn watch(palette: Palette) -> Watch {
        *PALETTE.lock().unwrap_or_else(|held| held.into_inner()) = palette;
        // SAFETY: a plain call; `shown` lives for the whole program.
        let hook = unsafe {
            SetWinEventHook(
                EVENT_OBJECT_SHOW,
                EVENT_OBJECT_SHOW,
                None,
                Some(shown),
                GetCurrentProcessId(),
                GetCurrentThreadId(),
                WINEVENT_OUTOFCONTEXT,
            )
        };
        Watch((!hook.is_invalid()).then_some(hook))
    }

    unsafe extern "system" fn shown(
        _hook: HWINEVENTHOOK,
        event: u32,
        window: HWND,
        object: i32,
        _child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if event != EVENT_OBJECT_SHOW || object != OBJID_WINDOW.0 || window.is_invalid() {
            return;
        }
        // A top-level window, not one of its children (the webview's own).
        // SAFETY: plain calls on a window handle Windows just reported.
        if unsafe { GetAncestor(window, GA_ROOT) } != window {
            return;
        }
        cover_now(window.0 as isize);
    }

    /**
    The cover over `window`, if it isn't there yet, and above everything else in it. Called by the
    watch as the window first shows and again once `build()` returns, in case the webview's own
    windows went over it meanwhile. On the main window's own thread.
    */
    pub fn cover_now(window: isize) {
        let parent = hwnd(window);
        // SAFETY: plain calls; the handle is checked before anything is done with it.
        unsafe {
            if !IsWindow(Some(parent)).as_bool() {
                return;
            }
            let cover = COVER.load(Ordering::SeqCst);
            if cover != 0 {
                if COVERED.load(Ordering::SeqCst) == window && IsWindow(Some(hwnd(cover))).as_bool()
                {
                    let _ = SetWindowPos(
                        hwnd(cover),
                        Some(HWND_TOP),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
                return;
            }
            // Once: a cover taken away stays away.
            if SHOWN
                .lock()
                .unwrap_or_else(|held| held.into_inner())
                .is_some()
            {
                return;
            }
            let instance: HINSTANCE = GetModuleHandleW(PCWSTR::null())
                .map(Into::into)
                .unwrap_or_default();
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(paint),
                hInstance: instance,
                // The arrow with the busy circle: something is under way.
                hCursor: LoadCursorW(None, IDC_APPSTARTING).unwrap_or_default(),
                lpszClassName: CLASS,
                ..Default::default()
            };
            // Registered again on a second cover in the same process; that one fails harmlessly.
            RegisterClassExW(&class);
            let mut area = RECT::default();
            let _ = GetClientRect(parent, &mut area);
            let heading: Vec<u16> = HEADING.encode_utf16().chain(Some(0)).collect();
            let Ok(cover) = CreateWindowExW(
                WS_EX_NOPARENTNOTIFY,
                CLASS,
                PCWSTR(heading.as_ptr()),
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                0,
                0,
                area.right - area.left,
                area.bottom - area.top,
                Some(parent),
                None,
                Some(instance),
                None,
            ) else {
                log::warn!("[window] couldn't cover the window until its page paints");
                return;
            };
            let _ = SetWindowPos(
                cover,
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
            let _ = SetWindowSubclass(parent, Some(follow), FOLLOW, cover.0 as usize);
            COVERED.store(window, Ordering::SeqCst);
            COVER.store(cover.0 as isize, Ordering::SeqCst);
            *SHOWN.lock().unwrap_or_else(|held| held.into_inner()) =
                Some((Instant::now(), process_age()));
        }
    }

    /// The main window resized: the cover with it, still on top.
    unsafe extern "system" fn follow(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        cover: usize,
    ) -> LRESULT {
        // SAFETY: called by Windows on the window's own thread with its own message.
        unsafe {
            if message == WM_SIZE {
                let width = (lparam.0 & 0xffff) as i32;
                let height = ((lparam.0 >> 16) & 0xffff) as i32;
                let _ = SetWindowPos(
                    hwnd(cover as isize),
                    Some(HWND_TOP),
                    0,
                    0,
                    width,
                    height,
                    SWP_NOACTIVATE,
                );
            }
            DefSubclassProc(window, message, wparam, lparam)
        }
    }

    fn colorref((red, green, blue): (u8, u8, u8)) -> COLORREF {
        COLORREF(u32::from(red) | (u32::from(green) << 8) | (u32::from(blue) << 16))
    }

    /// Segoe UI at `size` CSS pixels and `weight`, at the window's DPI.
    unsafe fn font(window: HWND, size: i32, weight: i32) -> HFONT {
        // SAFETY: plain calls.
        unsafe {
            let dpi = GetDpiForWindow(window).max(96) as i32;
            CreateFontW(
                -(size * dpi / 96),
                0,
                0,
                0,
                weight,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                CLEARTYPE_QUALITY,
                0,
                w!("Segoe UI"),
            )
        }
    }

    /// The cover's window procedure: the ground, then the heading and the line, centred.
    unsafe extern "system" fn paint(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        // SAFETY: called by Windows on the cover's own thread with its own message.
        unsafe {
            match message {
                WM_ERASEBKGND => LRESULT(1),
                WM_PAINT => {
                    let palette = *PALETTE.lock().unwrap_or_else(|held| held.into_inner());
                    let mut sheet = PAINTSTRUCT::default();
                    let canvas = BeginPaint(window, &mut sheet);
                    let mut area = RECT::default();
                    let _ = GetClientRect(window, &mut area);
                    let ground = CreateSolidBrush(colorref(palette.ground));
                    FillRect(canvas, &area, ground);
                    let _ = DeleteObject(ground.into());
                    SetBkMode(canvas, TRANSPARENT);
                    // The setup page's h1 (22.5px, 600) and lede (15px), in the system's face.
                    let lines = [
                        (HEADING, 22, 600, palette.ink),
                        (LINE, 15, 400, palette.soft),
                    ];
                    let dpi = GetDpiForWindow(window).max(96) as i32;
                    let gap = 8 * dpi / 96;
                    let mut sized = Vec::new();
                    let mut total = 0;
                    for (text, size, weight, ink) in lines {
                        let face = font(window, size, weight);
                        let old = SelectObject(canvas, face.into());
                        let mut words: Vec<u16> = text.encode_utf16().collect();
                        let mut measure = area;
                        DrawTextW(
                            canvas,
                            &mut words,
                            &mut measure,
                            DT_CALCRECT | DT_SINGLELINE | DT_NOPREFIX,
                        );
                        SelectObject(canvas, old);
                        let height = measure.bottom - measure.top;
                        total += height;
                        sized.push((words, face, height, ink));
                    }
                    total += gap * (sized.len() as i32 - 1);
                    let mut top = area.top + (area.bottom - area.top - total) / 2;
                    for (mut words, face, height, ink) in sized {
                        let old = SelectObject(canvas, face.into());
                        SetTextColor(canvas, colorref(ink));
                        let mut line = RECT {
                            left: area.left,
                            top,
                            right: area.right,
                            bottom: top + height,
                        };
                        DrawTextW(
                            canvas,
                            &mut words,
                            &mut line,
                            DT_CENTER | DT_SINGLELINE | DT_NOPREFIX,
                        );
                        SelectObject(canvas, old);
                        let _ = DeleteObject(face.into());
                        top += height + gap;
                    }
                    let _ = EndPaint(window, &sheet);
                    LRESULT(0)
                }
                WM_DESTROY => {
                    let covered = COVERED.swap(0, Ordering::SeqCst);
                    if covered != 0 {
                        let _ = RemoveWindowSubclass(hwnd(covered), Some(follow), FOLLOW);
                    }
                    let _ = COVER.compare_exchange(
                        window.0 as isize,
                        0,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    );
                    DefWindowProcW(window, message, wparam, lparam)
                }
                _ => DefWindowProcW(window, message, wparam, lparam),
            }
        }
    }

    /**
    The page has painted: the cover goes, from whichever thread says so (it is closed on its own
    thread, by a posted WM_CLOSE). How long it was up, the first time; None once it is gone.
    */
    pub fn page_painted() -> Option<Duration> {
        let cover = COVER.swap(0, Ordering::SeqCst);
        if cover == 0 {
            return None;
        }
        // SAFETY: a plain call; a cover already gone makes it fail, which changes nothing.
        let _ = unsafe { PostMessageW(Some(hwnd(cover)), WM_CLOSE, WPARAM(0), LPARAM(0)) };
        SHOWN
            .lock()
            .unwrap_or_else(|held| held.into_inner())
            .map(|(at, _)| at.elapsed())
    }

    /**
    The page loaded: if it has not said it painted within `after`, the cover goes anyway, so a page
    that never sends a heartbeat is never hidden behind it.
    */
    pub fn uncover_unless_painted(after: Duration) {
        if COVER.load(Ordering::SeqCst) == 0 {
            return;
        }
        let _ = std::thread::Builder::new()
            .name("openbot-first-paint".into())
            .spawn(move || {
                std::thread::sleep(after);
                if let Some(up) = page_painted() {
                    log::warn!(
                        "[window] the page loaded but never said it painted; uncovered it after {:.1}s",
                        up.as_secs_f64()
                    );
                }
            });
    }

    /// How long after this process started the window first showed, with the cover on it.
    pub fn shown_after_start() -> Option<Duration> {
        SHOWN
            .lock()
            .unwrap_or_else(|held| held.into_inner())
            .and_then(|(_, age)| age)
    }

    /// How long ago Windows created this process.
    fn process_age() -> Option<Duration> {
        let ticks =
            |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        // SAFETY: plain calls on this process's own pseudo-handle.
        unsafe {
            GetProcessTimes(
                GetCurrentProcess(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
            .ok()?;
            let now = ticks(GetSystemTimeAsFileTime());
            // FILETIME counts 100 ns.
            Some(Duration::from_nanos(now.checked_sub(ticks(created))? * 100))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::Win32::UI::WindowsAndMessaging::{
            DestroyWindow, DispatchMessageW, GetWindow, GetWindowRect, IsWindowVisible,
            PeekMessageW, ShowWindow, TranslateMessage, GW_CHILD, MSG, PM_REMOVE, SW_SHOW,
            WS_OVERLAPPEDWINDOW,
        };

        /// What the thread's message loop does while `build()` waits for WebView2.
        fn pump(for_: Duration) {
            let until = Instant::now() + for_;
            while Instant::now() < until {
                let mut message = MSG::default();
                // SAFETY: plain calls with a message this thread owns.
                unsafe {
                    while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        unsafe extern "system" fn plain(
            window: HWND,
            message: u32,
            wparam: WPARAM,
            lparam: LPARAM,
        ) -> LRESULT {
            // SAFETY: Windows's own handling of a window's message.
            unsafe { DefWindowProcW(window, message, wparam, lparam) }
        }

        /// A window as tao builds the main one: top-level, created hidden, then shown.
        fn main_window() -> HWND {
            // SAFETY: plain calls.
            unsafe {
                let instance: HINSTANCE = GetModuleHandleW(PCWSTR::null()).map(Into::into).unwrap();
                let class = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    lpfnWndProc: Some(plain),
                    hInstance: instance,
                    lpszClassName: w!("OpenBotFirstPaintTest"),
                    ..Default::default()
                };
                RegisterClassExW(&class);
                let window = CreateWindowExW(
                    Default::default(),
                    w!("OpenBotFirstPaintTest"),
                    w!("OpenBot"),
                    WS_OVERLAPPEDWINDOW,
                    100,
                    100,
                    800,
                    600,
                    None,
                    None,
                    Some(instance),
                    None,
                )
                .unwrap();
                let _ = ShowWindow(window, SW_SHOW);
                window
            }
        }

        /// A child standing in for the webview's own window: a new child goes under its siblings,
        /// and wry then puts its container on top of them (`SetWindowPos` with `HWND_TOP`).
        fn webview_in(window: HWND) -> HWND {
            // SAFETY: plain calls.
            unsafe {
                let instance: HINSTANCE = GetModuleHandleW(PCWSTR::null()).map(Into::into).unwrap();
                let webview = CreateWindowExW(
                    Default::default(),
                    w!("Static"),
                    w!("webview"),
                    WS_CHILD | WS_VISIBLE,
                    0,
                    0,
                    780,
                    560,
                    Some(window),
                    None,
                    Some(instance),
                    None,
                )
                .unwrap();
                let _ = SetWindowPos(
                    webview,
                    Some(HWND_TOP),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                webview
            }
        }

        fn rect(window: HWND) -> RECT {
            let mut area = RECT::default();
            // SAFETY: a plain call.
            let _ = unsafe { GetWindowRect(window, &mut area) };
            area
        }

        /**
        Box H: the window stayed blank white for a minute until WebView2 painted the setup page.
        The window shows covered, the cover goes over the webview's own window, takes the
        window's size when it changes, and goes once the page says it painted, never to return.
        */
        #[test]
        fn the_window_says_getting_openbot_ready_from_its_first_show_until_the_page_paints() {
            let watching = watch(super::super::LIGHT);
            let window = main_window();
            // The webview's environment being made: the thread's messages are handed on.
            pump(Duration::from_millis(300));
            let cover = hwnd(COVER.load(Ordering::SeqCst));
            assert!(
                !cover.is_invalid(),
                "nothing covered the window as it showed"
            );
            // SAFETY: plain calls on windows this test made.
            unsafe {
                assert!(IsWindowVisible(cover).as_bool());
                assert_eq!(GetAncestor(cover, GA_ROOT), window);
            }
            // The webview's own window put on top of it meanwhile; once `build()` returns the cover
            // is put back on top.
            let webview = webview_in(window);
            // SAFETY: plain calls on windows this test made.
            unsafe {
                assert_eq!(GetWindow(window, GW_CHILD).ok(), Some(webview));
            }
            cover_now(window.0 as isize);
            drop(watching);
            // SAFETY: plain calls on windows this test made.
            unsafe {
                assert_eq!(
                    GetWindow(window, GW_CHILD).ok(),
                    Some(cover),
                    "the webview is on top"
                );
                let mut area = RECT::default();
                let _ = GetClientRect(window, &mut area);
                let cover_area = rect(cover);
                assert_eq!(
                    (
                        cover_area.right - cover_area.left,
                        cover_area.bottom - cover_area.top
                    ),
                    (area.right - area.left, area.bottom - area.top),
                    "the cover doesn't fill the window"
                );
                // The person makes the window bigger.
                let _ = SetWindowPos(window, None, 0, 0, 1100, 900, SWP_NOMOVE | SWP_NOACTIVATE);
                pump(Duration::from_millis(100));
                let _ = GetClientRect(window, &mut area);
                let cover_area = rect(cover);
                assert_eq!(
                    (
                        cover_area.right - cover_area.left,
                        cover_area.bottom - cover_area.top
                    ),
                    (area.right - area.left, area.bottom - area.top),
                    "the cover didn't follow the window's size"
                );
            }
            assert!(shown_after_start().is_some());
            // The setup page's first heartbeat.
            assert!(page_painted().is_some());
            pump(Duration::from_millis(200));
            // SAFETY: plain calls on windows this test made.
            unsafe {
                assert!(
                    !IsWindow(Some(cover)).as_bool(),
                    "the cover stayed after the page painted"
                );
                assert_eq!(GetWindow(window, GW_CHILD).ok(), Some(webview));
            }
            assert_eq!(page_painted(), None);
            // Never again in this launch, for any window this thread shows.
            cover_now(window.0 as isize);
            assert_eq!(COVER.load(Ordering::SeqCst), 0);
            // SAFETY: a window this test made.
            let _ = unsafe { DestroyWindow(window) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cover is drawn in the setup screens' own colours, as `desktop/src/styles.css` has them.
    #[test]
    fn the_cover_uses_the_setup_screens_colours_and_words() {
        let styles = include_str!("../../src/styles.css");
        assert!(styles.contains("--sidebar: oklch(0.948 0.011 286.2);"));
        assert!(styles.contains("--foreground: oklch(0.108 0.015 220.9);"));
        assert!(styles.contains("--muted-foreground: oklch(0.506 0.013 285.9);"));
        assert!(styles.contains("--sidebar: oklch(0.156 0.017 295.8);"));
        assert!(styles.contains("--foreground: oklch(0.956 0.005 286.3);"));
        assert!(styles.contains("--muted-foreground: oklch(0.69 0.017 285.9);"));
        assert!(styles.contains("--surface-main: var(--sidebar);"));
        // The ground the window is built on is the one the title bar already takes.
        assert_eq!(palette(false).ground, (0xed, 0xed, 0xf5));
        assert_eq!(palette(true).ground, (0x0d, 0x0b, 0x13));
        let main = include_str!("main.rs");
        assert!(main.contains("Color(0xed, 0xed, 0xf5, 0xff)"));
        assert!(main.contains("Color(0x0d, 0x0b, 0x13, 0xff)"));
        // The words the setup page uses while OpenBot gets ready, in plain words.
        assert!(include_str!("../../src/App.tsx").contains(&format!("<h1>{HEADING}</h1>")));
        assert_eq!(LINE, "This can take a minute.");
    }
}
