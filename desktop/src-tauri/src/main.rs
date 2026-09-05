// A window, not a console. Release builds on Windows must not open one behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use openbot_desktop_lib::{acquire, deployment, engine, env as openbot_env, stack, windows as win};

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
    children: Mutex<Vec<std::process::Child>>,
    root: Mutex<Option<PathBuf>>,
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
    shell
        .children
        .lock()
        .unwrap()
        .extend(started.into_iter().map(|(_, child)| child));
    *shell.root.lock().unwrap() = Some(root);

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
    for mut child in shell.children.lock().unwrap().drain(..) {
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
    let window = app
        .get_webview_window("main")
        .ok_or("the OpenBot window is not there to show it in")?;
    window
        .navigate(
            url.parse()
                .map_err(|error| format!("{url} is not a URL: {error}"))?,
        )
        .map_err(|error| format!("could not show OpenBot: {error}"))
}

/// Put the setup screen back, when there is something to set up again.
#[tauri::command]
fn show_setup(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("the OpenBot window is not there")?;
    // Whatever this build serves its own interface from, dev server or bundle.
    let setup = if cfg!(debug_assertions) {
        "http://localhost:3020".to_string()
    } else {
        "tauri://localhost".to_string()
    };
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

#[tauri::command]
fn default_root() -> String {
    stack::default_root().to_string_lossy().into_owned()
}

/// `bun` from PATH, or the places an installer puts it when PATH has not been reloaded.
fn which_bun() -> Option<PathBuf> {
    if std::process::Command::new("bun")
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
            default_root,
        ])
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
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_whichever_applies(app),
                    // Stop without quitting: the stack is what costs something to leave running,
                    // and somebody who wants it stopped does not necessarily want the icon gone.
                    "stop" => {
                        let app = app.clone();
                        std::thread::spawn(move || {
                            let root = default_root();
                            let _ = stop_everything(&app, &PathBuf::from(root));
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.eval("window.location.reload()");
                            }
                        });
                    }
                    // Exit rather than hide: quitting from the tray is a decision to stop, and the
                    // exit handler below is what stops the processes with it.
                    "quit" => app.exit(0),
                    _ => {}
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
                    let mut children = shell.children.lock().unwrap();
                    for child in children.iter_mut() {
                        ask_to_stop(child);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    for child in children.iter_mut() {
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
