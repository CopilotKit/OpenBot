//! What a person is told when something fails, and what a developer is told at the same time.
//!
//! TWO PARTS, ALWAYS, and this exists because one part is never enough for both readers. The
//! person needs a sentence about their situation and what to do next; whoever is debugging needs
//! the actual output, verbatim, including the bits that are only meaningful to them. Collapse them
//! and one of the two is failed: a plain sentence alone throws away the evidence, and raw engine
//! output alone is what put "pull access denied for openbot-agent-langgraph-agui, repository does
//! not exist or may require 'docker login'" in front of somebody who was setting up an app.
//!
//! The window shows `said` as the failure and keeps `detail` behind a disclosure, so the default
//! reading is the human one and nothing is lost.

use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Connection {
    Model,
    Intelligence,
    /// Not a credential: Install has to run again before Start can, and the window goes back to it.
    Installation,
}

/// A failure, in both registers.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Problem {
    /// For the person. Their situation, and the next thing they can do about it.
    pub said: String,
    /// For whoever is debugging. Verbatim, and never shown as the headline.
    ///
    /// `None` where the plain sentence IS the whole truth — a refusal this deployment decided, with
    /// no underlying output behind it.
    pub detail: Option<String>,
    /// The credential operation that failed, never inferred from provider log text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<Connection>,
    /// The full, verified Compose volume name offered for an explicit fresh-install reset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database_reset: Option<String>,
    /// A verified fresh-install reset of everything a previous installation left behind.
    /// Boxed and flattened: the window reads `leftover_reset` and `leftover_containers`.
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub leftover: Option<Box<LeftoverReset>>,
    /// Only a Windows restart fixes this, so the window offers one instead of Try again.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub restart_windows: bool,
    /// Which failure this is, for the commands that connect to an OpenBot that runs elsewhere, so
    /// the window can choose what to offer next. See `connected::Kind`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    /// What is known of the room this computer has: boxed and flattened, so the window reads
    /// `shortfall` and `cause`, and a problem stays small.
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub room: Option<Box<Room>>,
}

/// Room on this computer, beside a failure.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct Room {
    /// What this computer is short of, for an update it did not start (`upgrade::Ran::Short`). The
    /// window says it with the figures, as it says the back end's own shortfall.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortfall: Option<crate::local_eval::Shortfall>,
    /// A plain line above the raw output, when that output shows the disk ran out (`disk_full`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<&'static str>,
}

/// Exactly what one confirmed reset removes: the containers first, then the volumes.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct LeftoverReset {
    /// Every verified volume, the database included.
    #[serde(rename = "leftover_reset", skip_serializing_if = "Vec::is_empty")]
    pub volumes: Vec<String>,
    /// Stopped containers that still hold those volumes.
    #[serde(rename = "leftover_containers", skip_serializing_if = "Vec::is_empty")]
    pub containers: Vec<String>,
}

impl Problem {
    /// A refusal this deployment made itself, where there is nothing underneath to show.
    pub fn plain(said: impl Into<String>) -> Self {
        Self {
            said: said.into(),
            detail: None,
            connection: None,
            database_reset: None,
            leftover: None,
            restart_windows: false,
            kind: None,
            room: None,
        }
    }

    /// A sentence for the person, with the real output kept beside it.
    pub fn with(said: impl Into<String>, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        Self {
            said: said.into(),
            detail: (!detail.trim().is_empty()).then_some(detail),
            connection: None,
            database_reset: None,
            leftover: None,
            restart_windows: false,
            kind: None,
            room: None,
        }
    }

    /// What this computer is short of, for an update it did not start.
    pub fn shortfall(&self) -> Option<&crate::local_eval::Shortfall> {
        self.room
            .as_deref()
            .and_then(|room| room.shortfall.as_ref())
    }

    /// The plain line for a disk that ran out, above the raw output.
    pub fn cause(&self) -> Option<&'static str> {
        self.room.as_deref().and_then(|room| room.cause)
    }

    /// The volumes a confirmed reset removes, or none when no reset is offered.
    pub fn leftover_volumes(&self) -> &[String] {
        self.leftover.as_deref().map_or(&[], |reset| &reset.volumes)
    }

    /// The stopped containers a confirmed reset removes before those volumes.
    pub fn leftover_containers(&self) -> &[String] {
        self.leftover
            .as_deref()
            .map_or(&[], |reset| &reset.containers)
    }

    pub fn connection(mut self, connection: Connection) -> Self {
        self.connection = Some(connection);
        self
    }

    /// With the plain line for a disk that ran out (`disk_full`) above its raw output, when its
    /// sentence or its output shows one, on `os` and the engine OpenBot runs on.
    pub fn explained(mut self, os: &str, podman: bool) -> Self {
        if self.cause().is_none() {
            let all = format!(
                "{}\n{}",
                self.said,
                self.detail.as_deref().unwrap_or_default()
            );
            if let Some(cause) = disk_full(&all, os, podman) {
                self.room.get_or_insert_with(Default::default).cause = Some(cause);
            }
        }
        self
    }
}

/**
Whether engine output says the disk ran out. Not only "no space left on device": once the drive under
a Docker or Podman machine's disk fills, the machine's own file system stops writing ("EXT4-fs error
... Detected aborted journal"), and every write and read of the engine's store after it fails as an
input/output error. A Mac updating to 1.1.0 with 7.5 GB free showed only those:
`write /var/lib/desktop-containerd/daemon/io.containerd.metadata.v1.bolt/meta.db: input/output error`,
and the same for an image's blob under `io.containerd.content.v1.content/blobs`.
*/
fn disk_ran_out(lower: &str) -> bool {
    let engine_store = [
        "containerd",
        "/var/lib/docker/",
        "/var/lib/containers/storage",
    ]
    .iter()
    .any(|store| lower.contains(store));
    lower.contains("no space left")
        || lower.contains("not enough space on the disk")
        || lower.contains("ext4-fs error")
        || lower.contains("aborted journal")
        || (engine_store && lower.contains("input/output error"))
}

/**
The plain line a failure gets above its raw output when that output shows the disk ran out
(`disk_ran_out`), or nothing. What to do on this computer: free space, then start the engine's
machine again, since its disk stops writing until it is restarted. Docker Desktop is quit and opened
again; OpenBot's own Podman machine restarts with the computer.
*/
pub fn disk_full(output: &str, os: &str, podman: bool) -> Option<&'static str> {
    if !disk_ran_out(&output.to_lowercase()) {
        return None;
    }
    Some(match (os, podman) {
        ("macos", false) => {
            "Your Mac's disk is full. Free up space, quit and reopen Docker Desktop, then try again."
        }
        ("macos", true) => "Your Mac's disk is full. Free up space, restart your Mac, then try again.",
        ("windows", false) => {
            "This computer's disk is full. Free up space, quit and reopen Docker Desktop, then try \
             again."
        }
        ("windows", true) => {
            "This computer's disk is full. Free up space, restart this computer, then try again."
        }
        _ => "This computer's disk is full. Free up space, then try again.",
    })
}

/*
 * Every error that is still a bare string becomes a plain problem.
 *
 * So `?` keeps working on the paths that have not been given a sentence yet, and those read exactly
 * as they did before rather than losing their message during the conversion. What it does NOT do is
 * let a raw engine dump masquerade as a sentence: `said_about` below is what turns one of those into
 * both halves, and the call sites that produce engine output use it.
 */
impl From<String> for Problem {
    fn from(said: String) -> Self {
        Self::plain(said)
    }
}

impl From<&str> for Problem {
    fn from(said: &str) -> Self {
        Self::plain(said)
    }
}

/**
A sentence for engine output, chosen by what the output actually says.

Pure and tested, because these are the failures a first run hits and the sentence is the only part
the person reads. Anything unrecognised keeps a general sentence rather than a guess: being vague is
fixable, and being confidently wrong about somebody's machine is not.
*/
pub fn said_about(output: &str) -> String {
    let lower = output.to_lowercase();

    // The one this was written for. A pull that is refused reads as a permissions problem, and is
    // almost always an image this release did not publish.
    if lower.contains("pull access denied")
        || lower.contains("repository does not exist")
        || lower.contains("manifest unknown")
        || lower.contains("not found: manifest")
    {
        return "OpenBot could not download one of the parts it needs. That version may not have \
                been published yet. Check for an OpenBot update, and try again."
            .into();
    }
    if lower.contains("port is already allocated") || lower.contains("address already in use") {
        return "Something else on this computer is using a port OpenBot needs. Close it, or \
                restart the computer, and try again."
            .into();
    }
    if disk_ran_out(&lower) {
        return "This computer has run out of disk space, so OpenBot could not finish. Free some \
                space and try again."
            .into();
    }
    // A registry that did not answer, while the engine did: the engine is what reports it, so the
    // "connection refused" in it is the registry's, not the engine's. Podman's Docker API answers a
    // pull that never started with only the root cause, so a refused registry reads, in full,
    // "Error response from daemon: connection refused". A response is the engine answering.
    if lower.contains("failed to resolve reference")
        || lower.contains("failed to do request")
        || lower.contains("error pulling")
        || lower.contains("pinging container registry")
        || (lower.contains("error response from daemon")
            && [
                "dial tcp",
                "connection refused",
                "no such host",
                "i/o timeout",
                "network is unreachable",
                "no route to host",
                "connection reset",
            ]
            .iter()
            .any(|cause| lower.contains(cause)))
    {
        return "OpenBot couldn't download the software it needs. Check your internet connection, \
                proxy or firewall, and try again."
            .into();
    }
    if lower.contains("cannot connect")
        || lower.contains("is the docker daemon running")
        || lower.contains("connection refused")
    {
        return "OpenBot can't reach the software it runs on. If you use Docker Desktop, open it and \
                wait for it to start. Then try again."
            .into();
    }
    if lower.contains("timeout") || lower.contains("timed out") {
        return "That took too long and stopped. It is usually a slow or interrupted connection, \
                so trying again often works."
            .into();
    }
    if lower.contains("unauthorized") || lower.contains("permission denied") {
        return "OpenBot was refused permission for something it needed. The details below say \
                what, and are worth sending to whoever set this up."
            .into();
    }

    "Something went wrong while setting OpenBot up. The details below are worth sending to \
     whoever set this up."
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The failure this whole file exists for.
    #[test]
    fn a_refused_pull_reads_as_a_missing_release_not_a_login_problem() {
        let raw =
            "Error response from daemon: pull access denied for openbot-agent-langgraph-agui, \
                   repository does not exist or may require 'docker login'";
        let said = said_about(raw);
        assert!(said.contains("could not download"), "{said}");
        // The person is never told to run `docker login`, which is not a thing they have.
        assert!(!said.to_lowercase().contains("docker login"), "{said}");
        assert!(!said.contains("openbot-agent"), "{said}");
    }

    /// Found upgrading a real Desktop with its registry stopped: the engine answered and the
    /// registry did not, and the window said to start Docker, which was running.
    #[test]
    fn a_registry_that_does_not_answer_is_a_download_that_failed_not_a_stopped_engine() {
        for raw in [
            r#"{"id":"Image 127.0.0.1:5050/openbot-server@sha256:d6dcee1f","status":"Error","text":"Error","details":"failed to resolve reference \"127.0.0.1:5050/openbot-server@sha256:d6dcee1f\": failed to do request: Head \"http://127.0.0.1:5050/v2/openbot-server/manifests/sha256:d6dcee1f\": dial tcp 127.0.0.1:5050: connect: connection refused"}"#,
            "Error response from daemon: Get \"https://ghcr.io/v2/\": dial tcp: lookup ghcr.io: no such host",
            // Podman, whose answer is only the root cause. See `pull_metrics` for the whole output.
            "Error response from daemon: connection refused",
        ] {
            let said = said_about(raw);
            assert!(said.contains("couldn't download"), "{said}");
            assert!(!said.contains("container engine"), "{said}");
        }
        // The engine itself not answering still says so.
        let said = said_about("dial unix /var/run/docker.sock: connect: connection refused");
        assert!(
            said.contains("can't reach the software it runs on"),
            "{said}"
        );
    }

    #[test]
    fn a_taken_port_says_so_in_words_somebody_can_act_on() {
        let said = said_about("Bind for 0.0.0.0:4202 failed: port is already allocated");
        assert!(said.contains("port OpenBot needs"), "{said}");
    }

    #[test]
    fn an_engine_that_is_not_running_says_to_start_it() {
        let said =
            said_about("Cannot connect to the Docker daemon at unix:///var/run/docker.sock.");
        assert!(
            said.contains("can't reach the software it runs on"),
            "{said}"
        );
    }

    /// The card a Mac showed updating to 1.1.0 with 7.5 GB free of 926 GB, word for word: Docker's
    /// disk had stopped writing, and nothing on it said the disk was full.
    const FULL_MAC_CARD: &str = "Image ghcr.io/copilotkit/openbot@sha256:479cccd42fc8942c98c7f326b065ca53cfd58f91d78fd1d5a2680b684e1a5f70: write /var/lib/desktop-containerd/daemon/io.containerd.metadata.v1.bolt/meta.db: input/output error
Error response from daemon: write /var/lib/desktop-containerd/daemon/io.containerd.metadata.v1.bolt/meta.db: input/output error
putting back: OpenBot could not put its database back.
Postgres did not start on its own: time=\"2026-11-17T13:46:50-08:00\" level=warning msg=\"The \\\"OPENAI_API_KEY\\\" variable is not set. Defaulting to a blank string.\"
unable to get image 'pgvector/pgvector:pg17': Error response from daemon: rpc error: code = Unknown desc = blob sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f expected at /var/lib/desktop-containerd/daemon/io.containerd.content.v1.content/blobs/sha256/cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f: open /var/lib/desktop-containerd/daemon/io.containerd.content.v1.content/blobs/sha256/cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f: input/output error";

    #[test]
    fn a_full_disk_is_said_as_one_even_when_the_engine_says_only_input_output_error() {
        // Each line of that card alone, as each step's own output reached `said_about`.
        for line in [
            "write /var/lib/desktop-containerd/daemon/io.containerd.metadata.v1.bolt/meta.db: input/output error",
            "unable to get image 'pgvector/pgvector:pg17': Error response from daemon: rpc error: code = Unknown desc = blob sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f expected at /var/lib/desktop-containerd/daemon/io.containerd.content.v1.content/blobs/sha256/cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f: open /var/lib/desktop-containerd/daemon/io.containerd.content.v1.content/blobs/sha256/cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f: input/output error",
            // Docker's own log on that Mac, first on the Mac, then inside its machine.
            "no space left on device",
            "EXT4-fs error (device vda1): ext4_journal_check_start:83: Detected aborted journal",
            FULL_MAC_CARD,
        ] {
            let said = said_about(line);
            assert!(said.contains("run out of disk space"), "{line}: {said}");
        }

        // The card itself: its sentence, and above the raw output, the line that says what to do.
        let card = Problem::with(
            "OpenBot couldn't update or put the version it had back. Choose Retry to try putting it \
             back again.",
            FULL_MAC_CARD,
        );
        assert_eq!(
            card.clone().explained("macos", false).cause(),
            Some("Your Mac's disk is full. Free up space, quit and reopen Docker Desktop, then try again.")
        );
        assert_eq!(
            card.clone().explained("windows", false).cause(),
            Some("This computer's disk is full. Free up space, quit and reopen Docker Desktop, then try again.")
        );
        assert_eq!(
            card.explained("windows", true).cause(),
            Some("This computer's disk is full. Free up space, restart this computer, then try again.")
        );
        for said in [
            disk_full(FULL_MAC_CARD, "macos", true).unwrap(),
            disk_full(FULL_MAC_CARD, "linux", false).unwrap(),
        ] {
            assert!(!said.contains('\u{2014}'), "{said}");
        }
        // An input/output error that is not the engine's store, and a timeout, are not a full disk.
        assert_eq!(
            disk_full("read /dev/sdb: input/output error", "macos", false),
            None
        );
        assert_eq!(disk_full("dial tcp: i/o timeout", "macos", false), None);
        assert_eq!(
            Problem::with("OpenBot couldn't start.", "exit 1")
                .explained("macos", false)
                .cause(),
            None
        );
    }

    /// Unrecognised output keeps a general sentence. Guessing at somebody's machine is worse than
    /// admitting the detail is where the answer is.
    #[test]
    fn something_unrecognised_stays_general_rather_than_guessing() {
        let said = said_about("frobnicator exploded (0x8007)");
        assert!(said.contains("Something went wrong"), "{said}");
    }

    /// Both halves, and the detail is never empty-but-present.
    #[test]
    fn a_problem_carries_both_registers() {
        let both = Problem::with("Plain thing.", "raw output");
        assert_eq!(both.said, "Plain thing.");
        assert_eq!(both.detail.as_deref(), Some("raw output"));

        let blank = Problem::with("Plain thing.", "   ");
        assert_eq!(blank.detail, None, "whitespace is not a detail");

        let refusal = Problem::plain("We will not do that.");
        assert_eq!(refusal.detail, None);
    }

    /// A bare string still converts, so paths without a sentence yet read as they always did.
    #[test]
    fn a_bare_string_becomes_a_plain_problem() {
        let problem: Problem = "bun was not found".to_string().into();
        assert_eq!(problem.said, "bun was not found");
        assert_eq!(problem.detail, None);
    }
}
