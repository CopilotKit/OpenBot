/*!
The app connected to an OpenBot that runs somewhere else: what the setup window and OpenBot's own
page may ask, and what the window, the menus and Quit do differently while it is.

The work is in `openbot_desktop_lib::connected`. This is the wiring: the choice read from
`connection.json`, the sign-in started and cancelled, the relay started and stopped with the window
pointed at it, and the sentence kept for the setup window when a sign-in ends.

While the choice is to be connected, nothing of an installation on this computer is started, read
or written: `is_connected` is what every such path asks first.
*/

use crate::{Problem, Shell};
use openbot_desktop_lib::connected::{address, choice, credentials, relay, sign_in, Kind};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

/// What a page that asks for something of this computer's own OpenBot is told while connected.
pub const NOTHING_HERE: &str = "This app is connected to an OpenBot that runs somewhere else, so \
                                there's nothing to do here on this computer.";

/// Told to the setup window while OpenBot shows in connected mode: `{ kind, message }`.
pub const ENDED_EVENT: &str = "connection-ended";

/// The connection this session holds, and what the setup window is to be told next.
#[derive(Default)]
pub struct State {
    /// The relay the window shows OpenBot through, and its sign-in. None while not showing.
    live: Mutex<Option<Live>>,
    /// A sign-in waiting for the browser, for Cancel.
    attempt: Mutex<Option<Arc<sign_in::Attempt>>>,
    /// Kept for the setup page that has not loaded yet, and given once (`take_connection_notice`).
    notice: Mutex<Option<Notice>>,
    /// In place of the app's configuration folder, in a test.
    config_dir: Mutex<Option<PathBuf>>,
    /// In place of the system's credential store, in a test.
    store: Mutex<Option<credentials::Store>>,
    /// The account the app is signed in to, by the address it is signed in at, once that OpenBot
    /// has said (`learn_account`). About names it. Gone with a sign-out or an ended sign-in.
    signed_in_as: Mutex<Option<SignedInAs>>,
    /// The origin of a relay taken to be showing, in a test of the window's own rules: a real one
    /// needs an OpenBot to sign in to, which the library's tests have and these do not.
    #[cfg(test)]
    relay_for_test: Mutex<Option<String>>,
}

struct Live {
    relay: relay::Relay,
    session: Arc<sign_in::Session>,
}

struct SignedInAs {
    address: String,
    email: String,
}

/// What the setup window shows when it loads after a connection ended, or after Settings asked to
/// change it (`choose`, with no sentence).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Notice {
    pub kind: &'static str,
    pub message: Option<String>,
}

/// The choice, as the setup window and OpenBot's page are told it.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub mode: choice::Mode,
    pub address: Option<String>,
    pub organization_id: Option<String>,
    /// Whether a sign-in for that address is in the credential store. Only the setup window asks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signed_in: Option<bool>,
    /// Whether Settings offers the move to OpenBot Cloud (`desktop_move::offered_in_settings`).
    /// Only OpenBot's page asks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub move_to_cloud: Option<bool>,
}

fn state<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::State<'_, Shell> {
    app.state::<Shell>()
}

/// The app's configuration folder, where `connection.json` is (and the move's answer,
/// `desktop_move`). In a test, only the folder the test gave.
pub(crate) fn config_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    let given = state(app).connected.config_dir.lock().unwrap().clone();
    // A test never reads the choice of whoever runs it: only the folder it was given.
    if cfg!(test) {
        return given;
    }
    given.or_else(|| app.path().app_config_dir().ok())
}

fn store<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> credentials::Store {
    let given = state(app).connected.store.lock().unwrap().clone();
    given.unwrap_or_else(credentials::Store::system)
}

/// The person's choice on record: on this computer unless `connection.json` says otherwise.
pub fn chosen<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> choice::Choice {
    config_dir(app)
        .map(|dir| choice::read(&dir))
        .unwrap_or_default()
}

fn keep<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    chosen: &choice::Choice,
) -> Result<(), Problem> {
    let written = config_dir(app)
        .ok_or_else(|| "the app has no configuration folder".to_owned())
        .and_then(|dir| choice::write(&dir, chosen).map_err(|error| error.to_string()));
    written.map_err(|detail| {
        Problem::with(
            "OpenBot couldn't save your choice on this computer. Try again.",
            detail,
        )
    })
}

/// Whether the app is connected to an OpenBot that runs elsewhere: it shows one now, or the choice
/// on record is to. Then nothing of this computer's own installation is touched.
pub fn is_connected<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    state(app).connected.live.lock().unwrap().is_some()
        || chosen(app).mode == choice::Mode::Connected
}

/// The relay's origin, `http://127.0.0.1:<port>`, while the window shows OpenBot through it.
pub fn relay_origin<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<String> {
    #[cfg(test)]
    if let Some(origin) = state(app).connected.relay_for_test.lock().unwrap().clone() {
        return Some(origin);
    }
    state(app)
        .connected
        .live
        .lock()
        .unwrap()
        .as_ref()
        .map(|live| live.relay.origin())
}

/// The relay's entry address, while the window shows OpenBot through it: where the window goes
/// whenever it comes to the relay from a page of the shell's own. Going straight to the relay's
/// origin from there, WebKit leaves the window's cookie off, and the relay refuses the page
/// (`relay` says why). It holds the run's secret, so it is never logged.
fn relay_entry<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<String> {
    state(app)
        .connected
        .live
        .lock()
        .unwrap()
        .as_ref()
        .map(|live| live.relay.entry())
}

/// The address of the OpenBot the window shows through the relay, while it does.
pub fn connected_address<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<String> {
    state(app)
        .connected
        .live
        .lock()
        .unwrap()
        .as_ref()
        .map(|live| live.session.address().to_owned())
}

/// The address of the OpenBot the app is connected to: the one it shows, or else the one on record.
pub fn address_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<String> {
    connected_address(app).or_else(|| chosen(app).connected_to().map(str::to_owned))
}

/**
What that OpenBot says about itself, for Get Troubleshooting Logs…, asked by the gathering's
deadline (`connected::about`): through the app's sign-in while it shows that OpenBot, and only
whether it answers while it doesn't. The organization is the one the app works in there.
*/
pub fn about<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> openbot_desktop_lib::troubleshooting::Ask<openbot_desktop_lib::connected::about::About> {
    let address = address_now(app);
    let organization = chosen(app).organization_id;
    let session = state(app)
        .connected
        .live
        .lock()
        .unwrap()
        .as_ref()
        .map(|live| live.session.clone());
    Box::new(move |deadline| {
        let Some(address) = address else {
            return Ok(None);
        };
        let token = session.map(|session| move || session.access().map_err(|problem| problem.said));
        Ok(Some(openbot_desktop_lib::connected::about::ask(
            &address,
            organization.as_deref(),
            token
                .as_ref()
                .map(|token| token as openbot_desktop_lib::connected::about::Token),
            deadline,
        )))
    })
}

/// Whether `url` is a page the relay serves: OpenBot's own, from the OpenBot it is connected to.
pub fn is_relay_page<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &tauri::Url) -> bool {
    relay_origin(app).is_some_and(|origin| origin == url.origin().ascii_serialization())
}

/**
Where a navigation or a new window asked for from the main window goes, while the window shows an
OpenBot through the relay: true for the person's browser, false for the window itself. None while
no relay is showing, and then the rule for an OpenBot on this computer decides, as it always has.

The relay's own origin is OpenBot in the window, and stays. So do the setup page, the frames
OpenBot's pages embed, and anything that is not `http` or `https`. Every other address is outside,
whatever its host: the OpenBot the app is connected to has pages meant for the person's own browser,
where they hold a session of their own, and its address can be on this computer (`127.0.0.1` behind
a port forward). By its host alone that address looked like part of the window, and would have
loaded there with no sign-in at all.
*/
pub fn leaves_for_browser<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    destination: &tauri::Url,
) -> Option<bool> {
    let relay = relay_origin(app)?;
    let stays = !matches!(destination.scheme(), "http" | "https")
        || destination.origin().ascii_serialization() == relay
        || crate::on_setup_page(app, destination)
        || crate::outside_links::loads_in_a_frame(destination);
    Some(!stays)
}

/// Refuse something that is about this computer's own OpenBot, while connected to another.
pub fn nothing_here<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    if is_connected(app) {
        Err(NOTHING_HERE.into())
    } else {
        Ok(())
    }
}

/// The same refusal, for the setup window's commands that start or install something here.
pub fn local_only<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), Problem> {
    nothing_here(app).map_err(Problem::plain)
}

pub fn connection_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>, for_setup: bool) -> Connection {
    let chosen = chosen(app);
    let connected = chosen.mode == choice::Mode::Connected;
    let signed_in = for_setup.then(|| {
        chosen.connected_to().is_some_and(|address| {
            state(app).connected.live.lock().unwrap().is_some()
                || store(app).get(address).is_ok_and(|saved| saved.is_some())
        })
    });
    Connection {
        mode: chosen.mode,
        // The setup window is given a remembered address to offer again; OpenBot's page is told
        // of one only while connected to it.
        address: chosen.address.filter(|_| connected || for_setup),
        organization_id: chosen.organization_id.filter(|_| connected),
        signed_in,
        move_to_cloud: (!for_setup).then(|| crate::desktop_move::offered_in_settings(app)),
    }
}

/// The setup window's first question: which of the two, where, and whether it is signed in.
#[tauri::command]
pub async fn connection<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Connection {
    tauri::async_runtime::spawn_blocking(move || connection_now(&app, true))
        .await
        .unwrap_or(Connection {
            mode: choice::Mode::Local,
            address: None,
            organization_id: None,
            signed_in: Some(false),
            move_to_cloud: None,
        })
}

#[derive(Serialize)]
pub struct Checked {
    address: String,
}

/// Whether there is an OpenBot this app can connect to at `address`, and the address as kept.
#[tauri::command]
pub async fn check_openbot_address(address: String) -> Result<Checked, Problem> {
    let asked = std::time::Instant::now();
    let checked =
        blocking(move || address::check(&address).map(|(address, _)| Checked { address })).await;
    openbot_desktop_lib::logging::outcome("connect check", asked, &checked);
    checked
}

/// Connect: check the address, sign in through the browser, start the relay and show OpenBot.
/// The choice is kept only once all of that has worked.
#[tauri::command]
pub async fn connect_to_openbot<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    address: String,
) -> Result<(), Problem> {
    let asked = std::time::Instant::now();
    log::info!("[connect] asked");
    // Whether the browser was opened for the sign-in: from then on the person is in the browser,
    // and the app comes forward however it ends.
    let opened = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let opening = opened.clone();
    let forward = app.clone();
    let connected = blocking(move || connect_now(&app, &address, &opening)).await;
    openbot_desktop_lib::logging::outcome("connect", asked, &connected);
    come_forward_after_sign_in(
        &forward,
        opened.load(std::sync::atomic::Ordering::SeqCst),
        &connected,
    );
    connected
}

/// Why the app comes forward once a sign-in has ended, for the log: whenever the browser was
/// opened for it, however it ended. None when it never was (the address was refused first), and
/// the app is in front already.
pub fn forward_after_sign_in(opened: bool, outcome: &Result<(), Problem>) -> Option<String> {
    opened.then(|| {
        let ended = match outcome {
            Ok(()) => "signed in",
            Err(problem) => problem.kind.unwrap_or("failed"),
        };
        format!("the browser sign-in ended: {ended}")
    })
}

/**
The app in front once a sign-in that opened the browser has ended, however it ended: the same
routine every other moment that needs the person uses (`bring_to_front`), which shows, restores and
focuses the window and, where the system refuses, flashes its taskbar button. On the Mac a sign-in
whose save to the Keychain failed left the app behind Safari, and the person saw only the browser's
line, not the app's sentence about it.
*/
pub fn come_forward_after_sign_in<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    opened: bool,
    outcome: &Result<(), Problem>,
) {
    if let Some(why) = forward_after_sign_in(opened, outcome) {
        crate::bring_to_front(app, &why);
    }
}

/// Stop a sign-in that is waiting for the browser.
#[tauri::command]
pub async fn cancel_connect<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    cancel_sign_in(&app);
}

/// Stop a sign-in that is waiting for the browser: Connect's, or the move to OpenBot Cloud's.
pub fn cancel_sign_in<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(attempt) = state(app).connected.attempt.lock().unwrap().as_ref() {
        attempt.cancel();
    }
}

/**
The move to OpenBot Cloud's sign-in at `typed`, in the browser, exactly as Connect signs in (and
kept in the credential store as Connect keeps it). Always the browser's: a sign-in kept from before
may not carry the scopes the move asks for, which OpenBot Cloud lists in its metadata and this
sign-in asks for. Nothing is shown and nothing on this computer is stopped: the move still needs
the OpenBot here, and shows OpenBot Cloud only once it is done (`keep_moved_choice`,
`show_connected_at`). `opened` says whether the browser was opened.
*/
pub fn sign_in_for_move<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    typed: &str,
    opened: &std::sync::atomic::AtomicBool,
) -> Result<Arc<sign_in::Session>, Problem> {
    let (address, metadata) = address::check(typed)?;
    let attempt = Arc::new(sign_in::Attempt::default());
    if let Some(earlier) = state(app)
        .connected
        .attempt
        .lock()
        .unwrap()
        .replace(attempt.clone())
    {
        earlier.cancel();
    }
    let signed_in = sign_in::sign_in(
        &address,
        &metadata,
        store(app),
        &attempt,
        sign_in::WAIT,
        |authorize| {
            opened.store(true, std::sync::atomic::Ordering::SeqCst);
            open_in_browser(authorize)
        },
    );
    {
        let shell = state(app);
        let mut waiting = shell.connected.attempt.lock().unwrap();
        if waiting
            .as_ref()
            .is_some_and(|waiting| Arc::ptr_eq(waiting, &attempt))
        {
            *waiting = None;
        }
    }
    signed_in.map(Arc::new)
}

/// The move to OpenBot Cloud kept: the app connected to `address`, in the organization the move
/// went into, from the next launch on. Nothing is shown yet.
pub fn keep_moved_choice<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    address: &str,
    organization: &str,
) -> Result<(), Problem> {
    let mut moved = choice::signed_in_at(address);
    moved.organization_id =
        Some(organization.to_owned()).filter(|id| choice::valid_organization(id));
    keep(app, &moved)?;
    log::info!(
        "[move] the choice is the OpenBot at {}",
        openbot_desktop_lib::connected::host_of(address)
    );
    crate::refresh_menus(app);
    Ok(())
}

/// After the move: OpenBot Cloud in the window, at the app's page `to` (`/`, or `/connections`
/// for Reconnect), from the sign-in the move kept.
pub fn show_connected_at<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    to: &str,
) -> Result<(), Problem> {
    if let Some(entry) = state(app)
        .connected
        .live
        .lock()
        .unwrap()
        .as_ref()
        .map(|live| live.relay.entry_to(to))
    {
        return navigate(app, &entry);
    }
    let chosen = chosen(app);
    let Some(address) = chosen.connected_to() else {
        return Err(Problem::plain(
            "OpenBot isn't connected to an address. Choose where OpenBot runs.",
        ));
    };
    let metadata = address::probe(address)?;
    let session = sign_in::resume(address, &metadata, store(app))?;
    show(
        app,
        Arc::new(session),
        chosen.organization_id.as_deref(),
        to,
    )
}

/// At launch, connected and signed in: the saved sign-in made current, the relay started, and the
/// window on OpenBot. `session-ended` when the saved sign-in no longer works.
#[tauri::command]
pub async fn show_connected<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), Problem> {
    let asked = std::time::Instant::now();
    log::info!("[connect] asked to show the connected OpenBot");
    let shown = blocking(move || show_connected_now(&app)).await;
    openbot_desktop_lib::logging::outcome("connect show", asked, &shown);
    shown
}

/// Sign out, and the setup window. The address stays remembered.
#[tauri::command]
pub async fn sign_out_of_openbot<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), Problem> {
    blocking(move || {
        sign_out_now(&app);
        crate::show_setup(app).map_err(Problem::from)
    })
    .await
}

/// Back to OpenBot on this computer: signed out, the choice switched, and the setup window, which
/// carries on as it does for an installation here.
#[tauri::command]
pub async fn use_this_computer<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), Problem> {
    blocking(move || {
        sign_out_now(&app);
        let mut chosen = chosen(&app);
        chosen.mode = choice::Mode::Local;
        chosen.organization_id = None;
        keep(&app, &chosen)?;
        log::info!("[connect] the choice is OpenBot on this computer");
        crate::refresh_menus(&app);
        crate::show_setup(app).map_err(Problem::from)
    })
    .await
}

/// What the setup window is to show after a connection ended or was asked to change. Once.
#[tauri::command]
pub async fn take_connection_notice<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Option<Notice> {
    state(&app).connected.notice.lock().unwrap().take()
}

/// The setup window's next `take_connection_notice` says to open at the choice of where OpenBot
/// runs, showing no failure.
pub fn ask_to_choose<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    *state(app).connected.notice.lock().unwrap() = Some(Notice {
        kind: "choose",
        message: None,
    });
}

/// Settings' Change on where OpenBot runs, and the setup window at that choice.
///
/// Connected: signed out, still connected to the address on record. On this computer: OpenBot
/// stopped, exactly as Settings' Stop stops it, and the choice on record left as it is.
pub fn change_connection_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    if !is_connected(app) {
        crate::change_connection_from_settings(app.clone());
        return Ok(());
    }
    sign_out_now(app);
    ask_to_choose(app);
    crate::show_setup(app.clone())
}

/// The organisation the person picked in OpenBot's switcher, kept beside the address and named by
/// the relay on every request from now on. None clears it.
pub fn set_organization_now<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    organization_id: Option<String>,
) -> Result<(), String> {
    if let Some(id) = &organization_id {
        if !choice::valid_organization(id) {
            return Err("That isn't an organization OpenBot knows.".into());
        }
    }
    let mut chosen = chosen(app);
    if chosen.connected_to().is_none() {
        return Err("OpenBot isn't connected to an address.".into());
    }
    chosen.organization_id = organization_id;
    keep(app, &chosen).map_err(|problem| problem.said)?;
    if let Some(live) = state(app).connected.live.lock().unwrap().as_ref() {
        live.relay
            .set_organization(chosen.organization_id.as_deref());
    }
    Ok(())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Problem> + Send + 'static,
) -> Result<T, Problem> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| Problem::with("OpenBot couldn't do that. Try again.", error.to_string()))
        .and_then(|done| done)
}

fn connect_now<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    typed: &str,
    opened: &std::sync::atomic::AtomicBool,
) -> Result<(), Problem> {
    let (address, metadata) = address::check(typed)?;
    let attempt = Arc::new(sign_in::Attempt::default());
    if let Some(earlier) = state(app)
        .connected
        .attempt
        .lock()
        .unwrap()
        .replace(attempt.clone())
    {
        earlier.cancel();
    }
    let signed_in = sign_in::sign_in(
        &address,
        &metadata,
        store(app),
        &attempt,
        sign_in::WAIT,
        |authorize| {
            opened.store(true, std::sync::atomic::Ordering::SeqCst);
            open_in_browser(authorize)
        },
    );
    {
        let shell = state(app);
        let mut waiting = shell.connected.attempt.lock().unwrap();
        if waiting
            .as_ref()
            .is_some_and(|waiting| Arc::ptr_eq(waiting, &attempt))
        {
            *waiting = None;
        }
    }
    let session = Arc::new(signed_in?);

    // A sign-in the app could not use is revoked, and the browser is left as it is: the person
    // who signed in there a moment ago is still here, and tries again.
    let keep_browser = |_: &str| Ok(());
    // An OpenBot running on this computer is stopped first, as Stop stops it.
    if let Err(problem) = stop_local_first(app) {
        let _ = session.sign_out(keep_browser);
        return Err(problem);
    }
    // No organisation named: the app works in the one the person picked as they signed in, which
    // the token keeps, until they pick another in the switcher.
    let chosen = choice::signed_in_at(&address);
    let shown = show(app, session.clone(), chosen.organization_id.as_deref(), "/")
        .and_then(|()| keep(app, &chosen));
    if shown.is_err() {
        stop_relay(app);
        let _ = session.sign_out(keep_browser);
    }
    shown
}

/// The person's own browser, where they are signed in to their accounts: where the sign-in goes,
/// and where sign-out ends that browser's session at the OpenBot. Never opened by a test.
fn open_in_browser(address: &str) -> Result<(), String> {
    if cfg!(test) {
        return Err("a test opens no browser".into());
    }
    tauri_plugin_opener::open_url(address, None::<&str>).map_err(|error| error.to_string())
}

fn show_connected_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), Problem> {
    // Already showing in this session: the window goes back to it, through the entry.
    if let Some(origin) = relay_origin(app) {
        return navigate(app, &relay_entry(app).unwrap_or(origin));
    }
    let chosen = chosen(app);
    let Some(address) = chosen.connected_to() else {
        return Err(Problem::plain(
            "OpenBot isn't connected to an address. Choose where OpenBot runs.",
        ));
    };
    let metadata = address::probe(address)?;
    let session = sign_in::resume(address, &metadata, store(app))?;
    show(
        app,
        Arc::new(session),
        chosen.organization_id.as_deref(),
        "/",
    )
}

/// Start the relay for `session` and point the window at it, at the app's page `to`.
fn show<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    session: Arc<sign_in::Session>,
    organization: Option<&str>,
    to: &str,
) -> Result<(), Problem> {
    let host = session.host().to_owned();
    let listening = app.clone();
    let listening_host = host.clone();
    let relay = relay::Relay::start(session.clone(), organization, move |why| match why {
        relay::Ended::SessionEnded => session_ended(&listening, &listening_host),
        relay::Ended::Unreachable => {
            let _ = listening.emit(
                ENDED_EVENT,
                Notice {
                    kind: Kind::Unreachable.id(),
                    message: Some(Kind::Unreachable.said(&listening_host)),
                },
            );
        }
    })
    .map_err(|detail| {
        Problem::with(
            "OpenBot couldn't open its connection on this computer. Try again.",
            detail,
        )
    })?;
    let origin = relay.origin();
    let entry = relay.entry_to(to);
    stop_relay(app);
    *state(app).connected.live.lock().unwrap() = Some(Live {
        relay,
        session: session.clone(),
    });
    // The relay's pages are OpenBot's own: the window's controls, theme, notifications and the
    // rest, exactly as for an OpenBot this computer runs.
    crate::trust_owned_app(app, &origin);
    crate::refresh_menus(app);
    learn_account(app, session, organization);
    log::info!("[connect] showing the OpenBot at {host}");
    // First to the relay's entry, which gives the window this run's cookie and sends it on.
    navigate(app, &entry)?;
    crate::bring_to_front(app, "OpenBot is showing");
    Ok(())
}

/**
Ask the OpenBot the app is now signed in to which account it is, on its own thread, and build the
menus again once it says, so About names it. The same question the move to OpenBot Cloud asks of
the account it went into (`move_to_cloud::Api::account`), in the organization the app works in, or
the person's own when none is on record. One that can't be answered leaves About without the
account, and nothing else waits on it.
*/
fn learn_account<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    session: Arc<sign_in::Session>,
    organization: Option<&str>,
) {
    use openbot_desktop_lib::move_to_cloud::{their_own_organization, Api};
    let app = app.clone();
    let organization = organization.map(str::to_owned);
    std::thread::spawn(move || {
        let address = session.address().to_owned();
        let credentials = Box::new(crate::desktop_move::SessionCredentials(session));
        let cloud = match &organization {
            Some(organization) => Api::at(&address, credentials, organization),
            None => Api::open(&address, credentials, their_own_organization),
        };
        match cloud.and_then(|cloud| cloud.account()) {
            // Only while that sign-in still shows: one signed out meanwhile is not named.
            Ok(account) if connected_address(&app).as_deref() == Some(address.as_str()) => {
                remember_account(&app, &address, &account.email)
            }
            Ok(_) => {}
            Err(detail) => log::warn!(
                "[connect] could not ask {} which account this app is signed in to: {detail}",
                openbot_desktop_lib::connected::host_of(&address)
            ),
        }
    });
}

/// The account the app is signed in to at `address`, for About, which is built again to say it.
pub(crate) fn remember_account<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    address: &str,
    email: &str,
) {
    *state(app).connected.signed_in_as.lock().unwrap() = Some(SignedInAs {
        address: address.to_owned(),
        email: email.to_owned(),
    });
    crate::refresh_menus(app);
}

/// Signed out, or the sign-in ended: About no longer names an account.
fn forget_account<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    *state(app).connected.signed_in_as.lock().unwrap() = None;
}

/// The email the app is signed in with at the OpenBot it is connected to, once that OpenBot has
/// said. None on this computer, and for an account at another address than the one on record.
pub fn signed_in_as<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<String> {
    let chosen = chosen(app);
    let address = chosen.connected_to()?;
    state(app)
        .connected
        .signed_in_as
        .lock()
        .unwrap()
        .as_ref()
        .filter(|known| known.address == address)
        .map(|known| known.email.clone())
}

fn navigate<R: tauri::Runtime>(app: &tauri::AppHandle<R>, to: &str) -> Result<(), Problem> {
    let window = app
        .get_webview_window("main")
        .ok_or("the OpenBot window is not there to show it in")?;
    let destination: tauri::Url = to
        .parse()
        .map_err(|_| Problem::plain("OpenBot could not navigate to its app."))?;
    window
        .navigate(destination)
        .map_err(|_| Problem::plain("OpenBot could not navigate to its app."))
}

/// Stop the relay, if one runs. The sign-in is left as it is.
pub fn stop_relay<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let live = state(app).connected.live.lock().unwrap().take();
    if let Some(live) = live {
        forget_origin(app, &live.relay.origin());
        drop(live);
    }
}

/// A relay that has stopped is no longer OpenBot's page: its port is anybody's again.
fn forget_origin<R: tauri::Runtime>(app: &tauri::AppHandle<R>, origin: &str) {
    state(app)
        .owned_app_origins
        .lock()
        .unwrap()
        .retain(|trusted| trusted != origin);
}

/// Sign out of the OpenBot on record: revoked there as far as it answers, forgotten here, and the
/// relay stopped. The address stays. The next sign-in names no organisation: it works in the one
/// the person picks as they sign in (`choice::signed_in_at`).
///
/// Then, when the OpenBot publishes where a browser ends its session there, the person's browser
/// is sent there, the same browser the sign-in went through (`open_in_browser`): it stays signed in
/// otherwise, and the next person's sign-in on this computer would come back as this one.
pub fn sign_out_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(attempt) = state(app).connected.attempt.lock().unwrap().take() {
        attempt.cancel();
    }
    let live = state(app).connected.live.lock().unwrap().take();
    let chosen = chosen(app);
    match live {
        Some(live) => {
            forget_origin(app, &live.relay.origin());
            if let Err(problem) = live.session.sign_out(open_in_browser) {
                log::warn!(
                    "[connect] could not forget the sign-in: {}",
                    problem.detail.unwrap_or(problem.said)
                );
            }
        }
        None => {
            if let Some(address) = chosen.connected_to() {
                let metadata = address::probe(address).ok();
                if let Err(problem) = sign_in::sign_out_saved(
                    address,
                    metadata.as_ref(),
                    &store(app),
                    open_in_browser,
                ) {
                    log::warn!(
                        "[connect] could not forget the sign-in: {}",
                        problem.detail.unwrap_or(problem.said)
                    );
                }
            }
        }
    }
    forget_account(app);
    crate::refresh_menus(app);
}

/// The relay said the sign-in is over: it is stopped, the setup window comes back, and the
/// sentence waits for it.
pub(crate) fn session_ended<R: tauri::Runtime>(app: &tauri::AppHandle<R>, host: &str) {
    stop_relay(app);
    let notice = Notice {
        kind: Kind::SessionEnded.id(),
        message: Some(Kind::SessionEnded.said(host)),
    };
    *state(app).connected.notice.lock().unwrap() = Some(notice.clone());
    forget_account(app);
    crate::refresh_menus(app);
    if let Err(error) = crate::show_setup(app.clone()) {
        log::warn!("[connect] could not show setup after the sign-in ended: {error}");
    }
    let _ = app.emit(ENDED_EVENT, notice);
}

/// An OpenBot running on this computer when the person connects to another: stopped, the way Stop
/// stops it, before the app is connected. One that is not running is left exactly as it is.
fn stop_local_first<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), Problem> {
    let shell = state(app);
    let held = shell.root.lock().unwrap().is_some() || shell.containers.lock().unwrap().is_some();
    let root = crate::cleanup_root(&shell, &openbot_desktop_lib::stack::default_root());
    let running = held
        || (openbot_desktop_lib::deployment::installed(&root).is_some()
            && crate::already_running_now(app, &root.to_string_lossy()));
    if !running {
        return Ok(());
    }
    log::info!("[connect] stopping OpenBot on this computer first");
    crate::stop_everything(app, &root)
        .into_result()
        .map_err(|detail| {
            Problem::with(
                "OpenBot on this computer couldn't finish stopping, so the app didn't connect. \
                 Try again.",
                detail,
            )
        })
}

/// Show Window, from the tray or a second launch, while connected: OpenBot through the relay when
/// it is showing, and the setup window otherwise, which signs in or shows why it can't.
pub fn show_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let current = window.url().ok();
    let destination = match relay_origin(app) {
        Some(origin) => origin.parse::<tauri::Url>().ok(),
        None => crate::setup_destination(app).ok(),
    };
    if let Some(destination) = destination {
        let already_showing = current
            .as_ref()
            .is_some_and(|current| crate::same_window_app(current, &destination));
        if !already_showing {
            // Onto the relay through its entry, which hands the window its cookie on the way.
            let entry = relay_entry(app).and_then(|entry| entry.parse::<tauri::Url>().ok());
            let _ = window.navigate(entry.unwrap_or(destination));
        }
    }
    let _ = window.show();
    let _ = window.unminimize();
    crate::focus(&window, "OpenBot is showing");
}

/// What `status` answers OpenBot's page while connected: the app's own version, build and log
/// folder, and nothing of this computer's own OpenBot, which is not asked.
pub fn status<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> crate::DesktopStatus {
    crate::DesktopStatus::of_the_app_alone(app)
}

/// Quit while connected: only the relay stops. Nothing on this computer runs because of it.
pub fn quit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(attempt) = state(app).connected.attempt.lock().unwrap().take() {
        attempt.cancel();
    }
    stop_relay(app);
    log::info!("[quit] connected to an OpenBot that runs elsewhere; nothing to stop here");
}

/// Sign Out in the tray and the window menu.
pub fn sign_out_from_menu<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    std::thread::spawn(move || {
        sign_out_now(&app);
        if let Err(error) = crate::show_setup_and_focus(app) {
            log::warn!("[connect] could not show setup after signing out: {error}");
        }
    });
}

#[cfg(test)]
pub(crate) fn use_for_test<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    config_dir: PathBuf,
    store: credentials::Store,
) {
    *state(app).connected.config_dir.lock().unwrap() = Some(config_dir);
    *state(app).connected.store.lock().unwrap() = Some(store);
}

/// As `show` leaves things once a relay is up at `origin`: taken to be showing, and trusted.
#[cfg(test)]
pub(crate) fn showing_for_test<R: tauri::Runtime>(app: &tauri::AppHandle<R>, origin: &str) {
    *state(app).connected.relay_for_test.lock().unwrap() = Some(origin.to_owned());
    crate::trust_owned_app(app, origin);
}
