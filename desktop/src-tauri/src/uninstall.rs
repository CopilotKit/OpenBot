//! What the Windows uninstaller stops before it removes OpenBot.
//!
//! Uninstalling OpenBot from Windows' Apps closed the app and left everything it runs behind:
//! OpenBot's Podman machine (`acquire::MACHINE`), OpenBot's containers in it and the backend's
//! cluster, with no app left to stop them. So the uninstaller first runs this app headless
//! (`NSIS_HOOK_PREUNINSTALL` in `windows/hooks.nsh`), as `openbot-desktop.exe --stop-for-uninstall`,
//! with `--remove-machine` added when the person ticked "Delete the application data".
//!
//! It stops what Stop stops, then OpenBot's own machine, and nothing else:
//! - OpenBot's containers, with Compose (`stack::down`), on the engine the installation runs on;
//! - the backend, with the CLI's `local stop`, and only when OpenBot created it;
//! - OpenBot's machine, `openbot`, when there is one.
//!
//! The person's own machines and containers are never touched. An OpenBot that ran in a machine of
//! theirs has its containers taken down there, and their machine is left running. OpenBot's machine
//! is removed only when the person chose to delete OpenBot's data. Otherwise it is left stopped, with
//! everything in it, so installing OpenBot again finds it.
//!
//! Not on an update: the installer runs the old uninstaller with `/UPDATE` (`windows/installer.nsi`),
//! and the hook then leaves everything running for the new version.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use crate::engine::Address;

/// The argument the uninstaller starts the app with.
pub const COMMAND: &str = "--stop-for-uninstall";

/// Added when the person ticked "Delete the application data": OpenBot's machine goes too.
pub const REMOVE_MACHINE: &str = "--remove-machine";

/// How long the whole stop may take before the uninstaller goes on without it. The backend's stop
/// alone may take two minutes (`local_eval::Limits::for_quit`).
pub const LIMIT: Duration = Duration::from_secs(5 * 60);

/// What the uninstaller asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Asked {
    pub remove_machine: bool,
}

/// The uninstaller's request, from the program's arguments (the program first), or `None` for any
/// other launch. Anything after `--stop-for-uninstall` but `--remove-machine` is passed over: a run
/// the uninstaller started must never open the app's window.
pub fn asked(args: &[OsString]) -> Option<Asked> {
    let mut rest = args.iter().skip(1);
    if rest.next()? != COMMAND {
        return None;
    }
    Some(Asked {
        remove_machine: rest.any(|arg| arg == REMOVE_MACHINE),
    })
}

/// What the stop does on a computer, so the order and the choices can be tested without one.
pub trait Computer {
    /// The engine the installation at `root` runs on, when it answers.
    fn engine(&mut self, root: &Path) -> Option<Address>;
    /// OpenBot's containers at `root`, taken down with Compose.
    fn compose_down(&mut self, engine: &Address, root: &Path) -> Result<(), String>;
    /// The backend, stopped with the CLI, when OpenBot created it.
    fn stop_backend(&mut self, engine: &Address, root: &Path) -> Result<(), String>;
    /// The Podman machine `name`: `None` when there is none (or no Podman), else whether it runs.
    fn machine(&mut self, name: &str) -> Result<Option<bool>, String>;
    fn stop_machine(&mut self, name: &str) -> Result<(), String>;
    fn remove_machine(&mut self, name: &str) -> Result<(), String>;
}

/// Stop what OpenBot runs for the installation at `root`, saying each step to `say`. Every step is
/// tried, whatever happened to the one before; what failed is returned, in plain words with the
/// engine's own after them.
pub fn stop_with(
    computer: &mut dyn Computer,
    root: &Path,
    asked: Asked,
    say: &mut dyn FnMut(&str),
) -> Vec<String> {
    let mut failures = Vec::new();

    // No engine answering: nothing of OpenBot's runs there to take down.
    if let Some(engine) = computer.engine(root) {
        say("Stopping OpenBot.");
        let down = computer.compose_down(&engine, root);
        note(&mut failures, "Couldn't stop OpenBot's containers.", down);
        say("Stopping OpenBot's services.");
        let backend = computer.stop_backend(&engine, root);
        note(&mut failures, "Couldn't stop OpenBot's services.", backend);
    }

    let own = crate::acquire::MACHINE;
    let running = match computer.machine(own) {
        Ok(Some(running)) => running,
        Ok(None) => return failures,
        Err(error) => {
            note(
                &mut failures,
                "Couldn't find OpenBot's Podman machine.",
                Err(error),
            );
            return failures;
        }
    };
    if running {
        say("Stopping OpenBot's Podman machine.");
        let stopped = computer.stop_machine(own);
        note(
            &mut failures,
            "Couldn't stop OpenBot's Podman machine.",
            stopped,
        );
    }
    if asked.remove_machine {
        say("Removing OpenBot's Podman machine.");
        let removed = computer.remove_machine(own);
        note(
            &mut failures,
            "Couldn't remove OpenBot's Podman machine.",
            removed,
        );
    }
    failures
}

/// A failed step's line: what failed in plain words, then the engine's own.
fn note(failures: &mut Vec<String>, sentence: &str, result: Result<(), String>) {
    if let Err(error) = result {
        failures.push(format!("{sentence} ({error})"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;

    /// A computer that records what was asked of it.
    #[derive(Default)]
    struct Recorded {
        engine: Option<Address>,
        machine: Option<bool>,
        failing: Vec<&'static str>,
        calls: Vec<String>,
    }

    impl Recorded {
        fn with_machine(running: bool) -> Self {
            Self {
                engine: Some(Address::new(
                    Engine::Podman,
                    Some(format!("{}-root", crate::acquire::MACHINE)),
                )),
                machine: Some(running),
                ..Self::default()
            }
        }

        fn result(&mut self, call: String) -> Result<(), String> {
            let failed = self.failing.iter().any(|name| call.starts_with(name));
            self.calls.push(call.clone());
            if failed {
                Err(format!("{call} failed"))
            } else {
                Ok(())
            }
        }
    }

    impl Computer for Recorded {
        fn engine(&mut self, root: &Path) -> Option<Address> {
            self.calls.push(format!("engine {}", root.display()));
            self.engine.clone()
        }
        fn compose_down(&mut self, _engine: &Address, root: &Path) -> Result<(), String> {
            self.result(format!("compose down {}", root.display()))
        }
        fn stop_backend(&mut self, _engine: &Address, root: &Path) -> Result<(), String> {
            self.result(format!("stop backend {}", root.display()))
        }
        fn machine(&mut self, name: &str) -> Result<Option<bool>, String> {
            self.calls.push(format!("machine {name}"));
            Ok(self.machine)
        }
        fn stop_machine(&mut self, name: &str) -> Result<(), String> {
            self.result(format!("stop machine {name}"))
        }
        fn remove_machine(&mut self, name: &str) -> Result<(), String> {
            self.result(format!("remove machine {name}"))
        }
    }

    const KEEP: Asked = Asked {
        remove_machine: false,
    };
    const REMOVE: Asked = Asked {
        remove_machine: true,
    };

    fn run(computer: &mut Recorded, asked: Asked) -> (Vec<String>, Vec<String>) {
        let mut said = Vec::new();
        let failures = stop_with(computer, Path::new("/home/a/OpenBot"), asked, &mut |line| {
            said.push(line.to_string())
        });
        (said, failures)
    }

    /// Uninstalling found OpenBot's machine, its containers and the backend still running with no
    /// app left to stop them. The uninstaller now stops them, and leaves the machine there, stopped.
    #[test]
    fn uninstalling_stops_what_openbot_runs_and_leaves_its_machine_stopped() {
        let mut computer = Recorded::with_machine(true);
        let (said, failures) = run(&mut computer, KEEP);
        assert_eq!(
            computer.calls,
            [
                "engine /home/a/OpenBot",
                "compose down /home/a/OpenBot",
                "stop backend /home/a/OpenBot",
                "machine openbot",
                "stop machine openbot",
            ]
        );
        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(
            said,
            [
                "Stopping OpenBot.",
                "Stopping OpenBot's services.",
                "Stopping OpenBot's Podman machine.",
            ]
        );
    }

    /// "Delete the application data" ticked: OpenBot's machine is removed as well, after it stops.
    #[test]
    fn deleting_the_data_also_removes_openbots_machine() {
        let mut computer = Recorded::with_machine(true);
        let (said, failures) = run(&mut computer, REMOVE);
        assert_eq!(
            computer.calls[3..],
            [
                "machine openbot",
                "stop machine openbot",
                "remove machine openbot"
            ]
        );
        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(said.last().unwrap(), "Removing OpenBot's Podman machine.");
    }

    /// A machine already stopped is not stopped again, and is still removed when asked.
    #[test]
    fn a_stopped_machine_is_left_or_removed_as_asked() {
        let mut computer = Recorded::with_machine(false);
        run(&mut computer, KEEP);
        assert_eq!(computer.calls.last().unwrap(), "machine openbot");

        let mut computer = Recorded::with_machine(false);
        run(&mut computer, REMOVE);
        assert_eq!(
            computer.calls[3..],
            ["machine openbot", "remove machine openbot"]
        );
    }

    /// Docker, or no Podman machine of OpenBot's: the containers stop and no machine is touched.
    #[test]
    fn without_openbots_machine_no_machine_is_touched() {
        let mut computer = Recorded {
            engine: Some(Address::new(Engine::Docker, None)),
            ..Recorded::default()
        };
        run(&mut computer, REMOVE);
        assert!(computer
            .calls
            .iter()
            .all(|call| !call.starts_with("stop machine") && !call.starts_with("remove machine")));
        assert!(computer
            .calls
            .contains(&"compose down /home/a/OpenBot".to_string()));
    }

    /// The only machine named is OpenBot's own, whatever the engine OpenBot ran on: one of the
    /// person's machines is never stopped or removed.
    #[test]
    fn only_openbots_own_machine_is_ever_named() {
        let mut computer = Recorded::with_machine(true);
        computer.engine = Some(Address::new(
            Engine::Podman,
            Some("podman-machine-default-root".into()),
        ));
        run(&mut computer, REMOVE);
        let machines: Vec<&String> = computer
            .calls
            .iter()
            .filter(|call| call.contains("machine"))
            .collect();
        assert!(!machines.is_empty());
        assert!(
            machines.iter().all(|call| call.ends_with(" openbot")),
            "{machines:?}"
        );
    }

    /// No engine answering (OpenBot's machine already stopped, say): nothing to take down, and the
    /// machine is still dealt with.
    #[test]
    fn with_no_engine_answering_only_the_machine_is_dealt_with() {
        let mut computer = Recorded::with_machine(false);
        computer.engine = None;
        let (_, failures) = run(&mut computer, REMOVE);
        assert_eq!(
            computer.calls,
            [
                "engine /home/a/OpenBot",
                "machine openbot",
                "remove machine openbot"
            ]
        );
        assert!(failures.is_empty());
    }

    /// One step failing never keeps the rest from running, and each failure is reported.
    #[test]
    fn a_failed_step_does_not_stop_the_rest() {
        let mut computer = Recorded::with_machine(true);
        computer.failing = vec!["compose down", "stop machine"];
        let (_, failures) = run(&mut computer, REMOVE);
        assert_eq!(computer.calls.len(), 6, "{:?}", computer.calls);
        assert_eq!(failures.len(), 2, "{failures:?}");
        assert!(
            failures[0].starts_with("Couldn't stop OpenBot's containers."),
            "{failures:?}"
        );
        assert!(failures[0].contains("compose down /home/a/OpenBot failed"));
        assert!(failures[1].starts_with("Couldn't stop OpenBot's Podman machine."));
    }

    fn args(list: &[&str]) -> Vec<OsString> {
        std::iter::once("openbot-desktop.exe")
            .chain(list.iter().copied())
            .map(OsString::from)
            .collect()
    }

    #[test]
    fn the_uninstallers_arguments_are_read_and_nothing_else_is() {
        assert_eq!(asked(&args(&[COMMAND])), Some(KEEP));
        assert_eq!(asked(&args(&[COMMAND, REMOVE_MACHINE])), Some(REMOVE));
        assert_eq!(asked(&args(&[])), None);
        assert_eq!(asked(&args(&["openbot://open"])), None);
        assert_eq!(asked(&args(&[REMOVE_MACHINE])), None);
    }

    /// The text of `hooks.nsh`'s macro `name`, between `!macro name` and `!macroend`.
    fn nsis_macro(name: &str) -> String {
        include_str!("../windows/hooks.nsh")
            .split(&format!("!macro {name}\n"))
            .nth(1)
            .and_then(|rest| rest.split("!macroend").next())
            .unwrap_or_else(|| panic!("hooks.nsh has no {name}"))
            .to_string()
    }

    /// The arguments of each `--stop-for-uninstall` run in `text`, as the app receives them.
    fn runs_in(text: &str) -> Vec<Vec<OsString>> {
        text.lines()
            .filter(|line| line.contains(COMMAND))
            .map(|line| {
                let command = line
                    .split("'\"$INSTDIR\\${MAINBINARYNAME}.exe\" ")
                    .nth(1)
                    .and_then(|rest| rest.split('\'').next())
                    .unwrap_or_else(|| panic!("no command in {line}"));
                std::iter::once("openbot-desktop.exe")
                    .chain(command.split(' '))
                    .map(OsString::from)
                    .collect()
            })
            .collect()
    }

    /// The uninstaller runs the stop on a real uninstall only, closes a running OpenBot first, and
    /// asks for the machine to go only when "Delete the application data" is ticked. What it runs
    /// is what the app reads.
    #[test]
    fn the_uninstaller_stops_openbot_on_uninstall_and_removes_the_machine_only_with_the_data() {
        let hook = nsis_macro("NSIS_HOOK_PREUNINSTALL");
        let real = hook
            .split("${If} $UpdateMode <> 1")
            .nth(1)
            .and_then(|rest| rest.split("${EndIf}").next())
            .expect("the stop runs only when $UpdateMode isn't 1");
        assert!(
            real.contains("!insertmacro OPENBOT_STOP_WHAT_OPENBOT_RUNS"),
            "{hook}"
        );
        assert_eq!(hook.matches("OPENBOT_STOP_WHAT_OPENBOT_RUNS").count(), 1);

        let stop = nsis_macro("OPENBOT_STOP_WHAT_OPENBOT_RUNS");
        let close = stop
            .find("!insertmacro CheckIfAppIsRunning")
            .expect("a running OpenBot is closed first");
        assert!(close < stop.find(COMMAND).unwrap());
        let ticked = stop
            .split("${If} $DeleteAppDataCheckboxState = 1")
            .nth(1)
            .and_then(|rest| rest.split("${Else}").next())
            .expect("the box decides whether the machine goes");
        let unticked = stop
            .split("${Else}")
            .nth(1)
            .and_then(|rest| rest.split("${EndIf}").next())
            .unwrap();
        assert_eq!(
            runs_in(ticked)
                .iter()
                .map(|run| asked(run))
                .collect::<Vec<_>>(),
            [Some(REMOVE)]
        );
        assert_eq!(
            runs_in(unticked)
                .iter()
                .map(|run| asked(run))
                .collect::<Vec<_>>(),
            [Some(KEEP)]
        );
        assert_eq!(runs_in(&stop).len(), 2);
    }
}
