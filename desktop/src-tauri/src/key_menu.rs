//! WINDOWS. A lone Alt or F10 never puts an OpenBot window into Windows' menu mode.
//!
//! Alt pressed and released on its own, or F10, makes `DefWindowProc` send the top-level window
//! `WM_SYSCOMMAND` with `SC_KEYMENU` and an `lParam` of 0 ("the character code of the key that is
//! used with the ALT key", none). Handled by `DefWindowProc`, that starts a modal menu loop on the
//! window's thread even though OpenBot's windows have no menu bar, so nothing on screen says so.
//! While the thread is in it, WebView2's page and OpenBot stop hearing each other in both
//! directions: an invoke's answer does not reach the page and the page's next invoke does not
//! reach OpenBot. The page itself keeps painting, so its timers tick. It lasts until a click
//! anywhere, Esc or Alt+Tab ends the menu loop. tao (0.37.2) hands `SC_KEYMENU` to `DefWindowProc`
//! as it is.
//!
//! MEASURED on Windows box H (internal-ce5bfbece1df): a lone Alt reached the setup window at
//! 20:54:32 during `local update`. The page's one-second download poll stopped there, and the
//! update's answer, handed back at 20:56:41, reached the page 530.2 s later, within a second of
//! a right-click on the tray icon. Other Tauri apps measured the same and fixed it the same way,
//! by answering `SC_KEYMENU` with a zero `lParam` themselves.
//!
//! What still reaches `DefWindowProc`: Alt+Space (`lParam` is the space), which opens the window
//! menu as on every Windows window; Alt with a letter; a click on the window's icon
//! (`SC_MOUSEMENU`). The page still gets Alt's and F10's own keydown and keyup, which come before
//! this command and are not touched, so its Alt shortcuts work as they did.

/// `SC_KEYMENU` (winuser.h).
#[cfg_attr(not(windows), allow(dead_code))]
const SC_KEYMENU: usize = 0xF100;

/// The bits of a `WM_SYSCOMMAND` `wParam` that name the command: "the four low-order bits of the
/// wParam parameter are used internally by the system" (`WM_SYSCOMMAND`).
#[cfg_attr(not(windows), allow(dead_code))]
const COMMAND: usize = 0xFFF0;

/// Whether a `WM_SYSCOMMAND` with `wparam` and `lparam` is a menu key pressed alone: Alt or F10,
/// with no character after it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn lone_menu_key(wparam: usize, lparam: isize) -> bool {
    wparam & COMMAND == SC_KEYMENU && lparam == 0
}

/// The id of this subclass among the window's subclasses.
#[cfg(windows)]
const SUBCLASS: usize = 0x0A17;

/**
Keeps the top-level window `hwnd` out of menu mode on a lone Alt or F10 (see the module). Called on
the window's own thread, which `SetWindowSubclass` requires. False when Windows refused.
*/
#[cfg(windows)]
pub fn ignore_lone_menu_key(hwnd: isize) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::SetWindowSubclass;
    // SAFETY: `hwnd` is a live window of this thread's; the subclass procedure keeps no state.
    unsafe { SetWindowSubclass(HWND(hwnd as *mut _), Some(subclass), SUBCLASS, 0) }.as_bool()
}

/// The window's messages, ahead of tao's: a lone Alt or F10's `SC_KEYMENU` stops here, answered
/// as handled (0, "an application should return zero if it processes this message"); every other
/// message goes on as before.
#[cfg(windows)]
unsafe extern "system" fn subclass(
    hwnd: windows::Win32::Foundation::HWND,
    message: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _id: usize,
    _data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::Shell::DefSubclassProc;
    use windows::Win32::UI::WindowsAndMessaging::WM_SYSCOMMAND;
    if message == WM_SYSCOMMAND && lone_menu_key(wparam.0, lparam.0) {
        return LRESULT(0);
    }
    // SAFETY: called by Windows on the window's own thread with its own message.
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The commands a lone Alt or F10 sends are the ones dropped; Alt+Space, Alt with a letter,
    /// a click on the window's icon and every other command still reach `DefWindowProc`.
    #[test]
    fn only_a_menu_key_pressed_alone_is_dropped() {
        // Alt or F10 alone, with or without the system's low bits set.
        assert!(lone_menu_key(0xF100, 0));
        assert!(lone_menu_key(0xF100 | 0x0002, 0));
        // Alt+Space opens the window menu; Alt+F looks for a menu letter.
        assert!(!lone_menu_key(0xF100, b' ' as isize));
        assert!(!lone_menu_key(0xF100, b'f' as isize));
        // SC_MOUSEMENU (a click on the icon), SC_CLOSE (Alt+F4), SC_MINIMIZE, SC_RESTORE.
        for command in [0xF090, 0xF060, 0xF020, 0xF120] {
            assert!(!lone_menu_key(command, 0), "{command:#x}");
        }
    }

    /**
    A real lone Alt's `SC_KEYMENU`, posted to two windows on a thread of their own, as tao's are:
    a plain one goes into menu mode (`GetGUIThreadInfo` says `GUI_INMENUMODE`), which shows this
    desktop reproduces it. OpenBot's, with the subclass, never goes into menu mode, and a message
    posted to it after (as wry posts an invoke's answer) is handled at once. Without the subclass
    the second window behaves as the first and this fails.
    */
    #[cfg(windows)]
    #[test]
    fn a_lone_alt_puts_no_subclassed_window_in_menu_mode() {
        use std::sync::atomic::{AtomicIsize, AtomicUsize, Ordering};
        use std::sync::mpsc;
        use std::time::{Duration, Instant};
        use windows::core::{w, PCWSTR};
        use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::System::Threading::GetCurrentThreadId;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetGUIThreadInfo,
            GetMessageW, PostMessageW, PostThreadMessageW, RegisterClassExW, SendMessageTimeoutW,
            SetForegroundWindow, ShowWindow, TranslateMessage, GUITHREADINFO, GUI_INMENUMODE, MSG,
            SMTO_ABORTIFHUNG, SW_SHOW, WM_APP, WM_CANCELMODE, WM_QUIT, WM_SYSCOMMAND, WNDCLASSEXW,
            WS_OVERLAPPEDWINDOW,
        };

        static PLAIN: AtomicIsize = AtomicIsize::new(0);
        static PLAIN_HEARD: AtomicUsize = AtomicUsize::new(0);
        static OURS_HEARD: AtomicUsize = AtomicUsize::new(0);
        const FRONT: u32 = WM_APP + 1;

        unsafe extern "system" fn procedure(
            window: HWND,
            message: u32,
            wparam: WPARAM,
            lparam: LPARAM,
        ) -> LRESULT {
            // Each window comes to the front on its own thread before its Alt, as the window a
            // person presses Alt in is.
            if message == FRONT {
                let _ = unsafe { SetForegroundWindow(window) };
                return LRESULT(0);
            }
            if message == WM_APP {
                let heard = if window.0 as isize == PLAIN.load(Ordering::SeqCst) {
                    &PLAIN_HEARD
                } else {
                    &OURS_HEARD
                };
                heard.fetch_add(1, Ordering::SeqCst);
                return LRESULT(0);
            }
            // SAFETY: Windows's own handling of a window's message.
            unsafe { DefWindowProcW(window, message, wparam, lparam) }
        }

        // SAFETY: plain calls on windows this thread creates and owns.
        let window = |instance: HINSTANCE| unsafe {
            let window = CreateWindowExW(
                Default::default(),
                w!("OpenBotKeyMenuTest"),
                w!("OpenBot"),
                WS_OVERLAPPEDWINDOW,
                100,
                100,
                600,
                400,
                None,
                None,
                Some(instance),
                None,
            )
            .unwrap();
            let _ = ShowWindow(window, SW_SHOW);
            window
        };

        let (made, windows) = mpsc::channel();
        let (finished, done) = mpsc::channel();
        std::thread::spawn(move || {
            // SAFETY: this thread's own windows and message loop.
            unsafe {
                let instance: HINSTANCE = GetModuleHandleW(PCWSTR::null()).map(Into::into).unwrap();
                let class = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    lpfnWndProc: Some(procedure),
                    hInstance: instance,
                    lpszClassName: w!("OpenBotKeyMenuTest"),
                    ..Default::default()
                };
                RegisterClassExW(&class);
                let plain = window(instance);
                PLAIN.store(plain.0 as isize, Ordering::SeqCst);
                let ours = window(instance);
                let subclassed = ignore_lone_menu_key(ours.0 as isize);
                made.send((
                    plain.0 as isize,
                    ours.0 as isize,
                    GetCurrentThreadId(),
                    subclassed,
                ))
                .unwrap();
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                let _ = DestroyWindow(plain);
                let _ = DestroyWindow(ours);
            }
            let _ = finished.send(());
        });
        let (plain, ours, thread, subclassed) =
            windows.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(subclassed, "Windows refused the subclass");

        let in_menu_mode = || {
            let mut info = GUITHREADINFO {
                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            // SAFETY: a read-only question about the window thread, into a struct sized for it.
            unsafe { GetGUIThreadInfo(thread, &mut info) }.is_ok()
                && info.flags.contains(GUI_INMENUMODE)
        };
        let within = |limit: Duration, done: &dyn Fn() -> bool| {
            let until = Instant::now() + limit;
            while Instant::now() < until {
                if done() {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            done()
        };
        // A lone Alt's command, then a message posted after it; what each window did with them.
        let lone_alt = |window: isize, heard: &'static AtomicUsize| {
            let window = HWND(window as *mut _);
            let before = heard.load(Ordering::SeqCst);
            // SAFETY: posting to a live window of the other thread.
            unsafe {
                PostMessageW(Some(window), FRONT, WPARAM(0), LPARAM(0)).unwrap();
                PostMessageW(Some(window), WM_SYSCOMMAND, WPARAM(SC_KEYMENU), LPARAM(0)).unwrap();
                PostMessageW(Some(window), WM_APP, WPARAM(0), LPARAM(0)).unwrap();
            }
            let menu_mode = within(Duration::from_secs(2), &in_menu_mode);
            let answered = within(Duration::from_secs(1), &|| {
                heard.load(Ordering::SeqCst) > before
            });
            // Out of menu mode again, as a click does: `WM_CANCELMODE` "cancels internal menu
            // processing", and a menu loop still takes a sent message.
            // SAFETY: a message with no pointers, to a live window, never waiting long.
            let _ = unsafe {
                SendMessageTimeoutW(
                    window,
                    WM_CANCELMODE,
                    WPARAM(0),
                    LPARAM(0),
                    SMTO_ABORTIFHUNG,
                    2_000,
                    None,
                )
            };
            assert!(
                within(Duration::from_secs(5), &|| !in_menu_mode()),
                "still in menu mode"
            );
            (menu_mode, answered)
        };

        let (plain_menu_mode, plain_answered) = lone_alt(plain, &PLAIN_HEARD);
        let (ours_menu_mode, ours_answered) = lone_alt(ours, &OURS_HEARD);
        // SAFETY: a message to the window thread's own queue.
        let _ = unsafe { PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0)) };
        let _ = done.recv_timeout(Duration::from_secs(5));

        assert!(
            plain_menu_mode,
            "a plain window did not go into menu mode, so this desktop cannot show the fix"
        );
        assert!(
            !ours_menu_mode,
            "a lone Alt put OpenBot's window into menu mode"
        );
        assert!(
            ours_answered,
            "a message posted after a lone Alt was not handled (plain window: {plain_answered})"
        );
    }
}
