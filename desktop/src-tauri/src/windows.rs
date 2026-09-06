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
    /// The features are on but the WSL2 kernel is not there, so nothing can actually run.
    WslNoKernel,
    /// Virtualization is off in firmware. Only the person, in their BIOS, can fix this.
    VirtualizationDisabled,
    /// The account cannot elevate.
    NotAdministrator,
}

impl Blocker {
    /// What the screen says. Each names the specific fix, and the one we cannot perform says so.
    pub fn instruction(self) -> &'static str {
        match self {
            // Says what to run, because OpenBot does not do it. The screen used to say "OpenBot
            // can install it", and nothing in this application installs anything: there is no
            // button under the sentence and no code behind one. Somebody read that, waited, and
            // had been told to wait for something that was never going to happen.
            Blocker::WslAbsent => {
                "Windows Subsystem for Linux is not installed. Open Windows Terminal or PowerShell \
                 as an administrator, run `wsl --install`, restart Windows, and start OpenBot \
                 again."
            }
            Blocker::WslOne => {
                "Windows Subsystem for Linux is at version 1. Open Windows Terminal or PowerShell \
                 as an administrator, run `wsl --set-default-version 2`, restart Windows, and \
                 start OpenBot again."
            }
            // Measured on Windows Server 2022. `wsl --install` enabled both features and stopped
            // there, leaving the inbox WSL with no kernel, and `Get-WindowsOptionalFeature` says
            // Enabled for exactly that state. Nothing looked wrong until `podman machine init`
            // died on `wsl --import ... --version 2` with `exit status 0xffffffff`, which is not
            // a sentence anybody can act on.
            Blocker::WslNoKernel => {
                "Windows Subsystem for Linux is switched on but its Linux kernel is missing, so \
                 nothing can run inside it yet. Open Windows Terminal or PowerShell as an \
                 administrator, run `wsl --update`, restart Windows, and start OpenBot again."
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
    /// Whether OpenBot could fix this itself, one day.
    ///
    /// Nothing acts on this yet. `wsl --install` needs elevation and a restart, and the resumable
    /// state machine that would carry somebody across that reboot is designed and not built, so
    /// every blocker screen currently tells a person what to run. Kept because the two halves are
    /// genuinely different: WSL is installable and a firmware setting is not.
    pub fn ours_to_fix(self) -> bool {
        matches!(
            self,
            Blocker::WslAbsent | Blocker::WslOne | Blocker::WslNoKernel
        )
    }
}

/// The persisted step, beside the rest of the app's data.
/// Whether WSL has a kernel to run, given what `wsl --version` said and whether the kernel file
/// that the update package installs is on disk.
///
/// Both are asked because either alone is wrong. `wsl --version` is absent from the older inbox
/// `wsl.exe` on builds where WSL2 nevertheless works perfectly, having had its kernel installed by
/// the standalone update package, so refusing on that alone would block a machine that is fine.
/// The kernel file alone is not enough either: a modern WSL reports its kernel version without
/// that path necessarily being the one in use.
///
/// So this only says "no kernel" when **neither** answers, which is the state actually measured on
/// a Server 2022 machine where `wsl --install` had enabled the features and done nothing else.
pub fn wsl_kernel_present(version_output: &str, kernel_file_exists: bool) -> bool {
    kernel_file_exists || version_output.to_lowercase().contains("kernel version")
}

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
    std::fs::write(
        state_path(data_dir),
        serde_json::to_string(&step).unwrap_or_default(),
    )
}

/// Read the machine and say which of the four, if any, is in the way.
///
/// Order matters. Firmware virtualization is checked first because nothing else can be fixed while
/// it is off, and telling somebody to install WSL when their BIOS will not allow a VM wastes a
/// restart to arrive at the same place.
/// Whether this machine can run a virtual machine, from the two things Windows will say about it.
///
/// Either answer is enough. `VirtualizationFirmwareEnabled` reports False once a hypervisor has
/// claimed the extensions, which is exactly the state of a machine where WSL2 already works, so
/// asking only that sends everybody running Hyper-V to a screen telling them to switch on a
/// firmware setting that is already on. Measured on Windows Server 2022: firmware False,
/// hypervisor True.
// Only `blocker` calls it, and only on Windows, but the rule is pure and the test that pins it
// should run everywhere rather than on the one platform nobody runs the tests on.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn virtualization_available(hypervisor_present: bool, firmware_enabled: bool) -> bool {
    hypervisor_present || firmware_enabled
}

#[cfg(target_os = "windows")]
pub fn blocker() -> Option<Blocker> {
    use crate::quiet::command;

    // Two questions, not one, and either answer is enough.
    //
    // `VirtualizationFirmwareEnabled` reports False once a hypervisor has claimed the extensions,
    // which is exactly the state of a machine where WSL2 is already working. Asking only that
    // sends everybody running Hyper-V to a screen telling them to switch on a firmware setting
    // that is already on, and which they cannot switch on again. Measured on Windows Server 2022:
    // `VirtualizationFirmwareEnabled: False`, `HypervisorPresent: True`.
    //
    // A hypervisor that is present is virtualization that is working, whatever the firmware says
    // about it. Where neither is true the firmware really is the thing to change.
    let reported = command("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "'hypervisor=' + (Get-CimInstance Win32_ComputerSystem).HypervisorPresent; \
             'firmware=' + ((Get-CimInstance Win32_Processor | \
               ForEach-Object { $_.VirtualizationFirmwareEnabled }) -contains $true)",
        ])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).to_lowercase())
        .unwrap_or_default();
    if !virtualization_available(
        reported.contains("hypervisor=true"),
        reported.contains("firmware=true"),
    ) {
        return Some(Blocker::VirtualizationDisabled);
    }

    let elevated = command("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        ])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).to_lowercase().contains("true"))
        .unwrap_or(false);

    let features = command("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "(Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux).State",
        ])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default();

    if features != "Enabled" {
        return Some(if elevated {
            Blocker::WslAbsent
        } else {
            Blocker::NotAdministrator
        });
    }

    let default_version = command("wsl.exe")
        .args(["--status"])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).replace('\0', ""))
        .unwrap_or_default();
    if default_version.contains("Default Version: 1") {
        return Some(Blocker::WslOne);
    }

    let version_output = command("wsl.exe")
        .args(["--version"])
        .output()
        .map(|out| {
            // wsl.exe writes UTF-16, which arrives here with a NUL between every character.
            String::from_utf8_lossy(&out.stdout).replace('\0', "")
        })
        .unwrap_or_default();
    let kernel_file_exists = std::env::var("SystemRoot")
        .map(|root| {
            Path::new(&root)
                .join(r"System32\lxss\tools\kernel")
                .exists()
        })
        .unwrap_or(false);
    if !wsl_kernel_present(&version_output, kernel_file_exists) {
        return Some(Blocker::WslNoKernel);
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
    fn a_machine_already_running_a_hypervisor_is_not_told_to_switch_virtualization_on() {
        // The state of every machine where WSL2 already works, and the one this got wrong.
        assert!(virtualization_available(true, false));
        assert!(virtualization_available(true, true));
        assert!(virtualization_available(false, true));
    }

    #[test]
    fn a_machine_with_neither_is_the_one_whose_firmware_is_the_thing_to_change() {
        assert!(!virtualization_available(false, false));
    }

    #[test]
    fn no_blocker_screen_offers_to_do_something_this_application_does_not_do() {
        // The screen said "OpenBot can install it" while nothing installed anything and there was
        // no button to press. Seen on Windows Server 2022 with WSL genuinely disabled.
        for blocker in [
            Blocker::WslAbsent,
            Blocker::WslOne,
            Blocker::VirtualizationDisabled,
            Blocker::NotAdministrator,
        ] {
            let said = blocker.instruction();
            // "OpenBot cannot" is the honest half of this and must survive the check.
            assert!(
                !said.contains("OpenBot can install") && !said.contains("OpenBot can convert"),
                "promises what nothing does: {said}"
            );
        }
    }

    #[test]
    fn the_two_installable_blockers_name_the_command_that_fixes_them() {
        assert!(Blocker::WslAbsent.instruction().contains("wsl --install"));
        assert!(Blocker::WslNoKernel.instruction().contains("wsl --update"));

        assert!(Blocker::WslOne
            .instruction()
            .contains("wsl --set-default-version 2"));
    }

    #[test]
    fn each_blocker_names_its_own_fix_rather_than_saying_setup_failed() {
        for blocker in [
            Blocker::WslAbsent,
            Blocker::WslOne,
            Blocker::VirtualizationDisabled,
            Blocker::NotAdministrator,
        ] {
            let text = blocker.instruction();
            assert!(text.len() > 40, "{blocker:?} has no instruction");
            assert!(!text.to_lowercase().contains("setup failed"));
        }
    }

    #[test]
    fn the_two_we_cannot_fix_say_who_has_to() {
        assert!(!Blocker::VirtualizationDisabled.ours_to_fix());
        assert!(Blocker::VirtualizationDisabled
            .instruction()
            .contains("firmware"));
        assert!(!Blocker::NotAdministrator.ours_to_fix());
        assert!(Blocker::NotAdministrator
            .instruction()
            .contains("administrator"));
    }

    #[test]
    fn the_two_we_can_fix_promise_the_restart_they_will_cost() {
        for blocker in [Blocker::WslAbsent, Blocker::WslOne] {
            assert!(blocker.ours_to_fix());
            assert!(
                blocker.instruction().contains("restart"),
                "{blocker:?} hides the restart"
            );
        }
    }

    #[test]
    fn the_step_survives_the_restart_that_ends_the_process() {
        let dir = std::env::temp_dir().join(format!("openbot-winstate-{}", std::process::id()));
        assert_eq!(
            read_step(&dir),
            SetupStep::Start,
            "an unknown machine starts at the beginning"
        );

        write_step(&dir, SetupStep::AwaitingRestart).unwrap();
        assert_eq!(
            read_step(&dir),
            SetupStep::AwaitingRestart,
            "the step did not survive being written"
        );

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

    /// The state measured on Server 2022: features on, inbox `wsl.exe` that does not know
    /// `--version`, no kernel file. This is what let the app march on and fail inside Podman.
    #[test]
    fn no_kernel_when_neither_the_version_nor_the_file_says_so() {
        assert!(!wsl_kernel_present(
            "Invalid command line option: --version",
            false
        ));
    }

    /// A modern WSL answers `--version` with its kernel, and is fine even if that particular
    /// path is not the kernel in use.
    #[test]
    fn a_reported_kernel_is_enough_on_its_own() {
        assert!(wsl_kernel_present(
            "WSL version: 2.7.13.0\nKernel version: 6.18.33.2-2",
            false
        ));
    }

    /// The older builds that matter: `wsl.exe` predates `--version`, but the update package put
    /// a kernel on disk and WSL2 works. Refusing these would block a working machine.
    #[test]
    fn the_kernel_file_is_enough_on_its_own() {
        assert!(wsl_kernel_present(
            "Invalid command line option: --version",
            true
        ));
    }
}
