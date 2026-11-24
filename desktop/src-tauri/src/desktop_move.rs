/*!
The move from OpenBot (Self-Contained) to OpenBot Cloud, as the setup window and Settings ask it.

The work is in `openbot_desktop_lib::move_to_cloud`. This is the wiring:

- `move_offer`: whether the setup window shows the choice before it shows OpenBot (once per
  person, after the update, for OpenBot (Self-Contained) only), and whether Settings sent it
  there, answered at once.
- `move_footprint`: how much OpenBot takes on this computer, measured on its own thread, which the
  window asks for once it has the answer.
- `keep_self_contained`: "Keep OpenBot (Self-Contained)", not asked again at launch, except once
  after the next update when it followed a move that failed (`note_outcome`).
- `move_preview`: what moves and which apps to connect again, from the OpenBot running here.
- `move_to_cloud`: sign in to OpenBot Cloud in the browser, then the move, which removes OpenBot
  from this computer only once OpenBot Cloud has checked that everything arrived. Each step is
  told to the window as `move:progress`.
- `cancel_move`: Cancel while the browser sign-in waits.
- `open_moved_cloud`: OpenBot Cloud in the window, at its home or its Connections page.
- `ask_from_settings`: Settings' "Move to OpenBot Cloud", which sends the window to setup without
  stopping anything: the move needs the OpenBot here running.
*/

use crate::{Problem, Shell};
use openbot_desktop_lib::move_to_cloud::{self as moving, Answer, Stage};
use openbot_desktop_lib::{own_podman, stack, uninstall};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

/// Told to the setup window while the move runs.
pub const PROGRESS_EVENT: &str = "move:progress";

#[derive(Default)]
pub struct State {
    /// The setup page said this build offers OpenBot Cloud (its own build-time switch), this run.
    cloud: AtomicBool,
    /// Settings asked for the move; the setup page reads it once.
    from_settings: AtomicBool,
    /// A move is running: a second one is refused.
    running: AtomicBool,
    /// The move's screens are on setup, waiting for the person's answer: offered (`move_offer`
    /// said due, or Settings sent the window), and neither kept here (`keep_self_contained`) nor
    /// moved yet. A restore leaves the window on them (`offered_on_screen`).
    on_screen: AtomicBool,
    /// The OpenBot Cloud sign-in this run made for the move, for Try again.
    signed_in:
        std::sync::Mutex<Option<std::sync::Arc<openbot_desktop_lib::connected::sign_in::Session>>>,
    /// What OpenBot's files take on this computer, measured once a run on a thread of its own
    /// (`sized_within`).
    sizing: std::sync::Mutex<Sizing>,
    sized: std::sync::Condvar,
    /// Sizing OpenBot's files takes this much longer, for a test of a computer where it is slow.
    #[cfg(test)]
    slow_sizing: std::sync::Mutex<Option<std::time::Duration>>,
}

/// Where the measure of OpenBot's files is: not begun, under way, or done, with its answer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Sizing {
    #[default]
    NotBegun,
    Measuring,
    Done(Option<u64>),
}

/// The longest the window waits for the size before it says the move without it.
const SIZING_CAP: std::time::Duration = std::time::Duration::from_secs(20);

/// Sizing OpenBot's files takes `delay` longer, as on a computer with old installs on its disk.
#[cfg(test)]
pub(crate) fn slow_sizing_for_test<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    delay: std::time::Duration,
) {
    *state(app).slow_sizing.lock().unwrap() = Some(delay);
}

fn state<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> &State {
    &app.state::<Shell>().inner().moving
}

/**
Whether a move is running now. Its screens are setup's, and the window stays on them until it ends:
a Dock click, the tray's Open, a second launch or a notice brings the window forward as it is
(`restore_window_on`). Sending it to the OpenBot on this computer would show an app the move is
about to remove, which then answers nothing.
*/
pub fn moving<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    state(app).running.load(Ordering::SeqCst)
}

/// A move running, or not, for a test of what the window does meanwhile.
#[cfg(test)]
pub(crate) fn set_moving_for_test<R: tauri::Runtime>(app: &tauri::AppHandle<R>, running: bool) {
    state(app).running.store(running, Ordering::SeqCst);
}

/**
Whether the move's screens are on setup, waiting for the person's answer: the choice, what moves, or
a move that stopped. The window stays on them when it is brought back, as it does while a move runs
(`moving`).

Seen on 1.2.0-rc.3: the person picked OpenBot Cloud, and while the OpenBot here started and updated
for the move (two and a half minutes), came back to the window from the Dock. The restore showed the
OpenBot here, now up, in place of the move's screens. The move was never started, nothing said so,
and the person took the move as done.
*/
pub fn offered_on_screen<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    state(app).on_screen.load(Ordering::SeqCst)
}

/// The move's screens on setup, or not, for a test of what the window does meanwhile.
#[cfg(test)]
pub(crate) fn set_offered_on_screen_for_test<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    shown: bool,
) {
    state(app).on_screen.store(shown, Ordering::SeqCst);
}

/// The folder `connection.json` is in, the same in a test (`desktop_connected::config_dir`).
fn config_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    crate::desktop_connected::config_dir(app)
}

fn answered<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<Answer> {
    config_dir(app).and_then(|dir| moving::answered(&dir))
}

/// This app's own version: a Keep that followed a failed move is offered again in any other.
fn release<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    app.package_info().version.to_string()
}

fn root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    crate::cleanup_root(&app.state::<Shell>(), &stack::default_root())
}

/// Whether OpenBot is set up on this computer: an installation recorded in its folder.
fn installed_here<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    openbot_desktop_lib::deployment::installed(&root(app)).is_some()
}

/// What the setup window is told when it is about to show OpenBot.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOffer {
    due: bool,
    from_settings: bool,
    footprint_bytes: Option<u64>,
}

/// Whether Settings may offer the move: on this computer, in a build that offers OpenBot Cloud,
/// and not moved already. Read by the page's `connection` answer.
pub fn offered_in_settings<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    moving::offered_in_settings(
        state(app).cloud.load(Ordering::SeqCst),
        crate::desktop_connected::is_connected(app),
        answered(app),
    )
}

/**
The setup window's question before it shows OpenBot. `cloud` is its own switch: whether this build
offers OpenBot Cloud.

Answered at once. The window holds every start and update until it has the answer, and on a Mac
with two older installs of OpenBot on its disk, sizing OpenBot's files first made that 15 seconds.
So the size goes with the answer only when it is already known; otherwise it is measured on a
thread of its own and the window asks for it with `move_footprint`.
*/
#[tauri::command]
pub async fn move_offer<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    cloud: Option<bool>,
) -> MoveOffer {
    let cloud = cloud.unwrap_or(false);
    state(&app).cloud.store(cloud, Ordering::SeqCst);
    let asked = std::time::Instant::now();
    log::info!("[move] offer asked");
    tauri::async_runtime::spawn_blocking(move || {
        let from_settings =
            state(&app).from_settings.swap(false, Ordering::SeqCst) && offered_in_settings(&app);
        let recorded = config_dir(&app)
            .map(|dir| moving::on_record(&dir))
            .unwrap_or_default();
        let due = moving::due(
            cloud,
            crate::desktop_connected::is_connected(&app),
            installed_here(&app),
            &recorded,
            &release(&app),
        );
        // The window shows the move's screens before OpenBot now, and stays on them until answered.
        state(&app)
            .on_screen
            .store(due || from_settings, Ordering::SeqCst);
        let footprint_bytes = if due || from_settings {
            begin_sizing(&app);
            sized_now(&app)
        } else {
            None
        };
        let again = match (&recorded.kept_after_failed_move_in, due) {
            (Some(kept_in), true) => {
                format!(", again: kept after a failed move on {kept_in}")
            }
            _ => String::new(),
        };
        log::info!(
            "[move] offer: due {due}, from Settings {from_settings}{again}, in {:.2}s",
            asked.elapsed().as_secs_f64()
        );
        MoveOffer {
            due,
            from_settings,
            footprint_bytes,
        }
    })
    .await
    .unwrap_or(MoveOffer {
        due: false,
        from_settings: false,
        footprint_bytes: None,
    })
}

/**
What OpenBot's files take on this computer, for the move's first screen when `move_offer` answered
before the size was known: the size once it is measured, or None if it can't be, or if it takes
longer than `SIZING_CAP`. The screen says the move without it meanwhile.
*/
#[tauri::command]
pub async fn move_footprint<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Option<u64> {
    tauri::async_runtime::spawn_blocking(move || sized_within(&app, SIZING_CAP))
        .await
        .ok()
        .flatten()
}

/// Measure OpenBot's files on a thread of its own, once a run.
fn begin_sizing<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    {
        let mut sizing = state(app).sizing.lock().unwrap();
        if *sizing != Sizing::NotBegun {
            return;
        }
        *sizing = Sizing::Measuring;
    }
    let handle = app.clone();
    let begun = std::thread::Builder::new()
        .name("openbot-move-size".into())
        .spawn(move || {
            let started = std::time::Instant::now();
            let total = footprint(&handle);
            log::info!(
                "[move] sized OpenBot's files on this computer in {:.1}s: {}",
                started.elapsed().as_secs_f64(),
                total.map_or_else(
                    || "nothing measured".to_owned(),
                    |bytes| format!("{bytes} bytes")
                )
            );
            let moving = state(&handle);
            *moving.sizing.lock().unwrap() = Sizing::Done(total);
            moving.sized.notify_all();
        });
    if let Err(error) = begun {
        log::warn!("[move] couldn't begin sizing OpenBot's files: {error}");
        *state(app).sizing.lock().unwrap() = Sizing::Done(None);
        state(app).sized.notify_all();
    }
}

/// The size, if it is measured already.
fn sized_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<u64> {
    match *state(app).sizing.lock().unwrap() {
        Sizing::Done(total) => total,
        Sizing::NotBegun | Sizing::Measuring => None,
    }
}

/// The size, waiting for it up to `cap` and beginning it if it hasn't begun.
fn sized_within<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    cap: std::time::Duration,
) -> Option<u64> {
    begin_sizing(app);
    let moving = state(app);
    let (sizing, waited) = moving
        .sized
        .wait_timeout_while(moving.sizing.lock().unwrap(), cap, |sizing| {
            !matches!(sizing, Sizing::Done(_))
        })
        .unwrap();
    if waited.timed_out() {
        log::warn!(
            "[move] sizing OpenBot's files is still going after {}s; the move is offered without it",
            cap.as_secs()
        );
    }
    match *sizing {
        Sizing::Done(total) => total,
        Sizing::NotBegun | Sizing::Measuring => None,
    }
}

/// "Keep OpenBot (Self-Contained)": kept, and not asked again at launch, unless it followed a failed
/// move (`moving::record_kept`).
#[tauri::command]
pub async fn keep_self_contained<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), Problem> {
    let dir = config_dir(&app)
        .ok_or_else(|| Problem::plain("OpenBot couldn't save your choice on this computer."))?;
    let recorded = moving::record_kept(&dir, &release(&app)).map_err(|error| {
        Problem::with(
            "OpenBot couldn't save your choice on this computer. Try again.",
            error.to_string(),
        )
    })?;
    // Answered: the window shows OpenBot here next, and a restore may take it there.
    state(&app).on_screen.store(false, Ordering::SeqCst);
    match recorded.kept_after_failed_move_in {
        Some(_) => log::info!(
            "[move] the person keeps OpenBot (Self-Contained) after a failed move; offered again after the next update"
        ),
        None => log::info!("[move] the person keeps OpenBot (Self-Contained)"),
    }
    Ok(())
}

/**
A move that ran and didn't finish is kept on record (`moving::record_failed_move`), so a Keep chosen
after it brings the offer back after the next update. Only the move's own failures: a sign-in that
didn't finish (Cancel among them), a second move refused while one runs, or an app connected
elsewhere never started it.
*/
pub(crate) fn note_outcome<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    moved: &Result<moving::Moved, Problem>,
) {
    let Err(problem) = moved else { return };
    if !matches!(
        problem.kind,
        Some("move-failed" | "move-mismatch" | "move-stopped")
    ) {
        return;
    }
    let Some(dir) = config_dir(app) else { return };
    match moving::record_failed_move(&dir) {
        Ok(()) => log::info!("[move] a failed move is on record"),
        Err(error) => log::warn!("[move] could not keep the failed move on record: {error}"),
    }
}

/// What `move_preview` answers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovePreview {
    counts: Vec<moving::Count>,
    apps: Vec<moving::ReconnectApp>,
    footprint_bytes: Option<u64>,
    model_keys_available: bool,
}

/// What moves, which apps to connect again, and what the move frees, from the OpenBot here.
#[tauri::command]
pub async fn move_preview<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<MovePreview, Problem> {
    blocking(move || {
        let mut local = local_api(&app)?;
        let estimate = moving::Local::estimate(&mut local).map_err(|detail| {
            log::warn!("[move] could not read what would move: {detail}");
            Problem::with(
                "OpenBot couldn't read what's on this computer. Try again in a moment.",
                detail,
            )
        })?;
        // What the move removes, counted as the result counts it.
        let footprint_bytes = footprint(&app);
        Ok(MovePreview {
            counts: estimate.counts,
            apps: estimate.reconnect,
            footprint_bytes,
            model_keys_available: estimate.model_keys_available,
        })
    })
    .await
}

/// One step of the move, as the setup window draws it.
#[derive(Clone, Serialize)]
struct Step {
    stage: Stage,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<f64>,
}

struct Told<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> moving::Progress for Told<R> {
    fn running(&mut self, stage: Stage, progress: Option<f64>) {
        let _ = self.app.emit(
            PROGRESS_EVENT,
            Step {
                stage,
                state: "running",
                progress,
            },
        );
    }
    fn done(&mut self, stage: Stage) {
        log::info!("[move] {stage:?} done");
        let _ = self.app.emit(
            PROGRESS_EVENT,
            Step {
                stage,
                state: "done",
                progress: None,
            },
        );
    }
}

/// Sign in to OpenBot Cloud at `address`, then the move. See the module's documentation.
#[tauri::command]
pub async fn move_to_cloud<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    address: String,
    include_model_keys: Option<bool>,
) -> Result<moving::Moved, Problem> {
    if state(&app).running.swap(true, Ordering::SeqCst) {
        return Err(Problem::plain(
            "OpenBot is already moving to OpenBot Cloud.",
        ));
    }
    let asked = std::time::Instant::now();
    let forward = app.clone();
    let opened = std::sync::Arc::new(AtomicBool::new(false));
    let opening = opened.clone();
    let worker = app.clone();
    let moved = blocking(move || {
        move_now(
            &worker,
            &address,
            include_model_keys.unwrap_or(false),
            &opening,
        )
    })
    .await;
    // Moved, the app is connected to OpenBot Cloud and the result is the window's last move screen.
    // Not moved, the window stays on the move until the person tries again or keeps OpenBot here.
    if moved.is_ok() {
        state(&app).on_screen.store(false, Ordering::SeqCst);
    }
    state(&app).running.store(false, Ordering::SeqCst);
    openbot_desktop_lib::logging::outcome("move", asked, &moved);
    note_outcome(&app, &moved);
    crate::setup_again_after_move(&app);
    if opened.load(Ordering::SeqCst) {
        crate::bring_to_front(&forward, "the move to OpenBot Cloud signed in");
    }
    moved
}

fn move_now<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    address: &str,
    include_model_keys: bool,
    opened: &AtomicBool,
) -> Result<moving::Moved, Problem> {
    if crate::desktop_connected::is_connected(app) {
        return Err(Problem::plain(crate::desktop_connected::NOTHING_HERE));
    }
    let mut told = Told { app: app.clone() };
    moving::Progress::running(&mut told, Stage::SignIn, None);
    // A sign-in this run made for the move is used again by Try again. One kept from an earlier
    // run is not: it may predate the scopes the move needs, so the move signs in afresh.
    let kept = state(app)
        .signed_in
        .lock()
        .unwrap()
        .clone()
        .filter(|session| session.address() == address.trim_end_matches('/'));
    let session = match kept {
        Some(session) => session,
        None => {
            let session = crate::desktop_connected::sign_in_for_move(app, address, opened)
                .map_err(|mut problem| {
                    problem.kind = Some("sign-in");
                    problem
                })?;
            *state(app).signed_in.lock().unwrap() = Some(session.clone());
            session
        }
    };
    moving::Progress::done(&mut told, Stage::SignIn);

    let not_moved = |detail: String| {
        let mut problem = Problem::with(
            "OpenBot couldn't start the move. Nothing was removed from this computer. Try again.",
            detail,
        );
        problem.kind = Some("move-failed");
        problem
    };
    let mut local = local_api(app).map_err(|problem| {
        let mut problem = problem;
        problem.kind = Some("move-failed");
        problem
    })?;
    let mut cloud = moving::Api::open(
        session.address(),
        Box::new(SessionCredentials(session.clone())),
        moving::their_own_organization,
    )
    .map_err(not_moved)?;
    let mut here = ThisComputer {
        app: app.clone(),
        address: session.address().to_owned(),
        organization: cloud.organization().to_owned(),
        footprint: moving::Footprint::default(),
    };
    let source = source_name();
    let asked = moving::Asked {
        include_model_keys,
        source_name: &source,
        limits: moving::Limits::default(),
    };
    let mut moved =
        moving::run(&mut local, &mut cloud, &mut here, &asked, &mut told).map_err(|failure| {
            log::warn!("[move] {}: {}", failure.kind(), failure.detail());
            // OpenBot Cloud's own sentence is the whole of what it said: nothing to show beside it.
            let mut problem = match &failure {
                moving::Failure::Stopped { said } => Problem::plain(said.clone()),
                _ => Problem::with(failure.said(), failure.detail().to_owned()),
            };
            problem.kind = Some(failure.kind());
            problem
        })?;
    // The move has happened: whether OpenBot Cloud still needs the person's AI only decides what
    // the result leads with, so a question it can't answer is logged and never fails the move.
    moved.connect_ai = match cloud.needs_ai_connection() {
        Ok(needs) => {
            log::info!("[move] OpenBot Cloud needs the person's AI: {needs}");
            Some(needs)
        }
        Err(detail) => {
            log::warn!("[move] could not ask whether the person's AI is connected: {detail}");
            None
        }
    };
    // Which account and organization it went into, so the result says where everything is and as
    // whom to sign in there. Never fails the move either.
    moved.account = match cloud.account() {
        Ok(account) => {
            log::info!(
                "[move] moved into organization {} on {}",
                cloud.organization(),
                openbot_desktop_lib::connected::host_of(session.address())
            );
            Some(account)
        }
        Err(detail) => {
            log::warn!("[move] could not ask which account the move went into: {detail}");
            None
        }
    };
    Ok(moved)
}

/// Cancel while the browser sign-in waits.
#[tauri::command]
pub async fn cancel_move<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    crate::desktop_connected::cancel_sign_in(&app);
}

/// OpenBot Cloud in the window once the move is done: its home, or `path` (`/reconnect`, the
/// list of apps to reconnect, or `/reconnect/<app>`). A path the relay can't carry opens home.
#[tauri::command]
pub async fn open_moved_cloud<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: Option<String>,
) -> Result<(), Problem> {
    blocking(move || {
        let to = path.unwrap_or_else(|| "/".into());
        crate::desktop_connected::show_connected_at(&app, &to)
    })
    .await
}

/// Settings' "Move to OpenBot Cloud": the setup window, at the move, with OpenBot left running.
pub fn ask_from_settings<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    if !offered_in_settings(app) {
        return Err("Moving to OpenBot Cloud isn't available here.".into());
    }
    state(app).from_settings.store(true, Ordering::SeqCst);
    log::info!("[move] asked from Settings");
    crate::show_setup(app.clone())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Problem> + Send + 'static,
) -> Result<T, Problem> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| Problem::with("OpenBot couldn't do that. Try again.", error.to_string()))
        .and_then(|done| done)
}

/// The OpenBot running on this computer, as the move asks it: its server, with the install's token.
fn local_api<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<moving::Api, Problem> {
    let shell = app.state::<Shell>();
    let root = root(app);
    let ports = crate::ports_for_shell(app)?;
    let (_, address) = crate::owned_app(&shell, &root, &ports).ok_or_else(|| {
        Problem::plain(
            "OpenBot needs to be running on this computer to move. Start it, then try again.",
        )
    })?;
    let token = crate::install_token_for(&shell, &root, &address);
    moving::Api::at(
        &format!("http://127.0.0.1:{}", ports.server),
        Box::new(moving::InstallToken(token)),
        moving::THIS_COMPUTERS_ORGANIZATION,
    )
    .map_err(|detail| {
        log::warn!("[move] could not open the OpenBot here: {detail}");
        Problem::with(
            "OpenBot couldn't reach its server on this computer. Try again in a moment.",
            detail,
        )
    })
}

/// The OpenBot Cloud sign-in, as the move's requests carry it, and the question About asks of the
/// OpenBot the app is connected to (`desktop_connected::learn_account`).
pub(crate) struct SessionCredentials(
    pub(crate) std::sync::Arc<openbot_desktop_lib::connected::sign_in::Session>,
);

impl moving::Credentials for SessionCredentials {
    fn header(&self) -> Result<(&'static str, String), String> {
        let token = self.0.access().map_err(|problem| problem.said)?;
        Ok(("Authorization", format!("Bearer {token}")))
    }
    fn after_refused(&self, used: &str) -> Result<(&'static str, String), String> {
        let used = used.strip_prefix("Bearer ").unwrap_or(used);
        let token = self.0.after_refused(used).map_err(|problem| problem.said)?;
        Ok(("Authorization", format!("Bearer {token}")))
    }
}

/// What the import on OpenBot Cloud is called: this computer, by its name where the system says.
fn source_name() -> String {
    let name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty());
    match name {
        Some(name) => format!("OpenBot on {name}"),
        None => "OpenBot (Self-Contained)".to_owned(),
    }
}

/**
What OpenBot takes on this computer, as the move screens say it and the result counts it
(`parts`, measured by `moving::footprint`).
*/
fn footprint<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<u64> {
    #[cfg(test)]
    if let Some(delay) = *state(app).slow_sizing.lock().unwrap() {
        std::thread::sleep(delay);
    }
    let total = moving::footprint(&parts(app));
    (total > 0).then_some(total)
}

/**
OpenBot's own files on this computer, which the move removes: its installation folder's own files
and its downloads (`uninstall::installation_parts`), OpenBot's own Podman machine's disk when there
is one, which holds the containers, the database, the backend and the images, and Podman itself
when it goes with OpenBot (`own_podman`). On an engine that isn't OpenBot's own (Docker Desktop),
the images and volumes there are removed inside that engine's own disk, which OpenBot can't measure
from here, so they are not counted. Nor is the server's figure for its data (`storedBytes`): it is
in one of those, and counting it would promise space the result can't measure.
*/
fn parts<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<PathBuf> {
    let root = root(app);
    let mut parts = uninstall::installation_parts(&root, dirs::home_dir().as_deref());
    parts.extend(own_machine_disks());
    parts.extend(own_podman::parts(
        &mut own_podman::ThisComputer,
        &downloads(&root),
    ));
    parts
}

/// Where OpenBot ran Podman's installer from: the downloads folder of the installation at `root`,
/// and of the default one, which is where setup installs the engine from.
fn downloads(root: &Path) -> Vec<PathBuf> {
    vec![
        openbot_desktop_lib::acquire::download_dir(root),
        openbot_desktop_lib::acquire::download_dir(&stack::default_root()),
    ]
}

/// OpenBot's own Podman machine's disk images, from `podman machine inspect`, when it has one.
fn own_machine_disks() -> Vec<PathBuf> {
    let Some(podman) =
        openbot_desktop_lib::engine::program(openbot_desktop_lib::engine::Engine::Podman)
    else {
        return Vec::new();
    };
    let machine = openbot_desktop_lib::acquire::MACHINE;
    let output = openbot_desktop_lib::quiet::output_within(
        openbot_desktop_lib::quiet::command(podman).args(["machine", "inspect", machine]),
        std::time::Duration::from_secs(30),
    );
    // Where Podman keeps a machine's disk: its data folder, `~/.local/share` unless XDG says.
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| dirs::home_dir().map(|home| home.join(".local").join("share")));
    match output {
        Ok(output) if output.status.success() => moving::machine_disks(
            &String::from_utf8_lossy(&output.stdout),
            machine,
            data_home.as_deref(),
        ),
        _ => Vec::new(),
    }
}

/// This computer, for the move, once OpenBot Cloud has checked everything arrived.
struct ThisComputer<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
    address: String,
    organization: String,
    /// OpenBot's files as found before the removal, measured again after it.
    footprint: moving::Footprint,
}

impl<R: tauri::Runtime> moving::Here for ThisComputer<R> {
    fn footprint(&mut self) -> Option<u64> {
        let app = &self.app;
        self.footprint.measure(|| parts(app))
    }

    /// The disk the installation folder is on, which holds OpenBot's machine disk too wherever
    /// OpenBot put it (`<root>\engine` on Windows, the home folder on a Mac).
    fn free_space(&mut self) -> Option<u64> {
        openbot_desktop_lib::early_downloads::free_space(&root(&self.app))
    }

    /// Kept before anything goes: the answer, and the app connected to OpenBot Cloud from the
    /// next launch on, so a removal cut short never offers the move again.
    fn moved(&mut self) -> Result<(), String> {
        let dir = config_dir(&self.app).ok_or("the app has no configuration folder")?;
        moving::record_moved(&dir).map_err(|error| error.to_string())?;
        crate::desktop_connected::keep_moved_choice(&self.app, &self.address, &self.organization)
            .map_err(|problem| problem.detail.unwrap_or(problem.said))
    }

    /**
    OpenBot removed from this computer: stopped as Stop stops it, then everything the uninstaller's
    "Delete the application data" removes (`uninstall::stop_with`): the backend OpenBot created,
    OpenBot's volumes and images, OpenBot's own Podman machine, and its files and downloads. Then
    Podman itself, when OpenBot installed it and nothing else uses it (`own_podman`). Only
    OpenBot's own: the person's machines, containers, images and files stay.
    */
    fn remove(&mut self) -> Vec<String> {
        let root = root(&self.app);
        let mut left = Vec::new();
        if let Err(detail) = crate::stop_everything(&self.app, &root).into_result() {
            log::warn!("[move] OpenBot didn't stop cleanly before removal: {detail}");
        }
        left.extend(uninstall::stop_with(
            &mut crate::ThisComputerAtUninstall,
            &root,
            uninstall::Asked { delete_data: true },
            &mut |line| log::info!("[move] {line}"),
        ));
        left.extend(own_podman::remove(
            &mut own_podman::ThisComputer,
            &downloads(&root),
        ));
        forget_root(&self.app, &root);
        left
    }
}

/// The installation is gone: the shell no longer holds it, and the menus say so.
fn forget_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>, root: &Path) {
    let shell = app.state::<Shell>();
    *shell.containers.lock().unwrap() = None;
    if shell.root.lock().unwrap().as_deref() == Some(root) {
        *shell.root.lock().unwrap() = None;
    }
    crate::refresh_menus(app);
}
