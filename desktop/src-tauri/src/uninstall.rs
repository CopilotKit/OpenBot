//! What the Windows uninstaller stops, and with "Delete the application data" removes, before it
//! removes OpenBot.
//!
//! Uninstalling OpenBot from Windows' Apps closed the app and left everything it runs behind:
//! OpenBot's Podman machine (`acquire::MACHINE`), OpenBot's containers in it and the backend's
//! cluster, with no app left to stop them. So the uninstaller first runs this app headless
//! (`NSIS_HOOK_PREUNINSTALL` in `windows/hooks.nsh`), as `openbot-desktop.exe --stop-for-uninstall`,
//! with `--delete-data` added when the person ticked "Delete the application data".
//!
//! It stops what Stop stops, then OpenBot's own machine, and nothing else:
//! - OpenBot's containers, with Compose (`stack::down`), on the engine the installation runs on;
//! - the backend, with the CLI's `local stop`, and only when OpenBot created it;
//! - OpenBot's machine, `openbot`, when there is one.
//!
//! Deleting the data also removes what a new installation would otherwise find and take for its own:
//! the backend OpenBot created (the CLI's `local delete`), OpenBot's machine, and OpenBot's files in
//! the installation folder (`remove_installation`). Box I found why: with the machine gone and the
//! folder left complete, the next install opened on a Start that could never work. Otherwise the
//! machine is left stopped, with everything in it, so installing OpenBot again finds it.
//!
//! The person's own machines and containers are never touched. An OpenBot that ran in a machine of
//! theirs has its containers taken down there, and their machine is left running.
//!
//! Not on an update: the installer runs the old uninstaller with `/UPDATE`, and the hook then leaves
//! everything running for the new version.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use crate::engine::Address;

/// The argument the uninstaller starts the app with.
pub const COMMAND: &str = "--stop-for-uninstall";

/// Added when the person ticked "Delete the application data".
pub const DELETE_DATA: &str = "--delete-data";

/// How long the whole stop may take before the uninstaller goes on without it. The backend's stop
/// alone may take two minutes (`local_eval::Limits::for_quit`).
pub const LIMIT: Duration = Duration::from_secs(5 * 60);

/// What the uninstaller asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Asked {
    pub delete_data: bool,
}

/// The uninstaller's request, from the program's arguments (the program first), or `None` for any
/// other launch. Anything after `--stop-for-uninstall` but `--delete-data` is passed over: a run the
/// uninstaller started must never open the app's window.
pub fn asked(args: &[OsString]) -> Option<Asked> {
    let mut rest = args.iter().skip(1);
    if rest.next()? != COMMAND {
        return None;
    }
    Some(Asked {
        delete_data: rest.any(|arg| arg == DELETE_DATA),
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
    /// The backend deleted with the CLI, when OpenBot created it.
    fn delete_backend(&mut self, engine: &Address, root: &Path) -> Result<(), String>;
    /// The Podman machine `name`: `None` when there is none (or no Podman), else whether it runs.
    fn machine(&mut self, name: &str) -> Result<Option<bool>, String>;
    fn stop_machine(&mut self, name: &str) -> Result<(), String>;
    fn remove_machine(&mut self, name: &str) -> Result<(), String>;
    /// OpenBot's files in the installation folder `root` (`remove_installation`).
    fn remove_installation(&mut self, root: &Path) -> Result<(), String>;
}

/// Stop what OpenBot runs for the installation at `root`, and with `delete_data` remove it, saying
/// each step to `say` in plain words. Every step is tried, whatever happened to the one before.
/// What failed is returned in plain words too, and the engine's own words go to the log.
pub fn stop_with(
    computer: &mut dyn Computer,
    root: &Path,
    asked: Asked,
    say: &mut dyn FnMut(&str),
) -> Vec<String> {
    log::info!(
        "[uninstall] stopping what OpenBot runs for {}{}",
        root.display(),
        if asked.delete_data {
            ", and deleting its data"
        } else {
            ""
        }
    );
    let mut failures = Vec::new();

    // No engine answering: nothing of OpenBot's runs there to take down.
    match computer.engine(root) {
        Some(engine) => {
            log::info!("[uninstall] on {engine:?}");
            say("Stopping OpenBot.");
            let down = computer.compose_down(&engine, root);
            note(
                &mut failures,
                "Couldn't stop OpenBot.",
                "compose down",
                down,
            );
            say("Stopping OpenBot's services.");
            let backend = computer.stop_backend(&engine, root);
            note(
                &mut failures,
                "Couldn't stop OpenBot's services.",
                "the backend's stop",
                backend,
            );
            if asked.delete_data {
                say("Removing OpenBot's services.");
                let deleted = computer.delete_backend(&engine, root);
                note(
                    &mut failures,
                    "Couldn't remove OpenBot's services.",
                    "the backend's delete",
                    deleted,
                );
            }
        }
        None => log::info!("[uninstall] no engine answers for this installation"),
    }

    let own = crate::acquire::MACHINE;
    match computer.machine(own) {
        Ok(Some(running)) => {
            if running {
                say("Stopping the software OpenBot runs on.");
                let stopped = computer.stop_machine(own);
                note(
                    &mut failures,
                    "Couldn't stop the software OpenBot runs on.",
                    &format!("podman machine stop {own}"),
                    stopped,
                );
            }
            if asked.delete_data {
                say("Removing the software OpenBot runs on.");
                let removed = computer.remove_machine(own);
                note(
                    &mut failures,
                    "Couldn't remove the software OpenBot runs on.",
                    &format!("podman machine rm {own}"),
                    removed,
                );
            }
        }
        Ok(None) => log::info!("[uninstall] no Podman machine named {own}"),
        Err(error) => note(
            &mut failures,
            "Couldn't check the software OpenBot runs on.",
            "podman machine list",
            Err(error),
        ),
    }

    // Last, once nothing of OpenBot's runs from it.
    if asked.delete_data {
        say("Removing OpenBot's files.");
        let removed = computer.remove_installation(root);
        note(
            &mut failures,
            "Couldn't remove all of OpenBot's files.",
            "removing the installation's files",
            removed,
        );
    }
    failures
}

/// A failed step: the person's line, and the engine's own words in the log.
fn note(failures: &mut Vec<String>, sentence: &str, step: &str, result: Result<(), String>) {
    match result {
        Ok(()) => log::info!("[uninstall] {step}: done"),
        Err(error) => {
            log::warn!("[uninstall] {step} failed: {error}");
            failures.push(format!("{sentence} Uninstalling anyway."));
        }
    }
}

/// Only OpenBot writes these, so a folder with one of them is an OpenBot installation.
const RECORDS: [&str; 3] = [
    ".openbot-deployment",
    crate::preparation::FILE,
    crate::preparation::ENGINE,
];

/// The installation's own files besides `upgrade::KEPT` and every `.openbot…` record: its settings
/// and keys, the backend's tool's project and the sign-in store the containers keep there, the log of
/// processes an older version ran, and the engine tools OpenBot downloaded.
const OWN: [&str; 6] = [
    ".env",
    ".secrets",
    ".copilotkit",
    ".langchain",
    ".logs",
    "openbot-engine",
];

/// Whether the entry `name` in an installation folder is OpenBot's own.
fn openbots(name: &str) -> bool {
    crate::upgrade::KEPT.contains(&name)
        || OWN.contains(&name)
        || name.starts_with(".openbot")
        || name.starts_with(".env.openbot")
}

/**
OpenBot's files in the installation folder `root`, removed, then the folder itself once nothing else
is left in it: what a new installation would otherwise find and take for its own.

Only a folder OpenBot recorded as an installation, by a record only it writes (`RECORDS`), and never
the home folder `home`, a folder above it or the root of a drive. Inside it only OpenBot's own entries
go (`openbots`): a file of the person's stays, and with it the folder. The backend's tool also leaves
a `.gitignore` in the folder it runs in, which goes only when nothing but it is left. Links are
removed as links, never followed.
*/
pub fn remove_installation(root: &Path, home: Option<&Path>) -> Result<(), String> {
    if !root.is_absolute() || root.parent().is_none() {
        return Err(format!("{} is not a folder OpenBot made", root.display()));
    }
    if let Some(home) = home {
        if root == home || home.starts_with(root) {
            return Err(format!("{} is the home folder or above it", root.display()));
        }
    }
    if !RECORDS.iter().any(|record| root.join(record).exists()) {
        log::info!(
            "[uninstall] {} holds no OpenBot installation; nothing removed",
            root.display()
        );
        return Ok(());
    }
    let entries = |root: &Path| -> Result<Vec<std::fs::DirEntry>, String> {
        std::fs::read_dir(root)
            .and_then(|entries| entries.collect())
            .map_err(|error| format!("{}: {error}", root.display()))
    };
    let remove = |entry: &std::fs::DirEntry| -> Result<(), String> {
        let path = entry.path();
        let directory = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let removed = if directory {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        removed.map_err(|error| format!("{}: {error}", path.display()))
    };
    let mut failed = Vec::new();
    for entry in entries(root)? {
        if openbots(&entry.file_name().to_string_lossy()) {
            if let Err(error) = remove(&entry) {
                failed.push(error);
            }
        }
    }
    let left = entries(root)?;
    if left.iter().all(|entry| entry.file_name() == ".gitignore") {
        for entry in &left {
            if let Err(error) = remove(entry) {
                failed.push(error);
            }
        }
        if let Err(error) = std::fs::remove_dir(root) {
            failed.push(format!("{}: {error}", root.display()));
        }
    } else {
        log::info!(
            "[uninstall] {} keeps files that are not OpenBot's",
            root.display()
        );
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(failed.join("; "))
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
        fn delete_backend(&mut self, _engine: &Address, root: &Path) -> Result<(), String> {
            self.result(format!("delete backend {}", root.display()))
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
        fn remove_installation(&mut self, root: &Path) -> Result<(), String> {
            self.result(format!("remove installation {}", root.display()))
        }
    }

    const KEEP: Asked = Asked { delete_data: false };
    const DELETE: Asked = Asked { delete_data: true };

    fn run(computer: &mut Recorded, asked: Asked) -> (Vec<String>, Vec<String>) {
        let mut said = Vec::new();
        let failures = stop_with(computer, Path::new("/home/a/OpenBot"), asked, &mut |line| {
            said.push(line.to_string())
        });
        (said, failures)
    }

    /// Uninstalling found OpenBot's machine, its containers and the backend still running with no
    /// app left to stop them. The uninstaller now stops them, and leaves the machine there, stopped,
    /// with the installation folder, for a reinstall to find.
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
                "Stopping the software OpenBot runs on.",
            ]
        );
    }

    /// Box I: "Delete the application data" took the machine and left the installation folder whole,
    /// and the next install opened on a Start that could never work. Deleting the data now removes
    /// the backend OpenBot created while its engine still runs, then OpenBot's machine, then its
    /// files, last.
    #[test]
    fn deleting_the_data_removes_the_backend_the_machine_and_the_installation() {
        let mut computer = Recorded::with_machine(true);
        let (said, failures) = run(&mut computer, DELETE);
        assert_eq!(
            computer.calls,
            [
                "engine /home/a/OpenBot",
                "compose down /home/a/OpenBot",
                "stop backend /home/a/OpenBot",
                "delete backend /home/a/OpenBot",
                "machine openbot",
                "stop machine openbot",
                "remove machine openbot",
                "remove installation /home/a/OpenBot",
            ]
        );
        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(
            said,
            [
                "Stopping OpenBot.",
                "Stopping OpenBot's services.",
                "Removing OpenBot's services.",
                "Stopping the software OpenBot runs on.",
                "Removing the software OpenBot runs on.",
                "Removing OpenBot's files.",
            ]
        );
    }

    /// A machine already stopped is not stopped again, and is still removed when asked.
    #[test]
    fn a_stopped_machine_is_left_or_removed_as_asked() {
        let mut computer = Recorded::with_machine(false);
        run(&mut computer, KEEP);
        assert_eq!(computer.calls.last().unwrap(), "machine openbot");

        let mut computer = Recorded::with_machine(false);
        run(&mut computer, DELETE);
        assert_eq!(
            computer.calls[4..],
            [
                "machine openbot",
                "remove machine openbot",
                "remove installation /home/a/OpenBot"
            ]
        );
    }

    /// Docker, or no Podman machine of OpenBot's: the containers stop and no machine is touched.
    /// The installation's files still go when the data is deleted.
    #[test]
    fn without_openbots_machine_no_machine_is_touched() {
        let mut computer = Recorded {
            engine: Some(Address::new(Engine::Docker, None)),
            ..Recorded::default()
        };
        run(&mut computer, DELETE);
        assert!(computer
            .calls
            .iter()
            .all(|call| !call.starts_with("stop machine") && !call.starts_with("remove machine")));
        assert!(computer
            .calls
            .contains(&"compose down /home/a/OpenBot".to_string()));
        assert_eq!(
            computer.calls.last().unwrap(),
            "remove installation /home/a/OpenBot"
        );
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
        run(&mut computer, DELETE);
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
    /// machine and the files are still dealt with.
    #[test]
    fn with_no_engine_answering_only_the_machine_and_the_files_are_dealt_with() {
        let mut computer = Recorded::with_machine(false);
        computer.engine = None;
        let (_, failures) = run(&mut computer, DELETE);
        assert_eq!(
            computer.calls,
            [
                "engine /home/a/OpenBot",
                "machine openbot",
                "remove machine openbot",
                "remove installation /home/a/OpenBot"
            ]
        );
        assert!(failures.is_empty());
    }

    /// One step failing never keeps the rest from running, and each failure is reported.
    #[test]
    fn a_failed_step_does_not_stop_the_rest() {
        let mut computer = Recorded::with_machine(true);
        computer.failing = vec!["compose down", "stop machine"];
        let (_, failures) = run(&mut computer, DELETE);
        assert_eq!(computer.calls.len(), 8, "{:?}", computer.calls);
        // Plain words for the person (box I's details said "computer namespace" and an exit
        // code); the engine's own words go to the log.
        assert_eq!(
            failures,
            [
                "Couldn't stop OpenBot. Uninstalling anyway.",
                "Couldn't stop the software OpenBot runs on. Uninstalling anyway.",
            ]
        );
    }

    /// Nothing the uninstaller shows names the parts inside OpenBot: none of the copy guard's
    /// words (`tests/plain-setup-words.test.ts`), and never an engine's own message.
    #[test]
    fn the_uninstallers_lines_are_plain_words() {
        let mut computer = Recorded::with_machine(true);
        computer.failing = vec![
            "compose down",
            "stop backend",
            "delete backend",
            "stop machine",
            "remove machine",
            "remove installation",
        ];
        let (said, failures) = run(&mut computer, DELETE);
        assert_eq!(failures.len(), 6, "{failures:?}");
        let technical = [
            "podman",
            "engine",
            "container",
            "compose",
            "back end",
            "backend",
            "cluster",
            "namespace",
            "machine",
            "exit",
            "failed",
            "intelligence",
        ];
        for line in said.iter().chain(&failures) {
            let lower = line.to_lowercase();
            for word in technical {
                assert!(!lower.contains(word), "{word} in: {line}");
            }
        }
    }

    /// What box I found left in `~\OpenBot` after "Delete the application data", by name.
    const LEFT_ON_BOX_I: [&str; 18] = [
        ".copilotkit/local.json",
        ".langchain/chatgpt-auth.json",
        ".openbot/marker",
        ".secrets/KEY_ENCRYPTION_KEY.dpapi",
        "openbot-engine/bin/docker-compose.exe",
        ".env",
        ".env.openbot-installation-id",
        ".gitignore",
        ".openbot-deployment",
        ".openbot-desktop-telemetry.yml",
        ".openbot-engine.json",
        ".openbot-launched.json",
        ".openbot-local-eval.json",
        ".openbot-prepared.json",
        ".openbot-project.json",
        ".openbot-saved.json",
        "container-images.json",
        "docker-compose.yml",
    ];

    fn installation(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let home = crate::test_support::temp_root(name);
        let root = home.join("OpenBot");
        for entry in LEFT_ON_BOX_I {
            let path = root.join(entry);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "x").unwrap();
        }
        (home, root)
    }

    #[test]
    fn deleting_the_data_removes_the_whole_installation_folder_openbot_made() {
        let (home, root) = installation("uninstall-whole-folder");
        remove_installation(&root, Some(&home)).unwrap();
        assert!(!root.exists(), "{:?}", std::fs::read_dir(&root).ok());
        assert!(home.exists());
        let _ = std::fs::remove_dir_all(home);
    }

    /// A folder the person chose that holds files of theirs keeps them, and stays.
    #[test]
    fn a_file_of_the_persons_stays_with_its_folder() {
        let (home, root) = installation("uninstall-persons-file");
        std::fs::write(root.join("notes.txt"), "mine").unwrap();
        std::fs::create_dir_all(root.join("photos")).unwrap();
        remove_installation(&root, Some(&home)).unwrap();
        let mut left: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, [".gitignore", "notes.txt", "photos"]);
        let _ = std::fs::remove_dir_all(home);
    }

    /// Never the home folder, a folder above it, a drive's root, or a folder OpenBot didn't record.
    #[test]
    fn only_a_folder_openbot_recorded_is_ever_touched() {
        let (home, root) = installation("uninstall-refusals");
        // The home folder itself, holding OpenBot's records, and the folder above it.
        for entry in LEFT_ON_BOX_I {
            let path = home.join(entry);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "x").unwrap();
        }
        assert!(remove_installation(&home, Some(&home)).is_err());
        assert!(remove_installation(home.parent().unwrap(), Some(&home)).is_err());
        assert!(home.join(".env").exists());
        let drive = Path::new(if cfg!(windows) { "C:\\" } else { "/" });
        assert!(remove_installation(drive, Some(&home)).is_err());
        assert!(remove_installation(Path::new("OpenBot"), Some(&home)).is_err());

        // A folder with none of OpenBot's records: nothing in it goes.
        for record in RECORDS {
            std::fs::remove_file(root.join(record)).unwrap();
        }
        remove_installation(&root, Some(&home)).unwrap();
        assert!(root.join(".env").exists());
        assert!(root.join(".secrets").exists());
        let _ = std::fs::remove_dir_all(home);
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
        assert_eq!(asked(&args(&[COMMAND, DELETE_DATA])), Some(DELETE));
        assert_eq!(asked(&args(&[])), None);
        assert_eq!(asked(&args(&["openbot://open"])), None);
        assert_eq!(asked(&args(&[DELETE_DATA])), None);
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
    /// asks for the data to go only when "Delete the application data" is ticked. What it runs is
    /// what the app reads.
    #[test]
    fn the_uninstaller_stops_openbot_on_uninstall_and_deletes_only_with_the_data() {
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
            .expect("the box decides whether the data goes");
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
            [Some(DELETE)]
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
