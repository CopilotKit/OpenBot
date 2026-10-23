/*!
The OpenBot app's own page asking the shell to open the local Intelligence dashboard.

The app is served from a loopback port and loaded in the main window, so to Tauri it is a remote
origin, and a remote origin reaches no command of this app (Tauri refuses every app command to one
that no capability names). This is the one exception, kept as small as it can be:

- an inline plugin, `openbot-intelligence`, with two commands: `watch`, which hands over a channel
  for what the sidebar row should show, and `open`, which starts the same opening as the menu;
- a capability added at runtime for exactly the owned app's origin, `http://127.0.0.1:<port>`, on
  the main window only, granting those two commands and nothing else. No `core:event`, so the page
  hears none of the setup window's events;
- what the page is told is an `Offer`: a state, and for a failure a fixed category. No address,
  no CLI text, no stack id.
*/

use serde::Serialize;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::Manager;

use super::{DashboardFailure, IntelligenceOpening, Shell};

pub const PLUGIN: &str = "openbot-intelligence";

/// What the app's sidebar row shows. A failure is told once, as it happens; a page that starts
/// watching afterwards is told the state that followed it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", content = "reason", rename_all = "lowercase")]
pub enum Offer {
    /// Not local mode, or no stack recorded: the row is hidden.
    Unavailable,
    Ready,
    Opening,
    Failed(DashboardFailure),
}

impl Offer {
    /// What the row shows once the opening has said `status`.
    pub fn after(status: &IntelligenceOpening) -> Offer {
        match status {
            IntelligenceOpening::Opening => Offer::Opening,
            IntelligenceOpening::Opened => Offer::Ready,
            IntelligenceOpening::Failed(failure) => Offer::Failed(*failure),
        }
    }
}

#[derive(Default)]
pub struct Bridge {
    /// The newest page's channel. Only the main window can watch, and a page that loads again
    /// watches again, so one is kept.
    watcher: Mutex<Option<Channel<Offer>>>,
    /// The app origins already granted, so a navigation back does not add the same capability.
    granted: Mutex<Vec<String>>,
    /// Set once the app was built with this plugin's permissions (`enable`). Tauri panics, holding
    /// its permission lock, on a capability that names permissions it never compiled in.
    enabled: std::sync::atomic::AtomicBool,
}

/// Say the running app carries this plugin's permissions, so `allow` may grant them. Called from
/// the real app's setup; a test app built from a mock context never is.
pub fn enable<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    app.state::<Shell>()
        .intelligence_bridge
        .enabled
        .store(true, std::sync::atomic::Ordering::SeqCst);
}

/// The row's state now, from the same state the menu item uses.
pub fn current<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Offer {
    let shell = app.state::<Shell>();
    if shell
        .intelligence_opening
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        Offer::Opening
    } else if shell.intelligence_menu.lock().unwrap().is_some() {
        Offer::Ready
    } else {
        Offer::Unavailable
    }
}

/// Tell the watching page. True when the main window shows a granted app page now and the channel
/// took the message, so a failure has somewhere on screen to be read.
pub fn tell<R: tauri::Runtime>(app: &tauri::AppHandle<R>, offer: Offer) -> bool {
    let bridge = &app.state::<Shell>().intelligence_bridge;
    let mut watcher = bridge.watcher.lock().unwrap();
    let Some(channel) = watcher.as_ref() else {
        return false;
    };
    if channel.send(offer).is_err() {
        *watcher = None;
        return false;
    }
    drop(watcher);
    let showing = app
        .get_webview_window("main")
        .and_then(|window| window.url().ok())
        .map(|url| url.origin().ascii_serialization());
    showing.is_some_and(|origin| bridge.granted.lock().unwrap().contains(&origin))
}

/// The exact origin of an owned app address, or None for anything but `http` on a loopback IP.
pub fn app_origin(address: &str) -> Option<String> {
    let url = tauri::Url::parse(address).ok()?;
    // An IP literal only: a name could resolve anywhere.
    let loopback = url
        .host_str()?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback());
    (url.scheme() == "http" && loopback && url.port().is_some())
        .then(|| url.origin().ascii_serialization())
}

/// Let the owned app at `address` use this plugin from the main window, once per origin.
///
/// Called with the address the shell verified it owns, before navigating there. Anything that is
/// not a loopback `http` address with a port is refused.
pub fn allow<R: tauri::Runtime>(app: &tauri::AppHandle<R>, address: &str) {
    let Some(origin) = app_origin(address) else {
        return;
    };
    let shell = app.state::<Shell>();
    if !shell
        .intelligence_bridge
        .enabled
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }
    let mut granted = shell.intelligence_bridge.granted.lock().unwrap();
    if granted.contains(&origin) {
        return;
    }
    let capability = tauri::ipc::CapabilityBuilder::new(format!("openbot-app-{}", granted.len()))
        .remote(format!("{origin}/*"))
        .local(false)
        .window("main")
        .permission(format!("{PLUGIN}:allow-watch"))
        .permission(format!("{PLUGIN}:allow-open"));
    match app.add_capability(capability) {
        Ok(()) => granted.push(origin),
        Err(error) => eprintln!("[intelligence] could not allow the app page: {error}"),
    }
}

/// Keep `on_offer` as the page's channel and tell it the state now.
#[tauri::command]
fn watch<R: tauri::Runtime>(app: tauri::AppHandle<R>, on_offer: Channel<Offer>) {
    let now = current(&app);
    if on_offer.send(now).is_ok() {
        *app.state::<Shell>()
            .intelligence_bridge
            .watcher
            .lock()
            .unwrap() = Some(on_offer);
    }
}

/// Start opening the dashboard, exactly as the menu does. How it goes arrives through `watch`.
#[tauri::command]
fn open<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    super::start_intelligence_opening(app);
}

pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new(PLUGIN)
        .invoke_handler(tauri::generate_handler![watch, open])
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_loopback_ip_with_a_port_is_an_app_origin() {
        assert_eq!(
            app_origin("http://127.0.0.1:3010").as_deref(),
            Some("http://127.0.0.1:3010")
        );
        assert_eq!(
            app_origin("http://[::1]:3010/channel/x").as_deref(),
            Some("http://[::1]:3010")
        );
        for refused in [
            "http://localhost:3010",
            "https://127.0.0.1:3010",
            "http://127.0.0.1",
            "http://192.168.1.4:3010",
            "http://openbot.example.com:3010",
            "tauri://localhost",
            "not a url",
        ] {
            assert_eq!(app_origin(refused), None, "{refused}");
        }
    }

    fn app() -> (
        tauri::App<tauri::test::MockRuntime>,
        tauri::WebviewWindow<tauri::test::MockRuntime>,
    ) {
        let app = tauri::test::mock_builder()
            .plugin(plugin())
            .manage(Shell::default())
            .invoke_handler(tauri::generate_handler![crate::default_root])
            .build(tauri::generate_context!(test = true))
            .unwrap();
        enable(app.handle());
        let window = app.get_webview_window("main").unwrap_or_else(|| {
            tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap()
        });
        (app, window)
    }

    fn ask(
        window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        from: &str,
        cmd: &str,
    ) -> Result<serde_json::Value, serde_json::Value> {
        tauri::test::get_ipc_response(
            window,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: from.parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize().unwrap())
    }

    const OPEN: &str = "plugin:openbot-intelligence|open";

    #[test]
    fn the_owned_app_origin_reaches_these_commands_and_nothing_else() {
        let (app, window) = app();
        let page = "http://127.0.0.1:3010/channel/existing";
        // Before the shell has verified and allowed the app, its page reaches nothing.
        assert!(ask(&window, page, OPEN).is_err());

        allow(app.handle(), "http://127.0.0.1:3010");
        assert_eq!(ask(&window, page, OPEN), Ok(serde_json::Value::Null));
        // Not the app's other commands, and not another port on the same address.
        assert!(ask(&window, page, "default_root").is_err());
        assert!(
            ask(&window, "tauri://localhost", "default_root").is_ok(),
            "the setup page still reaches it, so the refusal above is the origin's"
        );
        assert!(ask(&window, "http://127.0.0.1:3011/", OPEN).is_err());
        assert!(ask(&window, "http://localhost:3010/", OPEN).is_err());
        // Allowing again adds nothing new and changes nothing.
        allow(app.handle(), "http://127.0.0.1:3010");
        assert_eq!(
            app.state::<Shell>()
                .intelligence_bridge
                .granted
                .lock()
                .unwrap()
                .len(),
            1
        );
        // A refused address is never allowed.
        allow(app.handle(), "http://localhost:3011");
        assert!(ask(&window, "http://localhost:3011/", OPEN).is_err());
    }

    #[test]
    fn an_app_built_without_the_plugins_permissions_grants_nothing() {
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        // No panic, and nothing recorded as granted.
        allow(app.handle(), "http://127.0.0.1:3010");
        assert!(app
            .state::<Shell>()
            .intelligence_bridge
            .granted
            .lock()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn the_row_follows_the_menus_state() {
        let (app, _window) = app();
        assert_eq!(current(app.handle()), Offer::Unavailable);
        let shell = app.state::<Shell>();
        *shell.intelligence_menu.lock().unwrap() = Some("/tmp/openbot".into());
        assert_eq!(current(app.handle()), Offer::Ready);
        shell
            .intelligence_opening
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(current(app.handle()), Offer::Opening);
        // With no page watching, nothing is told and a failure needs another place.
        assert!(!tell(app.handle(), Offer::Failed(DashboardFailure::Busy)));
    }
}
