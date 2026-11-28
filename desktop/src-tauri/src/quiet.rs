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

use std::io::Read;
use std::process::{Child, Command, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

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

/**
`Command::output`, to the command's end or `limit`, whichever comes first.

A command still running at `limit` is stopped (see `stop`: on Windows with everything it started,
elsewhere through its own handle) and answers `ErrorKind::TimedOut`, so the caller can tell "it did
not say in time" apart from "it said no" or "it could not start". Both streams are kept, as
`output` keeps them, because a probe's diagnostic is often on the one its answer is not.

A command that exited while something it started kept its output open also answers
`ErrorKind::TimedOut`, because its answer is incomplete, but carries `StayedOpen`: `stayed_open`
tells a caller that needs to know that it did exit, and was not stopped at `limit`.

`local_images::run_within` is the same wait for engine commands, but it drops stderr and caps
stdout, which is right for `kubectl` output and wrong for a probe whose failure has to be shown.
*/
pub fn output_within(command: &mut Command, limit: Duration) -> std::io::Result<Output> {
    output_watching(command, limit, None)
}

/// `output_within`, also calling `slow.1` once if the command is still running after `slow.0`, so
/// the person waiting can be told why.
pub fn output_watching(
    command: &mut Command,
    limit: Duration,
    mut slow: Option<(Duration, &dyn Fn())>,
) -> std::io::Result<Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    // Read both pipes while waiting: a child that fills one pipe's buffer would otherwise wait on
    // us as we wait on it.
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let started = Instant::now();
    let until = started + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                stop(&mut child);
                return Err(error);
            }
        }
        if Instant::now() >= until {
            stop(&mut child);
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("still running after {limit:?}, so it was stopped"),
            ));
        }
        if let Some((after, said)) = slow {
            if started.elapsed() >= after {
                said();
                slow = None;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    // A grandchild can hold a pipe open after its parent exits. The answer is then incomplete,
    // which is no answer.
    let streams_closed = Duration::from_secs(5);
    let stdout = stdout.recv_timeout(streams_closed);
    let stderr = stderr.recv_timeout(streams_closed);
    match (stdout, stderr) {
        (Ok(stdout), Ok(stderr)) => Ok(Output {
            status,
            stdout,
            stderr,
        }),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            StayedOpen(status),
        )),
    }
}

/// `output_watching`'s error for a command that exited with its output still held open by
/// something it started. Its kind stays `TimedOut`, which every other caller relies on; only the
/// type says the command did exit.
#[derive(Debug)]
pub struct StayedOpen(pub std::process::ExitStatus);

impl std::fmt::Display for StayedOpen {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "exited with {} but its output stayed open", self.0)
    }
}

impl std::error::Error for StayedOpen {}

/// Whether `error` is `StayedOpen`: the command exited, and was not stopped at its limit.
pub fn stayed_open(error: &std::io::Error) -> bool {
    error
        .get_ref()
        .is_some_and(|inner| inner.is::<StayedOpen>())
}

/// Stop `child` and reap it. On Windows, also stop what it started: `podman machine ssh` runs
/// `ssh.exe`, which kept waiting for a password nobody could type after `podman` itself was killed.
/// `taskkill /T` reaches the processes `child` still parents, as `local_eval::stop_tree` does.
fn stop(child: &mut Child) {
    #[cfg(windows)]
    let _ = command("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

/// Everything `pipe` says until it closes, read on a thread of its own.
fn drain(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<Vec<u8>> {
    let (sender, received) = mpsc::channel();
    match pipe {
        Some(mut pipe) => {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                let _ = pipe.read_to_end(&mut bytes);
                let _ = sender.send(bytes);
            });
        }
        None => {
            let _ = sender.send(Vec::new());
        }
    }
    received
}

/// What a command said, fit to put in front of somebody.
///
/// Two things make raw stderr the wrong thing to render. Terminal escapes: Podman underlines its
/// own notices, so the card showed a literal `[4m>>>>` before the message on every Linux failure.
/// And Podman's compose shim prefixes *every* invocation, successful or not, with a line naming
/// the external provider it is about to run, so the first thing a person read when the stack
/// failed was a sentence about `docker-compose` that had nothing to do with the failure.
///
/// Only that one known prefix is dropped, and only from the front. Everything else a command says
/// is kept: guessing which of somebody else's lines are unimportant is how real errors disappear.
pub fn said(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let mut clean = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            clean.push(c);
            continue;
        }
        // CSI: ESC [ ... final byte in @-~. Anything else after ESC is a short sequence whose
        // next character is the whole of it.
        match chars.peek() {
            Some('[') => {
                chars.next();
                for inner in chars.by_ref() {
                    if ('@'..='~').contains(&inner) {
                        break;
                    }
                }
            }
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }

    clean
        .lines()
        .skip_while(|line| {
            line.trim_start()
                .trim_start_matches('>')
                .trim_start()
                .starts_with("Executing external compose provider")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{command, output_within};
    use std::time::Duration;

    /// A probe that hangs is stopped at its limit, through its own handle, and says so as a
    /// timeout rather than as an answer, so a caller waiting on it waits no longer than it chose.
    #[test]
    fn a_command_still_running_at_its_limit_is_stopped_and_says_it_timed_out() {
        let cli = crate::test_support::probe_cli("output-within-hang");
        let marker = cli.with_file_name("outlived");
        // Unbounded, this would answer Ok after the fixture's two seconds.
        let error = output_within(
            command(&cli).arg("hang").arg(&marker),
            Duration::from_millis(200),
        )
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut, "{error}");
        // Past the moment it would have finished: killed, not abandoned to run on.
        std::thread::sleep(Duration::from_secs(3));
        assert!(!marker.exists(), "the probe ran on after its limit");
        let _ = std::fs::remove_dir_all(cli.parent().unwrap());
    }

    /// What the command started is stopped with it. `podman machine ssh` timed out with its
    /// `ssh.exe` still waiting on a password prompt, and every retry left one more behind.
    #[test]
    #[cfg(windows)]
    fn a_command_stopped_at_its_limit_takes_what_it_started_with_it() {
        let cli = crate::test_support::probe_cli("output-within-tree");
        let error = output_within(command(&cli).arg("parent"), Duration::from_secs(1)).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut, "{error}");
        // The child sleeps two seconds, then leaves `probe-child-outlived` beside it.
        std::thread::sleep(Duration::from_secs(3));
        assert!(
            !cli.with_file_name("probe-child-outlived").exists(),
            "the command's child ran on after its limit"
        );
        let _ = std::fs::remove_dir_all(cli.parent().unwrap());
    }

    /// One that finishes in time answers exactly as `output` does: status and both streams.
    #[test]
    fn a_command_that_finishes_in_time_answers_as_output_does() {
        let cli = crate::test_support::probe_cli("output-within-say");
        let output = output_within(command(&cli).arg("say"), Duration::from_secs(30)).unwrap();
        assert_eq!(output.status.code(), Some(3));
        assert_eq!(output.stdout, b"said on stdout");
        assert_eq!(output.stderr, b"said on stderr");
        let _ = std::fs::remove_dir_all(cli.parent().unwrap());
    }

    /// The failure this was written for: Podman underlines its provider notice, and the card
    /// rendered the escape bytes as text in front of the real message.
    #[test]
    fn strips_terminal_escapes_and_the_provider_notice() {
        let raw = b"\x1b[4m>>>> Executing external compose provider \"/usr/libexec/docker/cli-plugins/docker-compose\". Please refer to the documentation for details.\x1b[0m\nError: mkdir /var/run/docker.sock: permission denied\n";
        assert_eq!(
            super::said(raw),
            "Error: mkdir /var/run/docker.sock: permission denied"
        );
    }

    /// Everything that is not that one notice survives, including lines that merely mention
    /// compose. Dropping somebody else's output by guesswork loses real errors.
    #[test]
    fn keeps_every_other_line() {
        let raw = b"Error: compose failed\nCaused by: no such image\n";
        assert_eq!(
            super::said(raw),
            "Error: compose failed\nCaused by: no such image"
        );
    }

    /// A message with no escapes and no notice comes back exactly as it went in, trimmed.
    #[test]
    fn leaves_plain_text_alone() {
        assert_eq!(super::said(b"  plain failure  \n"), "plain failure");
    }

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
