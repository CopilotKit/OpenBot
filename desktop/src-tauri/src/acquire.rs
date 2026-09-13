//! Getting an engine onto a machine that has none, and a machine behind it.
//!
//! Two steps that look like one. Installing Podman puts a binary on PATH; it does not give you
//! anything that answers. On macOS and Windows a `podman machine` has to be created and started
//! first, and that is where the platform differences live.
//!
//! **Windows cannot do this from a service.** `podman machine init` shells out to `wsl.exe`, and WSL
//! refuses to run as LocalSystem: `Wsl/WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`. Meanwhile `wsl --install`
//! needs elevation. So the two halves run in different contexts, and the elevated half is the only
//! part that may be handed to a helper. See `windows.rs`. Fetching and installing Podman itself is
//! `install.rs`.

use crate::quiet::said as command_said;
use std::net::Ipv4Addr;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::engine::{Address, Engine};

/// Named so a caller can say which step failed rather than that a step did.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Step {
    CreateMachine,
    StartMachine,
    HealthGate,
}

/// How a step went, in both registers when it went badly.
///
/// Two fields and not one for the reason `problem.rs` gives: `podman machine init` failing is
/// exactly the case where the engine's own output was put in front of somebody as the headline.
/// The row shows `said`; `detail` is the output, kept.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StepOutcome {
    pub step: Step,
    pub ok: bool,
    /// The sentence for the step row, and for the failure when there is one.
    pub said: String,
    /// What the command actually said, where a command said anything.
    pub detail: Option<String>,
}

impl StepOutcome {
    fn went(step: Step, said: impl Into<String>) -> Self {
        Self {
            step,
            ok: true,
            said: said.into(),
            detail: None,
        }
    }

    /// A failed step, with the engine's own words kept behind the sentence.
    fn stopped(step: Step, output: &str) -> Self {
        let problem = crate::problem::Problem::with(explain_machine_error(output), output);
        Self {
            step,
            ok: false,
            said: problem.said,
            detail: problem.detail,
        }
    }

    /// This step's failure, for a caller that has to return one.
    pub fn problem(&self) -> crate::problem::Problem {
        let mut problem = crate::problem::Problem::plain(self.said.clone());
        problem.detail = self.detail.clone();
        problem
    }
}

/// The name of the machine this app owns.
///
/// Its own, not `podman-machine-default`: somebody may already have a machine with their own work
/// in it, and an installer that reconfigures or deletes it has taken something that was not
/// offered.
pub const MACHINE: &str = "openbot";

const USER_MODE_NETWORKING_FLAG: &str = "--user-mode-networking=true";
const HOST_GATEWAY_CONFIG: &str = ".config/containers/containers.conf.d/90-openbot-host.conf";

fn podman(args: &[&str]) -> Result<String, String> {
    podman_with(args, || {
        crate::engine::tool(Engine::Podman).args(args).output()
    })
}

fn podman_with(
    args: &[&str],
    run: impl FnOnce() -> std::io::Result<std::process::Output>,
) -> Result<String, String> {
    // Resolved, not named: right after OpenBot installs it, `podman` is not yet on this process's
    // PATH. See the PATH rule in `engine.rs`.
    let output = run().map_err(|error| format!("could not run podman: {error}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    Err(command_failure("podman", args, &output))
}

fn command_failure(binary: &str, args: &[&str], output: &std::process::Output) -> String {
    let status = output.status.code().map_or_else(
        || "terminated by signal".to_string(),
        |code| code.to_string(),
    );
    let stdout = command_said(&output.stdout);
    let stderr = command_said(&output.stderr);
    let command = std::iter::once(binary)
        .chain(args.iter().copied())
        .collect::<Vec<_>>()
        .join(" ");
    match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
        (true, true) => format!("{command} exited with status {status}"),
        (false, true) => format!("{command} exited with status {status}; stdout: {stdout}"),
        (true, false) => format!("{command} exited with status {status}; stderr: {stderr}"),
        (false, false) => {
            format!("{command} exited with status {status}; stdout: {stdout}; stderr: {stderr}")
        }
    }
}

fn machine_exists_with(run: impl FnOnce() -> Result<String, String>) -> Result<bool, String> {
    let names = run()?;
    Ok(names.lines().any(|name| name.trim() == MACHINE))
}

/// Does this app's machine already exist?
pub fn machine_exists() -> Result<bool, String> {
    machine_exists_with(|| podman(&["machine", "list", "--quiet"]))
}

/// Create the machine.
///
/// No `--provider`: `applehv` has been the default on Apple silicon since Podman 6.1, and pinning it
/// asks for what you already get. The libkrun bind-mount trouble that the pin was written for
/// belonged to 5.7, where libkrun was the default.
pub fn create_machine(cpus: u32, memory_mib: u32, disk_gib: u32) -> StepOutcome {
    create_machine_with(cpus, memory_mib, disk_gib, machine_exists, podman)
}

fn create_machine_with(
    cpus: u32,
    memory_mib: u32,
    disk_gib: u32,
    exists: impl FnOnce() -> Result<bool, String>,
    mut run: impl FnMut(&[&str]) -> Result<String, String>,
) -> StepOutcome {
    match exists() {
        Ok(true) => {
            return StepOutcome::went(Step::CreateMachine, format!("{MACHINE} already exists."));
        }
        Ok(false) => {}
        Err(error) => return StepOutcome::stopped(Step::CreateMachine, &error),
    }
    let args = create_machine_args(cpus, memory_mib, disk_gib, cfg!(target_os = "windows"));
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    match run(&refs) {
        Ok(_) => StepOutcome::went(Step::CreateMachine, format!("{MACHINE} created.")),
        Err(error) => StepOutcome::stopped(Step::CreateMachine, &error),
    }
}

fn create_machine_args(
    cpus: u32,
    memory_mib: u32,
    disk_gib: u32,
    target_is_windows: bool,
) -> Vec<String> {
    let mut args = vec![
        "machine".to_string(),
        "init".to_string(),
        MACHINE.to_string(),
        "--cpus".to_string(),
        cpus.to_string(),
        "--memory".to_string(),
        memory_mib.to_string(),
        "--disk-size".to_string(),
        disk_gib.to_string(),
    ];
    if target_is_windows {
        args.push(USER_MODE_NETWORKING_FLAG.to_string());
    }
    args
}

#[derive(Debug, PartialEq, Eq)]
struct MachineNetworking {
    state: String,
    user_mode: bool,
}

fn prepare_user_mode_networking_before_start(
    run: &mut impl FnMut(&[&str]) -> Result<String, String>,
    target_is_windows: bool,
) -> Result<(), String> {
    if !target_is_windows {
        return Ok(());
    }

    let listing = run(&["machine", "inspect", MACHINE])?;
    let networking = owned_machine_networking(&listing)?;
    if networking.state.eq_ignore_ascii_case("running") && !networking.user_mode {
        return Err(format!(
            "{MACHINE} is already running without Podman user-mode networking. Stop the OpenBot engine machine and start OpenBot again so host callbacks can be configured."
        ));
    }
    if networking.state.eq_ignore_ascii_case("stopped") && !networking.user_mode {
        run(&["machine", "set", USER_MODE_NETWORKING_FLAG, MACHINE])?;
    }
    Ok(())
}

fn owned_machine_networking(listing: &str) -> Result<MachineNetworking, String> {
    let machines: Vec<Value> = serde_json::from_str(listing)
        .map_err(|error| format!("could not inspect {MACHINE} networking: {error}"))?;
    let machine = machines
        .iter()
        .find(|machine| machine.get("Name").and_then(Value::as_str) == Some(MACHINE))
        .ok_or_else(|| format!("podman machine inspect did not return {MACHINE}"))?;
    let state = machine
        .get("State")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("podman machine inspect did not include {MACHINE} state"))?
        .to_string();
    let user_mode = machine
        .get("UserModeNetworking")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            format!("podman machine inspect did not include {MACHINE} user-mode networking")
        })?;
    Ok(MachineNetworking { state, user_mode })
}

fn configure_host_gateway_after_start(
    run: &mut impl FnMut(&[&str]) -> Result<String, String>,
    target_is_windows: bool,
) -> Result<(), String> {
    if !target_is_windows {
        return Ok(());
    }

    let resolved = run(&[
        "machine",
        "ssh",
        MACHINE,
        "getent",
        "ahostsv4",
        "host.containers.internal",
    ])?;
    let ip = first_valid_host_gateway_ip(&resolved)?;
    let script = host_gateway_config_script(ip);
    run(&["machine", "ssh", MACHINE, &script]).map(|_| ())
}

fn configure_owned_windows_podman_for_compose(
    address: &Address,
    mut run: impl FnMut(&[&str]) -> Result<String, String>,
    target_is_windows: bool,
) -> Result<(), String> {
    if !owned_windows_podman_address(address, target_is_windows) {
        return Ok(());
    }
    let listing = run(&["machine", "inspect", MACHINE])?;
    let networking = owned_machine_networking(&listing)?;
    if !networking.user_mode {
        return Err(format!(
            "{MACHINE} is running without Podman user-mode networking. Stop the OpenBot engine machine and start OpenBot again so host callbacks can be configured."
        ));
    }
    configure_host_gateway_after_start(&mut run, true)
}

fn owned_windows_podman_address(address: &Address, target_is_windows: bool) -> bool {
    target_is_windows
        && address.engine == Engine::Podman
        && address.connection.as_deref() == Some(MACHINE)
}

fn first_valid_host_gateway_ip(raw: &str) -> Result<Ipv4Addr, String> {
    for field in raw.split_whitespace() {
        if let Ok(ip) = field.parse::<Ipv4Addr>() {
            return validate_host_gateway_ip(ip);
        }
    }
    Err(format!(
        "could not resolve host.containers.internal in the {MACHINE} VM as IPv4"
    ))
}

fn validate_host_gateway_ip(ip: Ipv4Addr) -> Result<Ipv4Addr, String> {
    if ip.is_unspecified() || ip.is_loopback() {
        return Err(format!(
            "resolved host.containers.internal in the {MACHINE} VM to unusable address {ip}"
        ));
    }
    Ok(ip)
}

fn host_gateway_config_script(ip: Ipv4Addr) -> String {
    format!(
        "mkdir -p \"$HOME/.config/containers/containers.conf.d\" && \
         tmp=\"$HOME/{HOST_GATEWAY_CONFIG}.tmp\" && \
         cat > \"$tmp\" <<'EOF'\n[containers]\nhost_containers_internal_ip=\"{ip}\"\nEOF\n\
         mv \"$tmp\" \"$HOME/{HOST_GATEWAY_CONFIG}\""
    )
}

fn start_machine_with(
    mut run: impl FnMut(&[&str]) -> Result<String, String>,
    target_is_windows: bool,
) -> StepOutcome {
    if let Err(error) = prepare_user_mode_networking_before_start(&mut run, target_is_windows) {
        return StepOutcome::stopped(Step::StartMachine, &error);
    }
    let started = match run(&["machine", "start", MACHINE]) {
        Ok(_) => format!("{MACHINE} started."),
        Err(error) if error.contains("already running") => {
            format!("{MACHINE} was already running.")
        }
        Err(error) => return StepOutcome::stopped(Step::StartMachine, &error),
    };
    if let Err(error) = configure_host_gateway_after_start(&mut run, target_is_windows) {
        return StepOutcome::stopped(Step::StartMachine, &error);
    }
    StepOutcome::went(Step::StartMachine, started)
}

pub fn start_machine() -> StepOutcome {
    start_machine_with(podman, cfg!(target_os = "windows"))
}

/// Turn Podman's own words into an instruction, where we know one.
///
/// Every string matched here was produced by a real failure on a real machine during S2. A person
/// reading "exit status 0xffffffff" learns nothing; a person reading "Windows needs restarting"
/// knows what to do next.
fn explain_machine_error(error: &str) -> String {
    if error.contains("WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED") {
        return "WSL will not run as the system account, so this step has to run as you. \
                Restart OpenBot without elevation."
            .into();
    }
    if error.contains("WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED") {
        return "Windows Subsystem for Linux is installed but not active yet. Windows needs \
                restarting before a machine can be created."
            .into();
    }
    if error.contains("not enough space") || error.contains("no space left") {
        return "There is not enough disk space to create the engine's virtual machine.".into();
    }
    error.to_string()
}

/// How to reach the machine this app just started.
///
/// Always by name. The default connection belongs to whoever set it, and after `machine init` it is
/// usually still pointing somewhere else.
pub fn address() -> Address {
    Address::new(Engine::Podman, Some(MACHINE.to_string()))
}

/// The gate before Compose is touched.
///
/// A process that answers is not a process holding the current configuration, so this asks the
/// engine for its server version rather than whether a binary exists.
pub fn health_gate(address: &Address) -> StepOutcome {
    let binary = address.engine.binary();
    let output = address
        .command()
        .args(["version", "--format", "{{.Server.APIVersion}}"])
        .output();
    match output {
        Ok(out) if out.status.success() && !out.stdout.is_empty() => {
            if let Err(error) = configure_owned_windows_podman_for_compose(
                address,
                podman,
                cfg!(target_os = "windows"),
            ) {
                return StepOutcome::stopped(Step::HealthGate, &error);
            }
            // An engine that answers is not an engine that can raise the stack. Asked here, where
            // there is a sentence to put it in, rather than left to Compose to discover.
            if !address.composes() {
                return StepOutcome {
                    step: Step::HealthGate,
                    ok: false,
                    said: missing_compose(binary),
                    detail: None,
                };
            }
            StepOutcome::went(
                Step::HealthGate,
                format!("engine API {}", String::from_utf8_lossy(&out.stdout).trim()),
            )
        }
        // The engine ran and refused. Its words are the evidence, and the sentence in front of
        // them is chosen from what they say.
        Ok(out) => StepOutcome::stopped(
            Step::HealthGate,
            &command_failure(
                binary,
                &["version", "--format", "{{.Server.APIVersion}}"],
                &out,
            ),
        ),
        Err(error) => StepOutcome::stopped(
            Step::HealthGate,
            &format!("{binary} could not be run: {error}"),
        ),
    }
}

/// What to install, named, rather than seven errors about a file that is not there.
///
/// A last resort, not the plan: OpenBot installs a Compose provider itself, so somebody only reads
/// this when that copy is missing or is not being found. The restart comes first for that reason,
/// and the platform's own instruction is behind it.
///
/// Compose v2 rather than `podman-compose`: v2 is what the stack was tested against, and it is what
/// reads the healthchecks and `depends_on` conditions in `docker-compose.yml`. `podman-compose` is
/// a separate reimplementation with its own coverage of those, and choosing it here would mean
/// shipping a deployment nobody has run.
pub fn missing_compose(binary: &str) -> String {
    // Named per platform, because the generic sentence sent a Windows install looking for a
    // package manager it does not have. Podman ships no Compose provider on Windows either, which
    // was measured rather than assumed: a fresh Podman 6.1.1 there stops at exactly this gate.
    let install = if cfg!(target_os = "linux") {
        "Install Compose v2: `sudo apt install docker-compose-v2` on Debian or Ubuntu, or \
         `sudo dnf install docker-compose` on Fedora."
    } else if cfg!(target_os = "windows") {
        "Install Compose v2: either install Docker Desktop, or download `docker-compose` from \
         github.com/docker/compose/releases and put it beside the engine on PATH."
    } else {
        "Install Compose v2: `brew install docker-compose`, or install Docker Desktop, and make \
         sure `docker-compose` is on PATH."
    };
    format!(
        "{binary} is answering, but it has no Compose to run the stack with, and OpenBot's own \
         copy of one is not being found. Restart OpenBot and try again. If this comes back: \
         {install}"
    )
}

/// Where a downloaded installer is kept, so a failed run can be retried without downloading again.
pub fn download_dir(cache: &Path) -> std::path::PathBuf {
    cache.join("openbot-engine")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::test_support::temp_root;

    /// Whatever platform the tests run on, the sentence must not send somebody to a tool that
    /// platform does not have. Windows measured this the hard way: the generic wording named a
    /// PATH convention and nothing that would put anything on it.
    #[test]
    fn the_compose_instruction_suits_the_platform_it_is_shown_on() {
        let said = missing_compose("podman");
        if cfg!(target_os = "windows") {
            assert!(said.contains("github.com/docker/compose"), "{said}");
            assert!(!said.contains("apt"), "{said}");
            assert!(!said.contains("brew"), "{said}");
        } else if cfg!(target_os = "linux") {
            assert!(said.contains("apt"), "{said}");
        } else {
            assert!(said.contains("brew"), "{said}");
            assert!(!said.contains("apt"), "{said}");
        }
    }

    #[test]
    fn a_missing_compose_names_what_to_install_rather_than_what_was_not_found() {
        let said = missing_compose("podman");
        assert!(said.contains("podman"), "{said}");
        assert!(said.to_lowercase().contains("install"), "{said}");
        // The engine's own answer names docker-compose, which reads as "install Docker" to
        // somebody who chose Podman on purpose.
        assert!(
            !said.contains("7 errors"),
            "the engine's own wording helps nobody: {said}"
        );
    }

    #[cfg(unix)]
    fn output(status: i32, stdout: &str, stderr: &str) -> std::process::Output {
        use std::os::unix::process::ExitStatusExt;
        std::process::Output {
            status: std::process::ExitStatus::from_raw(status << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    fn machine_inspect(state: &str, user_mode: bool) -> String {
        serde_json::json!([
            {
                "Name": "openbot",
                "State": state,
                "UserModeNetworking": user_mode
            }
        ])
        .to_string()
    }

    #[test]
    #[cfg(unix)]
    fn failed_podman_commands_keep_status_stdout_and_stderr() {
        let failure = podman_with(&["machine", "inspect", MACHINE], || {
            Ok(output(125, "stdout diagnostic", "stderr diagnostic"))
        })
        .expect_err("nonzero podman must fail");

        assert!(
            failure.contains("podman machine inspect openbot"),
            "{failure}"
        );
        assert!(failure.contains("status 125"), "{failure}");
        assert!(failure.contains("stdout: stdout diagnostic"), "{failure}");
        assert!(failure.contains("stderr: stderr diagnostic"), "{failure}");
    }

    #[test]
    fn machine_existence_uses_the_quiet_machine_list_names() {
        assert!(machine_exists_with(|| Ok("default\nopenbot\n".into())).unwrap());
        assert!(!machine_exists_with(|| Ok("default\nopenbot-old\n".into())).unwrap());
    }

    #[test]
    fn machine_list_failures_stop_create_before_init() {
        let mut init_called = false;
        let result = create_machine_with(
            2,
            4096,
            20,
            || Err("podman machine list exited with status 125; stdout: denied".into()),
            |_args| {
                init_called = true;
                Ok(String::new())
            },
        );

        assert!(!init_called, "machine init must not run after list failure");
        assert!(!result.ok);
        assert_eq!(result.step, Step::CreateMachine);
        assert!(
            result
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("stdout: denied")),
            "{result:?}"
        );
    }

    #[test]
    fn absent_machine_creates_with_requested_resources() {
        let mut captured = Vec::new();
        let result = create_machine_with(
            4,
            8192,
            64,
            || Ok(false),
            |args| {
                captured = args.iter().map(|arg| (*arg).to_string()).collect();
                Ok(String::new())
            },
        );

        assert!(result.ok, "{result:?}");
        assert_eq!(
            captured,
            create_machine_args(4, 8192, 64, cfg!(target_os = "windows"))
        );
    }

    #[test]
    fn windows_machine_init_enables_user_mode_networking() {
        assert_eq!(
            create_machine_args(4, 8192, 64, true),
            [
                "machine",
                "init",
                "openbot",
                "--cpus",
                "4",
                "--memory",
                "8192",
                "--disk-size",
                "64",
                "--user-mode-networking=true"
            ]
        );
    }

    #[test]
    fn existing_stopped_windows_machine_is_configured_before_start() {
        let mut calls = Vec::<Vec<String>>::new();
        let inspect = machine_inspect("stopped", false);

        prepare_user_mode_networking_before_start(
            &mut |args: &[&str]| {
                calls.push(args.iter().map(|arg| (*arg).to_string()).collect());
                if args == ["machine", "inspect", "openbot"] {
                    return Ok(inspect.clone());
                }
                Ok(String::new())
            },
            true,
        )
        .expect("stopped owned machine should be configurable");

        assert_eq!(
            calls,
            [
                vec!["machine", "inspect", "openbot"],
                vec!["machine", "set", "--user-mode-networking=true", "openbot"]
            ]
        );
    }

    #[test]
    fn running_windows_machine_without_user_mode_fails_loud() {
        let mut calls = Vec::<Vec<String>>::new();
        let inspect = machine_inspect("running", false);

        let error = prepare_user_mode_networking_before_start(
            &mut |args| {
                calls.push(args.iter().map(|arg| (*arg).to_string()).collect());
                Ok(inspect.clone())
            },
            true,
        )
        .expect_err("running machines without user-mode networking must not be treated as fixed");

        assert_eq!(calls, [vec!["machine", "inspect", "openbot"]]);
        assert!(
            error.contains("without Podman user-mode networking"),
            "{error}"
        );
    }

    #[test]
    fn malformed_machine_inspect_fails_loud() {
        let error = owned_machine_networking("not json")
            .expect_err("new networking inspection must not ignore malformed output");

        assert!(
            error.contains("could not inspect openbot networking"),
            "{error}"
        );
    }

    #[test]
    fn non_windows_start_does_not_probe_podman_machine_networking() {
        let mut called = false;

        prepare_user_mode_networking_before_start(
            &mut |_args| {
                called = true;
                Ok(String::new())
            },
            false,
        )
        .expect("non-Windows should not run the Windows-only networking fix");

        assert!(!called);
    }

    #[test]
    fn windows_start_writes_host_gateway_config_from_vm_resolution() {
        let mut calls = Vec::<Vec<String>>::new();
        let inspect = machine_inspect("stopped", false);

        let result = start_machine_with(
            |args| {
                calls.push(args.iter().map(|arg| (*arg).to_string()).collect());
                match args {
                    ["machine", "inspect", "openbot"] => Ok(inspect.clone()),
                    ["machine", "set", "--user-mode-networking=true", "openbot"] => {
                        Ok(String::new())
                    }
                    ["machine", "start", "openbot"] => Ok(String::new()),
                    ["machine", "ssh", "openbot", "getent", "ahostsv4", "host.containers.internal"] => {
                        Ok("192.168.127.254 STREAM host.containers.internal\n".into())
                    }
                    ["machine", "ssh", "openbot", script]
                        if script.contains("host_containers_internal_ip=\"192.168.127.254\"") =>
                    {
                        Ok(String::new())
                    }
                    _ => Err(format!("unexpected args: {args:?}")),
                }
            },
            true,
        );

        assert!(result.ok, "{result:?}");
        assert_eq!(result.said, "openbot started.");
        assert_eq!(
            calls,
            vec![
                vec!["machine", "inspect", "openbot"]
                    .into_iter()
                    .map(str::to_string)
                    .collect::<Vec<_>>(),
                vec!["machine", "set", "--user-mode-networking=true", "openbot"]
                    .into_iter()
                    .map(str::to_string)
                    .collect::<Vec<_>>(),
                vec!["machine", "start", "openbot"]
                    .into_iter()
                    .map(str::to_string)
                    .collect::<Vec<_>>(),
                vec![
                    "machine",
                    "ssh",
                    "openbot",
                    "getent",
                    "ahostsv4",
                    "host.containers.internal",
                ]
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>(),
                vec![
                    "machine".to_string(),
                    "ssh".to_string(),
                    "openbot".to_string(),
                    host_gateway_config_script("192.168.127.254".parse().unwrap()),
                ],
            ]
        );
    }

    #[test]
    fn owned_windows_podman_health_gate_writes_host_gateway_config() {
        let mut calls = Vec::<Vec<String>>::new();
        let inspect = machine_inspect("running", true);

        configure_owned_windows_podman_for_compose(
            &Address::new(Engine::Podman, Some("openbot".into())),
            |args| {
                calls.push(args.iter().map(|arg| (*arg).to_string()).collect());
                match args {
                    ["machine", "inspect", "openbot"] => Ok(inspect.clone()),
                    ["machine", "ssh", "openbot", "getent", "ahostsv4", "host.containers.internal"] => {
                        Ok("192.168.127.254 STREAM host.containers.internal\n".into())
                    }
                    ["machine", "ssh", "openbot", script]
                        if script.contains("host_containers_internal_ip=\"192.168.127.254\"") =>
                    {
                        Ok(String::new())
                    }
                    _ => Err(format!("unexpected args: {args:?}")),
                }
            },
            true,
        )
        .expect("owned Windows Podman health gate should prepare host-gateway config");

        assert_eq!(calls.len(), 3);
    }

    #[test]
    fn borrowed_podman_machine_health_gate_is_not_reconfigured() {
        let mut called = false;

        configure_owned_windows_podman_for_compose(
            &Address::new(Engine::Podman, Some("somebody-else".into())),
            |_args| {
                called = true;
                Ok(String::new())
            },
            true,
        )
        .expect("borrowed Podman machines are outside OpenBot's provisioning scope");

        assert!(!called);
    }

    #[test]
    fn loopback_host_gateway_resolution_is_rejected() {
        let error = validate_host_gateway_ip("127.0.0.1".parse().unwrap())
            .expect_err("loopback cannot be the container route to the Windows host");

        assert!(error.contains("unusable address"), "{error}");
    }

    #[test]
    #[cfg(unix)]
    fn joined_podman_ssh_write_command_creates_expected_host_config() {
        let home = temp_root("openbot-host-gateway-home");
        std::fs::create_dir_all(&home).unwrap();
        let command = host_gateway_config_script("192.168.127.254".parse().unwrap());
        let joined_remote_command = [command.as_str()].join(" ");

        let status = std::process::Command::new("sh")
            .arg("-c")
            .arg(&joined_remote_command)
            .env("HOME", &home)
            .status()
            .expect("execute joined remote command under sh");

        assert!(status.success(), "joined command failed: {status}");
        let written = std::fs::read_to_string(home.join(HOST_GATEWAY_CONFIG)).unwrap();
        assert_eq!(
            written,
            "[containers]\nhost_containers_internal_ip=\"192.168.127.254\"\n"
        );
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    #[cfg(unix)]
    fn failed_health_gate_detail_keeps_stdout_as_well_as_stderr() {
        let detail = command_failure(
            "podman",
            &["version", "--format", "{{.Server.APIVersion}}"],
            &output(77, "server says no", "stderr says why"),
        );

        assert!(detail.contains("status 77"), "{detail}");
        assert!(detail.contains("stdout: server says no"), "{detail}");
        assert!(detail.contains("stderr: stderr says why"), "{detail}");
    }

    #[test]
    #[cfg(unix)]
    fn failed_podman_process_boundary_keeps_stdout_stderr_and_status() {
        let dir = temp_root("podman-process-proof");
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("podman");
        std::fs::write(
            &fake,
            "#!/bin/sh\necho stdout-from-podman\necho stderr-from-podman >&2\nexit 42\n",
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let failure = podman_with(&["machine", "list", "--quiet"], || {
            std::process::Command::new(&fake)
                .args(["machine", "list", "--quiet"])
                .output()
        })
        .expect_err("fake podman exits nonzero");

        assert!(failure.contains("podman machine list --quiet"), "{failure}");
        assert!(failure.contains("status 42"), "{failure}");
        assert!(failure.contains("stdout: stdout-from-podman"), "{failure}");
        assert!(failure.contains("stderr: stderr-from-podman"), "{failure}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_machine_this_app_starts_is_addressed_by_name_not_by_the_default_connection() {
        let addressed = address();
        assert_eq!(addressed.connection.as_deref(), Some(MACHINE));
        assert_eq!(addressed.engine, Engine::Podman);
    }

    #[test]
    fn the_machine_has_its_own_name_so_an_existing_one_is_not_adopted() {
        assert_ne!(MACHINE, "podman-machine-default");
    }

    #[test]
    fn the_local_system_refusal_is_turned_into_an_instruction() {
        let explained = explain_machine_error("Error code: Wsl/WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED");
        assert!(
            explained.contains("as you"),
            "did not say whose session it needs: {explained}"
        );
        assert!(!explained.contains("0xffffffff"));
    }

    #[test]
    fn the_missing_component_refusal_asks_for_the_restart_it_needs() {
        let explained =
            explain_machine_error("Error code: Wsl/WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED");
        assert!(
            explained.contains("restart"),
            "did not mention the restart: {explained}"
        );
    }

    /// A step that stopped keeps the engine's words, and does not make them the headline. This is
    /// the case that put "exit status 0xffffffff" in front of somebody as the whole message.
    #[test]
    fn a_step_that_stopped_carries_both_registers() {
        let stopped = StepOutcome::stopped(Step::CreateMachine, "exit status 0xffffffff");
        assert!(!stopped.ok);
        assert_eq!(stopped.detail.as_deref(), Some("exit status 0xffffffff"));
        assert_eq!(stopped.problem().detail, stopped.detail);
        assert_eq!(stopped.problem().said, stopped.said);
    }

    /// A step that worked has nothing behind it, because there is no failure to explain.
    #[test]
    fn a_step_that_worked_has_no_output_hidden_behind_it() {
        let went = StepOutcome::went(Step::StartMachine, "openbot started.");
        assert!(went.ok);
        assert_eq!(went.detail, None);
    }

    #[test]
    fn an_error_we_do_not_recognise_is_passed_through_rather_than_swallowed() {
        let explained = explain_machine_error("some novel failure");
        assert_eq!(explained, "some novel failure");
    }
}
