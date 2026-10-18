//! Writes the native messaging host manifests that let the Recorder extension find OpenBot Desktop.
//!
//! Where each manifest goes, checked against the official pages:
//! - Chrome and Chromium, macOS, Linux and the Windows registry key:
//!   <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
//!   (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`, `~/.config/google-chrome/NativeMessagingHosts/`,
//!   `HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\<name>` with the manifest path as its default value;
//!   Chromium uses `Chromium` in place of `Google/Chrome` and `google-chrome`).
//! - Edge, macOS (`~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/`), Linux
//!   (`~/.config/microsoft-edge/NativeMessagingHosts`) and `HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\<name>`; the same page
//!   lists `HKCU\SOFTWARE\Chromium\NativeMessagingHosts` as a registry location, and shows `allowed_origins` as
//!   `chrome-extension://<id>/`:
//!   <https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging>
//!
//! `allowed_origins` never holds a wildcard, and holds only the Recorder's one extension id, in debug and release builds alike.
use crate::problem::Problem;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The host name and the one extension id, shared with the extension and the server.
const RECORDER_EXTENSION: &str = include_str!("../../../shared/recorder-extension.json");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Browser {
    Chrome,
    Edge,
    Chromium,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Mac,
    Linux,
    Windows,
}

/// The side effects of an install, so tests can watch them without touching the computer.
pub trait InstallWriter {
    /// Writes the file, creating its parent directories first.
    fn write_file(&mut self, path: &Path, contents: &str) -> std::io::Result<()>;
    fn run(&mut self, argv: &[String]) -> std::io::Result<()>;
    fn exists(&self, path: &Path) -> bool;
}

const BROWSERS: [Browser; 3] = [Browser::Chrome, Browser::Edge, Browser::Chromium];

fn shared_field(field: &str) -> String {
    serde_json::from_str::<Value>(RECORDER_EXTENSION)
        .ok()
        .and_then(|value| value.get(field)?.as_str().map(str::to_string))
        .unwrap_or_else(|| panic!("shared/recorder-extension.json has no {field}"))
}

fn host_name() -> String {
    shared_field("nativeHost")
}

fn manifest_file_name() -> String {
    format!("{}.json", host_name())
}

/// The host manifest Chrome, Edge and Chromium read.
pub fn host_manifest(path_to_exe: &Path) -> Value {
    json!({
        "name": host_name(),
        "description": "OpenBot Desktop: lets the Recorder find this computer's OpenBot",
        "path": path_to_exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{}/", shared_field("extensionId"))],
    })
}

fn windows_local_app_data(home: &Path, local_app_data: Option<&Path>) -> PathBuf {
    local_app_data
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join("AppData").join("Local"))
}

/// The per-user data directory, relative to its root, that each browser keeps on each OS.
fn data_directory(os: Os, browser: Browser, home: &Path, local_app_data: Option<&Path>) -> PathBuf {
    match os {
        Os::Mac => home
            .join("Library")
            .join("Application Support")
            .join(match browser {
                Browser::Chrome => "Google/Chrome",
                Browser::Edge => "Microsoft Edge",
                Browser::Chromium => "Chromium",
            }),
        Os::Linux => home.join(".config").join(match browser {
            Browser::Chrome => "google-chrome",
            Browser::Edge => "microsoft-edge",
            Browser::Chromium => "chromium",
        }),
        Os::Windows => {
            let base = windows_local_app_data(home, local_app_data);
            match browser {
                Browser::Chrome => base.join("Google").join("Chrome"),
                Browser::Edge => base.join("Microsoft").join("Edge"),
                Browser::Chromium => base.join("Chromium"),
            }
            .join("User Data")
        }
    }
}

/// Where the host manifest for one browser goes. Windows keeps one file for every browser and points each
/// browser's registry key at it.
pub fn host_manifest_location(
    os: Os,
    browser: Browser,
    home: &Path,
    local_app_data: Option<&Path>,
) -> PathBuf {
    match os {
        Os::Windows => windows_local_app_data(home, local_app_data)
            .join("OpenBot")
            .join("recorder")
            .join(manifest_file_name()),
        Os::Mac | Os::Linux => data_directory(os, browser, home, local_app_data)
            .join("NativeMessagingHosts")
            .join(manifest_file_name()),
    }
}

/// `reg.exe` arguments that point the browser's host key at the manifest file.
pub fn registry_commands(browser: Browser, manifest_path: &Path) -> Vec<Vec<String>> {
    let vendor = match browser {
        Browser::Chrome => "Google\\Chrome",
        Browser::Edge => "Microsoft\\Edge",
        Browser::Chromium => "Chromium",
    };
    vec![vec![
        "reg.exe".to_string(),
        "add".to_string(),
        format!(
            "HKCU\\Software\\{vendor}\\NativeMessagingHosts\\{}",
            host_name()
        ),
        "/ve".to_string(),
        "/t".to_string(),
        "REG_SZ".to_string(),
        "/d".to_string(),
        manifest_path.to_string_lossy().into_owned(),
        "/f".to_string(),
    ]]
}

/// The browser's per-user data directory exists.
pub fn browser_present(
    os: Os,
    browser: Browser,
    home: &Path,
    local_app_data: Option<&Path>,
    writer: &dyn InstallWriter,
) -> bool {
    writer.exists(&data_directory(os, browser, home, local_app_data))
}

/// The path a host manifest may name: one that still exists after this process exits.
pub fn stable_host_path(
    os: Os,
    current_exe: &Path,
    appimage: Option<&Path>,
) -> Result<PathBuf, Problem> {
    let exe = current_exe.to_string_lossy();
    match os {
        Os::Linux => {
            if let Some(appimage) = appimage {
                Ok(appimage.to_path_buf())
            } else if exe.starts_with("/tmp/.mount_") {
                Err(Problem::plain(
                    "Run OpenBot Desktop from its AppImage file to let the Recorder find it.",
                ))
            } else {
                Ok(current_exe.to_path_buf())
            }
        }
        Os::Mac if exe.contains("/AppTranslocation/") => Err(Problem::plain(
            "Move OpenBot Desktop to Applications to let the Recorder find it.",
        )),
        Os::Mac | Os::Windows => Ok(current_exe.to_path_buf()),
    }
}

fn write_manifest(
    writer: &mut dyn InstallWriter,
    path: &Path,
    stable_exe: &Path,
) -> Result<(), Problem> {
    writer
        .write_file(path, &host_manifest(stable_exe).to_string())
        .map_err(|error| {
            Problem::with(
                "OpenBot Desktop could not set up the Recorder.",
                format!("{}: {error}", path.display()),
            )
        })
}

/// Writes one host manifest per present browser, and on Windows registers each present browser's key.
pub fn install(
    stable_exe: &Path,
    home: &Path,
    local_app_data: Option<&Path>,
    os: Os,
    writer: &mut dyn InstallWriter,
) -> Result<Vec<PathBuf>, Problem> {
    let present: Vec<Browser> = BROWSERS
        .into_iter()
        .filter(|browser| browser_present(os, *browser, home, local_app_data, writer))
        .collect();
    if present.is_empty() {
        return Ok(Vec::new());
    }
    if os == Os::Windows {
        let manifest = host_manifest_location(os, present[0], home, local_app_data);
        write_manifest(writer, &manifest, stable_exe)?;
        for browser in present {
            for argv in registry_commands(browser, &manifest) {
                writer.run(&argv).map_err(|error| {
                    Problem::with(
                        "OpenBot Desktop could not set up the Recorder.",
                        format!("{}: {error}", argv.join(" ")),
                    )
                })?;
            }
        }
        return Ok(vec![manifest]);
    }
    let mut written = Vec::new();
    for browser in present {
        let manifest = host_manifest_location(os, browser, home, local_app_data);
        write_manifest(writer, &manifest, stable_exe)?;
        written.push(manifest);
    }
    Ok(written)
}

/// Runs `job` on its own thread, logs a failure, and returns at once.
pub fn spawn_recorder_host_install<F>(job: F) -> std::thread::JoinHandle<()>
where
    F: FnOnce() -> Result<Vec<PathBuf>, Problem> + Send + 'static,
{
    std::thread::spawn(move || {
        if let Err(problem) = job() {
            eprintln!(
                "[recorder] host install failed: {} {}",
                problem.said,
                problem.detail.unwrap_or_default()
            );
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};

    const ID: &str = "icpcnhgjghecmklnjbccdgdicklblcgd";

    #[derive(Default)]
    struct Recording {
        present: HashSet<PathBuf>,
        files: Vec<(PathBuf, String)>,
        commands: Vec<Vec<String>>,
    }
    impl InstallWriter for Recording {
        fn write_file(&mut self, path: &Path, contents: &str) -> std::io::Result<()> {
            self.files.push((path.to_path_buf(), contents.to_string()));
            Ok(())
        }
        fn run(&mut self, argv: &[String]) -> std::io::Result<()> {
            self.commands.push(argv.to_vec());
            Ok(())
        }
        fn exists(&self, path: &Path) -> bool {
            self.present.contains(path)
        }
    }

    fn home() -> PathBuf {
        PathBuf::from("/home/a")
    }

    #[test]
    fn manifest_names_the_host_the_path_and_only_the_fixed_origin() {
        let manifest = host_manifest(Path::new(
            "/Applications/OpenBot.app/Contents/MacOS/openbot",
        ));
        assert_eq!(
            manifest,
            serde_json::json!({
                "name": "ai.copilotkit.openbot.recorder",
                "description": "OpenBot Desktop: lets the Recorder find this computer's OpenBot",
                "path": "/Applications/OpenBot.app/Contents/MacOS/openbot",
                "type": "stdio",
                "allowed_origins": [format!("chrome-extension://{ID}/")],
            })
        );
        let text = manifest.to_string();
        assert!(!text.contains('*'));
    }

    #[test]
    fn locations_per_os_and_browser() {
        let h = home();
        let local = PathBuf::from("/c/Local");
        let expect = |os, browser, local_app_data: Option<&Path>, want: &str| {
            assert_eq!(
                host_manifest_location(os, browser, &h, local_app_data),
                PathBuf::from(want),
                "{os:?} {browser:?}"
            );
        };
        let file = "ai.copilotkit.openbot.recorder.json";
        let mac = |dir: &str| {
            format!("/home/a/Library/Application Support/{dir}/NativeMessagingHosts/{file}")
        };
        expect(Os::Mac, Browser::Chrome, None, &mac("Google/Chrome"));
        expect(Os::Mac, Browser::Edge, None, &mac("Microsoft Edge"));
        expect(Os::Mac, Browser::Chromium, None, &mac("Chromium"));
        let linux = |dir: &str| format!("/home/a/.config/{dir}/NativeMessagingHosts/{file}");
        expect(Os::Linux, Browser::Chrome, None, &linux("google-chrome"));
        expect(Os::Linux, Browser::Edge, None, &linux("microsoft-edge"));
        expect(Os::Linux, Browser::Chromium, None, &linux("chromium"));
        let windows = PathBuf::from("/c/Local")
            .join("OpenBot")
            .join("recorder")
            .join(file);
        for browser in [Browser::Chrome, Browser::Edge, Browser::Chromium] {
            assert_eq!(
                host_manifest_location(Os::Windows, browser, &h, Some(&local)),
                windows
            );
        }
    }

    #[test]
    fn windows_location_falls_back_to_the_profile_when_local_app_data_is_unset() {
        let got = host_manifest_location(Os::Windows, Browser::Chrome, &home(), None);
        assert_eq!(
            got,
            home()
                .join("AppData")
                .join("Local")
                .join("OpenBot")
                .join("recorder")
                .join("ai.copilotkit.openbot.recorder.json")
        );
    }

    #[test]
    fn registry_commands_set_the_default_value_under_each_browsers_key() {
        let path = Path::new(
            "C:\\Users\\a\\AppData\\Local\\OpenBot\\recorder\\ai.copilotkit.openbot.recorder.json",
        );
        let argv = |key: &str| {
            vec![vec![
                "reg.exe".to_string(),
                "add".to_string(),
                format!("{key}\\NativeMessagingHosts\\ai.copilotkit.openbot.recorder"),
                "/ve".to_string(),
                "/t".to_string(),
                "REG_SZ".to_string(),
                "/d".to_string(),
                path.to_string_lossy().into_owned(),
                "/f".to_string(),
            ]]
        };
        assert_eq!(
            registry_commands(Browser::Chrome, path),
            argv("HKCU\\Software\\Google\\Chrome")
        );
        assert_eq!(
            registry_commands(Browser::Edge, path),
            argv("HKCU\\Software\\Microsoft\\Edge")
        );
        assert_eq!(
            registry_commands(Browser::Chromium, path),
            argv("HKCU\\Software\\Chromium")
        );
    }

    #[test]
    fn browser_present_looks_for_each_browsers_user_data_directory() {
        let h = home();
        let local = PathBuf::from("/c/Local");
        let cases: Vec<(Os, Browser, PathBuf)> = vec![
            (
                Os::Mac,
                Browser::Chrome,
                h.join("Library/Application Support/Google/Chrome"),
            ),
            (
                Os::Mac,
                Browser::Edge,
                h.join("Library/Application Support/Microsoft Edge"),
            ),
            (
                Os::Mac,
                Browser::Chromium,
                h.join("Library/Application Support/Chromium"),
            ),
            (Os::Linux, Browser::Chrome, h.join(".config/google-chrome")),
            (Os::Linux, Browser::Edge, h.join(".config/microsoft-edge")),
            (Os::Linux, Browser::Chromium, h.join(".config/chromium")),
            (
                Os::Windows,
                Browser::Chrome,
                local.join("Google").join("Chrome").join("User Data"),
            ),
            (
                Os::Windows,
                Browser::Edge,
                local.join("Microsoft").join("Edge").join("User Data"),
            ),
            (
                Os::Windows,
                Browser::Chromium,
                local.join("Chromium").join("User Data"),
            ),
        ];
        for (os, browser, dir) in &cases {
            let mut writer = Recording::default();
            assert!(!browser_present(*os, *browser, &h, Some(&local), &writer));
            writer.present.insert(dir.clone());
            assert!(
                browser_present(*os, *browser, &h, Some(&local), &writer),
                "{os:?} {browser:?}"
            );
            for (other_os, other, _) in &cases {
                if (other_os, other) != (os, browser) && other_os == os {
                    assert!(!browser_present(
                        *other_os,
                        *other,
                        &h,
                        Some(&local),
                        &writer
                    ));
                }
            }
        }
    }

    #[test]
    fn an_appimage_run_names_the_appimage_itself() {
        let got = stable_host_path(
            Os::Linux,
            Path::new("/tmp/.mount_abc/usr/bin/openbot-desktop"),
            Some(Path::new("/home/a/OpenBot.AppImage")),
        );
        assert_eq!(got.unwrap(), PathBuf::from("/home/a/OpenBot.AppImage"));
    }

    #[test]
    fn a_mounted_binary_without_an_appimage_is_refused() {
        let got = stable_host_path(
            Os::Linux,
            Path::new("/tmp/.mount_abc/usr/bin/openbot-desktop"),
            None,
        );
        assert!(got.is_err());
    }

    #[test]
    fn a_translocated_mac_app_asks_to_be_moved() {
        let got = stable_host_path(
            Os::Mac,
            Path::new("/private/var/folders/x/T/AppTranslocation/1/d/OpenBot.app/Contents/MacOS/openbot-desktop"),
            None,
        );
        assert_eq!(
            got.unwrap_err().said,
            "Move OpenBot Desktop to Applications to let the Recorder find it."
        );
    }

    #[test]
    fn installed_paths_are_returned_unchanged() {
        let mac = Path::new("/Applications/OpenBot.app/Contents/MacOS/openbot-desktop");
        assert_eq!(stable_host_path(Os::Mac, mac, None).unwrap(), mac);
        let windows = Path::new("C:\\Program Files\\OpenBot\\openbot-desktop.exe");
        assert_eq!(
            stable_host_path(Os::Windows, windows, None).unwrap(),
            windows
        );
        let deb = Path::new("/usr/bin/openbot-desktop");
        assert_eq!(stable_host_path(Os::Linux, deb, None).unwrap(), deb);
    }

    #[test]
    fn install_writes_a_manifest_only_for_present_browsers() {
        let h = home();
        let mut writer = Recording::default();
        writer
            .present
            .insert(h.join("Library/Application Support/Google/Chrome"));
        writer
            .present
            .insert(h.join("Library/Application Support/Microsoft Edge"));
        let exe = Path::new("/Applications/OpenBot.app/Contents/MacOS/openbot-desktop");
        let written = install(exe, &h, None, Os::Mac, &mut writer).unwrap();
        assert_eq!(written.len(), 2);
        assert_eq!(writer.files.len(), 2);
        assert!(writer
            .files
            .iter()
            .all(|(p, _)| !p.to_string_lossy().contains("Chromium")));
        assert!(writer.commands.is_empty());
        for (path, contents) in &writer.files {
            assert!(written.contains(path));
            let json: serde_json::Value = serde_json::from_str(contents).unwrap();
            assert_eq!(json["path"], exe.to_string_lossy().as_ref());
            assert_eq!(
                json["allowed_origins"],
                serde_json::json!([format!("chrome-extension://{ID}/")])
            );
        }
    }

    #[test]
    fn install_writes_nothing_when_no_browser_is_installed() {
        let mut writer = Recording::default();
        let written = install(
            Path::new("/usr/bin/openbot-desktop"),
            &home(),
            None,
            Os::Linux,
            &mut writer,
        )
        .unwrap();
        assert!(written.is_empty());
        assert!(writer.files.is_empty());
        assert!(writer.commands.is_empty());
    }

    #[test]
    fn install_on_windows_writes_one_manifest_and_registers_present_browsers_only() {
        let h = home();
        let local = PathBuf::from("/c/Local");
        let mut writer = Recording::default();
        writer
            .present
            .insert(local.join("Google").join("Chrome").join("User Data"));
        writer
            .present
            .insert(local.join("Chromium").join("User Data"));
        let exe = Path::new("C:\\Program Files\\OpenBot\\openbot-desktop.exe");
        let written = install(exe, &h, Some(&local), Os::Windows, &mut writer).unwrap();
        let manifest = local
            .join("OpenBot")
            .join("recorder")
            .join("ai.copilotkit.openbot.recorder.json");
        assert_eq!(written, vec![manifest.clone()]);
        assert_eq!(writer.files.len(), 1);
        assert_eq!(writer.files[0].0, manifest);
        assert_eq!(writer.commands.len(), 2);
        assert!(writer.commands[0][2].contains("HKCU\\Software\\Google\\Chrome"));
        assert!(writer.commands[1][2].contains("HKCU\\Software\\Chromium"));
        assert!(writer
            .commands
            .iter()
            .all(|c| c[7] == manifest.to_string_lossy().as_ref()));
    }

    #[test]
    fn spawning_the_install_returns_at_once() {
        let started = std::time::Instant::now();
        let handle = spawn_recorder_host_install(|| {
            std::thread::sleep(std::time::Duration::from_secs(2));
            Ok(vec![])
        });
        assert!(started.elapsed() < std::time::Duration::from_millis(100));
        handle.join().unwrap();
    }

    #[test]
    fn a_failed_install_job_neither_panics_nor_blocks() {
        let handle = spawn_recorder_host_install(|| Err(Problem::plain("nope")));
        assert!(handle.join().is_ok());
    }
}
