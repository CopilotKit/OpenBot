//! Get troubleshooting logs: everything a person, or the AI assistant they paste it into, needs to
//! find out why setup stopped, as one block of text.
//!
//! Before this, finding out why a fresh install said "The back end could not start" took asking for
//! two files by path, the version, and Docker's details, one message at a time. Now one action
//! gathers them: which build, on what, what failed, what the container engine reports about itself
//! and its disk, the end of this app's newest log file and the end of the back end CLI's own log.
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
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use regex::Regex;

/// How much of the end of this app's newest log goes in: about the last few launches.
pub const DESKTOP_TAIL_BYTES: u64 = 192 * 1024;

/// How much of the end of the CLI's log goes in. It writes far less than the shell does.
pub const CLI_TAIL_BYTES: u64 = 64 * 1024;

/// How long one engine command may take before it is left out: an engine whose disk is full, or
/// that is starting, can hang on `system df`.
pub const ENGINE_TIMEOUT: Duration = Duration::from_secs(5);

/// The name of a saved bundle: `openbot-troubleshooting-<when>.txt`, in the log folder.
pub const SAVED_PREFIX: &str = "openbot-troubleshooting-";

/// Written in place of an account, organisation, user or installation identifier.
pub const ID: &str = "[id]";

/// What goes into one bundle, gathered by the app and laid out by `bundle`.
#[derive(Debug, Default)]
pub struct Facts {
    /// `OpenBot Desktop 1.0.0 (Built … from …)`, as the launch line says it.
    pub desktop: String,
    /// `macos aarch64`.
    pub system: String,
    /// What the person was told, and what lay beneath, when something failed.
    pub failure: Option<String>,
    /// Each engine command and what it printed, or why it printed nothing.
    pub engine: Vec<(String, String)>,
    /// The newest log file of this app, and its end.
    pub desktop_log: Option<(PathBuf, String)>,
    /// The CLI's log file and its end, or None when there is none on this computer.
    pub cli_log: Option<(PathBuf, String)>,
}

/// The bundle as text, redacted. `home` is written as `~`.
pub fn bundle(facts: &Facts, home: Option<&str>) -> String {
    let mut out = String::new();
    out.push_str("# OpenBot troubleshooting logs\n\n");
    out.push_str(&summary(facts));
    out.push_str(&format!("\n{REDACTED_NOTE}\n\n"));
    out.push_str(&format!("{}\n", facts.desktop));
    out.push_str(&format!("System: {}\n", facts.system));
    out.push_str("\n## What failed\n\n");
    match &facts.failure {
        Some(failure) if !failure.trim().is_empty() => {
            out.push_str(failure.trim_end());
            out.push('\n');
        }
        _ => out.push_str("Nothing reported a failure.\n"),
    }
    out.push_str("\n## Container engine\n\n");
    if facts.engine.is_empty() {
        out.push_str("No container engine is answering.\n");
    }
    for (command, said) in &facts.engine {
        out.push_str(&format!("$ {command}\n{}\n\n", said.trim_end()));
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
    file(&mut out, "Back end CLI log (end)", &facts.cli_log);
    redact(&out, home).into_owned()
}

/// What the bundle says was taken out, so a person knows it is safe to paste.
pub const REDACTED_NOTE: &str = "Redacted on this computer before copying: API keys, tokens, \
passwords, cookies, email addresses, and account, organisation, user and installation ids. The \
home folder is written as ~.";

/// The headline, for whoever reads the bundle first: which build, what failed, and the engine's
/// size. One to three lines.
pub fn summary(facts: &Facts) -> String {
    let mut lines = vec![format!("Summary: {} on {}.", facts.desktop, facts.system)];
    if let Some(failure) = facts.failure.as_deref().filter(|f| !f.trim().is_empty()) {
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
    if let Some(engine) = engine_summary(&facts.engine) {
        lines.push(engine);
    }
    lines.join("\n") + "\n"
}

/// `docker 28.5.1, 8 CPUs, 8.2 GB memory. Docker disk: 0.0 GB free.`, from
/// the engine commands' own answers. None when nothing answered.
fn engine_summary(engine: &[(String, String)]) -> Option<String> {
    static SIZE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(\d+) CPUs, (\d+) bytes memory").expect("the size pattern compiles")
    });
    let answered = |said: &str| {
        !(said.starts_with("failed (")
            || said.starts_with("no answer within")
            || said.starts_with("could not"))
    };
    let name = engine.first()?.0.split(' ').next()?.to_owned();
    let mut parts = vec![name];
    let version = engine
        .iter()
        .find(|(command, _)| command.contains(" version"))
        .map(|(_, said)| said.trim())
        .filter(|said| !said.is_empty() && answered(said));
    if let Some(version) = version {
        parts[0] = format!("{} {version}", parts[0]);
    }
    let size = engine
        .iter()
        .find(|(command, said)| command.contains(" info") && answered(said))
        .and_then(|(_, said)| SIZE.captures(said));
    match size {
        Some(size) => {
            let bytes: f64 = size[2].parse().unwrap_or_default();
            parts.push(format!("{} CPUs", &size[1]));
            parts.push(format!("{:.1} GB memory", bytes / 1e9));
        }
        None if version.is_none() => parts.push("not answering".into()),
        None => {}
    }
    let disk_name = if engine[0].0.starts_with("podman") {
        "Podman"
    } else {
        "Docker"
    };
    let free = engine
        .iter()
        .find(|(command, said)| command.contains("--entrypoint df") && answered(said))
        .and_then(|(_, said)| free_bytes(said));
    let disk = match free {
        Some(bytes) => format!("{disk_name} disk: {:.1} GB free.", bytes as f64 / 1e9),
        None => format!("{disk_name} disk: free space not measured; see system df below."),
    };
    Some(format!("Container engine: {}. {disk}", parts.join(", ")))
}

/// The image to measure the engine's disk from: one already on this computer, so nothing is
/// downloaded (a download is what fails when that disk is full). OpenBot's own first, then
/// CopilotKit's, from `images --format {{.Repository}}:{{.Tag}}`.
pub fn probe_image(listing: &str) -> Option<String> {
    let images: Vec<&str> = listing
        .lines()
        .map(str::trim)
        .filter(|image| !image.is_empty() && !image.contains("<none>"))
        .collect();
    ["openbot", "copilotkit"].iter().find_map(|wanted| {
        images
            .iter()
            .find(|image| image.to_ascii_lowercase().contains(wanted))
            .map(|image| (*image).to_owned())
    })
}

/// `run` arguments that print the engine's disk as `df` sees it from inside a container, the way
/// the back end CLI's own capacity check does: never pulled, no network, removed after.
pub fn disk_probe_arguments(image: &str) -> Vec<String> {
    [
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        "--entrypoint",
        "df",
        image,
        "-Pk",
        "/",
    ]
    .map(str::to_owned)
    .to_vec()
}

/// The bytes free in POSIX `df -Pk` output: the Available column of its first filesystem line.
pub fn free_bytes(df: &str) -> Option<u64> {
    let line = df.lines().find(|line| {
        line.split_whitespace()
            .nth(3)
            .is_some_and(|available| available.parse::<u64>().is_ok())
    })?;
    let kilobytes: u64 = line.split_whitespace().nth(3)?.parse().ok()?;
    Some(kilobytes * 1024)
}

/// A named account identifier: `"organizationId":"org_…"`, `user_id=…`, `installationId: …`.
static IDENTIFIER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(?P<name>\b(?:organi[sz]ation|org|user|account|installation|install|tenant|workspace|team|customer|member|distinct)[_\-]?id)(?P<sep>["']?\s*[:=]\s*["']?)[^\s"'&,;}\]\)]+"#,
    )
    .expect("the identifier pattern compiles")
});

/// `logging::scrub`, then account identifiers as `[id]`.
pub fn redact<'a>(text: &'a str, home: Option<&str>) -> Cow<'a, str> {
    let scrubbed = crate::logging::scrub(text, home);
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

/// The engine commands that are cheap to answer and say what support asks for: its version, its
/// CPUs, memory and storage, and how much of its disk is used.
pub fn engine_commands(podman: bool) -> Vec<Vec<&'static str>> {
    if podman {
        vec![
            vec!["version", "--format", "{{.Server.Version}}"],
            vec![
                "info",
                "--format",
                "{{.Host.OS}} {{.Host.Arch}}, {{.Host.Cpus}} CPUs, {{.Host.MemTotal}} bytes memory, storage {{.Store.GraphDriverName}} at {{.Store.GraphRoot}}",
            ],
            vec!["system", "df"],
        ]
    } else {
        vec![
            vec!["version", "--format", "{{.Server.Version}}"],
            vec![
                "info",
                "--format",
                "{{.OperatingSystem}} {{.Architecture}}, {{.NCPU}} CPUs, {{.MemTotal}} bytes memory, storage {{.Driver}} at {{.DockerRootDir}}",
            ],
            vec!["system", "df"],
        ]
    }
}

/// Run a command for at most `timeout`, and say what it printed: its output, its error output when
/// it failed, or that it did not answer in time.
pub fn run_bounded(mut command: Command, timeout: Duration) -> String {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return format!("could not run: {error}"),
    };
    let until = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return format!("no answer within {}s", timeout.as_secs_f32());
            }
            Err(error) => return format!("could not wait for it: {error}"),
        }
    }
    match child.wait_with_output() {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_owned(),
        Ok(output) => format!(
            "failed ({}): {}",
            output.status,
            crate::quiet::said(&output.stderr).trim_end()
        ),
        Err(error) => format!("could not read it: {error}"),
    }
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

    /// Lines the CLI and the shell really write, each with something a third-party AI must not get.
    #[test]
    fn account_details_tokens_and_the_home_folder_are_redacted() {
        let token = format!(
            "eyJ{}.eyJ{}.{}",
            "hbGciOi".repeat(3),
            "zdWIiOi".repeat(3),
            "Sfl"
        );
        let key = format!("sk-ant-api03-{}", "Ab9_".repeat(12));
        let lines = [
            r#"2026-11-08T10:12:01.004Z info auth: signed in {"email":"alice.smith@example.com","organizationId":"org_2xK9pQ7vLm","userId":"user_31aZ"}"#.to_owned(),
            format!(r#"2026-11-08T10:12:01.010Z debug api: GET /v1/projects Authorization: Bearer {token}"#),
            format!("2026-11-08T10:12:03.551Z info license: ANTHROPIC_API_KEY={key}"),
            "2026-11-08T10:12:04.000Z info telemetry: installation_id=8c0f4a52-7e0b-4d1e-9a5f-3b2c1d0e9f8a".to_owned(),
            "2026-11-08T10:12:05.000Z info config: wrote /Users/alice/.copilotkit/project.json".to_owned(),
            r#"{"level":"info","msg":"project linked","accountId":"acct_77","orgId":"o-1"}"#.to_owned(),
        ];
        let text = lines.join("\n");
        let redacted = redact(&text, Some("/Users/alice"));
        for secret in [
            "alice.smith@example.com",
            "org_2xK9pQ7vLm",
            "user_31aZ",
            token.as_str(),
            key.as_str(),
            "8c0f4a52-7e0b-4d1e-9a5f-3b2c1d0e9f8a",
            "/Users/alice",
            "acct_77",
            "o-1",
        ] {
            assert!(!redacted.contains(secret), "{secret} survived:\n{redacted}");
        }
        assert!(redacted.contains(r#""email":"[email]","organizationId":"[id]","userId":"[id]""#));
        assert!(redacted.contains("installation_id=[id]"));
        assert!(redacted.contains("wrote ~/.copilotkit/project.json"));
        assert!(redacted.contains("ANTHROPIC_API_KEY=[redacted]"));
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
            "stack local-7f3a2c is starting",
        ] {
            assert_eq!(redact(line, Some("/Users/alice")), line);
        }
    }

    #[test]
    fn a_bundle_has_every_section_and_is_redacted() {
        let facts = Facts {
            desktop: "OpenBot Desktop 1.0.0 (Built 2026-11-08 06:40 UTC from 52ea4b5)".into(),
            system: "macos aarch64".into(),
            failure: Some("The back end could not start.\nexit 1".into()),
            engine: vec![(
                "docker version --format {{.Server.Version}}".into(),
                "27.3.1\n".into(),
            )],
            desktop_log: Some((
                PathBuf::from(
                    "/Users/alice/Library/Logs/ai.copilotkit.openbot.desktop/openbot-desktop.log",
                ),
                "2026-11-08T10:15:40.003Z ERROR [local setup] failed after 88.1s: exit 1\n".into(),
            )),
            cli_log: Some((
                PathBuf::from("/Users/alice/.copilotkit/cli.log"),
                r#"signed in {"email":"a@b.co","organizationId":"org_1"}"#.into(),
            )),
        };
        let text = bundle(&facts, Some("/Users/alice"));
        for expected in [
            "OpenBot Desktop 1.0.0 (Built",
            "System: macos aarch64",
            "## What failed\n\nThe back end could not start.\nexit 1\n",
            "$ docker version --format {{.Server.Version}}\n27.3.1\n",
            "~/Library/Logs/ai.copilotkit.openbot.desktop/openbot-desktop.log",
            "[local setup] failed after 88.1s: exit 1",
            "~/.copilotkit/cli.log",
            r#"{"email":"[email]","organizationId":"[id]"}"#,
        ] {
            assert!(text.contains(expected), "missing {expected:?} in\n{text}");
        }
        assert!(!text.contains("/Users/alice"));

        // The headline comes first, then what was taken out.
        assert!(text.starts_with(
            "# OpenBot troubleshooting logs\n\nSummary: OpenBot Desktop 1.0.0 (Built 2026-11-08 06:40 UTC from 52ea4b5) on macos aarch64.\nFailed: The back end could not start. / exit 1\nContainer engine: docker 27.3.1. Docker disk: free space not measured; see system df below.\n\nRedacted on this computer"
        ), "{text}");

        let empty = bundle(&Facts::default(), None);
        assert!(empty.contains("Nothing reported a failure."));
        assert!(empty.contains("No container engine is answering."));
        assert_eq!(empty.matches("Not found on this computer.").count(), 2);
    }

    #[test]
    fn the_summary_says_the_engines_size_or_that_it_did_not_answer() {
        let facts = Facts {
            engine: vec![
                ("docker version --format x".into(), "28.5.1".into()),
                (
                    "docker info --format y".into(),
                    "Docker Desktop aarch64, 8 CPUs, 8217473024 bytes memory, storage overlayfs at /var/lib/docker".into(),
                ),
                ("docker system df".into(), "no answer within 5s".into()),
            ],
            ..Facts::default()
        };
        assert!(summary(&facts).ends_with(
            "Container engine: docker 28.5.1, 8 CPUs, 8.2 GB memory. Docker disk: free space not measured; see system df below.\n"
        ));
        let silent = Facts {
            engine: vec![
                (
                    "podman version --format x".into(),
                    "no answer within 5s".into(),
                ),
                (
                    "podman info --format y".into(),
                    "failed (exit status: 125): boom".into(),
                ),
            ],
            ..Facts::default()
        };
        assert!(summary(&silent).contains("Container engine: podman, not answering."));
        assert!(!summary(&Facts::default()).contains("Failed:"));
    }

    /// The case this bundle has to make obvious: CPUs and memory fine, the engine's disk full.
    #[test]
    fn a_full_engine_disk_is_in_the_summary() {
        let df = "Filesystem     1024-blocks      Used Available Capacity Mounted on\noverlay           61255492  61255492         0     100% /\n";
        let facts = Facts {
            engine: vec![
                ("docker version --format x".into(), "28.5.1".into()),
                ("docker info --format y".into(), "Docker Desktop aarch64, 8 CPUs, 8217473024 bytes memory, storage overlayfs at /var/lib/docker".into()),
                (format!("docker {}", disk_probe_arguments("ghcr.io/copilotkit/openbot-server:1.0.0").join(" ")), df.into()),
            ],
            ..Facts::default()
        };
        assert!(summary(&facts).ends_with(
            "Container engine: docker 28.5.1, 8 CPUs, 8.2 GB memory. Docker disk: 0.0 GB free.\n"
        ), "{}", summary(&facts));
        assert_eq!(free_bytes("Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 100 40 60 40% /"), Some(60 * 1024));
        assert_eq!(free_bytes("no such image"), None);
        // A probe that failed (no image, a refused run) leaves it unmeasured.
        let failed = Facts {
            engine: vec![(
                "docker run --rm --pull never x df -Pk /".into(),
                "failed (exit status: 125): No such image".into(),
            )],
            ..Facts::default()
        };
        assert!(summary(&failed).contains("Docker disk: free space not measured"));
    }

    #[test]
    fn the_disk_is_measured_from_an_image_already_here_and_never_pulled() {
        let listing = "postgres:16\n<none>:<none>\nghcr.io/copilotkit/intelligence-cli:0.16.0\nghcr.io/copilotkit/openbot-server:1.0.0-rc.3\n";
        assert_eq!(
            probe_image(listing).as_deref(),
            Some("ghcr.io/copilotkit/openbot-server:1.0.0-rc.3")
        );
        assert_eq!(
            probe_image("ghcr.io/copilotkit/intelligence-cli:0.16.0\n").as_deref(),
            Some("ghcr.io/copilotkit/intelligence-cli:0.16.0")
        );
        assert_eq!(probe_image("postgres:16\nredis:7\n"), None);
        let arguments = disk_probe_arguments("img:1");
        assert!(arguments.windows(2).any(|pair| pair == ["--pull", "never"]));
        assert!(arguments
            .windows(2)
            .any(|pair| pair == ["--network", "none"]));
        assert!(arguments.contains(&"--rm".to_owned()));
        assert!(arguments.ends_with(&["img:1".to_owned(), "-Pk".to_owned(), "/".to_owned()]));
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

    #[test]
    fn a_tail_starts_at_a_whole_line() {
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
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn the_cli_log_is_under_the_home_folder_on_every_platform() {
        assert_eq!(
            cli_log(Path::new("/Users/alice")),
            Path::new("/Users/alice/.copilotkit/cli.log")
        );
        assert_eq!(
            cli_log(Path::new(r"C:\Users\alice")),
            Path::new(r"C:\Users\alice")
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

    #[cfg(unix)]
    #[test]
    fn an_engine_command_that_hangs_is_cut_off() {
        let mut slow = Command::new("sh");
        slow.args(["-c", "sleep 5"]);
        assert_eq!(
            run_bounded(slow, Duration::from_millis(200)),
            "no answer within 0.2s"
        );
        let mut fails = Command::new("sh");
        fails.args([
            "-c",
            "echo 'Cannot connect to the Docker daemon' >&2; exit 1",
        ]);
        let said = run_bounded(fails, ENGINE_TIMEOUT);
        assert!(said.starts_with("failed ("), "{said}");
        assert!(
            said.contains("Cannot connect to the Docker daemon"),
            "{said}"
        );
        let mut answers = Command::new("sh");
        answers.args(["-c", "echo 27.3.1"]);
        assert_eq!(run_bounded(answers, ENGINE_TIMEOUT), "27.3.1");
    }
}
