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

use crate::problem::Problem;

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
    /// WSL is enabled but the Virtual Machine Platform feature needed by WSL2 is off.
    VirtualMachinePlatformDisabled,
    /// Virtualization is off in firmware. Only the person, in their BIOS, can fix this.
    VirtualizationDisabled,
    /// The account cannot elevate.
    NotAdministrator,
}

impl Blocker {
    /// What the screen says. Each names the specific fix, and the one we cannot perform says so.
    pub fn instruction(self) -> &'static str {
        match self {
            Blocker::VirtualMachinePlatformDisabled => {
                "Virtual Machine Platform is switched off. Open Windows Terminal or PowerShell \
                 as an administrator, run `dism.exe /online /enable-feature \
                 /featurename:VirtualMachinePlatform /all /norestart`, restart Windows, and \
                 start OpenBot again."
            }
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
                "Setting up Windows Subsystem for Linux needs administrator rights. Ask an \
                 administrator to open Windows Terminal or PowerShell as an administrator and run \
                 `dism.exe /online /enable-feature \
                 /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart`, \
                 `dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart`, \
                 and `wsl --install`. Restart Windows, then start OpenBot again in your own account."
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
            Blocker::WslAbsent
                | Blocker::WslOne
                | Blocker::WslNoKernel
                | Blocker::VirtualMachinePlatformDisabled
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
/// The caller must check probe success first: command failure is not evidence of a missing kernel.
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
pub fn blocker() -> Result<Option<Blocker>, Problem> {
    blocker_with(
        |program, args| crate::quiet::command(program).args(args).output(),
        || {
            let root = std::env::var_os("SystemRoot")
                .filter(|root| !root.is_empty())
                .ok_or_else(|| {
                    detection_failed("the WSL kernel file", "SystemRoot is missing or empty")
                })?;
            let path = Path::new(&root).join(r"System32\lxss\tools\kernel");
            match std::fs::metadata(&path) {
                Ok(metadata) if metadata.is_file() => Ok(true),
                Ok(_) => Err(detection_failed(
                    "the WSL kernel file",
                    format!("{} is not a file", path.display()),
                )),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(error) => Err(detection_failed(
                    "the WSL kernel file",
                    format!("{}: {error}", path.display()),
                )),
            }
        },
    )
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn detection_failed(operation: &str, detail: impl Into<String>) -> Problem {
    Problem::with(
        format!("OpenBot could not check {operation}. Close and reopen OpenBot to try again."),
        detail,
    )
}

/// Inspect the exit status before interpreting stdout as a machine state. Keep both streams:
/// wsl.exe can put its diagnostic on stdout, and a failed PowerShell pipeline can have partial output.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn probe_text(
    operation: &str,
    output: std::io::Result<std::process::Output>,
) -> Result<String, Problem> {
    let output = output
        .map_err(|error| detection_failed(operation, format!("Could not start probe: {error}")))?;
    let stdout = decode_probe_text(&output.stdout);
    let stderr = decode_probe_text(&output.stderr);
    if !output.status.success() {
        // Decoding failures are diagnostics too; retain the bytes if they were not valid text.
        let stdout = stdout.unwrap_or_else(|error| format!("{error}: {:?}", output.stdout));
        let stderr = stderr.unwrap_or_else(|error| format!("{error}: {:?}", output.stderr));
        return Err(detection_failed(
            operation,
            format!(
                "Probe exited with {}\nstdout:\n{stdout}\nstderr:\n{stderr}",
                output.status
            ),
        ));
    }
    let stdout = stdout.map_err(|error| {
        detection_failed(operation, format!("Could not decode probe stdout: {error}"))
    })?;
    let stderr = stderr.map_err(|error| {
        detection_failed(operation, format!("Could not decode probe stderr: {error}"))
    })?;
    if stdout.trim().is_empty() {
        return Err(detection_failed(
            operation,
            format!("Probe returned empty output.\nstderr:\n{stderr}"),
        ));
    }
    Ok(stdout.trim().to_string())
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn decode_probe_text(bytes: &[u8]) -> Result<String, String> {
    // wsl.exe writes UTF-16LE to redirected pipes on inbox builds. Stripping NUL bytes corrupts
    // non-ASCII diagnostics; PowerShell's ASCII boolean results and modern UTF-8 also work here.
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.contains(&0) {
        let bytes = bytes.strip_prefix(&[0xff, 0xfe]).unwrap_or(bytes);
        if bytes.len() % 2 != 0 {
            return Err("Truncated UTF-16 probe output".into());
        }
        let units = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16(&units).map_err(|error| error.to_string())
    } else {
        String::from_utf8(bytes.to_vec()).map_err(|error| error.to_string())
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn probe_bool(operation: &str, output: &str) -> Result<bool, Problem> {
    match output.trim().to_ascii_lowercase().as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(detection_failed(
            operation,
            format!("Expected True or False; probe returned: {output}"),
        )),
    }
}

/// The native adapter above only supplies process execution and the legacy kernel-file check.
/// Keeping the decision path shared lets failure tests run without touching Windows components.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn blocker_with(
    mut run: impl FnMut(&str, &[&str]) -> std::io::Result<std::process::Output>,
    kernel_file_exists: impl FnOnce() -> Result<bool, Problem>,
) -> Result<Option<Blocker>, Problem> {
    // A running hypervisor is positive virtualization evidence even when firmware reports False.
    // Stop converts CIM/DISM non-terminating errors into failed probes instead of partial answers.
    let virtualization = "Windows virtualization support (powershell)";
    let reported = probe_text(
        virtualization,
        run(
            "powershell",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$ErrorActionPreference = 'Stop'; \
         'hypervisor=' + (Get-CimInstance Win32_ComputerSystem).HypervisorPresent; \
         'firmware=' + ((Get-CimInstance Win32_Processor | \
           ForEach-Object { $_.VirtualizationFirmwareEnabled }) -contains $true)",
            ],
        ),
    )?;
    let lines: Vec<_> = reported.lines().map(str::trim).collect();
    let [hypervisor, firmware] = lines.as_slice() else {
        return Err(detection_failed(
            virtualization,
            format!("Unexpected probe output: {reported}"),
        ));
    };
    let hypervisor = hypervisor.strip_prefix("hypervisor=").ok_or_else(|| {
        detection_failed(
            virtualization,
            format!("Missing hypervisor result: {reported}"),
        )
    })?;
    let firmware = firmware.strip_prefix("firmware=").ok_or_else(|| {
        detection_failed(
            virtualization,
            format!("Missing firmware result: {reported}"),
        )
    })?;
    if !virtualization_available(
        probe_bool(virtualization, hypervisor)?,
        probe_bool(virtualization, firmware)?,
    ) {
        return Ok(Some(Blocker::VirtualizationDisabled));
    }

    let administrator = "Windows administrator rights (powershell)";
    let elevated = probe_bool(administrator, &probe_text(administrator, run("powershell", &[
        "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference = 'Stop'; \
         ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    ]))?)?;

    let wsl_feature = "the WSL feature state (powershell)";
    let enabled = probe_bool(wsl_feature, &probe_text(wsl_feature, run("powershell", &[
        "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference = 'Stop'; \
         $state = (Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux).State; \
         if ($null -eq $state) { throw 'WSL feature query returned no state' }; \
         $state -eq 'Enabled'",
    ]))?)?;
    if !enabled {
        return Ok(Some(if elevated {
            Blocker::WslAbsent
        } else {
            Blocker::NotAdministrator
        }));
    }

    let vmp_feature = "the Virtual Machine Platform feature state (powershell)";
    let enabled = probe_bool(vmp_feature, &probe_text(vmp_feature, run("powershell", &[
        "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference = 'Stop'; \
         $state = (Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform).State; \
         if ($null -eq $state) { throw 'Virtual Machine Platform feature query returned no state' }; \
         $state -eq 'Enabled'",
    ]))?)?;
    if !enabled {
        return Ok(Some(if elevated {
            Blocker::VirtualMachinePlatformDisabled
        } else {
            Blocker::NotAdministrator
        }));
    }

    let default_version = probe_text(
        "WSL status (wsl.exe --status)",
        run("wsl.exe", &["--status"]),
    )?;
    if default_version.contains("Default Version: 1") {
        return Ok(Some(Blocker::WslOne));
    }

    // Inbox WSL predates --version. A positively inspected kernel file is enough, so do not run
    // an unsupported command in that case. An executed probe failing is never "no kernel".
    if kernel_file_exists()? {
        return Ok(None);
    }
    let version_output = probe_text(
        "the WSL version (wsl.exe --version)",
        run("wsl.exe", &["--version"]),
    )?;
    if !wsl_kernel_present(&version_output, false) {
        return Ok(Some(Blocker::WslNoKernel));
    }
    Ok(None)
}

#[cfg(not(target_os = "windows"))]
pub fn blocker() -> Result<Option<Blocker>, Problem> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    const PROBE_OUTPUTS: [&str; 6] = [
        "hypervisor=True\nfirmware=False\n",
        "True\n",
        "True\n",
        "True\n",
        "Default Version: 2\n",
        "WSL version: 2.7.13.0\nKernel version: 6.18.33.2-2\n",
    ];

    fn assert_probe_call(probe: usize, program: &str, args: &[&str]) {
        if probe < 4 {
            assert_eq!(program, "powershell");
            assert_eq!(args.len(), 4);
            assert_eq!(&args[..3], ["-NoProfile", "-NonInteractive", "-Command"]);
            assert!(args[3].starts_with("$ErrorActionPreference = 'Stop'; "));
            assert!(args[3].contains(match probe {
                0 => "Get-CimInstance Win32_ComputerSystem",
                1 => "WindowsBuiltInRole]::Administrator",
                2 => "-FeatureName Microsoft-Windows-Subsystem-Linux",
                3 => "-FeatureName VirtualMachinePlatform",
                _ => unreachable!(),
            }));
            if probe == 3 {
                assert_eq!(args[3], "$ErrorActionPreference = 'Stop'; \
                    $state = (Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform).State; \
                    if ($null -eq $state) { throw 'Virtual Machine Platform feature query returned no state' }; \
                    $state -eq 'Enabled'");
            }
        } else {
            assert_eq!(program, "wsl.exe");
            assert_eq!(
                args,
                [match probe {
                    4 => "--status",
                    5 => "--version",
                    _ => panic!("unexpected extra probe {probe}"),
                }]
            );
        }
    }

    fn probe_output(code: i32, stdout: &str, stderr: &str) -> std::process::Output {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        std::process::Output {
            #[cfg(unix)]
            status: std::process::ExitStatus::from_raw(code << 8),
            #[cfg(windows)]
            status: std::process::ExitStatus::from_raw(code as u32),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[test]
    fn vmp_disabled_blocks_before_wsl_or_engine_setup() {
        let mut calls = Vec::new();
        let result = blocker_with(
            |program, args| {
                assert_probe_call(calls.len(), program, args);
                calls.push((program.to_string(), args.join(" ")));
                let stdout = if args.iter().any(|arg| arg.contains("Win32_ComputerSystem")) {
                    "hypervisor=True\nfirmware=False"
                } else if args
                    .iter()
                    .any(|arg| arg.contains("VirtualMachinePlatform"))
                {
                    "False"
                } else if program == "powershell" {
                    "True"
                } else if args == ["--status"] {
                    "Default Version: 2"
                } else {
                    "WSL version: 2.7.13.0\nKernel version: 6.18.33.2-2"
                };
                Ok(probe_output(0, stdout, ""))
            },
            || panic!("disabled VMP must stop before kernel inspection"),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!("virtual-machine-platform-disabled")
        );
        assert!(!calls.iter().any(|(program, _)| program == "wsl.exe"));
    }

    fn fail_probe_at(
        failing_probe: usize,
        failure: std::io::Result<std::process::Output>,
    ) -> Result<Option<Blocker>, Problem> {
        let mut failure = Some(failure);
        let mut probe = 0;
        let result = blocker_with(
            |program, args| {
                assert_probe_call(probe, program, args);
                let current = probe;
                probe += 1;
                if current == failing_probe {
                    failure.take().unwrap()
                } else {
                    Ok(probe_output(0, PROBE_OUTPUTS[current], ""))
                }
            },
            || Ok(false),
        );
        assert_eq!(probe, failing_probe + 1, "continued after a failed probe");
        result
    }

    #[test]
    fn vmp_blocker_round_trips_and_names_the_precise_feature_command() {
        let blocker: Blocker =
            serde_json::from_str("\"virtual-machine-platform-disabled\"").unwrap();
        assert_eq!(blocker, Blocker::VirtualMachinePlatformDisabled);
        assert_eq!(
            serde_json::to_string(&blocker).unwrap(),
            "\"virtual-machine-platform-disabled\""
        );
        assert_eq!(blocker.instruction(), "Virtual Machine Platform is switched off. \
            Open Windows Terminal or PowerShell as an administrator, run \
            `dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart`, \
            restart Windows, and start OpenBot again.");
        assert!(blocker.ours_to_fix());
    }

    #[test]
    fn vmp_probe_failures_keep_the_operation_and_diagnostic() {
        for (failure, diagnostic) in [
            (
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "synthetic VMP launch denied",
                )),
                "synthetic VMP launch denied",
            ),
            (
                Ok(probe_output(17, "True", "VMP query denied")),
                "VMP query denied",
            ),
            (
                Ok(probe_output(17, "False", "VMP query denied")),
                "VMP query denied",
            ),
            (
                Ok(probe_output(0, "", "VMP returned no state")),
                "VMP returned no state",
            ),
            (
                Ok(probe_output(0, "garbled VMP state", "")),
                "garbled VMP state",
            ),
        ] {
            let error = fail_probe_at(3, failure).unwrap_err();
            assert!(error
                .said
                .contains("the Virtual Machine Platform feature state (powershell)"));
            assert!(error.detail.unwrap().contains(diagnostic));
        }
        let mut output = probe_output(0, "", "");
        output.stdout = vec![0xff];
        let error = fail_probe_at(3, Ok(output)).unwrap_err();
        assert!(error
            .said
            .contains("the Virtual Machine Platform feature state (powershell)"));
        assert!(error
            .detail
            .unwrap()
            .contains("Could not decode probe stdout"));
    }

    #[test]
    fn healthy_vmp_utf16_output_continues_to_wsl() {
        let mut probe = 0;
        let result = blocker_with(
            |program, args| {
                assert_probe_call(probe, program, args);
                let mut output = probe_output(0, PROBE_OUTPUTS[probe], "");
                if probe == 3 {
                    output.stdout = "True\r\n"
                        .encode_utf16()
                        .flat_map(u16::to_le_bytes)
                        .collect();
                }
                probe += 1;
                Ok(output)
            },
            || Ok(false),
        );
        assert_eq!(result, Ok(None));
        assert_eq!(probe, 6);
    }

    #[test]
    fn probe_launch_failures_are_detection_errors_instead_of_setup_guidance() {
        for probe in 0..PROBE_OUTPUTS.len() {
            let result = fail_probe_at(
                probe,
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "synthetic probe launch denied",
                )),
            );
            let error = result.expect_err(&format!("probe {probe} hid its launch failure"));
            assert!(error
                .detail
                .unwrap()
                .contains("synthetic probe launch denied"));
        }
    }

    #[test]
    fn unsuccessful_probes_preserve_diagnostics_even_with_plausible_stdout() {
        for (probe, stdout) in PROBE_OUTPUTS.iter().enumerate() {
            let result = fail_probe_at(
                probe,
                Ok(probe_output(17, stdout, "synthetic command access denied")),
            );
            let error = result.expect_err(&format!("probe {probe} hid its nonzero exit"));
            let detail = error.detail.unwrap();
            assert!(detail.contains("synthetic command access denied"));
            assert!(detail.contains("17"));
        }
    }

    #[test]
    fn malformed_successful_powershell_probes_are_detection_errors() {
        for probe in 0..4 {
            let result = fail_probe_at(probe, Ok(probe_output(0, "", "")));
            assert!(
                result.is_err(),
                "probe {probe} accepted empty output: {result:?}"
            );
        }
    }

    #[test]
    fn failed_kernel_file_inspection_is_a_detection_error() {
        let mut probe = 0;
        let result = blocker_with(
            |program, args| {
                assert_probe_call(probe, program, args);
                let output = probe_output(0, PROBE_OUTPUTS[probe], "");
                probe += 1;
                Ok(output)
            },
            || {
                Err(Problem::with(
                    "Kernel inspection failed",
                    "synthetic permission denied",
                ))
            },
        );
        assert!(
            result.is_err(),
            "kernel inspection failed but detection returned {result:?}"
        );
    }

    #[test]
    fn wsl_utf16_diagnostics_remain_readable() {
        let diagnostic = "synthetic WSL failure: accès refusé";
        let mut output = probe_output(17, "", "");
        output.stderr = diagnostic
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        let error = fail_probe_at(5, Ok(output)).unwrap_err();
        assert!(error.detail.unwrap().contains(diagnostic));
    }

    #[test]
    fn successful_probe_states_keep_the_existing_remediation() {
        for (outputs, expected) in [
            (
                [
                    "hypervisor=False\nfirmware=False",
                    "True",
                    "True",
                    "True",
                    "Default Version: 2",
                    "Kernel version: 6",
                ],
                Some(Blocker::VirtualizationDisabled),
            ),
            (
                [
                    PROBE_OUTPUTS[0],
                    "True",
                    "False",
                    "True",
                    PROBE_OUTPUTS[4],
                    PROBE_OUTPUTS[5],
                ],
                Some(Blocker::WslAbsent),
            ),
            (
                [
                    PROBE_OUTPUTS[0],
                    "False",
                    "False",
                    "True",
                    PROBE_OUTPUTS[4],
                    PROBE_OUTPUTS[5],
                ],
                Some(Blocker::NotAdministrator),
            ),
            (
                [
                    PROBE_OUTPUTS[0],
                    "True",
                    "True",
                    "True",
                    "Default Version: 1",
                    PROBE_OUTPUTS[5],
                ],
                Some(Blocker::WslOne),
            ),
            (
                [
                    PROBE_OUTPUTS[0],
                    "True",
                    "True",
                    "True",
                    PROBE_OUTPUTS[4],
                    "WSL version: 2",
                ],
                Some(Blocker::WslNoKernel),
            ),
            (PROBE_OUTPUTS, None),
        ] {
            let mut probe = 0;
            let result = blocker_with(
                |program, args| {
                    assert_probe_call(probe, program, args);
                    let output = probe_output(0, outputs[probe], "");
                    probe += 1;
                    Ok(output)
                },
                || Ok(false),
            );
            assert_eq!(result, Ok(expected));
        }
    }

    #[test]
    fn an_existing_inbox_kernel_does_not_require_the_unsupported_version_command() {
        let mut probe = 0;
        let result = blocker_with(
            |program, args| {
                assert_probe_call(probe, program, args);
                assert_ne!(args, ["--version"]);
                let output = probe_output(0, PROBE_OUTPUTS[probe], "");
                probe += 1;
                Ok(output)
            },
            || Ok(true),
        );
        assert_eq!(result, Ok(None));
        assert_eq!(probe, 5);
    }

    fn child_probe_output(
        code: &str,
        stdout: &str,
        stderr: &str,
    ) -> std::io::Result<std::process::Output> {
        #[cfg(unix)]
        let output = crate::quiet::command("/bin/sh")
            .args([
                "-c",
                "printf '%s' \"$1\"; printf '%s' \"$2\" >&2; exit \"$3\"",
                "openbot-probe-fixture",
                stdout,
                stderr,
                code,
            ])
            .output();
        #[cfg(windows)]
        let output = {
            let lines = stdout
                .lines()
                .map(|line| format!("echo {line}"))
                .collect::<Vec<_>>()
                .join(" & ");
            let diagnostic = if stderr.is_empty() {
                String::new()
            } else {
                format!("echo {stderr} 1>&2 & ")
            };
            crate::quiet::command("cmd")
                .args(["/D", "/C", &format!("{lines} & {diagnostic}exit /b {code}")])
                .output()
        };
        output
    }

    /// Actual child processes supply bytes and statuses to the production decision path. No
    /// PowerShell, Windows features, WSL installation, or real credential store is touched.
    #[test]
    fn detection_errors_cross_the_external_command_boundary() {
        for failing_probe in 0..PROBE_OUTPUTS.len() {
            let mut probe = 0;
            let mut calls = Vec::new();
            let result = blocker_with(
                |program, args| {
                    assert_probe_call(probe, program, args);
                    calls.push(serde_json::json!({ "program": program, "args": args }));
                    let stdout = PROBE_OUTPUTS[probe];
                    let stderr = if probe == failing_probe {
                        "synthetic external probe denied"
                    } else {
                        ""
                    };
                    let code = if probe == failing_probe { "17" } else { "0" };
                    probe += 1;
                    child_probe_output(code, stdout, stderr)
                },
                || Ok(false),
            );
            let error = result.unwrap_err();
            let detail = error.detail.as_deref().unwrap();
            assert!(detail.contains("synthetic external probe denied"));
            assert!(detail.contains("17"));
            assert_eq!(probe, failing_probe + 1, "continued after a failed probe");
            println!(
                "windows detection command boundary: {}",
                serde_json::to_string(&error).unwrap()
            );
            println!(
                "windows blocker command payload: {}",
                serde_json::json!({
                    "scenario": format!("failed-probe-{failing_probe}"),
                    "problem": error,
                    "calls": calls,
                })
            );
        }
    }

    #[test]
    fn feature_states_cross_the_external_command_boundary() {
        for (scenario, elevated, wsl, vmp, expected, expected_probes) in [
            (
                "vmp-disabled-admin",
                "True",
                "True",
                "False",
                Some(Blocker::VirtualMachinePlatformDisabled),
                4,
            ),
            (
                "vmp-disabled-standard",
                "False",
                "True",
                "False",
                Some(Blocker::NotAdministrator),
                4,
            ),
            (
                "wsl-absent-admin",
                "True",
                "False",
                "True",
                Some(Blocker::WslAbsent),
                3,
            ),
            (
                "wsl-absent-standard",
                "False",
                "False",
                "True",
                Some(Blocker::NotAdministrator),
                3,
            ),
            ("healthy-admin", "True", "True", "True", None, 6),
            ("healthy-standard", "False", "True", "True", None, 6),
        ] {
            let mut outputs = PROBE_OUTPUTS;
            outputs[1] = elevated;
            outputs[2] = wsl;
            outputs[3] = vmp;
            let mut calls = Vec::new();
            let stages = std::cell::RefCell::new(Vec::new());
            let result = blocker_with(
                |program, args| {
                    let probe = calls.len();
                    assert_probe_call(probe, program, args);
                    calls.push(serde_json::json!({ "program": program, "args": args }));
                    stages.borrow_mut().push(probe);
                    child_probe_output("0", outputs[probe], "")
                },
                || {
                    assert!(expected.is_none(), "{scenario} reached kernel inspection");
                    stages.borrow_mut().push(6);
                    Ok(false)
                },
            )
            .unwrap();
            assert_eq!(result, expected, "{scenario}");
            assert_eq!(calls.len(), expected_probes, "{scenario}");
            if let Some(blocker @ Blocker::NotAdministrator) = result {
                assert_administrator_setup_instruction(blocker.instruction());
            }
            if expected.is_none() {
                assert_eq!(*stages.borrow(), [0, 1, 2, 3, 4, 6, 5]);
            }
            println!(
                "windows blocker command payload: {}",
                serde_json::json!({
                    "scenario": scenario,
                    "blocker": result,
                    "instruction": result.map(Blocker::instruction),
                    "calls": calls,
                })
            );
        }
    }

    #[test]
    fn a_real_command_launch_failure_keeps_the_os_diagnostic() {
        let missing = temp_root("missing-windows-probe").join("not-installed");
        let output = crate::quiet::command(&missing).output();
        assert_eq!(
            output.as_ref().unwrap_err().kind(),
            std::io::ErrorKind::NotFound
        );
        let error = fail_probe_at(0, output).unwrap_err();
        assert!(error.said.contains("Windows virtualization support"));
        assert!(error.detail.unwrap().contains("Could not start probe"));
    }

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
            Blocker::VirtualMachinePlatformDisabled,
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
            Blocker::VirtualMachinePlatformDisabled,
            Blocker::WslOne,
            Blocker::VirtualizationDisabled,
            Blocker::NotAdministrator,
        ] {
            let text = blocker.instruction();
            assert!(text.len() > 40, "{blocker:?} has no instruction");
            assert!(!text.to_lowercase().contains("setup failed"));
        }
    }

    fn assert_administrator_setup_instruction(instruction: &str) {
        for command in [
            "wsl --install",
            "dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart",
            "dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart",
        ] {
            assert!(instruction.contains(command), "missing admin setup command: {instruction}");
        }
        assert!(instruction.contains("Ask an administrator"));
        assert!(instruction.contains("Windows Terminal or PowerShell as an administrator and run"));
        assert!(instruction.to_ascii_lowercase().contains("restart"));
        assert!(instruction.contains("your own account"));
        assert!(!instruction.contains("run OpenBot once"));
        assert!(!instruction.contains("account does not have"));
    }

    #[test]
    fn the_two_we_cannot_fix_say_who_has_to() {
        assert!(!Blocker::VirtualizationDisabled.ours_to_fix());
        assert!(Blocker::VirtualizationDisabled
            .instruction()
            .contains("firmware"));
        assert!(!Blocker::NotAdministrator.ours_to_fix());
        assert_administrator_setup_instruction(Blocker::NotAdministrator.instruction());
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
        let dir = temp_root("winstate");
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
        let dir = temp_root("winstate-bad");
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
