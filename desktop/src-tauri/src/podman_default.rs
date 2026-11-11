//! The person's default Podman connection stays theirs.
//!
//! Podman keeps one default connection, the engine every `podman` command reaches when it names
//! none, in `podman-connections.json` (`%APPDATA%\containers` on Windows, `~/.config/containers`
//! elsewhere: `connectionsConfigFile` in go.podman.io/common's `pkg/config/connections.go`). OpenBot
//! reaches its own machine by name and never needs the default (see `acquire::address`). Yet three
//! of the commands it runs can move it, in Podman 6.1.1:
//!
//! - **`podman machine rm` always picks a new default**, even when the machine it removes was not
//!   the default: `podman-machine-default` when there is one, and otherwise whichever connection
//!   Go's map iteration yields first (`setNewDefaultConnection` in
//!   `pkg/machine/connection/connection.go`). Go randomises that order. With the person's `mine` and
//!   `mine-root` left, it lands on `mine-root` about one time in eight. Box I: `mine` was the
//!   default at 08:15, the ticked uninstall removed `openbot` at 08:17, at 08:18 `podman machine
//!   list` no longer marked `mine` as the default, and the connection list said `mine-root`. The
//!   three removals before it on the same computer happened to land on `mine`.
//! - **`podman machine init`** makes the new machine's connection the default only when there were
//!   no connections at all (`addConnection`). But an init that fails after adding its connections
//!   removes them again (`shim.Init`'s cleanup), which picks a new default as `rm` does.
//! - **`podman machine start`** makes the machine's connection the default with
//!   `--update-connection`, or when the person answers yes to "Set the default Podman connection to
//!   this machine? [y/N]", which is asked only when stdin is a terminal (`startLocked` and
//!   `promptUpdateSystemConn` in `pkg/machine/shim/host.go`). OpenBot's commands have no terminal.
//!
//! So every `machine init`, `machine start` and `machine rm` OpenBot runs goes through `keeping`.
//! Init and start are told to leave the default alone wherever Podman takes the flag
//! (`--update-connection=false`, Podman 6.0 and later; 5.8 answers "unknown flag"). After each of
//! the three, a default that moved is put back by its exact name. Removing OpenBot's own machine
//! while one of its connections is the default leaves the default the person had before OpenBot
//! made its machine (`Before`), or none: never one of the person's connections picked for them.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::acquire::MACHINE;
use crate::engine_versions::Version;

/// Tells `machine init` and `machine start` to leave the default connection alone.
pub const LEAVE_DEFAULT: &str = "--update-connection=false";

/// The first Podman that takes `LEAVE_DEFAULT`: `cmd/podman/machine/start.go` has no such flag in
/// 5.8.0, and has it from 6.0.0.
const LEAVE_DEFAULT_SINCE: Version = Version::new(6, 0, 0);

/// Podman's connections, as `podman system connection list --format json` lists them.
pub const LIST: [&str; 5] = ["system", "connection", "list", "--format", "json"];

/// The connections there are, by name, and the default among them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Connections {
    pub names: Vec<String>,
    pub default: Option<String>,
}

/// `LIST`'s answer read. Podman lists `Default` true on one connection at most.
pub fn connections_in(listing: &str) -> Result<Connections, String> {
    #[derive(Deserialize)]
    struct Listed {
        #[serde(rename = "Name")]
        name: String,
        #[serde(rename = "Default", default)]
        default: bool,
    }
    let listed: Vec<Listed> = serde_json::from_str(listing).map_err(|error| {
        format!("could not read podman system connection list JSON: {error}; stdout: {listing}")
    })?;
    let default = listed
        .iter()
        .find(|connection| connection.default)
        .map(|connection| connection.name.clone());
    Ok(Connections {
        names: listed
            .into_iter()
            .map(|connection| connection.name)
            .collect(),
        default,
    })
}

/// One of OpenBot's own machine's connections: `openbot`, or `openbot-root` (`acquire::connection_for`).
pub fn is_ours(connection: &str) -> bool {
    crate::acquire::machine_of(connection) == MACHINE
}

/// The default connection before OpenBot made its machine, kept until the machine is removed.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Before {
    pub default: Option<String>,
}

/// What `keeping` needs of a computer's Podman.
pub trait Podman {
    /// A `podman` command as it is: its standard output, or why it failed.
    fn run(&mut self, args: &[&str]) -> Result<String, String>;
    /// Podman left with no default connection, provided the default is still `was`. Podman's own
    /// `system connection rm` leaves it so when it removes the default; no command does it alone.
    fn clear_default(&mut self, was: &str) -> Result<(), String>;
    /// What `remember` kept, if anything.
    fn before(&mut self) -> Option<Before>;
    fn remember(&mut self, before: &Before);
    fn forget(&mut self);
}

/// What a Podman command can do to the default connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Moves {
    Init { ours: bool },
    Start,
    Remove { ours: bool },
}

fn moves(args: &[&str]) -> Option<Moves> {
    let ["machine", verb, rest @ ..] = args else {
        return None;
    };
    // The machine is the first word that is not a flag, as OpenBot writes its commands.
    let ours = rest.iter().find(|word| !word.starts_with('-')).copied() == Some(MACHINE);
    match *verb {
        "init" => Some(Moves::Init { ours }),
        "start" => Some(Moves::Start),
        "rm" => Some(Moves::Remove { ours }),
        _ => None,
    }
}

/// Run `args` with `podman`, and leave the default connection as the person had it.
///
/// Anything but `machine init`, `start` and `rm` runs as it is. Those three are run with the default
/// read before and after, and a default that moved is put back (`put_back`). What it goes back to:
/// - the default from before the command, by its exact name;
/// - when the command removes OpenBot's machine and one of its connections was the default: the
///   default from before OpenBot made the machine (`Before`), or none;
/// - none when there was none, unless the default Podman set is OpenBot's own: Podman makes the
///   first connection there is the default, and that is not one of the person's.
pub fn keeping(podman: &mut dyn Podman, args: &[&str]) -> Result<String, String> {
    let Some(moves) = moves(args) else {
        return podman.run(args);
    };
    let told = told_to_leave_default(podman, args, moves);
    let before = match listed(podman) {
        Ok(before) => before,
        Err(error) => {
            log::warn!(
                "[engine] could not read Podman's connections before `podman {}`, so its default \
                 connection is not looked after: {error}",
                told.join(" ")
            );
            return podman.run(&told);
        }
    };
    let wanted = match (moves, before.default.as_deref()) {
        (Moves::Remove { ours: true }, Some(default)) if is_ours(default) => {
            podman.before().and_then(|kept| kept.default)
        }
        _ => before.default.clone(),
    };
    let done = podman.run(&told);
    match moves {
        // A default that is OpenBot's own already is no default of the person's to keep.
        Moves::Init { ours: true }
            if done.is_ok() && !before.default.as_deref().is_some_and(is_ours) =>
        {
            podman.remember(&Before {
                default: before.default.clone(),
            });
        }
        Moves::Remove { ours: true } if done.is_ok() => podman.forget(),
        _ => {}
    }
    // Also after a failure: an init that fails removes the connections it added, which picks a
    // new default.
    put_back(podman, wanted, &told);
    done
}

/// `args`, with `LEAVE_DEFAULT` for an init or a start when this Podman takes it.
fn told_to_leave_default<'a>(
    podman: &mut dyn Podman,
    args: &[&'a str],
    moves: Moves,
) -> Vec<&'a str> {
    let mut told = args.to_vec();
    if matches!(moves, Moves::Init { .. } | Moves::Start) {
        let version = podman.run(&["--version"]);
        if version
            .as_deref()
            .ok()
            .and_then(Version::find)
            .is_some_and(|version| version >= LEAVE_DEFAULT_SINCE)
        {
            told.push(LEAVE_DEFAULT);
        } else {
            log::info!(
                "[engine] `podman machine {}` without {LEAVE_DEFAULT}, which this Podman does not \
                 take ({})",
                args[1],
                version.unwrap_or_else(|error| error)
            );
        }
    }
    told
}

fn listed(podman: &mut dyn Podman) -> Result<Connections, String> {
    connections_in(&podman.run(&LIST)?)
}

/// The default back to `wanted` after `podman <command>`, if it moved.
fn put_back(podman: &mut dyn Podman, wanted: Option<String>, command: &[&str]) {
    let command = command.join(" ");
    let after = match listed(podman) {
        Ok(after) => after,
        Err(error) => {
            log::warn!(
                "[engine] could not read Podman's connections after `podman {command}`, so its \
                 default connection is not looked after: {error}"
            );
            return;
        }
    };
    // A connection that is gone cannot be the default again: none, then.
    let wanted = wanted.filter(|name| after.names.contains(name));
    if after.default == wanted {
        return;
    }
    let moved_to = after.default.as_deref().unwrap_or("none");
    match (wanted, after.default.as_deref()) {
        (Some(name), _) => match podman.run(&["system", "connection", "default", &name]) {
            Ok(_) => log::info!(
                "[engine] `podman {command}` made {moved_to} Podman's default connection; set back \
                 to {name}"
            ),
            Err(error) => log::warn!(
                "[engine] `podman {command}` made {moved_to} Podman's default connection, and it \
                 could not be set back to {name}: {error}"
            ),
        },
        (None, Some(picked)) if !is_ours(picked) => match podman.clear_default(picked) {
            Ok(()) => log::info!(
                "[engine] `podman {command}` made {picked} Podman's default connection, where there \
                 was none of the person's; set back to none"
            ),
            Err(error) => log::warn!(
                "[engine] `podman {command}` made {picked} Podman's default connection, and it \
                 could not be set back to none: {error}"
            ),
        },
        // OpenBot's own, made the default because it was the first connection there was.
        (None, _) => {}
    }
}

/// This computer's Podman, the one `acquire` runs.
pub struct ThisComputer;

impl Podman for ThisComputer {
    fn run(&mut self, args: &[&str]) -> Result<String, String> {
        crate::acquire::podman_as_is(args)
    }

    fn clear_default(&mut self, was: &str) -> Result<(), String> {
        let path = connections_file()
            .ok_or_else(|| "this computer has no folder for Podman's connections".to_string())?;
        clear_default_in(&path, was)
    }

    fn before(&mut self) -> Option<Before> {
        std::fs::read(record_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }

    fn remember(&mut self, before: &Before) {
        if let Err(error) = write_record(&record_path(), before) {
            log::warn!("[engine] could not keep Podman's default connection from before: {error}");
        }
    }

    fn forget(&mut self) {
        match std::fs::remove_file(record_path()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => log::warn!(
                "[engine] could not remove the record of Podman's default connection: {error}"
            ),
        }
    }
}

/// Where `Before` is kept: beside the engine files OpenBot downloads, as `own_machine::record_path`.
pub fn record_path() -> PathBuf {
    crate::acquire::download_dir(&crate::stack::default_root()).join("podman-default-before.json")
}

fn write_record(path: &Path, before: &Before) -> Result<(), String> {
    let folder = path
        .parent()
        .ok_or_else(|| format!("{} has no folder", path.display()))?;
    std::fs::create_dir_all(folder).map_err(|error| format!("{}: {error}", folder.display()))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("{} has no file name", path.display()))?;
    crate::preparation::write_checkpoint(folder, name, before)
}

/// Podman's connections file: `PODMAN_CONNECTIONS_CONF`, or `podman-connections.json` in the
/// person's `containers` configuration folder (`connectionsConfigFile` in go.podman.io/common, and
/// `UserConfigPath` in go.podman.io/storage's `pkg/configfile`: `%APPDATA%` on Windows,
/// `$XDG_CONFIG_HOME` or `~/.config` elsewhere).
fn connections_file() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PODMAN_CONNECTIONS_CONF") {
        return Some(PathBuf::from(path));
    }
    let folder = if cfg!(windows) {
        PathBuf::from(std::env::var_os("APPDATA")?)
    } else {
        match std::env::var_os("XDG_CONFIG_HOME") {
            Some(home) => PathBuf::from(home),
            None => dirs::home_dir()?.join(".config"),
        }
    };
    Some(folder.join("containers").join("podman-connections.json"))
}

/// The default connection in the connections file at `path` removed, provided it is still `was`.
///
/// Under Podman's own lock, `<path>.lock`, which `EditConnectionConfig` takes for every change it
/// makes: on Windows both are `LockFileEx` over the whole file. Everything else in the file is
/// written back as it was read, and the file replaced in one rename, as Podman writes it.
pub fn clear_default_in(path: &Path, was: &str) -> Result<(), String> {
    let mut lock_path = path.as_os_str().to_owned();
    lock_path.push(".lock");
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .map_err(|error| format!("{}: {error}", Path::new(&lock_path).display()))?;
    lock.lock()
        .map_err(|error| format!("{}: {error}", Path::new(&lock_path).display()))?;
    let bytes = std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut file: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", path.display()))?;
    let connection = file
        .get_mut("Connection")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| format!("{} has no connections", path.display()))?;
    let now = connection
        .get("Default")
        .and_then(serde_json::Value::as_str);
    if now != Some(was) {
        return Err(format!(
            "{}: the default connection is {} now, not {was}",
            path.display(),
            now.unwrap_or("none")
        ));
    }
    // Podman writes no `Default` when there is none (`json:",omitempty"`).
    connection.remove("Default");
    let bytes = serde_json::to_vec(&file).map_err(|error| error.to_string())?;
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".openbot");
    std::fs::write(&temporary, bytes)
        .map_err(|error| format!("{}: {error}", Path::new(&temporary).display()))?;
    std::fs::rename(&temporary, path).map_err(|error| format!("{}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// Box I's connections after the flip, as `podman system connection list --format json` printed
    /// them there (Podman 6.1.1, Windows Server 2022, WSL).
    const BOX_I_AFTER: &str = include_str!("../test-fixtures/podman-connections/box-i-after.json");

    /// Podman 6.1.1's connections as a model: what `init`, `start`, `rm`, `system connection list`
    /// and `system connection default` do to them, read from its source (`pkg/machine/connection`,
    /// `pkg/machine/shim/host.go`, `cmd/podman/system/connection`), and listed in its format.
    struct Fake {
        version: &'static str,
        /// Name to (URI, identity), sorted as Podman sorts its list.
        connections: BTreeMap<String, (String, String)>,
        default: Option<String>,
        /// Machine to whether it is rootful (`provider.GetAllMachinesAndRootfulness`).
        machines: BTreeMap<String, bool>,
        /// The connection Go's map iteration yields first when `rm` picks a new default. Random in
        /// Podman; `None` for the first by name.
        draw: Option<&'static str>,
        /// The person answering yes at `machine start`'s terminal prompt, or a Podman that moved
        /// the default regardless.
        start_takes_default: bool,
        kept: Option<Before>,
        calls: Vec<String>,
    }

    impl Fake {
        /// The computer `listing` describes, with `default` as its default connection.
        fn from_listing(listing: &str, default: Option<&str>) -> Self {
            #[derive(Deserialize)]
            struct Listed {
                #[serde(rename = "Name")]
                name: String,
                #[serde(rename = "URI")]
                uri: String,
                #[serde(rename = "Identity")]
                identity: String,
            }
            let listed: Vec<Listed> = serde_json::from_str(listing).unwrap();
            let connections: BTreeMap<_, _> = listed
                .into_iter()
                .map(|connection| (connection.name, (connection.uri, connection.identity)))
                .collect();
            let machines = connections
                .keys()
                .filter(|name| !name.ends_with("-root"))
                .map(|name| (name.clone(), false))
                .collect();
            Self {
                version: "podman version 6.1.1",
                connections,
                default: default.map(str::to_string),
                machines,
                draw: None,
                start_takes_default: false,
                kept: None,
                calls: Vec::new(),
            }
        }

        fn list(&self) -> String {
            let rows: Vec<serde_json::Value> = self
                .connections
                .iter()
                .map(|(name, (uri, identity))| {
                    serde_json::json!({
                        "Name": name,
                        "URI": uri,
                        "Identity": identity,
                        "IsMachine": true,
                        "Default": self.default.as_deref() == Some(name.as_str()),
                        "ReadWrite": true,
                    })
                })
                .collect();
            serde_json::to_string_pretty(&rows).unwrap()
        }

        fn takes_leave_default(&self) -> bool {
            Version::find(self.version).is_some_and(|version| version >= LEAVE_DEFAULT_SINCE)
        }

        /// `RemoveConnections`: the names deleted, then a new default picked whatever it was.
        fn remove_connections(&mut self, name: &str) {
            for connection in [name.to_string(), format!("{name}-root")] {
                self.connections.remove(&connection);
                if self.default.as_deref() == Some(connection.as_str()) {
                    self.default = None;
                }
            }
            let picked = if self.connections.contains_key("podman-machine-default") {
                Some("podman-machine-default".to_string())
            } else {
                self.draw
                    .filter(|draw| self.connections.contains_key(*draw))
                    .map(str::to_string)
                    .or_else(|| self.connections.keys().next().cloned())
            };
            if let Some(picked) = picked {
                // `updateConnection`: a rootful machine's own name moves to its `-root`.
                let rootful = self.machines.get(&picked).copied().unwrap_or(false);
                self.default = Some(if rootful {
                    format!("{picked}-root")
                } else {
                    picked
                });
            }
        }
    }

    impl Podman for Fake {
        fn run(&mut self, args: &[&str]) -> Result<String, String> {
            self.calls.push(args.join(" "));
            if args
                .iter()
                .any(|arg| arg.starts_with("--update-connection"))
                && !self.takes_leave_default()
            {
                return Err("Error: unknown flag: --update-connection".into());
            }
            match args {
                ["--version"] => Ok(self.version.to_string()),
                args if args == LIST => Ok(self.list()),
                ["system", "connection", "default", name] => {
                    if !self.connections.contains_key(*name) {
                        return Err(format!(
                            "Error: \"{name}\" destination is not defined. See \"podman system connection add ...\" to create a connection"
                        ));
                    }
                    self.default = Some(name.to_string());
                    Ok(String::new())
                }
                ["machine", "init", name, flags @ ..] => {
                    let name = name.to_string();
                    for connection in [name.clone(), format!("{name}-root")] {
                        if self.connections.contains_key(&connection) {
                            return Err(format!("Error: system connection \"{connection}\" already exists. consider a different machine name or remove the connection with `podman system connection rm`"));
                        }
                    }
                    let rootful = flags.contains(&"--rootful");
                    let mut made = vec![name.clone(), format!("{name}-root")];
                    // `AddSSHConnectionsToPodmanSocket`: the rootful one first when rootful.
                    if rootful {
                        made.reverse();
                    }
                    let first = self.connections.is_empty();
                    for connection in &made {
                        let user = if connection.ends_with("-root") {
                            "root@127.0.0.1:56970/run/podman/podman.sock"
                        } else {
                            "user@127.0.0.1:56970/run/user/1000/podman/podman.sock"
                        };
                        self.connections.insert(
                            connection.clone(),
                            (
                                format!("ssh://{user}"),
                                r"C:\Users\Administrator\.local\share\containers\podman\machine\machine".into(),
                            ),
                        );
                    }
                    // `addConnection`: the first connection there is becomes the default.
                    if first {
                        self.default = Some(made[0].clone());
                    }
                    self.machines.insert(name, rootful);
                    Ok("Machine init complete".into())
                }
                ["machine", "start", name, flags @ ..] => {
                    let rootful = self.machines.get(*name).copied().unwrap_or(false);
                    let connection = if rootful {
                        format!("{name}-root")
                    } else {
                        name.to_string()
                    };
                    let told = flags
                        .iter()
                        .find_map(|flag| flag.strip_prefix("--update-connection="));
                    if told == Some("true") || (told.is_none() && self.start_takes_default) {
                        self.default = Some(connection);
                    }
                    Ok(format!("Machine \"{name}\" started successfully"))
                }
                ["machine", "rm", .., name] => {
                    let name = name.to_string();
                    if self.machines.remove(&name).is_none() {
                        return Err(format!("Error: {name}: VM does not exist"));
                    }
                    self.remove_connections(&name);
                    Ok(String::new())
                }
                _ => Ok(String::new()),
            }
        }

        fn clear_default(&mut self, was: &str) -> Result<(), String> {
            self.calls.push(format!("clear default {was}"));
            if self.default.as_deref() != Some(was) {
                return Err(format!("the default is not {was}"));
            }
            self.default = None;
            Ok(())
        }

        fn before(&mut self) -> Option<Before> {
            self.kept.clone()
        }

        fn remember(&mut self, before: &Before) {
            self.kept = Some(before.clone());
        }

        fn forget(&mut self) {
            self.kept = None;
        }
    }

    fn default_of(podman: &mut Fake) -> Option<String> {
        connections_in(&podman.list()).unwrap().default
    }

    /// OpenBot's create, as `acquire::create_machine` runs it on Windows from a downloaded image.
    fn create(podman: &mut Fake) {
        let created = crate::acquire::create_machine_with(
            4,
            6144,
            60,
            Some(Path::new(
                r"C:\Users\Administrator\OpenBot\openbot-engine\machine.tar.zst",
            )),
            || Ok(false),
            || {},
            |args| keeping(podman, args),
        );
        assert!(created.ok, "{created:?}");
    }

    fn start(podman: &mut Fake) {
        keeping(podman, &["machine", "start", MACHINE]).unwrap();
    }

    /// Box I: the person's own `mine`, the default, beside OpenBot's `openbot`. A ticked uninstall
    /// removed `openbot` and a fresh install created it again; afterwards `mine-root` was the
    /// default. Podman's removal picked it (see the module comment). Through `keeping`, the same
    /// draw changes nothing the person sees.
    #[test]
    fn box_i_ticked_uninstall_then_fresh_install_leaves_mine_the_default() {
        let box_i = |draw| {
            let mut podman = Fake::from_listing(BOX_I_AFTER, Some("mine"));
            podman.machines.insert(MACHINE.into(), true);
            podman.draw = Some(draw);
            podman
        };

        // Podman as it is lands where box I did, with the list it printed there.
        let mut podman = box_i("mine-root");
        crate::acquire::remove_machine_with(MACHINE, |args| podman.run(args)).unwrap();
        create(&mut podman);
        let mut as_is = podman;
        let observed: serde_json::Value = serde_json::from_str(BOX_I_AFTER).unwrap();
        let listed: serde_json::Value = serde_json::from_str(&as_is.list()).unwrap();
        assert_eq!(listed, observed);
        assert_eq!(default_of(&mut as_is).as_deref(), Some("mine-root"));

        // Through `keeping`, on each of the draws Podman can make.
        for draw in ["mine-root", "mine"] {
            let mut podman = box_i(draw);
            crate::acquire::remove_machine_with(MACHINE, |args| keeping(&mut podman, args))
                .unwrap();
            assert_eq!(
                default_of(&mut podman).as_deref(),
                Some("mine"),
                "after the uninstall, drawing {draw}: {:#?}",
                podman.calls
            );
            create(&mut podman);
            start(&mut podman);
            assert_eq!(
                default_of(&mut podman).as_deref(),
                Some("mine"),
                "after the install, drawing {draw}: {:#?}",
                podman.calls
            );
            assert_eq!(
                connections_in(&podman.list()).unwrap().names,
                ["mine", "mine-root", "openbot", "openbot-root"]
            );
        }
    }

    /// OpenBot's own machine was the default when it was removed: the default goes back to the one
    /// the person had before OpenBot made its machine, or to none. Never to a connection Podman
    /// picked for them, `podman-machine-default` included.
    #[test]
    fn removing_openbots_machine_while_it_is_the_default_never_picks_one_of_the_persons() {
        let listing = r#"[
            {"Name":"mine","URI":"ssh://user@127.0.0.1:62515/run/user/1000/podman/podman.sock","Identity":"i","IsMachine":true,"Default":true,"ReadWrite":true},
            {"Name":"mine-root","URI":"ssh://root@127.0.0.1:62515/run/podman/podman.sock","Identity":"i","IsMachine":true,"Default":false,"ReadWrite":true}
        ]"#;

        // Made beside the person's `mine`, then made the default by the person.
        let mut podman = Fake::from_listing(listing, Some("mine"));
        podman.draw = Some("mine-root");
        create(&mut podman);
        assert_eq!(
            podman.kept,
            Some(Before {
                default: Some("mine".into())
            })
        );
        podman
            .run(&["system", "connection", "default", "openbot-root"])
            .unwrap();
        crate::acquire::remove_machine_with(MACHINE, |args| keeping(&mut podman, args)).unwrap();
        assert_eq!(default_of(&mut podman).as_deref(), Some("mine"));
        assert_eq!(podman.kept, None, "the record goes with the machine");

        // Made when there were no connections at all: Podman made OpenBot's the default, and the
        // person's machines came later. Nothing was the default before OpenBot's, so none is.
        for theirs in ["mine", "podman-machine-default"] {
            let mut podman = Fake::from_listing("[]", None);
            create(&mut podman);
            assert_eq!(default_of(&mut podman).as_deref(), Some("openbot-root"));
            assert_eq!(podman.kept, Some(Before { default: None }));
            podman.run(&["machine", "init", theirs]).unwrap();
            assert_eq!(default_of(&mut podman).as_deref(), Some("openbot-root"));
            crate::acquire::remove_machine_with(MACHINE, |args| keeping(&mut podman, args))
                .unwrap();
            assert_eq!(
                default_of(&mut podman),
                None,
                "{theirs}: {:#?}",
                podman.calls
            );
            assert_eq!(
                connections_in(&podman.list()).unwrap().names,
                [theirs.to_string(), format!("{theirs}-root")]
            );
        }

        // Made by a release that kept no record: none, too.
        let mut podman = Fake::from_listing(listing, Some("mine"));
        podman
            .run(&["machine", "init", "openbot", "--rootful"])
            .unwrap();
        podman
            .run(&["system", "connection", "default", "openbot-root"])
            .unwrap();
        crate::acquire::remove_machine_with(MACHINE, |args| keeping(&mut podman, args)).unwrap();
        assert_eq!(default_of(&mut podman), None, "{:#?}", podman.calls);
    }

    /// Init and start are told to leave the default alone where Podman takes the flag, and a
    /// default that moved anyway goes back to the person's by its exact name.
    #[test]
    fn init_and_start_leave_the_default_where_podman_can_be_told_and_put_it_back_where_not() {
        let listing = r#"[
            {"Name":"mine","URI":"ssh://user@127.0.0.1:62515/run/user/1000/podman/podman.sock","Identity":"i","IsMachine":true,"Default":true,"ReadWrite":true},
            {"Name":"mine-root","URI":"ssh://root@127.0.0.1:62515/run/podman/podman.sock","Identity":"i","IsMachine":true,"Default":false,"ReadWrite":true}
        ]"#;
        let mut podman = Fake::from_listing(listing, Some("mine-root"));
        create(&mut podman);
        start(&mut podman);
        let told: Vec<_> = podman
            .calls
            .iter()
            .filter(|call| call.starts_with("machine init") || call.starts_with("machine start"))
            .collect();
        assert_eq!(told.len(), 2, "{told:?}");
        assert!(
            told.iter().all(|call| call.ends_with(LEAVE_DEFAULT)),
            "{told:?}"
        );
        assert_eq!(default_of(&mut podman).as_deref(), Some("mine-root"));

        // Podman 5.8 has no such flag and would refuse the command: it is not passed, and a start
        // that took the default anyway (a yes at Podman's prompt) has it put back.
        let mut podman = Fake::from_listing(listing, Some("mine-root"));
        podman.version = "podman version 5.8.9";
        podman.start_takes_default = true;
        create(&mut podman);
        start(&mut podman);
        assert!(
            !podman
                .calls
                .iter()
                .any(|call| call.contains("--update-connection")),
            "{:#?}",
            podman.calls
        );
        assert!(
            podman
                .calls
                .contains(&"system connection default mine-root".to_string()),
            "{:#?}",
            podman.calls
        );
        assert_eq!(default_of(&mut podman).as_deref(), Some("mine-root"));

        // The person's own machine, started again by OpenBot after a pause on a Mac.
        let mut podman = Fake::from_listing(listing, Some("mine-root"));
        podman.start_takes_default = true;
        keeping(&mut podman, &["machine", "start", "mine"]).unwrap();
        assert_eq!(default_of(&mut podman).as_deref(), Some("mine-root"));

        // The first connection there is: Podman makes it the default, and it stays.
        let mut podman = Fake::from_listing("[]", None);
        create(&mut podman);
        start(&mut podman);
        assert_eq!(default_of(&mut podman).as_deref(), Some("openbot-root"));
        assert!(
            !podman.calls.iter().any(|call| call.starts_with("clear")),
            "{:#?}",
            podman.calls
        );
    }

    /// `clear_default_in` on a connections file as Podman writes it: the default removed only while
    /// it is still the one picked, and everything else kept.
    #[test]
    fn clearing_the_default_keeps_the_rest_of_podmans_file_and_only_the_default_it_was_asked_for() {
        let root = crate::test_support::temp_root("podman-default");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("podman-connections.json");
        let written = r#"{"Connection":{"Default":"mine-root","Connections":{"mine":{"URI":"ssh://user@127.0.0.1:62515/run/user/1000/podman/podman.sock","Identity":"C:\\Users\\Administrator\\.local\\share\\containers\\podman\\machine\\machine","IsMachine":true},"mine-root":{"URI":"ssh://root@127.0.0.1:62515/run/podman/podman.sock","Identity":"C:\\Users\\Administrator\\.local\\share\\containers\\podman\\machine\\machine","IsMachine":true}}},"Farm":{}}
"#;
        std::fs::write(&path, written).unwrap();

        let refused = clear_default_in(&path, "mine").unwrap_err();
        assert!(refused.contains("mine-root now"), "{refused}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), written);

        clear_default_in(&path, "mine-root").unwrap();
        let mut expected: serde_json::Value = serde_json::from_str(written).unwrap();
        expected["Connection"]
            .as_object_mut()
            .unwrap()
            .remove("Default");
        let now: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(now, expected);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn openbots_connections_are_told_from_the_persons() {
        assert!(is_ours("openbot"));
        assert!(is_ours("openbot-root"));
        for theirs in ["mine", "mine-root", "openbot-old", "podman-machine-default"] {
            assert!(!is_ours(theirs), "{theirs}");
        }
        assert_eq!(
            moves(&["machine", "rm", "--force", "openbot"]),
            Some(Moves::Remove { ours: true })
        );
        assert_eq!(
            moves(&["machine", "rm", "--force", "mine"]),
            Some(Moves::Remove { ours: false })
        );
        assert_eq!(
            moves(&["machine", "init", "openbot", "--rootful"]),
            Some(Moves::Init { ours: true })
        );
        assert_eq!(moves(&["machine", "inspect", "openbot"]), None);
        assert_eq!(
            moves(&["--connection", "openbot-root", "start", "abc"]),
            None
        );
    }
}
