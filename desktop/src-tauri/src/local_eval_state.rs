//! Where the local evaluation has got to, kept beside the installation.
//!
//! A checkpoint, not a credential: the stack id, who created the stack, the CLI digest it was
//! recorded with, the furthest phase reached, and whether OpenBot holds a key for the stack. Nothing here proves the stack is running or the
//! person is signed in; the CLI is asked for that every time. A missing, unreadable or unknown
//! record reads as no record, exactly like the installation's own checkpoints.
//!
//! Phases advance one at a time and never backwards, in the agreed order: installed, app opened,
//! signed in, provider validated. Activation is deliberately not a phase yet. It requires the CLI
//! to report readiness and licence, which version 1 cannot, so it cannot be recorded truthfully.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::local_eval::StackId;
use crate::problem::Problem;

pub const FILE: &str = ".openbot-local-eval.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Installed,
    AppOpened,
    SignedIn,
    ProviderValidated,
}

impl Phase {
    fn next(self) -> Option<Self> {
        match self {
            Phase::Installed => Some(Phase::AppOpened),
            Phase::AppOpened => Some(Phase::SignedIn),
            Phase::SignedIn => Some(Phase::ProviderValidated),
            Phase::ProviderValidated => None,
        }
    }
}

/// Whether the stack exists only for OpenBot.
///
/// A stack OpenBot created starts and stops with OpenBot. One it found already recorded may serve
/// other apps too, so OpenBot never stops it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Ownership {
    Created,
    Shared,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Record {
    version: u8,
    stack: String,
    ownership: Ownership,
    cli_sha256: String,
    phase: Phase,
    /// `local connect` ran and its key went into OpenBot's credential store. Absent until then, so
    /// a record that was never connected keeps the fields it always had.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    connected: bool,
}

/// What the window and the stop path may know.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub stack: String,
    pub ownership: Ownership,
    pub phase: Phase,
    pub connected: bool,
}

impl State {
    pub fn stack_id(&self) -> StackId {
        // `read` and `begin` only ever hold an id that parsed.
        StackId::parse(&self.stack).expect("a recorded stack id was validated")
    }

    /// Whether stopping OpenBot also stops this stack.
    pub fn tied_to_openbot(&self) -> bool {
        self.ownership == Ownership::Created
    }
}

fn digest_valid(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn load(root: &Path) -> Option<Record> {
    let record: Record = serde_json::from_slice(&std::fs::read(root.join(FILE)).ok()?).ok()?;
    (record.version == 1
        && StackId::parse(&record.stack).is_ok()
        && digest_valid(&record.cli_sha256))
    .then_some(record)
}

/**
The recorded state, or none.

`cli_sha256` is the digest of the CLI this build would run, when it has one. A record made with a
different CLI keeps its stack and ownership but goes back to `installed`: what the earlier CLI
reported says nothing about this one.
*/
pub fn read(root: &Path, cli_sha256: Option<&str>) -> Option<State> {
    let record = load(root)?;
    let phase = match cli_sha256 {
        Some(current) if current != record.cli_sha256 => Phase::Installed,
        _ => record.phase,
    };
    Some(State {
        stack: record.stack,
        ownership: record.ownership,
        phase,
        connected: record.connected,
    })
}

fn problem(detail: String) -> Problem {
    Problem::with(
        "OpenBot could not save its local evaluation progress. Check that the installation folder \
         is writable, then try again.",
        detail,
    )
}

fn write(root: &Path, record: &Record) -> Result<(), Problem> {
    crate::preparation::write_checkpoint(root, FILE, record).map_err(problem)
}

/// Record a stack at `installed`, replacing any earlier record. Setting the same stack up again
/// resumes it, so its connection is kept; any other stack starts unconnected.
pub fn begin(
    root: &Path,
    stack: &StackId,
    ownership: Ownership,
    cli_sha256: &str,
) -> Result<State, Problem> {
    if !digest_valid(cli_sha256) {
        return Err(Problem::plain("OpenBot refused an invalid CLI digest."));
    }
    let record = Record {
        version: 1,
        stack: stack.as_str().to_owned(),
        ownership,
        cli_sha256: cli_sha256.to_owned(),
        phase: Phase::Installed,
        connected: load(root)
            .is_some_and(|earlier| earlier.stack == stack.as_str() && earlier.connected),
    };
    write(root, &record)?;
    Ok(read(root, Some(cli_sha256)).expect("the record just written reads back"))
}

/// Move to `to`, which must be the current phase or the one after it.
pub fn advance(root: &Path, cli_sha256: &str, to: Phase) -> Result<State, Problem> {
    let current = read(root, Some(cli_sha256))
        .ok_or_else(|| Problem::plain("OpenBot has no local evaluation progress to continue."))?;
    if to != current.phase && current.phase.next() != Some(to) {
        return Err(Problem::plain(
            "OpenBot refused to skip or repeat a local evaluation step.",
        ));
    }
    let mut record = load(root).expect("read found the record");
    record.phase = to;
    record.cli_sha256 = cli_sha256.to_owned();
    write(root, &record)?;
    Ok(read(root, Some(cli_sha256)).expect("the record just written reads back"))
}

/// Record that OpenBot now holds the key `local connect` gave it for `stack`, the recorded one.
pub fn mark_connected(root: &Path, stack: &StackId) -> Result<State, Problem> {
    let mut record = load(root)
        .filter(|record| record.stack == stack.as_str())
        .ok_or_else(|| Problem::plain("OpenBot has no record of that local Intelligence stack."))?;
    record.connected = true;
    write(root, &record)?;
    Ok(read(root, None).expect("the record just written reads back"))
}

pub fn clear(root: &Path) -> Result<(), Problem> {
    match std::fs::remove_file(root.join(FILE)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(problem(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    const PIN: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const OTHER: &str = "0000000000000000000000000000000000000000000000000000000000000000";

    fn root(label: &str) -> std::path::PathBuf {
        let root = temp_root(label);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn stack() -> StackId {
        StackId::parse("local-abc123").unwrap()
    }

    #[test]
    fn missing_malformed_unknown_and_wrong_version_records_read_as_none() {
        let root = root("local-eval-state-unknown");
        assert_eq!(read(&root, None), None);
        for contents in [
            "not json".to_owned(),
            format!(r#"{{"version":2,"stack":"local-abc123","ownership":"created","cliSha256":"{PIN}","phase":"installed"}}"#),
            format!(r#"{{"version":1,"stack":"local-abc123","ownership":"created","cliSha256":"{PIN}","phase":"installed","token":"x"}}"#),
            format!(r#"{{"version":1,"stack":"--json","ownership":"created","cliSha256":"{PIN}","phase":"installed"}}"#),
            format!(r#"{{"version":1,"stack":"local-abc123","ownership":"created","cliSha256":"{PIN}","phase":"activated"}}"#),
            r#"{"version":1,"stack":"local-abc123","ownership":"created","cliSha256":"short","phase":"installed"}"#.to_owned(),
        ] {
            std::fs::write(root.join(FILE), contents.as_bytes()).unwrap();
            assert_eq!(read(&root, None), None, "{contents}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn phases_advance_one_at_a_time_and_survive_a_restart() {
        let root = root("local-eval-state-advance");
        let state = begin(&root, &stack(), Ownership::Created, PIN).unwrap();
        assert_eq!(state.phase, Phase::Installed);
        assert!(
            advance(&root, PIN, Phase::SignedIn).is_err(),
            "skipped a phase"
        );
        for phase in [Phase::AppOpened, Phase::SignedIn, Phase::ProviderValidated] {
            assert_eq!(advance(&root, PIN, phase).unwrap().phase, phase);
            // Repeating the current phase is harmless; reopening the app does it.
            assert_eq!(advance(&root, PIN, phase).unwrap().phase, phase);
        }
        assert!(
            advance(&root, PIN, Phase::AppOpened).is_err(),
            "went backwards"
        );
        // A restart is a fresh read of the same file.
        let state = read(&root, Some(PIN)).unwrap();
        assert_eq!(state.phase, Phase::ProviderValidated);
        assert_eq!(state.stack_id(), stack());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_different_cli_keeps_the_stack_but_restarts_the_phases() {
        let root = root("local-eval-state-pin");
        begin(&root, &stack(), Ownership::Created, PIN).unwrap();
        advance(&root, PIN, Phase::AppOpened).unwrap();
        let state = read(&root, Some(OTHER)).unwrap();
        assert_eq!(state.phase, Phase::Installed);
        assert_eq!(state.stack, "local-abc123");
        // Without a CLI to compare against, the record is reported as it was written.
        assert_eq!(read(&root, None).unwrap().phase, Phase::AppOpened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_a_stack_openbot_created_is_tied_to_it() {
        let root = root("local-eval-state-owner");
        assert!(begin(&root, &stack(), Ownership::Created, PIN)
            .unwrap()
            .tied_to_openbot());
        assert!(!begin(&root, &stack(), Ownership::Shared, PIN)
            .unwrap()
            .tied_to_openbot());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_connection_is_kept_for_its_own_stack_only() {
        let root = root("local-eval-state-connected");
        assert!(mark_connected(&root, &stack()).is_err(), "nothing recorded");
        assert!(
            !begin(&root, &stack(), Ownership::Created, PIN)
                .unwrap()
                .connected
        );
        let other = StackId::parse("local-other").unwrap();
        assert!(mark_connected(&root, &other).is_err(), "another stack");
        assert!(mark_connected(&root, &stack()).unwrap().connected);
        assert!(read(&root, None).unwrap().connected);
        // Setting the same stack up again resumes it, and its connection with it.
        assert!(
            begin(&root, &stack(), Ownership::Created, PIN)
                .unwrap()
                .connected
        );
        assert!(advance(&root, PIN, Phase::AppOpened).unwrap().connected);
        // A different stack starts unconnected.
        assert!(
            !begin(&root, &other, Ownership::Created, PIN)
                .unwrap()
                .connected
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_record_holds_only_its_own_fields() {
        let root = root("local-eval-state-fields");
        begin(&root, &stack(), Ownership::Shared, PIN).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join(FILE)).unwrap()).unwrap();
        let mut keys: Vec<_> = written.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            ["cliSha256", "ownership", "phase", "stack", "version"]
        );
        assert!(begin(
            &root,
            &stack(),
            Ownership::Shared,
            "synthetic-secret-marker"
        )
        .is_err());
        clear(&root).unwrap();
        clear(&root).unwrap();
        assert_eq!(read(&root, None), None);
        std::fs::remove_dir_all(root).unwrap();
    }
}
