/*!
The move from OpenBot (Self-Contained) to OpenBot Cloud, as the setup window and Settings ask it.

The work is in `openbot_desktop_lib::move_to_cloud`. This is the wiring:

- `move_offer`: whether the setup window shows the choice before it shows OpenBot (once per
  person, after the update, for OpenBot (Self-Contained) only), whether Settings sent it there,
  and how much OpenBot takes on this computer.
- `keep_self_contained`: "Keep OpenBot (Self-Contained)", never asked again at launch.
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
    /// The OpenBot Cloud sign-in this run made for the move, for Try again.
    signed_in:
        std::sync::Mutex<Option<std::sync::Arc<openbot_desktop_lib::connected::sign_in::Session>>>,
}

fn state<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> &State {
    &app.state::<Shell>().inner().moving
}

/// The folder `connection.json` is in, the same in a test (`desktop_connected::config_dir`).
fn config_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    crate::desktop_connected::config_dir(app)
}

fn answered<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<Answer> {
    config_dir(app).and_then(|dir| moving::answered(&dir))
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

/// The setup window's question before it shows OpenBot. `cloud` is its own switch: whether this
/// build offers OpenBot Cloud.
#[tauri::command]
pub async fn move_offer<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    cloud: Option<bool>,
) -> MoveOffer {
    let cloud = cloud.unwrap_or(false);
    state(&app).cloud.store(cloud, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let from_settings =
            state(&app).from_settings.swap(false, Ordering::SeqCst) && offered_in_settings(&app);
        let due = moving::due(
            cloud,
            crate::desktop_connected::is_connected(&app),
            installed_here(&app),
            answered(&app),
        );
        let footprint_bytes = (due || from_settings).then(|| footprint(&app)).flatten();
        log::info!("[move] offer: due {due}, from Settings {from_settings}");
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

/// "Keep OpenBot (Self-Contained)": kept, and never asked again at launch.
#[tauri::command]
pub async fn keep_self_contained<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), Problem> {
    let dir = config_dir(&app)
        .ok_or_else(|| Problem::plain("OpenBot couldn't save your choice on this computer."))?;
    moving::record(&dir, Answer::Kept).map_err(|error| {
        Problem::with(
            "OpenBot couldn't save your choice on this computer. Try again.",
            error.to_string(),
        )
    })?;
    log::info!("[move] the person keeps OpenBot (Self-Contained)");
    Ok(())
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
        // What the server keeps, or what this computer holds for all of OpenBot when that is more.
        let footprint_bytes = footprint(&app)
            .map(|here| here.max(estimate.stored_bytes))
            .or(Some(estimate.stored_bytes).filter(|bytes| *bytes > 0));
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
    state(&app).running.store(false, Ordering::SeqCst);
    openbot_desktop_lib::logging::outcome("move", asked, &moved);
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
    };
    let source = source_name();
    let asked = moving::Asked {
        include_model_keys,
        source_name: &source,
        limits: moving::Limits::default(),
    };
    moving::run(&mut local, &mut cloud, &mut here, &asked, &mut told).map_err(|failure| {
        log::warn!("[move] {}: {}", failure.kind(), failure.detail());
        let mut problem = Problem::with(failure.said(), failure.detail().to_owned());
        problem.kind = Some(failure.kind());
        problem
    })
}

/// Cancel while the browser sign-in waits.
#[tauri::command]
pub async fn cancel_move<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    crate::desktop_connected::cancel_sign_in(&app);
}

/// OpenBot Cloud in the window once the move is done: its home, or `path` (`/connections`).
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

/// The OpenBot Cloud sign-in, as the move's requests carry it.
struct SessionCredentials(std::sync::Arc<openbot_desktop_lib::connected::sign_in::Session>);

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
What OpenBot takes on this computer: its installation folder's own files and its downloads
(`uninstall::installation_parts`), and OpenBot's own Podman machine's disk when there is one, which
holds the containers, the database, the backend and the images. On an engine that isn't OpenBot's
own (Docker Desktop), the images and volumes there are not measured here: the server's own figure
for its data (`storedBytes`) stands in for them in the preview. Podman itself too, when it goes
with OpenBot (`own_podman`).
*/
fn footprint<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<u64> {
    let root = root(app);
    let mut parts = uninstall::installation_parts(&root, dirs::home_dir().as_deref());
    parts.extend(own_machine_disks());
    parts.extend(own_podman::parts(
        &mut own_podman::ThisComputer,
        &downloads(&root),
    ));
    let total = moving::footprint(&parts);
    (total > 0).then_some(total)
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
}

impl<R: tauri::Runtime> moving::Here for ThisComputer<R> {
    fn footprint(&mut self) -> Option<u64> {
        footprint(&self.app)
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
        moving::record(&dir, Answer::Moved).map_err(|error| error.to_string())?;
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
