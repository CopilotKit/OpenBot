/*!
The shell's own messages on macOS, such as Check for Updates…'s answer, in an alert with OpenBot's
icon.

The dialog plugin hands a message to `rfd`, and on macOS `rfd` shows a message that has no parent
window through `CFUserNotificationDisplayAlert`, with no icon. That alert is drawn by the system,
not by OpenBot, so it carries the system's grey note icon whatever the message's kind. A message
from the menu or the tray has no window to sit on, so it always went that way.

An `NSAlert` that OpenBot runs itself shows OpenBot's icon. This one is set to the app's icon by
name, so nothing else can stand in for it, and it keeps the informational style, which on macOS
draws no badge or symbol over the icon. On Windows and Linux the dialog plugin's message is right
as it is.
*/

use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSApplication, NSModalResponse,
};
use objc2_foundation::NSString;

/// Escape, as a button's key equivalent: the alert's second button is its way out.
const ESCAPE: &str = "\u{1b}";

/**
The alert for a message: `title` in bold, `message` under it, OpenBot's icon beside them.

`buttons` is the answer to ask for, the one that goes ahead first. Without it the alert has a
single OK. Return chooses the first button and Escape the second, as in any Mac alert.
*/
pub fn alert(
    mtm: MainThreadMarker,
    title: &str,
    message: &str,
    buttons: Option<(&str, &str)>,
) -> Retained<NSAlert> {
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Informational);
    alert.setMessageText(&NSString::from_str(title));
    alert.setInformativeText(&NSString::from_str(message));
    let icon = NSApplication::sharedApplication(mtm).applicationIconImage();
    // SAFETY: the image is the app's own icon, retained for the call; NSAlert copies nothing
    // unsafe from it.
    unsafe { alert.setIcon(icon.as_deref()) };
    match buttons {
        Some((yes, no)) => {
            alert.addButtonWithTitle(&NSString::from_str(yes));
            alert
                .addButtonWithTitle(&NSString::from_str(no))
                .setKeyEquivalent(&NSString::from_str(ESCAPE));
        }
        None => {
            alert.addButtonWithTitle(&NSString::from_str("OK"));
        }
    }
    alert
}

/// Whether the person chose the first button, the one that goes ahead.
pub fn went_ahead(response: NSModalResponse) -> bool {
    response == NSAlertFirstButtonReturn
}

/**
Show the alert for a message in front of whatever is there, wait for the answer, and say whether
it was the first button. On the main thread, which `mtm` proves.

A message from the tray comes while another app is in front, so OpenBot is activated first, with
`activateIgnoringOtherApps:`: macOS 14's cooperative `activate` leaves OpenBot behind an app that
does not yield (see `bring_to_front` in main.rs).
*/
pub fn ask(
    mtm: MainThreadMarker,
    title: &str,
    message: &str,
    buttons: Option<(&str, &str)>,
) -> bool {
    let alert = alert(mtm, title, message, buttons);
    #[allow(deprecated)]
    NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
    went_ahead(alert.runModal())
}
