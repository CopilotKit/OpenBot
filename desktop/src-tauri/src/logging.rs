//! The desktop app's log file: what it did, when, and how it went, kept on this computer.
//!
//! Before this the shell wrote a handful of untimestamped lines to stderr, which on Windows and on a
//! Mac started from the Dock goes nowhere, so when something broke on somebody's computer there was
//! nothing for them to send. Now every line also lands in a file in the platform's own place for
//! application logs (`TargetKind::LogDir`, Tauri's `app_log_dir`):
//!
//! - macOS: `~/Library/Logs/ai.copilotkit.openbot.desktop/openbot-desktop.log`
//! - Windows: `%LOCALAPPDATA%\ai.copilotkit.openbot.desktop\logs\openbot-desktop.log`
//! - Linux: `$XDG_DATA_HOME/ai.copilotkit.openbot.desktop/logs/openbot-desktop.log`
//!   (`~/.local/share/...` when it is unset)
//!
//! The official Tauri log plugin writes it: the `log` macros the shell already reads like its
//! `eprintln!` lines, a file that rotates at `MAX_FILE_BYTES`, and `KEPT_FILES` older ones beside it,
//! so the folder never holds more than about 25 MB.
//!
//! NOTHING SECRET OR PRIVATE GOES IN. The file stays on this computer, and a person sends it to us
//! only when they choose to, so it says what the shell chose and how that went, never the values it
//! handled: no API keys, tokens, passwords, cookies or message contents. The shell's own lines are
//! written that way. Every line, the shell's and the libraries' alike, then passes `scrub` on its
//! way to the file, which replaces anything shaped like a key, a token or an email address, and
//! writes the home folder as `~`.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::{Captures, Regex};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

/// `openbot-desktop.log`, and `openbot-desktop_<date>_<time>.log` once rotated.
pub const FILE_NAME: &str = "openbot-desktop";

/// Where the current file is set aside and a new one started.
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// How many set-aside files are kept beside the current one. Older ones are deleted.
pub const KEPT_FILES: usize = 4;

// The shipped cap: at least one set-aside file (the plugin subtracts one when it rotates), and the
// folder never over 30 MB.
const _: () = assert!(KEPT_FILES >= 1 && MAX_FILE_BYTES * (KEPT_FILES as u64 + 1) <= 30 << 20);

/// Written in place of whatever looked like a key, a token or a password.
pub const REDACTED: &str = "[redacted]";

/// The shell's own crates. Their information lines are the log; every other crate's are noise
/// (and, for an HTTP client, a place a URL with a token in it could turn up), so only their
/// warnings and errors are kept.
const OWN_CRATES: [&str; 2] = ["openbot_desktop", "openbot_desktop_lib"];

/// The plugin as the app registers it: the log file, and stderr as before for a terminal run.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    builder(
        TargetKind::LogDir {
            file_name: Some(FILE_NAME.into()),
        },
        MAX_FILE_BYTES,
        KEPT_FILES,
    )
    .target(Target::new(TargetKind::Stderr))
    .build()
}

/// Everything about the log but where it goes: its levels, its line format and its rotation. The
/// tests build the same logger into a folder of their own.
pub fn builder(
    file: TargetKind,
    max_file_bytes: u64,
    kept_files: usize,
) -> tauri_plugin_log::Builder {
    let home = home_folder();
    let mut builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(file))
        .max_file_size(u128::from(max_file_bytes))
        // At least one: the plugin subtracts one from it when it rotates.
        .rotation_strategy(RotationStrategy::KeepSome(kept_files.max(1)))
        .level(log::LevelFilter::Warn);
    for own in OWN_CRATES {
        builder = builder.level_for(own, log::LevelFilter::Info);
    }
    builder.format(move |out, message, record| {
        out.finish(format_args!(
            "{}",
            line(
                &timestamp(),
                record.level(),
                record.target(),
                &message.to_string(),
                home.as_deref(),
            )
        ))
    })
}

/// The folder the log file is written to, as the plugin resolves it.
pub fn folder<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<PathBuf> {
    use tauri::Manager;
    app.path().app_log_dir()
}

/// Open the log folder for the person, with `open` (the system's file manager in the app). Made
/// first if nothing has been written there yet, so the button never lands on "folder not found".
pub fn open_folder(
    folder: &Path,
    open: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    std::fs::create_dir_all(folder)
        .map_err(|error| format!("could not make the log folder: {error}"))?;
    open(folder)
}

/// What went wrong, as one entry of the log: for a `Problem`, what the person was told and, under
/// it, what lay beneath.
pub trait Failure {
    fn described(&self) -> String;
}

impl Failure for crate::problem::Problem {
    fn described(&self) -> String {
        match &self.detail {
            Some(detail) => format!("{}\n{detail}", self.said),
            None => self.said.clone(),
        }
    }
}

impl Failure for String {
    fn described(&self) -> String {
        self.clone()
    }
}

/// One entry for how something the shell was asked to do ended: `[start] finished in 41.2s`, or
/// `[start] failed after 3.1s: ` and why.
pub fn outcome<T, E: Failure>(what: &str, started: std::time::Instant, result: &Result<T, E>) {
    let took = started.elapsed().as_secs_f32();
    match result {
        Ok(_) => log::info!("[{what}] finished in {took:.1}s"),
        Err(failure) => log::error!("[{what}] failed after {took:.1}s: {}", failure.described()),
    }
}

/// Run a command the engine carries out, and log how it went: `[compose up] finished in 3.2s`, or
/// that it failed, after how long, and what the engine said.
pub fn timed<T, E: Failure>(what: &str, run: impl FnOnce() -> Result<T, E>) -> Result<T, E> {
    let started = std::time::Instant::now();
    let result = run();
    outcome(what, started, &result);
    result
}

/**
What a Start phase waits on, as the log says it: the first answer and every change of it, the same
answer again once a minute, and why the wait ended, with how long it ran and the last answer.

A Start on Windows waited five minutes for OpenBot's services and then said "OpenBot didn't get
ready in time", and the log had nothing in between: not what was asked, not what it answered, not
why it stopped. Support had nothing to go on. Every wait writes these lines now.

Pure, so the rule is tested with the answers the real waits give; the waits pass its lines to
`log::info!`.
*/
pub struct WaitLog {
    what: String,
    started: std::time::Instant,
    checks: u32,
    last: Option<String>,
    logged: Option<std::time::Instant>,
    checked: std::time::Instant,
}

/// How often an answer that has not changed is said again, so a long wait is never silent.
pub const SAID_AGAIN_EVERY: std::time::Duration = std::time::Duration::from_secs(60);

impl WaitLog {
    /// A wait on `what`: the thing asked and where, such as "GET /health on port 64770".
    pub fn new(what: impl Into<String>, now: std::time::Instant) -> Self {
        Self {
            what: what.into(),
            started: now,
            checks: 0,
            last: None,
            logged: None,
            checked: now,
        }
    }

    /// How long since the last answer, so a wait nobody ended (a Start that was stopped) is not
    /// carried on by the next one.
    pub fn quiet_for(&self, now: std::time::Instant) -> std::time::Duration {
        now.duration_since(self.checked)
    }

    /// The line for one answer, when there is one to write: a new answer always, the same one once
    /// `SAID_AGAIN_EVERY` has passed since it was last written.
    pub fn answered(&mut self, now: std::time::Instant, answer: &str) -> Option<String> {
        self.checks += 1;
        self.checked = now;
        let changed = self.last.as_deref() != Some(answer);
        let due = self
            .logged
            .is_none_or(|at| now.duration_since(at) >= SAID_AGAIN_EVERY);
        if !changed && !due {
            return None;
        }
        self.last = Some(answer.to_string());
        self.logged = Some(now);
        Some(format!(
            "[wait] {}: {}{answer} ({} in, check {})",
            self.what,
            if changed { "" } else { "still " },
            took(now.duration_since(self.started)),
            self.checks
        ))
    }

    /// Why the wait ended, after how long and how many checks, and what the last one answered.
    pub fn ended(&self, now: std::time::Instant, why: &str) -> String {
        format!(
            "[wait] {}: {why} after {} and {} checks; last answer: {}",
            self.what,
            took(now.duration_since(self.started)),
            self.checks,
            self.last.as_deref().unwrap_or("none")
        )
    }
}

/// `4.2s`, or `5m 02s` from a minute on.
fn took(elapsed: std::time::Duration) -> String {
    let seconds = elapsed.as_secs();
    if seconds < 60 {
        format!("{:.1}s", elapsed.as_secs_f32())
    } else {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    }
}

/// `2026-11-07T14:03:12.345Z`. UTC, so a line means the same moment wherever it is read; the
/// first line of each launch says the local offset.
fn timestamp() -> String {
    use time::macros::format_description;
    time::OffsetDateTime::now_utc()
        .format(format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        ))
        .unwrap_or_default()
}

/// One line of the file: when, how serious, whose (only for another crate's line: the shell's
/// carry a `[tag]` of their own), and what, scrubbed. A message over several lines keeps its
/// continuation lines indented under it, so each entry still starts with its timestamp.
pub fn line(
    timestamp: &str,
    level: log::Level,
    target: &str,
    message: &str,
    home: Option<&str>,
) -> String {
    let own = OWN_CRATES
        .iter()
        .any(|own| target == *own || target.starts_with(&format!("{own}::")));
    let message = scrub(message.trim_end(), home)
        .replace("\r\n", "\n")
        .replace('\n', "\n    ");
    if own {
        format!("{timestamp} {level:<5} {message}")
    } else {
        format!("{timestamp} {level:<5} {target}: {message}")
    }
}

/// The person's home folder, written as `~` in the log: it names them.
pub fn home_folder() -> Option<String> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    let home = home
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_owned();
    // A home of `/` or `C:` would turn every path into nonsense.
    (home.len() > 3).then_some(home)
}

/// `redact`, then the home folder as `~`.
pub fn scrub<'a>(text: &'a str, home: Option<&str>) -> Cow<'a, str> {
    let redacted = redact(text);
    match home {
        Some(home) if redacted.contains(home) => Cow::Owned(redacted.replace(home, "~")),
        _ => redacted,
    }
}

/**
Every name the home folder goes by: itself, and on Windows its 8.3 short form and long form. Windows writes temporary paths with the short one (`C:\Users\RUNNER~1\AppData\Local\Temp`,
for `C:\Users\runneradmin`), and that names the person as much as the long one does.
*/
pub fn home_forms(home: &str) -> Vec<String> {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut forms = vec![home.to_owned()];
    #[cfg(windows)]
    for other in [windows_path(home, true), windows_path(home, false)]
        .into_iter()
        .flatten()
    {
        let other = other.trim_end_matches(['/', '\\']).to_owned();
        if other.len() > 3 && !forms.contains(&other) {
            forms.push(other);
        }
    }
    forms
}

/// `redact`, then each of `homes` as `~`, longest first so one never leaves part of another.
pub fn scrub_homes<'a>(text: &'a str, homes: &[String]) -> Cow<'a, str> {
    let mut text = redact(text);
    let mut homes: Vec<&String> = homes.iter().filter(|home| home.len() > 3).collect();
    homes.sort_by_key(|home| std::cmp::Reverse(home.len()));
    for home in homes {
        if text.contains(home.as_str()) {
            text = Cow::Owned(text.replace(home.as_str(), "~"));
        }
    }
    text
}

/// `path` in its 8.3 short form (`short`) or its long form, as Windows resolves it. None when the
/// volume keeps no short names or the path does not exist.
#[cfg(windows)]
fn windows_path(path: &str, short: bool) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{GetLongPathNameW, GetShortPathNameW};
    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let resolve = |buffer: Option<&mut [u16]>| {
        let at = windows::core::PCWSTR(wide.as_ptr());
        // SAFETY: `wide` is a NUL-terminated path that outlives the call, and the buffer, when
        // given, is one the call may fill up to its length.
        unsafe {
            if short {
                GetShortPathNameW(at, buffer)
            } else {
                GetLongPathNameW(at, buffer)
            }
        }
    };
    // Asked with no buffer, each answers the length it needs, NUL included.
    let needed = resolve(None) as usize;
    if needed == 0 {
        return None;
    }
    let mut buffer = vec![0u16; needed];
    // Filled, it answers the length it wrote, NUL not included.
    let written = resolve(Some(&mut buffer)) as usize;
    (written > 0 && written < buffer.len()).then(|| String::from_utf16_lossy(&buffer[..written]))
}

/// One way a key or a token shows itself, and what is kept of the match.
struct Rule {
    pattern: Regex,
    /// What the match becomes, with `$name` for the parts kept (the name of a field, a scheme).
    keep: &'static str,
    /// For the shapes that are only secret some of the time: whether this match is one.
    secret: fn(&str) -> bool,
}

fn always(_: &str) -> bool {
    true
}

/// A named credential's value, unless the value is the scheme of an `Authorization` header that the
/// rule before has already redacted: `Authorization: Bearer [redacted]` keeps saying Bearer.
fn named_value(found: &str) -> bool {
    let lower = found.to_ascii_lowercase();
    !["bearer", "basic"].iter().any(|scheme| {
        lower
            .strip_suffix(scheme)
            .is_some_and(|before| before.ends_with([' ', ':', '=', '"', '\'']))
    })
}

/// A random string from a key generator, rather than a word, a name or a number: long, and mixing
/// capitals, small letters and digits, which a container name or a path segment does not.
fn opaque(candidate: &str) -> bool {
    candidate.chars().any(|c| c.is_ascii_uppercase())
        && candidate.chars().any(|c| c.is_ascii_lowercase())
        && candidate.chars().any(|c| c.is_ascii_digit())
}

/// The name of anything that holds a credential: `OPENAI_API_KEY`, `refresh_token`, `x-api-key`.
const CREDENTIAL_NAME: &str = r"[A-Za-z0-9_.\-]*(?:api[_\-]?key|apikey|[_\-]key\b|secret|token|password|passwd|pwd|cookie|authorization|credential|private[_\-]?key|access[_\-]?key|session[_\-]?id)[A-Za-z0-9_.\-]*";

/// In order: a rule after another sees what the earlier one left.
static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let rule = |pattern: &str, keep: &'static str| Rule {
        pattern: Regex::new(pattern).expect("a redaction pattern compiles"),
        keep,
        secret: always,
    };
    vec![
        // A password in a URL: `https://user:password@host`.
        rule(
            r"(?i)\b(?P<scheme>[a-z][a-z0-9+.\-]*://)[^\s/:@]+:[^\s/@]+@",
            "${scheme}[redacted]@",
        ),
        // A cookie header, every pair of it.
        rule(
            r"(?i)\b(?P<name>set-cookie|cookie)(?P<sep>\s*[:=]\s*)[^\r\n]+",
            "${name}${sep}[redacted]",
        ),
        // `Authorization: Bearer <token>`, `Basic <base64>`.
        rule(r"(?i)\b(?P<scheme>bearer)\s+[^\s\x22',;]+", "${scheme} [redacted]"),
        rule(r"\b(?P<scheme>Basic)\s+[A-Za-z0-9+/]{12,}={0,2}", "${scheme} [redacted]"),
        // A credential's quoted value in an `.env` file, spaces and all:
        // `BETTER_AUTH_SECRET="correct horse battery staple"`. The rule after stops at a space.
        rule(
            &format!(
                r#"(?i)(?P<name>{CREDENTIAL_NAME})(?P<sep>\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*')"#
            ),
            "${name}${sep}[redacted]",
        ),
        // Anything named as a credential, with its value: `OPENAI_API_KEY=…`, `"refresh_token": "…"`,
        // `x-api-key: …`, `password=…`. The name stays, so the line still says what was there.
        Rule {
            pattern: Regex::new(&format!(
                r#"(?i)(?P<name>{CREDENTIAL_NAME})(?P<sep>["']?\s*[:=]\s*["']?)[^\s"'&,;}}\]\[][^\s"'&,;}}\]]*"#
            ))
            .expect("a redaction pattern compiles"),
            keep: "${name}${sep}[redacted]",
            secret: named_value,
        },
        // The parts of a sign-in URL that are a credential for as long as they live.
        rule(
            r"(?i)(?P<name>[?&](?:code|state|code_verifier|sig|signature|key|auth)=)[^&\s#\x22']+",
            "${name}[redacted]",
        ),
        // Keys and tokens by their providers' prefixes.
        rule(
            concat!(
                r"\b(?:",
                r"sk-[A-Za-z0-9_\-]{8,}",
                r"|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}",
                r"|gh[pousr]_[A-Za-z0-9]{20,}",
                r"|github_pat_[A-Za-z0-9_]{20,}",
                r"|glpat-[A-Za-z0-9_\-]{20,}",
                r"|xox[abposr]-[A-Za-z0-9\-]{10,}",
                r"|xapp-[A-Za-z0-9\-]{10,}",
                r"|(?:AKIA|ASIA)[A-Z0-9]{16}",
                r"|AIza[0-9A-Za-z_\-]{35}",
                r"|ya29\.[0-9A-Za-z_\-]+",
                r"|npm_[A-Za-z0-9]{36}",
                r"|hf_[A-Za-z0-9]{30,}",
                r"|eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*",
                r")",
            ),
            "[redacted]",
        ),
        // An email address names a person.
        rule(
            r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}\b",
            "[email]",
        ),
        // A long hexadecimal string: a generated secret as often as a digest.
        rule(r"\b[0-9a-fA-F]{32,}\b", "[redacted]"),
        // A long random string with no prefix at all.
        Rule {
            pattern: Regex::new(r"[A-Za-z0-9_\-+=]{20,}").expect("a redaction pattern compiles"),
            keep: "[redacted]",
            secret: opaque,
        },
    ]
});

/// `text` with everything that looks like a key, a token, a password or an email address replaced.
///
/// Errs towards replacing: a log that lost an identifier is still a log, and one that kept a key
/// cannot be sent to anybody.
pub fn redact(text: &str) -> Cow<'_, str> {
    let mut text = Cow::Borrowed(text);
    for rule in RULES.iter() {
        if !rule.pattern.is_match(&text) {
            continue;
        }
        let replaced = rule
            .pattern
            .replace_all(&text, |found: &Captures| {
                let whole = &found[0];
                if !(rule.secret)(whole) {
                    return whole.to_owned();
                }
                let mut kept = String::new();
                found.expand(rule.keep, &mut kept);
                kept
            })
            .into_owned();
        text = Cow::Owned(replaced);
    }
    text
}

#[cfg(test)]
mod tests {
    /// A five-minute wait, as Start's for OpenBot's services ran on Windows: the first answer,
    /// nothing for the same one a second later, the same one again after a minute, a change, and
    /// why it gave up, with how long and the last answer.
    #[test]
    fn a_wait_says_each_answer_once_again_each_minute_and_why_it_ended() {
        let start = std::time::Instant::now();
        let at = |seconds: u64| start + std::time::Duration::from_secs(seconds);
        let mut wait = WaitLog::new(
            "OpenBot's services, GET /health on port 64770 (API) and port 64771 (app)",
            start,
        );
        let refused = "API not answering (http://127.0.0.1:64770/health: Connection refused (os \
                       error 61), http://[::1]:64770/health: Connection refused (os error 61)); app \
                       not asked until the API answers";
        assert_eq!(
            wait.answered(at(1), refused).unwrap(),
            format!(
                "[wait] OpenBot's services, GET /health on port 64770 (API) and port 64771 \
                 (app): {refused} (1.0s in, check 1)"
            )
        );
        assert_eq!(wait.answered(at(2), refused), None);
        assert!(wait
            .answered(at(62), refused)
            .unwrap()
            .ends_with(&format!("still {refused} (1m 02s in, check 3)")));
        let unavailable = "API not answering (http://127.0.0.1:64770/health answered 503 Service \
                           Unavailable); app not asked until the API answers";
        assert!(wait.answered(at(70), unavailable).is_some());
        assert_eq!(
            wait.ended(at(302), "gave up: the API is not answering on port 64770."),
            format!(
                "[wait] OpenBot's services, GET /health on port 64770 (API) and port 64771 \
                 (app): gave up: the API is not answering on port 64770. after 5m 02s and 4 \
                 checks; last answer: {unavailable}"
            )
        );
        assert_eq!(wait.quiet_for(at(80)), std::time::Duration::from_secs(10));
    }

    use super::*;
    use crate::test_support::temp_root;

    // Built at run time, so no key-shaped literal sits in the source for a scanner to stop.
    fn fake(prefix: &str, body: &str, times: usize) -> String {
        format!("{prefix}{}", body.repeat(times))
    }

    #[test]
    fn opening_the_log_folder_makes_it_and_opens_exactly_it() {
        let folder = temp_root("log-open").join("logs");
        let mut opened = None;
        open_folder(&folder, |path| {
            opened = Some(path.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(opened.as_deref(), Some(folder.as_path()));
        assert!(folder.is_dir());
        // The opener's own failure is what the person is told.
        assert_eq!(
            open_folder(&folder, |_| Err("no file manager".into())),
            Err("no file manager".into())
        );
        let _ = std::fs::remove_dir_all(folder.parent().unwrap());
    }

    /// Shapes the shell or an engine can print, each with a credential in it.
    #[test]
    fn keys_tokens_passwords_and_emails_are_redacted() {
        let openai = fake("sk-proj-", "a1B2c3D4", 6);
        let anthropic = fake("sk-ant-oat01-", "Xy7_", 24);
        let github = fake("ghp_", "q1W2", 9);
        let slack = fake("xoxb-", "1234-", 4);
        let jwt = format!(
            "{}.{}.{}",
            fake("eyJ", "hbGciOiJIUzI1", 2),
            fake("eyJ", "zdWIiOiIxMjM0", 2),
            "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        );
        let hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
        let opaque = fake("", "Kd8fJ2", 5);
        let cases = [
            (format!("OPENAI_API_KEY={openai}"), openai.clone()),
            (format!("model refused key {anthropic}"), anthropic.clone()),
            (
                format!("{{\"refresh_token\":\"{opaque}\"}}"),
                opaque.clone(),
            ),
            (
                format!("git clone https://x-access-token:{github}@github.com/a/b"),
                github.clone(),
            ),
            (
                format!("slack said invalid_auth for {slack}"),
                slack.clone(),
            ),
            (format!("Authorization: Bearer {jwt}"), jwt.clone()),
            (format!("id_token {jwt}"), jwt.clone()),
            (format!("KEY_ENCRYPTION_KEY: {hex}"), hex.to_owned()),
            (format!("secret {hex} rejected"), hex.to_owned()),
            (
                "password=hunter2 for postgres".to_owned(),
                "hunter2".to_owned(),
            ),
            (
                "http://127.0.0.1:1455/auth/callback?code=ac_Synthetic.Code&state=xyz123"
                    .to_owned(),
                "ac_Synthetic.Code".to_owned(),
            ),
            (
                "postgres://openbot:s3cret-Pass@postgres:5432/openbot".to_owned(),
                "s3cret-Pass".to_owned(),
            ),
            (
                "Cookie: better-auth.session_token=abc; theme=dark".to_owned(),
                "abc; theme".to_owned(),
            ),
            (
                format!("unexpected answer from {opaque} upstream"),
                opaque.clone(),
            ),
            (
                "signed in as alice.smith@example.com".to_owned(),
                "alice.smith@example.com".to_owned(),
            ),
        ];
        for (line, secret) in &cases {
            let redacted = redact(line);
            assert!(!redacted.contains(secret.as_str()), "{line} -> {redacted}");
            assert!(
                redacted.contains(REDACTED) || redacted.contains("[email]"),
                "{line} -> {redacted}"
            );
        }
        assert_eq!(
            redact(&format!("OPENAI_API_KEY={openai}")),
            "OPENAI_API_KEY=[redacted]"
        );
    }

    /// What the log is for has to survive: commands, exit codes, ports, versions, names and paths.
    #[test]
    fn ordinary_diagnostics_are_left_alone() {
        for line in [
            "[compose] up failed (exit status: 1) in 12.4s",
            "Error response from daemon: Bind for 0.0.0.0:3010 failed: port is already allocated",
            "[engine] docker 27.3.1 is answering at unix:///var/run/docker.sock",
            "pulled ghcr.io/copilotkit/openbot-server:0.3.2 for openbot-desktop-server-1",
            "[app update] could not read https://github.com/CopilotKit/OpenBot/releases/latest/download/latest.json: 404",
            r"[start] installed in C:\Users\Administrator\OpenBot, app on port 3010",
            "[start] using k3d-local-abc-server-0 and cpki-app-api-test",
            "[step engine] Docker Desktop 4.36.0 is running.",
            "[exit] code 0, Os { code: 2, kind: NotFound, message: \"No such file or directory\" }",
            "[start] model anthropic, signed in with a subscription",
            "OpenBot Desktop 0.3.2 (v0.3.2 (b214c97e)) on macos aarch64",
        ] {
            assert_eq!(redact(line), line);
        }
    }

    #[test]
    fn the_home_folder_is_written_as_a_tilde() {
        assert_eq!(
            scrub(
                "[show] installed in /Users/alice/OpenBot",
                Some("/Users/alice")
            ),
            "[show] installed in ~/OpenBot"
        );
        assert_eq!(
            scrub(
                r"opened C:\Users\alice\AppData\Local\x",
                Some(r"C:\Users\alice")
            ),
            r"opened ~\AppData\Local\x"
        );
    }

    #[test]
    fn a_line_says_whose_it_is_only_for_another_crate() {
        assert_eq!(
            line(
                "2026-11-07T14:03:12.345Z",
                log::Level::Info,
                "openbot_desktop_lib::stack",
                "[compose] down finished in 3.1s\n",
                None
            ),
            "2026-11-07T14:03:12.345Z INFO  [compose] down finished in 3.1s"
        );
        assert_eq!(
            line(
                "2026-11-07T14:03:12.345Z",
                log::Level::Error,
                "tauri_plugin_updater",
                "signature mismatch",
                None
            ),
            "2026-11-07T14:03:12.345Z ERROR tauri_plugin_updater: signature mismatch"
        );
    }
}
