//! Registers the Recorder, from the browsers' own stores, with the person's everyday Google Chrome and Microsoft Edge,
//! so the browser installs it itself and asks the person once to switch it on.
//!
//! This is Chrome's and Edge's own way for an application to bring an extension with it (an "external extension"):
//! an entry naming the extension's id and the store it updates from. Where each browser reads one, checked against
//! the official pages and Chromium's source:
//! - macOS, per person: `External Extensions/<id>.json` in the browser's user data directory
//!   (`~/Library/Application Support/Google/Chrome/`, `~/Library/Application Support/Microsoft Edge/`), holding
//!   `{"external_update_url": <the store's update address>}`. Read only when the browser starts, so the Recorder
//!   arrives at the person's next restart of it.
//!   <https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions>
//!   <https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/alternate-distribution-options>
//!   Chromium builds that folder from the user data directory (`DIR_USER_EXTERNAL_EXTENSIONS` in
//!   `chrome/common/chrome_paths.cc`), so it moves with `$XDG_CONFIG_HOME` on Linux as the native host's folder does.
//! - Linux: Edge reads `~/.config/microsoft-edge/External Extensions/`. Google Chrome reads only
//!   `/opt/google/chrome/extensions/` and `/usr/share/google-chrome/extensions/`, which only root can write, so Chrome is
//!   not registered on Linux; the person adds the Recorder from its store page.
//! - Windows: `HKCU\Software\Google\Chrome\Extensions\<id>` with an `update_url` value. Chromium reads HKCU as well as
//!   the HKLM key the page documents, and watches both while it runs, so the Recorder arrives without a restart
//!   (`chrome/browser/extensions/external_registry_loader_win.cc`). Edge documents only HKLM, which needs an
//!   administrator; it is the same Chromium code under `Software\Microsoft\Edge`, so its HKCU key is written too.
//!
//! Every profile installs it switched off and asks once. A person who chooses "Remove from Chrome" blocks it for that
//! profile, and it is not put back however often the entry is written.
//!
//! Only for a store id that is set in shared/recorder-extension.json. Until the Recorder is published both are empty,
//! and nothing is written. Desktop keeps a note of what it registered, so an id that changes, or is emptied, is taken
//! back out of each browser; nothing else in the browsers' folders or keys is touched, and a file that no longer holds
//! exactly what Desktop wrote is left alone.
use crate::problem::Problem;
use crate::recorder_host::app_config_dir;
use crate::recorder_install::{
    browser_present, data_directory, Browser, InstallWriter, Os, StoreIds, UserDirs,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The Chrome Web Store's update address, which an external entry names to install from it.
pub const CHROME_WEB_STORE_UPDATE_URL: &str = "https://clients2.google.com/service/update2/crx";

/// Edge Add-ons' update address.
pub const EDGE_ADD_ONS_UPDATE_URL: &str = "https://edge.microsoft.com/extensionwebstorebase/v1/crx";

/// The browsers with a store the Recorder is published in. Chromium has none.
const BROWSERS: [Browser; 2] = [Browser::Chrome, Browser::Edge];

/// What Desktop's note of its registrations is called.
const RECORD_FILE: &str = "recorder-store-extensions.json";

/// The store a browser installs from.
pub fn update_url(browser: Browser) -> &'static str {
    match browser {
        Browser::Edge => EDGE_ADD_ONS_UPDATE_URL,
        Browser::Chrome | Browser::Chromium => CHROME_WEB_STORE_UPDATE_URL,
    }
}

/// Where one browser reads the entry for one id on one OS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Entry {
    File(PathBuf),
    /// A key under HKCU, written as `reg.exe` takes it.
    RegistryKey(String),
}

/// The entry for `id` in `browser`, or None where Desktop cannot register it (Chrome on Linux, and Chromium).
pub fn entry(os: Os, browser: Browser, dirs: UserDirs, id: &str) -> Option<Entry> {
    match (os, browser) {
        (_, Browser::Chromium) | (Os::Linux, Browser::Chrome) => None,
        (Os::Mac | Os::Linux, _) => Some(Entry::File(
            data_directory(os, browser, dirs)
                .join("External Extensions")
                .join(format!("{id}.json")),
        )),
        (Os::Windows, Browser::Chrome) => Some(Entry::RegistryKey(format!(
            "HKCU\\Software\\Google\\Chrome\\Extensions\\{id}"
        ))),
        (Os::Windows, Browser::Edge) => Some(Entry::RegistryKey(format!(
            "HKCU\\Software\\Microsoft\\Edge\\Extensions\\{id}"
        ))),
    }
}

/// The file an entry is on macOS and Linux.
pub fn entry_contents(browser: Browser) -> String {
    json!({ "external_update_url": update_url(browser) }).to_string()
}

/// `reg.exe` arguments that set the key's `update_url` to the browser's store.
pub fn registry_add(key: &str, browser: Browser) -> Vec<String> {
    [
        "reg.exe",
        "add",
        key,
        "/v",
        "update_url",
        "/t",
        "REG_SZ",
        "/d",
        update_url(browser),
        "/f",
    ]
    .map(str::to_string)
    .to_vec()
}

/// `reg.exe` arguments that succeed only when the key is there.
pub fn registry_query(key: &str) -> Vec<String> {
    ["reg.exe", "query", key].map(str::to_string).to_vec()
}

/// `reg.exe` arguments that delete the key, without asking.
pub fn registry_delete(key: &str) -> Vec<String> {
    ["reg.exe", "delete", key, "/f"]
        .map(str::to_string)
        .to_vec()
}

/// Where Desktop keeps its note of what it registered: beside the native host's manifest on Windows (which the
/// uninstaller clears), and in Desktop's own configuration folder elsewhere.
pub fn record_location(os: Os, dirs: UserDirs) -> PathBuf {
    match os {
        Os::Windows => dirs
            .local_app_data
            .map(Path::to_path_buf)
            .unwrap_or_else(|| dirs.home.join("AppData").join("Local"))
            .join("OpenBot")
            .join("recorder")
            .join(RECORD_FILE),
        Os::Mac | Os::Linux => {
            app_config_dir(os, dirs.home, dirs.xdg_config_home, None).join(RECORD_FILE)
        }
    }
}

fn browser_key(browser: Browser) -> &'static str {
    match browser {
        Browser::Chrome => "chrome",
        Browser::Edge => "msedge",
        Browser::Chromium => "chromium",
    }
}

/// The (browser, id) pairs the note holds. A note that cannot be read holds nothing.
fn read_record(writer: &dyn InstallWriter, path: &Path) -> Vec<(Browser, String)> {
    let Some(text) = writer.read_file(path) else {
        return Vec::new();
    };
    let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let mut pairs = Vec::new();
    for browser in BROWSERS {
        let ids = record
            .get(browser_key(browser))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|id| crate::recorder_install::is_extension_id(id));
        for id in ids {
            pairs.push((browser, id.to_string()));
        }
    }
    pairs
}

fn record_text(pairs: &[(Browser, String)]) -> String {
    let mut record = serde_json::Map::new();
    for browser in BROWSERS {
        let ids: Vec<&str> = pairs
            .iter()
            .filter(|(each, _)| *each == browser)
            .map(|(_, id)| id.as_str())
            .collect();
        if !ids.is_empty() {
            record.insert(browser_key(browser).into(), json!(ids));
        }
    }
    Value::Object(record).to_string()
}

fn failed(detail: String) -> Problem {
    Problem::with(
        "OpenBot Desktop could not add the Recorder to your browser.",
        detail,
    )
}

/// Writes the entry unless it already says exactly that. Ok(None) where the browser is not installed (macOS and Linux),
/// so nothing is made inside a browser folder that is not there.
fn place(
    os: Os,
    browser: Browser,
    dirs: UserDirs,
    id: &str,
    writer: &mut dyn InstallWriter,
) -> Result<Option<Entry>, Problem> {
    let Some(entry) = entry(os, browser, dirs, id) else {
        return Ok(None);
    };
    match &entry {
        Entry::File(path) => {
            if !browser_present(os, browser, dirs, writer) {
                return Ok(None);
            }
            let contents = entry_contents(browser);
            if writer.read_file(path).as_deref() != Some(contents.as_str()) {
                writer
                    .write_file(path, &contents)
                    .map_err(|error| failed(format!("{}: {error}", path.display())))?;
            }
        }
        Entry::RegistryKey(key) => {
            let argv = registry_add(key, browser);
            writer
                .run(&argv)
                .map_err(|error| failed(format!("{}: {error}", argv.join(" "))))?;
        }
    }
    Ok(Some(entry))
}

/// Takes out the entry Desktop wrote for `id`: a file only while it holds exactly what Desktop wrote, a key only while
/// it is there.
fn take_out(
    os: Os,
    browser: Browser,
    dirs: UserDirs,
    id: &str,
    writer: &mut dyn InstallWriter,
) -> Result<(), Problem> {
    match entry(os, browser, dirs, id) {
        None => Ok(()),
        Some(Entry::File(path)) => {
            if writer.read_file(&path).as_deref() != Some(entry_contents(browser).as_str()) {
                return Ok(());
            }
            writer
                .remove_file(&path)
                .map_err(|error| failed(format!("{}: {error}", path.display())))
        }
        Some(Entry::RegistryKey(key)) => {
            if writer.run(&registry_query(&key)).is_err() {
                return Ok(());
            }
            let argv = registry_delete(&key);
            writer
                .run(&argv)
                .map_err(|error| failed(format!("{}: {error}", argv.join(" "))))
        }
    }
}

/// Registers the Recorder with each browser whose store id is set, takes out what an earlier id left, and returns the
/// entry files in place (the keys on Windows are not files, and are not listed). Idempotent. One browser's failure does
/// not stop the other's; the first is returned once both are done.
pub fn register(
    dirs: UserDirs,
    os: Os,
    store: &StoreIds,
    writer: &mut dyn InstallWriter,
) -> Result<Vec<PathBuf>, Problem> {
    let record = record_location(os, dirs);
    let before = read_record(writer, &record);
    let mut after: Vec<(Browser, String)> = Vec::new();
    let mut in_place = Vec::new();
    let mut first_failure = None;
    for browser in BROWSERS {
        let wanted = store.for_browser(browser);
        for (_, old) in before
            .iter()
            .filter(|(each, id)| *each == browser && Some(id.as_str()) != wanted)
        {
            if let Err(problem) = take_out(os, browser, dirs, old, writer) {
                // Kept in the note, so the next round tries again.
                after.push((browser, old.clone()));
                first_failure.get_or_insert(problem);
            }
        }
        let Some(id) = wanted else { continue };
        match place(os, browser, dirs, id, writer) {
            Ok(None) => {}
            Ok(Some(entry)) => {
                after.push((browser, id.to_string()));
                if let Entry::File(path) = entry {
                    in_place.push(path);
                }
            }
            Err(problem) => {
                // Noted all the same: a write that failed halfway is taken out if the id changes.
                after.push((browser, id.to_string()));
                first_failure.get_or_insert(problem);
            }
        }
    }
    if after.is_empty() {
        if writer.read_file(&record).is_some() {
            writer
                .remove_file(&record)
                .map_err(|error| failed(format!("{}: {error}", record.display())))?;
        }
    } else {
        let text = record_text(&after);
        if writer.read_file(&record).as_deref() != Some(text.as_str()) {
            writer
                .write_file(&record, &text)
                .map_err(|error| failed(format!("{}: {error}", record.display())))?;
        }
    }
    match first_failure {
        Some(problem) => Err(problem),
        None => Ok(in_place),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    const CHROME_ID: &str = "abcdefghijklmnopabcdefghijklmnop";
    const EDGE_ID: &str = "ponmlkjihgfedcbaponmlkjihgfedcba";
    const NEW_EDGE_ID: &str = "aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb";

    /// A computer's files and registry, as far as the registration sees them.
    #[derive(Default)]
    struct Computer {
        present: HashSet<PathBuf>,
        files: HashMap<PathBuf, String>,
        keys: HashMap<String, String>,
        writes: Vec<PathBuf>,
        commands: Vec<Vec<String>>,
        failing: Option<PathBuf>,
    }

    impl InstallWriter for Computer {
        fn write_file(&mut self, path: &Path, contents: &str) -> std::io::Result<()> {
            if self.failing.as_deref() == Some(path) {
                return Err(std::io::Error::other("read-only"));
            }
            self.writes.push(path.to_path_buf());
            self.files.insert(path.to_path_buf(), contents.to_string());
            Ok(())
        }
        fn read_file(&self, path: &Path) -> Option<String> {
            self.files.get(path).cloned()
        }
        fn remove_file(&mut self, path: &Path) -> std::io::Result<()> {
            self.files.remove(path);
            Ok(())
        }
        fn run(&mut self, argv: &[String]) -> std::io::Result<()> {
            self.commands.push(argv.to_vec());
            match argv.get(1).map(String::as_str) {
                Some("add") => {
                    self.keys.insert(argv[2].clone(), argv[8].clone());
                    Ok(())
                }
                Some("query") if self.keys.contains_key(&argv[2]) => Ok(()),
                Some("query") => Err(std::io::Error::other("not found")),
                Some("delete") => self
                    .keys
                    .remove(&argv[2])
                    .map(|_| ())
                    .ok_or_else(|| std::io::Error::other("not found")),
                _ => Err(std::io::Error::other("unknown command")),
            }
        }
        fn exists(&self, path: &Path) -> bool {
            self.present.contains(path)
        }
    }

    fn ids(chrome: Option<&str>, edge: Option<&str>) -> StoreIds {
        StoreIds {
            chrome: chrome.map(str::to_string),
            edge: edge.map(str::to_string),
        }
    }

    fn home() -> PathBuf {
        PathBuf::from("/Users/pat")
    }

    fn mac_folder(browser: &str) -> PathBuf {
        home()
            .join("Library")
            .join("Application Support")
            .join(browser)
    }

    #[test]
    fn where_each_browser_reads_an_entry_on_each_os() {
        let h = home();
        let xdg = PathBuf::from("/xdg");
        let local = PathBuf::from("C:\\Users\\pat\\AppData\\Local");
        let plain = UserDirs::at(&h);
        assert_eq!(
            entry(Os::Mac, Browser::Chrome, plain, CHROME_ID),
            Some(Entry::File(
                mac_folder("Google/Chrome")
                    .join("External Extensions")
                    .join(format!("{CHROME_ID}.json"))
            ))
        );
        assert_eq!(
            entry(Os::Mac, Browser::Edge, plain, EDGE_ID),
            Some(Entry::File(
                mac_folder("Microsoft Edge")
                    .join("External Extensions")
                    .join(format!("{EDGE_ID}.json"))
            ))
        );
        assert_eq!(
            entry(Os::Linux, Browser::Edge, plain, EDGE_ID),
            Some(Entry::File(PathBuf::from(format!(
                "/Users/pat/.config/microsoft-edge/External Extensions/{EDGE_ID}.json"
            ))))
        );
        // Edge's folder moves with $XDG_CONFIG_HOME, as its user data directory does.
        let with_xdg = UserDirs {
            xdg_config_home: Some(&xdg),
            ..plain
        };
        assert_eq!(
            entry(Os::Linux, Browser::Edge, with_xdg, EDGE_ID),
            Some(Entry::File(PathBuf::from(format!(
                "/xdg/microsoft-edge/External Extensions/{EDGE_ID}.json"
            ))))
        );
        // Google Chrome on Linux reads only folders root owns.
        assert_eq!(entry(Os::Linux, Browser::Chrome, plain, CHROME_ID), None);
        let windows = UserDirs {
            local_app_data: Some(&local),
            ..plain
        };
        assert_eq!(
            entry(Os::Windows, Browser::Chrome, windows, CHROME_ID),
            Some(Entry::RegistryKey(format!(
                "HKCU\\Software\\Google\\Chrome\\Extensions\\{CHROME_ID}"
            )))
        );
        assert_eq!(
            entry(Os::Windows, Browser::Edge, windows, EDGE_ID),
            Some(Entry::RegistryKey(format!(
                "HKCU\\Software\\Microsoft\\Edge\\Extensions\\{EDGE_ID}"
            )))
        );
        for os in [Os::Mac, Os::Linux, Os::Windows] {
            assert_eq!(entry(os, Browser::Chromium, plain, CHROME_ID), None);
        }
    }

    #[test]
    fn each_entry_names_its_own_browsers_store() {
        let chrome: Value = serde_json::from_str(&entry_contents(Browser::Chrome)).unwrap();
        assert_eq!(
            chrome,
            json!({ "external_update_url": "https://clients2.google.com/service/update2/crx" })
        );
        let edge: Value = serde_json::from_str(&entry_contents(Browser::Edge)).unwrap();
        assert_eq!(
            edge,
            json!({ "external_update_url": "https://edge.microsoft.com/extensionwebstorebase/v1/crx" })
        );
        let key = format!("HKCU\\Software\\Google\\Chrome\\Extensions\\{CHROME_ID}");
        assert_eq!(
            registry_add(&key, Browser::Chrome),
            [
                "reg.exe",
                "add",
                key.as_str(),
                "/v",
                "update_url",
                "/t",
                "REG_SZ",
                "/d",
                "https://clients2.google.com/service/update2/crx",
                "/f"
            ]
        );
        assert_eq!(
            registry_delete(&key),
            ["reg.exe", "delete", key.as_str(), "/f"]
        );
    }

    #[test]
    fn nothing_is_written_while_the_store_ids_are_empty() {
        for os in [Os::Mac, Os::Linux, Os::Windows] {
            let h = home();
            let mut computer = Computer::default();
            computer.present.insert(mac_folder("Google/Chrome"));
            computer.present.insert(mac_folder("Microsoft Edge"));
            computer
                .present
                .insert(h.join(".config").join("microsoft-edge"));
            let placed =
                register(UserDirs::at(&h), os, &StoreIds::default(), &mut computer).unwrap();
            assert!(placed.is_empty(), "{os:?}");
            assert!(computer.writes.is_empty(), "{os:?}");
            assert!(computer.commands.is_empty(), "{os:?}");
        }
    }

    #[test]
    fn macos_writes_each_installed_browsers_entry_once_and_notes_it() {
        let h = home();
        let dirs = UserDirs::at(&h);
        let mut computer = Computer::default();
        computer.present.insert(mac_folder("Google/Chrome"));
        let store = ids(Some(CHROME_ID), Some(EDGE_ID));
        let chrome_entry = mac_folder("Google/Chrome")
            .join("External Extensions")
            .join(format!("{CHROME_ID}.json"));
        // Edge is not installed: nothing is made inside a folder of its that is not there.
        assert_eq!(
            register(dirs, Os::Mac, &store, &mut computer).unwrap(),
            vec![chrome_entry.clone()]
        );
        assert_eq!(
            computer.files[&chrome_entry],
            entry_contents(Browser::Chrome)
        );
        assert!(!computer
            .files
            .keys()
            .any(|path| path.starts_with(mac_folder("Microsoft Edge"))));
        let record = record_location(Os::Mac, dirs);
        assert_eq!(
            record,
            mac_folder("ai.copilotkit.openbot.desktop").join("recorder-store-extensions.json")
        );
        assert_eq!(
            serde_json::from_str::<Value>(&computer.files[&record]).unwrap(),
            json!({ "chrome": [CHROME_ID] })
        );
        // Again: nothing is rewritten.
        let writes = computer.writes.len();
        register(dirs, Os::Mac, &store, &mut computer).unwrap();
        assert_eq!(computer.writes.len(), writes);
        // Edge installed since: its entry is added, and the note with it.
        computer.present.insert(mac_folder("Microsoft Edge"));
        let placed = register(dirs, Os::Mac, &store, &mut computer).unwrap();
        assert_eq!(placed.len(), 2);
        assert_eq!(
            computer.files[&mac_folder("Microsoft Edge")
                .join("External Extensions")
                .join(format!("{EDGE_ID}.json"))],
            entry_contents(Browser::Edge)
        );
        assert_eq!(
            serde_json::from_str::<Value>(&computer.files[&record]).unwrap(),
            json!({ "chrome": [CHROME_ID], "msedge": [EDGE_ID] })
        );
    }

    #[test]
    fn linux_registers_edge_only() {
        let h = home();
        let dirs = UserDirs::at(&h);
        let mut computer = Computer::default();
        computer
            .present
            .insert(h.join(".config").join("google-chrome"));
        computer
            .present
            .insert(h.join(".config").join("microsoft-edge"));
        let placed = register(
            dirs,
            Os::Linux,
            &ids(Some(CHROME_ID), Some(EDGE_ID)),
            &mut computer,
        )
        .unwrap();
        assert_eq!(
            placed,
            vec![h
                .join(".config")
                .join("microsoft-edge")
                .join("External Extensions")
                .join(format!("{EDGE_ID}.json"))]
        );
        assert!(!computer
            .files
            .keys()
            .any(|path| path.starts_with(h.join(".config").join("google-chrome"))));
        assert_eq!(
            record_location(Os::Linux, dirs),
            h.join(".config")
                .join("ai.copilotkit.openbot.desktop")
                .join("recorder-store-extensions.json")
        );
    }

    #[test]
    fn windows_sets_each_browsers_key_whether_or_not_it_is_installed() {
        let h = home();
        let local = PathBuf::from("C:\\Users\\pat\\AppData\\Local");
        let dirs = UserDirs {
            local_app_data: Some(&local),
            ..UserDirs::at(&h)
        };
        let mut computer = Computer::default();
        let placed = register(
            dirs,
            Os::Windows,
            &ids(Some(CHROME_ID), Some(EDGE_ID)),
            &mut computer,
        )
        .unwrap();
        // The keys are not files, and are not listed.
        assert!(placed.is_empty());
        let chrome_key = format!("HKCU\\Software\\Google\\Chrome\\Extensions\\{CHROME_ID}");
        let edge_key = format!("HKCU\\Software\\Microsoft\\Edge\\Extensions\\{EDGE_ID}");
        assert_eq!(
            computer.commands,
            vec![
                registry_add(&chrome_key, Browser::Chrome),
                registry_add(&edge_key, Browser::Edge)
            ]
        );
        assert_eq!(computer.keys[&chrome_key], CHROME_WEB_STORE_UPDATE_URL);
        assert_eq!(computer.keys[&edge_key], EDGE_ADD_ONS_UPDATE_URL);
        assert_eq!(
            record_location(Os::Windows, dirs),
            local
                .join("OpenBot")
                .join("recorder")
                .join("recorder-store-extensions.json")
        );
    }

    #[test]
    fn an_id_that_changes_or_empties_is_taken_back_out_and_nothing_else() {
        let h = home();
        let dirs = UserDirs::at(&h);
        let mut computer = Computer::default();
        computer.present.insert(mac_folder("Google/Chrome"));
        computer.present.insert(mac_folder("Microsoft Edge"));
        let folder = |browser: &str| mac_folder(browser).join("External Extensions");
        // Another application's entry, and a file at the Recorder's own name that is no longer what Desktop wrote.
        let theirs = folder("Google/Chrome").join("hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh.json");
        computer
            .files
            .insert(theirs.clone(), entry_contents(Browser::Chrome));
        register(
            dirs,
            Os::Mac,
            &ids(Some(CHROME_ID), Some(EDGE_ID)),
            &mut computer,
        )
        .unwrap();

        // Edge Add-ons gave the Recorder a new id: the old entry goes, the new one comes.
        register(
            dirs,
            Os::Mac,
            &ids(Some(CHROME_ID), Some(NEW_EDGE_ID)),
            &mut computer,
        )
        .unwrap();
        assert!(!computer
            .files
            .contains_key(&folder("Microsoft Edge").join(format!("{EDGE_ID}.json"))));
        assert!(computer
            .files
            .contains_key(&folder("Microsoft Edge").join(format!("{NEW_EDGE_ID}.json"))));

        // Somebody changed the Chrome entry by hand: it is no longer Desktop's to take out.
        let chrome_entry = folder("Google/Chrome").join(format!("{CHROME_ID}.json"));
        computer
            .files
            .insert(chrome_entry.clone(), r#"{"external_crx":"/x.crx"}"#.into());
        // Unpublished: both ids emptied.
        register(dirs, Os::Mac, &StoreIds::default(), &mut computer).unwrap();
        assert!(!computer
            .files
            .contains_key(&folder("Microsoft Edge").join(format!("{NEW_EDGE_ID}.json"))));
        assert_eq!(
            computer.files[&chrome_entry],
            r#"{"external_crx":"/x.crx"}"#
        );
        assert_eq!(computer.files[&theirs], entry_contents(Browser::Chrome));
        // The note goes with the last entry.
        assert!(!computer.files.contains_key(&record_location(Os::Mac, dirs)));
    }

    #[test]
    fn windows_takes_out_only_a_key_that_is_there() {
        let h = home();
        let dirs = UserDirs::at(&h);
        let mut computer = Computer::default();
        register(
            dirs,
            Os::Windows,
            &ids(Some(CHROME_ID), Some(EDGE_ID)),
            &mut computer,
        )
        .unwrap();
        let edge_key = format!("HKCU\\Software\\Microsoft\\Edge\\Extensions\\{EDGE_ID}");
        let chrome_key = format!("HKCU\\Software\\Google\\Chrome\\Extensions\\{CHROME_ID}");
        // The person deleted the Chrome key themselves.
        computer.keys.remove(&chrome_key);
        computer.commands.clear();
        register(dirs, Os::Windows, &StoreIds::default(), &mut computer).unwrap();
        assert_eq!(
            computer.commands,
            vec![
                registry_query(&chrome_key),
                registry_query(&edge_key),
                registry_delete(&edge_key)
            ]
        );
        assert!(computer.keys.is_empty());
        // Nothing left to note, and nothing to do the next time.
        computer.commands.clear();
        register(dirs, Os::Windows, &StoreIds::default(), &mut computer).unwrap();
        assert!(computer.commands.is_empty());
    }

    #[test]
    fn one_browsers_failure_leaves_the_other_registered_and_is_reported() {
        let h = home();
        let dirs = UserDirs::at(&h);
        let mut computer = Computer::default();
        computer.present.insert(mac_folder("Google/Chrome"));
        computer.present.insert(mac_folder("Microsoft Edge"));
        let chrome_entry = mac_folder("Google/Chrome")
            .join("External Extensions")
            .join(format!("{CHROME_ID}.json"));
        computer.failing = Some(chrome_entry.clone());
        let problem = register(
            dirs,
            Os::Mac,
            &ids(Some(CHROME_ID), Some(EDGE_ID)),
            &mut computer,
        )
        .unwrap_err();
        assert_eq!(
            problem.said,
            "OpenBot Desktop could not add the Recorder to your browser."
        );
        assert!(problem
            .detail
            .unwrap()
            .contains(&chrome_entry.display().to_string()));
        assert!(computer.files.contains_key(
            &mac_folder("Microsoft Edge")
                .join("External Extensions")
                .join(format!("{EDGE_ID}.json"))
        ));
        // The next round, with the folder writable again, finishes the job.
        computer.failing = None;
        register(
            dirs,
            Os::Mac,
            &ids(Some(CHROME_ID), Some(EDGE_ID)),
            &mut computer,
        )
        .unwrap();
        assert_eq!(
            computer.files[&chrome_entry],
            entry_contents(Browser::Chrome)
        );
    }

    /// The Extensions keys the uninstaller deletes, as `HKCU\...` the way `entry` names them.
    fn uninstalled_store_keys(hooks: &str) -> std::collections::BTreeSet<String> {
        let uninstall = hooks
            .split("!macro NSIS_HOOK_POSTUNINSTALL")
            .nth(1)
            .and_then(|rest| rest.split("!macroend").next())
            .expect("hooks.nsh has no NSIS_HOOK_POSTUNINSTALL");
        uninstall
            .lines()
            .filter_map(|line| line.trim().strip_prefix("DeleteRegKey HKCU \""))
            .filter_map(|rest| rest.strip_suffix('"'))
            .filter(|key| key.contains("\\Extensions\\"))
            .map(|key| format!("HKCU\\{key}"))
            .collect()
    }

    /// The keys a Windows registration writes for these store ids.
    fn registered_store_keys(store: &StoreIds) -> std::collections::BTreeSet<String> {
        let dirs = UserDirs::at(Path::new("C:\\Users\\pat"));
        BROWSERS
            .into_iter()
            .filter_map(|browser| {
                let id = store.for_browser(browser)?;
                match entry(Os::Windows, browser, dirs, id)? {
                    Entry::RegistryKey(key) => Some(key),
                    Entry::File(_) => None,
                }
            })
            .collect()
    }

    // Uninstalling OpenBot Desktop takes back what it registered: each store id's key, so the browser removes the
    // Recorder it installed from it, and the note. A store id set in the shared file without its line here fails.
    #[test]
    fn the_uninstaller_takes_out_each_store_ids_key_and_the_note() {
        let hooks = include_str!("../windows/hooks.nsh");
        assert_eq!(
            uninstalled_store_keys(hooks),
            registered_store_keys(crate::recorder_install::store_ids()),
            "windows/hooks.nsh must delete exactly the HKCU Extensions key of each store id in \
             shared/recorder-extension.json"
        );
        let local = PathBuf::from("/local");
        let note = record_location(
            Os::Windows,
            UserDirs {
                local_app_data: Some(&local),
                ..UserDirs::at(Path::new("/home/a"))
            },
        );
        let relative: Vec<String> = note
            .strip_prefix(&local)
            .unwrap()
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect();
        assert!(hooks.contains(&format!(
            "Delete \"$LOCALAPPDATA\\{}\"",
            relative.join("\\")
        )));
        // The check itself: published ids with no line for them are caught, and the lines that hold them pass.
        let published = ids(Some(CHROME_ID), Some(EDGE_ID));
        assert_ne!(
            uninstalled_store_keys(hooks),
            registered_store_keys(&published)
        );
        let with_lines = hooks.replace(
            "    SetShellVarContext current",
            &format!(
                "    DeleteRegKey HKCU \"Software\\Google\\Chrome\\Extensions\\{CHROME_ID}\"\n    \
                 DeleteRegKey HKCU \"Software\\Microsoft\\Edge\\Extensions\\{EDGE_ID}\"\n    SetShellVarContext current"
            ),
        );
        assert_eq!(
            uninstalled_store_keys(&with_lines),
            registered_store_keys(&published)
        );
    }

    #[test]
    fn a_note_that_is_not_desktops_names_nothing_to_take_out() {
        let h = home();
        let dirs = UserDirs::at(&h);
        let record = record_location(Os::Mac, dirs);
        for text in [
            "not json",
            "[]",
            r#"{"chrome":"abcdefghijklmnopabcdefghijklmnop"}"#,
            r#"{"chrome":["../../../.ssh/id_rsa"]}"#,
        ] {
            let mut computer = Computer::default();
            computer.present.insert(mac_folder("Google/Chrome"));
            computer.files.insert(record.clone(), text.to_string());
            let victim = mac_folder("Google/Chrome")
                .join("External Extensions")
                .join("../../../.ssh/id_rsa.json");
            computer
                .files
                .insert(victim.clone(), entry_contents(Browser::Chrome));
            register(dirs, Os::Mac, &StoreIds::default(), &mut computer).unwrap();
            assert!(computer.files.contains_key(&victim), "{text}");
            assert!(!computer.files.contains_key(&record), "{text}");
        }
    }
}
