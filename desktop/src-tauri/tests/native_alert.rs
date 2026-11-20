//! The alert the shell shows its own messages in on macOS, built on the main thread the way the
//! app builds it: OpenBot's icon, the informational style, and the buttons the message asks for.
//! AppKit only works on the main thread, and the test harness runs each test on a thread of its
//! own, so this file runs without it (`harness = false` in Cargo.toml).

#[cfg(target_os = "macos")]
fn main() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSAlertFirstButtonReturn, NSAlertSecondButtonReturn, NSAlertStyle, NSApplication,
    };
    use openbot_desktop_lib::app_update;
    use openbot_desktop_lib::native_alert::{alert, went_ahead};

    let mtm = MainThreadMarker::new().expect("runs on the main thread");
    let app = NSApplication::sharedApplication(mtm);

    // Check for Updates… when this is the newest OpenBot: the message in the report.
    let up_to_date = app_update::prompt(&Ok(app_update::Asked::UpToDate {
        current: "1.0.0".into(),
    }));
    let shown = alert(
        mtm,
        &up_to_date.title,
        &up_to_date.message,
        up_to_date.buttons,
    );
    assert_eq!(shown.messageText().to_string(), "OpenBot is up to date");
    assert_eq!(
        shown.informativeText().to_string(),
        "OpenBot 1.0.0 is up to date."
    );
    // OpenBot's own icon, not the system's note icon, and no badge over it.
    let icon = shown.icon().expect("the alert has an icon");
    let own = app.applicationIconImage().expect("the app has an icon");
    assert!(
        std::ptr::eq(&*icon, &*own),
        "the alert shows the app's icon"
    );
    assert_eq!(shown.alertStyle(), NSAlertStyle::Informational);
    let titles: Vec<String> = shown
        .buttons()
        .iter()
        .map(|b| b.title().to_string())
        .collect();
    assert_eq!(titles, ["OK"]);

    // A newer version: the offer, with Update and restart first and Not now on Escape.
    let offer = app_update::prompt(&Ok(app_update::Asked::Available {
        version: "1.0.1".into(),
        current: "1.0.0".into(),
        ready: None,
    }));
    let (yes, no) = offer.buttons.expect("the offer asks");
    let shown = alert(mtm, &offer.title, &offer.message, offer.buttons);
    let buttons = shown.buttons();
    let titles: Vec<String> = buttons.iter().map(|b| b.title().to_string()).collect();
    assert_eq!(titles, [yes, no]);
    assert_eq!(buttons.objectAtIndex(0).keyEquivalent().to_string(), "\r");
    assert_eq!(
        buttons.objectAtIndex(1).keyEquivalent().to_string(),
        "\u{1b}"
    );
    assert!(std::ptr::eq(
        &*shown.icon().expect("the offer has an icon"),
        &*own
    ));

    // Only the first button goes ahead with an update.
    assert!(went_ahead(NSAlertFirstButtonReturn));
    assert!(!went_ahead(NSAlertSecondButtonReturn));

    // Failed to install: still OpenBot's icon, a single OK.
    let failed = app_update::install_failed("The download didn't finish.");
    let shown = alert(mtm, &failed.title, &failed.message, failed.buttons);
    assert!(std::ptr::eq(&*shown.icon().expect("an icon"), &*own));
    assert_eq!(shown.alertStyle(), NSAlertStyle::Informational);

    println!("native_alert: ok");
}

#[cfg(not(target_os = "macos"))]
fn main() {}
