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
use std::path::Path;

use serde::{Deserialize, Serialize};

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
        crate::problem::Problem {
            said: self.said.clone(),
            detail: self.detail.clone(),
        }
    }
}

/// The name of the machine this app owns.
///
/// Its own, not `podman-machine-default`: somebody may already have a machine with their own work
/// in it, and an installer that reconfigures or deletes it has taken something that was not
/// offered.
pub const MACHINE: &str = "openbot";

fn podman(args: &[&str]) -> Result<String, String> {
    // Resolved, not named: right after OpenBot installs it, `podman` is not yet on this process's
    // PATH. See the PATH rule in `engine.rs`.
    let output = crate::engine::tool(Engine::Podman)
        .args(args)
        .output()
        .map_err(|error| format!("could not run podman: {error}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    Err(command_said(&output.stderr))
}

/// Does this app's machine already exist?
pub fn machine_exists() -> bool {
    podman(&["machine", "inspect", MACHINE]).is_ok()
}

/// Create the machine.
///
/// No `--provider`: `applehv` has been the default on Apple silicon since Podman 6.1, and pinning it
/// asks for what you already get. The libkrun bind-mount trouble that the pin was written for
/// belonged to 5.7, where libkrun was the default.
pub fn create_machine(cpus: u32, memory_mib: u32, disk_gib: u32) -> StepOutcome {
    if machine_exists() {
        return StepOutcome::went(Step::CreateMachine, format!("{MACHINE} already exists."));
    }
    match podman(&[
        "machine",
        "init",
        MACHINE,
        "--cpus",
        &cpus.to_string(),
        "--memory",
        &memory_mib.to_string(),
        "--disk-size",
        &disk_gib.to_string(),
    ]) {
        Ok(_) => StepOutcome::went(Step::CreateMachine, format!("{MACHINE} created.")),
        Err(error) => StepOutcome::stopped(Step::CreateMachine, &error),
    }
}

pub fn start_machine() -> StepOutcome {
    match podman(&["machine", "start", MACHINE]) {
        Ok(_) => StepOutcome::went(Step::StartMachine, format!("{MACHINE} started.")),
        Err(error) if error.contains("already running") => StepOutcome::went(
            Step::StartMachine,
            format!("{MACHINE} was already running."),
        ),
        Err(error) => StepOutcome::stopped(Step::StartMachine, &error),
    }
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
            &format!("{binary} did not answer: {}", command_said(&out.stderr)),
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
