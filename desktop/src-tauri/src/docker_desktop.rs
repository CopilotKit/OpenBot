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
//! Desktop on a machine without it; one too old to run OpenBot is updated in place
//! (`docker_desktop_update`). Linux is not handled here: Docker there is the distribution's Docker
//! Engine.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::engine::{self, Engine, StepLine};
use crate::problem::Problem;

/// How long a Docker Desktop that is safe to open gets to start answering: a cold start on a slow
/// machine, with room to spare. One still not answering by then is most likely stopped on a screen
/// of its own (updated terms, a required sign-in), and the person is told to finish it.
const START_PATIENCE: Duration = Duration::from_secs(3 * 60);
const POLL: Duration = Duration::from_secs(2);

/// How long Docker Desktop starts before OpenBot says it may be waiting for the person. A Docker
/// Desktop that has run before answers well inside this on a warm machine. Past it, the likeliest
/// reason is a window of Docker's own: updated terms, a required sign-in.
const NEEDS_YOU_AFTER: Duration = Duration::from_secs(45);

/// Said as OpenBot opens Docker Desktop, whose window then comes to the front over OpenBot's.
pub const HAND_OFF: &str = "Docker Desktop is starting in its own window. If it asks you to \
                            accept its terms or sign in, do that there. OpenBot comes back when \
                            Docker is ready.";

/// Said once Docker Desktop has had `NEEDS_YOU_AFTER` and still does not answer.
pub const STILL_WAITING: &str = "Docker Desktop hasn't started yet. It may be waiting for you \
                                 in its own window. Accept its terms or sign in there, and \
                                 OpenBot carries on by itself.";

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
    // Per user and per machine: Docker's installer offers both.
    #[cfg(target_os = "windows")]
    {
        [
            std::env::var_os("LOCALAPPDATA").map(|local| {
                PathBuf::from(local).join("Programs\\DockerDesktop\\Docker Desktop.exe")
            }),
            std::env::var_os("ProgramFiles")
                .map(|files| PathBuf::from(files).join("Docker\\Docker\\Docker Desktop.exe")),
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
    /// Whether Docker answers now: `answers`.
    pub answers: &'a dyn Fn() -> bool,
    pub open: &'a dyn Fn() -> Result<(), Problem>,
    /// OpenBot's own window to the front again.
    pub back: &'a dyn Fn(),
    pub sleep: &'a dyn Fn(Duration),
    pub now: &'a dyn Fn() -> Instant,
}

/// Docker answering, by opening the installed Docker Desktop. Answers with the sentence for the
/// step row; `progress` is each line before that. Only for a Docker Desktop that is safe to open:
/// see the module comment.
///
/// Opening Docker Desktop puts its window in front of OpenBot's, and nothing in Docker's says to
/// come back. So OpenBot's window says what is happening while Docker starts (`HAND_OFF`), says
/// when it may be waiting on the person (`STILL_WAITING`), and `back` brings OpenBot to the front
/// the moment Docker answers, or when it gives up on it.
pub fn start(progress: &mut dyn FnMut(StepLine), back: &dyn Fn()) -> Result<String, Problem> {
    start_with(
        &Machine {
            answers: &answers,
            open: &open,
            back,
            sleep: &std::thread::sleep,
            now: &Instant::now,
        },
        progress,
    )
}

pub(crate) fn start_with(
    machine: &Machine,
    progress: &mut dyn FnMut(StepLine),
) -> Result<String, Problem> {
    // Already answering: nothing is opened, and OpenBot never left the front.
    if (machine.answers)() {
        return Ok("Docker Desktop is running.".into());
    }
    progress(StepLine::elsewhere(HAND_OFF));
    (machine.open)()?;

    let started = (machine.now)();
    let mut said_still_waiting = false;
    loop {
        let waited = (machine.now)().duration_since(started);
        if waited >= START_PATIENCE {
            break;
        }
        if (machine.answers)() {
            (machine.back)();
            return Ok("Docker Desktop is running.".into());
        }
        if !said_still_waiting && waited >= NEEDS_YOU_AFTER {
            progress(StepLine::elsewhere(STILL_WAITING));
            said_still_waiting = true;
        }
        (machine.sleep)(POLL);
    }
    // The failure needs the person, and it is said in OpenBot's window.
    (machine.back)();
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
pub fn start_saved(progress: &mut dyn FnMut(StepLine), back: &dyn Fn()) -> Result<(), Problem> {
    if cfg!(any(target_os = "macos", target_os = "windows")) && installed_app().is_some() {
        start(progress, back)?;
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
    ///
    /// Its probe has the real one's shape: `answers` is asked, says yes or no, and is asked again
    /// after a sleep. Each poll Docker did not answer also records whether OpenBot had been brought
    /// back by then, so a test can tell "back once Docker answers" from "back at some point".
    struct Fake {
        polls: Cell<u32>,
        answers_after: Option<u32>,
        opened: Cell<u32>,
        backs: Cell<u32>,
        backs_while_not_answering: RefCell<Vec<u32>>,
        clock: Cell<Instant>,
        started: Instant,
    }

    impl Fake {
        fn new(answers_after: Option<u32>) -> Self {
            let now = Instant::now();
            Self {
                polls: Cell::new(0),
                answers_after,
                opened: Cell::new(0),
                backs: Cell::new(0),
                backs_while_not_answering: RefCell::new(Vec::new()),
                clock: Cell::new(now),
                started: now,
            }
        }

        /// The result, and each line the step row was told with the seconds in it was told.
        fn run(&self) -> (Result<String, Problem>, Vec<(u64, StepLine)>) {
            let said = RefCell::new(Vec::new());
            let answers = || {
                let polls = self.polls.get();
                self.polls.set(polls + 1);
                let answering =
                    self.opened.get() > 0 && self.answers_after.is_some_and(|after| polls >= after);
                if !answering {
                    self.backs_while_not_answering
                        .borrow_mut()
                        .push(self.backs.get());
                }
                answering
            };
            let result = start_with(
                &Machine {
                    answers: &answers,
                    open: &|| {
                        self.opened.set(self.opened.get() + 1);
                        Ok(())
                    },
                    back: &|| self.backs.set(self.backs.get() + 1),
                    sleep: &|step| self.clock.set(self.clock.get() + step),
                    now: &|| self.clock.get(),
                },
                &mut |line| {
                    let at = self.clock.get().duration_since(self.started).as_secs();
                    said.borrow_mut().push((at, line));
                },
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
        assert_eq!(fake.backs.get(), 0, "OpenBot never left the front");
    }

    #[test]
    fn an_installed_docker_desktop_that_is_stopped_is_started() {
        let fake = Fake::new(Some(3));
        let (result, said) = fake.run();
        assert_eq!(result.unwrap(), "Docker Desktop is running.");
        assert_eq!(fake.opened.get(), 1);
        assert_eq!(said, [(0, StepLine::elsewhere(HAND_OFF))]);
    }

    /// Dogfooding 0.3.3: Docker Desktop opened in front of OpenBot, started, and stayed in front.
    /// OpenBot's window, behind it, said nothing about Docker and never came back.
    #[test]
    fn opening_docker_desktop_says_so_while_it_starts_and_brings_openbot_back_once_it_answers() {
        let fake = Fake::new(Some(3));
        let (result, said) = fake.run();
        assert_eq!(result.unwrap(), "Docker Desktop is running.");

        // Said before Docker's window takes the front, and marked as another app's window, so the
        // setup window shows it on whichever screen the person is on.
        let (at, line) = &said[0];
        assert_eq!(*at, 0);
        assert!(line.elsewhere);
        assert!(line.said.starts_with("Docker Desktop is starting"));
        assert!(line.said.contains("OpenBot comes back"));

        // Not brought back while Docker was still starting: that would cover Docker's own window
        // just when it may need the person.
        let not_answering = fake.backs_while_not_answering.borrow();
        assert!(!not_answering.is_empty());
        assert!(not_answering.iter().all(|backs| *backs == 0));
        // Brought back once, as soon as Docker answered.
        assert_eq!(fake.backs.get(), 1);
    }

    #[test]
    fn a_docker_desktop_still_starting_after_a_while_says_it_may_be_waiting_for_you() {
        // Answers on the 31st poll: a minute in, with a poll every two seconds.
        let fake = Fake::new(Some(31));
        let (result, said) = fake.run();
        assert_eq!(result.unwrap(), "Docker Desktop is running.");
        let lines: Vec<&StepLine> = said.iter().map(|(_, line)| line).collect();
        assert_eq!(
            lines,
            [
                &StepLine::elsewhere(HAND_OFF),
                &StepLine::elsewhere(STILL_WAITING)
            ]
        );
        assert!(
            said[1].0 >= NEEDS_YOU_AFTER.as_secs() && said[1].0 < NEEDS_YOU_AFTER.as_secs() + 2,
            "said once, when Docker had had its time: {}s",
            said[1].0
        );
        assert_eq!(fake.backs.get(), 1);
    }

    #[test]
    fn a_docker_desktop_that_never_answers_says_so_after_its_patience() {
        let fake = Fake::new(None);
        let (result, said) = fake.run();
        let problem = result.unwrap_err();
        assert!(problem.said.starts_with("Docker Desktop didn't start."));
        assert!(problem.detail.unwrap().contains("180s"));
        assert_eq!(said.len(), 2, "the hand-off, then one still-waiting line");
        // The failure is said in OpenBot's window, so OpenBot comes back to say it.
        assert_eq!(fake.backs.get(), 1);
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
