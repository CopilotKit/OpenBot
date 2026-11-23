/*!
A Bot using the person's own computer: the main screen, the mouse and the keyboard, while the
person lets it. A prototype, on macOS only.

OpenBot's own page asks for each action (`desktop_page::person_computer`), never the server. The
Bot's tool is a tool of that page (`person_computer` in the app), so it works only while the
conversation is open in this window. The first action of a conversation asks the person, in this
app's own dialog, whether the Bot may use this computer in it (`allow`). The answer holds until Stop
(`stop`) or until OpenBot quits.

Every action answers with the screen after it, so the model sees what it did. The screen is the
main display, scaled down to fit 1280 by 800, and the model's coordinates are the screenshot's
pixels: an action scales them back to the display's points (`Fit`).

The screenshot is the system's own `screencapture`, scaled and compressed with `sips`. Mouse and
keyboard events go through Quartz (`core-graphics`, which tao already builds). The system asks once
for Screen Recording, to see the screen, and once for Accessibility, to post mouse and keyboard
events, each for this app.
*/
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// The largest screenshot the model gets. The display is scaled down to fit, keeping its shape.
const MAX_WIDTH: f64 = 1280.0;
const MAX_HEIGHT: f64 = 800.0;

/// The longest a Bot may ask to wait in one action.
const MAX_WAIT_SECONDS: f64 = 10.0;

#[cfg(not(target_os = "macos"))]
const ONLY_MAC: &str = "Using the person's computer works only in OpenBot on a Mac for now.";
const NO_CONVERSATION: &str = "Using the person's computer works only in a conversation.";
#[cfg(target_os = "macos")]
const DECLINED: &str =
    "The person didn't allow using their computer in this conversation. Don't try again unless they ask.";
#[cfg(target_os = "macos")]
const WINDOW_CLOSED: &str = "The OpenBot window is closed, so the person can't be asked.";

/// What a Bot asks the computer to do. Coordinates are in the last screenshot's pixels.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    /// Only look.
    Screenshot,
    Click {
        x: f64,
        y: f64,
        #[serde(default)]
        button: Button,
        /// 1 for a click, 2 for a double click, 3 for a triple click.
        #[serde(default = "one")]
        count: u8,
    },
    Move {
        x: f64,
        y: f64,
    },
    /// Press the left button at `from`, move to `to`, release.
    Drag {
        from: [f64; 2],
        to: [f64; 2],
    },
    /// Type text as a person does. A new line presses Return and a tab presses Tab.
    Type {
        text: String,
    },
    /// One key combination, such as `cmd+c` or `Return`, or several separated by spaces.
    Key {
        keys: String,
    },
    Scroll {
        x: f64,
        y: f64,
        direction: Direction,
        /// How far, in steps of about 100 pixels.
        #[serde(default = "three")]
        amount: u8,
    },
    /// Wait for something to finish, then look again.
    Wait {
        seconds: f64,
    },
}

fn one() -> u8 {
    1
}

fn three() -> u8 {
    3
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Button {
    #[default]
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

/// The conversation an action is asked in, and the name of the Bot asking. The person allows a
/// Bot once per conversation.
#[derive(Debug, Clone, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub bot: String,
}

/// The screen after an action: a JPEG in base64, and its size in pixels.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    pub base64: String,
    pub mime_type: &'static str,
    pub width: u32,
    pub height: u32,
}

/// The conversations whose person allowed a Bot to use this computer, until Stop or quit.
static ALLOWED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// One question at a time: an action asked while the person is answering waits for that answer.
#[cfg(target_os = "macos")]
static ASKING: Mutex<()> = Mutex::new(());

/// Forget every conversation's answer: each asks again before its next action.
pub fn stop() {
    ALLOWED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
}

/// Take one action for the Bot of a conversation, and answer with the screen after it.
pub async fn perform(
    app: tauri::AppHandle,
    action: Action,
    conversation: Conversation,
) -> Result<Screen, String> {
    if conversation.id.trim().is_empty() {
        return Err(NO_CONVERSATION.into());
    }
    on_this_computer(app, action, conversation).await
}

#[cfg(target_os = "macos")]
async fn on_this_computer(
    app: tauri::AppHandle,
    action: Action,
    conversation: Conversation,
) -> Result<Screen, String> {
    // Off the async workers: the dialog waits for the person, and an action sleeps between events.
    tauri::async_runtime::spawn_blocking(move || macos::perform(&app, &action, &conversation))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(not(target_os = "macos"))]
async fn on_this_computer(
    _app: tauri::AppHandle,
    _action: Action,
    _conversation: Conversation,
) -> Result<Screen, String> {
    Err(ONLY_MAC.into())
}

/// The Bot's name as the dialog says it: one short line.
fn bot_label(name: &str) -> String {
    let name: String = name
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .chars()
        .take(60)
        .collect();
    if name.is_empty() {
        "This Bot".into()
    } else {
        name
    }
}

/**
Ask the person once per conversation, in this app's own dialog, before a Bot's first action there.
The main window comes forward first, so the question is asked where the person is looking.
*/
#[cfg(target_os = "macos")]
fn allow(app: &tauri::AppHandle, conversation: &Conversation) -> Result<(), String> {
    use tauri::Manager as _;
    use tauri_plugin_dialog::{DialogExt as _, MessageDialogButtons, MessageDialogKind};

    let allowed = |id: &str| {
        ALLOWED
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .any(|held| held == id)
    };
    if allowed(&conversation.id) {
        return Ok(());
    }
    let _asking = ASKING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Answered while this action waited its turn.
    if allowed(&conversation.id) {
        return Ok(());
    }
    let bot = bot_label(&conversation.bot);
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| WINDOW_CLOSED.to_string())?;
    let _ = window.show();
    crate::focus(&window, "a Bot asks to use this computer");
    let allowed_now = app
        .dialog()
        .message(format!(
            "{bot} will see your screen and use your mouse and keyboard in this conversation. \
             It can do anything you can do on this Mac, so stay nearby. \
             Stop it any time in the conversation."
        ))
        .title(format!("Let {bot} use this Mac?"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Allow".into(),
            "Don't allow".into(),
        ))
        .parent(&window)
        .blocking_show();
    if !allowed_now {
        return Err(DECLINED.into());
    }
    ALLOWED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push(conversation.id.clone());
    Ok(())
}

/// The screenshot's size for a display, and the factors from its pixels back to the display's points.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Fit {
    width: u32,
    height: u32,
    /// Display points per screenshot pixel, across and down.
    x_factor: f64,
    y_factor: f64,
}

impl Fit {
    /// A display of `width` by `height` points, scaled down to fit the largest screenshot, never up.
    fn new(width: f64, height: f64) -> Fit {
        let scale = (MAX_WIDTH / width).min(MAX_HEIGHT / height).min(1.0);
        let fitted_width = (width * scale).round().max(1.0);
        let fitted_height = (height * scale).round().max(1.0);
        Fit {
            width: fitted_width as u32,
            height: fitted_height as u32,
            x_factor: width / fitted_width,
            y_factor: height / fitted_height,
        }
    }

    /// A point of the screenshot as display points from the display's corner, kept on the display.
    fn points(&self, x: f64, y: f64) -> (f64, f64) {
        let width = f64::from(self.width) * self.x_factor;
        let height = f64::from(self.height) * self.y_factor;
        (
            (x * self.x_factor).clamp(0.0, (width - 1.0).max(0.0)),
            (y * self.y_factor).clamp(0.0, (height - 1.0).max(0.0)),
        )
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{
        allow, Action, Button, Conversation, Direction, Fit, Screen, MAX_WAIT_SECONDS,
    };
    use base64::Engine as _;
    use core_graphics::display::CGDisplay;
    use core_graphics::event::{
        CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGKeyCode, CGMouseButton,
        EventField, KeyCode, ScrollEventUnit,
    };
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use core_graphics::geometry::CGPoint;
    use std::thread::sleep;
    use std::time::Duration;

    /// How long the screen gets to settle after an action before the screenshot.
    const SETTLE: Duration = Duration::from_millis(600);
    /// Between the events of one action, so an app sees a click as a click.
    const BETWEEN: Duration = Duration::from_millis(40);
    /// The longest `screencapture` or `sips` may take.
    const TOOL_LIMIT: Duration = Duration::from_secs(15);

    const NEEDS_SCREEN_RECORDING: &str = "OpenBot can't see the screen yet. The person needs to turn on OpenBot in System Settings, under Privacy & Security, Screen Recording, then ask again.";
    const NEEDS_ACCESSIBILITY: &str = "OpenBot can't use the mouse and keyboard yet. The person needs to turn on OpenBot in System Settings, under Privacy & Security, Accessibility, then ask again.";
    const EVENTS_FAILED: &str = "Couldn't use the mouse or keyboard. Try again.";
    const SCREENSHOT_FAILED: &str = "Couldn't take a screenshot";

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
        fn CGPreflightPostEventAccess() -> bool;
        fn CGRequestPostEventAccess() -> bool;
    }

    pub fn perform(
        app: &tauri::AppHandle,
        action: &Action,
        conversation: &Conversation,
    ) -> Result<Screen, String> {
        // The person's answer first, so the system's own prompts come after OpenBot's explanation.
        allow(app, conversation)?;
        // SAFETY: plain Quartz functions with no arguments, safe from any thread.
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            unsafe { CGRequestScreenCaptureAccess() };
            return Err(NEEDS_SCREEN_RECORDING.into());
        }
        let looks_only = matches!(action, Action::Screenshot | Action::Wait { .. });
        // SAFETY: as above.
        if !looks_only && !unsafe { CGPreflightPostEventAccess() } {
            unsafe { CGRequestPostEventAccess() };
            return Err(NEEDS_ACCESSIBILITY.into());
        }
        let display = CGDisplay::main().bounds();
        let fit = Fit::new(display.size.width, display.size.height);
        let at = |x: f64, y: f64| {
            let (x, y) = fit.points(x, y);
            CGPoint::new(display.origin.x + x, display.origin.y + y)
        };
        match action {
            Action::Screenshot => {}
            Action::Wait { seconds } => {
                sleep(Duration::from_secs_f64(seconds.clamp(0.0, MAX_WAIT_SECONDS)));
            }
            Action::Click {
                x,
                y,
                button,
                count,
            } => click(at(*x, *y), *button, *count)?,
            Action::Move { x, y } => mouse(CGEventType::MouseMoved, at(*x, *y), CGMouseButton::Left, 0)?,
            Action::Drag { from, to } => drag(at(from[0], from[1]), at(to[0], to[1]))?,
            Action::Type { text } => type_text(text)?,
            Action::Key { keys } => {
                for combo in combos(keys)? {
                    press(&combo)?;
                    sleep(BETWEEN);
                }
            }
            Action::Scroll {
                x,
                y,
                direction,
                amount,
            } => scroll(at(*x, *y), *direction, *amount)?,
        }
        if !looks_only {
            sleep(SETTLE);
        }
        screenshot(&fit)
    }

    fn source() -> Result<CGEventSource, String> {
        CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|()| EVENTS_FAILED.into())
    }

    fn mouse(kind: CGEventType, at: CGPoint, button: CGMouseButton, clicks: i64) -> Result<(), String> {
        let event =
            CGEvent::new_mouse_event(source()?, kind, at, button).map_err(|()| EVENTS_FAILED.to_string())?;
        if clicks > 0 {
            event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, clicks);
        }
        event.post(CGEventTapLocation::HID);
        Ok(())
    }

    fn click(at: CGPoint, button: Button, count: u8) -> Result<(), String> {
        let (down, up, which) = match button {
            Button::Left => (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left),
            Button::Right => (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right),
            Button::Middle => (CGEventType::OtherMouseDown, CGEventType::OtherMouseUp, CGMouseButton::Center),
        };
        mouse(CGEventType::MouseMoved, at, CGMouseButton::Left, 0)?;
        sleep(BETWEEN);
        for click in 1..=i64::from(count.clamp(1, 3)) {
            mouse(down, at, which, click)?;
            mouse(up, at, which, click)?;
            sleep(BETWEEN);
        }
        Ok(())
    }

    fn drag(from: CGPoint, to: CGPoint) -> Result<(), String> {
        const STEPS: u32 = 12;
        mouse(CGEventType::MouseMoved, from, CGMouseButton::Left, 0)?;
        sleep(BETWEEN);
        mouse(CGEventType::LeftMouseDown, from, CGMouseButton::Left, 1)?;
        sleep(BETWEEN);
        for step in 1..=STEPS {
            let along = f64::from(step) / f64::from(STEPS);
            let point = CGPoint::new(from.x + (to.x - from.x) * along, from.y + (to.y - from.y) * along);
            mouse(CGEventType::LeftMouseDragged, point, CGMouseButton::Left, 0)?;
            sleep(Duration::from_millis(15));
        }
        mouse(CGEventType::LeftMouseUp, to, CGMouseButton::Left, 1)
    }

    fn scroll(at: CGPoint, direction: Direction, amount: u8) -> Result<(), String> {
        mouse(CGEventType::MouseMoved, at, CGMouseButton::Left, 0)?;
        sleep(BETWEEN);
        let pixels = i32::from(amount.clamp(1, 30)) * 100;
        // Quartz's first wheel is up and down (positive is up), its second left and right.
        let (vertical, horizontal) = match direction {
            Direction::Up => (pixels, 0),
            Direction::Down => (-pixels, 0),
            Direction::Left => (0, pixels),
            Direction::Right => (0, -pixels),
        };
        let event = CGEvent::new_scroll_event(source()?, ScrollEventUnit::PIXEL, 2, vertical, horizontal, 0)
            .map_err(|()| EVENTS_FAILED.to_string())?;
        event.post(CGEventTapLocation::HID);
        Ok(())
    }

    fn key_event(code: CGKeyCode, down: bool, flags: CGEventFlags) -> Result<(), String> {
        let event =
            CGEvent::new_keyboard_event(source()?, code, down).map_err(|()| EVENTS_FAILED.to_string())?;
        event.set_flags(flags);
        event.post(CGEventTapLocation::HID);
        Ok(())
    }

    /// Text as a person types it, a few characters per event, whatever the keyboard layout.
    fn type_text(text: &str) -> Result<(), String> {
        let mut chunk = String::new();
        let flush = |chunk: &mut String| -> Result<(), String> {
            if chunk.is_empty() {
                return Ok(());
            }
            for down in [true, false] {
                let event = CGEvent::new_keyboard_event(source()?, 0, down)
                    .map_err(|()| EVENTS_FAILED.to_string())?;
                event.set_string(chunk);
                event.post(CGEventTapLocation::HID);
            }
            chunk.clear();
            sleep(Duration::from_millis(10));
            Ok(())
        };
        for character in text.chars() {
            match character {
                '\r' => {}
                '\n' | '\t' => {
                    flush(&mut chunk)?;
                    let code = if character == '\n' { KeyCode::RETURN } else { KeyCode::TAB };
                    press(&Combo { modifiers: Vec::new(), key: Some(code) })?;
                }
                _ => {
                    if chunk.encode_utf16().count() + character.len_utf16() > 16 {
                        flush(&mut chunk)?;
                    }
                    chunk.push(character);
                }
            }
        }
        flush(&mut chunk)
    }

    /// One key combination: the modifiers held, and the key pressed while they are.
    #[derive(Debug, PartialEq, Eq)]
    pub(super) struct Combo {
        pub(super) modifiers: Vec<(CGKeyCode, CGEventFlags)>,
        pub(super) key: Option<CGKeyCode>,
    }

    fn press(combo: &Combo) -> Result<(), String> {
        let mut flags = CGEventFlags::CGEventFlagNull;
        for (code, flag) in &combo.modifiers {
            flags |= *flag;
            key_event(*code, true, flags)?;
        }
        if let Some(code) = combo.key {
            key_event(code, true, flags)?;
            sleep(Duration::from_millis(20));
            key_event(code, false, flags)?;
        }
        for (code, flag) in combo.modifiers.iter().rev() {
            flags.remove(*flag);
            key_event(*code, false, flags)?;
        }
        Ok(())
    }

    /// `cmd+shift+t`, `Return`, or several separated by spaces: `ctrl+a Delete`.
    pub(super) fn combos(keys: &str) -> Result<Vec<Combo>, String> {
        let combos = keys
            .split_whitespace()
            .map(combo)
            .collect::<Result<Vec<_>, _>>()?;
        if combos.is_empty() {
            return Err("Name a key to press, such as Return or cmd+c.".into());
        }
        Ok(combos)
    }

    fn combo(keys: &str) -> Result<Combo, String> {
        let mut modifiers = Vec::new();
        let mut key = None;
        for part in keys.split('+') {
            if part.is_empty() {
                return Err(format!("{keys:?} is not a key combination. Write one like cmd+c."));
            }
            if let Some(held) = modifier(part) {
                modifiers.push(held);
                continue;
            }
            if key.is_some() {
                return Err(format!(
                    "{keys:?} presses more than one key at once. Hold only cmd, ctrl, alt and shift with a key."
                ));
            }
            key = Some(key_code(part).ok_or_else(|| format!("{part:?} is not a key OpenBot knows."))?);
        }
        Ok(Combo { modifiers, key })
    }

    fn modifier(name: &str) -> Option<(CGKeyCode, CGEventFlags)> {
        Some(match name.to_ascii_lowercase().as_str() {
            "cmd" | "command" | "meta" | "super" | "win" => (KeyCode::COMMAND, CGEventFlags::CGEventFlagCommand),
            "ctrl" | "control" => (KeyCode::CONTROL, CGEventFlags::CGEventFlagControl),
            "alt" | "option" | "opt" => (KeyCode::OPTION, CGEventFlags::CGEventFlagAlternate),
            "shift" => (KeyCode::SHIFT, CGEventFlags::CGEventFlagShift),
            _ => return None,
        })
    }

    fn key_code(name: &str) -> Option<CGKeyCode> {
        let mut characters = name.chars();
        if let (Some(only), None) = (characters.next(), characters.next()) {
            return character_code(only.to_ascii_lowercase());
        }
        let name = name.to_ascii_lowercase().replace(['_', ' ', '-'], "");
        Some(match name.as_str() {
            "enter" | "return" => KeyCode::RETURN,
            "tab" => KeyCode::TAB,
            "esc" | "escape" => KeyCode::ESCAPE,
            "space" | "spacebar" => KeyCode::SPACE,
            "backspace" => KeyCode::DELETE,
            "delete" | "del" | "forwarddelete" => KeyCode::FORWARD_DELETE,
            "up" | "arrowup" | "uparrow" => KeyCode::UP_ARROW,
            "down" | "arrowdown" | "downarrow" => KeyCode::DOWN_ARROW,
            "left" | "arrowleft" | "leftarrow" => KeyCode::LEFT_ARROW,
            "right" | "arrowright" | "rightarrow" => KeyCode::RIGHT_ARROW,
            "home" => KeyCode::HOME,
            "end" => KeyCode::END,
            "pageup" | "pgup" | "prior" => KeyCode::PAGE_UP,
            "pagedown" | "pgdn" | "next" => KeyCode::PAGE_DOWN,
            "capslock" => KeyCode::CAPS_LOCK,
            "minus" => KeyCode::ANSI_MINUS,
            "equal" | "equals" => KeyCode::ANSI_EQUAL,
            "comma" => KeyCode::ANSI_COMMA,
            "period" | "dot" => KeyCode::ANSI_PERIOD,
            "slash" => KeyCode::ANSI_SLASH,
            "backslash" => KeyCode::ANSI_BACKSLASH,
            "semicolon" => KeyCode::ANSI_SEMICOLON,
            "quote" | "apostrophe" => KeyCode::ANSI_QUOTE,
            "grave" | "backtick" => KeyCode::ANSI_GRAVE,
            "bracketleft" | "leftbracket" => KeyCode::ANSI_LEFT_BRACKET,
            "bracketright" | "rightbracket" => KeyCode::ANSI_RIGHT_BRACKET,
            "f1" => KeyCode::F1,
            "f2" => KeyCode::F2,
            "f3" => KeyCode::F3,
            "f4" => KeyCode::F4,
            "f5" => KeyCode::F5,
            "f6" => KeyCode::F6,
            "f7" => KeyCode::F7,
            "f8" => KeyCode::F8,
            "f9" => KeyCode::F9,
            "f10" => KeyCode::F10,
            "f11" => KeyCode::F11,
            "f12" => KeyCode::F12,
            _ => return None,
        })
    }

    fn character_code(character: char) -> Option<CGKeyCode> {
        Some(match character {
            'a' => KeyCode::ANSI_A,
            'b' => KeyCode::ANSI_B,
            'c' => KeyCode::ANSI_C,
            'd' => KeyCode::ANSI_D,
            'e' => KeyCode::ANSI_E,
            'f' => KeyCode::ANSI_F,
            'g' => KeyCode::ANSI_G,
            'h' => KeyCode::ANSI_H,
            'i' => KeyCode::ANSI_I,
            'j' => KeyCode::ANSI_J,
            'k' => KeyCode::ANSI_K,
            'l' => KeyCode::ANSI_L,
            'm' => KeyCode::ANSI_M,
            'n' => KeyCode::ANSI_N,
            'o' => KeyCode::ANSI_O,
            'p' => KeyCode::ANSI_P,
            'q' => KeyCode::ANSI_Q,
            'r' => KeyCode::ANSI_R,
            's' => KeyCode::ANSI_S,
            't' => KeyCode::ANSI_T,
            'u' => KeyCode::ANSI_U,
            'v' => KeyCode::ANSI_V,
            'w' => KeyCode::ANSI_W,
            'x' => KeyCode::ANSI_X,
            'y' => KeyCode::ANSI_Y,
            'z' => KeyCode::ANSI_Z,
            '0' => KeyCode::ANSI_0,
            '1' => KeyCode::ANSI_1,
            '2' => KeyCode::ANSI_2,
            '3' => KeyCode::ANSI_3,
            '4' => KeyCode::ANSI_4,
            '5' => KeyCode::ANSI_5,
            '6' => KeyCode::ANSI_6,
            '7' => KeyCode::ANSI_7,
            '8' => KeyCode::ANSI_8,
            '9' => KeyCode::ANSI_9,
            '-' => KeyCode::ANSI_MINUS,
            '=' => KeyCode::ANSI_EQUAL,
            '[' => KeyCode::ANSI_LEFT_BRACKET,
            ']' => KeyCode::ANSI_RIGHT_BRACKET,
            '\\' => KeyCode::ANSI_BACKSLASH,
            ';' => KeyCode::ANSI_SEMICOLON,
            '\'' => KeyCode::ANSI_QUOTE,
            ',' => KeyCode::ANSI_COMMA,
            '.' => KeyCode::ANSI_PERIOD,
            '/' => KeyCode::ANSI_SLASH,
            '`' => KeyCode::ANSI_GRAVE,
            ' ' => KeyCode::SPACE,
            _ => return None,
        })
    }

    /// The main display now, as a JPEG of `fit`'s size. The full-size capture never outlives the call.
    fn screenshot(fit: &Fit) -> Result<Screen, String> {
        use openbot_desktop_lib::quiet;
        let id: u64 = rand::random();
        let folder = std::env::temp_dir();
        let full = folder.join(format!("openbot-screen-{id:016x}.png"));
        let small = folder.join(format!("openbot-screen-{id:016x}.jpg"));
        let run = |command: &mut std::process::Command| -> Result<(), String> {
            let output = quiet::output_within(command, TOOL_LIMIT)
                .map_err(|error| format!("{SCREENSHOT_FAILED}: {error}."))?;
            if output.status.success() {
                Ok(())
            } else {
                Err(format!("{SCREENSHOT_FAILED}: {}.", quiet::said(&output.stderr)))
            }
        };
        let taken = (|| {
            // -x: no sound. -C: with the pointer. -m: the main display only.
            run(quiet::command("/usr/sbin/screencapture")
                .args(["-x", "-C", "-m", "-t", "png"])
                .arg(&full))?;
            run(quiet::command("/usr/bin/sips")
                .args(["-z", &fit.height.to_string(), &fit.width.to_string()])
                .args(["-s", "format", "jpeg", "-s", "formatOptions", "70"])
                .arg(&full)
                .arg("--out")
                .arg(&small))?;
            std::fs::read(&small).map_err(|error| format!("{SCREENSHOT_FAILED}: {error}."))
        })();
        let _ = std::fs::remove_file(&full);
        let _ = std::fs::remove_file(&small);
        Ok(Screen {
            base64: base64::engine::general_purpose::STANDARD.encode(taken?),
            mime_type: "image/jpeg",
            width: fit.width,
            height: fit.height,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_retina_laptop_display_fits_the_largest_screenshot_and_maps_back_to_its_points() {
        // A 14-inch MacBook Pro's default: 1512 by 982 points.
        let fit = Fit::new(1512.0, 982.0);
        assert_eq!((fit.width, fit.height), (1232, 800));
        let (x, y) = fit.points(616.0, 400.0);
        assert!((x - 756.0).abs() < 1.0 && (y - 491.0).abs() < 1.0, "{x},{y}");
        // A click past the screenshot's edge stays on the display.
        let (x, y) = fit.points(5000.0, -20.0);
        assert!(x <= 1511.0 && y == 0.0, "{x},{y}");
    }

    #[test]
    fn a_small_display_is_never_scaled_up() {
        let fit = Fit::new(1024.0, 768.0);
        assert_eq!((fit.width, fit.height), (1024, 768));
        assert_eq!(fit.points(10.0, 20.0), (10.0, 20.0));
    }

    #[test]
    fn the_page_asks_with_a_kind_and_its_fields() {
        let click: Action =
            serde_json::from_value(serde_json::json!({ "kind": "click", "x": 10, "y": 20 })).unwrap();
        assert!(matches!(
            click,
            Action::Click { button: Button::Left, count: 1, .. }
        ));
        let drag: Action = serde_json::from_value(
            serde_json::json!({ "kind": "drag", "from": [1, 2], "to": [3, 4] }),
        )
        .unwrap();
        assert!(matches!(drag, Action::Drag { from: [1.0, 2.0], to: [3.0, 4.0] }));
        let scroll: Action = serde_json::from_value(
            serde_json::json!({ "kind": "scroll", "x": 1, "y": 2, "direction": "down" }),
        )
        .unwrap();
        assert!(matches!(
            scroll,
            Action::Scroll { direction: Direction::Down, amount: 3, .. }
        ));
        assert!(serde_json::from_value::<Action>(serde_json::json!({ "kind": "shell" })).is_err());
    }

    #[test]
    fn a_bot_is_named_on_one_short_line() {
        assert_eq!(bot_label("  Research\nBot  "), "Research Bot");
        assert_eq!(bot_label(""), "This Bot");
        assert_eq!(bot_label(&"x".repeat(200)).chars().count(), 60);
    }

    #[test]
    fn stop_forgets_every_conversation() {
        ALLOWED.lock().unwrap().push("a conversation".into());
        stop();
        assert!(ALLOWED.lock().unwrap().is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn key_combinations_read_as_a_person_writes_them() {
        use core_graphics::event::{CGEventFlags, KeyCode};
        let combos = macos::combos("cmd+shift+T Return ctrl+a").unwrap();
        assert_eq!(combos.len(), 3);
        assert_eq!(
            combos[0].modifiers.iter().map(|(_, flag)| *flag).collect::<Vec<_>>(),
            [CGEventFlags::CGEventFlagCommand, CGEventFlags::CGEventFlagShift]
        );
        assert_eq!(combos[0].key, Some(KeyCode::ANSI_T));
        assert_eq!(combos[1].key, Some(KeyCode::RETURN));
        assert_eq!(macos::combos("Page_Down").unwrap()[0].key, Some(KeyCode::PAGE_DOWN));
        assert!(macos::combos("cmd+").is_err());
        assert!(macos::combos("a+b").is_err());
        assert!(macos::combos("hyper").is_err());
        assert!(macos::combos("   ").is_err());
    }
}
