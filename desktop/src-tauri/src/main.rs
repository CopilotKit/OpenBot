// A window, not a console. Release builds on Windows must not open one behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use openbot_desktop_lib::{
    acquire, deployment, engine, env as openbot_env, quiet, stack, supervise, windows as win,
};

/// The deployment this app installs.
///
/// Pinned rather than "latest": the images a release runs are pinned per release, so the tree that
/// names them has to be too, and an app that fetches whatever shipped this morning is not a version
/// anybody can be given. Moved deliberately, with the app.
const DEPLOYMENT_VERSION: &str = "v0.0.7";
use serde::Serialize;
use tauri::{Emitter, Manager};

/// What the shell is running, so the window and the tray say the same thing.
#[derive(Default)]
struct Shell {
    /// Named, because a restart policy that cannot say which process died cannot start it again.
    children: Mutex<Vec<(&'static str, std::process::Child)>>,
    /// Which run is the current one.
    ///
    /// Stopping and starting again inside two seconds would otherwise leave the previous watcher
    /// alive beside the new one, both answering the same death, and a process restarted twice is
    /// one process and one orphan holding a port.
    generation: std::sync::atomic::AtomicU64,
    /// Why the stack stopped, kept for the screen that has not loaded yet.
    ///
    /// Going back to the setup screen is a navigation, and a navigation is a fresh page: React
    /// remounts with no progress and the sentence explaining what happened is lost at the one
    /// moment it is worth reading. Held here instead, and asked for on load.
    last_failure: Mutex<Option<String>>,
    root: Mutex<Option<PathBuf>>,
    /// Where the shell's own interface lives, read from the window rather than spelled out.
    ///
    /// Tauri does not serve the bundle from the same address on every platform: macOS and Linux
    /// get `tauri://localhost`, Windows gets `http://tauri.localhost`. Spelling one of them into
    /// the code means Stop leaves Windows staring at a page whose servers have just been killed,
    /// which is what it did. The window knows its own address, so it is asked once and kept.
    setup_url: Mutex<Option<String>>,
}

#[derive(Serialize, Clone)]
struct Progress {
    step: String,
    ok: bool,
    detail: String,
}

fn report(app: &tauri::AppHandle, step: &str, ok: bool, detail: impl Into<String>) {
    let _ = app.emit(
        "setup:progress",
        Progress {
            step: step.into(),
            ok,
            detail: detail.into(),
        },
    );
}

#[tauri::command]
fn detect_engine() -> engine::EngineStatus {
    engine::detect()
}

#[tauri::command]
fn windows_blocker() -> Option<win::Blocker> {
    win::blocker()
}

#[tauri::command]
fn windows_blocker_instruction(blocker: win::Blocker) -> String {
    blocker.instruction().to_string()
}

/// Bring the engine up: create the machine if it is missing, start it, then prove it answers.
///
/// Reported step by step rather than as one result, because these take minutes and a window with
/// nothing moving in it reads as a hang.
#[tauri::command]
async fn prepare_engine(app: tauri::AppHandle) -> Result<engine::EngineStatus, String> {
    let found = engine::detect();
    if found.responding {
        report(&app, "engine", true, found.detail.clone());
        return Ok(found);
    }

    let created = acquire::create_machine(4, 6144, 60);
    report(&app, "create-machine", created.ok, created.detail.clone());
    if !created.ok {
        return Err(created.detail);
    }

    let started = acquire::start_machine();
    report(&app, "start-machine", started.ok, started.detail.clone());
    if !started.ok {
        return Err(started.detail);
    }

    let gate = acquire::health_gate(&acquire::address());
    report(&app, "health-gate", gate.ok, gate.detail.clone());
    if !gate.ok {
        return Err(gate.detail);
    }

    Ok(engine::detect())
}

/// Write the `.env`, raise the containers, migrate, then start the three host processes.
#[tauri::command]
async fn start_stack(
    app: tauri::AppHandle,
    root: String,
    api_url: String,
    gateway_ws_url: String,
    api_key: String,
    openai_api_key: String,
) -> Result<(), String> {
    let root = PathBuf::from(root);

    // The installer does not carry the deployment; it fetches one. Skipped when the recorded
    // version already matches, so a restart is not a download.
    if deployment::needs_fetch(&root, DEPLOYMENT_VERSION) {
        report(
            &app,
            "deployment",
            true,
            format!("fetching {DEPLOYMENT_VERSION}"),
        );
        // On a blocking thread, not this one. A blocking HTTP client builds its own runtime, and
        // dropping one inside an async context panics the worker rather than returning an error:
        // "Cannot drop a runtime in a context where blocking is not allowed". The window survives
        // that, which is worse than a crash, because the only symptom is a step that never ends.
        let target = root.clone();
        tauri::async_runtime::spawn_blocking(move || {
            deployment::fetch(&target, DEPLOYMENT_VERSION)
        })
        .await
        .map_err(|error| format!("the download did not run: {error}"))?
        .inspect_err(|error| {
            report(&app, "deployment", false, error.clone());
        })?;
    }
    report(
        &app,
        "deployment",
        true,
        format!("{DEPLOYMENT_VERSION} in {}", root.display()),
    );

    // Belt and braces: a fetch that reported success and left something out is still not a
    // deployment, and Compose's own error would not say which part was missing.
    if let Some(problem) = stack::deployment_problem(&root) {
        report(&app, "deployment", false, problem.clone());
        return Err(problem);
    }

    let status = engine::detect();
    let Some(found) = status.address.clone().filter(|_| status.responding) else {
        return Err(status.detail);
    };

    // Checked here as well as in the health gate, because the gate only runs when an engine had to
    // be installed. A machine that already had Podman skips all of that and arrives at Compose,
    // which is exactly the machine this was found on.
    if !found.composes() {
        let problem = acquire::missing_compose(found.engine.binary());
        report(&app, "engine", false, problem.clone());
        return Err(problem);
    }

    let settings = openbot_env::compose(
        &openbot_env::Intelligence {
            api_url,
            gateway_ws_url,
            api_key,
        },
        &openbot_env::Model { openai_api_key },
        &status,
        &openbot_env::Ports::default(),
        &deployment::image_variables(&root)?,
    );
    openbot_env::write(&root.join(".env"), &settings)
        .map_err(|e| format!("could not write .env: {e}"))?;
    report(&app, "env", true, ".env written");

    // Said before rather than after. On a machine that has never run OpenBot this pulls five
    // images, and a person watching a button that says "Working" has no way to tell a download
    // from a hang.
    report(
        &app,
        "services",
        true,
        "pulling images and starting containers",
    );
    stack::up(&found, &root)?;
    report(&app, "services", true, "containers up");

    report(&app, "migrate", true, "applying migrations");
    stack::migrate(&found, &root)?;
    report(&app, "migrate", true, "migrations applied");

    // `compose up` succeeds once it has asked for everything. A service that then exits is not its
    // problem, and both Bots exit immediately without a model key. Reported rather than passed
    // over, or the window shows a healthy stack while nothing can answer a question.
    for (name, why) in stack::services_that_exited(&found, &root) {
        report(&app, "services", false, format!("{name} stopped: {why}"));
    }

    // Before spawning: if these are already held, whatever answers later is not ours.
    let ports = openbot_env::Ports::default();
    if let Some(problem) =
        stack::port_already_taken(&[("API server", ports.server), ("app", ports.app)])
    {
        report(&app, "ports", false, problem.clone());
        return Err(problem);
    }

    let logs = root.join(".logs");
    let bun = which_bun().ok_or("bun was not found, so the API server cannot be started")?;

    // The source alone will not run: without this the server stops at a package it cannot resolve
    // and the app at a missing `vite`, neither of which mentions dependencies.
    report(&app, "dependencies", true, "installing");
    {
        let target = root.clone();
        let bun = bun.clone();
        tauri::async_runtime::spawn_blocking(move || stack::install_dependencies(&target, &bun))
            .await
            .map_err(|error| format!("the install did not run: {error}"))?
            .inspect_err(|error| report(&app, "dependencies", false, error.clone()))?;
    }
    report(&app, "dependencies", true, "installed");

    let mut started = Vec::new();
    for process in stack::HOST_PROCESSES.iter() {
        let child = stack::spawn_host_process(process, &root, &logs, &bun)
            .map_err(|e| format!("could not start {}: {e}", process.name))?;
        started.push((process.name, child));
        report(&app, process.name, true, "started");
    }

    // Spawning is not starting. Nothing is called running until the API answers.
    let logs_for_wait = logs.clone();
    let (outcome, started) = tauri::async_runtime::spawn_blocking(move || {
        let mut started = started;
        let outcome = stack::wait_until_answering(
            &mut started,
            &logs_for_wait,
            &stack::Ready {
                api: openbot_env::Ports::default().server,
                app: openbot_env::Ports::default().app,
            },
            std::time::Duration::from_secs(180),
        );
        (outcome, started)
    })
    .await
    .map_err(|error| format!("the wait did not run: {error}"))?;

    let shell = app.state::<Shell>();
    shell.children.lock().unwrap().extend(started);
    *shell.root.lock().unwrap() = Some(root.clone());

    // From here the shell is the restart policy `worker/src/index.ts` says it does not have.
    let generation = shell
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    supervise_host_processes(app.clone(), root, logs, bun, generation);

    outcome.inspect_err(|error| report(&app, "answering", false, error.clone()))?;
    report(&app, "answering", true, "the API and the app are answering");
    Ok(())
}

/// Stop what this started, and only what this started.
///
/// A Bot's computer belongs to the supervisor rather than to Compose and is deliberately left
/// running: its files and browser profile are volumes, and killing it here would sign somebody out
/// of everything their Bot had logged into.
#[tauri::command]
fn stop_stack(app: tauri::AppHandle, root: String) -> Result<(), String> {
    stop_everything(&app, &PathBuf::from(&root))
}

/// Take the whole stack down: the host processes, anything left over, and the containers.
///
/// One implementation, because there are three ways to ask for it (the button, the menu bar, and
/// quitting) and a person who used one of them and got a different amount of stopping would be
/// right to call that a bug.
fn stop_everything(app: &tauri::AppHandle, fallback_root: &Path) -> Result<(), String> {
    let shell = app.state::<Shell>();
    // Ended first, so the watcher stops before anything is killed and does not read a death it
    // caused as one worth answering.
    shell
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    *shell.root.lock().unwrap() = None;
    for (_, mut child) in shell.children.lock().unwrap().drain(..) {
        let _ = child.kill();
        let _ = child.wait();
    }

    // The window may be a second one, holding no handles to a stack that is still up. Stop what is
    // there rather than only what this window started, or Stop is a button that does nothing and
    // reports success.
    let root = shell
        .root
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| fallback_root.to_path_buf());
    stack::stop_processes_under(&root);

    let outcome = match engine::detect().address {
        Some(found) => stack::down(&found, &root),
        None => Ok(()),
    };
    *shell.root.lock().unwrap() = None;
    outcome
}

/// Show OpenBot itself in this window.
///
/// The point of a desktop application is that it is the application. A window that sets things up
/// and then sends somebody to a browser tab is a launcher, and nobody wanted a launcher: they
/// double-clicked OpenBot to get OpenBot.
///
/// So the window navigates to the running app, and the tray keeps the controls that would otherwise
/// have nowhere to live. Setup comes back if the stack is stopped, because then there is something
/// to set up again.
///
/// `localhost` rather than an address, against the rule the rest of this file follows: the app's
/// dev server binds `[::1]` and not `127.0.0.1`, so naming either one guesses wrong half the time.
/// Every spelling of it is trusted, so whichever it bound is the right one.
#[tauri::command]
fn show_openbot(app: tauri::AppHandle) -> Result<(), String> {
    let port = openbot_env::Ports::default().app;
    // Where it answered, not where it was asked to listen. A dev server binds whichever loopback
    // its runtime resolved `localhost` to, and navigating to the other one shows a blank window
    // that looks like the app failing to start.
    let url = stack::app_url(port).ok_or_else(|| {
        format!("OpenBot is not answering on port {port} yet, so there is nothing to show.")
    })?;
    eprintln!("[show] navigating the window to {url}");
    let window = app
        .get_webview_window("main")
        .ok_or("the OpenBot window is not there to show it in")?;
    let outcome = window
        .navigate(
            url.parse()
                .map_err(|error| format!("{url} is not a URL: {error}"))?,
        )
        .map_err(|error| format!("could not show OpenBot: {error}"));
    eprintln!("[show] navigate returned {outcome:?}");
    outcome
}

/// Put the setup screen back, when there is something to set up again.
#[tauri::command]
fn show_setup(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("the OpenBot window is not there")?;
    // Whatever this build serves its own interface from, recorded at startup from the window
    // itself. The dev server is the fallback because in development that is where it starts.
    let setup = app
        .state::<Shell>()
        .setup_url
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| "http://localhost:3020".to_string());
    window
        .navigate(
            setup
                .parse()
                .map_err(|error| format!("{setup} is not a URL: {error}"))?,
        )
        .map_err(|error| format!("could not go back to setup: {error}"))
}

/// Is a deployment this app manages already running?
///
/// The shell keeps what it started in memory, so closing the window and opening it again forgets a
/// stack that is still up. Without asking, the second launch offers to set up something already
/// running, and the port check then reports OpenBot as a foreign process holding its own port.
///
/// Asked of the deployment rather than of a file: a stamp says a deployment was installed, and only
/// an answer on the port says one is running now.
#[tauri::command]
fn already_running(root: String) -> bool {
    let root = PathBuf::from(&root);
    if deployment::installed(&root).is_none() {
        return false;
    }
    let port = openbot_env::Ports::default().server;
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .ok()
        .and_then(|client| {
            client
                .get(format!("http://127.0.0.1:{port}/api/capabilities"))
                .send()
                .ok()
        })
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

/// What stopped the stack, if anything did, and forget it once it has been read.
///
/// Cleared on reading so a failure from an hour ago does not greet somebody who has since fixed it.
#[tauri::command]
fn last_failure(app: tauri::AppHandle) -> Option<String> {
    app.state::<Shell>().last_failure.lock().unwrap().take()
}

#[tauri::command]
fn default_root() -> String {
    stack::default_root().to_string_lossy().into_owned()
}

/// `bun` from PATH, or the places an installer puts it when PATH has not been reloaded.
fn which_bun() -> Option<PathBuf> {
    if quiet::command("bun")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Some(PathBuf::from("bun"));
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let candidates = [
        PathBuf::from(&home).join(".bun/bin/bun"),
        PathBuf::from(&home).join(".bun/bin/bun.exe"),
    ];
    candidates.into_iter().find(|path| path.exists())
}

/// Watch the three host processes and start one again when it dies.
///
/// The policy is in `supervise.rs`; this is the loop that applies it. It ends when the stack is
/// stopped, which is what clearing the root means, so stopping does not race a restart.
fn supervise_host_processes(
    app: tauri::AppHandle,
    root: PathBuf,
    logs: PathBuf,
    bun: PathBuf,
    generation: u64,
) {
    std::thread::spawn(move || {
        eprintln!(
            "[watch] supervising {} host processes",
            stack::HOST_PROCESSES.len()
        );
        let mut watches: Vec<supervise::Watch> = stack::HOST_PROCESSES
            .iter()
            .map(|process| supervise::Watch::new(process.name))
            .collect();

        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let shell = app.state::<Shell>();
            // Not this run's any more, or no run at all.
            if shell.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
                || shell.root.lock().unwrap().is_none()
            {
                return;
            }

            // Which ones have died. Collected rather than acted on under the lock, because a
            // restart waits, and waiting while holding the children is how Stop would block on a
            // backoff nobody asked it to sit through.
            let dead: Vec<&'static str> = {
                let mut children = shell.children.lock().unwrap();
                let mut dead = Vec::new();
                for (name, child) in children.iter_mut() {
                    if let Ok(Some(_)) = child.try_wait() {
                        dead.push(*name);
                    }
                }
                dead
            };

            if !dead.is_empty() {
                eprintln!("[watch] dead: {dead:?}");
            }
            for name in dead {
                let Some(watch) = watches.iter_mut().find(|watch| watch.name == name) else {
                    continue;
                };
                if !watch.should_restart(std::time::Instant::now()) {
                    // Let go of it. A dead child left in the list is found dead again two seconds
                    // later, and forever after: the count climbs past what actually happened, the
                    // window is sent back to the setup screen on a loop, and the giving up that was
                    // supposed to stop a hot laptop becomes one.
                    shell
                        .children
                        .lock()
                        .unwrap()
                        .retain(|(held, _)| *held != name);

                    let reason = watch.gave_up();
                    report(&app, name, false, reason.clone());
                    *shell.last_failure.lock().unwrap() = Some(reason);
                    // Back to the setup screen. By now the window is showing OpenBot, and OpenBot
                    // is not running: leaving it there is a window that lies.
                    let _ = show_setup(app.clone());
                    continue;
                }
                report(
                    &app,
                    name,
                    false,
                    format!("{name} stopped. Starting it again."),
                );
                std::thread::sleep(supervise::backoff(watch.restarts - 1));

                // Asked again after the backoff: a stop, or another start, may have happened while
                // this was waiting, and starting a process into either is how an orphan is made.
                if shell.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
                    || shell.root.lock().unwrap().is_none()
                {
                    return;
                }
                let Some(process) = stack::HOST_PROCESSES
                    .iter()
                    .find(|process| process.name == name)
                else {
                    continue;
                };
                match stack::spawn_host_process(process, &root, &logs, &bun) {
                    Ok(child) => {
                        let mut children = shell.children.lock().unwrap();
                        children.retain(|(held, _)| *held != name);
                        children.push((name, child));
                        report(&app, name, true, "started again");
                    }
                    Err(error) => report(
                        &app,
                        name,
                        false,
                        format!("{name} would not start: {error}"),
                    ),
                }
            }
        }
    });
}

/// Point the window at OpenBot if it is up, and at the setup screen if it is not.
///
/// Used by the tray and by a second launch, both of which happen at moments when the caller has no
/// idea which of the two the person should be looking at.
fn show_whichever_applies(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Some(url) = stack::app_url(openbot_env::Ports::default().app) {
        if let Ok(parsed) = url.parse() {
            let _ = window.navigate(parsed);
        }
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn main() {
    tauri::Builder::default()
        // A second launch is somebody looking for the window they already have, not a request for a
        // second stack. Without this both copies bind the same ports and the loser reports a
        // failure that belongs to the winner.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_whichever_applies(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![
            detect_engine,
            windows_blocker,
            windows_blocker_instruction,
            prepare_engine,
            start_stack,
            stop_stack,
            show_openbot,
            show_setup,
            already_running,
            last_failure,
            default_root,
        ])
        // A packaged application is not a browser tab. Left alone, WebView2 answers a right-click
        // with Back, Refresh, Save as and Print: Back walks the window out of OpenBot with nothing
        // to walk it home, and Save as offers to write the page to disk as `Webpage, complete`.
        // macOS never showed this because Tauri suppresses it there in release builds; Windows has
        // no such setting, and Tauri has no configuration option for it either, so the page is
        // asked to refuse. Every navigation, because the window navigates to OpenBot and back.
        .on_page_load(|window, _| {
            let _ = window
                .eval("document.addEventListener('contextmenu', e => e.preventDefault(), true)");
        })
        // Closing the window hides it. A tray application whose window is destroyed on close has a
        // menu item that points at nothing: `get_webview_window` returns None from then on, and the
        // only way back is to quit and start again, with a stack still running that nothing on
        // screen can reach.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                // Asked before anything navigates away from it.
                *app.state::<Shell>().setup_url.lock().unwrap() = Some(window.url()?.to_string());
            }

            // The menu bar the window's own text refers to. Two items, because there are two things
            // somebody wants from a status icon: get to it, or stop it.
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;

            let open = MenuItem::with_id(app, "open", "Open OpenBot", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop OpenBot", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &stop, &quit])?;

            TrayIconBuilder::with_id("openbot")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .tooltip("OpenBot")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "open" => show_whichever_applies(app),
                        // Stop without quitting: the stack is what costs something to leave running,
                        // and somebody who wants it stopped does not necessarily want the icon gone.
                        "stop" => {
                            let app = app.clone();
                            std::thread::spawn(move || {
                                let root = default_root();
                                eprintln!("[tray] stopping the stack under {root}");
                                match stop_everything(&app, &PathBuf::from(root)) {
                                    Ok(()) => {
                                        eprintln!("[tray] stopped");
                                        report(&app, "stopped", true, "OpenBot has been stopped");
                                    }
                                    // Said rather than swallowed. A menu item that fails silently is
                                    // worse than one that is not there: the person believes the stack
                                    // is down and it is not.
                                    Err(problem) => {
                                        eprintln!("[tray] stop failed: {problem}");
                                        report(&app, "stopped", false, problem);
                                    }
                                }
                                let _ = show_setup(app.clone());
                            });
                        }
                        // Exit rather than hide: quitting from the tray is a decision to stop, and the
                        // exit handler below is what stops the processes with it.
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the OpenBot window could not be created")
        .run(|app, event| {
            // Nothing this started may outlive it.
            //
            // A child that survives the window is the failure Tauri has a standing issue about: an
            // orphaned server keeps port 3001, the next launch cannot bind it, and nothing on
            // screen says why. Asked to stop first, then made to, because a server given a moment
            // closes its database connections and one that is shot does not.
            // `Exit` only. `ExitRequested` fires first and for the same quit, and running this
            // twice means a second SIGTERM to a process that has already gone and another wait
            // nobody is watching.
            if matches!(event, tauri::RunEvent::Exit) {
                let shell = app.state::<Shell>();
                {
                    *shell.root.lock().unwrap() = None;
                    let mut children = shell.children.lock().unwrap();
                    for (_, child) in children.iter_mut() {
                        ask_to_stop(child);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    for (_, child) in children.iter_mut() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    children.clear();
                }

                // The containers too. Leaving five of them running behind an application that is
                // no longer on screen is the one outcome nobody can act on: there is no window to
                // stop them from and nothing to say they are there.
                let root = shell
                    .root
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| PathBuf::from(default_root()));
                stack::stop_processes_under(&root);
                if let Some(found) = engine::detect().address {
                    let _ = stack::down(&found, &root);
                }
            }
        });
}

/// Ask a child to stop, rather than shooting it.
///
/// On Unix that is SIGTERM, which the runtime turns into an ordinary shutdown. Windows has no
/// equivalent for a process without a console, so there it is the same as being killed; the wait
/// below is what gives a well-behaved process its moment either way.
fn ask_to_stop(child: &std::process::Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    #[cfg(not(unix))]
    let _ = child;
}
