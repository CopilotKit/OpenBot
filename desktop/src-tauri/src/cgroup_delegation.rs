//! Letting the person's own systemd hand every cgroup controller to rootless Podman, on Linux.
//!
//! The backend runs a k3s node in a rootless Podman container. k3s stops at start with
//! `failed to find cpuset cgroup (v2)` unless the person's user manager (`user@<uid>.service`) has
//! the `cpuset` and `io` controllers, and systemd delegates only `cpu memory pids` to it by default
//! (systemd 255, Ubuntu 24.04). A drop-in on `user@.service` that delegates all five, followed by
//! `systemctl daemon-reload`, gives them to the session that is already running: no logout. That was
//! measured on a stock Ubuntu 24.04 VM, where a user manager started before the drop-in went from
//! `cpu memory pids` to all five on the reload alone, and a k3d cluster then came up and served a
//! pod.
//!
//! Writing the drop-in needs root. A fresh install writes it in the same `pkexec` call that installs
//! Podman, so there is one password prompt. Somebody who already had Podman gets one prompt for the
//! drop-in alone, and only if their controllers are missing.
//!
//! macOS and Windows run their engine in a rootful machine, a VM, and need none of this.

/// The controllers k3s needs in a rootless node.
pub const NEEDED: [&str; 5] = ["cpu", "cpuset", "io", "memory", "pids"];

/// Where the drop-in goes. Its own file, so a distribution's or another tool's drop-in is untouched,
/// and `Delegate=` lists in several drop-ins are merged by systemd.
pub const DROP_IN: &str = "/etc/systemd/system/user@.service.d/openbot-delegate.conf";

/// What runs as root. A fixed string: nothing in it comes from the person, the environment or a
/// file, so nothing can be smuggled into the root shell.
pub const SETUP_SCRIPT: &str = "mkdir -p /etc/systemd/system/user@.service.d && \
printf '[Service]\\nDelegate=cpu cpuset io memory pids\\n' \
> /etc/systemd/system/user@.service.d/openbot-delegate.conf && \
systemctl daemon-reload";

/// The needed controllers missing from a `cgroup.controllers` file's contents.
pub fn missing(controllers: &str) -> Vec<&'static str> {
    let present: Vec<&str> = controllers.split_whitespace().collect();
    NEEDED
        .iter()
        .copied()
        .filter(|needed| !present.contains(needed))
        .collect()
}

/// The `cgroup.controllers` of this person's user manager.
pub fn controllers_file(uid: u32) -> std::path::PathBuf {
    std::path::PathBuf::from(format!(
        "/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service/cgroup.controllers"
    ))
}

/// The shell line for the one `pkexec` prompt of a fresh install: Podman, then the drop-in.
/// `install` is the package manager and its words, which `install::linux_package_manager` takes from
/// a fixed list.
pub fn install_then_setup(manager: &str, args: &[&str]) -> String {
    format!("{manager} {} podman && {SETUP_SCRIPT}", args.join(" "))
}

/// Whether this person's controllers are all delegated. `None` when the file can't be read: no
/// cgroup v2, or a layout this does not know. The backend's own check then says what is wrong, and
/// OpenBot does not ask for a password it can't show a reason for.
#[cfg(target_os = "linux")]
pub fn delegated() -> Option<bool> {
    let uid = unsafe { libc::getuid() };
    std::fs::read_to_string(controllers_file(uid))
        .ok()
        .map(|controllers| missing(&controllers).is_empty())
}

/// Write the drop-in when controllers are missing. One `pkexec` prompt, only when needed.
#[cfg(target_os = "linux")]
pub fn ensure() -> Result<(), crate::problem::Problem> {
    use crate::problem::Problem;
    if delegated() != Some(false) {
        return Ok(());
    }
    log::info!("[engine] cgroup controllers missing for rootless Podman; asking to delegate them");
    let output = crate::quiet::command("pkexec")
        .args(["/bin/sh", "-c", SETUP_SCRIPT])
        .output()
        .map_err(|error| {
            Problem::with(
                "OpenBot couldn't ask for permission to finish setting up.",
                format!("pkexec: {error}"),
            )
        })?;
    if output.status.success() {
        return Ok(());
    }
    // pkexec's own refusal: 126 is "not authorized", 127 is "dialog dismissed".
    if matches!(output.status.code(), Some(126) | Some(127)) {
        return Err(Problem::plain(
            "OpenBot needs your permission once to finish setting up. Press Start to try again.",
        ));
    }
    Err(Problem::with(
        "OpenBot couldn't finish setting up. Try again.",
        crate::quiet::said(&output.stderr),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ubuntus_default_is_missing_cpuset_and_io() {
        assert_eq!(missing("cpu memory pids\n"), vec!["cpuset", "io"]);
    }

    #[test]
    fn a_delegated_user_manager_is_missing_nothing() {
        assert!(missing("cpuset cpu io memory pids hugetlb\n").is_empty());
    }

    #[test]
    fn the_controllers_file_is_the_user_managers() {
        assert_eq!(
            controllers_file(1000).to_str().unwrap(),
            "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cgroup.controllers"
        );
    }

    /// The drop-in delegates exactly what k3s needs, to the file `DROP_IN` names, and reloads.
    #[test]
    fn the_script_writes_the_drop_in_and_reloads() {
        assert!(
            SETUP_SCRIPT.contains(&format!("> {DROP_IN}")),
            "{SETUP_SCRIPT}"
        );
        assert!(SETUP_SCRIPT.contains("Delegate=cpu cpuset io memory pids"));
        assert!(SETUP_SCRIPT.ends_with("systemctl daemon-reload"));
        for needed in NEEDED {
            assert!(SETUP_SCRIPT.contains(needed), "{needed}");
        }
    }

    /// It runs in `sh -c` as root: a quote or a variable in it would be a hole.
    #[test]
    fn the_script_takes_nothing_from_outside() {
        assert!(!SETUP_SCRIPT.contains('$'));
        assert!(!SETUP_SCRIPT.contains('`'));
    }

    #[test]
    fn a_fresh_install_installs_podman_before_the_drop_in() {
        let line = install_then_setup("apt-get", &["install", "-y"]);
        assert!(
            line.starts_with("apt-get install -y podman && mkdir -p"),
            "{line}"
        );
        assert!(line.ends_with("systemctl daemon-reload"), "{line}");
    }

    /// The script's printf, run by a real shell, writes the file systemd reads.
    #[cfg(unix)]
    #[test]
    fn the_drop_in_systemd_reads() {
        let dir = crate::test_support::temp_root("cgroup-delegation");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("openbot-delegate.conf");
        let printf = SETUP_SCRIPT
            .split(" && ")
            .nth(1)
            .unwrap()
            .replace(DROP_IN, target.to_str().unwrap());
        let status = std::process::Command::new("/bin/sh")
            .args(["-c", &printf])
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "[Service]\nDelegate=cpu cpuset io memory pids\n"
        );
    }
}
