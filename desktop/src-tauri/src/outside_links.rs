//! A site outside OpenBot opens in the person's own browser, never in the desktop window.
//!
//! OpenBot's pages are shown in this app's webview, which is not a browser: it refuses
//! `window.open`, so an app's sign-in claimed in a new tab was blocked ("This browser blocked the
//! tab"), and a link to another site took the window itself there, leaving OpenBot. The person's
//! accounts (HubSpot, Google and the rest) are signed in to in their own browser, so that is where
//! a consent has to open. The page's shim (`outside-links.js`) turns every way out into a
//! navigation, and the window's guard hands each one that leaves to the default browser while the
//! page stays.

/// Injected into OpenBot's pages in the desktop window. See the module documentation.
pub const PAGE: &str = include_str!("outside-links.js");

/// Whether `destination` is a site outside OpenBot: the web, not this machine.
pub fn leaves(destination: &tauri::Url) -> bool {
    matches!(destination.scheme(), "http" | "https")
        && destination.host_str().is_some_and(|host| {
            !matches!(host, "127.0.0.1" | "localhost" | "[::1]") && !host.ends_with(".localhost")
        })
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
    fn the_window_hands_outside_sites_to_the_browser_and_injects_the_shim() {
        // Read as text, as the update-offer registration test does: the real webview cannot be
        // built in a unit test on macOS.
        let main = include_str!("main.rs");
        assert!(main.contains("plugin(outside_links_guard())"));
        assert!(main.contains("outside_links::PAGE"));
        assert!(PAGE.contains("window.open ="));
    }
}
