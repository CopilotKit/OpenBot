//! OpenBot Desktop's binary run the way its callers run it: `--install-recorder-host` as the app's setup
//! and a person would, and the native messaging host as Chrome starts it.
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
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
fn drain(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        bytes
    })
}

/// Waits for the child to exit, killing it and failing the test if it is still running at the deadline.
fn finish(mut child: Child, patience: Duration) -> Output {
    let stdout = drain(child.stdout.take().unwrap());
    let stderr = drain(child.stderr.take().unwrap());
    let deadline = Instant::now() + patience;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            let stderr = String::from_utf8_lossy(&stderr.join().unwrap()).into_owned();
            panic!("openbot-desktop was still running after {patience:?}: {stderr}");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Output {
        status,
        stdout: stdout.join().unwrap(),
        stderr: stderr.join().unwrap(),
    }
}

/// The binary with nothing of the developer's own environment that would change its answer.
fn binary(home: &Path) -> Command {
    let mut command = Command::new(BINARY);
    command
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("APPDATA", home.join("AppData").join("Roaming"))
        .env("LOCALAPPDATA", home.join("AppData").join("Local"))
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
