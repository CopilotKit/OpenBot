//! Docker Desktop: started when it is installed, installed when it is not.
//!
//! Docker is the engine OpenBot runs on, and the only one local Intelligence accepts. A Mac or a
//! Windows machine with Docker Desktop installed but not running is not a machine without an engine:
//! starting it is the repair, not installing a second engine beside it. A machine without it gets
//! Docker's own installer.
//!
//! **Podman is never chosen for somebody.** It is for an organization that cannot use Docker
//! Desktop under its licence, and that is a decision a person makes, not a fallback the app takes
//! because Docker happened to be stopped. A Podman somebody already runs is still used (see
//! `install::install_engine_with`); one is never installed in Docker's place.
//!
//! **Docker's terms are accepted by the person, in Docker's own window.** The installer is run
//! without `--accept-license`, so the first start shows Docker's subscription agreement and its
//! privileged-helper prompt, and the wait below allows for somebody reading them.
//!
//! Linux is not handled here: Docker there is the distribution's Docker Engine, not Docker Desktop.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::engine::{self, Engine};
use crate::install::Download;
use crate::problem::Problem;

/// The release whose installers are pinned below, and Docker's build number for it.
///
/// Pinned for the reason every other download is: these files are executed. The digests come from
/// the `checksums.txt` Docker publishes beside each build, recorded here rather than fetched, since a
/// checksum from the server that served the file proves nothing. Moving the version means
/// re-recording all three.
pub const DOCKER_DESKTOP: &str = "4.96.3";
const BUILD: &str = "244472";

/// How long a Docker Desktop that was already installed gets to start answering.
const START_PATIENCE: Duration = Duration::from_secs(180);
/// How long a first start gets: it shows Docker's terms and a helper prompt, which somebody reads.
const FIRST_START_PATIENCE: Duration = Duration::from_secs(15 * 60);
const POLL: Duration = Duration::from_secs(2);

/// Docker Desktop's installer for this machine, or why there is not one.
pub fn download() -> Result<Download, Problem> {
    download_for(std::env::consts::OS, std::env::consts::ARCH)
}

fn download_for(os: &str, arch: &str) -> Result<Download, Problem> {
    let (path, file, sha256) =
        match (os, arch) {
            ("macos", "aarch64") => (
                "mac/main/arm64",
                "Docker.dmg",
                "a3ac78b7de67af169ca58f33a4fa4c26007840870574c80c59a7ab0c7f68d954",
            ),
            ("macos", "x86_64") => (
                "mac/main/amd64",
                "Docker.dmg",
                "9d3409c689628d4f42972e4773a700817ff3526b1810a30a8de33fc1379e016b",
            ),
            ("windows", "x86_64") => (
                "win/main/amd64",
                "Docker Desktop Installer.exe",
                "3d8adad4f6c86583e0b00ea19a76197c51ccf5c83437c9ed775b739756452507",
            ),
            (os, arch) => return Err(Problem::with(
                "OpenBot cannot install Docker Desktop on this kind of computer. Install Docker, \
                 then start OpenBot again.",
                format!("no Docker Desktop {DOCKER_DESKTOP} installer for {os} on {arch}"),
            )),
        };
    Ok(Download {
        url: format!(
            "https://desktop.docker.com/{path}/{BUILD}/{}",
            file.replace(' ', "%20")
        ),
        sha256,
        file,
    })
}

/// Where Docker Desktop is installed on this machine, if it is.
pub fn installed_app() -> Option<PathBuf> {
    installed_app_in(&app_places())
}

fn installed_app_in(places: &[PathBuf]) -> Option<PathBuf> {
    places.iter().find(|place| place.exists()).cloned()
}

fn app_places() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut places = vec![PathBuf::from("/Applications/Docker.app")];
        if let Some(home) = std::env::var_os("HOME") {
            places.push(PathBuf::from(home).join("Applications/Docker.app"));
        }
        places
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("ProgramFiles")
            .map(|files| PathBuf::from(files).join("Docker\\Docker\\Docker Desktop.exe"))
            .into_iter()
            .collect()
    }
    #[cfg(target_os = "linux")]
    {
        Vec::new()
    }
}

/// Whether Docker answers now.
pub fn answers() -> bool {
    engine::Address::new(Engine::Docker, None).responds()
}

/// Downloads and installs Docker Desktop, saying how it is going.
type Install<'a> = &'a mut dyn FnMut(&mut dyn FnMut(Progress)) -> Result<(), Problem>;

/// What `ensure` needs from the machine, so its decisions can be tested without one.
pub(crate) struct Machine<'a> {
    pub installed: &'a dyn Fn() -> bool,
    pub answers: &'a dyn Fn() -> bool,
    pub install: Install<'a>,
    pub open: &'a dyn Fn() -> Result<(), Problem>,
    pub sleep: &'a dyn Fn(Duration),
    pub now: &'a dyn Fn() -> Instant,
}

/// One line for the setup screen's step row, with download progress when there is some.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub said: String,
    pub downloaded: Option<u64>,
}

impl Progress {
    fn said(said: impl Into<String>) -> Self {
        Self {
            said: said.into(),
            downloaded: None,
        }
    }
}

/// What `ensure` did, for the step row and for telemetry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ensured {
    pub said: String,
    /// True when Docker Desktop was installed by this call.
    pub installed: bool,
}

/// Docker answering, by starting it or installing and starting it. See the module comment.
pub fn ensure(cache: &Path, progress: &mut dyn FnMut(Progress)) -> Result<Ensured, Problem> {
    let into = crate::acquire::download_dir(cache);
    ensure_with(
        &mut Machine {
            installed: &|| installed_app().is_some(),
            answers: &answers,
            install: &mut |progress| install(&into, progress),
            open: &open,
            sleep: &std::thread::sleep,
            now: &Instant::now,
        },
        progress,
    )
}

pub(crate) fn ensure_with(
    machine: &mut Machine,
    progress: &mut dyn FnMut(Progress),
) -> Result<Ensured, Problem> {
    if (machine.answers)() {
        return Ok(Ensured {
            said: "Docker Desktop is running.".into(),
            installed: false,
        });
    }
    let fresh = !(machine.installed)();
    if fresh {
        (machine.install)(progress)?;
    }
    progress(Progress::said(if fresh {
        "Starting Docker Desktop. Accept its terms in its own window when it asks."
    } else {
        "Starting Docker Desktop."
    }));
    (machine.open)()?;

    let patience = if fresh {
        FIRST_START_PATIENCE
    } else {
        START_PATIENCE
    };
    let started = (machine.now)();
    while (machine.now)().duration_since(started) < patience {
        if (machine.answers)() {
            return Ok(Ensured {
                said: if fresh {
                    format!("Docker Desktop {DOCKER_DESKTOP} installed and running.")
                } else {
                    "Docker Desktop is running.".into()
                },
                installed: fresh,
            });
        }
        (machine.sleep)(POLL);
    }
    Err(Problem::with(
        "Docker Desktop did not start. Open Docker Desktop, finish anything it asks for, then try \
         again.",
        format!(
            "Docker did not answer within {}s of opening Docker Desktop",
            patience.as_secs()
        ),
    ))
}

/// Open Docker Desktop the way the person would.
fn open() -> Result<(), Problem> {
    let Some(app) = installed_app() else {
        return Err(Problem::plain(
            "OpenBot cannot find Docker Desktop. Install it, then try again.",
        ));
    };
    #[cfg(target_os = "macos")]
    let spawned = crate::quiet::command("open").arg("-a").arg(&app).status();
    // Starting Docker Desktop's own executable is the whole job, so a started process counts as
    // success and its exit is not waited for. The status is named: `Default::default()` here left
    // the type to inference, which had nothing to go on, and failed to compile off macOS.
    #[cfg(not(target_os = "macos"))]
    let spawned = crate::quiet::command(&app)
        .spawn()
        .map(|_| std::process::ExitStatus::default());
    match spawned {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(Problem::with(
            "OpenBot could not open Docker Desktop. Open it yourself, then try again.",
            format!("opening {} ended with {status}", app.display()),
        )),
        Err(error) => Err(Problem::with(
            "OpenBot could not open Docker Desktop. Open it yourself, then try again.",
            format!("opening {}: {error}", app.display()),
        )),
    }
}

/// Download Docker Desktop's installer and install it, without accepting its terms.
fn install(into: &Path, progress: &mut dyn FnMut(Progress)) -> Result<(), Problem> {
    let download = download()?;
    let installer = fetch_streamed(&download, into, progress)?;
    progress(Progress::said("Installing Docker Desktop."));
    install_from(&installer, into)
}

#[cfg(target_os = "macos")]
fn install_from(dmg: &Path, into: &Path) -> Result<(), Problem> {
    let mount = into.join("docker-desktop-volume");
    let _ = std::fs::create_dir_all(&mount);
    let attached = crate::quiet::command("hdiutil")
        .args([
            "attach",
            "-nobrowse",
            "-readonly",
            "-noautoopen",
            "-mountpoint",
        ])
        .arg(&mount)
        .arg(dmg)
        .output()
        .map_err(|error| install_failed(format!("hdiutil attach: {error}")))?;
    if !attached.status.success() {
        return Err(install_failed(format!(
            "hdiutil attach: {}",
            crate::quiet::said(&attached.stderr)
        )));
    }
    // Copied as the person, which an administrator account can do into /Applications with no
    // prompt. Docker's own first start then asks for its privileged helper.
    let copied = crate::quiet::command("ditto")
        .arg(mount.join("Docker.app"))
        .arg("/Applications/Docker.app")
        .output();
    let _ = crate::quiet::command("hdiutil")
        .args(["detach", "-quiet"])
        .arg(&mount)
        .output();
    match copied {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => Err(install_failed(format!(
            "ditto Docker.app /Applications: {}",
            crate::quiet::said(&out.stderr)
        ))),
        Err(error) => Err(install_failed(format!("ditto: {error}"))),
    }
}

#[cfg(target_os = "windows")]
fn install_from(exe: &Path, _into: &Path) -> Result<(), Problem> {
    // Docker's installer elevates itself through UAC. `install` without `--accept-license` leaves
    // the agreement to Docker Desktop's first start, where the person accepts it.
    let status = crate::quiet::command(exe)
        .arg("install")
        .status()
        .map_err(|error| install_failed(format!("{}: {error}", exe.display())))?;
    if status.success() {
        Ok(())
    } else {
        Err(install_failed(format!(
            "{} install ended with {status}",
            exe.display()
        )))
    }
}

#[cfg(target_os = "linux")]
fn install_from(_installer: &Path, _into: &Path) -> Result<(), Problem> {
    Err(Problem::plain(
        "On Linux, Docker comes from the distribution's own packages.",
    ))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn install_failed(detail: String) -> Problem {
    Problem::with(
        "OpenBot could not install Docker Desktop. Install it from docker.com, then try again.",
        detail,
    )
}

/// Fetch to `into`, hashing as it streams, and refuse anything whose digest is not the pinned one.
///
/// Streamed rather than read whole like the smaller downloads: the installer is about 600 MB, and
/// the step row shows how much has arrived. A file already there with the right digest is kept.
fn fetch_streamed(
    download: &Download,
    into: &Path,
    progress: &mut dyn FnMut(Progress),
) -> Result<PathBuf, Problem> {
    let path = into.join(download.file);
    if file_digest(&path).as_deref() == Some(download.sha256) {
        return Ok(path);
    }
    std::fs::create_dir_all(into).map_err(|error| unwritable(into, &error.to_string()))?;

    let unreachable = |error: String| {
        Problem::with(
            "OpenBot could not download Docker Desktop. Check the internet connection and try \
             again.",
            format!("{}: {error}", download.url),
        )
    };
    let mut response = reqwest::blocking::Client::builder()
        .user_agent("openbot-desktop")
        .build()
        .map_err(|error| unreachable(error.to_string()))?
        .get(&download.url)
        .send()
        .map_err(|error| unreachable(error.to_string()))?;
    if !response.status().is_success() {
        return Err(unreachable(format!("answered {}", response.status())));
    }

    let partial = into.join(format!("{}.part", download.file));
    let mut out = std::fs::File::create(&partial)
        .map_err(|error| unwritable(&partial, &error.to_string()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1 << 20];
    let mut received: u64 = 0;
    let mut last_said = 0;
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| unreachable(format!("the download did not finish: {error}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        out.write_all(&buffer[..read])
            .map_err(|error| unwritable(&partial, &error.to_string()))?;
        received += read as u64;
        if received - last_said >= 8 << 20 {
            last_said = received;
            progress(Progress {
                said: "Downloading Docker Desktop.".into(),
                downloaded: Some(received),
            });
        }
    }
    drop(out);

    let got = format!("{:x}", hasher.finalize());
    if got != download.sha256 {
        let _ = std::fs::remove_file(&partial);
        return Err(Problem::with(
            "What OpenBot downloaded is not what it was expecting, so it has not been run. Try \
             again.",
            format!(
                "{} from {}: expected sha256 {}, got {got}",
                download.file, download.url, download.sha256
            ),
        ));
    }
    std::fs::rename(&partial, &path).map_err(|error| unwritable(&path, &error.to_string()))?;
    Ok(path)
}

fn file_digest(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).ok()?;
    Some(format!("{:x}", hasher.finalize()))
}

fn unwritable(path: &Path, error: &str) -> Problem {
    Problem::with(
        "OpenBot could not save Docker Desktop's installer. Check there is free disk space and try \
         again.",
        format!("{}: {error}", path.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// A machine whose Docker answers after `answers_after` polls, counting what was done to it.
    struct Fake {
        installed: Cell<bool>,
        polls: Cell<u32>,
        answers_after: Option<u32>,
        opened: Cell<u32>,
        installs: Cell<u32>,
        clock: Cell<Instant>,
    }

    impl Fake {
        fn new(installed: bool, answers_after: Option<u32>) -> Self {
            Self {
                installed: Cell::new(installed),
                polls: Cell::new(0),
                answers_after,
                opened: Cell::new(0),
                installs: Cell::new(0),
                clock: Cell::new(Instant::now()),
            }
        }

        fn run(&self) -> (Result<Ensured, Problem>, Vec<Progress>) {
            let said = RefCell::new(Vec::new());
            let answers = || {
                let polls = self.polls.get();
                self.polls.set(polls + 1);
                self.opened.get() > 0 && self.answers_after.is_some_and(|after| polls >= after)
            };
            let result = ensure_with(
                &mut Machine {
                    installed: &|| self.installed.get(),
                    answers: &answers,
                    install: &mut |progress| {
                        self.installs.set(self.installs.get() + 1);
                        progress(Progress {
                            said: "Downloading Docker Desktop.".into(),
                            downloaded: Some(8 << 20),
                        });
                        self.installed.set(true);
                        Ok(())
                    },
                    open: &|| {
                        self.opened.set(self.opened.get() + 1);
                        Ok(())
                    },
                    sleep: &|step| self.clock.set(self.clock.get() + step),
                    now: &|| self.clock.get(),
                },
                &mut |line| said.borrow_mut().push(line),
            );
            (result, said.into_inner())
        }
    }

    #[test]
    fn an_answering_docker_is_used_as_it_is() {
        let fake = Fake::new(true, Some(0));
        fake.opened.set(1);
        let (result, said) = fake.run();
        assert!(!result.unwrap().installed);
        assert_eq!(fake.opened.get(), 1, "nothing was opened again");
        assert_eq!(fake.installs.get(), 0);
        assert!(said.is_empty());
    }

    #[test]
    fn an_installed_docker_desktop_that_is_stopped_is_started_not_replaced() {
        let fake = Fake::new(true, Some(3));
        let (result, said) = fake.run();
        let ensured = result.unwrap();
        assert!(!ensured.installed);
        assert_eq!(
            fake.installs.get(),
            0,
            "an installed Docker is never installed again"
        );
        assert_eq!(fake.opened.get(), 1);
        assert_eq!(said, [Progress::said("Starting Docker Desktop.")]);
    }

    #[test]
    fn a_machine_without_docker_desktop_gets_it_installed_then_started() {
        let fake = Fake::new(false, Some(2));
        let (result, said) = fake.run();
        let ensured = result.unwrap();
        assert!(ensured.installed);
        assert_eq!(fake.installs.get(), 1);
        assert_eq!(fake.opened.get(), 1);
        assert_eq!(said[0].downloaded, Some(8 << 20));
        // The person accepts Docker's terms themselves, in Docker's window.
        assert!(said[1].said.contains("Accept its terms in its own window"));
    }

    #[test]
    fn a_docker_desktop_that_never_answers_says_so_after_its_patience() {
        let fake = Fake::new(true, None);
        let (result, _) = fake.run();
        let problem = result.unwrap_err();
        assert!(problem.said.starts_with("Docker Desktop did not start."));
        assert!(problem.detail.unwrap().contains("180s"));
        // A first start waits longer: it shows terms somebody reads.
        let fresh = Fake::new(false, None);
        let problem = fresh.run().0.unwrap_err();
        assert!(problem.detail.unwrap().contains("900s"));
    }

    #[test]
    fn the_installers_are_pinned_to_docker_s_published_digests() {
        for (os, arch) in [
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("windows", "x86_64"),
        ] {
            let download = download_for(os, arch).unwrap();
            assert!(
                download.url.starts_with("https://desktop.docker.com/"),
                "{download:?}"
            );
            assert!(download.url.contains(&format!("/{BUILD}/")), "{download:?}");
            assert_eq!(download.sha256.len(), 64);
            assert!(download
                .sha256
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        }
        assert!(download_for("windows", "x86_64")
            .unwrap()
            .url
            .ends_with("Docker%20Desktop%20Installer.exe"));
        assert!(download_for("linux", "x86_64").is_err());
    }

    #[test]
    fn an_installed_app_is_found_in_any_of_its_places() {
        let root = crate::test_support::temp_root("docker-desktop-places");
        let first = root.join("Applications/Docker.app");
        let second = root.join("home/Applications/Docker.app");
        assert_eq!(installed_app_in(&[first.clone(), second.clone()]), None);
        std::fs::create_dir_all(&second).unwrap();
        assert_eq!(installed_app_in(&[first, second.clone()]), Some(second));
    }
}
