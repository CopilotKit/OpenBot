//! A site outside OpenBot opens in the person's own browser, never in the desktop window.
//!
//! OpenBot's pages are shown in this app's webview, which is not a browser: it refuses
//! `window.open`, so an app's sign-in claimed in a new tab was blocked ("This browser blocked the
//! tab"), and a link to another site took the window itself there, leaving OpenBot. The person's
//! accounts (HubSpot, Google and the rest) are signed in to in their own browser, so that is where
//! a consent has to open. The page's shim (`outside-links.js`) turns every way out into a
//! navigation, and the window's guard hands each one that leaves to the default browser while the
//! page stays.
//!
//! A FRAME IN THE PAGE IS NOT THE WINDOW LEAVING. OpenBot embeds one site: the booking calendar on
//! onboarding's Book a demo step (Calendly), which itself frames reCAPTCHA and Stripe. On macOS
//! the window's guard is asked about every frame's navigation, not only the page's, so it would
//! have sent the calendar and its parts to the browser and left an empty frame. Those hosts load
//! in their frames (`loads_in_a_frame`); OpenBot never sends the window itself to any of them.
//! Links in the calendar open new windows, and a new window from this one opens in the browser
//! (`new_window`).

/// Injected into OpenBot's pages in the desktop window. See the module documentation.
pub const PAGE: &str = include_str!("outside-links.js");

/// Whether `destination` is a site outside OpenBot: the web, not this machine.
pub fn leaves(destination: &tauri::Url) -> bool {
    matches!(destination.scheme(), "http" | "https")
        && destination.host_str().is_some_and(|host| {
            !matches!(host, "127.0.0.1" | "localhost" | "[::1]") && !host.ends_with(".localhost")
        })
}

/// Whether `destination` is a file on this computer, which the window never shows in place of OpenBot.
///
/// The page handles a dropped file itself (the composer attaches it), so Tauri's own drag-and-drop
/// handler is off (`dragDropEnabled` in `tauri.conf.json`). With it off, a file let go over a page
/// that does not take it is the webview's to handle. WebView2 on Windows is Chromium, whose default
/// is to open the file in place, leaving OpenBot or the setup screen (WKWebView on macOS refuses the
/// drop instead). OpenBot's own page refuses such a drop (`useUnclaimedDropGuard`), but the setup
/// screens and older OpenBot releases do not, so the window refuses the navigation and stays put.
pub fn opens_a_file(destination: &tauri::Url) -> bool {
    destination.scheme() == "file"
}

/// Whether `destination` is the booking calendar OpenBot embeds, or a frame that calendar embeds:
/// Calendly, its reCAPTCHA (served from recaptcha.net) and its Stripe frames. Over https only.
pub fn loads_in_a_frame(destination: &tauri::Url) -> bool {
    let within = |host: &str, domain: &str| {
        host == domain
            || host
                .strip_suffix(domain)
                .is_some_and(|rest| rest.ends_with('.'))
    };
    destination.scheme() == "https"
        && destination.host_str().is_some_and(|host| {
            within(host, "calendly.com")
                || within(host, "recaptcha.net")
                || matches!(host, "js.stripe.com" | "m.stripe.network")
        })
}

/// A new window asked for from the desktop window (a link meant for a new tab, or `window.open`,
/// from the page or a frame in it). A site outside OpenBot is handed to `open`, the person's
/// browser; the webview opens no window of its own either way, as it never has on macOS.
pub fn new_window(destination: &tauri::Url, open: impl FnOnce(&str)) {
    if leaves(destination) {
        open(destination.as_str());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> tauri::Url {
        text.parse().unwrap()
    }

    #[test]
    fn an_apps_sign_in_and_any_other_website_leave_for_the_persons_browser() {
        assert!(leaves(&url("https://backend.composio.dev/api/v3/s/abc123")));
        assert!(leaves(&url(
            "https://app.hubspot.com/oauth/authorize?client_id=x"
        )));
        assert!(leaves(&url("http://example.com/")));
    }

    #[test]
    fn openbot_its_setup_screen_and_this_machine_stay_in_the_window() {
        assert!(!leaves(&url("http://127.0.0.1:3010/connections")));
        assert!(!leaves(&url("http://localhost:3010/")));
        assert!(!leaves(&url("http://[::1]:3010/")));
        assert!(!leaves(&url("http://dashboard.localhost:8080/")));
        assert!(!leaves(&url("tauri://localhost/")));
        assert!(!leaves(&url("about:blank")));
    }

    #[test]
    fn a_dropped_file_never_replaces_the_page_in_the_window() {
        assert!(opens_a_file(&url(
            "file:///Users/someone/Desktop/Screenshot%202026-11-09%20at%2014.20.00.png"
        )));
        assert!(opens_a_file(&url(
            "file:///C:/Users/someone/Pictures/shot.png"
        )));
        assert!(!opens_a_file(&url("http://127.0.0.1:3010/channel/abc")));
        assert!(!opens_a_file(&url("tauri://localhost/")));
        assert!(!opens_a_file(&url("http://tauri.localhost/")));
        let main = include_str!("main.rs");
        let guard = main
            .find("outside_links::opens_a_file(destination)")
            .unwrap();
        let first_check = main.find("outside_links::leaves(destination)").unwrap();
        assert!(
            guard < first_check,
            "the file check runs before a navigation is let through"
        );
    }

    #[test]
    fn the_booking_calendar_and_the_frames_it_embeds_load_in_place() {
        for frame in [
            "https://calendly.com/d/dwfr-k64-8d2/openbot-for-business?embed_domain=127.0.0.1%3A3010&embed_type=Inline&hide_event_type_details=1",
            "https://assets.calendly.com/assets/booking/css/booking.css",
            "https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=key",
            "https://js.stripe.com/v3/m-outer-3437aaddcdf6922d623e172c2d6f9278.html",
            "https://m.stripe.network/inner.html",
        ] {
            assert!(loads_in_a_frame(&url(frame)), "{frame}");
        }
    }

    #[test]
    fn every_other_site_and_a_lookalike_still_leave_for_the_browser() {
        for elsewhere in [
            "https://open.bot/business",
            "https://www.onetrust.com/solutions/consent-and-preferences/",
            "https://notcalendly.com/d/x",
            "https://calendly.com.example.com/",
            "http://calendly.com/d/dwfr-k64-8d2/openbot-for-business",
            "https://stripe.com/",
            "https://accounts.google.com/o/oauth2/auth",
        ] {
            assert!(!loads_in_a_frame(&url(elsewhere)), "{elsewhere}");
        }
    }

    #[test]
    fn a_new_window_for_a_site_outside_openbot_opens_in_the_browser_and_nothing_else_opens() {
        let mut opened = Vec::new();
        for asked in [
            "https://calendly.com/legal/privacy-notice",
            "https://www.onetrust.com/solutions/consent-and-preferences/",
            "http://127.0.0.1:3010/settings",
            "about:blank",
        ] {
            new_window(&url(asked), |to| opened.push(to.to_string()));
        }
        assert_eq!(
            opened,
            [
                "https://calendly.com/legal/privacy-notice",
                "https://www.onetrust.com/solutions/consent-and-preferences/",
            ]
        );
    }

    #[test]
    fn the_window_lets_the_calendar_load_and_sends_its_links_to_the_browser() {
        let main = include_str!("main.rs");
        assert!(main.contains("outside_links::loads_in_a_frame(destination)"));
        assert!(main.contains(".on_new_window("));
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["app"]["windows"][0]["create"],
            serde_json::Value::Bool(false),
            "the main window is built in setup, where its new-window handler is attached"
        );
    }

    #[test]
    fn the_window_hands_outside_sites_to_the_browser_and_injects_the_shim() {
        // Read as text, as the update-offer registration test does: the real webview cannot be
        // built in a unit test on macOS.
        let main = include_str!("main.rs");
        assert!(main.contains("plugin(outside_links_guard())"));
        assert!(main.contains("outside_links::PAGE"));
        assert!(PAGE.contains("window.open ="));
    }
}
