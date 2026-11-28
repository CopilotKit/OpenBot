//! Get troubleshooting logs: everything a person, or the AI assistant they paste it into, needs to
//! find out why setup stopped, as one block of text.
//!
//! Before this, finding out why a fresh install said "The back end could not start" took asking for
//! two files by path, the version, and Docker's details, one message at a time. Now one action
//! gathers them: which build, on what, what failed, the container engine's version and size as the
//! back end's own engine check measures it (`local_eval::measured_engine_by`), the end of this app's
//! newest log file and of the back end CLI's log, and the end of the speech log
//! (`speech::diagnostics`), which says what dictation and narration did and never what was said.
//!
//! EVERY LINE IS REDACTED, because the point is that a person pastes this into a third-party AI.
//! This app's own log is scrubbed as it is written (`logging::scrub`), but the CLI's is not: it logs
//! `{"email":…,"organizationId":…}` on sign-in. So the whole bundle passes `redact` on its way out:
//! keys, tokens, passwords and emails as `logging::redact` replaces them, the home folder as `~`,
//! and the account identifiers below as `[id]`. Support has never needed them to read a failure,
//! and they say whose installation it is.
//!
//! NOTHING HERE WAITS LONGER THAN `LIMIT`. Logs are asked for when something is stuck, and the
//! container engine is often what is stuck: on OpenBot Desktop 1.1.2 a Mac's Docker Desktop stalled,
//! `docker compose logs` for the server's log had no time limit, and Get Troubleshooting Logs… sat on
//! "Gathering Logs…" until Docker was restarted, with no file and nothing said. Now everything that
//! asks the engine runs at once, each on a thread of its own, against one deadline; every command
//! still running then is stopped; and the file is written with what came back, and a section, What
//! couldn't be collected, that says what didn't and why.

use std::borrow::Cow;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use regex::Regex;

/// How much of the end of this app's newest log goes in: about the last few launches.
pub const DESKTOP_TAIL_BYTES: u64 = 192 * 1024;

/// How much of the end of the CLI's log goes in. It writes far less than the shell does.
pub const CLI_TAIL_BYTES: u64 = 64 * 1024;

/// How much of the end of the speech log goes in, across it and the one it set aside. A language
/// is noted only when its answer changes, so the line that says why dictation was refused can sit
/// well before the latest sessions.
pub const SPEECH_TAIL_BYTES: u64 = 128 * 1024;

/// The most of what failed that goes in: the window passes it, and only its start says anything.
pub const FAILURE_BYTES: usize = 16 * 1024;

/// The name of a saved bundle: `openbot-troubleshooting-<when>.txt`, in the log folder.
pub const SAVED_PREFIX: &str = "openbot-troubleshooting-";

/// Written in place of an account, organisation, user or installation identifier.
pub const ID: &str = "[id]";

/**
The longest gathering waits for anything that asks the container engine: which engine is answering,
its version, disk use and size, and the server container's log. They are asked at once, so this is
also about the longest the whole gathering takes. A healthy engine answers all of them in a few
seconds, the `docker run` that measures free disk included.
*/
pub const LIMIT: Duration = Duration::from_secs(20);

/// How long after the deadline a source's thread is still waited for, to hand over what it has
/// once its commands were stopped.
const HANDOVER: Duration = Duration::from_secs(2);

/// What a source that asks the engine can't give: it didn't answer before the deadline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoAnswer;

/// A source that can hang, asked on a thread of its own with the deadline it must keep: every
/// command it runs is stopped by then. `Ok(None)` is a source that has nothing to give, such as the
/// log of a server that isn't running.
pub type Ask<T> = Box<dyn FnOnce(Instant) -> Result<Option<T>, NoAnswer> + Send>;

/// A source already known, for a caller that has it in hand.
pub fn given<T: Send + 'static>(value: Option<T>) -> Ask<T> {
    Box::new(move |_| Ok(value))
}

/// What the bundle couldn't collect, each in "What couldn't be collected".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Missed {
    /// Which engine is answering, before setup chose one.
    Engine,
    EngineVersion,
    EngineDiskUse,
    /// CPUs, memory and free disk, as `[local check]` measures them.
    EngineSize,
    ServerLog,
    /// What the OpenBot the app is connected to says about itself (`connected::about`).
    ConnectedOpenBot,
}

impl Missed {
    /// The line in "What couldn't be collected", for a gathering that waited `limit`.
    fn said(self, limit: Duration) -> String {
        let seconds = limit.as_secs().max(1);
        let after = if seconds == 1 {
            "1 second".to_owned()
        } else {
            format!("{seconds} seconds")
        };
        match self {
            Missed::Engine => {
                format!("Which container engine is running: none answered within {after}.")
            }
            Missed::EngineVersion => {
                format!("The container engine's version: it didn't answer within {after}.")
            }
            Missed::EngineDiskUse => format!(
                "The container engine's disk use (system df): it didn't answer within {after}."
            ),
            Missed::EngineSize => format!(
                "The container engine's CPUs, memory and free disk: it didn't answer within {after}."
            ),
            Missed::ServerLog => format!(
                "The server's log, for model provider errors: the container engine didn't answer \
                 within {after}."
            ),
            Missed::ConnectedOpenBot => format!(
                "What the OpenBot this app is connected to says about itself: it didn't answer \
                 within {after}."
            ),
        }
    }

    /// The same, as a few words for the summary.
    fn named(self) -> &'static str {
        match self {
            Missed::Engine => "which container engine is running",
            Missed::EngineVersion => "the container engine's version",
            Missed::EngineDiskUse => "the container engine's disk use",
            Missed::EngineSize => "the container engine's CPUs, memory and free disk",
            Missed::ServerLog => "the server's log",
            Missed::ConnectedOpenBot => "what the connected OpenBot says about itself",
        }
    }
}

/// `work` started on a thread of its own, its answer waited for later with `by`.
struct Asked<T>(mpsc::Receiver<T>);

fn ask<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Asked<T> {
    let (sender, received) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(work());
    });
    Asked(received)
}

impl<T> Asked<T> {
    /// The answer, or None when there was none by `until`. A thread with no answer by then is
    /// left to end by itself: the commands it runs are stopped at the deadline it was given.
    fn by(self, until: Instant) -> Option<T> {
        self.0
            .recv_timeout(until.saturating_duration_since(Instant::now()))
            .ok()
    }
}

/// The container engine as the bundle reports it.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Engine {
    /// `docker` or `podman`.
    pub name: String,
    /// The engine's own version, from its `info`, when it said.
    pub version: Option<String>,
    /// `EngineCheck::said`: CPUs, memory, free disk and what is short, as `[local check]` logs it.
    pub measured: String,
    /// `system df`: what images, containers and volumes use of its disk, when it answered.
    pub disk_use: Option<String>,
}

/// What goes into one bundle, gathered by `gather` and laid out by `bundle`.
#[derive(Debug, Default)]
pub struct Facts {
    /// `OpenBot Desktop 1.0.0 (Built … from …)`, as the launch line says it.
    pub desktop: String,
    /// `macos aarch64`.
    pub system: String,
    /// What the person was told, and what lay beneath, when something failed.
    pub failure: Option<String>,
    /// The engine OpenBot runs on, or None when none is answering.
    pub engine: Option<Engine>,
    /// The newest log file of this app, and its end.
    pub desktop_log: Option<(PathBuf, String)>,
    /// The CLI's log file and its end, or None when there is none on this computer.
    pub cli_log: Option<(PathBuf, String)>,
    /// The end of the server container's log, or None when the server isn't running.
    pub server_log: Option<String>,
    /// The end of the speech log, oldest first: the end of the one set aside (`speech.log.1`) when
    /// the current one is shorter than the budget, then the current one. Empty when there is none.
    pub speech_log: Vec<(PathBuf, String)>,
    /// What didn't answer before the deadline, in the order asked.
    pub missed: Vec<Missed>,
    /// How long the gathering waited for it.
    pub limit: Duration,
}

/// Where `gather` finds what goes into a bundle.
pub struct Sources<'a> {
    pub desktop: String,
    pub failure: Option<String>,
    /// This app's log folder (`logging::folder`).
    pub log_folder: Option<&'a Path>,
    /// The home folder the CLI runs with, which also holds its log. Written as `~`.
    pub home: Option<&'a str>,
    /// The engine to measure: the one the back end runs on, or the one answering.
    pub engine: Ask<crate::engine::Address>,
    /// The end of the server container's log, or nothing when the server isn't running.
    pub server_log: Ask<String>,
    /// How long anything that asks the engine may take: `LIMIT`, or less in a test.
    pub limit: Duration,
}

/// How many of the server's latest `model-provider-refused` lines go in.
pub const SERVER_REFUSAL_LINES: usize = 50;

/// How much of the end of the server container's log is read for them.
pub const SERVER_LOG_LINES: u16 = 5000;

/// The server's `model-provider-refused` lines in `log`, the latest `SERVER_REFUSAL_LINES` of them.
pub fn provider_refusals(log: &str) -> String {
    let lines: Vec<&str> = log
        .lines()
        .filter(|line| line.contains(r#""type":"model-provider-refused""#))
        .map(str::trim_end)
        .collect();
    lines[lines.len().saturating_sub(SERVER_REFUSAL_LINES)..].join("\n")
}

/**
Gather a bundle and lay it out, redacted, within `sources.limit` (and a moment to hand over).

The engine and the server's log are asked at once, each on a thread of its own, while the files are
read here. What hasn't answered by the deadline is left out and named in `Facts::missed`.
*/
pub fn gather(sources: Sources) -> String {
    let limit = sources.limit;
    let deadline = Instant::now() + limit;
    let server_log = sources.server_log;
    let server = ask(move || server_log(deadline));
    let find_engine = sources.engine;
    let engine = ask(move || match find_engine(deadline) {
        Ok(Some(address)) => Ok(Some(measure_engine(&address, deadline))),
        Ok(None) => Ok(None),
        Err(NoAnswer) => Err(NoAnswer),
    });
    let read = |path: PathBuf, bytes: u64| tail(&path, bytes).ok().map(|tail| (path, tail));
    let desktop_log = sources
        .log_folder
        .and_then(newest_log)
        .and_then(|path| read(path, DESKTOP_TAIL_BYTES));
    let cli_log = sources
        .home
        .and_then(|home| read(cli_log(Path::new(home)), CLI_TAIL_BYTES));
    let speech_log = crate::speech::diagnostics::path()
        .map(|path| speech_log(&path, SPEECH_TAIL_BYTES))
        .unwrap_or_default();

    let mut missed = Vec::new();
    // The engine's thread waits for its own measurements until a handover after the deadline, so
    // it is given one more.
    let engine = match engine.by(deadline + HANDOVER * 2) {
        Some(Ok(Some((engine, unanswered)))) => {
            missed.extend(unanswered);
            Some(engine)
        }
        Some(Ok(None)) => None,
        Some(Err(NoAnswer)) | None => {
            missed.push(Missed::Engine);
            None
        }
    };
    let server_log = match server.by(deadline + HANDOVER) {
        Some(Ok(log)) => log,
        Some(Err(NoAnswer)) | None => {
            missed.push(Missed::ServerLog);
            None
        }
    };
    if !missed.is_empty() {
        log::warn!(
            "[logs] no answer within {}s from: {}",
            limit.as_secs(),
            missed
                .iter()
                .map(|missed| missed.named())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    let facts = Facts {
        desktop: sources.desktop,
        system: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        failure: sources.failure,
        engine,
        desktop_log,
        cli_log,
        server_log,
        speech_log,
        missed,
        limit,
    };
    bundle(&facts, sources.home)
}

/// The last `max_bytes` of the speech log at `current`, oldest first: when the current file is
/// shorter than that, the end of the one it set aside (`speech.log.1`) comes before it.
pub fn speech_log(current: &Path, max_bytes: u64) -> Vec<(PathBuf, String)> {
    let mut found = Vec::new();
    // What the current file leaves of the budget when it is read whole; nothing when it was cut.
    let mut left = max_bytes;
    if let Ok(length) = std::fs::metadata(current).map(|meta| meta.len()) {
        left = max_bytes.saturating_sub(length);
        if let Ok(text) = tail(current, max_bytes) {
            found.push((current.to_path_buf(), text));
        }
    }
    let set_aside = crate::speech::diagnostics::set_aside(current);
    if left > 0 {
        if let Ok(text) = tail(&set_aside, left) {
            found.insert(0, (set_aside, text));
        }
    }
    found
}

/// What the engine's measurement says when it didn't finish by the deadline.
pub const NOT_MEASURED: &str = "Couldn't measure it in time";

/**
The engine's version, size and disk use, asked at once, each on a thread of its own and stopped at
`deadline`, and what didn't answer by then.
*/
pub fn measure_engine(
    address: &crate::engine::Address,
    deadline: Instant,
) -> (Engine, Vec<Missed>) {
    let format = match address.engine {
        crate::engine::Engine::Podman => "{{.Version.Version}}",
        crate::engine::Engine::Docker => "{{.ServerVersion}}",
    };
    let asking = |args: Vec<&'static str>| {
        let address = address.clone();
        ask(move || engine_query(&address, &args, deadline))
    };
    let version = asking(vec!["info", "--format", format]);
    let disk_use = asking(vec!["system", "df"]);
    let measured = {
        let address = address.clone();
        ask(move || crate::local_eval::measured_engine_by(&address, deadline))
    };
    let until = deadline + HANDOVER;
    let mut missed = Vec::new();
    let mut answered = |answer: Option<Result<Option<String>, NoAnswer>>, what: Missed| match answer
    {
        Some(Ok(said)) => said,
        Some(Err(NoAnswer)) | None => {
            missed.push(what);
            None
        }
    };
    let version = answered(version.by(until), Missed::EngineVersion);
    let disk_use = answered(disk_use.by(until), Missed::EngineDiskUse);
    let measured = answered(
        measured
            .by(until)
            .map(|said| said.map(Some).ok_or(NoAnswer)),
        Missed::EngineSize,
    );
    let engine = Engine {
        name: address.engine.binary().to_owned(),
        version,
        measured: measured.unwrap_or_else(|| NOT_MEASURED.to_owned()),
        disk_use,
    };
    (engine, missed)
}

/// `args` on the engine, stopped at `deadline`: its trimmed stdout when it succeeded and said
/// something, nothing when it failed, and `NoAnswer` when it was still running at the deadline.
fn engine_query(
    address: &crate::engine::Address,
    args: &[&str],
    deadline: Instant,
) -> Result<Option<String>, NoAnswer> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(NoAnswer);
    }
    let mut command = address.command();
    command.args(args);
    match crate::quiet::output_within(&mut command, left) {
        Ok(out) => Ok(out
            .status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
            .filter(|said| !said.is_empty())),
        Err(error) if error.kind() == std::io::ErrorKind::TimedOut => Err(NoAnswer),
        Err(_) => Ok(None),
    }
}

/// The bundle as text, redacted. `home` is written as `~`.
pub fn bundle(facts: &Facts, home: Option<&str>) -> String {
    let failure = facts
        .failure
        .as_deref()
        .map(|failure| bounded(failure.trim(), FAILURE_BYTES))
        .filter(|failure| !failure.is_empty());
    let mut out = String::new();
    out.push_str("# OpenBot troubleshooting logs\n\n");
    out.push_str(&summary(facts, failure));
    out.push_str(&format!("\n{REDACTED_NOTE}\n\n"));
    out.push_str(&format!("{}\n", facts.desktop));
    out.push_str(&format!("System: {}\n", facts.system));
    out.push_str("\n## What failed\n\n");
    match failure {
        Some(failure) => {
            out.push_str(failure);
            out.push('\n');
        }
        None => out.push_str("Nothing reported a failure.\n"),
    }
    // Beside what failed, since what was stuck is often why: a source that didn't answer in time.
    if !facts.missed.is_empty() {
        out.push_str("\n## What couldn't be collected\n\n");
        for missed in &facts.missed {
            out.push_str(&format!("- {}\n", missed.said(facts.limit)));
        }
    }
    out.push_str("\n## Container engine\n\n");
    match &facts.engine {
        Some(engine) => {
            out.push_str(&format!("{}\n", engine_name(engine)));
            out.push_str(&format!("Measured: {}\n", engine.measured));
            if let Some(disk_use) = &engine.disk_use {
                out.push_str(&format!("\n$ {} system df\n{disk_use}\n", engine.name));
            }
        }
        None if facts.missed.contains(&Missed::Engine) => {
            out.push_str("No container engine answered in time.\n")
        }
        None => out.push_str("No container engine is answering.\n"),
    }
    let file = |out: &mut String, title: &str, found: &Option<(PathBuf, String)>| {
        out.push_str(&format!("\n## {title}\n\n"));
        match found {
            Some((path, tail)) => {
                out.push_str(&format!(
                    "{}\n\n```\n{}\n```\n",
                    path.display(),
                    tail.trim_end()
                ));
            }
            None => out.push_str("Not found on this computer.\n"),
        }
    };
    file(&mut out, "OpenBot Desktop log (end)", &facts.desktop_log);
    file(&mut out, "Backend CLI log (end)", &facts.cli_log);
    // What a model provider really said when a Bot's turn failed: the server writes it to its own
    // log and nowhere else, and the person reads only a sentence about it.
    out.push_str("\n## Model provider errors (server log)\n\n");
    match facts.server_log.as_deref().map(provider_refusals) {
        Some(lines) if !lines.is_empty() => out.push_str(&format!("```\n{lines}\n```\n")),
        Some(_) => out.push_str("None in the server's recent log.\n"),
        None if facts.missed.contains(&Missed::ServerLog) => {
            out.push_str("Couldn't read the server's log in time.\n")
        }
        None => out.push_str("The server isn't running.\n"),
    }
    // What dictation and narration did: which languages this computer said it could recognise,
    // permissions, the microphone, and the recognizer's errors. Never a word of what was said.
    out.push_str("\n## Speech log (end)\n\n");
    if facts.speech_log.is_empty() {
        out.push_str("Not found on this computer.\n");
    }
    for (index, (path, tail)) in facts.speech_log.iter().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        out.push_str(&format!(
            "{}\n\n```\n{}\n```\n",
            path.display(),
            tail.trim_end()
        ));
    }
    redact(&out, home).into_owned()
}

/// What the bundle says was taken out, so a person knows it is safe to paste.
pub const REDACTED_NOTE: &str = "Redacted on this computer before copying: API keys, tokens, \
passwords, cookies, email addresses, and account, organisation, user and installation ids. The \
home folder is written as ~.";

/// `docker 28.5.1`, or `docker` when it did not say its version.
fn engine_name(engine: &Engine) -> String {
    match &engine.version {
        Some(version) => format!("{} {version}", engine.name),
        None => engine.name.clone(),
    }
}

/// The headline, for whoever reads the bundle first: which build, what failed, and the engine's
/// size and disk. One to three lines.
fn summary(facts: &Facts, failure: Option<&str>) -> String {
    let mut lines = vec![format!("Summary: {} on {}.", facts.desktop, facts.system)];
    if let Some(failure) = failure {
        let said: Vec<&str> = failure
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .take(2)
            .collect();
        let mut said = said.join(" / ");
        if said.chars().count() > 300 {
            said = said.chars().take(300).collect::<String>() + "…";
        }
        lines.push(format!("Failed: {said}"));
    }
    lines.push(match &facts.engine {
        Some(engine) => format!(
            "Container engine: {}. {}.",
            engine_name(engine),
            engine.measured
        ),
        None if facts.missed.contains(&Missed::Engine) => {
            "Container engine: none answered in time.".to_owned()
        }
        None => "Container engine: none is answering.".to_owned(),
    });
    if !facts.missed.is_empty() {
        let named: Vec<&str> = facts.missed.iter().map(|missed| missed.named()).collect();
        lines.push(format!(
            "Couldn't collect: {}. See What couldn't be collected.",
            named.join(", ")
        ));
    }
    lines.join("\n") + "\n"
}

/// At most `max` bytes of `text`, cut at a character.
fn bounded(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// A named account identifier: `"organizationId":"org_…"`, `user_id=…`, `"subjectId":"usr_…"`.
static IDENTIFIER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(?P<name>[A-Za-z0-9_]*?(?:organi[sz]ation|org|user|account|subject|installation|install|tenant|workspace|team|customer|member|distinct)[_\-]?id)(?P<sep>["']?\s*[:=]\s*["']?)(?:\[[a-z]+\]|[^\s"'&,;}\]\)]+)"#,
    )
    .expect("the identifier pattern compiles")
});

/// `logging::redact`, the home folder as `~` by every name it goes by (`logging::home_forms`), then
/// account identifiers as `[id]`.
pub fn redact<'a>(text: &'a str, home: Option<&str>) -> Cow<'a, str> {
    redact_homes(
        text,
        &home.map(crate::logging::home_forms).unwrap_or_default(),
    )
}

/// `redact`, given the home folder's forms.
fn redact_homes<'a>(text: &'a str, homes: &[String]) -> Cow<'a, str> {
    let scrubbed = crate::logging::scrub_homes(text, homes);
    if !IDENTIFIER.is_match(&scrubbed) {
        return scrubbed;
    }
    Cow::Owned(
        IDENTIFIER
            .replace_all(&scrubbed, format!("${{name}}${{sep}}{ID}"))
            .into_owned(),
    )
}

/// The newest file in this app's log folder: the current one, or a set-aside one written later.
/// Saved bundles are not logs and are passed over.
pub fn newest_log(folder: &Path) -> Option<PathBuf> {
    std::fs::read_dir(folder)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with(crate::logging::FILE_NAME) && name.ends_with(".log")
        })
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

/// The back end CLI's log: `~/.copilotkit/cli.log` on every platform, under the home folder the CLI
/// runs with (`HOME`, or `USERPROFILE` on Windows).
pub fn cli_log(home: &Path) -> PathBuf {
    home.join(".copilotkit").join("cli.log")
}

/// The last `max_bytes` of a file, starting at a whole line. The whole file when it is shorter.
pub fn tail(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let length = file.metadata()?.len();
    let start = length.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(max_bytes).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if start == 0 {
        return Ok(text);
    }
    // The first line was cut partway through.
    Ok(match text.find('\n') {
        Some(newline) => text[newline + 1..].to_owned(),
        None => text,
    })
}

/*
 * CONNECTED TO AN OPENBOT THAT RUNS ELSEWHERE.
 *
 * Nothing of an installation on this computer applies then: no engine, no containers, no server log
 * here. What helps is what the app saw of that OpenBot: whether it answers and which release it
 * runs, which account and organization the app works in there, the app's own recent problems as
 * its page recorded them (`page_problems`), each failed request with the request id that finds it
 * in that OpenBot's own logs, the relay's recent lines, and the end of this app's log.
 *
 * Ids are kept here: they are how a failure is found on the server. Everything else is redacted as
 * the log is, and the problems were redacted as they arrived.
 */

/// How many of the relay's latest lines go in.
pub const RELAY_LINES: usize = 200;

/// Where `gather_connected` finds what goes into a bundle while the app is connected.
pub struct ConnectedSources<'a> {
    pub desktop: String,
    pub failure: Option<String>,
    /// This app's log folder (`logging::folder`).
    pub log_folder: Option<&'a Path>,
    /// The home folder, written as `~`.
    pub home: Option<&'a str>,
    /// The address of the OpenBot the app is connected to.
    pub address: Option<String>,
    /// Whether the app is signed in there and showing it now.
    pub signed_in: bool,
    /// The page's own release, as it last named it.
    pub front_end: Option<String>,
    /// What that OpenBot says about itself (`connected::about::ask`), by the deadline.
    pub about: Ask<crate::connected::about::About>,
    /// The app's recent problems, oldest first.
    pub problems: Vec<crate::page_problems::Problem>,
    pub limit: Duration,
}

/// What goes into a bundle while connected, gathered by `gather_connected`.
#[derive(Debug, Default)]
pub struct ConnectedFacts {
    pub desktop: String,
    pub system: String,
    pub failure: Option<String>,
    pub address: Option<String>,
    pub signed_in: bool,
    pub front_end: Option<String>,
    pub about: Option<crate::connected::about::About>,
    pub problems: Vec<crate::page_problems::Problem>,
    pub desktop_log: Option<(PathBuf, String)>,
    pub missed: Vec<Missed>,
    pub limit: Duration,
}

/// Gather a bundle while connected and lay it out, within `sources.limit` and a moment to hand over.
pub fn gather_connected(sources: ConnectedSources) -> String {
    let limit = sources.limit;
    let deadline = Instant::now() + limit;
    let ask_about = sources.about;
    let about = ask(move || ask_about(deadline));
    let desktop_log = sources.log_folder.and_then(newest_log).and_then(|path| {
        tail(&path, DESKTOP_TAIL_BYTES)
            .ok()
            .map(|tail| (path, tail))
    });
    let mut missed = Vec::new();
    let about = match about.by(deadline + HANDOVER) {
        Some(Ok(about)) => about,
        Some(Err(NoAnswer)) | None => {
            missed.push(Missed::ConnectedOpenBot);
            None
        }
    };
    if !missed.is_empty() {
        log::warn!(
            "[logs] no answer within {}s from the connected OpenBot",
            limit.as_secs()
        );
    }
    connected_bundle(
        &ConnectedFacts {
            desktop: sources.desktop,
            system: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
            failure: sources.failure,
            address: sources.address,
            signed_in: sources.signed_in,
            front_end: sources.front_end,
            about,
            problems: sources.problems,
            desktop_log,
            missed,
            limit,
        },
        sources.home,
    )
}

/// The relay's lines in `log`, the latest `RELAY_LINES` of them.
pub fn relay_lines(log: &str) -> String {
    let lines: Vec<&str> = log
        .lines()
        .filter(|line| line.contains("[relay]"))
        .map(str::trim_end)
        .collect();
    lines[lines.len().saturating_sub(RELAY_LINES)..].join("\n")
}

/// What the connected bundle says was taken out, so a person knows it is safe to paste, and what
/// was kept on purpose.
pub const CONNECTED_REDACTED_NOTE: &str = "Redacted on this computer before copying: API keys, \
tokens, passwords, cookies and email addresses. The home folder is written as ~. Request, account \
and organization ids are kept, so a failure can be found in the server's logs.";

/// `text` with its ids kept and every credential and email address replaced, and the home folder,
/// by each of `homes`, as `~`.
fn keeping_ids(text: &str, homes: &[String]) -> String {
    let mut text = crate::logging::redact_keeping_ids(text).into_owned();
    let mut homes: Vec<&String> = homes.iter().filter(|home| home.len() > 3).collect();
    homes.sort_by_key(|home| std::cmp::Reverse(home.len()));
    for home in homes {
        text = text.replace(home.as_str(), "~");
    }
    text
}

/// The bundle while connected, as text. Each part is redacted for what it is: what holds ids keeps
/// them (`keeping_ids`), and the failure and the log are redacted in full.
pub fn connected_bundle(facts: &ConnectedFacts, home: Option<&str>) -> String {
    let homes = home.map(crate::logging::home_forms).unwrap_or_default();
    let full = |text: &str| crate::logging::scrub_homes(text, &homes).into_owned();
    let ids = |text: &str| keeping_ids(text, &homes);
    let failure = facts
        .failure
        .as_deref()
        .map(|failure| bounded(failure.trim(), FAILURE_BYTES))
        .filter(|failure| !failure.is_empty());
    let about = facts.about.as_ref();
    let where_to = facts
        .address
        .as_deref()
        .map(crate::connected::host_of)
        .unwrap_or_else(|| "an OpenBot it has no address for".to_owned());

    let mut out = String::new();
    out.push_str("# OpenBot troubleshooting logs\n\n");
    // The summary: which build, where it is connected, what that OpenBot said, what the app saw.
    let mut summary = vec![ids(&format!(
        "Summary: {} on {}, connected to {where_to}.",
        facts.desktop, facts.system
    ))];
    if let Some(failure) = failure {
        let said: Vec<&str> = failure
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .take(2)
            .collect();
        summary.push(full(&format!("Failed: {}", said.join(" / "))));
    }
    summary.push(match about {
        Some(about) => ids(&format!(
            "The connected OpenBot: {}{}.",
            about.health,
            about
                .release
                .as_deref()
                .map(|release| format!(", release {release}"))
                .unwrap_or_default()
        )),
        None if facts.missed.contains(&Missed::ConnectedOpenBot) => {
            "The connected OpenBot: didn't answer in time.".to_owned()
        }
        None => "The connected OpenBot: not asked.".to_owned(),
    });
    summary.push(match facts.problems.last() {
        None => "Problems the app recorded: none since OpenBot Desktop started.".to_owned(),
        Some(latest) => {
            let mut counted: Vec<(&str, usize)> = Vec::new();
            for problem in &facts.problems {
                match counted
                    .iter_mut()
                    .find(|(name, _)| *name == problem.named())
                {
                    Some((_, count)) => *count += 1,
                    None => counted.push((problem.named(), 1)),
                }
            }
            let counted: Vec<String> = counted
                .iter()
                .map(|(name, count)| {
                    if *count == 1 {
                        format!("1 {name}")
                    } else {
                        format!("{count} {name}s")
                    }
                })
                .collect();
            ids(&format!(
                "Problems the app recorded: {} ({}). The latest: {}",
                facts.problems.len(),
                counted.join(", "),
                latest.line()
            ))
        }
    });
    if !facts.missed.is_empty() {
        let named: Vec<&str> = facts.missed.iter().map(|missed| missed.named()).collect();
        summary.push(format!(
            "Couldn't collect: {}. See What couldn't be collected.",
            named.join(", ")
        ));
    }
    out.push_str(&summary.join("\n"));
    out.push_str(&format!("\n\n{CONNECTED_REDACTED_NOTE}\n\n"));
    out.push_str(&ids(&format!(
        "{}\nSystem: {}\n",
        facts.desktop, facts.system
    )));

    out.push_str("\n## The connected OpenBot\n\n");
    let mut lines = vec![format!(
        "Address: {}",
        facts.address.as_deref().unwrap_or("none on record")
    )];
    lines.push(if facts.signed_in {
        "Signed in: yes, and showing it now.".to_owned()
    } else {
        "Signed in: no. The app isn't showing it now; sign in from the setup window.".to_owned()
    });
    match about {
        Some(about) => {
            lines.push(format!("Health (GET /health): {}", about.health));
            lines.push(format!(
                "Release: {}",
                about.release.as_deref().unwrap_or("not known")
            ));
            if let Some(edition) = &about.edition {
                lines.push(format!("Edition: {edition}"));
            }
            if !about.api.is_empty() {
                lines.push(format!("API versions: {}", about.api.join(", ")));
            }
            lines.push(format!(
                "Organization id: {}",
                about.organization.as_deref().unwrap_or("not known")
            ));
            lines.push(format!(
                "Account id: {}",
                about.account.as_deref().unwrap_or("not known")
            ));
            for unanswered in &about.unanswered {
                lines.push(format!("Not known: {unanswered}"));
            }
        }
        None if facts.missed.contains(&Missed::ConnectedOpenBot) => {
            lines.push("It didn't answer in time.".to_owned())
        }
        None => lines.push("Not asked.".to_owned()),
    }
    lines.push(format!(
        "Front end: {}",
        facts
            .front_end
            .as_deref()
            .map(|version| format!("{version}, as the app's page named its own release"))
            .unwrap_or_else(|| "not known: the page hasn't named its release".to_owned())
    ));
    out.push_str(&ids(&lines.join("\n")));
    out.push('\n');

    out.push_str("\n## What failed\n\n");
    match failure {
        Some(failure) => {
            out.push_str(&full(failure));
            out.push('\n');
        }
        None => out.push_str("Nothing reported a failure.\n"),
    }
    if !facts.missed.is_empty() {
        out.push_str("\n## What couldn't be collected\n\n");
        for missed in &facts.missed {
            out.push_str(&format!("- {}\n", missed.said(facts.limit)));
        }
    }

    out.push_str(&format!(
        "\n## Problems the app recorded (oldest first, the last {})\n\n",
        crate::page_problems::KEPT
    ));
    if facts.problems.is_empty() {
        out.push_str(
            "None since OpenBot Desktop started. The app records requests that failed or got no \
             answer, errors on its pages and runs that failed, as they happen.\n",
        );
    } else {
        let lines: Vec<String> = facts
            .problems
            .iter()
            .map(|problem| problem.line())
            .collect();
        out.push_str(&format!("```\n{}\n```\n", ids(&lines.join("\n"))));
    }

    out.push_str("\n## Relay (recent lines)\n\n");
    let relay = facts
        .desktop_log
        .as_ref()
        .map(|(_, tail)| relay_lines(tail))
        .unwrap_or_default();
    if relay.is_empty() {
        out.push_str("None in this app's recent log.\n");
    } else {
        out.push_str(&format!("```\n{}\n```\n", full(&relay)));
    }

    out.push_str("\n## OpenBot Desktop log (end)\n\n");
    match &facts.desktop_log {
        Some((path, tail)) => out.push_str(&full(&format!(
            "{}\n\n```\n{}\n```\n",
            path.display(),
            tail.trim_end()
        ))),
        None => out.push_str("Not found on this computer.\n"),
    }
    out
}

/// Save a bundle in `folder` as `openbot-troubleshooting-<stamp>.txt`, and say where.
pub fn save(folder: &Path, text: &str, stamp: &str) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(folder)?;
    let path = folder.join(format!("{SAVED_PREFIX}{stamp}.txt"));
    std::fs::write(&path, text)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;
    use std::time::Duration;

    // Built at run time, so no key-shaped literal sits in the source for a scanner to stop.
    fn fake(prefix: &str, body: &str, times: usize) -> String {
        format!("{prefix}{}", body.repeat(times))
    }

    /**
    Lines as the logs really write them, each holding something a third-party AI must not get: the
    CLI's JSON lines (sign-in with email, organisation, user and subject ids; a license check), this
    app's own lines, an `.env` file's lines (quoted values with spaces among them), `Authorization`
    headers, provider keys (`sk-proj-`, `sk-ant-api03-`), a Claude sign-in token (`sk-ant-oat01-`),
    an OAuth callback and an OAuth token answer.
    */
    #[test]
    fn keys_tokens_secrets_emails_and_ids_from_real_log_lines_are_redacted() {
        let jwt = format!(
            "eyJ{}.eyJ{}.{}",
            fake("", "hbGciOi", 3),
            fake("", "zdWIiOi", 3),
            "Sfl9xQ"
        );
        let openai = fake("sk-proj-", "Ab9_x7Qz", 6);
        let anthropic = fake("sk-ant-api03-", "Ab9_", 12);
        let oauth = fake("sk-ant-oat01-", "Zq3-Kp8_", 8);
        let license = fake("ck_lic_", "q7Rt2Xw9", 4);
        let google_secret = fake("GOCSPX-", "aB3dE5", 4);
        let refresh = fake("1//0g", "Lm7Np2Qr", 5);
        let composio = fake("ak_", "x7k2m9p4", 3);
        let encryption = fake("", "Qm9vYmFy", 4) + "==";
        let code = fake("4/0Aean", "S9kLm2", 5);
        let cases: Vec<(String, Vec<&str>)> = vec![
            // The CLI's JSON lines (`~/.copilotkit/cli.log`).
            (
                r#"{"level":30,"time":"2026-11-08T10:12:01.004Z","event":"auth.signed_in","email":"dana.rivera@acme-robotics.io","organizationId":"org_2xK9pQ7vLm","userId":"user_31aZ","subjectId":"usr_01JD8ZK3Q4M7N2P5R8T0V"}"#.to_owned(),
                vec!["dana.rivera@acme-robotics.io", "org_2xK9pQ7vLm", "user_31aZ", "usr_01JD8ZK3Q4M7N2P5R8T0V"],
            ),
            (
                format!(r#"{{"level":30,"time":"2026-11-08T10:12:02.551Z","msg":"license.verified","licenseToken":"{license}","token":"{jwt}"}}"#),
                vec![license.as_str(), jwt.as_str()],
            ),
            (
                r#"{"level":30,"time":"2026-11-08T10:12:03.000Z","msg":"telemetry.sink.succeeded","posthog_distinct_id":"8c0f4a52-7e0b-4d1e-9a5f-3b2c1d0e9f8a"}"#.to_owned(),
                vec!["8c0f4a52-7e0b-4d1e-9a5f-3b2c1d0e9f8a"],
            ),
            // This app's lines (`openbot-desktop.log`).
            (
                format!("2026-11-08T10:12:01.010Z INFO  [provider] GET https://api.anthropic.com/v1/models Authorization: Bearer {oauth}"),
                vec![oauth.as_str()],
            ),
            (
                format!("2026-11-08T10:12:01.011Z WARN  [provider] the key {anthropic} was refused (401)"),
                vec![anthropic.as_str()],
            ),
            (
                format!("2026-11-08T10:12:01.012Z INFO  [oauth] callback http://127.0.0.1:43117/callback?code={code}&state=Xy7kQ2mN9pL4"),
                vec![code.as_str(), "Xy7kQ2mN9pL4"],
            ),
            (
                format!(r#"2026-11-08T10:12:01.013Z INFO  [oauth] token answer {{"access_token":"{jwt}","refresh_token":"{refresh}","client_secret":"{google_secret}"}}"#),
                vec![jwt.as_str(), refresh.as_str(), google_secret.as_str()],
            ),
            (
                "2026-11-08T10:12:05.000Z INFO  [config] wrote /Users/dana/OpenBot/.env".to_owned(),
                vec!["/Users/dana"],
            ),
            // An `.env` file, as a person might paste it into a failure or a log.
            (format!("OPENAI_API_KEY={openai}"), vec![openai.as_str()]),
            (format!("ANTHROPIC_API_KEY=\"{anthropic}\""), vec![anthropic.as_str()]),
            (format!("CLAUDE_CODE_OAUTH_TOKEN={oauth}"), vec![oauth.as_str()]),
            (format!("COPILOTKIT_LICENSE_TOKEN={license}"), vec![license.as_str()]),
            (format!("COMPOSIO_API_KEY={composio}"), vec![composio.as_str()]),
            (format!("KEY_ENCRYPTION_KEY={encryption}"), vec![encryption.as_str()]),
            ("BETTER_AUTH_SECRET=\"correct horse battery staple\"".to_owned(), vec!["correct", "horse", "battery", "staple"]),
            ("export WORKER_SHARED_SECRET='two words'".to_owned(), vec!["two", "words"]),
            ("DATABASE_URL=postgres://openbot:hunter2pass@127.0.0.1:5432/openbot".to_owned(), vec!["hunter2pass"]),
        ];
        for (line, secrets) in &cases {
            let redacted = redact(line, Some("/Users/dana"));
            for secret in secrets {
                assert!(
                    !redacted.contains(secret),
                    "{secret} survived in\n{line}\nas\n{redacted}"
                );
            }
        }
        // What stays says what was there.
        let said = |line: &str| redact(line, Some("/Users/dana")).into_owned();
        assert!(
            said(&cases[0].0).contains(
                r#""email":"[email]","organizationId":"[id]","userId":"[id]","subjectId":"[id]""#
            ),
            "{}",
            said(&cases[0].0)
        );
        assert_eq!(
            said(&cases[3].0),
            "2026-11-08T10:12:01.010Z INFO  [provider] GET https://api.anthropic.com/v1/models Authorization: Bearer [redacted]"
        );
        assert_eq!(
            said("BETTER_AUTH_SECRET=\"correct horse battery staple\""),
            "BETTER_AUTH_SECRET=[redacted]"
        );
        assert_eq!(
            said(&cases[7].0),
            "2026-11-08T10:12:05.000Z INFO  [config] wrote ~/OpenBot/.env"
        );
        assert_eq!(said(&cases[8].0), "OPENAI_API_KEY=[redacted]");
    }

    /**
    The home folder by its 8.3 short name. On a Windows runner the Desktop log's folder came out as
    `C:\Users\RUNNER~1\AppData\Local\Temp\…`, which `USERPROFILE` (`C:\Users\runneradmin`) does not
    match, so the user's name went into the bundle. Every form is written as `~`, the longer first.
    */
    #[test]
    fn the_home_folder_is_redacted_by_its_short_name_too() {
        let homes = [
            r"C:\Users\runneradmin".to_owned(),
            r"C:\Users\RUNNER~1".to_owned(),
        ];
        let text = concat!(
            r"C:\Users\RUNNER~1\AppData\Local\Temp\openbot-troubleshooting-logs-3408-0\logs\openbot-desktop.log",
            "\n",
            r"C:\Users\runneradmin\.copilotkit\cli.log",
        );
        assert_eq!(
            redact_homes(text, &homes),
            concat!(
                r"~\AppData\Local\Temp\openbot-troubleshooting-logs-3408-0\logs\openbot-desktop.log",
                "\n",
                r"~\.copilotkit\cli.log",
            )
        );
        // A home that is a prefix of another's name never leaves part of it behind.
        let nested = [
            r"C:\Users\run".to_owned(),
            r"C:\Users\runneradmin".to_owned(),
        ];
        assert_eq!(redact_homes(r"C:\Users\runneradmin\x", &nested), r"~\x");
    }

    /// This computer's own temporary folder, which Windows names by the home folder's short form
    /// when it has one, reads as under `~`.
    #[cfg(windows)]
    #[test]
    fn this_windows_temp_folder_is_under_the_home_folder_by_any_name() {
        let home = crate::logging::home_folder().expect("USERPROFILE is set");
        let temp = std::env::temp_dir().display().to_string();
        let user = home.rsplit('\\').next().unwrap().to_owned();
        let forms = crate::logging::home_forms(&home);
        let users = home.rsplit_once('\\').map(|(users, _)| users).unwrap();
        if !temp.starts_with(users) {
            // TEMP is outside every profile on this machine; nothing of the home folder is in it.
            return;
        }
        // Under C:\Users, TEMP is in this account's profile, by whichever name Windows gave it.
        assert!(
            forms.iter().any(|form| temp.starts_with(form.as_str())),
            "{temp} is under none of {forms:?}"
        );
        let redacted = redact(&temp, Some(&home));
        assert!(redacted.starts_with('~'), "{temp} became {redacted}");
        assert!(!redacted.contains(&user), "{redacted}");
    }

    /// What the bundle is for has to survive: steps, exit codes, sizes, versions and the stack's name.
    #[test]
    fn the_failure_itself_is_left_readable() {
        for line in [
            "2026-11-08T10:14:22.120Z info step engine-storage-check succeeded",
            "2026-11-08T10:15:40.003Z ERROR [local setup] failed after 88.1s: exit 1; error.code=IMAGE_PULL_FAILED",
            "write /var/lib/docker/tmp/GetImageBlob123: no space left on device",
            "Images          14        3         18.2GB    12.1GB (66%)",
            "27.3.1",
            "[launch] OpenBot Desktop 1.0.0-rc.1 (Built 2026-11-08 06:40 UTC from 52ea4b5) on macos aarch64",
            "WARN [local check] before local start: 8 CPUs and 7.7 GiB of memory, 0.0 GiB free of 58.4 GiB in a container; short of disk (nearly full)",
            r#"{"level":30,"time":"2026-11-08T10:12:03.000Z","event":"consent.state.invalid","flowId":"setup-abc","runId":"run-7"}"#,
            "stack local-7f3a2c is starting",
            // What the app logs when it saves a bundle. The file's whole name reads as a key.
            "2026-11-09T22:27:16.960Z INFO  [logs] saved troubleshooting logs in the log folder, stamped 2026-11-09T22-27-16Z",
        ] {
            assert_eq!(redact(line, Some("/Users/dana")), line);
        }
    }

    fn full_engine() -> Engine {
        Engine {
            name: "docker".into(),
            version: Some("28.5.1".into()),
            measured: "8 CPUs and 7.7 GiB of memory, 0.0 GiB free of 58.4 GiB in a container; short of disk (nearly full)".into(),
            disk_use: Some("TYPE   TOTAL  ACTIVE  SIZE  RECLAIMABLE\nImages 14  3  18.2GB  12.1GB (66%)".into()),
        }
    }

    #[test]
    fn a_bundle_opens_with_a_summary_and_has_every_section_redacted() {
        let facts = Facts {
            desktop: "OpenBot Desktop 1.0.0 (Built 2026-11-08 06:40 UTC from 52ea4b5)".into(),
            system: "macos aarch64".into(),
            failure: Some("The backend could not start.\nexit 1".into()),
            engine: Some(full_engine()),
            desktop_log: Some((
                PathBuf::from(
                    "/Users/dana/Library/Logs/ai.copilotkit.openbot.desktop/openbot-desktop.log",
                ),
                "2026-11-08T10:15:40.003Z ERROR [local setup] failed after 88.1s: exit 1\n".into(),
            )),
            cli_log: Some((
                PathBuf::from("/Users/dana/.copilotkit/cli.log"),
                r#"signed in {"email":"a@b.co","organizationId":"org_1"}"#.into(),
            )),
            server_log: None,
            speech_log: vec![(
                PathBuf::from("/Users/dana/Library/Logs/OpenBot/speech.log"),
                "1763460000000 session=0 available(cy-GB) = Unavailable\n".into(),
            )],
            ..Facts::default()
        };
        let text = bundle(&facts, Some("/Users/dana"));
        assert!(text.starts_with(
            "# OpenBot troubleshooting logs\n\nSummary: OpenBot Desktop 1.0.0 (Built 2026-11-08 06:40 UTC from 52ea4b5) on macos aarch64.\nFailed: The backend could not start. / exit 1\nContainer engine: docker 28.5.1. 8 CPUs and 7.7 GiB of memory, 0.0 GiB free of 58.4 GiB in a container; short of disk (nearly full).\n\nRedacted on this computer"
        ), "{text}");
        for expected in [
            "System: macos aarch64",
            "## What failed\n\nThe backend could not start.\nexit 1\n",
            "## Container engine\n\ndocker 28.5.1\nMeasured: 8 CPUs",
            "$ docker system df\nTYPE",
            "~/Library/Logs/ai.copilotkit.openbot.desktop/openbot-desktop.log",
            "[local setup] failed after 88.1s: exit 1",
            "~/.copilotkit/cli.log",
            r#"{"email":"[email]","organizationId":"[id]"}"#,
            "## Speech log (end)\n\n~/Library/Logs/OpenBot/speech.log\n\n```\n1763460000000 session=0 available(cy-GB) = Unavailable\n```\n",
        ] {
            assert!(text.contains(expected), "missing {expected:?} in\n{text}");
        }
        assert!(!text.contains("/Users/dana"));
        // Everything answered: nothing is said about what couldn't be collected.
        assert!(!text.contains("collect"), "{text}");

        let empty = bundle(&Facts::default(), None);
        assert!(empty.contains("Container engine: none is answering."));
        assert!(empty.contains("Nothing reported a failure."));
        assert!(empty.contains("No container engine is answering."));
        assert_eq!(empty.matches("Not found on this computer.").count(), 3);
        assert!(
            empty.contains("## Speech log (end)\n\nNot found on this computer.\n"),
            "{empty}"
        );

        // A window that passes a huge failure does not make a huge bundle.
        let huge = Facts {
            failure: Some("x".repeat(FAILURE_BYTES * 4)),
            ..Facts::default()
        };
        assert!(bundle(&huge, None).len() < FAILURE_BYTES + 2048);
    }

    /**
    FOUND LIVE. People signed in with a Claude plan kept reading "Claude turned down the request"
    while the Claude app worked, and the bundle they sent said nothing about why: what Claude really
    said went only to the server's own log, as a `model-provider-refused` line. The bundle now carries
    the server's recent ones, redacted like every other line, and nothing else from that log.
    */
    #[test]
    fn the_server_s_model_provider_errors_are_in_the_bundle_redacted() {
        let key = fake("sk-ant-oat01-", "Zq3-Kp8_", 8);
        let refused = |kind: &str, said: &str| {
            format!(
                r#"server-1  | {{"type":"model-provider-refused","bot":"personal-assistant","provider":"Claude","kind":"{kind}","error":"{said}"}}"#
            )
        };
        let log = [
            "server-1  | OpenBot server listening on 0.0.0.0:4000".to_owned(),
            refused("other", "API Error: Connection dropped (ECONNRESET)"),
            r#"server-1  | {"type":"run-model","agentId":"personal-assistant","runId":"run-1"}"#
                .to_owned(),
            refused("usage_limit", "You've hit your limit · resets 3pm"),
            // A provider's words can carry a credential or an address; they go out redacted.
            refused(
                "key",
                &format!("invalid bearer {key} for dana.rivera@acme-robotics.io"),
            ),
        ]
        .join("\n");
        let text = bundle(
            &Facts {
                server_log: Some(log),
                ..Facts::default()
            },
            Some("/Users/dana"),
        );
        let section = text
            .split("## Model provider errors (server log)\n\n")
            .nth(1)
            .unwrap_or_else(|| panic!("no model provider section in\n{text}"));
        for expected in [
            "Connection dropped (ECONNRESET)",
            "You've hit your limit · resets 3pm",
            r#""kind":"usage_limit""#,
        ] {
            assert!(
                section.contains(expected),
                "missing {expected:?} in\n{section}"
            );
        }
        assert!(!text.contains(&key), "{text}");
        assert!(!text.contains("dana.rivera@acme-robotics.io"), "{text}");
        // Only the provider's errors: the rest of the server's log stays out.
        assert!(!text.contains("run-model"), "{text}");
        assert!(!text.contains("listening on"), "{text}");

        // A server that said nothing of the kind, and one that isn't running, each say so.
        let quiet = bundle(
            &Facts {
                server_log: Some("server-1  | OpenBot server listening".into()),
                ..Facts::default()
            },
            None,
        );
        assert!(
            quiet.contains(
                "## Model provider errors (server log)\n\nNone in the server's recent log.\n"
            ),
            "{quiet}"
        );
        let stopped = bundle(&Facts::default(), None);
        assert!(
            stopped
                .contains("## Model provider errors (server log)\n\nThe server isn't running.\n"),
            "{stopped}"
        );
    }

    /// Only the most recent provider errors go in, however many the server wrote.
    #[test]
    fn the_server_s_model_provider_errors_are_bounded_to_the_latest() {
        let log: Vec<String> = (0..500)
            .map(|n| {
                format!(
                    r#"{{"type":"model-provider-refused","kind":"other","error":"number {n}"}}"#
                )
            })
            .collect();
        let kept = provider_refusals(&log.join("\n"));
        assert_eq!(kept.lines().count(), SERVER_REFUSAL_LINES);
        assert!(kept.ends_with(r#""error":"number 499"}"#), "{kept}");
    }

    #[test]
    fn the_newest_log_file_is_read_and_saved_bundles_are_passed_over() {
        let folder = temp_root("troubleshooting-newest");
        std::fs::create_dir_all(&folder).unwrap();
        let set_aside = folder.join("openbot-desktop_2026-11-07_10-00-00.log");
        let current = folder.join("openbot-desktop.log");
        std::fs::write(&set_aside, "old").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&current, "new").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        save(&folder, "bundle", "2026-11-08T10-00-00Z").unwrap();
        std::fs::write(folder.join("other.log"), "not ours").unwrap();
        assert_eq!(newest_log(&folder), Some(current));
        assert_eq!(newest_log(&folder.join("missing")), None);
        let _ = std::fs::remove_dir_all(folder);
    }

    /// Only the end of each log goes in, starting at a whole line, however long the log has grown.
    #[test]
    fn a_tail_is_bounded_and_starts_at_a_whole_line() {
        let folder = temp_root("troubleshooting-tail");
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("cli.log");
        std::fs::write(&path, "first line\nsecond line\nthird line\n").unwrap();
        assert_eq!(
            tail(&path, 1024).unwrap(),
            "first line\nsecond line\nthird line\n"
        );
        assert_eq!(tail(&path, 16).unwrap(), "third line\n");
        assert!(tail(&folder.join("missing.log"), 16).is_err());
        let line = "2026-11-08T10:12:01.004Z INFO  [step engine] docker is answering.\n";
        std::fs::write(&path, line.repeat(20_000)).unwrap();
        let end = tail(&path, CLI_TAIL_BYTES).unwrap();
        assert!(end.len() as u64 <= CLI_TAIL_BYTES);
        assert!(end.starts_with("2026-11-08T"));
        let _ = std::fs::remove_dir_all(folder);
    }

    /// The speech log and the one it set aside go in oldest first, within one budget: the set-aside
    /// one only while the current one leaves room, and neither when there is none.
    #[test]
    fn the_speech_log_and_the_one_set_aside_go_in_oldest_first() {
        let folder = temp_root("troubleshooting-speech");
        std::fs::create_dir_all(&folder).unwrap();
        let current = folder.join("speech.log");
        let set_aside = folder.join("speech.log.1");
        assert_eq!(speech_log(&current, 1024), Vec::new());

        std::fs::write(&current, "3 session=0 available(cy-GB) = Unavailable\n").unwrap();
        assert_eq!(
            speech_log(&current, 1024),
            [(
                current.clone(),
                "3 session=0 available(cy-GB) = Unavailable\n".to_owned()
            )]
        );

        std::fs::write(&set_aside, "1 session=7 listening\n2 session=7 end\n").unwrap();
        assert_eq!(
            speech_log(&current, 1024),
            [
                (
                    set_aside.clone(),
                    "1 session=7 listening\n2 session=7 end\n".to_owned()
                ),
                (
                    current.clone(),
                    "3 session=0 available(cy-GB) = Unavailable\n".to_owned()
                ),
            ]
        );
        // The current one fills the budget: the set-aside one stays out, and nothing is cut short.
        let found = speech_log(&current, 20);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].0, current);
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn the_cli_log_is_under_the_home_folder_on_every_platform() {
        assert_eq!(
            cli_log(Path::new("/Users/dana")),
            Path::new("/Users/dana/.copilotkit/cli.log")
        );
        assert_eq!(
            cli_log(Path::new(r"C:\Users\dana")),
            Path::new(r"C:\Users\dana")
                .join(".copilotkit")
                .join("cli.log")
        );
    }

    #[test]
    fn a_saved_bundle_is_in_the_log_folder() {
        let folder = temp_root("troubleshooting-save").join("logs");
        let path = save(&folder, "text", "2026-11-08T10-00-00Z").unwrap();
        assert_eq!(
            path,
            folder.join("openbot-troubleshooting-2026-11-08T10-00-00Z.txt")
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), "text");
        let _ = std::fs::remove_dir_all(folder.parent().unwrap());
    }

    /**
    Sources that never answer, as on a computer whose engine stalled before setup chose one: the
    bundle still comes back by the deadline, with the logs that are files, and says what it couldn't
    collect near the top, beside what failed. The commands themselves are stopped at the deadline:
    `tests::troubleshooting_logs_come_back_in_time_from_an_engine_that_hangs` in main.rs.
    */
    #[test]
    fn sources_that_never_answer_are_named_and_the_rest_comes_back_in_time() {
        let logs = temp_root("troubleshooting-never-answer");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(
            logs.join("openbot-desktop.log"),
            "2026-11-20T18:21:25.340Z INFO  [watch] OpenBot stopped answering and is not running\n",
        )
        .unwrap();
        let never = |_: Instant| -> Result<Option<String>, NoAnswer> {
            std::thread::sleep(Duration::from_secs(60));
            Ok(None)
        };
        let started = Instant::now();
        let text = gather(Sources {
            desktop: "OpenBot Desktop 1.1.2 (Built 2026-11-20 13:53 UTC from 8826a0fe)".into(),
            failure: None,
            log_folder: Some(&logs),
            home: None,
            engine: Box::new(|_| {
                std::thread::sleep(Duration::from_secs(60));
                Ok(None)
            }),
            server_log: Box::new(never),
            limit: Duration::from_secs(1),
        });
        let took = started.elapsed();
        assert!(
            took < Duration::from_secs(1) + HANDOVER * 3,
            "took {took:?}"
        );
        let missing = text
            .split("## What couldn't be collected\n\n")
            .nth(1)
            .unwrap_or_else(|| panic!("no What couldn't be collected section in\n{text}"));
        let missing = &missing[..missing.find("\n## ").unwrap()];
        assert_eq!(
            missing,
            "- Which container engine is running: none answered within 1 second.\n\
             - The server's log, for model provider errors: the container engine didn't answer \
             within 1 second.\n"
        );
        assert!(
            text.find("## What failed").unwrap() < text.find("## What couldn't").unwrap()
                && text.find("## What couldn't").unwrap()
                    < text.find("## Container engine").unwrap(),
            "{text}"
        );
        for expected in [
            "Container engine: none answered in time.",
            "Couldn't collect: which container engine is running, the server's log.",
            "## Container engine\n\nNo container engine answered in time.\n",
            "## Model provider errors (server log)\n\nCouldn't read the server's log in time.\n",
            "[watch] OpenBot stopped answering and is not running",
        ] {
            assert!(text.contains(expected), "missing {expected:?} in\n{text}");
        }
        let _ = std::fs::remove_dir_all(logs);
    }
}
