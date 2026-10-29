//! Docker Desktop: opened when it is installed, stopped, and safe to open.
//!
//! **OpenBot never puts a person in front of Docker's terms, and never waits on them.** A Docker
//! Desktop that was installed and never opened shows its subscription terms on first open, and
//! from outside it nothing tells that window apart from a password prompt, a required sign-in or a
//! slow boot. So a stopped Docker Desktop is opened only when it is known to start by itself:
//!
//! - it has run before on this machine (`used_before`: its VM disk exists), or
//! - this installation was set up on Docker, so it answered for OpenBot before.
//!
//! Anything else gets Podman (see `install::install_engine_with`). OpenBot never installs Docker
//! Desktop itself. Linux is not handled here: Docker there is the distribution's Docker Engine.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::engine::{self, Engine};
use crate::problem::Problem;

/// How long a Docker Desktop that is safe to open gets to start answering: a cold start on a slow
/// machine, with room to spare. One still not answering by then is most likely stopped on a screen
/// of its own (updated terms, a required sign-in), and the person is told to finish it.
const START_PATIENCE: Duration = Duration::from_secs(3 * 60);
const POLL: Duration = Duration::from_secs(2);

/// Where Docker Desktop is installed on this machine, if it is.
pub fn installed_app() -> Option<PathBuf> {
    installed_app_in(&app_places())
}

fn installed_app_in(places: &[PathBuf]) -> Option<PathBuf> {
    places.iter().find(|place| place.exists()).cloned()
}

pub(crate) fn app_places() -> Vec<PathBuf> {
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

/// Whether this machine's Docker Desktop has run before: its terms were accepted and its first-run
/// screens are done, so opening it starts Docker and shows nothing that needs the person.
///
/// The evidence is Docker Desktop's VM disk, which holds every image and container. Docker creates
/// it when its engine first starts, and the engine starts only after the terms are accepted.
/// Docker documents these places in "How to back up and restore your Docker Desktop data". A disk
/// moved elsewhere in Docker's settings is not found, and that machine gets Podman: the safe side.
///
/// METADATA ONLY. On macOS the disk is inside Docker's app container, and reading or listing
/// anything there raises "would like to access data from other apps". A `stat` of a path inside it
/// raises nothing: checked on macOS 27.0.1 against the TCC log, where listing does show up. Never
/// open, read or list here, and never run `docker` to find out.
pub fn used_before() -> bool {
    any_disk(&vm_disks())
}

fn any_disk(disks: &[PathBuf]) -> bool {
    disks.iter().any(|disk| disk.is_file())
}

fn vm_disks() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|home| {
                PathBuf::from(home)
                    .join("Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw")
            })
            .into_iter()
            .collect()
    }
    #[cfg(target_os = "windows")]
    {
        // WSL 2 now, then WSL 2 as earlier releases laid it out, then Docker's own VM manager and
        // Hyper-V.
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let data = std::env::var_os("ProgramData").map(PathBuf::from);
        [
            local
                .as_ref()
                .map(|l| l.join("Docker\\wsl\\disk\\docker_data.vhdx")),
            local
                .as_ref()
                .map(|l| l.join("Docker\\wsl\\data\\docker_data.vhdx")),
            local
                .as_ref()
                .map(|l| l.join("Docker\\wsl\\data\\ext4.vhdx")),
            local
                .as_ref()
                .map(|l| l.join("Docker\\vm-data\\DockerDesktop.vhdx")),
            data.map(|d| d.join("DockerDesktop\\vm-data\\DockerDesktop.vhdx")),
        ]
        .into_iter()
        .flatten()
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

/// What `start_with` needs from the machine, so its decisions can be tested without one.
pub(crate) struct Machine<'a> {
    pub answers: &'a dyn Fn() -> bool,
    pub open: &'a dyn Fn() -> Result<(), Problem>,
    pub sleep: &'a dyn Fn(Duration),
    pub now: &'a dyn Fn() -> Instant,
}

/// Docker answering, by opening the installed Docker Desktop. Answers with the sentence for the
/// step row; `progress` is each line before that. Only for a Docker Desktop that is safe to open:
/// see the module comment.
pub fn start(progress: &mut dyn FnMut(String)) -> Result<String, Problem> {
    start_with(
        &Machine {
            answers: &answers,
            open: &open,
            sleep: &std::thread::sleep,
            now: &Instant::now,
        },
        progress,
    )
}

pub(crate) fn start_with(
    machine: &Machine,
    progress: &mut dyn FnMut(String),
) -> Result<String, Problem> {
    if (machine.answers)() {
        return Ok("Docker Desktop is running.".into());
    }
    progress("Starting Docker Desktop.".into());
    (machine.open)()?;

    let started = (machine.now)();
    while (machine.now)().duration_since(started) < START_PATIENCE {
        if (machine.answers)() {
            return Ok("Docker Desktop is running.".into());
        }
        (machine.sleep)(POLL);
    }
    Err(Problem::with(
        "Docker Desktop didn't start. Open it and finish anything it shows, then try again.",
        format!(
            "Docker did not answer within {}s of opening Docker Desktop",
            START_PATIENCE.as_secs()
        ),
    ))
}

/// Before Start, for an installation set up on Docker: a stopped Docker Desktop is opened. It
/// answered for this installation before, so its first-run screens are done. Without a Docker
/// Desktop to open, nothing is done here and Start reports that Docker is not answering.
pub fn start_saved(progress: &mut dyn FnMut(String)) -> Result<(), Problem> {
    if cfg!(any(target_os = "macos", target_os = "windows")) && installed_app().is_some() {
        start(progress)?;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// A machine whose Docker answers after `answers_after` polls, counting what was done to it.
    struct Fake {
        polls: Cell<u32>,
        answers_after: Option<u32>,
        opened: Cell<u32>,
        clock: Cell<Instant>,
    }

    impl Fake {
        fn new(answers_after: Option<u32>) -> Self {
            Self {
                polls: Cell::new(0),
                answers_after,
                opened: Cell::new(0),
                clock: Cell::new(Instant::now()),
            }
        }

        fn run(&self) -> (Result<String, Problem>, Vec<String>) {
            let said = RefCell::new(Vec::new());
            let answers = || {
                let polls = self.polls.get();
                self.polls.set(polls + 1);
                self.opened.get() > 0 && self.answers_after.is_some_and(|after| polls >= after)
            };
            let result = start_with(
                &Machine {
                    answers: &answers,
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
        let fake = Fake::new(Some(0));
        fake.opened.set(1);
        let (result, said) = fake.run();
        assert_eq!(result.unwrap(), "Docker Desktop is running.");
        assert_eq!(fake.opened.get(), 1, "nothing was opened again");
        assert!(said.is_empty());
    }

    #[test]
    fn an_installed_docker_desktop_that_is_stopped_is_started() {
        let fake = Fake::new(Some(3));
        let (result, said) = fake.run();
        assert_eq!(result.unwrap(), "Docker Desktop is running.");
        assert_eq!(fake.opened.get(), 1);
        assert_eq!(said, ["Starting Docker Desktop."]);
    }

    #[test]
    fn a_docker_desktop_that_never_answers_says_so_after_its_patience() {
        let fake = Fake::new(None);
        let (result, _) = fake.run();
        let problem = result.unwrap_err();
        assert!(problem.said.starts_with("Docker Desktop didn't start."));
        assert!(problem.detail.unwrap().contains("180s"));
    }

    #[test]
    fn a_docker_desktop_is_used_before_only_once_its_vm_disk_exists() {
        let root = crate::test_support::temp_root("docker-desktop-vm-disk");
        let disk = root.join("vms/0/data/Docker.raw");
        // Installed and never opened: no disk, and the folder alone is not a disk.
        assert!(!any_disk(std::slice::from_ref(&disk)));
        std::fs::create_dir_all(&disk).unwrap();
        assert!(!any_disk(std::slice::from_ref(&disk)));
        std::fs::remove_dir(&disk).unwrap();
        std::fs::write(&disk, "").unwrap();
        assert!(any_disk(&[root.join("elsewhere.vhdx"), disk]));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn the_mac_vm_disk_is_where_docker_documents_it() {
        let home = std::path::PathBuf::from(std::env::var_os("HOME").unwrap());
        assert_eq!(
            vm_disks(),
            [home.join("Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw")]
        );
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
