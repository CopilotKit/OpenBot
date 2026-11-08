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

/// Shows the toast as `app_id`, the AppUserModelID the Start menu shortcut carries.
#[cfg(windows)]
pub fn show_toast(app_id: &str, xml: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    let show = || -> windows::core::Result<()> {
        let document = XmlDocument::new()?;
        document.LoadXml(&HSTRING::from(xml))?;
        let toast = ToastNotification::CreateToastNotification(&document)?;
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
}
