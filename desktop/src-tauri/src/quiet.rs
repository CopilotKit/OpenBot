//! Running a command without putting a console window on somebody's screen.
//!
//! Every shell-out here is a black `conhost` window on Windows unless it is asked not to be.
//! `podman`, `wsl.exe`, `powershell` and `bun` are all console applications, and Windows gives a
//! console application a console: `CreateProcess` allocates one whenever the parent is a GUI
//! process, which the shell is. Redirecting the pipes does not stop it, because the window is
//! allocated before anything is written to.
//!
//! The visible half of this was Stop: `compose down` takes several seconds, so its window had time
//! to be seen, in the foreground, over OpenBot. The rest are quicker and flash instead, once per
//! poll, for the whole of a first run.
//!
//! Unix has no equivalent problem and no equivalent flag, so there the wrapper is the identity.

use std::process::Command;

/// `CREATE_NO_WINDOW`: run the console application without giving it a console.
///
/// Named here rather than pulled from `windows-sys` for one constant that has never moved.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A command that will not open a window, whatever platform this is.
///
/// Use this instead of `Command::new` everywhere the shell runs another program. The one exception
/// would be a program the person is meant to see, and there is not one.
pub fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    // `mut` only matters on Windows; everywhere else the flag block below is compiled away.
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::command;

    /// The wrapper has to still run things. A flag typed wrongly is a command that never starts,
    /// and every caller discards the error, so the shell would report an engine that is not there.
    #[test]
    fn runs_the_program_it_is_given() {
        let program = if cfg!(windows) { "cmd" } else { "echo" };
        let args: &[&str] = if cfg!(windows) {
            &["/C", "echo openbot"]
        } else {
            &["openbot"]
        };
        let out = command(program)
            .args(args)
            .output()
            .expect("the wrapped command should run");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("openbot"));
    }
}
