//! OpenBot Desktop's binary run the way its callers run it: `--install-recorder-host` as the app's setup
//! and a person would, and the native messaging host as Chrome starts it.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Output, Stdio};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const BINARY: &str = env!("CARGO_BIN_EXE_openbot-desktop");
const SHARED: &str = include_str!("../../../shared/recorder-extension.json");

fn shared(field: &str) -> String {
    serde_json::from_str::<Value>(SHARED).unwrap()[field]
        .as_str()
        .unwrap()
        .to_string()
}

fn extension_origin() -> String {
    format!("chrome-extension://{}/", shared("extensionId"))
}

/// Every origin a manifest allows: the fixed id's, then each store id's that is set and differs.
fn allowed_origins() -> Value {
    let store = serde_json::from_str::<Value>(SHARED).unwrap()["storeIds"].clone();
    let mut origins = vec![extension_origin()];
    for name in ["chrome", "edge"] {
        let id = store[name].as_str().unwrap_or_default();
        let origin = format!("chrome-extension://{id}/");
        if !id.is_empty() && !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    json!(origins)
}

/// A fresh, empty directory standing in for a person's home, removed when dropped.
struct TempHome(PathBuf);

impl TempHome {
    fn new(name: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "openbot-recorder-{name}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Reads the child's output on its own threads, so a full pipe never stalls it.
fn drain(mut pipe: impl Read + Send + 'static) -> JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        bytes
    })
}

/// Waits for the child to exit; None, with the child killed, when it is still running at the deadline.
fn wait_for_exit(child: &mut Child, patience: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + patience;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Runs the child to its exit, failing the test if it is still running after `patience`.
fn finish(mut child: Child, patience: Duration) -> Output {
    let stdout = drain(child.stdout.take().unwrap());
    let stderr = drain(child.stderr.take().unwrap());
    let status = wait_for_exit(&mut child, patience);
    let stderr = stderr.join().unwrap();
    let Some(status) = status else {
        panic!(
            "openbot-desktop was still running after {patience:?}: {}",
            String::from_utf8_lossy(&stderr)
        );
    };
    Output {
        status,
        stdout: stdout.join().unwrap(),
        stderr,
    }
}

/// Where a debug binary's `--install-recorder-host` writes; it writes nowhere without it.
const TEST_HOME: &str = "OPENBOT_RECORDER_HOST_TEST_HOME";

/// The binary with nothing of the developer's own environment that would change its answer.
fn binary(home: &Path) -> Command {
    let mut command = Command::new(BINARY);
    command
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("APPDATA", home.join("AppData").join("Roaming"))
        .env("LOCALAPPDATA", home.join("AppData").join("Local"))
        .env_remove("CHROME_CONFIG_HOME")
        .env_remove(TEST_HOME)
        .env_remove("APPIMAGE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

// The install command writes into the browsers' per-user folders on macOS and Linux. On Windows it
// writes the registry, which a test must leave alone, so the wiring is proved on the other two.
#[cfg(unix)]
#[test]
fn the_install_command_writes_a_manifest_for_the_only_browser_present() {
    let home = TempHome::new("install");
    let edge = if cfg!(target_os = "macos") {
        home.path()
            .join("Library")
            .join("Application Support")
            .join("Microsoft Edge")
    } else {
        home.path().join(".config").join("microsoft-edge")
    };
    std::fs::create_dir_all(&edge).unwrap();

    let output = finish(
        binary(home.path())
            .env(TEST_HOME, home.path())
            .arg("--install-recorder-host")
            .spawn()
            .unwrap(),
        Duration::from_secs(60),
    );

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{:?}: {stderr}", output.status);
    let manifest_path = edge
        .join("NativeMessagingHosts")
        .join(format!("{}.json", shared("nativeHost")));
    // The Recorder is registered with Edge from Edge Add-ons only once it is published there.
    let edge_store_id = serde_json::from_str::<Value>(SHARED).unwrap()["storeIds"]["edge"]
        .as_str()
        .unwrap()
        .to_string();
    let external = edge.join("External Extensions");
    if edge_store_id.is_empty() {
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            format!("{}\n", manifest_path.display())
        );
        assert!(!external.exists());
    } else {
        let entry = external.join(format!("{edge_store_id}.json"));
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            format!("{}\n{}\n", manifest_path.display(), entry.display())
        );
        assert_eq!(
            serde_json::from_str::<Value>(&std::fs::read_to_string(entry).unwrap()).unwrap(),
            json!({ "external_update_url": "https://edge.microsoft.com/extensionwebstorebase/v1/crx" })
        );
    }
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
    assert_eq!(
        std::fs::canonicalize(manifest["path"].as_str().unwrap()).unwrap(),
        std::fs::canonicalize(BINARY).unwrap()
    );
    assert_eq!(manifest["allowed_origins"], allowed_origins());
    assert_eq!(manifest["name"], shared("nativeHost"));
    assert!(!home
        .path()
        .join("Library/Application Support/Google")
        .exists());
    assert!(!home.path().join(".config/google-chrome").exists());
    assert!(!home.path().join(".config/chromium").exists());
}

// A debug build is a developer's binary: run without the test folder, it must not register itself in the browsers of
// the home it runs in, which outside a test is the developer's own.
#[cfg(unix)]
#[test]
fn a_debug_binary_installs_only_under_the_test_home() {
    let home = TempHome::new("debug-install");
    let elsewhere = TempHome::new("debug-install-test-home");
    let browser = |root: &Path| {
        if cfg!(target_os = "macos") {
            root.join("Library")
                .join("Application Support")
                .join("Google")
                .join("Chrome")
        } else {
            root.join(".config").join("google-chrome")
        }
    };
    for root in [home.path(), elsewhere.path()] {
        std::fs::create_dir_all(browser(root)).unwrap();
    }
    let manifests = |root: &Path| browser(root).join("NativeMessagingHosts");

    let refused = finish(
        binary(home.path())
            .arg("--install-recorder-host")
            .spawn()
            .unwrap(),
        Duration::from_secs(60),
    );
    if cfg!(debug_assertions) {
        assert_eq!(refused.status.code(), Some(1));
        assert!(
            String::from_utf8_lossy(&refused.stderr).contains(TEST_HOME),
            "{}",
            String::from_utf8_lossy(&refused.stderr)
        );
        assert!(refused.stdout.is_empty());
        assert!(!manifests(home.path()).exists());

        let output = finish(
            binary(home.path())
                .env(TEST_HOME, elsewhere.path())
                .arg("--install-recorder-host")
                .spawn()
                .unwrap(),
            Duration::from_secs(60),
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(manifests(elsewhere.path())
            .join(format!("{}.json", shared("nativeHost")))
            .is_file());
        assert!(!manifests(home.path()).exists());
    } else {
        // A release build is the one people install, and writes into the home it runs in.
        assert!(
            refused.status.success(),
            "{}",
            String::from_utf8_lossy(&refused.stderr)
        );
        assert!(manifests(home.path()).is_dir());
    }
}

/// The host as Chrome starts it: the caller's origin first and, on Windows, the parent window after
/// it. Replies are read on their own thread, so a host that never answers fails the test instead of
/// hanging it.
struct Host {
    child: Child,
    stdin: Option<ChildStdin>,
    replies: mpsc::Receiver<Value>,
    stderr: Option<JoinHandle<Vec<u8>>>,
}

/// One message as Chrome frames it: a 32-bit length in native byte order, then the UTF-8 JSON.
fn read_framed(input: &mut impl Read) -> Option<Value> {
    let mut prefix = [0u8; 4];
    input.read_exact(&mut prefix).ok()?;
    let mut body = vec![0; u32::from_ne_bytes(prefix) as usize];
    input.read_exact(&mut body).ok()?;
    Some(serde_json::from_slice(&body).expect("the host wrote a message that is not JSON"))
}

impl Host {
    fn start(home: &Path, origin: &str, test_app_url: Option<&str>) -> Self {
        let mut command = binary(home);
        command
            .arg(origin)
            .env_remove("OPENBOT_RECORDER_HOST_TEST_APP_URL")
            .stdin(Stdio::piped());
        if cfg!(windows) {
            command.arg("--parent-window=0");
        }
        if let Some(url) = test_app_url {
            command.env("OPENBOT_RECORDER_HOST_TEST_APP_URL", url);
        }
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take();
        let mut stdout = child.stdout.take().unwrap();
        let stderr = Some(drain(child.stderr.take().unwrap()));
        let (sender, replies) = mpsc::channel();
        std::thread::spawn(move || {
            while let Some(reply) = read_framed(&mut stdout) {
                if sender.send(reply).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            stdin,
            replies,
            stderr,
        }
    }

    fn ask(&mut self, message: Value) -> Value {
        let body = message.to_string();
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(&(body.len() as u32).to_ne_bytes()).unwrap();
        stdin.write_all(body.as_bytes()).unwrap();
        stdin.flush().unwrap();
        match self.replies.recv_timeout(Duration::from_secs(30)) {
            Ok(reply) => reply,
            Err(error) => panic!("no reply to {message}: {error}"),
        }
    }

    fn running(&mut self) -> bool {
        self.child.try_wait().unwrap().is_none()
    }

    /// Closes the host's input the way Chrome does when it is done, and waits for it to exit.
    fn close(self) -> ExitStatus {
        self.close_with_stderr().0
    }

    /// [`Host::close`], and everything the host wrote to stderr.
    fn close_with_stderr(mut self) -> (ExitStatus, String) {
        drop(self.stdin.take());
        let status = wait_for_exit(&mut self.child, Duration::from_secs(30));
        let stderr = self.stderr.take().unwrap().join().unwrap();
        let Some(status) = status else {
            panic!(
                "the host was still running after its input closed: {}",
                String::from_utf8_lossy(&stderr)
            );
        };
        assert!(
            self.replies.try_recv().is_err(),
            "the host answered a message nobody sent"
        );
        (status, String::from_utf8_lossy(&stderr).into_owned())
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[test]
fn the_host_answers_as_chrome_asks_and_exits_when_its_input_closes() {
    let home = TempHome::new("host");
    let mut host = Host::start(home.path(), &extension_origin(), None);
    assert_eq!(
        host.ask(json!({ "type": "ping" })),
        json!({ "ok": false, "available": false, "error": "not-installed" })
    );
    assert!(host.running(), "the host exited before its input closed");
    assert_eq!(
        host.ask(json!({ "type": "handoff" })),
        json!({ "ok": false, "error": "not-installed" })
    );
    assert_eq!(
        host.ask(json!({ "type": "address" })),
        json!({ "ok": false, "error": "not-installed" })
    );
    let status = host.close();
    assert!(status.success(), "{status:?}");
}

#[test]
fn another_extension_is_refused_a_handoff() {
    let other = format!("chrome-extension://{}/", "p".repeat(32));
    assert_ne!(other, extension_origin());
    let home = TempHome::new("foreign");
    let mut host = Host::start(home.path(), &other, None);
    assert_eq!(
        host.ask(json!({ "type": "handoff" })),
        json!({ "ok": false, "error": "origin-not-allowed" })
    );
    assert_eq!(
        host.ask(json!({ "type": "ping" })),
        json!({ "ok": false, "available": false, "error": "origin-not-allowed" })
    );
    assert_eq!(
        host.ask(json!({ "type": "address" })),
        json!({ "ok": false, "error": "origin-not-allowed" })
    );
    assert!(host.close().success());
}

/// One request as a fake server saw it: the request line, the headers and the body.
struct Seen {
    line: String,
    head: String,
    body: String,
}

/// A fake HTTP server on 127.0.0.1 that answers `count` requests, one per connection, each with what `route` says for
/// its request line, and hands back what it saw.
fn serve_routes(
    listener: TcpListener,
    count: usize,
    route: impl Fn(&str) -> String + Send + 'static,
) -> JoinHandle<Vec<Seen>> {
    std::thread::spawn(move || {
        let mut seen = Vec::new();
        for _ in 0..count {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let line = line.trim_end().to_string();
            let mut head = String::new();
            let mut length = 0;
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).unwrap() == 0 || header == "\r\n" {
                    break;
                }
                if let Some(value) = header.to_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
                head.push_str(&header);
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            stream.write_all(route(&line).as_bytes()).unwrap();
            seen.push(Seen {
                line,
                head,
                body: String::from_utf8(body).unwrap(),
            });
        }
        seen
    })
}

fn http(status: &str, headers: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

const MINTED: &str = r#"{"code":"obc_fixture","expiresAt":"2026-10-18T12:00:00.000Z"}"#;

// A debug binary lets a test point the host at an OpenBot it started itself. A release binary has no
// such seam: CI runs this file with `--release` on Windows, where the same variable changes nothing.
#[test]
fn the_test_app_address_reaches_only_a_debug_binary() {
    let home = TempHome::new("seam");
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let mut host = Host::start(home.path(), &extension_origin(), Some(&url));
    if cfg!(debug_assertions) {
        let app = serve_routes(listener, 2, |line| {
            if line.starts_with("GET /api/capabilities ") {
                http("200 OK", "", "{}")
            } else {
                http("201 Created", "", MINTED)
            }
        });
        // The address is the one the Recorder trusts a page's connect from; asking it dials nothing, so the app's first
        // request below is still the ping's.
        assert_eq!(
            host.ask(json!({ "type": "address" })),
            json!({ "ok": true, "openbotUrl": url })
        );
        assert_eq!(
            host.ask(json!({ "type": "ping" })),
            json!({ "ok": true, "available": true })
        );
        assert_eq!(
            host.ask(json!({ "type": "handoff" })),
            json!({ "ok": true, "openbotUrl": url, "code": "obc_fixture" })
        );
        let seen = app.join().unwrap();
        assert_eq!(seen[0].line, "GET /api/capabilities HTTP/1.1");
        assert_eq!(seen[1].line, "POST /api/recorder/connect-codes HTTP/1.1");
        assert!(
            !seen[1].head.to_lowercase().contains("cookie:"),
            "{}",
            seen[1].head
        );
        assert_eq!(
            serde_json::from_str::<Value>(&seen[1].body).unwrap(),
            json!({ "via": "desktop" })
        );
    } else {
        assert_eq!(
            host.ask(json!({ "type": "ping" })),
            json!({ "ok": false, "available": false, "error": "not-installed" })
        );
        assert_eq!(
            host.ask(json!({ "type": "handoff" })),
            json!({ "ok": false, "error": "not-installed" })
        );
        assert_eq!(
            host.ask(json!({ "type": "address" })),
            json!({ "ok": false, "error": "not-installed" })
        );
        listener.set_nonblocking(true).unwrap();
        match listener.accept() {
            Err(error) => assert_eq!(error.kind(), ErrorKind::WouldBlock),
            Ok((_, peer)) => panic!("a release binary dialled the test app from {peer}"),
        }
    }
    assert!(host.close().success());
}

// An app that takes the connection and never answers still gets the extension an answer, inside the time it waits:
// 3 s for a ping and 8 s for a handoff.
#[test]
fn a_silent_app_is_answered_for_within_the_extensions_wait() {
    if !cfg!(debug_assertions) {
        return;
    }
    let home = TempHome::new("silent");
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let held = std::thread::spawn(move || {
        let mut streams = Vec::new();
        listener.set_nonblocking(true).unwrap();
        let until = Instant::now() + Duration::from_secs(15);
        while Instant::now() < until {
            if let Ok((stream, _)) = listener.accept() {
                streams.push(stream);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    });
    let mut host = Host::start(home.path(), &extension_origin(), Some(&url));
    let asked = Instant::now();
    assert_eq!(
        host.ask(json!({ "type": "ping" })),
        json!({ "ok": false, "available": false, "error": "not-running" })
    );
    assert!(
        asked.elapsed() < Duration::from_secs(3),
        "{:?}",
        asked.elapsed()
    );
    let asked = Instant::now();
    assert_eq!(
        host.ask(json!({ "type": "handoff" })),
        json!({ "ok": false, "error": "timed-out" })
    );
    assert!(
        asked.elapsed() < Duration::from_secs(8),
        "{:?}",
        asked.elapsed()
    );
    assert!(host.close().success());
    drop(held);
}

/// A selected deployment in organization mode under `home`, its sign-in saved for `authority` when `cookie` is Some.
#[cfg(unix)]
fn organization_deployment(home: &Path, authority: &str, cookie: Option<&str>) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let config = if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support")
    } else {
        home.join(".config")
    }
    .join("ai.copilotkit.openbot.desktop");
    let root = home.join("deployment");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        config.join("last-launched-root.json"),
        serde_json::to_string(&root).unwrap(),
    )
    .unwrap();
    std::fs::write(
        root.join(".env"),
        format!("OPENBOT_ORGANIZATION_AUTH_URL={authority}\n"),
    )
    .unwrap();
    if let Some(cookie) = cookie {
        let secrets = root.join(".secrets");
        std::fs::create_dir_all(&secrets).unwrap();
        std::fs::set_permissions(&secrets, std::fs::Permissions::from_mode(0o700)).unwrap();
        let saved = secrets.join("OPENBOT_ORGANIZATION_SESSION.secret");
        std::fs::write(
            &saved,
            json!({ "authority": authority, "cookie": cookie }).to_string(),
        )
        .unwrap();
        std::fs::set_permissions(&saved, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    root
}

// Organization mode: the ping reads whether Desktop holds a sign-in, without the network.
#[cfg(unix)]
#[test]
fn an_organization_ping_without_a_saved_sign_in_is_not_signed_in() {
    if !cfg!(debug_assertions) {
        return;
    }
    let home = TempHome::new("organization-ping");
    let authority = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let authority_url = format!("http://{}", authority.local_addr().unwrap());
    organization_deployment(home.path(), &authority_url, None);
    let app = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let url = format!("http://{}", app.local_addr().unwrap());
    let probe = serve_routes(app, 1, |_| http("200 OK", "", "{}"));
    let mut host = Host::start(home.path(), &extension_origin(), Some(&url));
    assert_eq!(
        host.ask(json!({ "type": "ping" })),
        json!({ "ok": false, "available": false, "error": "not-signed-in" })
    );
    assert_eq!(
        probe.join().unwrap()[0].line,
        "GET /api/capabilities HTTP/1.1"
    );
    assert!(host.close().success());
    authority.set_nonblocking(true).unwrap();
    match authority.accept() {
        Err(error) => assert_eq!(error.kind(), ErrorKind::WouldBlock),
        Ok((_, peer)) => panic!("a ping dialled the organization from {peer}"),
    }
}

// The host's stderr reaches Chrome's log and the terminal of whoever started the browser: never a connect code or
// any part of a cookie, on success or on failure.
#[cfg(unix)]
#[test]
fn the_host_never_logs_a_code_or_a_cookie() {
    if !cfg!(debug_assertions) {
        return;
    }
    let home = TempHome::new("stderr");
    let authority = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let authority_url = format!("http://{}", authority.local_addr().unwrap());
    organization_deployment(
        home.path(),
        &authority_url,
        Some("better-auth.session_token=saved-secret"),
    );
    let me = r#"{"user":{"id":"u1","email":"a@b.c","name":null,"role":"user"}}"#;
    let organization = serve_routes(authority, 2, move |_| http("200 OK", "", me));
    let app = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let url = format!("http://{}", app.local_addr().unwrap());
    let minted = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let app = serve_routes(app, 7, move |line| {
        let minted_code = r#"{"code":"obc_secretcode","expiresAt":"2026-10-18T12:00:00.000Z"}"#;
        if line.starts_with("GET /api/capabilities ") {
            http("200 OK", "", "{}")
        } else if line.starts_with("POST /api/auth/organization/session ") {
            http("200 OK", "", r#"{"ticket":"t"}"#)
        } else if line.starts_with("GET /api/auth/organization/session?ticket=t ") {
            http(
                "302 Found",
                "Location: /\r\nSet-Cookie: openbot.organization-session=local-secret; Path=/; HttpOnly\r\n",
                "",
            )
        } else if minted.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            http("201 Created", "", minted_code)
        } else {
            // A refusal that repeats the code and the cookie in its body.
            http(
                "500 Internal Server Error",
                "",
                r#"{"error":"obc_secretcode openbot.organization-session=local-secret"}"#,
            )
        }
    });
    let mut host = Host::start(home.path(), &extension_origin(), Some(&url));
    assert_eq!(
        host.ask(json!({ "type": "ping" })),
        json!({ "ok": true, "available": true })
    );
    assert_eq!(
        host.ask(json!({ "type": "handoff" })),
        json!({ "ok": true, "openbotUrl": url, "code": "obc_secretcode" })
    );
    assert_eq!(
        host.ask(json!({ "type": "handoff" })),
        json!({ "ok": false, "error": "handoff-failed" })
    );
    let (status, stderr) = host.close_with_stderr();
    assert!(status.success(), "{status:?}: {stderr}");
    let seen = app.join().unwrap();
    assert!(seen[3]
        .head
        .to_lowercase()
        .contains("cookie: openbot.organization-session=local-secret\r\n"));
    organization.join().unwrap();
    assert!(
        stderr.contains("answered the handoff with 500"),
        "the failure was not logged at all: {stderr}"
    );
    for secret in [
        "obc_",
        "secret",
        "session_token",
        "organization-session",
        "ticket",
    ] {
        assert!(
            !stderr.contains(secret),
            "stderr holds {secret:?}: {stderr}"
        );
    }
}
