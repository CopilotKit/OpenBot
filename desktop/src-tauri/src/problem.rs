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
}

impl Problem {
    /// A refusal this deployment made itself, where there is nothing underneath to show.
    pub fn plain(said: impl Into<String>) -> Self {
        Self {
            said: said.into(),
            detail: None,
        }
    }

    /// A sentence for the person, with the real output kept beside it.
    pub fn with(said: impl Into<String>, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        Self {
            said: said.into(),
            detail: (!detail.trim().is_empty()).then_some(detail),
        }
    }
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
    if lower.contains("no space left") {
        return "This computer has run out of disk space, so OpenBot could not finish. Free some \
                space and try again."
            .into();
    }
    if lower.contains("cannot connect")
        || lower.contains("is the docker daemon running")
        || lower.contains("connection refused")
    {
        return "OpenBot cannot reach the container engine. Start Docker or Podman, wait for it to \
                finish starting, and try again."
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

    #[test]
    fn a_taken_port_says_so_in_words_somebody_can_act_on() {
        let said = said_about("Bind for 0.0.0.0:4202 failed: port is already allocated");
        assert!(said.contains("port OpenBot needs"), "{said}");
    }

    #[test]
    fn an_engine_that_is_not_running_says_to_start_it() {
        let said =
            said_about("Cannot connect to the Docker daemon at unix:///var/run/docker.sock.");
        assert!(said.contains("Start Docker or Podman"), "{said}");
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
