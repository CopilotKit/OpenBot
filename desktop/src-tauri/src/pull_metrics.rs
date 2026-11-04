//! Metrics for an explicit image pull, before containers or provider sign-in start.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc::{sync_channel, SyncSender};
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

#[derive(Default)]
struct DownloadBytes(HashMap<String, u64>);

impl DownloadBytes {
    fn observe(&mut self, progress: Progress) {
        if progress.text == "Downloading"
            && !progress.id.is_empty()
            && !progress.parent_id.as_deref().unwrap_or_default().is_empty()
        {
            if let Some(current) = progress.current {
                self.0
                    .entry(progress.id)
                    .and_modify(|maximum| *maximum = (*maximum).max(current))
                    .or_insert(current);
            }
        }
    }

    fn total(&self) -> Option<u64> {
        if self.0.is_empty() {
            return None;
        }
        self.0
            .values()
            .try_fold(0_u64, |sum, current| sum.checked_add(*current))
    }
}

/// Compose's JSON writer carries Docker's byte counters as integers:
/// https://github.com/docker/compose/blob/v2.39.2/pkg/compose/pull.go#L391-L440
/// The same layer can appear beneath multiple services. Keep its maximum download counter,
/// regardless of parent, and never add extraction progress or the advertised total size.
fn download_bytes(stdout: &[u8], stderr: &[u8]) -> Option<u64> {
    let mut layers = DownloadBytes::default();
    for output in [stdout, stderr] {
        for line in output.split(|byte| *byte == b'\n') {
            let Ok(progress) = serde_json::from_slice::<Progress>(line) else {
                continue;
            };
            layers.observe(progress);
        }
    }
    layers.total()
}

/// Pull a provider sign-in image without starting its CLI or creating a container.
/// A tiny stdin Compose project gives the same missing-only policy and JSON progress as setup.
/// Older Compose providers use an explicit native pull after a local presence check.
pub fn pull_image(
    engine: &Address,
    image: &str,
    on_progress: impl FnMut(u64),
    on_complete: impl FnOnce(PullMetrics),
) -> Result<(), Problem> {
    if crate::preparation::image_present(engine, image)? {
        return Ok(());
    }
    let Some(json_progress) = compose_pull_progress(engine) else {
        let mut command = engine.command();
        command.args(["pull", image]);
        return run_with_progress(command, None, false, on_progress, on_complete);
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
    run_with_progress(
        command,
        Some(project.as_bytes()),
        json_progress,
        on_progress,
        on_complete,
    )
}

/// How many images Install pulls at once.
pub const IMAGE_PULLS_AT_ONCE: usize = 4;

/// Pull `images` with at most `limit` pulls in flight, starting them in list order.
///
/// `pull(index, image, on_bytes)` is one blocking pull; it calls `on_bytes` with the bytes that
/// pull has downloaded so far. `keep_going` is asked before each pull starts; an `Err` (Stop)
/// starts no further pull. On the first failure no further pull starts, the pulls already running
/// finish, and that first error is returned.
///
/// `on_progress(done, total, bytes)`: `done` counts FINISHED pulls (not started ones), and
/// `bytes` is the sum of the bytes of every pull so far, running and finished. It never goes
/// down, and after the last pull succeeds it is called with `done == total`.
pub fn pull_images_limited<P, K, O>(
    images: &[String],
    limit: usize,
    pull: P,
    keep_going: K,
    on_progress: O,
) -> Result<(), Problem>
where
    P: Fn(usize, &str, &dyn Fn(u64)) -> Result<(), Problem> + Sync,
    K: Fn() -> Result<(), Problem> + Sync,
    O: Fn(usize, usize, u64) + Sync,
{
    struct Shared {
        next: usize,
        done: usize,
        bytes: Vec<u64>,
        error: Option<Problem>,
    }
    let total = images.len();
    let shared = std::sync::Mutex::new(Shared {
        next: 0,
        done: 0,
        bytes: vec![0; total],
        error: None,
    });
    // Reported under the lock, so the person sees `done` and `bytes` only ever go up.
    let report = |state: &Shared| on_progress(state.done, total, state.bytes.iter().sum());
    report(&shared.lock().unwrap());
    let worker = || loop {
        let index = {
            let mut state = shared.lock().unwrap();
            if state.error.is_some() || state.next >= total {
                return;
            }
            if let Err(problem) = keep_going() {
                state.error = Some(problem);
                return;
            }
            state.next += 1;
            state.next - 1
        };
        let on_bytes = |bytes: u64| {
            let mut state = shared.lock().unwrap();
            // One pull's own figure is cumulative; keep its highest so the sum never drops.
            if bytes > state.bytes[index] {
                state.bytes[index] = bytes;
                report(&state);
            }
        };
        let outcome = pull(index, &images[index], &on_bytes);
        let mut state = shared.lock().unwrap();
        match outcome {
            Ok(()) => {
                state.done += 1;
                report(&state);
            }
            Err(problem) => {
                state.error.get_or_insert(problem);
                return;
            }
        }
    };
    std::thread::scope(|scope| {
        for _ in 0..limit.max(1).min(total) {
            scope.spawn(worker);
        }
    });
    match shared.into_inner().unwrap().error {
        Some(problem) => Err(problem),
        None => Ok(()),
    }
}

/// Complete one explicit pull and report its outcome before the caller can start containers.
/// A failed pull is returned as the same two-part Problem used by the existing startup path.
pub(crate) fn run(
    command: Command,
    input: Option<&[u8]>,
    json_progress: bool,
    on_complete: impl FnOnce(PullMetrics),
) -> Result<(), Problem> {
    run_with_progress(command, input, json_progress, |_| {}, on_complete)
}

fn run_with_progress(
    mut command: Command,
    input: Option<&[u8]>,
    json_progress: bool,
    mut on_progress: impl FnMut(u64),
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
        // Drain both pipes concurrently, just as wait_with_output does, while forwarding only
        // structured byte counters. Raw engine output stays in the existing error diagnostics.
        let stdout = child.stdout.take().expect("piped pull stdout");
        let stderr = child.stderr.take().expect("piped pull stderr");
        std::thread::scope(|scope| {
            let (sender, receiver) = sync_channel(64);
            let stdout_sender = sender.clone();
            let out = scope.spawn(move || read_output(stdout, json_progress, stdout_sender));
            let err = scope.spawn(move || read_output(stderr, json_progress, sender));
            let mut layers = DownloadBytes::default();
            let mut last = None;
            for progress in receiver {
                layers.observe(progress);
                let total = layers.total();
                if total != last {
                    if let Some(bytes) = total {
                        on_progress(bytes);
                    }
                    last = total;
                }
            }
            let stdout = out
                .join()
                .map_err(|_| std::io::Error::other("pull stdout reader panicked"));
            let stderr = err
                .join()
                .map_err(|_| std::io::Error::other("pull stderr reader panicked"));
            // Always reap the child, including when reading a pipe failed.
            let status = child.wait()?;
            Ok(Output {
                status,
                stdout: stdout??,
                stderr: stderr??,
            })
        })
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

fn read_output(
    pipe: impl Read,
    json_progress: bool,
    sender: SyncSender<Progress>,
) -> std::io::Result<Vec<u8>> {
    let mut reader = BufReader::new(pipe);
    let mut output = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            return Ok(output);
        }
        output.extend_from_slice(&line);
        if json_progress {
            if let Ok(progress) = serde_json::from_slice(&line) {
                sender
                    .send(progress)
                    .map_err(|_| std::io::Error::other("pull progress receiver closed"))?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
    use std::sync::Mutex;
    use std::time::Duration;

    /// Wait, at most two seconds, until `count` reaches `want`. A bounded wait, so a sequential
    /// implementation fails the test instead of hanging it.
    fn wait_for(count: &AtomicUsize, want: usize) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while count.load(SeqCst) < want && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn names(count: usize) -> Vec<String> {
        (0..count).map(|index| format!("image-{index}")).collect()
    }

    #[test]
    fn pulls_several_images_at_once_but_never_more_than_the_limit() {
        let images = names(10);
        let running = AtomicUsize::new(0);
        let most = AtomicUsize::new(0);
        let arrived = AtomicUsize::new(0);
        pull_images_limited(
            &images,
            IMAGE_PULLS_AT_ONCE,
            |index, _, _| {
                let now = running.fetch_add(1, SeqCst) + 1;
                most.fetch_max(now, SeqCst);
                // The first four pulls wait to be running together.
                if index < IMAGE_PULLS_AT_ONCE {
                    arrived.fetch_add(1, SeqCst);
                    wait_for(&arrived, IMAGE_PULLS_AT_ONCE);
                }
                std::thread::sleep(Duration::from_millis(5));
                running.fetch_sub(1, SeqCst);
                Ok(())
            },
            || Ok(()),
            |_, _, _| {},
        )
        .unwrap();
        assert_eq!(most.load(SeqCst), IMAGE_PULLS_AT_ONCE);
    }

    #[test]
    fn first_failure_starts_no_new_pull_lets_running_ones_finish_and_is_returned() {
        let images = names(10);
        let started = Mutex::new(Vec::new());
        let finished = Mutex::new(Vec::new());
        let failed = std::sync::atomic::AtomicBool::new(false);
        let started_after_failure = AtomicUsize::new(0);
        let arrived = AtomicUsize::new(0);
        let error = pull_images_limited(
            &images,
            3,
            |index, _, _| {
                if failed.load(SeqCst) {
                    started_after_failure.fetch_add(1, SeqCst);
                }
                started.lock().unwrap().push(index);
                if index < 3 {
                    arrived.fetch_add(1, SeqCst);
                    wait_for(&arrived, 3);
                }
                if index == 0 {
                    failed.store(true, SeqCst);
                    return Err(Problem::plain("pull 0 failed"));
                }
                if index == 1 {
                    // Fails later than pull 0; its error is not the one returned.
                    std::thread::sleep(Duration::from_millis(40));
                    return Err(Problem::plain("pull 1 failed"));
                }
                std::thread::sleep(Duration::from_millis(40));
                finished.lock().unwrap().push(index);
                Ok(())
            },
            || Ok(()),
            |_, _, _| {},
        )
        .unwrap_err();
        assert_eq!(error, Problem::plain("pull 0 failed"));
        assert_eq!(started_after_failure.load(SeqCst), 0);
        let mut started = started.lock().unwrap().clone();
        started.sort();
        assert_eq!(started, vec![0, 1, 2]);
        assert_eq!(*finished.lock().unwrap(), vec![2]);
    }

    #[test]
    fn cancellation_starts_no_new_pull() {
        let images = names(10);
        let started = AtomicUsize::new(0);
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let error = pull_images_limited(
            &images,
            2,
            |_, _, _| {
                if started.fetch_add(1, SeqCst) + 1 == 3 {
                    cancelled.store(true, SeqCst);
                }
                Ok(())
            },
            || {
                if cancelled.load(SeqCst) {
                    Err(Problem::plain("cancelled"))
                } else {
                    Ok(())
                }
            },
            |_, _, _| {},
        )
        .unwrap_err();
        assert_eq!(error, Problem::plain("cancelled"));
        assert!(started.load(SeqCst) <= 4, "{}", started.load(SeqCst));
    }

    #[test]
    fn progress_counts_finished_pulls_and_sums_bytes_across_pulls() {
        let images = names(6);
        let calls = Mutex::new(Vec::new());
        pull_images_limited(
            &images,
            3,
            |index, _, on_bytes| {
                let base = (index as u64 + 1) * 100;
                on_bytes(base);
                std::thread::sleep(Duration::from_millis(2));
                on_bytes(base * 2);
                Ok(())
            },
            || Ok(()),
            |done, total, bytes| calls.lock().unwrap().push((done, total, bytes)),
        )
        .unwrap();
        let calls = calls.lock().unwrap();
        // Each image ends at 200 * (index + 1) bytes: 200 * (1 + ... + 6) in all.
        let expected: u64 = (1..=6).map(|n| n * 200).sum();
        assert_eq!(*calls.last().unwrap(), (6, 6, expected));
        assert!(calls.iter().all(|(_, total, _)| *total == 6));
        assert!(calls
            .windows(2)
            .all(|w| w[0].0 <= w[1].0 && w[0].2 <= w[1].2));
        // Done counts finishes: it goes up by one per pull, from 0 to 6.
        let mut seen: Vec<usize> = calls.iter().map(|(done, _, _)| *done).collect();
        seen.dedup();
        assert_eq!(seen, (0..=6).collect::<Vec<_>>());
        // Bytes from running pulls are summed, not only the last pull's own figure.
        assert!(calls
            .iter()
            .any(|(done, _, bytes)| *done < 6 && *bytes > 1200));
    }

    #[test]
    fn streams_download_bytes_before_the_child_exits() {
        let root = crate::test_support::temp_root("live-pull-progress");
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("progress.rs");
        let binary = root.join(format!("progress{}", std::env::consts::EXE_SUFFIX));
        let acknowledgement = root.join("progress-observed");
        std::fs::write(
            &source,
            r#"
use std::io::Write;
fn main() {
    let acknowledgement = std::env::args().nth(1).unwrap();
    println!("{{\"id\":\"a\",\"parent_id\":\"image\",\"text\":\"Downloading\",\"current\":7}}");
    std::io::stdout().flush().unwrap();
    eprintln!("{{\"id\":\"b\",\"parent_id\":\"image\",\"text\":\"Downloading\",\"current\":5}}");
    for _ in 0..300 {
        if std::path::Path::new(&acknowledgement).exists() { return; }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    eprintln!("progress was not delivered while the pull was running");
    std::process::exit(71);
}
"#,
        )
        .unwrap();
        crate::test_support::compile_fixture(&source, &binary);
        let mut command = crate::quiet::command(&binary);
        command.arg(&acknowledgement);
        let mut updates = Vec::new();
        let mut metrics = Vec::new();
        let result = run_with_progress(
            command,
            None,
            true,
            |bytes| {
                updates.push(bytes);
                if bytes == 12 {
                    std::fs::write(&acknowledgement, "received").unwrap();
                }
            },
            |metric| metrics.push(metric),
        );
        std::fs::remove_dir_all(root).unwrap();
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(updates.last(), Some(&12));
        assert_eq!(metrics.len(), 1);
        assert_eq!(metrics[0].bytes, Some(12));
        assert_eq!(metrics[0].outcome, Outcome::Success);
    }

    #[test]
    fn older_compose_explicitly_downloads_missing_images_and_reuses_cached_images() {
        if crate::test_support::isolated_process("pull_metrics::tests::older_compose_explicitly_downloads_missing_images_and_reuses_cached_images") { return; }
        let root = crate::test_support::temp_root("explicit-image-install");
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("docker.rs");
        std::fs::write(&source, r#"
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let executable = std::env::current_exe().unwrap();
    let root = executable.parent().unwrap();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["image", "inspect", image] => std::process::exit(if root.join(image).is_file() {0} else {1}),
        ["compose", "pull", "--help"] => println!("--include-deps"),
        ["pull", "synthetic-image"] => { std::fs::write(root.join("synthetic-image"), "installed").unwrap(); },
        ["pull", "missing-image"] => { eprintln!("synthetic download failure"); std::process::exit(71); },
        _ => panic!("no services or authentication may start while installing: {args:?}"),
    }
}
"#).unwrap();
        crate::test_support::compile_fixture(
            &source,
            &root.join(format!("docker{}", std::env::consts::EXE_SUFFIX)),
        );
        std::env::set_var("PATH", &root);
        let address = Address::new(crate::engine::Engine::Docker, None);
        let mut outcomes = Vec::new();
        pull_image(
            &address,
            "synthetic-image",
            |_| {},
            |metric| outcomes.push(metric.outcome),
        )
        .unwrap();
        pull_image(
            &address,
            "synthetic-image",
            |_| {},
            |_| panic!("cached image must not be downloaded again"),
        )
        .unwrap();
        assert!(pull_image(
            &address,
            "missing-image",
            |_| {},
            |metric| outcomes.push(metric.outcome)
        )
        .is_err());
        assert_eq!(outcomes, [Outcome::Success, Outcome::Failure]);
        std::fs::remove_dir_all(root).unwrap();
    }

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
