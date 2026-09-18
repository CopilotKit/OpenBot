//! The container engine: find one, install one, and prove it answers.
//!
//! Everything here was learned by running the stack on all three platforms rather than from the
//! documentation, and the three differ more than they look:
//!
//! - **macOS.** `podman machine` puts a Linux VM behind a socket. Inside that VM
//!   `/var/run/docker.sock` is already a symlink to the rootless socket, so Compose's mount needs no
//!   help and `ENGINE_SOCKET` stays unset. `applehv` is the default on Apple silicon as of Podman
//!   6.1, so no `--provider` is passed.
//! - **Linux.** Podman is native and rootless and there is no VM. `/var/run/docker.sock` is either
//!   absent or, with `podman-docker` installed, a symlink to the *rootful* socket, which is not the
//!   one running. `ENGINE_SOCKET` has to name `$XDG_RUNTIME_DIR/podman/podman.sock` or the
//!   supervisor is handed a dead socket and reports that it cannot reach Docker.
//! - **Windows.** `podman machine` again, on WSL2, and the same in-VM symlink as macOS. WSL refuses
//!   to run as LocalSystem, so none of this can be done from a service; see `windows.rs`.
//!
//! A second rule was learned the same way: **never assume the engine is on this process's PATH.**
//! When OpenBot installs Podman itself, the installer extends the *user's* PATH, and this process
//! was started with the old one. `podman` then cannot be run for the rest of the session, so the
//! app reports no engine while `podman.exe` sits on disk where it was just put. Every engine
//! command is therefore built from a resolved path, and the Compose provider OpenBot placed is put
//! on the child's PATH. See `install.rs`.
//!
//! One rule cuts across all three: **never address Podman through its ambient default connection.**
//! `podman` sends every command to whichever machine is marked default, and that machine belongs to
//! whoever made it. A person with a stopped machine of their own gets `Cannot connect to Podman`
//! from a machine of ours that is running perfectly well, which reads as our bug and is unfixable
//! from the error. So the engine is carried as an `Address` and every invocation names its
//! connection. Managed Docker runs likewise pin their effective context or host before Compose up.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use crate::quiet::command;

use serde::{Deserialize, Serialize};

/// Which engine is in use, because the answer changes what is mounted and what is reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Engine {
    /// Docker Desktop, OrbStack, Colima, or a Docker daemon by any other name.
    Docker,
    Podman,
}

impl Engine {
    pub fn binary(self) -> &'static str {
        match self {
            Engine::Docker => "docker",
            Engine::Podman => "podman",
        }
    }
}

/// How to talk to the engine: which binary, and which connection when the default is not ours.
///
/// `--connection` and not `DOCKER_HOST`: Podman ignores `DOCKER_HOST` when choosing its own
/// connection, and the flag is the only form that also reaches the Compose provider, which is where
/// most of the work happens.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Address {
    pub engine: Engine,
    /// A Podman connection by name. Unpinned detection may leave this unset.
    pub connection: Option<String>,
    /// Internal run affinity, deliberately absent from the setup/status IPC representation.
    #[serde(skip)]
    selector: Option<RuntimeSelector>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RuntimeSelector {
    DockerContext(String),
    DockerHost(String),
    PodmanUrl(String),
    PodmanLocal,
}

impl Address {
    pub fn new(engine: Engine, connection: Option<String>) -> Self {
        Self {
            engine,
            connection,
            selector: None,
        }
    }

    /// Freeze the supported nonsecret selector before a managed run can create containers.
    /// Query only names/remote mode, never context exports, TLS material or credential config.
    pub fn pin(&self) -> Result<Self, String> {
        if self.selector.is_some() || (self.engine == Engine::Podman && self.connection.is_some()) {
            return Ok(self.clone());
        }
        let mut pinned = self.clone();
        let env = |name| std::env::var(name).ok().filter(|value| !value.is_empty());
        match self.engine {
            Engine::Docker => {
                pinned.selector = Some(if let Some(context) = env("DOCKER_CONTEXT") {
                    self.docker_context_selector(context)?
                } else if let Some(host) = env("DOCKER_HOST") {
                    RuntimeSelector::DockerHost(nonsecret_endpoint(host)?)
                } else {
                    self.docker_context_selector(self.selector_output(&["context", "show"])?)?
                });
            }
            Engine::Podman => {
                if let Some(connection) = env("CONTAINER_CONNECTION") {
                    pinned.connection = Some(connection);
                } else if let Some(host) = env("CONTAINER_HOST") {
                    pinned.selector = Some(RuntimeSelector::PodmanUrl(nonsecret_endpoint(host)?));
                } else if cfg!(target_os = "linux")
                    && self.selector_output(&["info", "--format", "{{.Host.ServiceIsRemote}}"])?
                        == "false"
                {
                    pinned.selector = Some(RuntimeSelector::PodmanLocal);
                } else {
                    pinned.connection = Some(self.selector_output(&[
                        "system",
                        "connection",
                        "list",
                        "--format",
                        "{{if .Default}}{{.Name}}{{end}}",
                    ])?);
                }
            }
        }
        Ok(pinned)
    }

    fn docker_context_selector(&self, context: String) -> Result<RuntimeSelector, String> {
        if context == "default" {
            // Docker's virtual default context still derives its endpoint from DOCKER_HOST.
            // Retain that endpoint so even this context cannot be retargeted by the environment.
            Ok(RuntimeSelector::DockerHost(nonsecret_endpoint(
                self.selector_output(&[
                    "context",
                    "inspect",
                    "default",
                    "--format",
                    "{{.Endpoints.docker.Host}}",
                ])?,
            )?))
        } else {
            Ok(RuntimeSelector::DockerContext(context))
        }
    }

    fn selector_output(&self, args: &[&str]) -> Result<String, String> {
        let output = self
            .command()
            .args(args)
            .output()
            .map_err(|error| format!("Could not identify the container runtime: {error}"))?;
        if !output.status.success() {
            return Err(format!("Could not identify the {} runtime selector ({}). Choose an explicit context or connection and try again.", self.engine.binary(), output.status));
        }
        let value = String::from_utf8(output.stdout)
            .map_err(|_| "The container runtime returned an invalid selector.".to_string())?;
        let names: Vec<_> = value
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        match names.as_slice() {
            [name] => Ok((*name).to_string()),
            _ => Err("The container runtime did not identify one connection. Choose an explicit context or connection and try again.".into()),
        }
    }

    /// Probe this retained runtime without detecting a replacement engine.
    pub fn status(&self) -> EngineStatus {
        let mut status = answering(self.clone());
        status.responding = self.responds();
        if !status.responding {
            status.detail = format!(
                "The original {} runtime is not answering. Start it and try again.",
                self.engine.binary()
            );
        }
        status
    }

    /// The binary and the arguments that name this engine, and the one place that decides them.
    ///
    /// Split out because not every caller can use a `std::process::Command`: the plan sign-in runs
    /// under a pty and has to build the pty crate's own command type. Both go through here, so a
    /// machine addressed by name cannot be addressed by name on one path and not the other.
    ///
    /// The binary is a resolved path rather than a name, for the PATH reason at the top of this
    /// file. The pty path needs that as much as this one: a sign-in that cannot find `podman` is
    /// the same failure wearing a terminal.
    pub fn parts(&self) -> (PathBuf, Vec<String>) {
        let mut arguments = Vec::new();
        if let Some(connection) = &self.connection {
            arguments.push("--connection".to_string());
            arguments.push(connection.clone());
        }
        if let Some(selector) = &self.selector {
            match selector {
                RuntimeSelector::DockerContext(context) => {
                    arguments.extend(["--context".into(), context.clone()])
                }
                RuntimeSelector::DockerHost(host) => {
                    arguments.extend(["--host".into(), host.clone()])
                }
                RuntimeSelector::PodmanUrl(url) => arguments.extend(["--url".into(), url.clone()]),
                RuntimeSelector::PodmanLocal => arguments.push("--remote=false".into()),
            }
        }
        (
            program(self.engine).unwrap_or_else(|| PathBuf::from(self.engine.binary())),
            arguments,
        )
    }

    /// A command aimed at this engine, and the only way one should be built.
    ///
    /// The provider directory goes in front of the child's PATH rather than into `containers.conf`,
    /// because that file belongs to whoever else may have configured it.
    pub fn command(&self) -> Command {
        let (binary, arguments) = self.parts();
        let mut command = command(binary);
        command.args(arguments);
        if let Some(dir) = tools_dir() {
            command.env("PATH", path_with(dir));
        }
        command
    }

    /// Whether Compose can actually run through this engine.
    ///
    /// Podman ships no compose implementation. `podman compose` looks for an external provider on
    /// PATH and, finding none, answers with seven errors naming `docker-compose`, which is a
    /// baffling thing to read on a machine where Docker was deliberately not installed. Docker
    /// Desktop puts a provider on PATH, which is why this went unnoticed until the stack was
    /// started on a Linux machine that had only Podman.
    pub fn composes(&self) -> bool {
        self.command()
            .args(["compose", "version"])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }

    /// Answering now, not merely installed. A binary that prints help proves nothing.
    pub fn responds(&self) -> bool {
        self.command()
            .args(["version", "--format", "{{.Server.APIVersion}}"])
            .output()
            .map(|out| out.status.success() && !out.stdout.is_empty())
            .unwrap_or(false)
    }
}

fn nonsecret_endpoint(value: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&value).map_err(|_| {
        "Use a named container context or connection for this endpoint.".to_string()
    })?;
    if parsed.password().is_some() || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Use a named container context or connection; credentials cannot be retained in an endpoint selector.".into());
    }
    Ok(value)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EngineStatus {
    pub engine: Option<Engine>,
    /// How to reach it, carried so no later call has to guess again.
    pub address: Option<Address>,
    /// Answering now, not merely installed. A binary on PATH proves nothing.
    pub responding: bool,
    /// What Compose should mount as the engine socket, when the default is wrong.
    pub engine_socket: Option<String>,
    /// Present so a person can be told what was wrong rather than that something was.
    pub detail: String,
}

/// A Podman machine that is running now, preferred over starting a second one.
///
/// Somebody who already has a machine up is handed it rather than made to wait while a duplicate
/// boots beside it. Ours is preferred among running machines only so that repeat launches settle on
/// the same one.
fn running_machine(preferred: &str) -> Option<String> {
    let output = tool(Engine::Podman)
        .args(["machine", "list", "--format", "json"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let machines: Vec<MachineListing> = serde_json::from_slice(&output.stdout).ok()?;
    let running = || machines.iter().filter(|machine| machine.running);
    running()
        .find(|machine| machine.name == preferred)
        .or_else(|| running().next())
        .map(|machine| machine.name.clone())
}

#[derive(Deserialize)]
struct MachineListing {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Running")]
    running: bool,
}

/// Where OpenBot keeps the engine tools it installed itself.
///
/// Set once, at start-up, because the app knows its own cache directory and this module is called
/// from places that do not. Unset in tests and in any caller that never installed anything, which
/// is why every read tolerates its absence.
static TOOLS: OnceLock<PathBuf> = OnceLock::new();

/// Tell this module where the tools OpenBot installed live.
pub fn tools_live_in(dir: PathBuf) {
    let _ = TOOLS.set(dir);
}

/// The directory holding OpenBot's own copy of the Compose provider, under a download directory.
pub fn tools_dir_under(downloads: &Path) -> PathBuf {
    downloads.join("bin")
}

fn tools_dir() -> Option<&'static PathBuf> {
    TOOLS.get()
}

/// A command that runs this engine's binary, wherever it actually is.
pub fn tool(engine: Engine) -> Command {
    let mut built = command(program(engine).unwrap_or_else(|| PathBuf::from(engine.binary())));
    if let Some(dir) = tools_dir() {
        built.env("PATH", path_with(dir));
    }
    built
}

/// This process's PATH with `first` in front of it.
///
/// In front, so the provider OpenBot placed is the one found; appended, a broken `docker-compose`
/// earlier on PATH would still win.
fn path_with(first: &Path) -> OsString {
    let mut joined = OsString::from(first);
    if let Some(existing) = std::env::var_os("PATH") {
        if !existing.is_empty() {
            joined.push(if cfg!(windows) { ";" } else { ":" });
            joined.push(existing);
        }
    }
    joined
}

/// Where this engine's binary is, looking on PATH first and then where installers put it.
///
/// PATH first, because somebody who installed it themselves may have put it anywhere and that
/// choice is theirs. The fixed places are the fallback for the session in which OpenBot installed
/// it, when this process's PATH is the one it started with.
pub fn program(engine: Engine) -> Option<PathBuf> {
    on_path(engine.binary()).or_else(|| where_installers_put(engine))
}

/// A PATH lookup done by looking, rather than by starting the program to see whether it runs.
///
/// `command(...).output()` would answer this too, and is what this replaced. It also spawns a
/// process every time a command is built, and commands are built inside polling loops.
fn on_path(binary: &str) -> Option<PathBuf> {
    let filename = if cfg!(windows) {
        format!("{binary}.exe")
    } else {
        binary.to_string()
    };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(&filename))
        .find(|candidate| candidate.is_file())
}

/// The fixed places each platform's installers use.
fn where_installers_put(engine: Engine) -> Option<PathBuf> {
    let places: Vec<PathBuf> = match engine {
        #[cfg(target_os = "windows")]
        Engine::Podman => {
            // The MSI uses Programs\Podman per user and Program Files\Podman per machine.
            // Keep the legacy RedHat location for installations from the older EXE installer.
            [
                std::env::var_os("LOCALAPPDATA")
                    .map(|local| PathBuf::from(local).join("Programs\\Podman\\podman.exe")),
                std::env::var_os("ProgramFiles")
                    .map(|files| PathBuf::from(files).join("Podman\\podman.exe")),
                std::env::var_os("ProgramFiles")
                    .map(|files| PathBuf::from(files).join("RedHat\\Podman\\podman.exe")),
            ]
            .into_iter()
            .flatten()
            .collect()
        }
        #[cfg(target_os = "windows")]
        Engine::Docker => std::env::var_os("ProgramFiles")
            .map(|files| PathBuf::from(files).join("Docker\\Docker\\resources\\bin\\docker.exe"))
            .into_iter()
            .collect(),
        #[cfg(target_os = "macos")]
        Engine::Podman => [
            "/opt/podman/bin/podman",
            "/opt/homebrew/bin/podman",
            "/usr/local/bin/podman",
        ]
        .iter()
        .map(PathBuf::from)
        .collect(),
        #[cfg(target_os = "macos")]
        Engine::Docker => [
            "/usr/local/bin/docker",
            "/opt/homebrew/bin/docker",
            "/Applications/Docker.app/Contents/Resources/bin/docker",
        ]
        .iter()
        .map(PathBuf::from)
        .collect(),
        #[cfg(target_os = "linux")]
        Engine::Podman => ["/usr/bin/podman", "/usr/local/bin/podman"]
            .iter()
            .map(PathBuf::from)
            .collect(),
        #[cfg(target_os = "linux")]
        Engine::Docker => ["/usr/bin/docker", "/usr/local/bin/docker"]
            .iter()
            .map(PathBuf::from)
            .collect(),
    };
    places.into_iter().find(|candidate| candidate.is_file())
}

/// The rootless socket on Linux, which is the one Compose must mount.
///
/// Returned as a path rather than assumed, because `$XDG_RUNTIME_DIR` is not always `/run/user/$UID`
/// and a wrong guess here is the failure that looks like a network fault.
#[cfg(target_os = "linux")]
pub fn rootless_socket() -> Option<PathBuf> {
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            let uid = unsafe { libc::getuid() };
            Some(PathBuf::from(format!("/run/user/{uid}")))
        })?;
    let socket = runtime_dir.join("podman/podman.sock");
    socket.exists().then_some(socket)
}

#[cfg(not(target_os = "linux"))]
pub fn rootless_socket() -> Option<PathBuf> {
    // macOS and Windows run the engine in a virtual machine, and inside it `/var/run/docker.sock`
    // is already the rootless socket. Compose mounts that path, so there is nothing to override.
    None
}

/// What is here, before anything is installed.
pub fn detect() -> EngineStatus {
    for engine in [Engine::Docker, Engine::Podman] {
        let address = Address::new(engine, None);
        if address.responds() {
            return answering(address);
        }
    }

    // Podman's default connection can name a machine that is not running while another one is. That
    // is not "no engine", and creating a second machine in answer to it is the wrong repair.
    if let Some(machine) = running_machine(crate::acquire::MACHINE) {
        let address = Address::new(Engine::Podman, Some(machine));
        if address.responds() {
            return answering(address);
        }
    }

    for engine in [Engine::Docker, Engine::Podman] {
        if program(engine).is_some() {
            return EngineStatus {
                engine: Some(engine),
                address: None,
                responding: false,
                engine_socket: None,
                detail: format!(
                    "{} is installed but not answering. Start it and try again.",
                    engine.binary()
                ),
            };
        }
    }

    EngineStatus {
        engine: None,
        address: None,
        responding: false,
        engine_socket: None,
        // Not an instruction any more: OpenBot installs one. See `install.rs`.
        detail: "No container engine yet.".into(),
    }
}

fn answering(address: Address) -> EngineStatus {
    let engine = address.engine;
    let detail = match &address.connection {
        Some(machine) => format!("{} is answering on {machine}.", engine.binary()),
        None => format!("{} is answering.", engine.binary()),
    };
    EngineStatus {
        engine: Some(engine),
        engine_socket: socket_override(engine),
        address: Some(address),
        responding: true,
        detail,
    }
}

/// The socket Compose should mount, or `None` when the default is already right.
///
/// Only rootless Podman on Linux needs this. Docker owns `/var/run/docker.sock` outright, and a
/// Podman machine supplies the same path inside its VM.
fn socket_override(engine: Engine) -> Option<String> {
    match engine {
        Engine::Docker => None,
        Engine::Podman => rootless_socket().map(|path| path.to_string_lossy().into_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_selectors_keep_the_existing_status_wire_shape() {
        let mut address = Address::new(Engine::Docker, None);
        address.selector = Some(RuntimeSelector::DockerContext("owned".into()));
        assert_eq!(
            serde_json::to_value(&address).unwrap(),
            serde_json::json!({"engine":"docker","connection":null})
        );
        assert_eq!(address.parts().1, ["--context", "owned"]);
        address.selector = Some(RuntimeSelector::PodmanLocal);
        address.engine = Engine::Podman;
        assert_eq!(address.parts().1, ["--remote=false"]);
    }

    #[test]
    fn endpoint_affinity_never_retains_embedded_credentials() {
        assert!(
            nonsecret_endpoint("ssh://user:synthetic-password@example.test/socket".into()).is_err()
        );
        assert!(nonsecret_endpoint("tcp://example.test:1234?token=synthetic".into()).is_err());
        assert!(nonsecret_endpoint("unix:///owned.sock".into()).is_ok());
    }

    #[test]
    fn docker_never_overrides_the_socket_because_it_owns_the_default_path() {
        assert_eq!(socket_override(Engine::Docker), None);
    }

    #[test]
    fn a_missing_engine_is_reported_as_missing_rather_than_as_not_responding() {
        // Not a call to `detect`: this asserts the shape a caller has to distinguish. "Installed but
        // not answering" tells somebody to start it; "none found" tells them to install one, and
        // the wrong one of those sends them looking for a menu bar icon that is not there.
        let missing = EngineStatus {
            engine: None,
            address: None,
            responding: false,
            engine_socket: None,
            detail: "No container engine found. Install Podman Desktop or Docker Desktop first."
                .into(),
        };
        assert!(missing.engine.is_none());
        assert!(!missing.responding);
    }

    #[test]
    fn a_podman_machine_is_named_on_every_command_it_is_addressed_with() {
        let address = Address::new(Engine::Podman, Some("openbot".into()));
        let command = address.command();
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy())
            .collect();
        assert_eq!(args, ["--connection", "openbot"]);
    }

    #[test]
    fn unpinned_docker_detection_uses_the_ambient_selector() {
        let command = Address::new(Engine::Docker, None).command();
        assert_eq!(command.get_args().count(), 0);
    }

    /// The program is a path, not a name. This is the fix for an engine OpenBot has just installed
    /// but this process's PATH does not know about, and asserting it here is the only place it is
    /// visible without a machine that has no engine on it.
    #[test]
    fn an_engine_command_names_a_binary_rather_than_hoping_for_one_on_path() {
        let (named, _) = Address::new(Engine::Podman, None).parts();
        let named = named.to_string_lossy().into_owned();
        assert_eq!(
            named != "podman",
            program(Engine::Podman).is_some(),
            "addressed {named}, which does not match whether one was found"
        );
        assert!(
            named.ends_with("podman") || named.ends_with("podman.exe"),
            "{named}"
        );
    }

    /// A name that is nowhere still produces a runnable command, which is what keeps the "no engine
    /// yet" screen reachable rather than a panic.
    #[test]
    fn a_binary_that_is_nowhere_is_absent_rather_than_guessed_at() {
        assert_eq!(on_path("openbot-not-a-real-binary"), None);
    }

    #[test]
    #[cfg(windows)]
    fn windows_installed_podman_runs_without_an_inherited_path_entry() {
        if crate::test_support::isolated_process(
            "engine::tests::windows_installed_podman_runs_without_an_inherited_path_entry",
        ) {
            return;
        }
        let root = crate::test_support::temp_root("podman install locations");
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("engine.rs");
        let binary = root.join("fixture.exe");
        std::fs::write(&source, "fn main() { println!(\"1.44\"); }").unwrap();
        crate::test_support::compile_fixture(&source, &binary);
        let local = root.join("Local");
        let program_files = root.join("Program Files");
        std::env::set_var("LOCALAPPDATA", &local);
        std::env::set_var("ProgramFiles", &program_files);
        std::env::set_var("PATH", root.join("empty-path"));

        for installation in [
            local.join("Programs/Podman/podman.exe"),
            program_files.join("Podman/podman.exe"),
            program_files.join("RedHat/Podman/podman.exe"),
        ] {
            std::fs::create_dir_all(installation.parent().unwrap()).unwrap();
            std::fs::copy(&binary, &installation).unwrap();
            assert_eq!(program(Engine::Podman).as_ref(), Some(&installation));
            let address = Address::new(Engine::Podman, Some("openbot".into()));
            assert_eq!(address.parts().0, installation);
            assert!(address.responds(), "resolved engine should actually run");
            assert!(tool(Engine::Podman)
                .arg("--version")
                .output()
                .unwrap()
                .status
                .success());
            std::fs::remove_file(installation).unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The provider directory has to be in *front* of PATH: a broken `docker-compose` earlier on
    /// somebody's PATH would otherwise be the one Podman runs.
    #[test]
    fn the_provider_directory_goes_in_front_of_the_inherited_path() {
        let ours = Path::new("/tmp/openbot-tools");
        let joined = path_with(ours);
        let text = joined.to_string_lossy();
        assert!(text.starts_with("/tmp/openbot-tools"), "{text}");
        if let Some(existing) = std::env::var_os("PATH") {
            assert!(text.ends_with(&*existing.to_string_lossy()), "{text}");
        }
    }

    /// The tools live under the downloads they came from, so one install of the app has one place
    /// for both and a retry finds what it already fetched.
    #[test]
    fn the_tools_live_under_the_downloads_they_came_from() {
        let downloads = Path::new("/tmp/openbot-engine");
        assert_eq!(tools_dir_under(downloads), downloads.join("bin"));
    }

    #[test]
    fn an_answering_engine_says_which_machine_answered() {
        let status = answering(Address::new(Engine::Podman, Some("openbot".into())));
        assert!(status.responding);
        assert!(status.detail.contains("openbot"), "{}", status.detail);
        assert_eq!(
            status.address.unwrap().connection.as_deref(),
            Some("openbot")
        );
    }
}

/// A native Podman API service belongs to the desktop session only when this session spawned it.
/// Existing user/systemd services are probed and reused, never stopped or reconfigured.
#[cfg(any(target_os = "linux", all(test, unix)))]
pub mod local_api {
    use crate::problem::Problem;
    use std::io::{Read, Write};
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    #[derive(Default)]
    pub struct Service {
        child: Option<Child>,
        socket: Option<(PathBuf, u64, u64)>,
    }

    fn problem(detail: impl Into<String>) -> Problem {
        Problem::with(
            "OpenBot could not prepare its container API. Try again.",
            detail,
        )
    }

    fn ping(socket: &Path) -> Result<Option<u32>, String> {
        let probe = || -> std::io::Result<(String, Option<u32>)> {
            let mut stream = UnixStream::connect(socket)?;
            #[cfg(target_os = "linux")]
            let peer = {
                use std::os::fd::AsRawFd;
                let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
                let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
                if unsafe {
                    libc::getsockopt(
                        stream.as_raw_fd(),
                        libc::SOL_SOCKET,
                        libc::SO_PEERCRED,
                        (&mut credentials as *mut libc::ucred).cast(),
                        &mut size,
                    )
                } != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Some(credentials.pid as u32)
            };
            #[cfg(not(target_os = "linux"))]
            let peer = None;
            stream.set_read_timeout(Some(Duration::from_millis(300)))?;
            stream.set_write_timeout(Some(Duration::from_millis(300)))?;
            stream.write_all(
                b"GET /_ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )?;
            let mut response = String::new();
            stream.take(4096).read_to_string(&mut response)?;
            Ok((response, peer))
        };
        let (response, peer) = probe().map_err(|error| format!("{}: {error}", socket.display()))?;
        if response.starts_with("HTTP/1.1 200 ") || response.starts_with("HTTP/1.0 200 ") {
            Ok(peer)
        } else {
            Err(format!(
                "{}: Podman API ping failed: {response}",
                socket.display()
            ))
        }
    }

    impl Service {
        #[cfg(target_os = "linux")]
        pub fn ensure(&mut self, address: &super::Address, root: &Path) -> Result<(), Problem> {
            if !matches!(address.selector, Some(super::RuntimeSelector::PodmanLocal)) {
                return Ok(());
            }
            let runtime = std::env::var_os("XDG_RUNTIME_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(format!("/run/user/{}", unsafe { libc::getuid() }))
                });
            let socket = runtime.join("podman/podman.sock");
            let log = root.join("logs/podman-api.log");
            self.ensure_with(&socket, &log, || {
                let mut command = address.command();
                command
                    .args(["system", "service", "--time=0"])
                    .arg(format!("unix://{}", socket.display()));
                command
            })
        }

        pub(super) fn ensure_with(
            &mut self,
            socket: &Path,
            log: &Path,
            spawn: impl FnOnce() -> Command,
        ) -> Result<(), Problem> {
            if let Some(child) = self.child.as_mut() {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|error| problem(error.to_string()))?
                {
                    self.stop()?;
                    return Err(problem(format!(
                        "The owned Podman API exited with {status}. Log: {}",
                        log.display()
                    )));
                }
            }
            match std::fs::symlink_metadata(socket) {
                Ok(_) => return ping(socket).map(|_| ()).map_err(problem),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(problem(format!("{}: {error}", socket.display()))),
            }
            if self.child.is_some() {
                return Err(problem("The owned Podman API lost its socket."));
            }
            for directory in [socket.parent(), log.parent()].into_iter().flatten() {
                std::fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(directory)
                    .map_err(|error| problem(format!("{}: {error}", directory.display())))?;
            }
            let output = std::fs::File::create(log)
                .map_err(|error| problem(format!("{}: {error}", log.display())))?;
            let error_output = output
                .try_clone()
                .map_err(|error| problem(error.to_string()))?;
            self.child = Some(
                spawn()
                    .process_group(0)
                    .stdin(Stdio::null())
                    .stdout(output)
                    .stderr(error_output)
                    .spawn()
                    .map_err(|error| problem(format!("could not start Podman API: {error}")))?,
            );
            let until = Instant::now() + Duration::from_secs(10);
            let failure = loop {
                match self.child.as_mut().unwrap().try_wait() {
                    Ok(Some(status)) => break format!("Podman API exited with {status}"),
                    Err(error) => break format!("could not observe Podman API: {error}"),
                    Ok(None) => {}
                }
                match ping(socket) {
                    Ok(peer) => {
                        let child = self.child.as_ref().unwrap().id();
                        if peer
                            .is_some_and(|pid| unsafe { libc::getpgid(pid as i32) } != child as i32)
                        {
                            // Another service won the bind race. Retire ours without claiming its socket.
                            self.stop()?;
                            return ping(socket).map(|_| ()).map_err(problem);
                        }
                        match std::fs::symlink_metadata(socket) {
                            Ok(metadata) => {
                                self.socket =
                                    Some((socket.to_path_buf(), metadata.dev(), metadata.ino()))
                            }
                            Err(error) => break format!("{}: {error}", socket.display()),
                        }
                        return Ok(());
                    }
                    Err(error) if Instant::now() >= until => break error,
                    Err(_) => std::thread::sleep(Duration::from_millis(50)),
                }
            };
            let diagnostic = match std::fs::read_to_string(log) {
                Ok(contents) => contents,
                Err(error) => format!("could not read {}: {error}", log.display()),
            };
            let cleanup = self.stop();
            Err(problem(match cleanup {
                Ok(()) => format!("{failure}\n{diagnostic}"),
                Err(cleanup) => format!(
                    "{failure}\n{diagnostic}\nCleanup: {} {:?}",
                    cleanup.said, cleanup.detail
                ),
            }))
        }

        pub fn stop(&mut self) -> Result<(), Problem> {
            if let Some(child) = self.child.as_mut() {
                if child
                    .try_wait()
                    .map_err(|error| problem(error.to_string()))?
                    .is_none()
                {
                    // Terminate the exact held child, never a PID read from a previous session.
                    if unsafe { libc::kill(-(child.id() as i32), libc::SIGTERM) } != 0 {
                        let error = std::io::Error::last_os_error();
                        if error.raw_os_error() != Some(libc::ESRCH) {
                            return Err(problem(format!("could not stop Podman API: {error}")));
                        }
                    }
                    let until = Instant::now() + Duration::from_secs(2);
                    while child
                        .try_wait()
                        .map_err(|error| problem(error.to_string()))?
                        .is_none()
                    {
                        if Instant::now() >= until {
                            if unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) } != 0 {
                                let error = std::io::Error::last_os_error();
                                if error.raw_os_error() != Some(libc::ESRCH) {
                                    return Err(problem(error.to_string()));
                                }
                            }
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                }
                child.wait().map_err(|error| problem(error.to_string()))?;
                self.child = None;
            }
            if let Some((socket, device, inode)) = &self.socket {
                match std::fs::symlink_metadata(socket) {
                    Ok(metadata) if metadata.dev() == *device && metadata.ino() == *inode => {
                        std::fs::remove_file(socket)
                            .map_err(|error| problem(format!("{}: {error}", socket.display())))?;
                    }
                    Ok(_) => {} // A replacement socket is not ours.
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(problem(error.to_string())),
                }
                self.socket = None;
            }
            Ok(())
        }

        #[cfg(test)]
        pub(super) fn child_id(&self) -> Option<u32> {
            self.child.as_ref().map(Child::id)
        }
    }

    impl Drop for Service {
        fn drop(&mut self) {
            if let Err(error) = self.stop() {
                eprintln!(
                    "[podman-api] cleanup failed: {} {:?}",
                    error.said, error.detail
                );
            }
        }
    }
}

#[cfg(all(test, unix))]
mod local_api_tests {
    use super::local_api::Service;
    use crate::test_support::temp_root;
    use std::path::Path;
    use std::process::Command;

    fn fixture(socket: &Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "engine::local_api_tests::api_fixture_child",
                "--nocapture",
            ])
            .env("OPENBOT_API_FIXTURE_SOCKET", socket);
        command
    }

    #[test]
    fn api_fixture_child() {
        let Some(socket) = std::env::var_os("OPENBOT_API_FIXTURE_SOCKET") else {
            return;
        };
        use std::io::{Read, Write};
        let listener = std::os::unix::net::UnixListener::bind(socket).unwrap();
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0; 1];
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                assert!(request.len() < 4096, "fixture request must be bounded");
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
                .unwrap();
        }
    }

    #[test]
    fn linux_api_starts_a_real_socket_and_reaps_only_its_own_child() {
        let root = temp_root("linux-api");
        std::fs::create_dir_all(&root).unwrap();
        let socket = root.join("api.sock");
        let log = root.join("api.log");
        let mut owned = Service::default();
        owned
            .ensure_with(&socket, &log, || fixture(&socket))
            .unwrap();
        let pid = owned.child_id().expect("new service is owned");
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0);
        let mut borrowed = Service::default();
        borrowed
            .ensure_with(&socket, &log, || panic!("reuse the existing API"))
            .unwrap();
        borrowed.stop().unwrap();
        assert_eq!(
            unsafe { libc::kill(pid as i32, 0) },
            0,
            "unowned service must remain alive"
        );
        owned.stop().unwrap();
        assert_eq!(
            unsafe { libc::kill(pid as i32, 0) },
            -1,
            "owned child must be reaped"
        );
        assert!(
            !socket.exists(),
            "owned socket must not prevent a later start"
        );
        owned
            .ensure_with(&socket, &log, || fixture(&socket))
            .unwrap();
        owned.stop().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn linux_api_drop_reaps_the_owned_service_without_removing_a_replacement_socket() {
        let root = temp_root("linux-api-drop");
        std::fs::create_dir_all(&root).unwrap();
        let socket = root.join("api.sock");
        let mut service = Service::default();
        service
            .ensure_with(&socket, &root.join("api.log"), || fixture(&socket))
            .unwrap();
        let pid = service.child_id().unwrap();
        std::fs::remove_file(&socket).unwrap();
        let replacement = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        drop(service);
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
        assert!(socket.exists(), "replaced socket belongs to another owner");
        drop(replacement);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn linux_api_start_failure_preserves_diagnostics_and_reaps_child() {
        let root = temp_root("linux-api-failed");
        std::fs::create_dir_all(&root).unwrap();
        let mut service = Service::default();
        let problem = service
            .ensure_with(&root.join("api.sock"), &root.join("api.log"), || {
                let mut command = Command::new("/bin/sh");
                command.args(["-c", "echo native-service-failed >&2; exit 19"]);
                command
            })
            .unwrap_err();
        assert!(problem.detail.unwrap().contains("native-service-failed"));
        assert!(service.child_id().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn linux_api_refuses_an_unresponsive_existing_socket_without_replacing_it() {
        let root = temp_root("linux-api-existing");
        std::fs::create_dir_all(&root).unwrap();
        let socket = root.join("api.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let mut service = Service::default();
        assert!(service
            .ensure_with(&socket, &root.join("api.log"), || panic!(
                "must not replace existing socket"
            ))
            .is_err());
        assert!(socket.exists());
        drop(listener);
        std::fs::remove_dir_all(root).unwrap();
    }
}
