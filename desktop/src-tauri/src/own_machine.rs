//! OpenBot's own Podman machine, beside or in place of the person's own.
//!
//! A person who already uses Podman usually has a machine of their own, `podman-machine-default`,
//! running and answering. OpenBot used to settle on it. Made the default way it is rootless, and the
//! Intelligence CLI refused it ("Rootless Podman is not supported"), a dead end. On Windows even a
//! rootful one lacks the networking OpenBot's containers need to reach Intelligence. OpenBot never
//! changes somebody's machine (see `acquire::create_machine`), so it passes theirs over
//! (`engine::passed_over_machine`) and uses its own rootful machine, `acquire::MACHINE`, made as on
//! a computer with no Podman machine.
//!
//! **Windows: side by side.** WSL machines run at the same time (`WSLStubber.RequireExclusiveActive`
//! is false in Podman 6.1.1's `pkg/machine/wsl/stubber.go`), so OpenBot's machine starts beside the
//! person's, and nothing of theirs changes.
//!
//! **macOS: one at a time.** Only a rootless machine is passed over there. Podman starts one
//! machine at a time on a Mac: applehv and libkrun both answer `RequireExclusiveActive` with true,
//! and `shim.Start` refuses a second machine while any other is running
//! (`checkExclusiveActiveVM` in `pkg/machine/shim/host.go`). Podman 6.1.1 on a Mac says so:
//! `unable to start "obtest-own": obtest-theirs already starting or running: only one VM can be
//! active at a time`. So OpenBot says plainly that it needs its own, and offers to pause the
//! person's while OpenBot runs. Only once they say yes does it stop theirs (`start_own_with`). Quit
//! stops OpenBot's machine and starts theirs again, with the containers that were running in it
//! (`give_back_with`). What was paused is kept on disk (`Paused`), so a Quit after OpenBot was
//! closed some other way still gives it back. An app update's restart is not a Quit, and theirs
//! stays paused across it.
//!
//! **The person's default connection stays theirs.** OpenBot addresses its machine by name, never
//! through the default connection (see `engine.rs`). `podman machine init` makes a new machine's
//! connection the default only when there were no connections at all (`addConnection` in
//! `pkg/machine/connection/connection.go`), and `podman machine start` changes it only with
//! `--update-connection` or when the person answers yes at a terminal prompt (`shim.Start`).
//! OpenBot passes neither, and its commands have no terminal: `Command::output` gives them a closed
//! stdin.

use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::acquire::{Containers, StepOutcome};
use crate::engine::StepLine;
use crate::problem::Problem;

/// Whether Podman here starts one machine at a time: a Mac's applehv and libkrun do, Windows' WSL
/// does not. See the module comment.
pub fn one_machine_at_a_time(os: &str) -> bool {
    os == "macos"
}

/// The step row the pause offer is said on, and the window looks for.
pub const PAUSE_STEP: &str = "pause-podman";

/// What the person reads when OpenBot needs their go-ahead to pause their Podman.
pub const PAUSE_OFFER: &str = "Your Podman is set up in a way OpenBot can't use. OpenBot will use \
                               its own, and pause yours while OpenBot is running. Yours starts \
                               again when you quit OpenBot.";

/// The offer, said on the row while OpenBot waits for the person's go-ahead in its window.
pub fn pause_offer(theirs: &[String]) -> StepLine {
    StepLine::asks(PAUSE_OFFER).logged(format!(
        "{} runs rootless, and a Mac runs one Podman machine at a time. Waiting for the go-ahead \
         to stop it (podman machine stop) while OpenBot's machine, {}, runs. Quit starts it again.",
        theirs.join(", "),
        crate::acquire::MACHINE
    ))
}

/// The row while one of the person's machines is stopped.
pub fn pausing_line(name: &str) -> StepLine {
    StepLine::here("Pausing your Podman while OpenBot runs.").logged(format!(
        "Stopping {name} (podman machine stop) so {} can start.",
        crate::acquire::MACHINE
    ))
}

/// The row once the person's machines are paused.
pub const PAUSED: &str = "Your Podman is paused while OpenBot runs.";

/// The Podman machines here, as pausing and giving back needs them, so the sequence can be tested
/// without one.
pub trait Machines {
    /// The machines running now, by name.
    fn running(&mut self) -> Result<Vec<String>, String>;
    /// The containers running in one now, to start again with it.
    fn containers(&mut self, name: &str) -> Containers;
    fn stop(&mut self, name: &str) -> Result<(), String>;
    /// Start one, then `containers` in it.
    fn start(&mut self, name: &str, containers: &Containers) -> Result<(), String>;
}

/// `Machines` on this computer.
pub struct ThisComputer;

impl Machines for ThisComputer {
    fn running(&mut self) -> Result<Vec<String>, String> {
        crate::acquire::running_machines()
    }

    fn containers(&mut self, name: &str) -> Containers {
        crate::acquire::running_containers(name)
    }

    fn stop(&mut self, name: &str) -> Result<(), String> {
        crate::acquire::stop_machine_named(name)
    }

    fn start(&mut self, name: &str, containers: &Containers) -> Result<(), String> {
        crate::acquire::start_machine_named(name, containers)
    }
}

/// The person's machines OpenBot paused, and the containers that were running in each.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Paused {
    pub machines: Vec<PausedMachine>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PausedMachine {
    pub name: String,
    #[serde(default)]
    pub containers: Containers,
}

/// Where `Paused` is kept: beside the engine files OpenBot downloads, one place per computer
/// whichever installation folder is in use.
pub fn record_path() -> PathBuf {
    crate::acquire::download_dir(&crate::stack::default_root()).join("paused-podman.json")
}

/// What OpenBot paused, or nothing when it paused nothing.
pub fn read_paused(path: &Path) -> Paused {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Keep `paused`, or remove the record when it is empty.
pub fn write_paused(path: &Path, paused: &Paused) -> Result<(), String> {
    if paused.machines.is_empty() {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("{}: {error}", path.display())),
        };
    }
    let folder = path
        .parent()
        .ok_or_else(|| format!("{} has no folder", path.display()))?;
    std::fs::create_dir_all(folder).map_err(|error| format!("{}: {error}", folder.display()))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("{} has no file name", path.display()))?;
    crate::preparation::write_checkpoint(folder, name, paused)
}

/**
Start OpenBot's own machine (`start`), first pausing the person's machines that would keep it from
starting, once the person says yes (`ask`).

Only where Podman runs one machine at a time (`exclusive`, a Mac). Elsewhere, and on a Mac with no
other machine running, OpenBot's machine starts at once and nothing is asked. Each machine paused is
recorded in `record` before it is stopped, with the containers running in it, so Quit starts it
again (`give_back_with`) even if OpenBot is closed before it finishes.

`ask` answers once the person said yes, or with why not (Stop or Quit while it waited).
*/
#[allow(clippy::too_many_arguments)]
pub fn start_own_with(
    machines: &mut dyn Machines,
    record: &Path,
    exclusive: bool,
    own: &str,
    ask: &mut dyn FnMut(&[String]) -> Result<(), Problem>,
    progress: &mut dyn FnMut(StepLine),
    start: &mut dyn FnMut() -> StepOutcome,
) -> Result<StepOutcome, Problem> {
    if exclusive {
        let theirs: Vec<String> = machines
            .running()
            .unwrap_or_else(|error| {
                log::warn!("[engine] could not list the Podman machines running: {error}");
                Vec::new()
            })
            .into_iter()
            .filter(|name| name != own)
            .collect();
        if !theirs.is_empty() {
            ask(&theirs)?;
            pause(machines, record, &theirs, progress)?;
        }
    }
    Ok(start())
}

fn pause(
    machines: &mut dyn Machines,
    record: &Path,
    theirs: &[String],
    progress: &mut dyn FnMut(StepLine),
) -> Result<(), Problem> {
    let mut paused = read_paused(record);
    for name in theirs {
        progress(pausing_line(name));
        let containers = machines.containers(name);
        if !paused.machines.iter().any(|machine| &machine.name == name) {
            paused.machines.push(PausedMachine {
                name: name.clone(),
                containers,
            });
        }
        if let Err(error) = write_paused(record, &paused) {
            log::warn!("[engine] could not record {name} as paused: {error}");
        }
        if let Err(error) = machines.stop(name) {
            // Still running, so nothing to give back for it.
            paused.machines.retain(|machine| &machine.name != name);
            if let Err(error) = write_paused(record, &paused) {
                log::warn!("[engine] could not record {name} as running: {error}");
            }
            return Err(Problem::with(
                "OpenBot couldn't pause your Podman. Try again.",
                format!("podman machine stop {name}: {error}"),
            ));
        }
        log::info!("[engine] paused {name} while OpenBot runs");
    }
    Ok(())
}

/**
Quit's part: OpenBot's machine stopped, and every machine OpenBot paused started again, with the
containers that were running in it. Answers false when OpenBot paused nothing, which is every
computer but a Mac whose Podman ran rootless, and then nothing is touched.

A machine that will not start again stays recorded, so the next Quit tries again.
*/
pub fn give_back_with(
    machines: &mut dyn Machines,
    record: &Path,
    own: &str,
) -> Result<bool, String> {
    let mut paused = read_paused(record);
    if paused.machines.is_empty() {
        return Ok(false);
    }
    if let Err(error) = machines.stop(own) {
        // Stopped already, most often: OpenBot's machine may never have started this time.
        log::info!("[engine] podman machine stop {own}: {error}");
    }
    let mut failed = Vec::new();
    paused.machines.retain(
        |machine| match machines.start(&machine.name, &machine.containers) {
            Ok(()) => {
                log::info!("[engine] started {} again", machine.name);
                false
            }
            Err(error) => {
                failed.push(format!("podman machine start {}: {error}", machine.name));
                true
            }
        },
    );
    if let Err(error) = write_paused(record, &paused) {
        failed.push(error);
    }
    if failed.is_empty() {
        Ok(true)
    } else {
        Err(failed.join("; "))
    }
}

/// Whether OpenBot has a machine of the person's paused, for Quit to say so.
pub fn has_paused(record: &Path) -> bool {
    !read_paused(record).machines.is_empty()
}

/**
The person's go-ahead to pause their Podman, given in OpenBot's window.

Waits for as long as it takes: pausing somebody's machine is their choice, and nothing is paused
for them by a timer. Stop or Quit ends the wait with nothing paused. A go-ahead given while nothing
waits counts for nothing, so a click left over never pauses a machine later.
*/
pub struct Consent {
    state: Mutex<Asked>,
    changed: Condvar,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Asked {
    Nothing,
    Waiting,
    Given,
}

impl Default for Consent {
    fn default() -> Self {
        Self::new()
    }
}

impl Consent {
    pub const fn new() -> Self {
        Self {
            state: Mutex::new(Asked::Nothing),
            changed: Condvar::new(),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, Asked> {
        self.state.lock().unwrap_or_else(|held| held.into_inner())
    }

    /// The person said yes. True when OpenBot was waiting for it.
    pub fn give(&self) -> bool {
        let mut state = self.state();
        if *state != Asked::Waiting {
            return false;
        }
        *state = Asked::Given;
        self.changed.notify_all();
        true
    }

    /// Say what is asked (`ask`), then wait for the go-ahead. `cancelled` (Stop or Quit) ends the
    /// wait with nothing given.
    pub fn wait(&self, ask: impl FnOnce(), cancelled: &dyn Fn() -> bool) -> Result<(), Problem> {
        *self.state() = Asked::Waiting;
        ask();
        let mut state = self.state();
        loop {
            if *state == Asked::Given {
                *state = Asked::Nothing;
                return Ok(());
            }
            if cancelled() {
                *state = Asked::Nothing;
                return Err(Problem::with(
                    "OpenBot stopped before pausing your Podman. Start again when you're ready.",
                    "stopped while waiting for the go-ahead to pause the person's Podman machine",
                ));
            }
            state = self
                .changed
                .wait_timeout(state, Duration::from_millis(100))
                .unwrap_or_else(|held| held.into_inner())
                .0;
        }
    }
}

/// The go-ahead the window gives (`allow_pause`).
pub static PAUSE_GATE: Consent = Consent::new();

/// The window's go-ahead. True when OpenBot was waiting for it.
pub fn allow_pause() -> bool {
    PAUSE_GATE.give()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    /// Podman machines as Podman 6.1.1 runs them: on a Mac one at a time, refusing a second start
    /// with its own words; on Windows side by side. Each machine has its containers.
    struct Fake {
        exclusive: bool,
        machines: Vec<(String, bool)>,
        containers: std::collections::HashMap<String, Containers>,
        done: Vec<String>,
    }

    impl Fake {
        fn new(exclusive: bool, machines: &[(&str, bool)]) -> Self {
            Self {
                exclusive,
                machines: machines
                    .iter()
                    .map(|(name, running)| (name.to_string(), *running))
                    .collect(),
                containers: Default::default(),
                done: Vec::new(),
            }
        }

        fn running_now(&self) -> Vec<String> {
            self.machines
                .iter()
                .filter(|(_, running)| *running)
                .map(|(name, _)| name.clone())
                .collect()
        }

        fn set(&mut self, name: &str, running: bool) {
            for machine in &mut self.machines {
                if machine.0 == name {
                    machine.1 = running;
                }
            }
        }
    }

    impl Machines for Fake {
        fn running(&mut self) -> Result<Vec<String>, String> {
            Ok(self.running_now())
        }

        fn containers(&mut self, name: &str) -> Containers {
            self.containers.get(name).cloned().unwrap_or_default()
        }

        fn stop(&mut self, name: &str) -> Result<(), String> {
            self.done.push(format!("stop {name}"));
            if !self.running_now().contains(&name.to_string()) {
                return Err(format!("Error: {name}: VM already stopped"));
            }
            self.set(name, false);
            self.containers.remove(name);
            Ok(())
        }

        fn start(&mut self, name: &str, containers: &Containers) -> Result<(), String> {
            self.done.push(format!("start {name}"));
            if self.exclusive {
                if let Some(other) = self.running_now().into_iter().find(|other| other != name) {
                    return Err(format!(
                        "unable to start \"{name}\": {other} already starting or running: only \
                         one VM can be active at a time"
                    ));
                }
            }
            self.set(name, true);
            if !containers.is_empty() {
                self.done.push(format!("start containers in {name}"));
                self.containers.insert(name.to_string(), containers.clone());
            }
            Ok(())
        }
    }

    const THEIRS: &str = "podman-machine-default";
    const OURS: &str = "openbot";

    fn their_web() -> Containers {
        vec![(THEIRS.to_string(), vec!["my-web".to_string()])]
    }

    /// Start OpenBot's machine as setup and a relaunch do, with `answer` as the person's reply.
    fn start_ours(
        fake: &mut Fake,
        record: &Path,
        answer: Result<(), Problem>,
        asked: &mut Vec<Vec<String>>,
    ) -> Result<StepOutcome, Problem> {
        let exclusive = fake.exclusive;
        let mut answer = Some(answer);
        let mut said = Vec::new();
        let fake_cell = std::cell::RefCell::new(fake);
        let result = start_own_with(
            &mut **fake_cell.borrow_mut(),
            record,
            exclusive,
            OURS,
            &mut |theirs| {
                asked.push(theirs.to_vec());
                answer.take().unwrap()
            },
            &mut |line| said.push(line.said),
            &mut || StepOutcome {
                step: crate::acquire::Step::StartMachine,
                ok: true,
                said: "started".into(),
                detail: None,
            },
        );
        result.inspect(|_| {
            let fake = &mut **fake_cell.borrow_mut();
            fake.start(OURS, &Vec::new()).unwrap();
        })
    }

    /// A Mac with the person's rootless machine running: OpenBot asks, and only after yes pauses
    /// theirs and starts its own. Quit stops OpenBot's and starts theirs again with its container.
    #[test]
    fn on_a_mac_the_persons_machine_is_paused_only_after_yes_and_given_back_on_quit() {
        let root = temp_root("own-machine-mac");
        let record = root.join("paused-podman.json");
        let mut fake = Fake::new(true, &[(THEIRS, true), (OURS, false)]);
        fake.containers.insert(THEIRS.into(), their_web());

        let mut asked = Vec::new();
        start_ours(&mut fake, &record, Ok(()), &mut asked).unwrap();
        assert_eq!(asked, [vec![THEIRS.to_string()]]);
        assert_eq!(fake.done, ["stop podman-machine-default", "start openbot"]);
        assert_eq!(fake.running_now(), [OURS]);
        assert_eq!(
            read_paused(&record),
            Paused {
                machines: vec![PausedMachine {
                    name: THEIRS.into(),
                    containers: their_web(),
                }]
            }
        );

        // Quit gives it back as it was: OpenBot's machine stopped first, then theirs and its
        // container started again. The record is gone.
        fake.done.clear();
        assert_eq!(give_back_with(&mut fake, &record, OURS), Ok(true));
        assert_eq!(
            fake.done,
            [
                "stop openbot",
                "start podman-machine-default",
                "start containers in podman-machine-default"
            ]
        );
        assert_eq!(fake.running_now(), [THEIRS]);
        assert!(!record.exists());

        // A second Quit has nothing to give back and touches nothing.
        fake.done.clear();
        assert_eq!(give_back_with(&mut fake, &record, OURS), Ok(false));
        assert!(fake.done.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    /// Without the person's yes nothing of theirs is touched: Stop or Quit while OpenBot waits
    /// leaves their machine running and OpenBot's not started.
    #[test]
    fn on_a_mac_nothing_is_paused_without_the_persons_yes() {
        let root = temp_root("own-machine-no");
        let record = root.join("paused-podman.json");
        let mut fake = Fake::new(true, &[(THEIRS, true), (OURS, false)]);
        let problem = start_ours(
            &mut fake,
            &record,
            Err(Problem::plain("stopped")),
            &mut Vec::new(),
        )
        .unwrap_err();
        assert_eq!(problem.said, "stopped");
        assert!(fake.done.is_empty(), "{:?}", fake.done);
        assert_eq!(fake.running_now(), [THEIRS]);
        assert!(!has_paused(&record));
        let _ = std::fs::remove_dir_all(root);
    }

    /// The real gate: it waits for the go-ahead however long it takes, and Stop ends the wait with
    /// nothing given. A go-ahead given while nothing waits counts for nothing.
    #[test]
    fn the_go_ahead_waits_for_the_person_and_a_stray_one_counts_for_nothing() {
        let gate = std::sync::Arc::new(Consent::new());
        assert!(!gate.give(), "nothing was waiting");
        let waiting = gate.clone();
        let (asked, heard) = std::sync::mpsc::channel();
        let waited = std::thread::spawn(move || {
            waiting.wait(
                || {
                    asked.send(()).unwrap();
                },
                &|| false,
            )
        });
        heard.recv().unwrap();
        // Longer than any timer would be: still waiting.
        std::thread::sleep(Duration::from_millis(300));
        assert!(!waited.is_finished());
        assert!(gate.give());
        assert!(waited.join().unwrap().is_ok());

        let stopped = std::sync::atomic::AtomicBool::new(false);
        let problem = std::thread::scope(|scope| {
            let waiting = scope
                .spawn(|| gate.wait(|| {}, &|| stopped.load(std::sync::atomic::Ordering::SeqCst)));
            std::thread::sleep(Duration::from_millis(150));
            stopped.store(true, std::sync::atomic::Ordering::SeqCst);
            waiting.join().unwrap().unwrap_err()
        });
        assert_eq!(
            problem.said,
            "OpenBot stopped before pausing your Podman. Start again when you're ready."
        );
    }

    /// Windows runs WSL machines side by side: OpenBot's starts beside the person's, nothing is
    /// asked, nothing of theirs is stopped, and Quit has nothing to give back.
    #[test]
    fn on_windows_openbots_machine_starts_beside_the_persons_and_theirs_is_untouched() {
        let root = temp_root("own-machine-windows");
        let record = root.join("paused-podman.json");
        let mut fake = Fake::new(false, &[(THEIRS, true), (OURS, false)]);
        let mut asked = Vec::new();
        start_ours(&mut fake, &record, Ok(()), &mut asked).unwrap();
        assert!(asked.is_empty());
        assert_eq!(fake.done, ["start openbot"]);
        assert_eq!(fake.running_now(), [THEIRS, OURS]);
        assert_eq!(give_back_with(&mut fake, &record, OURS), Ok(false));
        assert_eq!(fake.done, ["start openbot"]);
        assert!(!record.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    /// A Mac with no other machine running, or with OpenBot's own already up: nothing to ask.
    #[test]
    fn on_a_mac_with_nothing_else_running_openbots_machine_just_starts() {
        let root = temp_root("own-machine-alone");
        let record = root.join("paused-podman.json");
        let mut fake = Fake::new(true, &[(THEIRS, false), (OURS, false)]);
        let mut asked = Vec::new();
        start_ours(&mut fake, &record, Ok(()), &mut asked).unwrap();
        assert!(asked.is_empty());
        assert_eq!(fake.done, ["start openbot"]);
        assert!(!has_paused(&record));
        let _ = std::fs::remove_dir_all(root);
    }

    /// A machine that will not stop is still the person's, running: it is not recorded, so Quit
    /// does not start what OpenBot never paused, and setup says so with Try again.
    #[test]
    fn a_machine_that_will_not_pause_is_said_and_not_recorded() {
        let root = temp_root("own-machine-stuck");
        let record = root.join("paused-podman.json");
        struct Stuck(Fake);
        impl Machines for Stuck {
            fn running(&mut self) -> Result<Vec<String>, String> {
                self.0.running()
            }
            fn containers(&mut self, name: &str) -> Containers {
                self.0.containers(name)
            }
            fn stop(&mut self, name: &str) -> Result<(), String> {
                Err(format!("Error: {name}: the VM did not stop"))
            }
            fn start(&mut self, name: &str, containers: &Containers) -> Result<(), String> {
                self.0.start(name, containers)
            }
        }
        let mut stuck = Stuck(Fake::new(true, &[(THEIRS, true), (OURS, false)]));
        let problem = start_own_with(
            &mut stuck,
            &record,
            true,
            OURS,
            &mut |_| Ok(()),
            &mut |_| {},
            &mut || panic!("OpenBot's machine is not started while theirs runs"),
        )
        .unwrap_err();
        assert_eq!(
            problem.said,
            "OpenBot couldn't pause your Podman. Try again."
        );
        assert!(!has_paused(&record));
        let _ = std::fs::remove_dir_all(root);
    }

    /// The record survives OpenBot itself: written before the stop, read by a later Quit.
    #[test]
    fn what_was_paused_is_kept_on_disk_until_it_is_given_back() {
        let root = temp_root("own-machine-record");
        let record = root.join("engine/paused-podman.json");
        let paused = Paused {
            machines: vec![PausedMachine {
                name: THEIRS.into(),
                containers: their_web(),
            }],
        };
        write_paused(&record, &paused).unwrap();
        assert_eq!(read_paused(&record), paused);
        assert!(has_paused(&record));
        write_paused(&record, &Paused::default()).unwrap();
        assert!(!record.exists());
        assert_eq!(read_paused(&record), Paused::default());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn only_a_mac_runs_one_machine_at_a_time() {
        assert!(one_machine_at_a_time("macos"));
        assert!(!one_machine_at_a_time("windows"));
        assert!(!one_machine_at_a_time("linux"));
    }
}

/**
The pause and give-back on a real Mac, with throwaway machines only: a rootless one standing for the
person's (`OPENBOT_LIVE_THEIRS`, running, with a container running in it) and a rootful one standing
for OpenBot's (`OPENBOT_LIVE_OWN`, stopped). Nothing else is touched. Run by hand:

```text
OPENBOT_LIVE_THEIRS=obtest-theirs OPENBOT_LIVE_OWN=obtest-own \
  cargo test --lib own_machine::live -- --ignored --nocapture --test-threads=1
```
*/
#[cfg(all(test, target_os = "macos"))]
mod live {
    use super::*;

    fn podman(args: &[&str]) -> Result<String, String> {
        let output = crate::engine::tool(crate::engine::Engine::Podman)
            .args(args)
            .output()
            .map_err(|error| error.to_string())?;
        let said = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() {
            Ok(said)
        } else {
            Err(format!(
                "{said} {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }

    fn default_connection() -> String {
        podman(&[
            "system",
            "connection",
            "list",
            "--format",
            "{{if .Default}}{{.Name}}{{end}}",
        ])
        .unwrap()
    }

    fn running() -> Vec<String> {
        crate::acquire::running_machines().unwrap()
    }

    #[test]
    #[ignore = "starts and stops the throwaway Podman machines named in OPENBOT_LIVE_THEIRS and OPENBOT_LIVE_OWN"]
    fn a_rootless_machine_is_paused_after_yes_and_given_back_on_quit() {
        let theirs = std::env::var("OPENBOT_LIVE_THEIRS").expect("OPENBOT_LIVE_THEIRS");
        let own = std::env::var("OPENBOT_LIVE_OWN").expect("OPENBOT_LIVE_OWN");
        let default_before = default_connection();
        assert_eq!(
            running(),
            std::slice::from_ref(&theirs),
            "only theirs runs to begin with"
        );

        // Theirs is passed over (rootless), and OpenBot's stand-in is not (rootful).
        assert_eq!(
            crate::engine::passed_over(&theirs, "macos", crate::acquire::machine_behind),
            Some(theirs.clone())
        );
        assert_eq!(
            crate::engine::passed_over(
                &format!("{own}-root"),
                "macos",
                crate::acquire::machine_behind
            ),
            None
        );

        // Podman itself refuses a second machine on a Mac: the reason for the pause.
        let refused = podman(&["machine", "start", &own]).unwrap_err();
        println!("[live] a second machine: {refused}");
        assert!(
            refused.contains("only one VM can be active at a time"),
            "{refused}"
        );

        let before = crate::acquire::running_containers(&theirs);
        println!("[live] containers in {theirs}: {before:?}");
        assert!(!before.is_empty(), "start a container in {theirs} first");

        let root = crate::test_support::temp_root("own-machine-live");
        let record = root.join("paused-podman.json");
        let gate = std::sync::Arc::new(Consent::new());
        let giving = gate.clone();
        let yes = std::thread::spawn(move || {
            while !giving.give() {
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let mut asked = Vec::new();
        let started = start_own_with(
            &mut ThisComputer,
            &record,
            one_machine_at_a_time(std::env::consts::OS),
            &own,
            &mut |machines| {
                asked.push(machines.to_vec());
                gate.wait(|| println!("[live] asked: {PAUSE_OFFER}"), &|| false)
            },
            &mut |line| println!("[live] {}", line.log_entry()),
            &mut || match crate::acquire::start_machine_named(&own, &Vec::new()) {
                Ok(()) => StepOutcome {
                    step: crate::acquire::Step::StartMachine,
                    ok: true,
                    said: format!("{own} started."),
                    detail: None,
                },
                Err(error) => panic!("{own} did not start: {error}"),
            },
        )
        .unwrap();
        yes.join().unwrap();
        assert!(started.ok);
        assert_eq!(asked, [vec![theirs.clone()]]);
        assert_eq!(running(), std::slice::from_ref(&own));
        crate::acquire::machine_api_answers(&own).unwrap();
        assert_eq!(read_paused(&record).machines[0].name, theirs);
        assert_eq!(default_connection(), default_before);
        println!("[live] {own} runs, {theirs} is paused, the default is still {default_before}");

        // Quit: OpenBot's stand-in stopped, theirs and its container started again.
        assert_eq!(give_back_with(&mut ThisComputer, &record, &own), Ok(true));
        assert_eq!(running(), std::slice::from_ref(&theirs));
        crate::acquire::machine_api_answers(&theirs).unwrap();
        assert_eq!(crate::acquire::running_containers(&theirs), before);
        assert!(!record.exists());
        assert_eq!(default_connection(), default_before);
        println!("[live] given back: {theirs} runs with {before:?}");
        let _ = std::fs::remove_dir_all(root);
    }
}
