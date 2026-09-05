//! Windows setup, which is a state machine because it crosses a restart.
//!
//! `wsl --install` needs administrator rights and a reboot. `podman machine init` needs the opposite
//! of the first: WSL refuses to run as LocalSystem
//! (`Wsl/WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`), so it must run in the signed-in person's own session.
//! Setup therefore cannot be one elevated script, and it cannot be one session either. It is:
//!
//! 1. as the person, decide what is missing;
//! 2. elevated, once, enable the features;
//! 3. restart;
//! 4. as the person again, create and start the machine.
//!
//! The step is written to disk before the restart and read back after, so the app returns to the
//! screen it left rather than starting over. That file is the whole reason this is a module and not
//! three function calls.
//!
//! Verified on Windows Server 2022 during S2: the inbox `wsl.exe` rejects `--no-distribution` as an
//! incorrect parameter and does not understand `--version`, so the current WSL is installed
//! separately rather than assumed.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Where setup has got to. Persisted, because step 3 ends the process.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SetupStep {
    /// Nothing done yet.
    Start,
    /// Features asked for; the restart has not happened.
    AwaitingRestart,
    /// Back from the restart, machine not yet created.
    FeaturesReady,
    Done,
}

/// The four named ways this fails, each with its own screen.
///
/// A single "setup failed" is the outcome this exists to prevent: these have different fixes and
/// only one of them is ours to perform.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Blocker {
    /// WSL is not installed at all.
    WslAbsent,
    /// WSL1 is present and has to be converted.
    WslOne,
    /// Virtualization is off in firmware. Only the person, in their BIOS, can fix this.
    VirtualizationDisabled,
    /// The account cannot elevate.
    NotAdministrator,
}

impl Blocker {
    /// What the screen says. Each names the specific fix, and the one we cannot perform says so.
    pub fn instruction(self) -> &'static str {
        match self {
            Blocker::WslAbsent => {
                "Windows Subsystem for Linux is not installed. OpenBot can install it. \
                 Windows will need to restart once."
            }
            Blocker::WslOne => {
                "Windows Subsystem for Linux is at version 1. OpenBot can convert it to version 2. \
                 Windows will need to restart once."
            }
            Blocker::VirtualizationDisabled => {
                "Virtualization is switched off in this machine's firmware. It has to be turned on \
                 there, which OpenBot cannot do: restart, open the firmware settings, and enable \
                 Intel VT-x or AMD-V."
            }
            Blocker::NotAdministrator => {
                "Installing Windows Subsystem for Linux needs administrator rights, and this \
                 account does not have them. Sign in as an administrator, or ask one to run OpenBot \
                 once."
            }
        }
    }

    /// Whether the shell can clear this itself. Two of the four are ours; two are not.
    pub fn ours_to_fix(self) -> bool {
        matches!(self, Blocker::WslAbsent | Blocker::WslOne)
    }
}

/// The persisted step, beside the rest of the app's data.
pub fn state_path(data_dir: &Path) -> PathBuf {
    data_dir.join("windows-setup.json")
}

pub fn read_step(data_dir: &Path) -> SetupStep {
    std::fs::read_to_string(state_path(data_dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(SetupStep::Start)
}

pub fn write_step(data_dir: &Path, step: SetupStep) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    std::fs::write(state_path(data_dir), serde_json::to_string(&step).unwrap_or_default())
}

/// Read the machine and say which of the four, if any, is in the way.
///
/// Order matters. Firmware virtualization is checked first because nothing else can be fixed while
/// it is off, and telling somebody to install WSL when their BIOS will not allow a VM wastes a
/// restart to arrive at the same place.
#[cfg(target_os = "windows")]
pub fn blocker() -> Option<Blocker> {
    use std::process::Command;

    let firmware_ok = Command::new("powershell")
        .args(["-NoProfile", "-Command", "(Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled"])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).to_lowercase().contains("true"))
        .unwrap_or(false);
    if !firmware_ok {
        return Some(Blocker::VirtualizationDisabled);
    }

    let elevated = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        ])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).to_lowercase().contains("true"))
        .unwrap_or(false);

    let features = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "(Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux).State",
        ])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default();

    if features != "Enabled" {
        return Some(if elevated { Blocker::WslAbsent } else { Blocker::NotAdministrator });
    }

    let default_version = Command::new("wsl.exe")
        .args(["--status"])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).replace('\0', ""))
        .unwrap_or_default();
    if default_version.contains("Default Version: 1") {
        return Some(Blocker::WslOne);
    }

    None
}

#[cfg(not(target_os = "windows"))]
pub fn blocker() -> Option<Blocker> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_blocker_names_its_own_fix_rather_than_saying_setup_failed() {
        for blocker in [Blocker::WslAbsent, Blocker::WslOne, Blocker::VirtualizationDisabled, Blocker::NotAdministrator] {
            let text = blocker.instruction();
            assert!(text.len() > 40, "{blocker:?} has no instruction");
            assert!(!text.to_lowercase().contains("setup failed"));
        }
    }

    #[test]
    fn the_two_we_cannot_fix_say_who_has_to() {
        assert!(!Blocker::VirtualizationDisabled.ours_to_fix());
        assert!(Blocker::VirtualizationDisabled.instruction().contains("firmware"));
        assert!(!Blocker::NotAdministrator.ours_to_fix());
        assert!(Blocker::NotAdministrator.instruction().contains("administrator"));
    }

    #[test]
    fn the_two_we_can_fix_promise_the_restart_they_will_cost() {
        for blocker in [Blocker::WslAbsent, Blocker::WslOne] {
            assert!(blocker.ours_to_fix());
            assert!(blocker.instruction().contains("restart"), "{blocker:?} hides the restart");
        }
    }

    #[test]
    fn the_step_survives_the_restart_that_ends_the_process() {
        let dir = std::env::temp_dir().join(format!("openbot-winstate-{}", std::process::id()));
        assert_eq!(read_step(&dir), SetupStep::Start, "an unknown machine starts at the beginning");

        write_step(&dir, SetupStep::AwaitingRestart).unwrap();
        assert_eq!(read_step(&dir), SetupStep::AwaitingRestart, "the step did not survive being written");

        write_step(&dir, SetupStep::FeaturesReady).unwrap();
        assert_eq!(read_step(&dir), SetupStep::FeaturesReady);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unreadable_state_starts_over_rather_than_refusing_to_run() {
        let dir = std::env::temp_dir().join(format!("openbot-winstate-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(state_path(&dir), "{ not json").unwrap();
        assert_eq!(read_step(&dir), SetupStep::Start);
        std::fs::remove_dir_all(&dir).ok();
    }
}
