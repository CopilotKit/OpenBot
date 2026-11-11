//! Get troubleshooting logs: everything a person, or the AI assistant they paste it into, needs to
//! find out why setup stopped, as one block of text.
//!
//! Before this, finding out why a fresh install said "The back end could not start" took asking for
//! two files by path, the version, and Docker's details, one message at a time. Now one action
//! gathers them: which build, on what, what failed, the container engine's version and size as the
//! back end's own engine check measures it (`local_eval::measured_engine`), and the end of this app's
//! newest log file and of the back end CLI's log.
//!
//! EVERY LINE IS REDACTED, because the point is that a person pastes this into a third-party AI.
//! This app's own log is scrubbed as it is written (`logging::scrub`), but the CLI's is not: it logs
//! `{"email":…,"organizationId":…}` on sign-in. So the whole bundle passes `redact` on its way out:
//! keys, tokens, passwords and emails as `logging::redact` replaces them, the home folder as `~`,
//! and the account identifiers below as `[id]`. Support has never needed them to read a failure,
//! and they say whose installation it is.

use std::borrow::Cow;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

/// How much of the end of this app's newest log goes in: about the last few launches.
pub const DESKTOP_TAIL_BYTES: u64 = 192 * 1024;

/// How much of the end of the CLI's log goes in. It writes far less than the shell does.
pub const CLI_TAIL_BYTES: u64 = 64 * 1024;

/// The most of what failed that goes in: the window passes it, and only its start says anything.
pub const FAILURE_BYTES: usize = 16 * 1024;

/// The name of a saved bundle: `openbot-troubleshooting-<when>.txt`, in the log folder.
pub const SAVED_PREFIX: &str = "openbot-troubleshooting-";

/// Written in place of an account, organisation, user or installation identifier.
pub const ID: &str = "[id]";

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
    pub engine: Option<crate::engine::Address>,
}

/// Gather a bundle and lay it out, redacted.
pub fn gather(sources: Sources) -> String {
    let read = |path: PathBuf, bytes: u64| tail(&path, bytes).ok().map(|tail| (path, tail));
    let facts = Facts {
        desktop: sources.desktop,
        system: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        failure: sources.failure,
        engine: sources.engine.as_ref().map(measure_engine),
        desktop_log: sources
            .log_folder
            .and_then(newest_log)
            .and_then(|path| read(path, DESKTOP_TAIL_BYTES)),
        cli_log: sources
            .home
            .and_then(|home| read(cli_log(Path::new(home)), CLI_TAIL_BYTES)),
    };
    bundle(&facts, sources.home)
}

/// The engine's version, size and disk use, asked at once: each within the engine check's own
/// limits, so a hung engine holds the bundle no longer than it holds the check.
pub fn measure_engine(address: &crate::engine::Address) -> Engine {
    let format = match address.engine {
        crate::engine::Engine::Podman => "{{.Version.Version}}",
        crate::engine::Engine::Docker => "{{.ServerVersion}}",
    };
    std::thread::scope(|scope| {
        let version =
            scope.spawn(|| crate::local_eval::engine_query(address, &["info", "--format", format]));
        let disk_use = scope.spawn(|| crate::local_eval::engine_query(address, &["system", "df"]));
        let measured = crate::local_eval::measured_engine(address);
        let said = |answer: Option<String>| {
            answer
                .map(|said| said.trim().to_owned())
                .filter(|said| !said.is_empty())
        };
        Engine {
            name: address.engine.binary().to_owned(),
            version: said(version.join().ok().flatten()),
            measured,
            disk_use: said(disk_use.join().ok().flatten()),
        }
    })
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
    out.push_str("\n## Container engine\n\n");
    match &facts.engine {
        Some(engine) => {
            out.push_str(&format!("{}\n", engine_name(engine)));
            out.push_str(&format!("Measured: {}\n", engine.measured));
            if let Some(disk_use) = &engine.disk_use {
                out.push_str(&format!("\n$ {} system df\n{disk_use}\n", engine.name));
            }
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
        None => "Container engine: none is answering.".to_owned(),
    });
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
        ] {
            assert!(text.contains(expected), "missing {expected:?} in\n{text}");
        }
        assert!(!text.contains("/Users/dana"));

        let empty = bundle(&Facts::default(), None);
        assert!(empty.contains("Container engine: none is answering."));
        assert!(empty.contains("Nothing reported a failure."));
        assert!(empty.contains("No container engine is answering."));
        assert_eq!(empty.matches("Not found on this computer.").count(), 2);

        // A window that passes a huge failure does not make a huge bundle.
        let huge = Facts {
            failure: Some("x".repeat(FAILURE_BYTES * 4)),
            ..Facts::default()
        };
        assert!(bundle(&huge, None).len() < FAILURE_BYTES + 2048);
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
}
