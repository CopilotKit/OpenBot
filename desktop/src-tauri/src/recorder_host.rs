//! The native messaging host the Recorder extension talks to.
//!
//! Chrome, Edge and Chromium start OpenBot Desktop's own binary as the host. Its first argument is
//! the caller's origin, and on Windows a `--parent-window=<n>` argument follows. Each message, both
//! ways, is UTF-8 JSON preceded by its length as a 32-bit integer in native byte order; a message
//! from the host may be at most 1 MB. The browser closes the host's stdin when it is done with it.
//! <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
//!
//! The host answers three messages, each within its own deadline ([`DEADLINES`]), which sits below the time the
//! extension waits for the answer, so the extension always hears why instead of giving up.
//!
//! `ping` says, cheaply, whether a connect would work now: an OpenBot is installed, its app answers on its port, and in
//! organization mode Desktop holds a sign-in for the organization. It reads two files and asks the app one question. It
//! does not prove which process answers, sends nothing secret and mints nothing.
//!
//! `handoff` makes sure the deployment's own processes hold its ports, hands the organization sign-in over in
//! organization mode, asks that OpenBot for a one-time connect code and returns it with the OpenBot's address, so the
//! Recorder can connect without the person typing either.
//!
//! `address` says which address this computer's OpenBot answers on, after the same ownership checks a handoff makes, and
//! mints nothing. The Recorder takes a connect from a page with no Connect click only when the page's origin is exactly
//! this address: any other program on this computer can serve a page on a loopback port, and only the host knows which
//! one is OpenBot Desktop's.
//!
//! Every reply carries `ok`. `ok: false` comes with `error`, one of the stable codes of [`Refusal`]. Neither a code nor
//! any cookie is ever written to a log.
use crate::recorder_install::{allowed_origins, linux_config_dir, Os};
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

/// Tauri's bundle identifier for OpenBot Desktop (`tauri.conf.json` `identifier`).
const APP_IDENTIFIER: &str = "ai.copilotkit.openbot.desktop";

/// The largest message either way. Chrome refuses a host message over 1 MB, and the extension sends
/// only a few bytes, so a longer length prefix is a broken or hostile pipe.
const MESSAGE_LIMIT: usize = 1024 * 1024;

/// Why the host could not do what it was asked: the `error` of a reply with `ok: false`. The extension shows each one,
/// so a code never changes its meaning.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// `origin-not-allowed`: the caller is not the Recorder's own extension, under its fixed id or a store's.
    OriginNotAllowed,
    /// `not-installed`: OpenBot Desktop has not set up an OpenBot on this computer.
    NotInstalled,
    /// `not-running`: this computer's OpenBot is not running, its app does not answer, or a process that is not this
    /// OpenBot's holds its port.
    NotRunning,
    /// `not-signed-in`: organization mode, and Desktop holds no sign-in for the organization, or the organization or
    /// the local OpenBot refused the one it holds. Signing in again in OpenBot Desktop fixes it.
    NotSignedIn,
    /// `organization-unavailable`: organization mode, and the sign-in Desktop holds could not be handed over now: the
    /// organization's OpenBot did not answer, or answered with an error, or the saved sign-in could not be read. Trying
    /// again later may work.
    OrganizationUnavailable,
    /// `handoff-failed`: the local OpenBot answered the request for a connect code without one.
    HandoffFailed,
    /// `timed-out`: the host did not finish within its deadline.
    TimedOut,
    /// `host-failed`: the host stopped before it could answer. A bug in OpenBot Desktop.
    HostFailed,
    /// `unknown-message`: a message the host does not know.
    UnknownMessage,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::OriginNotAllowed => "origin-not-allowed",
            Refusal::NotInstalled => "not-installed",
            Refusal::NotRunning => "not-running",
            Refusal::NotSignedIn => "not-signed-in",
            Refusal::OrganizationUnavailable => "organization-unavailable",
            Refusal::HandoffFailed => "handoff-failed",
            Refusal::TimedOut => "timed-out",
            Refusal::HostFailed => "host-failed",
            Refusal::UnknownMessage => "unknown-message",
        }
    }
}

/// One question main.rs answers about this computer's OpenBot. Asked from the host's worker thread.
pub type Check<T> = Box<dyn Fn() -> T + Send + Sync>;

/// The local organization session cookie for the app at the given address. Ok(None) in single-user mode.
pub type OrganizationCookie = Box<dyn Fn(&str) -> Result<Option<String>, Refusal> + Send + Sync>;

/// What main.rs knows about this computer's OpenBot.
pub struct HostEnvironment {
    /// A selected root exists.
    pub installed: Check<bool>,
    /// For a ping: the app answers on its port. Quick, and not proof of which process answered.
    pub app_answers: Check<bool>,
    /// For a ping: Ok in single-user mode or when Desktop holds an organization sign-in, read without the network.
    pub signed_in: Check<Result<(), Refusal>>,
    /// For a handoff: the owned app's address, None when it is not running or another process holds its port.
    pub app_url: Check<Option<String>>,
    /// For a handoff: the organization sign-in handed to the local OpenBot, as its session cookie.
    pub organization_cookie: OrganizationCookie,
}

/// How long the host gives each message before it answers `timed-out`.
#[derive(Clone, Copy, Debug)]
pub struct Deadlines {
    pub ping: Duration,
    pub handoff: Duration,
    pub address: Duration,
}

/// The extension waits 3 s for a ping and 8 s for a handoff, counted from when it asks Chrome, so the time Chrome takes
/// to start this binary comes out of the same budget. Timed on an Apple M5 Max, from starting a release build to its
/// reply: a ping about 3 ms (the earlier ping, which ran the handoff's ownership checks, about 175 ms), and a handoff
/// about 175 ms in either mode, nearly all of it the two `lsof` ownership checks of about 80 ms each. The first start
/// of a freshly built binary took about 0.5 s. On Windows those ownership checks run PowerShell and netstat, twice (not
/// timed here), and only the handoff and the address run them. Each deadline leaves a second of the extension's wait for
/// a slow start. The address runs the handoff's ownership checks without its request for a code, so it has the
/// handoff's deadline, and the extension waits 8 s for it too.
pub const DEADLINES: Deadlines = Deadlines {
    ping: Duration::from_millis(2_000),
    handoff: Duration::from_millis(7_000),
    address: Duration::from_millis(7_000),
};

/// How long a ping waits for the app on each loopback. A running app answers in milliseconds, and a closed port is
/// refused at once; this bounds a port held by something that accepts and never answers, twice within the deadline.
pub const PING_PROBE_PATIENCE: Duration = Duration::from_millis(750);

/// Only the Recorder may ask, under its own fixed id or an id a store gave it, in debug and release builds alike: the
/// origins the manifests allow (`recorder_install::allowed_origins`), so the browser and the host agree.
fn origin_allowed(origin: &str) -> bool {
    allowed_origins().iter().any(|allowed| allowed == origin)
}

/// [`origin_allowed`] for the store ids given.
#[cfg(test)]
fn origin_allowed_with(origin: &str, store: &crate::recorder_install::StoreIds) -> bool {
    crate::recorder_install::allowed_origins_with(store)
        .iter()
        .any(|allowed| allowed == origin)
}

/// An extension origin as Chrome passes it: `chrome-extension://` and an id of 32 letters a to p.
fn is_extension_origin(value: &str) -> bool {
    value
        .strip_prefix("chrome-extension://")
        .and_then(|rest| rest.strip_suffix('/'))
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte)))
}

/// Chrome starts a host with the caller's origin as the first argument ("chrome-extension://<id>/"),
/// and on Windows also "--parent-window=<n>".
pub fn caller_origin(args: &[OsString]) -> Option<String> {
    let first = args.get(1)?.to_str()?;
    is_extension_origin(first).then(|| first.to_string())
}

/// Reads one native-endian u32 length-prefixed JSON message; refuses messages over 1 MiB.
/// Ok(None) when the input closed cleanly before a new message began.
pub fn read_message(input: &mut impl Read) -> io::Result<Option<Value>> {
    let mut prefix = [0u8; 4];
    let mut filled = 0;
    while filled < prefix.len() {
        match input.read(&mut prefix[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => {
                return Err(io::Error::new(
                    ErrorKind::UnexpectedEof,
                    "the input closed inside a length prefix",
                ))
            }
            Ok(read) => filled += read,
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    let length = u32::from_ne_bytes(prefix) as usize;
    if length > MESSAGE_LIMIT {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            format!("a {length} byte message is over the 1 MiB limit"),
        ));
    }
    let mut body = vec![0; length];
    input.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))
}

/// Writes one native-endian u32 length-prefixed JSON message; refuses, writing nothing, one over 1 MiB.
pub fn write_message(output: &mut impl Write, value: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(value)?;
    if body.len() > MESSAGE_LIMIT {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            format!("a {} byte message is over the 1 MiB limit", body.len()),
        ));
    }
    output.write_all(&(body.len() as u32).to_ne_bytes())?;
    output.write_all(&body)?;
    output.flush()
}

/// Tauri 2's app_config_dir for ai.copilotkit.openbot.desktop, derived without an AppHandle:
/// macOS ~/Library/Application Support/<id>, Linux $XDG_CONFIG_HOME/<id> or ~/.config/<id>, Windows %APPDATA%\<id>.
///
/// Tauri joins its identifier to the `dirs` crate's `config_dir`, which on Linux takes
/// `$XDG_CONFIG_HOME` only when it is an absolute path.
pub fn app_config_dir(
    os: Os,
    home: &Path,
    xdg_config_home: Option<&Path>,
    app_data: Option<&Path>,
) -> PathBuf {
    let config = match os {
        Os::Mac => home.join("Library").join("Application Support"),
        Os::Linux => linux_config_dir(home, xdg_config_home),
        Os::Windows => app_data
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join("AppData").join("Roaming")),
    };
    config.join(APP_IDENTIFIER)
}

fn refused(refusal: Refusal) -> Value {
    json!({ "ok": false, "error": refusal.code() })
}

fn ping_reply(result: Result<(), Refusal>) -> Value {
    match result {
        Ok(()) => json!({ "ok": true, "available": true }),
        Err(refusal) => json!({ "ok": false, "available": false, "error": refusal.code() }),
    }
}

fn ping(origin_allowed: bool, env: &HostEnvironment) -> Result<(), Refusal> {
    if !origin_allowed {
        return Err(Refusal::OriginNotAllowed);
    }
    if !(env.installed)() {
        return Err(Refusal::NotInstalled);
    }
    if !(env.app_answers)() {
        return Err(Refusal::NotRunning);
    }
    (env.signed_in)()
}

/// The address this computer's OpenBot answers on, once its own processes are proved to hold its ports (`app_url`). It
/// sends nothing to the app beyond those checks, and mints nothing.
fn address(origin_allowed: bool, env: &HostEnvironment) -> Result<String, Refusal> {
    if !origin_allowed {
        return Err(Refusal::OriginNotAllowed);
    }
    if !(env.installed)() {
        return Err(Refusal::NotInstalled);
    }
    (env.app_url)().ok_or(Refusal::NotRunning)
}

fn handoff(
    origin_allowed: bool,
    env: &HostEnvironment,
    client: &Client,
) -> Result<(String, String), Refusal> {
    if !origin_allowed {
        return Err(Refusal::OriginNotAllowed);
    }
    if !(env.installed)() {
        return Err(Refusal::NotInstalled);
    }
    let app_url = (env.app_url)().ok_or(Refusal::NotRunning)?;
    let cookie = (env.organization_cookie)(&app_url)?;
    let mut request = client
        .post(format!(
            "{}/api/recorder/connect-codes",
            app_url.trim_end_matches('/')
        ))
        .json(&json!({ "via": "desktop" }));
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    let response = request.send().map_err(|error| {
        eprintln!("[recorder-host] the local OpenBot did not answer the handoff");
        if error.is_timeout() {
            Refusal::TimedOut
        } else {
            Refusal::NotRunning
        }
    })?;
    let status = response.status();
    if status != reqwest::StatusCode::CREATED {
        eprintln!("[recorder-host] the local OpenBot answered the handoff with {status}");
        return Err(
            if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN
            {
                Refusal::NotSignedIn
            } else {
                Refusal::HandoffFailed
            },
        );
    }
    match response
        .json::<Value>()
        .ok()
        .and_then(|minted| minted.get("code")?.as_str().map(str::to_string))
    {
        Some(code) if !code.is_empty() => Ok((app_url, code)),
        _ => {
            eprintln!("[recorder-host] the local OpenBot answered the handoff without a code");
            Err(Refusal::HandoffFailed)
        }
    }
}

/// Answers one message, however long that takes. Only "handoff" mints anything.
fn handle(message: &Value, origin_allowed: bool, env: &HostEnvironment, client: &Client) -> Value {
    match message.get("type").and_then(Value::as_str) {
        Some("ping") => ping_reply(ping(origin_allowed, env)),
        Some("handoff") => match handoff(origin_allowed, env, client) {
            Ok((app_url, code)) => json!({ "ok": true, "openbotUrl": app_url, "code": code }),
            Err(refusal) => refused(refusal),
        },
        Some("address") => match address(origin_allowed, env) {
            Ok(app_url) => json!({ "ok": true, "openbotUrl": app_url }),
            Err(refusal) => refused(refusal),
        },
        _ => refused(Refusal::UnknownMessage),
    }
}

/// Answers one message within its deadline. The work runs on its own thread; one still running at the deadline is left
/// to finish unheard, and the process exits under it once the input closes.
fn answer(
    message: Value,
    origin_allowed: bool,
    env: &Arc<HostEnvironment>,
    client: &Client,
    deadlines: Deadlines,
) -> Value {
    let (kind, deadline) = match message.get("type").and_then(Value::as_str) {
        Some("ping") => ("ping", deadlines.ping),
        Some("handoff") => ("handoff", deadlines.handoff),
        Some("address") => ("address", deadlines.address),
        _ => return refused(Refusal::UnknownMessage),
    };
    let failed = |refusal| {
        if kind == "ping" {
            ping_reply(Err(refusal))
        } else {
            refused(refusal)
        }
    };
    let (sender, receiver) = mpsc::channel();
    let (env, client) = (Arc::clone(env), client.clone());
    let worker = std::thread::Builder::new().spawn(move || {
        let _ = sender.send(handle(&message, origin_allowed, &env, &client));
    });
    if let Err(error) = worker {
        eprintln!("[recorder-host] could not start answering a {kind}: {error}");
        return failed(Refusal::HostFailed);
    }
    match receiver.recv_timeout(deadline) {
        Ok(reply) => reply,
        Err(RecvTimeoutError::Timeout) => {
            eprintln!("[recorder-host] a {kind} was not answered within {deadline:?}");
            failed(Refusal::TimedOut)
        }
        Err(RecvTimeoutError::Disconnected) => {
            eprintln!("[recorder-host] a {kind} stopped before it was answered");
            failed(Refusal::HostFailed)
        }
    }
}

/// The handoff's request for a connect code. The local OpenBot is on this computer; the deadline answers first if it
/// is slow, and this only stops the abandoned request.
fn client() -> reqwest::Result<Client> {
    Client::builder()
        .timeout(DEADLINES.handoff)
        .redirect(reqwest::redirect::Policy::none())
        .build()
}

/// Answers each message until the input closes (0), or until a message cannot be read or answered (1).
fn serve(
    input: &mut impl Read,
    output: &mut impl Write,
    origin_allowed: bool,
    env: &Arc<HostEnvironment>,
    client: &Client,
    deadlines: Deadlines,
) -> i32 {
    loop {
        let message = match read_message(input) {
            Ok(Some(message)) => message,
            Ok(None) => return 0,
            Err(error) => {
                eprintln!("[recorder-host] could not read a message: {error}");
                return 1;
            }
        };
        let reply = answer(message, origin_allowed, env, client, deadlines);
        if let Err(error) = write_message(output, &reply) {
            eprintln!("[recorder-host] could not answer a message: {error}");
            return 1;
        }
    }
}

/// Runs the host until stdin closes. Returns the process exit code. `origin_allowed` is true only for
/// "chrome-extension://<id>/" with the Recorder's fixed id or one of its store ids (shared/recorder-extension.json), in
/// every build.
pub fn run(origin: &str, env: HostEnvironment) -> i32 {
    let client = match client() {
        Ok(client) => client,
        Err(error) => {
            eprintln!("[recorder-host] could not prepare its HTTP client: {error}");
            return 1;
        }
    };
    serve(
        &mut io::stdin().lock(),
        &mut io::stdout().lock(),
        origin_allowed(origin),
        &Arc::new(env),
        &client,
        DEADLINES,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::ffi::OsString;
    use std::io::{BufRead, BufReader, Cursor, ErrorKind, Read, Write};
    use std::net::TcpListener;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::time::Instant;

    const ID: &str = "icpcnhgjghecmklnjbccdgdicklblcgd";
    const DESKTOP: &str = "ai.copilotkit.openbot.desktop";

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    fn framed(value: &Value) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_message(&mut bytes, value).unwrap();
        bytes
    }

    fn fixed_origin() -> String {
        format!("chrome-extension://{ID}/")
    }

    #[test]
    fn only_the_shared_files_origin_is_allowed() {
        assert_eq!(crate::recorder_install::extension_origin(), fixed_origin());
        assert!(origin_allowed(&fixed_origin()));
        assert!(!origin_allowed(&format!(
            "chrome-extension://{}/",
            "p".repeat(32)
        )));
        assert!(!origin_allowed(&format!("chrome-extension://{ID}")));
        assert!(!origin_allowed(""));
    }

    #[test]
    fn a_recorder_added_from_a_store_is_let_in_under_the_id_the_store_gave_it() {
        use crate::recorder_install::StoreIds;
        let edge = "ponmlkjihgfedcbaponmlkjihgfedcba";
        let chrome = "abcdefghijklmnopabcdefghijklmnop";
        let store = StoreIds {
            chrome: Some(chrome.into()),
            edge: Some(edge.into()),
        };
        for id in [ID, chrome, edge] {
            assert!(
                origin_allowed_with(&format!("chrome-extension://{id}/"), &store),
                "{id}"
            );
        }
        assert!(!origin_allowed_with(
            &format!("chrome-extension://{}/", "p".repeat(32)),
            &store
        ));
        assert!(!origin_allowed_with(
            &format!("chrome-extension://{edge}"),
            &store
        ));
        // Before publication the store ids are empty, and only the fixed id is let in.
        assert!(!origin_allowed_with(
            &format!("chrome-extension://{edge}/"),
            &StoreIds::default()
        ));
        assert!(origin_allowed_with(&fixed_origin(), &StoreIds::default()));
    }

    #[test]
    fn a_message_round_trips_with_a_native_endian_length_prefix() {
        let ping = json!({ "type": "ping" });
        let bytes = framed(&ping);
        let body = ping.to_string();
        assert_eq!(&bytes[..4], &(body.len() as u32).to_ne_bytes());
        assert_eq!(&bytes[4..], body.as_bytes());
        let handoff = json!({ "type": "handoff" });
        let mut input = Cursor::new([bytes, framed(&handoff)].concat());
        assert_eq!(read_message(&mut input).unwrap(), Some(ping));
        assert_eq!(read_message(&mut input).unwrap(), Some(handoff));
        assert_eq!(read_message(&mut input).unwrap(), None);
    }

    #[test]
    fn a_two_mebibyte_length_prefix_is_refused_without_reading_the_body() {
        let mut input = Cursor::new((2 * 1024 * 1024u32).to_ne_bytes().to_vec());
        let error = read_message(&mut input).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidData);
        assert_eq!(input.position(), 4);
    }

    #[test]
    fn one_mebibyte_is_the_largest_message_either_way() {
        let largest = Value::String("a".repeat(1024 * 1024 - 2));
        let bytes = framed(&largest);
        assert_eq!(bytes.len(), 4 + 1024 * 1024);
        assert_eq!(
            read_message(&mut Cursor::new(bytes)).unwrap(),
            Some(largest)
        );
        let over = (1024 * 1024 + 1u32).to_ne_bytes().to_vec();
        assert_eq!(
            read_message(&mut Cursor::new(over)).unwrap_err().kind(),
            ErrorKind::InvalidData
        );
        let mut sink = Vec::new();
        let too_big = Value::String("a".repeat(1024 * 1024 - 1));
        assert_eq!(
            write_message(&mut sink, &too_big).unwrap_err().kind(),
            ErrorKind::InvalidInput
        );
        assert!(sink.is_empty());
    }

    #[test]
    fn a_cut_short_or_malformed_message_is_an_error() {
        assert_eq!(
            read_message(&mut Cursor::new(vec![3u8, 0]))
                .unwrap_err()
                .kind(),
            ErrorKind::UnexpectedEof
        );
        let mut short_body = 10u32.to_ne_bytes().to_vec();
        short_body.extend_from_slice(b"{}");
        assert_eq!(
            read_message(&mut Cursor::new(short_body))
                .unwrap_err()
                .kind(),
            ErrorKind::UnexpectedEof
        );
        let mut not_json = 3u32.to_ne_bytes().to_vec();
        not_json.extend_from_slice(b"{{{");
        assert_eq!(
            read_message(&mut Cursor::new(not_json)).unwrap_err().kind(),
            ErrorKind::InvalidData
        );
    }

    #[test]
    fn the_caller_origin_is_the_first_argument_with_or_without_the_parent_window() {
        let origin = fixed_origin();
        assert_eq!(
            caller_origin(&args(&["openbot-desktop", &origin])),
            Some(origin.clone())
        );
        assert_eq!(
            caller_origin(&args(&[
                "openbot-desktop.exe",
                &origin,
                "--parent-window=0"
            ])),
            Some(origin.clone())
        );
        let other = format!("chrome-extension://{}/", "p".repeat(32));
        assert_eq!(
            caller_origin(&args(&["openbot-desktop", &other])),
            Some(other)
        );
    }

    #[test]
    fn anything_else_first_is_not_a_native_host_launch() {
        let origin = fixed_origin();
        let refused = [
            vec!["openbot-desktop".to_string()],
            vec!["openbot-desktop".into(), "--install-recorder-host".into()],
            vec![
                "openbot-desktop".into(),
                "--parent-window=0".into(),
                origin.clone(),
            ],
            vec!["openbot-desktop".into(), format!("chrome-extension://{ID}")],
            vec![
                "openbot-desktop".into(),
                format!("chrome-extension://{}/", "a".repeat(31)),
            ],
            vec![
                "openbot-desktop".into(),
                format!("chrome-extension://{}/", "a".repeat(33)),
            ],
            vec![
                "openbot-desktop".into(),
                format!("chrome-extension://{}/", "q".repeat(32)),
            ],
            vec![
                "openbot-desktop".into(),
                format!("chrome-extension://{}/", ID.to_uppercase()),
            ],
            vec![
                "openbot-desktop".into(),
                format!("chrome-extension://{ID}/path"),
            ],
            vec!["openbot-desktop".into(), format!("moz-extension://{ID}/")],
            vec!["openbot-desktop".into(), "https://openbot.example/".into()],
        ];
        for list in refused {
            let list: Vec<&str> = list.iter().map(String::as_str).collect();
            assert_eq!(caller_origin(&args(&list)), None, "{list:?}");
        }
    }

    #[test]
    fn app_config_dir_matches_tauri_on_each_os() {
        let home = Path::new("/home/a");
        let mac = home
            .join("Library")
            .join("Application Support")
            .join(DESKTOP);
        assert_eq!(app_config_dir(Os::Mac, home, None, None), mac);
        let roaming = Path::new("C:\\Users\\a\\AppData\\Roaming");
        assert_eq!(
            app_config_dir(Os::Mac, home, Some(Path::new("/xdg")), Some(roaming)),
            mac
        );
        let dot_config = home.join(".config").join(DESKTOP);
        assert_eq!(app_config_dir(Os::Linux, home, None, None), dot_config);
        assert_eq!(
            app_config_dir(Os::Linux, home, Some(Path::new("/xdg")), None),
            Path::new("/xdg").join(DESKTOP)
        );
        for ignored in ["", "relative/config"] {
            assert_eq!(
                app_config_dir(Os::Linux, home, Some(Path::new(ignored)), None),
                dot_config,
                "{ignored:?}"
            );
        }
        assert_eq!(
            app_config_dir(Os::Windows, home, Some(Path::new("/xdg")), Some(roaming)),
            roaming.join(DESKTOP)
        );
        assert_eq!(
            app_config_dir(Os::Windows, home, None, None),
            home.join("AppData").join("Roaming").join(DESKTOP)
        );
    }

    #[test]
    fn the_app_identifier_is_the_one_tauri_uses() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], DESKTOP);
    }

    /// What the host asked of the environment: each deep check it ran, and the addresses it asked a cookie for.
    #[derive(Default)]
    struct Asked {
        app_answers: AtomicUsize,
        signed_in: AtomicUsize,
        app_url: AtomicUsize,
        cookies: Mutex<Vec<String>>,
    }

    impl Asked {
        fn cookies(&self) -> Vec<String> {
            self.cookies.lock().unwrap().clone()
        }
    }

    /// A computer's OpenBot as a test describes it.
    struct Computer {
        installed: bool,
        app_url: Option<String>,
        signed_in: Result<(), Refusal>,
        cookie: Result<Option<String>, Refusal>,
    }

    /// Installed, running at `app_url`, single-user mode.
    fn running(app_url: &str) -> Computer {
        Computer {
            installed: true,
            app_url: Some(app_url.to_string()),
            signed_in: Ok(()),
            cookie: Ok(None),
        }
    }

    fn environment(computer: Computer) -> (Arc<HostEnvironment>, Arc<Asked>) {
        let asked = Arc::new(Asked::default());
        let (a, b, c, d) = (asked.clone(), asked.clone(), asked.clone(), asked.clone());
        let Computer {
            installed,
            app_url,
            signed_in,
            cookie,
        } = computer;
        let answers = app_url.is_some();
        let environment = HostEnvironment {
            installed: Box::new(move || installed),
            app_answers: Box::new(move || {
                a.app_answers.fetch_add(1, Ordering::SeqCst);
                answers
            }),
            signed_in: Box::new(move || {
                b.signed_in.fetch_add(1, Ordering::SeqCst);
                signed_in
            }),
            app_url: Box::new(move || {
                c.app_url.fetch_add(1, Ordering::SeqCst);
                app_url.clone()
            }),
            organization_cookie: Box::new(move |url| {
                d.cookies.lock().unwrap().push(url.to_string());
                cookie.clone()
            }),
        };
        (Arc::new(environment), asked)
    }

    fn fake_app() -> (String, TcpListener) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        (
            format!("http://{}", listener.local_addr().unwrap()),
            listener,
        )
    }

    /// The fake app was never dialled: nothing waits in its accept queue.
    fn assert_untouched(listener: &TcpListener) {
        listener.set_nonblocking(true).unwrap();
        match listener.accept() {
            Err(error) => assert_eq!(error.kind(), ErrorKind::WouldBlock),
            Ok((_, peer)) => panic!("the fake app was dialled from {peer}"),
        }
    }

    /// Answers one request with `reply` and hands back its head and body.
    fn answer_once(
        listener: TcpListener,
        reply: String,
    ) -> std::thread::JoinHandle<(String, String)> {
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            let mut length = 0;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
                head.push_str(&line);
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            stream.write_all(reply.as_bytes()).unwrap();
            (head, String::from_utf8(body).unwrap())
        })
    }

    fn reply(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    const MINTED: &str = r#"{"code":"obc_fixture","expiresAt":"2026-10-18T12:00:00.000Z"}"#;

    fn ask(message: Value, origin_allowed: bool, environment: &HostEnvironment) -> Value {
        handle(&message, origin_allowed, environment, &client().unwrap())
    }

    fn not(code: &str) -> Value {
        json!({ "ok": false, "error": code })
    }

    fn unavailable(code: &str) -> Value {
        json!({ "ok": false, "available": false, "error": code })
    }

    #[test]
    fn every_code_is_stable() {
        let codes: Vec<&str> = [
            Refusal::OriginNotAllowed,
            Refusal::NotInstalled,
            Refusal::NotRunning,
            Refusal::NotSignedIn,
            Refusal::OrganizationUnavailable,
            Refusal::HandoffFailed,
            Refusal::TimedOut,
            Refusal::HostFailed,
            Refusal::UnknownMessage,
        ]
        .into_iter()
        .map(Refusal::code)
        .collect();
        assert_eq!(
            codes,
            [
                "origin-not-allowed",
                "not-installed",
                "not-running",
                "not-signed-in",
                "organization-unavailable",
                "handoff-failed",
                "timed-out",
                "host-failed",
                "unknown-message",
            ]
        );
    }

    #[test]
    fn ping_answers_available_without_the_deep_checks_and_mints_nothing() {
        let (url, listener) = fake_app();
        let (environment, asked) = environment(running(&url));
        assert_eq!(
            ask(json!({ "type": "ping" }), true, &environment),
            json!({ "ok": true, "available": true })
        );
        assert_untouched(&listener);
        assert_eq!(asked.app_answers.load(Ordering::SeqCst), 1);
        assert_eq!(asked.signed_in.load(Ordering::SeqCst), 1);
        // Neither the ownership check behind `app_url` nor the organization handover runs for a ping.
        assert_eq!(asked.app_url.load(Ordering::SeqCst), 0);
        assert!(asked.cookies().is_empty());
    }

    #[test]
    fn ping_says_why_a_connect_would_not_work() {
        let (url, listener) = fake_app();
        let cases = [
            (false, running(&url), "origin-not-allowed"),
            (
                true,
                Computer {
                    installed: false,
                    ..running(&url)
                },
                "not-installed",
            ),
            (
                true,
                Computer {
                    app_url: None,
                    ..running(&url)
                },
                "not-running",
            ),
            (
                true,
                Computer {
                    signed_in: Err(Refusal::NotSignedIn),
                    ..running(&url)
                },
                "not-signed-in",
            ),
            (
                true,
                Computer {
                    signed_in: Err(Refusal::OrganizationUnavailable),
                    ..running(&url)
                },
                "organization-unavailable",
            ),
        ];
        for (origin_allowed, computer, code) in cases {
            let (environment, asked) = environment(computer);
            assert_eq!(
                ask(json!({ "type": "ping" }), origin_allowed, &environment),
                unavailable(code)
            );
            assert_eq!(asked.app_url.load(Ordering::SeqCst), 0, "{code}");
            assert!(asked.cookies().is_empty(), "{code}");
        }
        assert_untouched(&listener);
    }

    #[test]
    fn handoff_in_single_user_mode_returns_the_app_url_and_a_fresh_code() {
        let (url, listener) = fake_app();
        let app = answer_once(listener, reply("201 Created", MINTED));
        let (environment, asked) = environment(running(&url));
        assert_eq!(
            ask(json!({ "type": "handoff" }), true, &environment),
            json!({ "ok": true, "openbotUrl": url, "code": "obc_fixture" })
        );
        let (head, body) = app.join().unwrap();
        assert!(head.starts_with("POST /api/recorder/connect-codes HTTP/1.1\r\n"));
        let head = head.to_lowercase();
        assert!(head.contains("content-type: application/json\r\n"));
        assert!(!head.contains("cookie:"));
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({ "via": "desktop" })
        );
        assert_eq!(asked.cookies(), vec![url]);
        assert_eq!(asked.app_url.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn handoff_in_organization_mode_sends_the_local_session_cookie() {
        let (url, listener) = fake_app();
        let app = answer_once(listener, reply("201 Created", MINTED));
        let (environment, asked) = environment(Computer {
            cookie: Ok(Some("openbot.organization-session=v".into())),
            ..running(&url)
        });
        assert_eq!(
            ask(json!({ "type": "handoff" }), true, &environment),
            json!({ "ok": true, "openbotUrl": url, "code": "obc_fixture" })
        );
        let (head, _) = app.join().unwrap();
        assert!(head
            .to_lowercase()
            .contains("cookie: openbot.organization-session=v\r\n"));
        assert_eq!(asked.cookies(), vec![url]);
    }

    #[test]
    fn handoff_is_not_running_when_nothing_listens() {
        let (url, listener) = fake_app();
        drop(listener);
        let (environment, _) = environment(running(&url));
        assert_eq!(
            ask(json!({ "type": "handoff" }), true, &environment),
            not("not-running")
        );
    }

    #[test]
    fn handoff_says_what_the_local_openbot_answered_in_place_of_a_code() {
        for (answer, code) in [
            (
                reply("401 Unauthorized", r#"{"error":"Sign in."}"#),
                "not-signed-in",
            ),
            (reply("403 Forbidden", "{}"), "not-signed-in"),
            (reply("500 Internal Server Error", "{}"), "handoff-failed"),
            (reply("429 Too Many Requests", "{}"), "handoff-failed"),
            (reply("200 OK", MINTED), "handoff-failed"),
            (reply("201 Created", "{}"), "handoff-failed"),
            (reply("201 Created", r#"{"code":""}"#), "handoff-failed"),
            (reply("201 Created", "not json"), "handoff-failed"),
        ] {
            let (url, listener) = fake_app();
            let app = answer_once(listener, answer.clone());
            let (environment, _) = environment(running(&url));
            assert_eq!(
                ask(json!({ "type": "handoff" }), true, &environment),
                not(code),
                "{answer}"
            );
            app.join().unwrap();
        }
    }

    #[test]
    fn a_handoff_request_that_runs_out_of_time_is_timed_out() {
        let (url, listener) = fake_app();
        // Accepts, and never answers.
        let held = std::thread::spawn(move || listener.accept().unwrap());
        let (environment, _) = environment(running(&url));
        let impatient = Client::builder()
            .timeout(Duration::from_millis(200))
            .build()
            .unwrap();
        assert_eq!(
            handle(
                &json!({ "type": "handoff" }),
                true,
                &environment,
                &impatient
            ),
            not("timed-out")
        );
        drop(held.join().unwrap());
    }

    #[test]
    fn handoff_without_a_running_app_is_not_running() {
        let (environment, asked) = environment(Computer {
            app_url: None,
            ..running("http://127.0.0.1:9")
        });
        assert_eq!(
            ask(json!({ "type": "handoff" }), true, &environment),
            not("not-running")
        );
        assert!(asked.cookies().is_empty());
    }

    #[test]
    fn handoff_without_an_install_is_not_installed() {
        let (url, listener) = fake_app();
        let (environment, asked) = environment(Computer {
            installed: false,
            ..running(&url)
        });
        assert_eq!(
            ask(json!({ "type": "handoff" }), true, &environment),
            not("not-installed")
        );
        assert_untouched(&listener);
        assert!(asked.cookies().is_empty());
    }

    #[test]
    fn handoff_from_a_foreign_origin_is_refused_before_anything_else() {
        let (url, listener) = fake_app();
        let (environment, asked) = environment(running(&url));
        assert_eq!(
            ask(json!({ "type": "handoff" }), false, &environment),
            not("origin-not-allowed")
        );
        assert_untouched(&listener);
        assert!(asked.cookies().is_empty());
        assert_eq!(asked.app_url.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn handoff_passes_on_why_the_organization_sign_in_could_not_be_handed_over() {
        for (refusal, code) in [
            (Refusal::NotSignedIn, "not-signed-in"),
            (Refusal::OrganizationUnavailable, "organization-unavailable"),
        ] {
            let (url, listener) = fake_app();
            let (environment, asked) = environment(Computer {
                cookie: Err(refusal),
                ..running(&url)
            });
            assert_eq!(
                ask(json!({ "type": "handoff" }), true, &environment),
                not(code)
            );
            assert_untouched(&listener);
            assert_eq!(asked.cookies(), vec![url]);
        }
    }

    #[test]
    fn address_answers_the_owned_app_url_and_mints_nothing() {
        let (url, listener) = fake_app();
        let (environment, asked) = environment(running(&url));
        assert_eq!(
            ask(json!({ "type": "address" }), true, &environment),
            json!({ "ok": true, "openbotUrl": url })
        );
        // The ownership checks behind `app_url` ran; nothing asked the app for a code or handed over a sign-in.
        assert_eq!(asked.app_url.load(Ordering::SeqCst), 1);
        assert_untouched(&listener);
        assert!(asked.cookies().is_empty());
    }

    #[test]
    fn address_says_why_there_is_none_and_asks_a_foreign_origin_nothing() {
        let (url, listener) = fake_app();
        let cases = [
            (false, running(&url), "origin-not-allowed", 0),
            (
                true,
                Computer {
                    installed: false,
                    ..running(&url)
                },
                "not-installed",
                0,
            ),
            (
                true,
                Computer {
                    app_url: None,
                    ..running(&url)
                },
                "not-running",
                1,
            ),
        ];
        for (origin_allowed, computer, code, checks) in cases {
            let (environment, asked) = environment(computer);
            assert_eq!(
                ask(json!({ "type": "address" }), origin_allowed, &environment),
                not(code)
            );
            assert_eq!(asked.app_url.load(Ordering::SeqCst), checks, "{code}");
            assert!(asked.cookies().is_empty(), "{code}");
        }
        assert_untouched(&listener);
    }

    #[test]
    fn an_unknown_message_is_answered_without_touching_anything() {
        let (url, listener) = fake_app();
        let (environment, asked) = environment(running(&url));
        for message in [json!({ "type": "connect" }), json!("ping"), json!(null)] {
            assert_eq!(ask(message, true, &environment), not("unknown-message"));
        }
        assert_untouched(&listener);
        assert!(asked.cookies().is_empty());
        assert_eq!(asked.app_answers.load(Ordering::SeqCst), 0);
    }

    fn serve_all(
        messages: &[Value],
        environment: &Arc<HostEnvironment>,
        deadlines: Deadlines,
    ) -> (i32, Vec<Value>) {
        let input: Vec<u8> = messages.iter().flat_map(framed).collect();
        let mut output = Vec::new();
        let status = serve(
            &mut Cursor::new(input),
            &mut output,
            true,
            environment,
            &client().unwrap(),
            deadlines,
        );
        let mut replies = Vec::new();
        let mut output = Cursor::new(output);
        while let Some(reply) = read_message(&mut output).unwrap() {
            replies.push(reply);
        }
        (status, replies)
    }

    #[test]
    fn the_host_answers_each_message_until_its_input_closes() {
        let (environment, _) = environment(Computer {
            installed: false,
            ..running("http://127.0.0.1:9")
        });
        let (status, replies) = serve_all(
            &[
                json!({ "type": "ping" }),
                json!({ "type": "handoff" }),
                json!({ "type": "address" }),
                json!({ "type": "connect" }),
            ],
            &environment,
            DEADLINES,
        );
        assert_eq!(status, 0);
        assert_eq!(
            replies,
            [
                unavailable("not-installed"),
                not("not-installed"),
                not("not-installed"),
                not("unknown-message")
            ]
        );
    }

    #[test]
    fn a_check_still_running_at_its_deadline_is_answered_timed_out_and_the_next_message_is_heard() {
        let slow = HostEnvironment {
            installed: Box::new(|| true),
            app_answers: Box::new(|| {
                std::thread::sleep(Duration::from_secs(3));
                true
            }),
            signed_in: Box::new(|| Ok(())),
            app_url: Box::new(|| {
                std::thread::sleep(Duration::from_secs(3));
                None
            }),
            organization_cookie: Box::new(|_| Ok(None)),
        };
        let deadlines = Deadlines {
            ping: Duration::from_millis(100),
            handoff: Duration::from_millis(150),
            address: Duration::from_millis(150),
        };
        let started = Instant::now();
        let (status, replies) = serve_all(
            &[
                json!({ "type": "ping" }),
                json!({ "type": "handoff" }),
                json!({ "type": "address" }),
                json!({ "type": "connect" }),
            ],
            &Arc::new(slow),
            deadlines,
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(status, 0);
        assert_eq!(
            replies,
            [
                unavailable("timed-out"),
                not("timed-out"),
                not("timed-out"),
                not("unknown-message")
            ]
        );
    }

    #[test]
    fn a_check_that_fails_outright_is_answered_host_failed() {
        let broken = HostEnvironment {
            installed: Box::new(|| panic!("a broken check")),
            app_answers: Box::new(|| true),
            signed_in: Box::new(|| Ok(())),
            app_url: Box::new(|| None),
            organization_cookie: Box::new(|_| Ok(None)),
        };
        let (status, replies) = serve_all(
            &[json!({ "type": "ping" }), json!({ "type": "handoff" })],
            &Arc::new(broken),
            DEADLINES,
        );
        assert_eq!(status, 0);
        assert_eq!(replies, [unavailable("host-failed"), not("host-failed")]);
    }

    #[test]
    fn each_deadline_leaves_a_second_of_the_extensions_wait() {
        // extension/src/background/native-host.ts: PING_TIMEOUT_MS, HANDOFF_TIMEOUT_MS and ADDRESS_TIMEOUT_MS.
        let (extension_ping, extension_handoff, extension_address) = (
            Duration::from_secs(3),
            Duration::from_secs(8),
            Duration::from_secs(8),
        );
        assert!(DEADLINES.ping + Duration::from_secs(1) <= extension_ping);
        assert!(DEADLINES.handoff + Duration::from_secs(1) <= extension_handoff);
        assert!(DEADLINES.address + Duration::from_secs(1) <= extension_address);
        // Two probes, one per loopback, fit in a ping.
        assert!(PING_PROBE_PATIENCE * 2 < DEADLINES.ping);
    }

    #[test]
    fn the_host_stops_with_a_failure_on_a_message_it_cannot_read() {
        let (environment, _) = environment(Computer {
            installed: false,
            ..running("http://127.0.0.1:9")
        });
        let input = (2 * 1024 * 1024u32).to_ne_bytes().to_vec();
        let mut output = Vec::new();
        assert_eq!(
            serve(
                &mut Cursor::new(input),
                &mut output,
                true,
                &environment,
                &client().unwrap(),
                DEADLINES
            ),
            1
        );
        assert!(output.is_empty());
    }
}
