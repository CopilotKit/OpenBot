//! The web app's own problems, as OpenBot's page in this app's window records them: requests that
//! failed or got no answer, errors the page threw, promises nobody handled, and runs that failed.
//!
//! Connected to an OpenBot that runs somewhere else, the window shows that OpenBot's web app through
//! this app's relay (`connected::relay`), and what went wrong in the page was written nowhere this
//! app could read. A person whose reply broke sent a log that held only the relay's lines. Now the
//! page hands each problem to this app as it happens (the page plugin's `record_problem`), and Get
//! Troubleshooting Logs… lists them, each failed request with the request id the server answered
//! with, so it can be found in that server's logs.
//!
//! BOUNDED. The last `KEPT` are kept in memory, and each is written to the log as it arrives, at most
//! `LOGGED_PER_MINUTE` a minute, so a page failing in a loop can neither grow this app's memory nor
//! flood its log.
//!
//! NOTHING THE PERSON WROTE. The page sends only what `Reported` names: a request's method, path,
//! status and request id, and an error's name, message and where it was thrown. Every field is
//! checked and cut to length here, whatever the page sent: a path loses its query and fragment, and
//! every text is redacted as the log is (`logging`). A path, a request id and the page's version are
//! ids, never credentials, so they keep their ids (`logging::redact_keeping_ids`) and lose any key,
//! token or email address.

use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Deserialize;

/// How many of the latest problems are kept for Get Troubleshooting Logs….
pub const KEPT: usize = 100;

/// How many are written to the log in a minute. The rest are kept in memory and counted.
pub const LOGGED_PER_MINUTE: u32 = 30;

/// The most of an error's message that is kept.
pub const MESSAGE_CHARS: usize = 500;

/// The most of where an error was thrown that is kept.
pub const SOURCE_CHARS: usize = 300;

/// The most of a request's path that is kept.
pub const PATH_CHARS: usize = 512;

/// What the page sends, as `record_problem` receives it. Anything else it sends is ignored.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Reported {
    pub kind: String,
    pub method: Option<String>,
    pub path: Option<String>,
    pub outcome: Option<String>,
    pub status: Option<f64>,
    pub request_id: Option<String>,
    pub waited_ms: Option<f64>,
    pub message: Option<String>,
    pub source: Option<String>,
    pub app_version: Option<String>,
}

/// What kind of problem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Request,
    PageError,
    UnhandledRejection,
    Run,
}

/// How a request ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Answered with this status, 400 or above.
    Failed(u16),
    /// No answer at all: the network failed, or the OpenBot wasn't there.
    NoAnswer,
    /// No answer yet, after `Problem::waited`.
    Slow,
}

/// One problem, checked, cut to length and redacted, with when this app received it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    /// `2026-11-24T10:00:01.123Z`, this app's clock.
    pub at: String,
    pub kind: Kind,
    /// A request's method and path.
    pub request: Option<(String, String)>,
    pub outcome: Option<Outcome>,
    pub request_id: Option<String>,
    pub waited: Option<Duration>,
    /// An error's or a failed run's own words.
    pub message: Option<String>,
    /// Where an error was thrown: `file:line:column`.
    pub source: Option<String>,
}

static METHOD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Z]{3,7}$").expect("the method pattern compiles"));

static REQUEST_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$").expect("the request id pattern compiles")
});

/// A release as the page names its own: `1.2.0`, `v1.2.0-rc.4`.
static VERSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^v?\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.-]{1,40})?$")
        .expect("the version pattern compiles")
});

/// At most `max` characters of `text` with no control characters, trimmed; None when nothing is
/// left.
fn bounded(text: &str, max: usize) -> Option<String> {
    let cleaned: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return None;
    }
    let mut kept: String = cleaned.chars().take(max).collect();
    if cleaned.chars().count() > max {
        kept.push('…');
    }
    Some(kept)
}

/// A path as it is kept: from the root, without its query or fragment, cut to length, its ids kept
/// and any credential or email address in it replaced.
fn path_of(path: &str) -> Option<String> {
    let path = path.split(['?', '#']).next().unwrap_or_default();
    if !path.starts_with('/') || path.starts_with("//") {
        return None;
    }
    let path = bounded(path, PATH_CHARS)?;
    if path.contains(char::is_whitespace) {
        return None;
    }
    Some(crate::logging::redact_keeping_ids(&path).into_owned())
}

/// The page's own release, when it named one that reads as a release.
pub fn version_of(reported: &Reported) -> Option<String> {
    reported
        .app_version
        .as_deref()
        .map(str::trim)
        .filter(|version| VERSION.is_match(version))
        .map(str::to_owned)
}

/// `reported`, checked, cut to length and redacted, as received `at`. `home` is written as `~` in
/// an error's words. Refused, with why, when it isn't a problem the page records.
pub fn accept(reported: &Reported, at: String, home: Option<&str>) -> Result<Problem, String> {
    let kind = match reported.kind.as_str() {
        "request" => Kind::Request,
        "page-error" => Kind::PageError,
        "unhandled-rejection" => Kind::UnhandledRejection,
        "run" => Kind::Run,
        other => return Err(format!("not a kind of problem: {:?}", bounded(other, 40))),
    };
    let text = |value: &Option<String>, max: usize| {
        value
            .as_deref()
            .and_then(|value| bounded(value, max))
            .map(|value| crate::logging::scrub(&value, home).into_owned())
    };
    let request_id = reported
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|id| REQUEST_ID.is_match(id))
        .map(|id| crate::logging::redact_keeping_ids(id).into_owned());
    let waited = reported
        .waited_ms
        .filter(|ms| ms.is_finite() && *ms >= 0.0)
        .map(|ms| Duration::from_millis(ms.min(86_400_000.0) as u64));
    let mut problem = Problem {
        at,
        kind,
        request: None,
        outcome: None,
        request_id,
        waited: None,
        message: text(&reported.message, MESSAGE_CHARS),
        source: text(&reported.source, SOURCE_CHARS),
    };
    match kind {
        Kind::Request => {
            let method = reported
                .method
                .as_deref()
                .map(|method| method.trim().to_ascii_uppercase())
                .filter(|method| METHOD.is_match(method))
                .ok_or("a request without a method")?;
            let path = reported
                .path
                .as_deref()
                .and_then(path_of)
                .ok_or("a request without a path from the root")?;
            let outcome = match (reported.outcome.as_deref(), reported.status) {
                (Some("failed"), Some(status))
                    if status.fract() == 0.0 && (400.0..=599.0).contains(&status) =>
                {
                    Outcome::Failed(status as u16)
                }
                (Some("no-answer"), _) => Outcome::NoAnswer,
                (Some("slow"), _) => Outcome::Slow,
                _ => return Err("a request with no outcome it can have".into()),
            };
            problem.request = Some((method, path));
            problem.outcome = Some(outcome);
            // How long it waited says something only of a request that got no answer.
            problem.waited = if matches!(outcome, Outcome::Failed(_)) {
                None
            } else {
                waited
            };
            problem.message = None;
            problem.source = None;
        }
        Kind::PageError | Kind::UnhandledRejection | Kind::Run => {
            if problem.message.is_none() {
                problem.message = Some(match kind {
                    Kind::Run => "The run failed without saying why.".to_owned(),
                    _ => "It said nothing about itself.".to_owned(),
                });
            }
            if kind != Kind::PageError {
                problem.source = None;
            }
            if kind != Kind::Run {
                problem.request_id = None;
            }
        }
    }
    Ok(problem)
}

/// `1.2s`, `30s`, `2m 05s`.
fn took(waited: Duration) -> String {
    let seconds = waited.as_secs();
    if seconds >= 60 {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    } else if waited.subsec_millis() == 0 || seconds >= 10 {
        format!("{seconds}s")
    } else {
        format!("{:.1}s", waited.as_secs_f32())
    }
}

impl Problem {
    /// The problem in one line, without when: what the log and the troubleshooting file say.
    pub fn said(&self) -> String {
        let id = |request_id: &Option<String>| match request_id {
            Some(id) => format!("request id {id}"),
            None => "no request id".to_owned(),
        };
        match self.kind {
            Kind::Request => {
                let (method, path) = self.request.clone().unwrap_or_default();
                let answer = match self.outcome {
                    Some(Outcome::Failed(status)) => {
                        format!("answered {status}, {}", id(&self.request_id))
                    }
                    Some(Outcome::NoAnswer) => match self.waited {
                        Some(waited) => format!("no answer (gave up after {})", took(waited)),
                        None => "no answer".to_owned(),
                    },
                    Some(Outcome::Slow) => match self.waited {
                        Some(waited) => format!("no answer yet after {}", took(waited)),
                        None => "no answer yet".to_owned(),
                    },
                    None => "failed".to_owned(),
                };
                format!("request {method} {path}: {answer}")
            }
            Kind::PageError => {
                let message = self.message.clone().unwrap_or_default();
                match &self.source {
                    Some(source) => format!("page error: {message} (at {source})"),
                    None => format!("page error: {message}"),
                }
            }
            Kind::UnhandledRejection => format!(
                "unhandled rejection: {}",
                self.message.clone().unwrap_or_default()
            ),
            Kind::Run => {
                let message = self.message.clone().unwrap_or_default();
                match &self.request_id {
                    Some(id) => format!("run failed: {message} (request id {id})"),
                    None => format!("run failed: {message}"),
                }
            }
        }
    }

    /// `at`, then `said`.
    pub fn line(&self) -> String {
        format!("{} {}", self.at, self.said())
    }

    /// A few words for the summary's count.
    pub fn named(&self) -> &'static str {
        match self.kind {
            Kind::Request => "request",
            Kind::PageError => "page error",
            Kind::UnhandledRejection => "unhandled rejection",
            Kind::Run => "failed run",
        }
    }
}

#[derive(Default)]
struct Kept {
    problems: VecDeque<Problem>,
    /// The page's own release, as it last named it.
    front_end: Option<String>,
    /// When the current minute of logging began, and how many were logged and held back in it.
    minute: Option<Instant>,
    logged: u32,
    held_back: u32,
}

/// The problems this app has received since it started: the last `KEPT`.
#[derive(Default)]
pub struct Recorder {
    kept: Mutex<Kept>,
}

/// What `Recorder::record` did with a problem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recorded {
    /// The lines to write to the log: the problem's, unless this minute's share was used, and,
    /// first, how many were held back in the minute before.
    pub log: Vec<String>,
}

impl Recorder {
    /**
    Keep `reported`, received `now` and stamped `at`, and say what to write to the log. Refused,
    with why, when it isn't a problem the page records; nothing is kept then.
    */
    pub fn record_at(
        &self,
        reported: &Reported,
        at: String,
        now: Instant,
        home: Option<&str>,
    ) -> Result<Recorded, String> {
        let problem = accept(reported, at, home)?;
        let mut kept = self
            .kept
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(version) = version_of(reported) {
            kept.front_end = Some(version);
        }
        let mut log = Vec::new();
        let new_minute = kept
            .minute
            .is_none_or(|began| now.duration_since(began) >= Duration::from_secs(60));
        if new_minute {
            if kept.held_back > 0 {
                log.push(format!(
                    "[page] {} more problems in the minute before were kept for the troubleshooting \
                     logs and not written here",
                    kept.held_back
                ));
            }
            kept.minute = Some(now);
            kept.logged = 0;
            kept.held_back = 0;
        }
        if kept.logged < LOGGED_PER_MINUTE {
            kept.logged += 1;
            log.push(format!("[page] {}", problem.said()));
        } else {
            kept.held_back += 1;
        }
        if kept.problems.len() == KEPT {
            kept.problems.pop_front();
        }
        kept.problems.push_back(problem);
        Ok(Recorded { log })
    }

    /// `record_at` now, written to the log.
    pub fn record(&self, reported: &Reported, home: Option<&str>) -> Result<(), String> {
        let recorded =
            self.record_at(reported, crate::logging::timestamp(), Instant::now(), home)?;
        for line in recorded.log {
            log::warn!("{line}");
        }
        Ok(())
    }

    /// The problems kept, oldest first.
    pub fn recent(&self) -> Vec<Problem> {
        let kept = self
            .kept
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        kept.problems.iter().cloned().collect()
    }

    /// The page's own release, as it last named it.
    pub fn front_end(&self) -> Option<String> {
        let kept = self
            .kept
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        kept.front_end.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Built at run time, so no key-shaped literal sits in the source for a scanner to stop.
    fn fake(prefix: &str, body: &str, times: usize) -> String {
        format!("{prefix}{}", body.repeat(times))
    }

    fn request(method: &str, path: &str, outcome: &str, status: Option<f64>) -> Reported {
        Reported {
            kind: "request".into(),
            method: Some(method.into()),
            path: Some(path.into()),
            outcome: Some(outcome.into()),
            status,
            ..Default::default()
        }
    }

    const AT: &str = "2026-11-24T10:00:01.000Z";

    /// What the page sends, as each problem reads in the file: the request's method, path with its
    /// ids and status and request id, never its query; an error's words and where.
    #[test]
    fn each_problem_reads_as_one_line_with_what_finds_it_in_the_servers_logs() {
        let organization = fake("", "Kd8fJ2pQ", 4);
        let token = fake("", "Zq3Kp8x7", 4);
        let mut failed = request(
            "post",
            &format!("/api/v2/organizations/{organization}/conversations?token={token}&email=dana@acme-robotics.io#top"),
            "failed",
            Some(500.0),
        );
        failed.request_id = Some("req_5f0d6c0e-2f1a-4a53-9d51-6f3d6b1f6f10".into());
        failed.app_version = Some("v1.2.0-rc.4".into());
        let problem = accept(&failed, AT.into(), None).unwrap();
        assert_eq!(
            problem.line(),
            format!(
                "{AT} request POST /api/v2/organizations/{organization}/conversations: answered \
                 500, request id req_5f0d6c0e-2f1a-4a53-9d51-6f3d6b1f6f10"
            )
        );
        let mut lost = request(
            "GET",
            "/api/v2/organizations/default/bots",
            "no-answer",
            None,
        );
        lost.waited_ms = Some(1234.0);
        assert_eq!(
            accept(&lost, AT.into(), None).unwrap().said(),
            "request GET /api/v2/organizations/default/bots: no answer (gave up after 1.2s)"
        );
        let mut slow = request("GET", "/api/me", "slow", None);
        slow.waited_ms = Some(30_000.0);
        assert_eq!(
            accept(&slow, AT.into(), None).unwrap().said(),
            "request GET /api/me: no answer yet after 30s"
        );
        let thrown = Reported {
            kind: "page-error".into(),
            message: Some(format!(
                "TypeError: can't read {} for dana.rivera@acme-robotics.io",
                fake("sk-ant-api03-", "Ab9_", 12)
            )),
            source: Some("http://127.0.0.1:49200/assets/index-abc.js:12:345".into()),
            ..Default::default()
        };
        assert_eq!(
            accept(&thrown, AT.into(), None).unwrap().said(),
            "page error: TypeError: can't read [redacted] for [email] (at \
             http://127.0.0.1:49200/assets/index-abc.js:12:345)"
        );
        let rejected = Reported {
            kind: "unhandled-rejection".into(),
            message: Some("Error: Couldn't start a conversation.".into()),
            ..Default::default()
        };
        assert_eq!(
            accept(&rejected, AT.into(), None).unwrap().said(),
            "unhandled rejection: Error: Couldn't start a conversation."
        );
        let run = Reported {
            kind: "run".into(),
            message: Some(
                "OpenBot couldn't reach its backend, so your message wasn't sent.".into(),
            ),
            request_id: Some("req_1".into()),
            ..Default::default()
        };
        assert_eq!(
            accept(&run, AT.into(), None).unwrap().said(),
            "run failed: OpenBot couldn't reach its backend, so your message wasn't sent. \
             (request id req_1)"
        );
    }

    /// Whatever the page sends, only what a problem is made of is kept, and nothing out of shape.
    #[test]
    fn what_is_not_a_problem_is_refused_and_every_field_is_bounded() {
        for refused in [
            Reported {
                kind: "secret".into(),
                ..Default::default()
            },
            request(
                "GET",
                "https://elsewhere.example/api",
                "failed",
                Some(500.0),
            ),
            request("GET", "//elsewhere.example/api", "failed", Some(500.0)),
            request("G E T", "/api/me", "failed", Some(500.0)),
            request("GET", "/api/me", "failed", Some(200.0)),
            request("GET", "/api/me", "failed", Some(404.5)),
            request("GET", "/api/me", "failed", None),
            request("GET", "/api/me", "maybe", Some(500.0)),
            request("GET", "/api/ me", "failed", Some(500.0)),
        ] {
            assert!(accept(&refused, AT.into(), None).is_err(), "{refused:?}");
        }
        let mut long = request(
            "GET",
            &format!("/api/{}", "a".repeat(2000)),
            "failed",
            Some(404.0),
        );
        long.request_id = Some("not an id; DROP".into());
        let problem = accept(&long, AT.into(), None).unwrap();
        assert_eq!(problem.request.unwrap().1.chars().count(), PATH_CHARS + 1);
        assert_eq!(problem.request_id, None);
        let shouted = Reported {
            kind: "page-error".into(),
            message: Some(format!("Error: {}\u{0}\nnext line", "x".repeat(5000))),
            ..Default::default()
        };
        let message = accept(&shouted, AT.into(), None).unwrap().message.unwrap();
        assert_eq!(message.chars().count(), MESSAGE_CHARS + 1);
        assert!(!message.contains('\n') && !message.contains('\u{0}'));
        assert_eq!(
            version_of(&Reported {
                app_version: Some("1.2.0; rm -rf".into()),
                ..Default::default()
            }),
            None
        );
    }

    /// The last `KEPT` are kept, oldest first, and no more than `LOGGED_PER_MINUTE` are written to
    /// the log in a minute; the next minute says how many were held back.
    #[test]
    fn the_recorder_keeps_the_latest_and_never_floods_the_log() {
        let recorder = Recorder::default();
        let start = Instant::now();
        let mut logged = 0;
        for index in 0..(KEPT + 20) {
            let mut failed = request(
                "GET",
                &format!("/api/v2/bots/{index}"),
                "failed",
                Some(500.0),
            );
            failed.app_version = Some("1.2.0".into());
            logged += recorder
                .record_at(&failed, format!("t{index}"), start, None)
                .unwrap()
                .log
                .len();
        }
        assert_eq!(logged, LOGGED_PER_MINUTE as usize);
        let recent = recorder.recent();
        assert_eq!(recent.len(), KEPT);
        assert_eq!(recent[0].at, "t20");
        assert_eq!(recent[KEPT - 1].at, format!("t{}", KEPT + 19));
        assert_eq!(recorder.front_end().as_deref(), Some("1.2.0"));
        let next = recorder
            .record_at(
                &request("GET", "/api/me", "failed", Some(502.0)),
                "later".into(),
                start + Duration::from_secs(61),
                None,
            )
            .unwrap();
        assert_eq!(
            next.log,
            vec![
                format!(
                    "[page] {} more problems in the minute before were kept for the \
                     troubleshooting logs and not written here",
                    KEPT + 20 - LOGGED_PER_MINUTE as usize
                ),
                "[page] request GET /api/me: answered 502, no request id".to_owned(),
            ]
        );
        assert!(recorder
            .record_at(&request("GET", "/x", "nope", None), "x".into(), start, None)
            .is_err());
        assert_eq!(recorder.recent().len(), KEPT);
    }
}
