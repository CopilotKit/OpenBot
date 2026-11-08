//! A Bot's notification from OpenBot's page, shown by the system, and the link a click on it opens.
//!
//! WINDOWS. A toast from an app installed without an MSIX package can only bring the app back from
//! the notification centre through a protocol: "ToastGeneric Foreground | Unpackaged: Not
//! supported" without a COM activator, "ToastGeneric Protocol | Unpackaged: Supported" (Microsoft,
//! "Activating toast notifications from desktop apps"). MEASURED on Windows: a click on OpenBot's
//! toast in the notification centre only removed it. So the toast is built here with
//! `activationType="protocol"` and `launch="openbot://open?path=…"`. Windows starts OpenBot.exe with
//! that link (the installer registers the scheme, `plugins.deep-link` in tauri.conf.json), the
//! single-instance plugin hands it to the running OpenBot, and `open_link` opens the page. A click
//! on the toast while it is still on screen takes the same way.
//!
//! The notification plugin cannot send such a toast: it builds its own through notify-rust, which
//! sets no launch and no activation type. On macOS and Linux the plugin shows it.

/// The scheme of the links a notification opens. Registered by the installer.
pub const SCHEME: &str = "openbot";

/// `openbot://open?path=/channel/c-1`: the link a click on a notification for `path` opens.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn open_link(path: &str) -> String {
    let mut link = tauri::Url::parse(&format!("{SCHEME}://open")).expect("a valid link");
    link.query_pairs_mut().append_pair("path", path);
    link.into()
}

/// The page an `openbot://open?path=…` link names, as the page sent it. Anything else names none.
/// Where that page may be opened is `notification_destination`'s to decide.
pub fn path_of(link: &tauri::Url) -> Option<String> {
    if link.scheme() != SCHEME || link.host_str() != Some("open") {
        return None;
    }
    link.query_pairs()
        .find(|(key, _)| key == "path")
        .map(|(_, path)| path.into_owned())
}

/**
The script that opens `path` in OpenBot's page as a route change: it dispatches `openbot:open`,
which the page's router handles and cancels (`app/src/lib/desktop/open-requests.ts`). A page that
leaves it uncancelled, from before that, is loaded at `url` instead.
*/
pub fn open_script(path: &str, url: &str) -> String {
    let path = serde_json::to_string(path).expect("a string serialises");
    let url = serde_json::to_string(url).expect("a string serialises");
    format!(
        "(() => {{ const event = new CustomEvent(\"openbot:open\", {{ detail: {{ path: {path} }}, cancelable: true }}); if (window.dispatchEvent(event)) window.location.assign({url}); }})();"
    )
}

/**
Whether this launch of OpenBot is Windows opening a notification's link: a click on a toast starts
OpenBot.exe with `openbot://…`, and the single-instance plugin hands it to the OpenBot already
running.
*/
#[cfg_attr(not(windows), allow(dead_code))]
pub fn launched_by_link<I: IntoIterator<Item = String>>(args: I) -> bool {
    args.into_iter()
        .skip(1)
        .any(|arg| arg.starts_with(&format!("{SCHEME}:")))
}

/**
WINDOWS' FOREGROUND LOCK. Only the process the person last acted in may bring a window to the front.
MEASURED: after a click on a toast, OpenBot opened the page but stayed behind the app in front, or,
minimised, came back with a grey title bar, inactive; the foreground stayed with the shell's
notification host. The launch Windows starts for the click has the right, and the OpenBot already
running does not, so the launch passes it on before it hands its link over and exits
(`AllowSetForegroundWindow`, "a process that can set the foreground window can enable another
process to set the foreground window"). The running OpenBot then restores and activates its window
(`bring_to_front`).
*/
#[cfg(windows)]
pub fn let_running_openbot_come_forward() {
    use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
    if let Err(error) = unsafe { AllowSetForegroundWindow(ASFW_ANY) } {
        log::warn!("[notification] could not pass on the foreground: {error}");
    }
}

/// Restores the window if it is minimised and makes it the foreground window, with the right a
/// notification's launch passed on (`let_running_openbot_come_forward`).
#[cfg(windows)]
pub fn bring_to_front(hwnd: *mut core::ffi::c_void) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };
    let hwnd = HWND(hwnd);
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if !SetForegroundWindow(hwnd).as_bool() {
            log::warn!("[notification] Windows kept another window in front");
        }
    }
}

/// The few characters XML text and attributes cannot carry as they are.
#[cfg_attr(not(windows), allow(dead_code))]
fn escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            // Control characters other than tab and newlines are not allowed in XML 1.0.
            c if c.is_control() && !matches!(c, '\t' | '\n' | '\r') => {}
            c => escaped.push(c),
        }
    }
    escaped
}

/// The toast: its title and body, and the link a click on it opens, by protocol.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn toast_xml(title: &str, body: &str, link: &str) -> String {
    format!(
        "<toast launch=\"{}\" activationType=\"protocol\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        escape(link),
        escape(title),
        escape(body),
    )
}

/// The longest tag Windows takes on a toast (`ToastNotification.Tag`: 64 characters).
const TAG_MAX: usize = 64;

/**
The page's tag for a notice, as a toast can carry it. A toast with the tag of one already in the
notification centre replaces it, so one conversation's moment is one toast however the page raised
it. A longer tag is shortened to its SHA-256, which keeps two different tags apart.
*/
#[cfg_attr(not(windows), allow(dead_code))]
pub fn toast_tag(tag: &str) -> String {
    if tag.chars().count() <= TAG_MAX {
        return tag.to_owned();
    }
    use sha2::Digest;
    let digest = sha2::Sha256::digest(tag.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Shows the toast as `app_id`, the AppUserModelID the Start menu shortcut carries, replacing any
/// toast of the same `tag`.
#[cfg(windows)]
pub fn show_toast(app_id: &str, xml: &str, tag: Option<&str>) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    let show = || -> windows::core::Result<()> {
        let document = XmlDocument::new()?;
        document.LoadXml(&HSTRING::from(xml))?;
        let toast = ToastNotification::CreateToastNotification(&document)?;
        if let Some(tag) = tag {
            toast.SetTag(&HSTRING::from(tag))?;
            toast.SetGroup(&HSTRING::from("openbot"))?;
        }
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?.Show(&toast)
    };
    show().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The link round-trips any page path, query and all, and nothing but an `openbot://open`
    /// link names a page.
    #[test]
    fn a_notifications_link_names_the_page_it_was_sent_for() {
        for path in [
            "/channel/c-1",
            "/bots/expenses",
            "/channel/a b?settings=true&x=|",
        ] {
            let link = open_link(path);
            assert!(link.starts_with("openbot://open?path="), "{link}");
            // The single-instance plugin joins a second launch's arguments with `|`.
            assert!(!link.contains('|'), "{link}");
            assert_eq!(path_of(&link.parse().unwrap()).as_deref(), Some(path));
        }
        for other in [
            "https://open/?path=/bots",
            "openbot://other?path=/bots",
            "openbot://open",
        ] {
            assert_eq!(path_of(&other.parse().unwrap()), None, "{other}");
        }
    }

    /// A Bot's name and words are text in the toast, never markup, and the click is a protocol
    /// activation of the link: the one kind an unpackaged app gets from the notification centre.
    #[test]
    fn the_toast_opens_its_link_by_protocol_and_carries_text_as_text() {
        let xml = toast_xml(
            "R&D <Bot> needs you",
            "Approve \"Q3\" & 'Q4'?",
            &open_link("/channel/c-1"),
        );
        assert!(xml.starts_with(
            "<toast launch=\"openbot://open?path=%2Fchannel%2Fc-1\" activationType=\"protocol\">"
        ));
        assert!(xml.contains("<text>R&amp;D &lt;Bot&gt; needs you</text>"));
        assert!(xml.contains("<text>Approve &quot;Q3&quot; &amp; &apos;Q4&apos;?</text>"));
        assert!(!toast_xml("a\u{0}b", "", "").contains('\u{0}'));
    }

    /// A click on a notice opens its page as a route change, the page's to cancel; the path and the
    /// fallback address reach the page as JavaScript strings, never as code.
    #[test]
    fn a_notices_page_opens_as_a_route_change_with_a_load_only_as_the_fallback() {
        let script = open_script(
            "/channel/c-1?x=\"</script>",
            "http://127.0.0.1:3010/channel/c-1",
        );
        assert!(script.contains("new CustomEvent(\"openbot:open\""));
        assert!(script.contains("cancelable: true"));
        assert!(script.contains(r#"path: "/channel/c-1?x=\"</script>""#));
        assert!(script.contains(
            "if (window.dispatchEvent(event)) window.location.assign(\"http://127.0.0.1:3010/channel/c-1\")"
        ));
    }

    /// Only a launch Windows makes for a toast's link passes the foreground on: a person opening
    /// OpenBot from the Start menu, or the Desktop restarting itself, does not.
    #[test]
    fn only_a_launch_for_a_notices_link_passes_the_foreground_on() {
        let args = |rest: &[&str]| {
            std::iter::once("C:\\OpenBot\\OpenBot.exe")
                .chain(rest.iter().copied())
                .map(String::from)
                .collect::<Vec<_>>()
        };
        assert!(launched_by_link(args(&[
            "openbot://open?path=%2Fchannel%2Fc-1"
        ])));
        assert!(!launched_by_link(args(&[])));
        assert!(!launched_by_link(args(&["--restarted"])));
        // The executable's own path is never the link, whatever folder it is in.
        assert!(!launched_by_link(vec!["openbot:\\OpenBot.exe".to_owned()]));
    }

    /// A conversation's tag reaches the toast as it is, so its next notice replaces it; a tag too
    /// long for Windows becomes one that fits and still tells two tags apart.
    #[test]
    fn a_notices_tag_fits_a_toast_and_keeps_two_tags_apart() {
        let conversation = "openbot-0b6a5d4e-6f53-4c9c-9a3c-6c1f0d6d8b2e";
        assert_eq!(toast_tag(conversation), conversation);
        let long = |end: &str| format!("openbot-attention-{}{end}", "x".repeat(60));
        assert_eq!(toast_tag(&long("a")).chars().count(), TAG_MAX);
        assert_ne!(toast_tag(&long("a")), toast_tag(&long("b")));
    }
}
