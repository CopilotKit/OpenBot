//! Docker Desktop: started when it is installed and not running.
//!
//! **Docker first, Podman when there is no Docker.** A Mac or a Windows machine with Docker Desktop
//! installed but not running is not a machine without an engine: starting it is the repair, not
//! installing a second engine beside it. A machine with no Docker at all gets Podman (see
//! `install::install_engine_with`). OpenBot never installs Docker Desktop itself.
//!
//! Linux is not handled here: Docker there is the distribution's Docker Engine, not Docker Desktop.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::engine::{self, Engine};
use crate::problem::Problem;

/// How long an installed Docker Desktop gets to start answering. A first start shows Docker's
/// terms and a helper prompt in Docker's own window, so this allows for somebody reading them.
const START_PATIENCE: Duration = Duration::from_secs(5 * 60);
const POLL: Duration = Duration::from_secs(2);

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
/// step row; `progress` is each line before that. See the module comment.
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
    progress("Starting Docker Desktop. Accept anything it asks in its own window.".into());
    (machine.open)()?;

    let started = (machine.now)();
    while (machine.now)().duration_since(started) < START_PATIENCE {
        if (machine.answers)() {
            return Ok("Docker Desktop is running.".into());
        }
        (machine.sleep)(POLL);
    }
    Err(Problem::with(
        "Docker Desktop did not start. Open Docker Desktop, finish anything it asks for, then try \
         again.",
        format!(
            "Docker did not answer within {}s of opening Docker Desktop",
            START_PATIENCE.as_secs()
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
        assert_eq!(
            said,
            ["Starting Docker Desktop. Accept anything it asks in its own window."]
        );
    }

    #[test]
    fn a_docker_desktop_that_never_answers_says_so_after_its_patience() {
        let fake = Fake::new(None);
        let (result, _) = fake.run();
        let problem = result.unwrap_err();
        assert!(problem.said.starts_with("Docker Desktop did not start."));
        assert!(problem.detail.unwrap().contains("300s"));
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
