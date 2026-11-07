//! Metrics for an explicit image pull, before containers or provider sign-in start.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

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
    total: Option<u64>,
}

/// One pull's download so far: the bytes counted, and the image's size once every layer still to
/// download has said how big it is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ImageBytes {
    pub bytes: u64,
    pub size: Option<u64>,
}

#[derive(Default)]
struct DownloadBytes {
    /// Each layer's highest download counter.
    current: HashMap<String, u64>,
    /// Each layer's advertised size, from its download lines.
    sizes: HashMap<String, u64>,
    /// Layers this pull downloads, and those that finished downloading.
    layers: HashSet<String>,
    finished: HashSet<String>,
}

impl DownloadBytes {
    fn observe(&mut self, progress: Progress) {
        if progress.id.is_empty() || progress.parent_id.as_deref().unwrap_or_default().is_empty() {
            return;
        }
        match progress.text.as_str() {
            // Already on this computer: nothing to download.
            "Already exists" => {
                self.layers.remove(&progress.id);
                return;
            }
            "Download complete" | "Verifying Checksum" | "Extracting" | "Pull complete" => {
                self.finished.insert(progress.id.clone());
            }
            "Downloading" => {
                if let Some(current) = progress.current {
                    self.current
                        .entry(progress.id.clone())
                        .and_modify(|maximum| *maximum = (*maximum).max(current))
                        .or_insert(current);
                }
                if let Some(total) = progress.total.filter(|total| *total > 0) {
                    self.sizes.insert(progress.id.clone(), total);
                }
            }
            _ => {}
        }
        self.layers.insert(progress.id);
    }

    fn total(&self) -> Option<u64> {
        if self.current.is_empty() {
            return None;
        }
        self.current
            .values()
            .try_fold(0_u64, |sum, current| sum.checked_add(*current))
    }

    /// The size is the sum of the layers' sizes, known only when every layer that is still
    /// downloading has advertised one. A layer that finished without ever saying is counted at
    /// what was seen of it, so a tiny layer does not leave the size unknown for good.
    fn size(&self) -> Option<u64> {
        if self.layers.is_empty() {
            return None;
        }
        self.layers.iter().try_fold(0_u64, |sum, layer| {
            let size = match self.sizes.get(layer) {
                Some(size) => *size,
                None if self.finished.contains(layer) => {
                    self.current.get(layer).copied().unwrap_or(0)
                }
                None => return None,
            };
            sum.checked_add(size)
        })
    }

    fn image_bytes(&self) -> ImageBytes {
        ImageBytes {
            bytes: self.total().unwrap_or(0),
            size: self.size(),
        }
    }
}

/// A short name a person can read for an image reference: its repository's last part, without
/// registry, tag, digest or the `openbot-` prefix. The server image is "OpenBot server".
pub fn display_name(image: &str) -> String {
    let without_digest = image.split('@').next().unwrap_or_default();
    let last = without_digest.rsplit('/').next().unwrap_or_default();
    let repository = last.split(':').next().unwrap_or_default();
    let name = repository.strip_prefix("openbot-").unwrap_or(repository);
    match name {
        "openbot" | "server" => "OpenBot server".to_string(),
        name => name.to_string(),
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
    on_progress: impl FnMut(ImageBytes),
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

/// How often Install's download report is refreshed while no pull says anything, so the speed
/// falls when a download stalls.
pub const PROGRESS_TICK: Duration = Duration::from_millis(500);

/// Install's download, as the window shows it under "Installing OpenBot".
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Downloads {
    /// Pulls FINISHED, of `total`.
    pub done: usize,
    pub total: usize,
    /// Bytes downloaded by every pull so far, running and finished.
    pub bytes: u64,
    /// Recent download speed, once there is enough of a window to say. Filled in by `Pacer`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_per_second: Option<u64>,
    /// The pulls running now, in list order.
    pub pulling: Vec<ImagePull>,
}

/// One running pull.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ImagePull {
    /// See `display_name`.
    pub name: String,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// Pull `images` with at most `limit` pulls in flight, starting them in list order.
///
/// `pull(index, image, on_bytes)` is one blocking pull; it calls `on_bytes` with what that pull
/// has downloaded so far. `keep_going` is asked before each pull starts; an `Err` (Stop) starts no
/// further pull. On the first failure no further pull starts, the pulls already running finish,
/// and that first error is returned.
///
/// `on_progress` gets every change, and a repeat every `PROGRESS_TICK` while nothing changes.
/// `done` counts FINISHED pulls (not started ones), and `bytes` is the sum over every pull so
/// far, running and finished. Neither goes down, nor does a running pull's own `bytes`, and after
/// the last pull succeeds it is called with `done == total`. Pace it with `Pacer`.
pub fn pull_images_limited<P, K, O>(
    images: &[String],
    limit: usize,
    pull: P,
    keep_going: K,
    on_progress: O,
) -> Result<(), Problem>
where
    P: Fn(usize, &str, &dyn Fn(ImageBytes)) -> Result<(), Problem> + Sync,
    K: Fn() -> Result<(), Problem> + Sync,
    O: Fn(&Downloads) + Sync,
{
    #[derive(Clone, Copy, PartialEq)]
    enum Pull {
        Queued,
        Running,
        Finished,
    }
    struct Shared {
        next: usize,
        done: usize,
        state: Vec<Pull>,
        bytes: Vec<ImageBytes>,
        error: Option<Problem>,
    }
    let total = images.len();
    let names: Vec<String> = images.iter().map(|image| display_name(image)).collect();
    let shared = std::sync::Mutex::new(Shared {
        next: 0,
        done: 0,
        state: vec![Pull::Queued; total],
        bytes: vec![ImageBytes::default(); total],
        error: None,
    });
    // Reported under the lock, so the person sees `done` and `bytes` only ever go up.
    let report = |state: &Shared| {
        on_progress(&Downloads {
            done: state.done,
            total,
            bytes: state.bytes.iter().map(|bytes| bytes.bytes).sum(),
            bytes_per_second: None,
            pulling: (0..total)
                .filter(|index| state.state[*index] == Pull::Running)
                .map(|index| ImagePull {
                    name: names[index].clone(),
                    bytes: state.bytes[index].bytes,
                    size: state.bytes[index].size,
                })
                .collect(),
        })
    };
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
            let index = state.next - 1;
            state.state[index] = Pull::Running;
            index
        };
        let on_bytes = |bytes: ImageBytes| {
            let mut state = shared.lock().unwrap();
            let seen = state.bytes[index];
            // One pull's own figure is cumulative; keep its highest so the sum never drops.
            let next = ImageBytes {
                bytes: seen.bytes.max(bytes.bytes),
                size: bytes.size.or(seen.size),
            };
            if next != seen {
                state.bytes[index] = next;
                report(&state);
            }
        };
        let outcome = pull(index, &images[index], &on_bytes);
        let mut state = shared.lock().unwrap();
        state.state[index] = Pull::Finished;
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
        let (stop, stopped) = std::sync::mpsc::channel::<()>();
        let (shared, report) = (&shared, &report);
        scope.spawn(move || {
            // Wakes every tick until every worker has returned and `stop` is dropped.
            while let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
                stopped.recv_timeout(PROGRESS_TICK)
            {
                let state = shared.lock().unwrap();
                if state.error.is_none() && state.done < total {
                    report(&state);
                }
            }
        });
        let workers: Vec<_> = (0..limit.max(1).min(total))
            .map(|_| scope.spawn(worker))
            .collect();
        for worker in workers {
            if let Err(panic) = worker.join() {
                std::panic::resume_unwind(panic);
            }
        }
        drop(stop);
    });
    match shared.into_inner().unwrap().error {
        Some(problem) => Err(problem),
        None => Ok(()),
    }
}

/// Download speed over the last few seconds.
pub struct Speed {
    window: Duration,
    samples: VecDeque<(Instant, u64)>,
}

impl Default for Speed {
    fn default() -> Self {
        Self {
            window: Duration::from_secs(5),
            samples: VecDeque::new(),
        }
    }
}

impl Speed {
    /// Record `bytes` downloaded in all at `now`, and say the bytes per second over the window.
    /// None until the window spans at least half a second.
    pub fn observe(&mut self, now: Instant, bytes: u64) -> Option<u64> {
        self.samples.push_back((now, bytes));
        while let Some((at, _)) = self.samples.front() {
            if now.saturating_duration_since(*at) > self.window {
                self.samples.pop_front();
            } else {
                break;
            }
        }
        let (since, from) = *self.samples.front()?;
        let span = now.saturating_duration_since(since);
        if span < Duration::from_millis(500) {
            return None;
        }
        Some((bytes.saturating_sub(from) as f64 / span.as_secs_f64()).round() as u64)
    }
}

/// Paces `Downloads` reports for the window: at most one per `interval`, except that a pull
/// finishing is always shown at once. Measures the speed from every report it is offered.
pub struct Pacer {
    interval: Duration,
    last: Option<(Instant, usize)>,
    speed: Speed,
}

impl Default for Pacer {
    fn default() -> Self {
        Self {
            interval: Duration::from_millis(250),
            last: None,
            speed: Speed::default(),
        }
    }
}

impl Pacer {
    pub fn offer(&mut self, now: Instant, downloads: &Downloads) -> Option<Downloads> {
        let bytes_per_second = self.speed.observe(now, downloads.bytes);
        let due = match self.last {
            None => true,
            Some((at, done)) => {
                done != downloads.done || now.saturating_duration_since(at) >= self.interval
            }
        };
        if !due {
            return None;
        }
        self.last = Some((now, downloads.done));
        Some(Downloads {
            bytes_per_second,
            ..downloads.clone()
        })
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
    mut on_progress: impl FnMut(ImageBytes),
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
            let mut last = ImageBytes::default();
            for progress in receiver {
                layers.observe(progress);
                let now = layers.image_bytes();
                if now != last {
                    on_progress(now);
                    last = now;
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
    Err(failed_pull(&crate::quiet::said(
        if output.stderr.is_empty() {
            &output.stdout
        } else {
            &output.stderr
        },
    )))
}

/// A failed pull in both registers, from the error it reported.
///
/// Compose's JSON progress is a line for every step of every layer, and none of it is the failure.
/// Left in, the detail opens on `"status":"Working","text":"Pulling"`, and the sentence is chosen
/// from all of it. So both come from the error lines alone. Output with no error line in it is kept
/// whole, so nothing is ever lost from the detail.
fn failed_pull(raw: &str) -> Problem {
    let errors: Vec<String> = raw.lines().filter_map(pull_error).collect();
    let detail = if errors.is_empty() {
        raw.to_string()
    } else {
        errors.join("\n")
    };
    Problem::with(crate::problem::said_about(&detail), detail)
}

/// One line of a pull's output as the detail shows it: Compose's progress left out, its error
/// events and its closing error as their text, and anything else as it was.
fn pull_error(line: &str) -> Option<String> {
    /// https://github.com/docker/compose/blob/v5.5.1/cmd/display/json.go. Compose 5 puts an
    /// event's status in `status` and the error in `details`; Compose 2 put the error in `status`.
    /// The closing error is `{"error":true,"message":...}`.
    #[derive(Deserialize)]
    struct Line {
        id: Option<String>,
        #[serde(default)]
        status: String,
        #[serde(default)]
        text: String,
        #[serde(default)]
        details: String,
        #[serde(default)]
        error: bool,
        message: Option<String>,
    }
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let Ok(parsed) = serde_json::from_str::<Line>(line) else {
        return Some(line.to_string());
    };
    match (parsed.id, parsed.message) {
        (_, Some(message)) if parsed.error => Some(message),
        (Some(id), _) if parsed.status == "Error" || parsed.text == "Error" => {
            let said = [parsed.details, parsed.status]
                .into_iter()
                .find(|said| !said.is_empty() && said != "Error")
                .unwrap_or(parsed.text);
            Some(format!("{id}: {said}"))
        }
        // A progress event.
        (Some(_), _) => None,
        _ => Some(line.to_string()),
    }
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
            |_| {},
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
            |_| {},
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
            |_| {},
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
                on_bytes(ImageBytes {
                    bytes: base,
                    size: None,
                });
                std::thread::sleep(Duration::from_millis(2));
                on_bytes(ImageBytes {
                    bytes: base * 2,
                    size: None,
                });
                Ok(())
            },
            || Ok(()),
            |downloads| {
                calls
                    .lock()
                    .unwrap()
                    .push((downloads.done, downloads.total, downloads.bytes))
            },
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
            |bytes: ImageBytes| {
                updates.push(bytes.bytes);
                if bytes.bytes == 12 {
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

    /// Failed pulls captured from real engines, each with the error line the detail shows. The
    /// registry did not answer and the engine did. Captured with Compose 5.5.1 (the version
    /// Install puts on Windows) from `compose --progress json -f - pull --policy missing`, as
    /// `pull_image` runs it, and from `podman pull` through the remote API, as Windows runs it.
    const REGISTRY_UNREACHABLE: [(&str, &str); 5] = [
        // Podman 5.8.9's API, a real OpenBot image, its registries resolving to a refused port.
        // Podman answers with only the root cause once nothing has been pulled. This is the
        // upgrade on Windows whose window said to start the engine.
        (
            include_str!("../test-fixtures/image-pull-failures/podman-compose-registry-refused.txt"),
            "Error response from daemon: connection refused",
        ),
        (
            include_str!(
                "../test-fixtures/image-pull-failures/podman-compose-registry-unresolved.txt"
            ),
            "Error response from daemon: lookup ghcr.invalid: no such host",
        ),
        (
            include_str!("../test-fixtures/image-pull-failures/podman-pull-registry-refused.txt"),
            "pinging container registry ghcr.io: Get \"https://ghcr.io/v2/\": dial tcp 127.0.0.1:443: connect: connection refused",
        ),
        // Docker 29.5.2 (Docker Desktop).
        (
            include_str!("../test-fixtures/image-pull-failures/docker-compose-registry-refused.txt"),
            "dial tcp 127.0.0.1:5999: connect: connection refused",
        ),
        (
            include_str!(
                "../test-fixtures/image-pull-failures/docker-compose-registry-unresolved.txt"
            ),
            "lookup ghcr.invalid: no such host",
        ),
    ];

    /// The engine answered and the registry did not, so the person is told the download failed and
    /// what to check, never to start an engine that is running. The detail is the error the pull
    /// reported, without the progress lines above it.
    #[test]
    fn a_registry_the_engine_cannot_reach_is_a_failed_download_with_the_pull_error_as_detail() {
        for (captured, error) in REGISTRY_UNREACHABLE {
            let problem = failed_pull(&crate::quiet::said(captured.as_bytes()));
            assert!(problem.said.contains("couldn't download"), "{problem:?}");
            assert!(problem.said.contains("proxy or firewall"), "{problem:?}");
            assert!(!problem.said.contains("container engine"), "{problem:?}");
            let detail = problem.detail.unwrap();
            assert!(detail.contains(error), "{detail}");
            assert!(!detail.contains(r#""status":"Working""#), "{detail}");
        }
        // The Windows upgrade's detail, whole: the image that failed, and Compose's error.
        let windows = failed_pull(&crate::quiet::said(REGISTRY_UNREACHABLE[0].0.as_bytes()));
        assert_eq!(
            windows.detail.as_deref(),
            Some(
                "Image ghcr.io/copilotkit/openbot-agent-claude-sdk@sha256:5ce6f82ab8c90810cb45c86c2f5e9cdf4e73bfee1aef13713c9076a0883fd54d: connection refused\n\
                 Error response from daemon: connection refused"
            )
        );
    }

    /// Compose not reaching the engine at all still says to start it.
    #[test]
    fn an_engine_that_does_not_answer_a_pull_still_says_to_start_it() {
        let captured =
            include_str!("../test-fixtures/image-pull-failures/compose-engine-not-running.txt");
        let problem = failed_pull(&crate::quiet::said(captured.as_bytes()));
        assert!(
            problem.said.contains("Start Docker or Podman"),
            "{problem:?}"
        );
        assert!(
            problem
                .detail
                .unwrap()
                .contains("Cannot connect to the Docker daemon"),
            "the engine's own words stay in the detail"
        );
    }

    /// The same captured output, through the whole failed-pull path: the pull's stderr read
    /// while it runs, and the Problem returned.
    #[cfg(unix)]
    #[test]
    fn a_pull_that_fails_on_the_registry_returns_a_failed_download() {
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/test-fixtures/image-pull-failures/podman-compose-registry-refused.txt"
        );
        let mut command = crate::quiet::command("sh");
        command.args(["-c", "cat \"$1\" >&2; exit 1", "sh", fixture]);
        let problem = run(command, None, true, |_| {}).unwrap_err();
        assert!(problem.said.contains("couldn't download"), "{problem:?}");
        let detail = problem.detail.unwrap();
        assert!(detail.contains("connection refused"), "{detail}");
        assert!(!detail.contains(r#""status":"Working""#), "{detail}");
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
    #[test]
    fn names_an_image_by_its_repository_without_registry_tag_or_digest() {
        assert_eq!(
            display_name("ghcr.io/copilotkit/openbot-agent-bot@sha256:0123"),
            "agent-bot"
        );
        assert_eq!(
            display_name("ghcr.io/copilotkit/openbot-server@sha256:0123"),
            "OpenBot server"
        );
        assert_eq!(display_name("openbot-server:latest"), "OpenBot server");
        assert_eq!(display_name("openbot"), "OpenBot server");
        assert_eq!(display_name("pgvector/pgvector:pg17"), "pgvector");
        assert_eq!(display_name("busybox:1.37"), "busybox");
        assert_eq!(
            display_name("ghcr.io/spiffe/spire-agent:1.15.1"),
            "spire-agent"
        );
        // A registry with a port is not a tag.
        assert_eq!(
            display_name("localhost:5000/openbot-supervisor"),
            "supervisor"
        );
        assert_eq!(display_name(""), "");
    }

    #[test]
    fn an_image_size_is_known_once_every_unfinished_layer_has_one() {
        let mut layers = DownloadBytes::default();
        let line = |text: &str| serde_json::from_str::<Progress>(text).unwrap();
        layers.observe(line(
            r#"{"id":"a","parent_id":"image","text":"Pulling fs layer"}"#,
        ));
        layers.observe(line(
            r#"{"id":"b","parent_id":"image","text":"Pulling fs layer"}"#,
        ));
        layers.observe(line(
            r#"{"id":"c","parent_id":"image","text":"Already exists"}"#,
        ));
        layers.observe(line(
            r#"{"id":"a","parent_id":"image","text":"Downloading","current":10,"total":100}"#,
        ));
        // Layer b has not said how big it is yet.
        assert_eq!(
            layers.image_bytes(),
            ImageBytes {
                bytes: 10,
                size: None
            }
        );
        layers.observe(line(
            r#"{"id":"b","parent_id":"image","text":"Downloading","current":5,"total":50}"#,
        ));
        assert_eq!(
            layers.image_bytes(),
            ImageBytes {
                bytes: 15,
                size: Some(150)
            }
        );
        // A tiny layer that finishes without ever reporting a size counts as done, not unknown.
        layers.observe(line(
            r#"{"id":"d","parent_id":"image","text":"Pulling fs layer"}"#,
        ));
        layers.observe(line(
            r#"{"id":"d","parent_id":"image","text":"Download complete"}"#,
        ));
        assert_eq!(layers.image_bytes().size, Some(150));
        // The image's own line is not a layer.
        layers.observe(line(r#"{"id":"image","text":"Pulling"}"#));
        assert_eq!(layers.image_bytes().size, Some(150));
    }

    #[test]
    fn streams_each_change_of_bytes_or_size_for_one_pull() {
        let mut command = crate::quiet::command("sh");
        command.args([
            "-c",
            r#"printf '%s\n' '{"id":"a","parent_id":"image","text":"Pulling fs layer"}' '{"id":"a","parent_id":"image","text":"Downloading","current":4,"total":40}' '{"id":"a","parent_id":"image","text":"Downloading","current":4,"total":40}' '{"id":"a","parent_id":"image","text":"Downloading","current":40,"total":40}'"#,
        ]);
        let mut updates = Vec::new();
        run_with_progress(command, None, true, |bytes| updates.push(bytes), |_| {}).unwrap();
        assert_eq!(
            updates,
            vec![
                ImageBytes {
                    bytes: 4,
                    size: Some(40)
                },
                ImageBytes {
                    bytes: 40,
                    size: Some(40)
                },
            ]
        );
    }

    #[test]
    fn progress_lists_the_running_pulls_with_their_own_bytes() {
        let images = vec![
            "ghcr.io/copilotkit/openbot-server@sha256:1".to_string(),
            "ghcr.io/copilotkit/openbot-agent-bot@sha256:2".to_string(),
            "busybox:1.37".to_string(),
        ];
        let arrived = AtomicUsize::new(0);
        let reported = AtomicUsize::new(0);
        let calls = Mutex::new(Vec::<Downloads>::new());
        pull_images_limited(
            &images,
            2,
            |index, _, on_bytes| {
                if index < 2 {
                    on_bytes(ImageBytes {
                        bytes: (index as u64 + 1) * 100,
                        size: (index == 0).then_some(1000),
                    });
                    arrived.fetch_add(1, SeqCst);
                    // Both running pulls have reported before either finishes.
                    wait_for(&arrived, 2);
                    reported.fetch_add(1, SeqCst);
                    wait_for(&reported, 2);
                }
                Ok(())
            },
            || Ok(()),
            |downloads| calls.lock().unwrap().push(downloads.clone()),
        )
        .unwrap();
        let calls = calls.lock().unwrap();
        let both = calls
            .iter()
            .find(|downloads| downloads.bytes == 300 && downloads.done == 0)
            .expect("a report while both pulls ran");
        assert_eq!(
            both.pulling,
            vec![
                ImagePull {
                    name: "OpenBot server".into(),
                    bytes: 100,
                    size: Some(1000)
                },
                ImagePull {
                    name: "agent-bot".into(),
                    bytes: 200,
                    size: None
                },
            ]
        );
        assert_eq!(both.total, 3);
        let last = calls.last().unwrap();
        assert_eq!((last.done, last.total, last.bytes), (3, 3, 300));
        assert!(last.pulling.is_empty());
        // A running pull's own figure never goes down.
        let server: Vec<u64> = calls
            .iter()
            .flat_map(|downloads| &downloads.pulling)
            .filter(|pull| pull.name == "OpenBot server")
            .map(|pull| pull.bytes)
            .collect();
        assert!(server.windows(2).all(|w| w[0] <= w[1]), "{server:?}");
    }

    #[test]
    fn keeps_reporting_while_a_pull_is_quiet() {
        let images = names(1);
        let calls = AtomicUsize::new(0);
        pull_images_limited(
            &images,
            1,
            |_, _, _| {
                std::thread::sleep(PROGRESS_TICK * 3);
                Ok(())
            },
            || Ok(()),
            |_| {
                calls.fetch_add(1, SeqCst);
            },
        )
        .unwrap();
        // Start, at least two ticks, and the finish: the speed can fall while nothing arrives.
        assert!(calls.load(SeqCst) >= 4, "{}", calls.load(SeqCst));
    }

    #[test]
    fn speed_is_averaged_over_the_recent_window_and_falls_to_zero_when_stalled() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut speed = Speed::default();
        assert_eq!(speed.observe(at(0), 0), None);
        // Too short a span to say anything yet.
        assert_eq!(speed.observe(at(200), 2_000_000), None);
        assert_eq!(speed.observe(at(1_000), 10_000_000), Some(10_000_000));
        assert_eq!(speed.observe(at(2_000), 30_000_000), Some(15_000_000));
        // Samples older than the window are dropped: 20 MB over the last 5 s.
        assert_eq!(speed.observe(at(6_000), 30_000_000), Some(4_000_000));
        assert_eq!(speed.observe(at(7_500), 30_000_000), Some(0));
    }

    fn downloads(done: usize, bytes: u64) -> Downloads {
        Downloads {
            done,
            total: 3,
            bytes,
            bytes_per_second: None,
            pulling: Vec::new(),
        }
    }

    #[test]
    fn pacer_sends_at_most_four_reports_a_second_but_never_drops_a_finish() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut pacer = Pacer::default();
        assert!(pacer.offer(at(0), &downloads(0, 0)).is_some());
        assert!(pacer.offer(at(100), &downloads(0, 10)).is_none());
        assert!(pacer.offer(at(200), &downloads(0, 20)).is_none());
        let paced = pacer.offer(at(260), &downloads(0, 30)).unwrap();
        assert_eq!(paced.bytes, 30);
        // A pull finishing is shown at once.
        assert_eq!(pacer.offer(at(300), &downloads(1, 40)).unwrap().done, 1);
        assert!(pacer.offer(at(400), &downloads(1, 50)).is_none());
        let speed = pacer.offer(at(1_300), &downloads(1, 1_300)).unwrap();
        assert_eq!(speed.bytes_per_second, Some(1_000));
        assert_eq!(
            pacer.offer(at(1_310), &downloads(3, 1_300)).unwrap().done,
            3
        );
    }

    #[test]
    fn downloads_serialize_for_the_window() {
        let value = serde_json::to_value(Downloads {
            done: 1,
            total: 9,
            bytes: 5,
            bytes_per_second: Some(2),
            pulling: vec![ImagePull {
                name: "agent-bot".into(),
                bytes: 5,
                size: None,
            }],
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "done": 1,
                "total": 9,
                "bytes": 5,
                "bytesPerSecond": 2,
                "pulling": [{"name": "agent-bot", "bytes": 5}],
            })
        );
    }
}
