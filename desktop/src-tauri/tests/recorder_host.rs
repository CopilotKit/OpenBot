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
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{}\n", manifest_path.display())
    );
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
    assert_eq!(
        std::fs::canonicalize(manifest["path"].as_str().unwrap()).unwrap(),
        std::fs::canonicalize(BINARY).unwrap()
    );
    assert_eq!(manifest["allowed_origins"], json!([extension_origin()]));
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
    fn close(mut self) -> ExitStatus {
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
        status
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
        json!({ "available": false })
    );
    assert!(host.running(), "the host exited before its input closed");
    assert_eq!(
        host.ask(json!({ "type": "handoff" })),
        json!({ "error": "not-installed" })
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
        json!({ "error": "origin-not-allowed" })
    );
    assert_eq!(
        host.ask(json!({ "type": "ping" })),
        json!({ "available": false })
    );
    assert!(host.close().success());
}

/// Answers one request with a minted code and hands back the request's head and body.
fn mint_once(listener: TcpListener) -> JoinHandle<(String, String)> {
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
        let minted = r#"{"code":"obc_fixture","expiresAt":"2026-10-18T12:00:00.000Z"}"#;
        stream
            .write_all(
                format!(
                    "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{minted}",
                    minted.len()
                )
                .as_bytes(),
            )
            .unwrap();
        (head, String::from_utf8(body).unwrap())
    })
}

// A debug binary lets a test point the host at an OpenBot it started itself. A release binary has no
// such seam: CI runs this file with `--release` on Windows, where the same variable changes nothing.
#[test]
fn the_test_app_address_reaches_only_a_debug_binary() {
    let home = TempHome::new("seam");
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let mut host = Host::start(home.path(), &extension_origin(), Some(&url));
    if cfg!(debug_assertions) {
        let app = mint_once(listener);
        assert_eq!(
            host.ask(json!({ "type": "ping" })),
            json!({ "available": true })
        );
        assert_eq!(
            host.ask(json!({ "type": "handoff" })),
            json!({ "openbotUrl": url, "code": "obc_fixture" })
        );
        let (head, body) = app.join().unwrap();
        assert!(
            head.starts_with("POST /api/recorder/connect-codes HTTP/1.1\r\n"),
            "{head}"
        );
        assert!(!head.to_lowercase().contains("cookie:"), "{head}");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({ "via": "desktop" })
        );
    } else {
        assert_eq!(
            host.ask(json!({ "type": "ping" })),
            json!({ "available": false })
        );
        assert_eq!(
            host.ask(json!({ "type": "handoff" })),
            json!({ "error": "not-installed" })
        );
        listener.set_nonblocking(true).unwrap();
        match listener.accept() {
            Err(error) => assert_eq!(error.kind(), ErrorKind::WouldBlock),
            Ok((_, peer)) => panic!("a release binary dialled the test app from {peer}"),
        }
    }
    assert!(host.close().success());
}
