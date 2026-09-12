//! Metrics for an explicit image pull, before containers or provider sign-in start.

use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Instant;

use serde::Deserialize;

use crate::engine::Address;
use crate::problem::Problem;
use crate::telemetry::Outcome;

/// No image names, layer IDs, engine output, or credentials cross this boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PullMetrics {
    pub outcome: Outcome,
    /// Wall time of the pull command, excluding capability detection and container startup.
    pub duration_ms: u64,
    /// Download counters actually observed. None means the provider supplied no byte counters.
    /// This excludes extraction, cached image sizes, and unobserved bytes between progress updates.
    pub bytes: Option<u64>,
}

/// None preserves the existing implicit pull on providers without a missing-only pull policy.
/// Such a provider gets no pull metric: timing the later `up` would also measure startup.
/// Some(false) still measures explicit pulls, but the older progress format has unknown bytes.
/// Podman delegates to its selected external Compose provider through this same command path.
pub(crate) fn compose_pull_progress(engine: &Address) -> Option<bool> {
    let policy_help = engine
        .command()
        .args(["compose", "pull", "--help"])
        .output()
        .ok()?;
    if !policy_help.status.success()
        || !(option_advertises(&policy_help.stdout, "--policy", "missing")
            || option_advertises(&policy_help.stderr, "--policy", "missing"))
    {
        return None;
    }
    Some(
        engine
            .command()
            .args(["compose", "--help"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .is_some_and(|output| {
                supports_json_progress(&output.stdout) || supports_json_progress(&output.stderr)
            }),
    )
}

fn supports_json_progress(help: &[u8]) -> bool {
    option_advertises(help, "--progress", "json")
}

fn option_advertises(help: &[u8], flag: &str, value: &str) -> bool {
    let text = String::from_utf8_lossy(help);
    let Some((_, option)) = text.split_once(flag) else {
        return false;
    };
    option
        .split("--")
        .next()
        .unwrap_or_default()
        .split(|character: char| !character.is_ascii_alphabetic())
        .any(|word| word == value)
}

#[derive(Deserialize)]
struct Progress {
    id: String,
    parent_id: Option<String>,
    text: String,
    current: Option<u64>,
}

/// Compose's JSON writer carries Docker's byte counters as integers:
/// https://github.com/docker/compose/blob/v2.39.2/pkg/compose/pull.go#L391-L440
/// The same layer can appear beneath multiple services. Keep its maximum download counter,
/// regardless of parent, and never add extraction progress or the advertised total size.
fn download_bytes(stdout: &[u8], stderr: &[u8]) -> Option<u64> {
    let mut layers: HashMap<String, u64> = HashMap::new();
    for output in [stdout, stderr] {
        for line in output.split(|byte| *byte == b'\n') {
            let Ok(progress) = serde_json::from_slice::<Progress>(line) else {
                continue;
            };
            if progress.text != "Downloading"
                || progress.id.is_empty()
                || progress.parent_id.as_deref().unwrap_or_default().is_empty()
            {
                continue;
            }
            if let Some(current) = progress.current {
                layers
                    .entry(progress.id)
                    .and_modify(|maximum| *maximum = (*maximum).max(current))
                    .or_insert(current);
            }
        }
    }
    if layers.is_empty() {
        None
    } else {
        layers
            .values()
            .try_fold(0_u64, |sum, current| sum.checked_add(*current))
    }
}

/// Pull a provider sign-in image without starting its CLI or creating a container.
/// A tiny stdin Compose project gives the same missing-only policy and JSON progress as setup.
/// Providers without `pull --policy missing` retain their implicit pull and emit no metric.
pub fn pull_image(
    engine: &Address,
    image: &str,
    on_complete: impl FnOnce(PullMetrics),
) -> Result<(), Problem> {
    let Some(json_progress) = compose_pull_progress(engine) else {
        return Ok(());
    };
    let mut command = engine.command();
    command.arg("compose");
    if json_progress {
        command.args(["--progress", "json"]);
    }
    command.args([
        "--project-name",
        "openbot-image-pull",
        "-f",
        "-",
        "pull",
        "--policy",
        "missing",
    ]);
    let project = serde_json::json!({"services": {"image": {"image": image}}}).to_string();
    run(
        command,
        Some(project.as_bytes()),
        json_progress,
        on_complete,
    )
}

/// Complete one explicit pull and report its outcome before the caller can start containers.
/// A failed pull is returned as the same two-part Problem used by the existing startup path.
pub(crate) fn run(
    mut command: Command,
    input: Option<&[u8]>,
    json_progress: bool,
    on_complete: impl FnOnce(PullMetrics),
) -> Result<(), Problem> {
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let started = Instant::now();
    let output = (|| {
        let mut child = command.spawn()?;
        if let Some(input) = input {
            let result = child
                .stdin
                .take()
                .expect("piped pull stdin")
                .write_all(input);
            if let Err(error) = result {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
        child.wait_with_output()
    })();
    let duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let success = output.as_ref().is_ok_and(|output| output.status.success());
    let bytes = if json_progress {
        output
            .as_ref()
            .ok()
            .and_then(|output| download_bytes(&output.stdout, &output.stderr))
    } else {
        None
    };
    on_complete(PullMetrics {
        outcome: if success {
            Outcome::Success
        } else {
            Outcome::Failure
        },
        duration_ms,
        bytes,
    });
    let output = output.map_err(|error| {
        Problem::plain(format!("Could not pull the images OpenBot needs: {error}"))
    })?;
    if output.status.success() {
        return Ok(());
    }
    let raw = crate::quiet::said(if output.stderr.is_empty() {
        &output.stdout
    } else {
        &output.stderr
    });
    Err(Problem::with(crate::problem::said_about(&raw), raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_each_shared_layer_once_and_ignores_extraction() {
        let output = br#"
{"id":"layer-a","parent_id":"service-a","text":"Downloading","current":20,"total":100}
{"id":"layer-a","parent_id":"service-b","text":"Downloading","current":80,"total":100}
{"id":"layer-a","parent_id":"service-a","text":"Downloading","current":60,"total":100}
{"id":"layer-b","parent_id":"service-a","text":"Downloading","current":7,"total":7}
{"id":"layer-a","parent_id":"service-a","text":"Extracting","current":900,"total":900}
{"id":"layer-a","parent_id":"service-a","text":"Download complete"}
"#;
        assert_eq!(download_bytes(output, b""), Some(87));
    }

    #[test]
    fn missing_download_counters_are_unknown_even_after_a_successful_pull() {
        // Observed with Docker 29.5.2 / hello-world:latest: download completion has no
        // byte counters, while extraction reports current=1. That is not one downloaded byte.
        let output = br#"
{"id":"layer-a","parent_id":"image","text":"Download complete","details":"0B","percent":100}
{"id":"layer-a","parent_id":"image","text":"Extracting","current":1}
{"id":"image","text":"Pulled"}
"#;
        assert_eq!(download_bytes(output, b""), None);
        assert_eq!(
            download_bytes(b"", b"image Skipped - Image is already present locally"),
            None
        );
    }

    #[test]
    fn accepts_counters_on_either_pipe_without_counting_noise_or_totals() {
        let stdout =
            br#"{"id":"layer-a","parent_id":"image","text":"Downloading","current":5,"total":50}"#;
        let stderr = br#"
Executing external compose provider
{"id":"layer-a","parent_id":"image","text":"Downloading","current":8,"total":50}
{"id":"layer-b","parent_id":"image","text":"Downloading","total":999}
{"id":"layer-c","parent_id":"image","text":"Downloading","current":-1}
{"id":"image","text":"Downloading","current":10000}
"#;
        assert_eq!(download_bytes(stdout, stderr), Some(8));
    }

    #[test]
    fn json_capability_requires_the_progress_option_to_advertise_json() {
        assert!(supports_json_progress(
            b"--progress string  Set type of progress output (auto,\n                 tty, plain, json, quiet)\n--project-directory string"
        ));
        assert!(!supports_json_progress(
            b"--progress string (auto, tty, plain)\n--format string (json)"
        ));
        assert!(!supports_json_progress(b"--format string (json)"));
    }

    #[test]
    fn missing_policy_must_be_advertised_before_an_explicit_pull() {
        assert!(option_advertises(
            b"--policy string  Apply pull policy (\"missing\"|\"always\")\n--quiet",
            "--policy",
            "missing"
        ));
        // Compose v2.20 has no --policy; leave its existing implicit pull alone.
        assert!(!option_advertises(
            b"--include-deps  Also pull dependencies\n--quiet",
            "--policy",
            "missing"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn reports_failure_and_observed_bytes_once_before_returning_the_problem() {
        let mut command = crate::quiet::command("sh");
        command.args(["-c", "printf '%s\\n' '{\"id\":\"layer\",\"parent_id\":\"image\",\"text\":\"Downloading\",\"current\":12}' >&2; exit 1"]);
        let mut reports = Vec::new();
        let result = run(command, None, true, |metrics| reports.push(metrics));
        assert!(result.is_err());
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].outcome, crate::telemetry::Outcome::Failure);
        assert_eq!(reports[0].bytes, Some(12));
    }

    #[cfg(unix)]
    #[test]
    fn measures_the_child_operation_and_closes_its_stdin() {
        let mut command = crate::quiet::command("sh");
        command.args(["-c", "cat; sleep 0.02"]);
        let mut reports = Vec::new();
        let input = br#"{"id":"layer","parent_id":"image","text":"Downloading","current":9}"#;
        assert!(run(command, Some(input), true, |metrics| reports.push(metrics)).is_ok());
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].outcome, crate::telemetry::Outcome::Success);
        assert!(reports[0].duration_ms >= 10);
        assert_eq!(reports[0].bytes, Some(9));
    }

    #[cfg(unix)]
    #[test]
    fn non_json_provider_keeps_bytes_unknown() {
        let mut command = crate::quiet::command("sh");
        command.args(["-c", "cat"]);
        let mut reports = Vec::new();
        let input = br#"{"id":"layer","parent_id":"image","text":"Downloading","current":9}"#;
        assert!(run(command, Some(input), false, |metrics| reports.push(metrics)).is_ok());
        assert_eq!(reports[0].outcome, crate::telemetry::Outcome::Success);
        assert_eq!(reports[0].bytes, None);
    }

    #[test]
    fn reports_spawn_failure_once() {
        let command = crate::quiet::command("openbot-test-missing-pull-executable");
        let mut reports = Vec::new();
        assert!(run(command, None, true, |metrics| reports.push(metrics)).is_err());
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].outcome, crate::telemetry::Outcome::Failure);
        assert_eq!(reports[0].bytes, None);
    }
}
