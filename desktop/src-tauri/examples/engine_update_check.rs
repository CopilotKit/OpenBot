//! A dry run of the engine version check and the Docker Desktop update, on a real machine, that
//! changes nothing on it.
//!
//! ```text
//! cargo run --example engine_update_check
//!     Reads this machine's engine and says what OpenBot would do.
//! cargo run --example engine_update_check -- --as-docker-desktop-4.27.2 --cache <dir> [--download]
//!     Decides for Docker Desktop 4.27.2's real outputs, plans the update against Docker's live
//!     feed and, with --download, downloads the installer and checks its checksum and Docker's
//!     signature (mounted read-only, then detached). Never quits, installs or opens Docker.
//! ```

use std::path::PathBuf;

use openbot_desktop_lib::docker_desktop_update as update;
use openbot_desktop_lib::engine::{self, Engine};
use openbot_desktop_lib::engine_versions::{self, Verdict};

/// What Docker Desktop 4.27.2 (build 137060) says: its engine and `Platform.Name`, and its bundled
/// Compose plugin's `version --short`, captured from the official Docker.dmg.
const DESKTOP_4_27_2_VERSION: &str = "25.0.2|Docker Desktop 4.27.2 (137060)\n";
const DESKTOP_4_27_2_COMPOSE_SHORT: &str = "2.24.5-desktop.1\n";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().any(|arg| arg == name);
    let value = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|at| args.get(at + 1))
            .cloned()
    };
    let os = std::env::consts::OS;
    let arch = openbot_desktop_lib::windows::machine_arch();

    let (engine, readings) = if flag("--as-docker-desktop-4.27.2") {
        println!("engine: Docker Desktop 4.27.2 (its real outputs, not this machine's)");
        (
            Engine::Docker,
            engine_versions::docker_readings(DESKTOP_4_27_2_VERSION, DESKTOP_4_27_2_COMPOSE_SHORT),
        )
    } else {
        let status = engine::detect();
        let Some(address) = status.address.filter(|_| status.responding) else {
            println!("no engine answers here: {}", status.detail);
            return;
        };
        println!("engine: {:?} at {:?}", address.engine, address.connection);
        (address.engine, engine_versions::read(&address))
    };
    println!("read: {}", readings.said(engine));
    println!(
        "minimums: Compose {}, Docker Engine {}, Podman {} (Docker Desktop {} is the first to bundle that Compose)",
        engine_versions::COMPOSE,
        engine_versions::DOCKER_ENGINE,
        engine_versions::PODMAN,
        engine_versions::DOCKER_DESKTOP
    );
    let verdict = engine_versions::decide(engine, &readings, os, arch);
    println!("verdict on {os} {arch}: {verdict:?}");
    if verdict != Verdict::UpdateDockerDesktop {
        return;
    }

    let cache = value("--cache")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("openbot-engine-update-check"));
    let plan = match update::plan(&cache, os, arch) {
        Ok(plan) => plan,
        Err(problem) => {
            println!("plan stopped: {} ({:?})", problem.said, problem.detail);
            return;
        }
    };
    println!(
        "newest Docker Desktop: {} (build {}), needs {:?}",
        plan.release.version, plan.release.build, plan.release.minimum_os
    );
    println!("installer: {}", plan.release.download_url());
    println!("checksums: {}", plan.release.checksums_url());
    println!("downloads to: {}", plan.installer.display());
    let user = std::env::var("USER").ok();
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let per_user = openbot_desktop_lib::docker_desktop::installed_app()
        .is_some_and(|app| update::installed_per_user(&app, local.as_deref()));
    println!(
        "would quit Docker Desktop, then run: {} {}",
        if os == "macos" {
            "<mounted Docker.dmg>/Docker.app/Contents/MacOS/install (as administrator)"
        } else {
            "\"Docker Desktop Installer.exe\""
        },
        update::install_arguments(os, per_user, user.as_deref()).join(" ")
    );
    if !flag("--download") {
        return;
    }

    let mut last = String::new();
    if let Err(problem) = update::download(&plan, &mut |line| {
        if line.said != last {
            println!("  {}", line.said);
            last = line.said;
        }
    }) {
        println!("download stopped: {} ({:?})", problem.said, problem.detail);
        return;
    }
    println!("downloaded, and its sha256 matches Docker's checksums.txt");
    #[cfg(target_os = "macos")]
    match update::verify_mac(&plan.installer) {
        Ok(mounted) => {
            println!(
                "signature: codesign accepts {} and names Docker's team {}",
                mounted.app().display(),
                update::TEAM_ID
            );
            let help = std::process::Command::new(mounted.app().join("Contents/MacOS/install"))
                .arg("--help")
                .output();
            if let Ok(help) = help {
                let text = String::from_utf8_lossy(&help.stdout);
                for wanted in ["--user", "--accept-license"] {
                    println!(
                        "its install command offers {wanted}: {}",
                        text.contains(wanted)
                    );
                }
            }
            drop(mounted);
            println!("detached");
        }
        Err(problem) => println!(
            "signature check stopped: {} ({:?})",
            problem.said, problem.detail
        ),
    }
    #[cfg(target_os = "windows")]
    match update::verify_windows(&plan.installer) {
        Ok(()) => println!("signature: Authenticode valid, signed by Docker Inc"),
        Err(problem) => println!(
            "signature check stopped: {} ({:?})",
            problem.said, problem.detail
        ),
    }
}
