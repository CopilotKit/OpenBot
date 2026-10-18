//! The native messaging host the Recorder extension talks to.
//!
//! Chrome, Edge and Chromium start OpenBot Desktop's own binary as the host. Its first argument is
//! the caller's origin, and on Windows a `--parent-window=<n>` argument follows. Each message, both
//! ways, is UTF-8 JSON preceded by its length as a 32-bit integer in native byte order; a message
//! from the host may be at most 1 MB. The browser closes the host's stdin when it is done with it.
//! <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
//!
//! The host answers two messages. `ping` says whether this computer's OpenBot is installed and
//! running, and mints nothing. `handoff` asks that OpenBot for a one-time connect code and returns it
//! with the OpenBot's address, so the Recorder can connect without the person typing either. Neither
//! the code nor any cookie is ever written to a log.
use crate::recorder_install::Os;
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const HOST_NAME: &str = "ai.copilotkit.openbot.recorder";

/// The host name and the one extension id, shared with the extension and the server.
const RECORDER_EXTENSION: &str = include_str!("../../../shared/recorder-extension.json");

/// Tauri's bundle identifier for OpenBot Desktop (`tauri.conf.json` `identifier`).
const APP_IDENTIFIER: &str = "ai.copilotkit.openbot.desktop";

/// The largest message either way. Chrome refuses a host message over 1 MB, and the extension sends
/// only a few bytes, so a longer length prefix is a broken or hostile pipe.
const MESSAGE_LIMIT: usize = 1024 * 1024;

/// The local organization session cookie for the app at the given address. Ok(None) in single-user mode.
pub type OrganizationCookie = Box<dyn Fn(&str) -> Result<Option<String>, String>>;

/// What main.rs knows about this computer's OpenBot.
pub struct HostEnvironment {
    /// A selected root exists.
    pub installed: Box<dyn Fn() -> bool>,
    /// The owned app's address, None when it is not running.
    pub app_url: Box<dyn Fn() -> Option<String>>,
    /// Err when the organization sign-in cannot be handed over.
    pub organization_cookie: OrganizationCookie,
}

fn extension_origin() -> String {
    let id = serde_json::from_str::<Value>(RECORDER_EXTENSION)
        .ok()
        .and_then(|value| value.get("extensionId")?.as_str().map(str::to_string))
        .expect("shared/recorder-extension.json has no extensionId");
    format!("chrome-extension://{id}/")
}

/// Only the Recorder's own fixed id may ask, in debug and release builds alike.
fn origin_allowed(origin: &str) -> bool {
    origin == extension_origin()
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
        Os::Linux => xdg_config_home
            .filter(|path| path.to_string_lossy().starts_with('/'))
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join(".config")),
        Os::Windows => app_data
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join("AppData").join("Roaming")),
    };
    config.join(APP_IDENTIFIER)
}

fn refused(error: &str) -> Value {
    json!({ "error": error })
}

fn handoff(origin_allowed: bool, env: &HostEnvironment, client: &Client) -> Value {
    if !origin_allowed {
        return refused("origin-not-allowed");
    }
    if !(env.installed)() {
        return refused("not-installed");
    }
    let Some(app_url) = (env.app_url)() else {
        return refused("not-running");
    };
    let Ok(cookie) = (env.organization_cookie)(&app_url) else {
        return refused("not-signed-in");
    };
    let mut request = client
        .post(format!(
            "{}/api/recorder/connect-codes",
            app_url.trim_end_matches('/')
        ))
        .json(&json!({ "via": "desktop" }));
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    let response = match request.send() {
        Ok(response) => response,
        Err(_) => {
            eprintln!("[recorder-host] the local OpenBot did not answer the handoff");
            return refused("not-running");
        }
    };
    if response.status() != reqwest::StatusCode::CREATED {
        eprintln!(
            "[recorder-host] the local OpenBot answered the handoff with {}",
            response.status()
        );
        return refused("not-running");
    }
    match response
        .json::<Value>()
        .ok()
        .and_then(|minted| minted.get("code")?.as_str().map(str::to_string))
    {
        Some(code) if !code.is_empty() => json!({ "openbotUrl": app_url, "code": code }),
        _ => {
            eprintln!("[recorder-host] the local OpenBot answered the handoff without a code");
            refused("not-running")
        }
    }
}

/// Answers one message. "ping" never mints anything.
pub fn handle(
    message: &Value,
    origin_allowed: bool,
    env: &HostEnvironment,
    client: &Client,
) -> Value {
    match message.get("type").and_then(Value::as_str) {
        Some("ping") => json!({
            "available": origin_allowed && (env.installed)() && (env.app_url)().is_some()
        }),
        Some("handoff") => handoff(origin_allowed, env, client),
        _ => refused("unknown-message"),
    }
}

/// The local OpenBot is on this computer. The extension gives up on a handoff after 8 seconds: up to 3
/// for the running-app check that comes first, and these 5.
fn client() -> reqwest::Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
}

/// Answers each message until the input closes (0), or until a message cannot be read or answered (1).
fn serve(
    input: &mut impl Read,
    output: &mut impl Write,
    origin_allowed: bool,
    env: &HostEnvironment,
    client: &Client,
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
        if let Err(error) = write_message(output, &handle(&message, origin_allowed, env, client)) {
            eprintln!("[recorder-host] could not answer a message: {error}");
            return 1;
        }
    }
}

/// Runs the host until stdin closes. Returns the process exit code. `origin_allowed` is true only for
/// "chrome-extension://<RECORDER_EXTENSION_ID>/" (the id from shared/recorder-extension.json), in every build.
pub fn run(origin: &str, env: &HostEnvironment) -> i32 {
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
        env,
        &client,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::cell::RefCell;
    use std::ffi::OsString;
    use std::io::{BufRead, BufReader, Cursor, ErrorKind, Read, Write};
    use std::net::TcpListener;
    use std::path::Path;
    use std::rc::Rc;

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
    fn host_name_and_origin_come_from_the_shared_file() {
        let shared: Value =
            serde_json::from_str(include_str!("../../../shared/recorder-extension.json")).unwrap();
        assert_eq!(HOST_NAME, shared["nativeHost"]);
        assert_eq!(
            fixed_origin(),
            format!(
                "chrome-extension://{}/",
                shared["extensionId"].as_str().unwrap()
            )
        );
        assert!(origin_allowed(&fixed_origin()));
        assert!(!origin_allowed(&format!(
            "chrome-extension://{}/",
            "p".repeat(32)
        )));
        assert!(!origin_allowed(&format!("chrome-extension://{ID}")));
        assert!(!origin_allowed(""));
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

    /// What the host asked of the environment's cookie function.
    type Asked = Rc<RefCell<Vec<String>>>;

    fn environment(
        installed: bool,
        app_url: Option<String>,
        cookie: Result<Option<String>, String>,
    ) -> (HostEnvironment, Asked) {
        let asked: Asked = Rc::new(RefCell::new(Vec::new()));
        let seen = asked.clone();
        let environment = HostEnvironment {
            installed: Box::new(move || installed),
            app_url: Box::new(move || app_url.clone()),
            organization_cookie: Box::new(move |url| {
                seen.borrow_mut().push(url.to_string());
                cookie.clone()
            }),
        };
        (environment, asked)
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

    #[test]
    fn ping_answers_available_and_mints_nothing() {
        let (url, listener) = fake_app();
        let (environment, asked) = environment(true, Some(url), Ok(None));
        assert_eq!(
            ask(json!({ "type": "ping" }), true, &environment),
            json!({ "available": true })
        );
        assert_untouched(&listener);
        assert!(asked.borrow().is_empty());
    }

    #[test]
    fn ping_answers_unavailable_for_a_foreign_origin_no_install_or_no_running_app() {
        let (url, listener) = fake_app();
        for (origin_allowed, installed, app_url) in [
            (false, true, Some(url.clone())),
            (true, false, Some(url.clone())),
            (true, true, None),
        ] {
            let (environment, asked) = environment(installed, app_url, Ok(None));
            assert_eq!(
                ask(json!({ "type": "ping" }), origin_allowed, &environment),
                json!({ "available": false })
            );
            assert!(asked.borrow().is_empty());
        }
        assert_untouched(&listener);
    }

    #[test]
    fn handoff_in_single_user_mode_returns_the_app_url_and_a_fresh_code() {
        let (url, listener) = fake_app();
        let app = answer_once(listener, reply("201 Created", MINTED));
        let (environment, asked) = environment(true, Some(url.clone()), Ok(None));
        assert_eq!(
            ask(json!({ "type": "handoff" }), true, &environment),
            json!({ "openbotUrl": url, "code": "obc_fixture" })
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
        assert_eq!(*asked.borrow(), vec![url]);
    }

    #[test]
    fn handoff_in_organization_mode_sends_the_local_session_cookie() {
        let (url, listener) = fake_app();
        let app = answer_once(listener, reply("201 Created", MINTED));
        let (environment, asked) = environment(
            true,
            Some(url.clone()),
            Ok(Some("openbot.organization-session=v".into())),
        );
        assert_eq!(
            ask(json!({ "type": "handoff" }), true, &environment),
            json!({ "openbotUrl": url, "code": "obc_fixture" })
        );
        let (head, _) = app.join().unwrap();
        assert!(head
            .to_lowercase()
            .contains("cookie: openbot.organization-session=v\r\n"));
        assert_eq!(*asked.borrow(), vec![url]);
    }

    #[test]
    fn handoff_is_not_running_when_nothing_listens() {
        let (url, listener) = fake_app();
        drop(listener);
        let (environment, _) = environment(true, Some(url), Ok(None));
        assert_eq!(
            ask(json!({ "type": "handoff" }), true, &environment),
            json!({ "error": "not-running" })
        );
    }

    #[test]
    fn handoff_is_not_running_for_any_answer_but_a_minted_code() {
        for answer in [
            reply("401 Unauthorized", r#"{"error":"Sign in."}"#),
            reply("500 Internal Server Error", "{}"),
            reply("200 OK", MINTED),
            reply("201 Created", "{}"),
            reply("201 Created", "not json"),
        ] {
            let (url, listener) = fake_app();
            let app = answer_once(listener, answer.clone());
            let (environment, _) = environment(true, Some(url), Ok(None));
            assert_eq!(
                ask(json!({ "type": "handoff" }), true, &environment),
                json!({ "error": "not-running" }),
                "{answer}"
            );
            app.join().unwrap();
        }
    }

    #[test]
    fn handoff_without_a_running_app_is_not_running() {
        let (environment, asked) = environment(true, None, Ok(None));
        assert_eq!(
            ask(json!({ "type": "handoff" }), true, &environment),
            json!({ "error": "not-running" })
        );
        assert!(asked.borrow().is_empty());
    }

    #[test]
    fn handoff_without_an_install_is_not_installed() {
        let (url, listener) = fake_app();
        let (environment, asked) = environment(false, Some(url), Ok(None));
        assert_eq!(
            ask(json!({ "type": "handoff" }), true, &environment),
            json!({ "error": "not-installed" })
        );
        assert_untouched(&listener);
        assert!(asked.borrow().is_empty());
    }

    #[test]
    fn handoff_from_a_foreign_origin_is_refused_before_anything_else() {
        let (url, listener) = fake_app();
        let (environment, asked) = environment(true, Some(url), Ok(None));
        assert_eq!(
            ask(json!({ "type": "handoff" }), false, &environment),
            json!({ "error": "origin-not-allowed" })
        );
        assert_untouched(&listener);
        assert!(asked.borrow().is_empty());
    }

    #[test]
    fn handoff_when_the_organization_sign_in_fails_is_not_signed_in() {
        let (url, listener) = fake_app();
        let (environment, asked) = environment(
            true,
            Some(url.clone()),
            Err("Sign in to your organization again.".into()),
        );
        assert_eq!(
            ask(json!({ "type": "handoff" }), true, &environment),
            json!({ "error": "not-signed-in" })
        );
        assert_untouched(&listener);
        assert_eq!(*asked.borrow(), vec![url]);
    }

    #[test]
    fn an_unknown_message_is_answered_without_touching_anything() {
        let (url, listener) = fake_app();
        let (environment, asked) = environment(true, Some(url), Ok(None));
        for message in [json!({ "type": "connect" }), json!("ping"), json!(null)] {
            assert_eq!(
                ask(message, true, &environment),
                json!({ "error": "unknown-message" })
            );
        }
        assert_untouched(&listener);
        assert!(asked.borrow().is_empty());
    }

    #[test]
    fn the_host_answers_each_message_until_its_input_closes() {
        let (environment, _) = environment(false, None, Ok(None));
        let input = [
            framed(&json!({ "type": "ping" })),
            framed(&json!({ "type": "handoff" })),
        ]
        .concat();
        let mut output = Vec::new();
        assert_eq!(
            serve(
                &mut Cursor::new(input),
                &mut output,
                true,
                &environment,
                &client().unwrap()
            ),
            0
        );
        let mut replies = Cursor::new(output);
        assert_eq!(
            read_message(&mut replies).unwrap(),
            Some(json!({ "available": false }))
        );
        assert_eq!(
            read_message(&mut replies).unwrap(),
            Some(json!({ "error": "not-installed" }))
        );
        assert_eq!(read_message(&mut replies).unwrap(), None);
    }

    #[test]
    fn the_host_stops_with_a_failure_on_a_message_it_cannot_read() {
        let (environment, _) = environment(false, None, Ok(None));
        let input = (2 * 1024 * 1024u32).to_ne_bytes().to_vec();
        let mut output = Vec::new();
        assert_eq!(
            serve(
                &mut Cursor::new(input),
                &mut output,
                true,
                &environment,
                &client().unwrap()
            ),
            1
        );
        assert!(output.is_empty());
    }
}
