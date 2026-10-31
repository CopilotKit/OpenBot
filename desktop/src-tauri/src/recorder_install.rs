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
//! - On macOS and Linux a browser reads its per-user manifests from `NativeMessagingHosts` inside its user data
//!   directory, and on Linux that directory is under `$XDG_CONFIG_HOME` when it is set (and under `$CHROME_CONFIG_HOME`
//!   for Chrome and Chromium when that is set), not always under `~/.config`:
//!   <https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md>
//!
//! A browser installed after Desktop started is found too. On Windows every browser's key is written whether or not the
//! browser is there yet: the manifest lives in OpenBot's own folder, and a key no browser reads changes nothing. On macOS
//! and Linux a manifest goes inside the browser's own folder, which is not made for a browser that is not there, so the
//! app checks again every minute and writes only what is missing or different.
//!
//! `allowed_origins` never holds a wildcard, and holds only the Recorder's own ids, exactly, in debug and release builds
//! alike: its one fixed id, and each id the browsers' stores gave it once it is published there (`storeIds`, empty
//! until then). The Chrome Web Store keeps the fixed id when the first upload carries the key; Edge Add-ons always
//! gives its own, so a Recorder added from Edge Add-ons asks the host under that id.
use crate::problem::Problem;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

/// The native host's name and the Recorder's ids, read once from shared/recorder-extension.json, the file the extension
/// and the server read too.
struct RecorderExtension {
    native_host: String,
    extension_id: String,
    store_ids: StoreIds,
}

/// The Recorder's ids in the browsers' own stores: None until it is published there.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StoreIds {
    /// The Chrome Web Store's.
    pub chrome: Option<String>,
    /// Edge Add-ons'.
    pub edge: Option<String>,
}

impl StoreIds {
    /// `storeIds` from the shared file. An empty id is none, and so is one that is not an extension id: a store id
    /// names a file and a registry key, so nothing else may stand in for one.
    fn from_shared(shared: &Value) -> Self {
        let id = |store: &str| {
            shared
                .get("storeIds")
                .and_then(|ids| ids.get(store))
                .and_then(Value::as_str)
                .filter(|id| is_extension_id(id))
                .map(str::to_string)
        };
        StoreIds {
            chrome: id("chrome"),
            edge: id("edge"),
        }
    }

    /// The id the store `browser` installs from gave the Recorder. Chromium has no store of its own.
    pub fn for_browser(&self, browser: Browser) -> Option<&str> {
        match browser {
            Browser::Chrome => self.chrome.as_deref(),
            Browser::Edge => self.edge.as_deref(),
            Browser::Chromium => None,
        }
    }
}

/// An extension id as Chrome makes one: 32 letters from a to p.
pub fn is_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

fn recorder_extension() -> &'static RecorderExtension {
    static PARSED: OnceLock<RecorderExtension> = OnceLock::new();
    PARSED.get_or_init(|| {
        let shared: Value =
            serde_json::from_str(include_str!("../../../shared/recorder-extension.json"))
                .expect("shared/recorder-extension.json is not JSON");
        let field = |name: &str| {
            shared
                .get(name)
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| panic!("shared/recorder-extension.json has no {name}"))
        };
        RecorderExtension {
            native_host: field("nativeHost"),
            extension_id: field("extensionId"),
            store_ids: StoreIds::from_shared(&shared),
        }
    })
}

/// The native host's name, the one the extension asks Chrome for.
pub fn host_name() -> &'static str {
    &recorder_extension().native_host
}

/// `chrome-extension://<the Recorder's fixed id>/`.
pub fn extension_origin() -> String {
    format!("chrome-extension://{}/", recorder_extension().extension_id)
}

/// The Recorder's ids in the stores, from the shared file.
pub fn store_ids() -> &'static StoreIds {
    &recorder_extension().store_ids
}

/// Every origin a manifest allows and the host answers: the fixed id's, then each store id's that differs from it.
pub fn allowed_origins() -> Vec<String> {
    allowed_origins_with(store_ids())
}

/// [`allowed_origins`] for the store ids given.
pub fn allowed_origins_with(store: &StoreIds) -> Vec<String> {
    let mut origins = vec![extension_origin()];
    for id in [store.chrome.as_deref(), store.edge.as_deref()]
        .into_iter()
        .flatten()
    {
        let origin = format!("chrome-extension://{id}/");
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    origins
}

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

impl Os {
    /// The OS this binary was built for.
    pub fn current() -> Self {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Linux
        }
    }
}

/// This person's folders, as the environment names them.
#[derive(Clone, Copy, Debug)]
pub struct UserDirs<'a> {
    pub home: &'a Path,
    /// `$XDG_CONFIG_HOME`. Only Linux reads it.
    pub xdg_config_home: Option<&'a Path>,
    /// `$CHROME_CONFIG_HOME`. Only Chrome and Chromium on Linux read it, ahead of `$XDG_CONFIG_HOME`.
    pub chrome_config_home: Option<&'a Path>,
    /// `%LOCALAPPDATA%`. Only Windows reads it, and falls back to `<home>\AppData\Local`.
    pub local_app_data: Option<&'a Path>,
}

impl<'a> UserDirs<'a> {
    /// Only `home`: every other folder at its default.
    pub fn at(home: &'a Path) -> Self {
        Self {
            home,
            xdg_config_home: None,
            chrome_config_home: None,
            local_app_data: None,
        }
    }
}

/// A Linux configuration folder named by an environment variable. A browser takes a relative value relative to whatever
/// folder it was started in, which Desktop cannot know, so only an absolute one is followed. Checked as text, so the
/// answer is the same on every OS the tests run on.
fn absolute(path: Option<&Path>) -> Option<PathBuf> {
    path.filter(|path| path.to_string_lossy().starts_with('/'))
        .map(Path::to_path_buf)
}

/// Linux's per-user configuration folder: an absolute `$XDG_CONFIG_HOME`, or `~/.config`. Tauri's own config folder
/// follows the same rule (see `recorder_host::app_config_dir`).
pub fn linux_config_dir(home: &Path, xdg_config_home: Option<&Path>) -> PathBuf {
    absolute(xdg_config_home).unwrap_or_else(|| home.join(".config"))
}

/// The side effects of an install, so tests can watch them without touching the computer.
pub trait InstallWriter {
    /// Writes the file, creating its parent directories first.
    fn write_file(&mut self, path: &Path, contents: &str) -> std::io::Result<()>;
    /// The file's contents, None when it cannot be read.
    fn read_file(&self, path: &Path) -> Option<String>;
    /// Removes the file. One that is already gone is not an error.
    fn remove_file(&mut self, path: &Path) -> std::io::Result<()>;
    fn run(&mut self, argv: &[String]) -> std::io::Result<()>;
    fn exists(&self, path: &Path) -> bool;
}

const BROWSERS: [Browser; 3] = [Browser::Chrome, Browser::Edge, Browser::Chromium];

fn manifest_file_name() -> String {
    format!("{}.json", host_name())
}

/// The host manifest Chrome, Edge and Chromium read.
pub fn host_manifest(path_to_exe: &Path) -> Value {
    host_manifest_with(path_to_exe, store_ids())
}

/// [`host_manifest`] for the store ids given.
pub fn host_manifest_with(path_to_exe: &Path, store: &StoreIds) -> Value {
    json!({
        "name": host_name(),
        "description": "OpenBot Desktop: lets the Recorder find this computer's OpenBot",
        "path": path_to_exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": allowed_origins_with(store),
    })
}

fn windows_local_app_data(dirs: UserDirs) -> PathBuf {
    dirs.local_app_data
        .map(Path::to_path_buf)
        .unwrap_or_else(|| dirs.home.join("AppData").join("Local"))
}

/// The per-user data directory each browser keeps on each OS.
pub fn data_directory(os: Os, browser: Browser, dirs: UserDirs) -> PathBuf {
    match os {
        Os::Mac => dirs
            .home
            .join("Library")
            .join("Application Support")
            .join(match browser {
                Browser::Chrome => "Google/Chrome",
                Browser::Edge => "Microsoft Edge",
                Browser::Chromium => "Chromium",
            }),
        Os::Linux => {
            let config = match browser {
                Browser::Chrome | Browser::Chromium => absolute(dirs.chrome_config_home),
                Browser::Edge => None,
            }
            .unwrap_or_else(|| linux_config_dir(dirs.home, dirs.xdg_config_home));
            config.join(match browser {
                Browser::Chrome => "google-chrome",
                Browser::Edge => "microsoft-edge",
                Browser::Chromium => "chromium",
            })
        }
        Os::Windows => {
            let base = windows_local_app_data(dirs);
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
pub fn host_manifest_location(os: Os, browser: Browser, dirs: UserDirs) -> PathBuf {
    match os {
        Os::Windows => windows_local_app_data(dirs)
            .join("OpenBot")
            .join("recorder")
            .join(manifest_file_name()),
        Os::Mac | Os::Linux => data_directory(os, browser, dirs)
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
    dirs: UserDirs,
    writer: &dyn InstallWriter,
) -> bool {
    writer.exists(&data_directory(os, browser, dirs))
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

/// Writes the manifest unless the file already says exactly that.
fn write_manifest(
    writer: &mut dyn InstallWriter,
    path: &Path,
    stable_exe: &Path,
) -> Result<(), Problem> {
    let contents = host_manifest(stable_exe).to_string();
    if writer.read_file(path).as_deref() == Some(contents.as_str()) {
        return Ok(());
    }
    writer.write_file(path, &contents).map_err(|error| {
        Problem::with(
            "OpenBot Desktop could not set up the Recorder.",
            format!("{}: {error}", path.display()),
        )
    })
}

/// Lets each browser find the host, and returns the manifests in place. On Windows: one manifest, and every browser's
/// registry key pointed at it. On macOS and Linux: one manifest in each present browser's own folder.
pub fn install(
    stable_exe: &Path,
    dirs: UserDirs,
    os: Os,
    writer: &mut dyn InstallWriter,
) -> Result<Vec<PathBuf>, Problem> {
    if os == Os::Windows {
        let manifest = host_manifest_location(os, Browser::Chrome, dirs);
        write_manifest(writer, &manifest, stable_exe)?;
        for browser in BROWSERS {
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
    for browser in BROWSERS {
        if !browser_present(os, browser, dirs, writer) {
            continue;
        }
        let manifest = host_manifest_location(os, browser, dirs);
        write_manifest(writer, &manifest, stable_exe)?;
        written.push(manifest);
    }
    Ok(written)
}

/// How often the app checks again for a browser installed since it started. None on Windows, where the first install
/// already registers every browser.
pub fn recheck_interval(os: Os) -> Option<Duration> {
    (os != Os::Windows).then_some(Duration::from_secs(60))
}

/// Runs `job` on its own thread and returns at once. With `every`, runs it again after each wait for as long as the app
/// runs. A failure is logged, once until it changes, and never stops the checks.
pub fn keep_recorder_host_installed<F>(
    job: F,
    every: Option<Duration>,
) -> std::thread::JoinHandle<()>
where
    F: Fn() -> Result<Vec<PathBuf>, Problem> + Send + 'static,
{
    std::thread::spawn(move || run_install_rounds(&job, every, None))
}

/// One round, then one more after each `every`, up to `rounds` in all (None: no limit).
fn run_install_rounds<F>(job: &F, every: Option<Duration>, rounds: Option<usize>)
where
    F: Fn() -> Result<Vec<PathBuf>, Problem>,
{
    let mut last_failure = None;
    let mut done = 0;
    loop {
        match job() {
            Ok(_) => last_failure = None,
            Err(problem) => {
                let said = format!("{} {}", problem.said, problem.detail.unwrap_or_default());
                if last_failure.as_ref() != Some(&said) {
                    eprintln!("[recorder] host install failed: {said}");
                    last_failure = Some(said);
                }
            }
        }
        done += 1;
        let Some(every) = every else { return };
        if rounds.is_some_and(|rounds| done >= rounds) {
            return;
        }
        std::thread::sleep(every);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const ID: &str = "icpcnhgjghecmklnjbccdgdicklblcgd";

    #[derive(Default)]
    struct Recording {
        present: HashSet<PathBuf>,
        on_disk: HashMap<PathBuf, String>,
        files: Vec<(PathBuf, String)>,
        commands: Vec<Vec<String>>,
    }
    impl InstallWriter for Recording {
        fn write_file(&mut self, path: &Path, contents: &str) -> std::io::Result<()> {
            self.files.push((path.to_path_buf(), contents.to_string()));
            self.on_disk
                .insert(path.to_path_buf(), contents.to_string());
            Ok(())
        }
        fn read_file(&self, path: &Path) -> Option<String> {
            self.on_disk.get(path).cloned()
        }
        fn remove_file(&mut self, path: &Path) -> std::io::Result<()> {
            self.on_disk.remove(path);
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

    /// The origins a manifest must allow, read from the shared file here rather than through the code under test: the
    /// fixed id's, then each store id's that is set and differs.
    fn shared_origins() -> Value {
        let shared: Value =
            serde_json::from_str(include_str!("../../../shared/recorder-extension.json")).unwrap();
        let mut origins = vec![format!("chrome-extension://{ID}/")];
        for store in ["chrome", "edge"] {
            let id = shared["storeIds"][store].as_str().unwrap_or_default();
            let origin = format!("chrome-extension://{id}/");
            if !id.is_empty() && !origins.contains(&origin) {
                origins.push(origin);
            }
        }
        serde_json::json!(origins)
    }

    #[test]
    fn the_host_name_and_origin_come_from_the_shared_file() {
        let shared: Value =
            serde_json::from_str(include_str!("../../../shared/recorder-extension.json")).unwrap();
        assert_eq!(host_name(), shared["nativeHost"]);
        assert_eq!(host_name(), "ai.copilotkit.openbot.recorder");
        assert_eq!(
            extension_origin(),
            format!(
                "chrome-extension://{}/",
                shared["extensionId"].as_str().unwrap()
            )
        );
        assert_eq!(extension_origin(), format!("chrome-extension://{ID}/"));
    }

    #[test]
    fn manifest_names_the_host_the_path_and_only_the_recorders_own_origins() {
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
                "allowed_origins": shared_origins(),
            })
        );
        let text = manifest.to_string();
        assert!(!text.contains('*'));
    }

    const CHROME_STORE: &str = "abcdefghijklmnopabcdefghijklmnop";
    const EDGE_STORE: &str = "ponmlkjihgfedcbaponmlkjihgfedcba";

    #[test]
    fn the_shared_files_store_ids_are_each_empty_or_an_extension_id() {
        let shared: Value =
            serde_json::from_str(include_str!("../../../shared/recorder-extension.json")).unwrap();
        for store in ["chrome", "edge"] {
            let id = shared["storeIds"][store]
                .as_str()
                .unwrap_or_else(|| panic!("storeIds.{store} is not a string"));
            assert!(
                id.is_empty() || is_extension_id(id),
                "storeIds.{store}: {id:?}"
            );
            assert_eq!(
                StoreIds::from_shared(&shared).for_browser(if store == "chrome" {
                    Browser::Chrome
                } else {
                    Browser::Edge
                }),
                (!id.is_empty()).then_some(id)
            );
        }
    }

    #[test]
    fn a_store_id_is_read_only_when_it_is_an_extension_id() {
        let read = |chrome: &str, edge: &str| {
            StoreIds::from_shared(
                &serde_json::json!({ "storeIds": { "chrome": chrome, "edge": edge } }),
            )
        };
        assert_eq!(read("", ""), StoreIds::default());
        assert_eq!(
            read(CHROME_STORE, EDGE_STORE),
            StoreIds {
                chrome: Some(CHROME_STORE.into()),
                edge: Some(EDGE_STORE.into()),
            }
        );
        // An id names a file and a registry key: nothing but an extension id stands in for one.
        for bad in [
            "../../../../.ssh/authorized_keys",
            "ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP",
            "abcdefghijklmnopabcdefghijklmnoq",
            "abcdefghijklmnop",
            "abcdefghijklmnopabcdefghijklmnopa",
        ] {
            assert_eq!(read(bad, bad), StoreIds::default(), "{bad}");
        }
        assert_eq!(
            StoreIds::from_shared(&serde_json::json!({})),
            StoreIds::default()
        );
        assert_eq!(read(CHROME_STORE, "").for_browser(Browser::Chromium), None);
    }

    #[test]
    fn the_manifest_allows_each_store_id_exactly_and_the_fixed_one_once() {
        let exe = Path::new("/Applications/OpenBot.app/Contents/MacOS/openbot");
        let both = StoreIds {
            chrome: Some(CHROME_STORE.into()),
            edge: Some(EDGE_STORE.into()),
        };
        assert_eq!(
            host_manifest_with(exe, &both)["allowed_origins"],
            serde_json::json!([
                format!("chrome-extension://{ID}/"),
                format!("chrome-extension://{CHROME_STORE}/"),
                format!("chrome-extension://{EDGE_STORE}/"),
            ])
        );
        // The Chrome Web Store kept the fixed id, as it does when the first upload carries the key.
        let kept = StoreIds {
            chrome: Some(ID.into()),
            edge: Some(EDGE_STORE.into()),
        };
        assert_eq!(
            allowed_origins_with(&kept),
            vec![
                format!("chrome-extension://{ID}/"),
                format!("chrome-extension://{EDGE_STORE}/"),
            ]
        );
        assert_eq!(
            allowed_origins_with(&StoreIds::default()),
            vec![format!("chrome-extension://{ID}/")]
        );
        assert!(!host_manifest_with(exe, &both).to_string().contains('*'));
        // What is installed is what the shared file says.
        assert_eq!(host_manifest(exe), host_manifest_with(exe, store_ids()));
    }

    #[test]
    fn locations_per_os_and_browser() {
        let h = home();
        let local = PathBuf::from("/c/Local");
        let expect = |os, browser, dirs: UserDirs, want: &str| {
            assert_eq!(
                host_manifest_location(os, browser, dirs),
                PathBuf::from(want),
                "{os:?} {browser:?}"
            );
        };
        let file = "ai.copilotkit.openbot.recorder.json";
        let mac = |dir: &str| {
            format!("/home/a/Library/Application Support/{dir}/NativeMessagingHosts/{file}")
        };
        let plain = UserDirs::at(&h);
        expect(Os::Mac, Browser::Chrome, plain, &mac("Google/Chrome"));
        expect(Os::Mac, Browser::Edge, plain, &mac("Microsoft Edge"));
        expect(Os::Mac, Browser::Chromium, plain, &mac("Chromium"));
        let linux = |dir: &str| format!("/home/a/.config/{dir}/NativeMessagingHosts/{file}");
        expect(Os::Linux, Browser::Chrome, plain, &linux("google-chrome"));
        expect(Os::Linux, Browser::Edge, plain, &linux("microsoft-edge"));
        expect(Os::Linux, Browser::Chromium, plain, &linux("chromium"));
        let windows = PathBuf::from("/c/Local")
            .join("OpenBot")
            .join("recorder")
            .join(file);
        let with_local = UserDirs {
            local_app_data: Some(&local),
            ..plain
        };
        for browser in [Browser::Chrome, Browser::Edge, Browser::Chromium] {
            assert_eq!(
                host_manifest_location(Os::Windows, browser, with_local),
                windows
            );
        }
    }

    #[test]
    fn linux_follows_an_absolute_xdg_config_home_and_chrome_config_home() {
        let h = home();
        let xdg = PathBuf::from("/xdg");
        let chrome = PathBuf::from("/chrome-config");
        let file = "NativeMessagingHosts/ai.copilotkit.openbot.recorder.json";
        let with_xdg = UserDirs {
            xdg_config_home: Some(&xdg),
            ..UserDirs::at(&h)
        };
        for (browser, dir) in [
            (Browser::Chrome, "google-chrome"),
            (Browser::Edge, "microsoft-edge"),
            (Browser::Chromium, "chromium"),
        ] {
            assert_eq!(
                host_manifest_location(Os::Linux, browser, with_xdg),
                PathBuf::from(format!("/xdg/{dir}/{file}")),
                "{browser:?}"
            );
        }
        // Chrome and Chromium read $CHROME_CONFIG_HOME ahead of $XDG_CONFIG_HOME; Edge does not.
        let with_both = UserDirs {
            chrome_config_home: Some(&chrome),
            ..with_xdg
        };
        assert_eq!(
            host_manifest_location(Os::Linux, Browser::Chrome, with_both),
            PathBuf::from(format!("/chrome-config/google-chrome/{file}"))
        );
        assert_eq!(
            host_manifest_location(Os::Linux, Browser::Chromium, with_both),
            PathBuf::from(format!("/chrome-config/chromium/{file}"))
        );
        assert_eq!(
            host_manifest_location(Os::Linux, Browser::Edge, with_both),
            PathBuf::from(format!("/xdg/microsoft-edge/{file}"))
        );
        // An empty or relative value cannot be resolved the way the browser would, so ~/.config stands.
        for ignored in ["", "relative/config"] {
            let ignored = PathBuf::from(ignored);
            let dirs = UserDirs {
                xdg_config_home: Some(&ignored),
                chrome_config_home: Some(&ignored),
                ..UserDirs::at(&h)
            };
            assert_eq!(
                host_manifest_location(Os::Linux, Browser::Chrome, dirs),
                PathBuf::from(format!("/home/a/.config/google-chrome/{file}")),
                "{ignored:?}"
            );
        }
        // Neither variable moves anything on macOS.
        assert_eq!(
            host_manifest_location(Os::Mac, Browser::Chrome, with_both),
            host_manifest_location(Os::Mac, Browser::Chrome, UserDirs::at(&h))
        );
    }

    #[test]
    fn install_on_linux_writes_into_the_browser_folder_under_xdg_config_home() {
        let h = home();
        let xdg = PathBuf::from("/xdg");
        let dirs = UserDirs {
            xdg_config_home: Some(&xdg),
            ..UserDirs::at(&h)
        };
        let mut writer = Recording::default();
        writer.present.insert(xdg.join("google-chrome"));
        writer.present.insert(h.join(".config").join("chromium"));
        let written = install(
            Path::new("/usr/bin/openbot-desktop"),
            dirs,
            Os::Linux,
            &mut writer,
        )
        .unwrap();
        assert_eq!(
            written,
            vec![xdg
                .join("google-chrome")
                .join("NativeMessagingHosts")
                .join("ai.copilotkit.openbot.recorder.json")]
        );
    }

    #[test]
    fn windows_location_falls_back_to_the_profile_when_local_app_data_is_unset() {
        let h = home();
        let got = host_manifest_location(Os::Windows, Browser::Chrome, UserDirs::at(&h));
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
        let dirs = UserDirs {
            local_app_data: Some(&local),
            ..UserDirs::at(&h)
        };
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
            assert!(!browser_present(*os, *browser, dirs, &writer));
            writer.present.insert(dir.clone());
            assert!(
                browser_present(*os, *browser, dirs, &writer),
                "{os:?} {browser:?}"
            );
            for (other_os, other, _) in &cases {
                if (other_os, other) != (os, browser) && other_os == os {
                    assert!(!browser_present(*other_os, *other, dirs, &writer));
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
        let written = install(exe, UserDirs::at(&h), Os::Mac, &mut writer).unwrap();
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
            assert_eq!(json["allowed_origins"], shared_origins());
        }
    }

    #[test]
    fn install_writes_nothing_when_no_browser_is_installed() {
        let h = home();
        let mut writer = Recording::default();
        let written = install(
            Path::new("/usr/bin/openbot-desktop"),
            UserDirs::at(&h),
            Os::Linux,
            &mut writer,
        )
        .unwrap();
        assert!(written.is_empty());
        assert!(writer.files.is_empty());
        assert!(writer.commands.is_empty());
    }

    #[test]
    fn a_browser_installed_after_the_first_round_gets_its_manifest_on_the_next() {
        let h = home();
        let exe = Path::new("/Applications/OpenBot.app/Contents/MacOS/openbot-desktop");
        let mut writer = Recording::default();
        writer
            .present
            .insert(h.join("Library/Application Support/Google/Chrome"));
        install(exe, UserDirs::at(&h), Os::Mac, &mut writer).unwrap();
        assert_eq!(writer.files.len(), 1);
        // The same round again rewrites nothing.
        install(exe, UserDirs::at(&h), Os::Mac, &mut writer).unwrap();
        assert_eq!(writer.files.len(), 1);
        writer
            .present
            .insert(h.join("Library/Application Support/Microsoft Edge"));
        let written = install(exe, UserDirs::at(&h), Os::Mac, &mut writer).unwrap();
        assert_eq!(written.len(), 2);
        assert_eq!(writer.files.len(), 2);
        assert!(writer.files[1]
            .0
            .to_string_lossy()
            .contains("Microsoft Edge"));
        // A manifest that names another binary is put right.
        let moved = Path::new("/Users/a/Applications/OpenBot.app/Contents/MacOS/openbot-desktop");
        install(moved, UserDirs::at(&h), Os::Mac, &mut writer).unwrap();
        assert_eq!(writer.files.len(), 4);
    }

    #[test]
    fn install_on_windows_writes_one_manifest_and_registers_every_browser_present_or_not() {
        let h = home();
        let local = PathBuf::from("/c/Local");
        let dirs = UserDirs {
            local_app_data: Some(&local),
            ..UserDirs::at(&h)
        };
        // No browser is there yet: each key is written anyway, so one installed later finds the host.
        let mut writer = Recording::default();
        let exe = Path::new("C:\\Program Files\\OpenBot\\openbot-desktop.exe");
        let written = install(exe, dirs, Os::Windows, &mut writer).unwrap();
        let manifest = local
            .join("OpenBot")
            .join("recorder")
            .join("ai.copilotkit.openbot.recorder.json");
        assert_eq!(written, vec![manifest.clone()]);
        assert_eq!(writer.files.len(), 1);
        assert_eq!(writer.files[0].0, manifest);
        assert_eq!(writer.commands.len(), 3);
        assert!(writer.commands[0][2].contains("HKCU\\Software\\Google\\Chrome"));
        assert!(writer.commands[1][2].contains("HKCU\\Software\\Microsoft\\Edge"));
        assert!(writer.commands[2][2].contains("HKCU\\Software\\Chromium"));
        assert!(writer
            .commands
            .iter()
            .all(|c| c[7] == manifest.to_string_lossy().as_ref()));
    }

    #[test]
    fn uninstalling_on_windows_removes_every_key_and_the_manifest_the_install_writes() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["bundle"]["windows"]["nsis"]["installerHooks"],
            "./windows/hooks.nsh"
        );
        let hooks = include_str!("../windows/hooks.nsh");
        let uninstall = hooks
            .split("!macro NSIS_HOOK_POSTUNINSTALL")
            .nth(1)
            .and_then(|rest| rest.split("!macroend").next())
            .expect("hooks.nsh has no NSIS_HOOK_POSTUNINSTALL");
        // An update runs the old uninstaller first; the registrations stay for the new version.
        assert!(uninstall.contains("${If} $UpdateMode <> 1"));
        for browser in BROWSERS {
            let key = registry_commands(browser, Path::new("manifest.json"))[0][2].clone();
            let key = key.strip_prefix("HKCU\\").unwrap();
            assert!(
                uninstall.contains(&format!("DeleteRegKey HKCU \"{key}\"")),
                "{key}"
            );
        }
        let local = PathBuf::from("/local");
        let manifest = host_manifest_location(
            Os::Windows,
            Browser::Chrome,
            UserDirs {
                local_app_data: Some(&local),
                ..UserDirs::at(Path::new("/home/a"))
            },
        );
        let relative: Vec<String> = manifest
            .strip_prefix(&local)
            .unwrap()
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect();
        assert!(uninstall.contains(&format!(
            "Delete \"$LOCALAPPDATA\\{}\"",
            relative.join("\\")
        )));
        // The person's browser profile used to survive uninstall, and the folder holding the
        // manifest was removed only when empty (RMDir without /r). Each of Desktop's
        // folders now goes with all it holds: the manifest's, and the browser's whole data root.
        let folder = relative[..relative.len() - 1].join("\\");
        assert!(
            uninstall.contains(&format!("RMDir /r \"$LOCALAPPDATA\\{folder}\"")),
            "{uninstall}"
        );
        let data = crate::local_browser::data_root(Os::Windows, Path::new("/home/a"), &|name| {
            (name == "LOCALAPPDATA").then(|| local.clone().into_os_string())
        });
        let data: Vec<String> = data
            .strip_prefix(&local)
            .unwrap()
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect();
        assert!(
            uninstall.contains(&format!("RMDir /r \"$LOCALAPPDATA\\{}\"", data.join("\\"))),
            "{uninstall}"
        );
    }

    /// On Linux nothing used to be removed on uninstall. The .deb's and the .rpm's
    /// removal script takes away, in each person's home and as that person, the browser's data root
    /// and every browser's host manifest, exactly where the code writes them, and on an upgrade
    /// nothing. Run here against a home laid out as Desktop leaves it, with `getent` and `runuser`
    /// standing in as their Linux selves answer.
    #[cfg(unix)]
    #[test]
    fn uninstalling_on_linux_removes_the_browser_profile_and_every_manifest() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        for package in ["deb", "rpm"] {
            assert_eq!(
                config["bundle"]["linux"][package]["postRemoveScript"], "./linux/remove.sh",
                "{package}"
            );
        }
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("linux/remove.sh");
        let scratch = crate::test_support::temp_root("linux-uninstall");
        let home = scratch.join("home/ada");
        let system = scratch.join("var/lib/daemon");
        let dirs = UserDirs::at(&home);
        let data_root = crate::local_browser::data_root(Os::Linux, &home, &|_| None);
        let mut left = vec![data_root.join("profiles/person-0123/Default/Cookies")];
        for browser in BROWSERS {
            left.push(host_manifest_location(Os::Linux, browser, dirs));
        }
        // The person's own things beside them, and a system account's, which stay.
        let theirs = [
            home.join(".config/google-chrome/Default/Bookmarks"),
            home.join(".config/google-chrome/NativeMessagingHosts/com.1password.json"),
            home.join(".local/share/openbot/deployment/docker-compose.yml"),
            system.join(".local/share/openbot/local-computer/profiles/x"),
        ];
        let bin = scratch.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let tool = |name: &str, body: String| {
            use std::os::unix::fs::PermissionsExt;
            let path = bin.join(name);
            std::fs::write(&path, body).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        // `getent passwd`, as a machine with root, a system account, one person and nobody lists it.
        tool(
            "getent",
            format!(
                "#!/bin/sh\n[ \"$1\" = passwd ] || exit 2\nprintf '%s\\n' 'root:x:0:0:root:/root:/bin/sh' 'daemon:x:999:999::{}:/usr/sbin/nologin' 'ada:x:1000:1000:Ada:{}:/bin/bash' 'nobody:x:65534:65534::/nonexistent:/usr/sbin/nologin'\n",
                system.display(),
                home.display()
            ),
        );
        // `runuser -u NAME -- COMMAND...`, writing down whom it ran as.
        tool(
            "runuser",
            format!(
                "#!/bin/sh\n[ \"$1\" = -u ] || exit 2\necho \"$2\" >> '{}'\nshift 2\n[ \"$1\" = -- ] || exit 2\nshift\nexec \"$@\"\n",
                scratch.join("ran-as").display()
            ),
        );
        let run = |argument: &str| {
            for file in left.iter().chain(theirs.iter()) {
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                std::fs::write(file, "x").unwrap();
            }
            let status = std::process::Command::new("/bin/sh")
                .arg(&script)
                .arg(argument)
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .status()
                .unwrap();
            assert!(status.success(), "{argument}");
        };
        for upgrade in ["upgrade", "1", "failed-upgrade"] {
            run(upgrade);
            assert!(left.iter().all(|file| file.exists()), "{upgrade}");
        }
        for removal in ["remove", "purge", "0"] {
            run(removal);
            for file in &left {
                assert!(!file.exists(), "{removal}: {}", file.display());
            }
            assert!(!data_root.exists(), "{removal}");
            for file in &theirs {
                assert!(file.exists(), "{removal}: {}", file.display());
            }
        }
        // Only as the person, never as root or a system account.
        let ran_as = std::fs::read_to_string(scratch.join("ran-as")).unwrap();
        assert!(ran_as.lines().all(|name| name == "ada"), "{ran_as}");
        std::fs::remove_dir_all(scratch).unwrap();
    }

    #[test]
    fn only_windows_needs_no_second_look() {
        assert_eq!(recheck_interval(Os::Windows), None);
        assert_eq!(recheck_interval(Os::Mac), Some(Duration::from_secs(60)));
        assert_eq!(recheck_interval(Os::Linux), Some(Duration::from_secs(60)));
    }

    #[test]
    fn the_install_runs_again_after_each_wait_and_a_failure_does_not_stop_it() {
        let calls = AtomicUsize::new(0);
        let job = || {
            if calls.fetch_add(1, Ordering::SeqCst) % 2 == 0 {
                Err(Problem::plain("nope"))
            } else {
                Ok(vec![])
            }
        };
        run_install_rounds(&job, Some(Duration::from_millis(1)), Some(4));
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        let once = AtomicUsize::new(0);
        run_install_rounds(
            &|| {
                once.fetch_add(1, Ordering::SeqCst);
                Ok(vec![])
            },
            None,
            Some(4),
        );
        assert_eq!(once.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn keeping_the_host_installed_returns_at_once() {
        let started = std::time::Instant::now();
        let handle = keep_recorder_host_installed(
            || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                Ok(vec![])
            },
            None,
        );
        assert!(started.elapsed() < std::time::Duration::from_millis(100));
        handle.join().unwrap();
    }

    #[test]
    fn a_failed_install_job_neither_panics_nor_blocks() {
        let handle = keep_recorder_host_installed(|| Err(Problem::plain("nope")), None);
        assert!(handle.join().is_ok());
    }
}
