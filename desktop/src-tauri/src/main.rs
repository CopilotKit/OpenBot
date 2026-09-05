// A window, not a console. Release builds on Windows must not open one behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;

use openbot_desktop_lib::{acquire, engine, env as openbot_env, stack, windows as win};
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

    let gate = acquire::health_gate(engine::Engine::Podman.binary());
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
) -> Result<(), String> {
    let root = PathBuf::from(root);
    let status = engine::detect();
    let Some(found) = status.engine.filter(|_| status.responding) else {
        return Err(status.detail);
    };

    let settings = openbot_env::compose(
        &openbot_env::Intelligence {
            api_url,
            gateway_ws_url,
            api_key,
        },
        &status,
        &openbot_env::Ports::default(),
    );
    openbot_env::write(&root.join(".env"), &settings)
        .map_err(|e| format!("could not write .env: {e}"))?;
    report(&app, "env", true, ".env written");

    stack::up(found, &root)?;
    report(&app, "services", true, "containers up");

    stack::migrate(found, &root)?;
    report(&app, "migrate", true, "migrations applied");

    let logs = root.join(".logs");
    let bun = which_bun().ok_or("bun was not found, so the API server cannot be started")?;
    let shell = app.state::<Shell>();
    for process in stack::HOST_PROCESSES.iter() {
        let child = stack::spawn_host_process(process, &root, &logs, &bun)
            .map_err(|e| format!("could not start {}: {e}", process.name))?;
        shell.children.lock().unwrap().push(child);
        report(&app, process.name, true, "started");
    }
    *shell.root.lock().unwrap() = Some(root);
    Ok(())
}

/// Stop what this started, and only what this started.
///
/// A Bot's computer belongs to the supervisor rather than to Compose and is deliberately left
/// running: its files and browser profile are volumes, and killing it here would sign somebody out
/// of everything their Bot had logged into.
#[tauri::command]
fn stop_stack(app: tauri::AppHandle) -> Result<(), String> {
    let shell = app.state::<Shell>();
    for mut child in shell.children.lock().unwrap().drain(..) {
        let _ = child.kill();
        let _ = child.wait();
    }
    let root = shell.root.lock().unwrap().clone();
    if let (Some(root), Some(found)) = (root, engine::detect().engine) {
        stack::down(found, &root)?;
    }
    Ok(())
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![
            detect_engine,
            windows_blocker,
            windows_blocker_instruction,
            prepare_engine,
            start_stack,
            stop_stack,
            default_root,
        ])
        .run(tauri::generate_context!())
        .expect("the OpenBot window could not be created");
}
