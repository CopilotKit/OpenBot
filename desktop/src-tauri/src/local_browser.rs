//! The person's own browser on this machine: the host-side local Chrome computer.
//!
//! OpenBot Desktop runs a fourth host process beside the server, the app and the worker:
//! `agent-computer` with `COMPUTER_BROWSER_BACKEND=local-chrome`, the computer
//! `scripts/start-local-chrome-computer.ts` starts by hand for a developer. It opens the person's
//! installed Google Chrome, or Microsoft Edge where Chrome is missing, as a window on their desktop,
//! in a profile of its own, with the Recorder loaded from the deployment's prebuilt copy. The server
//! finds it through `OPENBOT_BROWSER_URL`. Bots' own computers stay where they are, with the
//! supervisor and the engine: only the person's browser runs here.
//!
//! It runs only where it can work. The deployment's release has to carry the OpenBot Browser (its
//! contract, `shared/openbot-browser.ts`), the Recorder has to be in it (installation copies it out
//! of the release's computer image, `preparation::place_recorder`), and Chrome or Edge has to be
//! installed where the computer will look. Anything less runs nothing here, and the server is told
//! why (`BROWSER_ABSENT_ENV`) so the app can tell the person.
//!
//! The names below are the contract's, checked against it by a test, so the two cannot drift.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::recorder_install::Os;

/// The file every part of the OpenBot Browser is built against. A release without it has no
/// server route, computer route or Browser button that could use a browser on this machine.
pub const CONTRACT: &str = "shared/openbot-browser.ts";

/// The contract's `RECORDER_DIR_ENV`: on the computer, the built Recorder, absolute.
pub const RECORDER_DIR_ENV: &str = "OPENBOT_RECORDER_DIR";

/// The contract's `BROWSER_URL_ENV`: on the server, the computer that runs people's browsers.
pub const BROWSER_URL_ENV: &str = "OPENBOT_BROWSER_URL";

/// The contract's `PEOPLE_ONLY_ENV`: on the computer, that it runs people's own browsers and no Bot. The
/// computer runs a person's browser only on a computer of its own, and this is how it knows it is one.
pub const PEOPLE_ONLY_ENV: &str = "COMPUTER_PEOPLE_ONLY";

/// Where the built Recorder sits inside the deployment: where its own build (`extension/scripts/build.ts`)
/// writes, and where installation puts the release's prebuilt copy.
pub const RECORDER_DIST: &str = "extension/dist";

/// The port the computer asks for first: the contract's example and the developer helper's default.
/// Desktop moves off it when something else holds it, as it does for every port it chooses.
pub const DEFAULT_PORT: u16 = 4101;

/// Which browser the computer opens. Named as the contract's `BrowserProduct`, which is also the
/// Playwright channel the computer launches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Product {
    Chrome,
    Edge,
}

impl Product {
    pub fn channel(self) -> &'static str {
        match self {
            Product::Chrome => "chrome",
            Product::Edge => "msedge",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Product::Chrome => "Google Chrome",
            Product::Edge => "Microsoft Edge",
        }
    }
}

/// An environment variable, `None` when unset or empty. Passed in rather than read here, so the
/// rule can be checked against the values a real machine has without changing this process's own.
pub type Variable<'a> = &'a dyn Fn(&str) -> Option<OsString>;

/// Where the computer will find each browser, in the order it looks: the same list as its own
/// (`browserExecutableCandidates` in `agent-computer/src/person-launch.ts`), so a browser Desktop
/// finds is one the computer opens.
///
/// On macOS and Windows, where Playwright looks for its `chrome` and `msedge` channels, read from
/// playwright-core 1.62.1, the version `agent-computer` pins (`_createChromiumChannel` in its
/// registry): one fixed path on macOS, and on Windows the same suffix under `%LOCALAPPDATA%`,
/// `%PROGRAMFILES%`, `%PROGRAMFILES(X86)%`, then `%HOMEDRIVE%\Program Files` and
/// `%HOMEDRIVE%\Program Files (x86)`.
///
/// On Linux, Playwright's path first, which is where Google's and Microsoft's own .deb and .rpm
/// packages install the browser on every distribution, then the browser's launcher by its vendor's
/// names in each absolute folder on `PATH`, for a distribution that keeps the browser somewhere of
/// its own (NixOS, in its store). The computer starts a person's window from that path itself, not
/// through Playwright's channel, and a launcher hands every argument on to the browser it starts.
/// A Flatpak's exported launcher is not on the list: see [`flatpak_only`].
pub fn executable_candidates(product: Product, os: Os, var: Variable) -> Vec<PathBuf> {
    match (os, product) {
        (Os::Mac, Product::Chrome) => {
            vec!["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into()]
        }
        (Os::Mac, Product::Edge) => {
            vec!["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge".into()]
        }
        (Os::Linux, _) => {
            let (packaged, launchers): (&str, [&str; 2]) = match product {
                Product::Chrome => (
                    "/opt/google/chrome/chrome",
                    ["google-chrome-stable", "google-chrome"],
                ),
                Product::Edge => (
                    "/opt/microsoft/msedge/msedge",
                    ["microsoft-edge-stable", "microsoft-edge"],
                ),
            };
            let mut candidates = vec![PathBuf::from(packaged)];
            let path = var("PATH").unwrap_or_default();
            // Absolute folders only: an empty or relative entry means the folder Desktop runs in.
            for folder in path.to_string_lossy().split(':') {
                if !folder.starts_with('/') {
                    continue;
                }
                for name in launchers {
                    let candidate = Path::new(folder).join(name);
                    if !candidates.contains(&candidate) {
                        candidates.push(candidate);
                    }
                }
            }
            candidates
        }
        (Os::Windows, _) => {
            let suffix: &[&str] = match product {
                Product::Chrome => &["Google", "Chrome", "Application", "chrome.exe"],
                Product::Edge => &["Microsoft", "Edge", "Application", "msedge.exe"],
            };
            let mut prefixes: Vec<PathBuf> = ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"]
                .into_iter()
                .filter_map(|name| var(name).map(PathBuf::from))
                .collect();
            // Concatenated as Playwright does: joining `C:` to a name is relative to the drive's
            // current folder, not its root.
            if let Some(drive) = var("HOMEDRIVE") {
                for folder in ["\\Program Files", "\\Program Files (x86)"] {
                    let mut prefix = drive.clone();
                    prefix.push(folder);
                    prefixes.push(prefix.into());
                }
            }
            prefixes
                .into_iter()
                .map(|prefix| suffix.iter().fold(prefix, |path, part| path.join(part)))
                .collect()
        }
    }
}

/// The browser the computer will open: Google Chrome, or Microsoft Edge where Chrome is missing.
pub fn installed(
    os: Os,
    var: Variable,
    is_file: &dyn Fn(&Path) -> bool,
) -> Option<(Product, PathBuf)> {
    [Product::Chrome, Product::Edge]
        .into_iter()
        .find_map(|product| {
            executable_candidates(product, os, var)
                .into_iter()
                .find(|candidate| is_file(candidate))
                .map(|executable| (product, executable))
        })
}

/// The computer's own data root, holding the browser's profile (`profiles/`) and its file
/// workspace (`workspace/`).
///
/// The defaults `docs/configuration.md` gives the developer helper, so a profile somebody built
/// with it is the profile Desktop opens. A relative `$XDG_DATA_HOME` is ignored, as the XDG Base
/// Directory specification says it must be.
pub fn data_root(os: Os, home: &Path, var: Variable) -> PathBuf {
    match os {
        Os::Mac => home
            .join("Library")
            .join("Application Support")
            .join("OpenBot"),
        Os::Windows => var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"))
            .join("OpenBot"),
        Os::Linux => var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|path| path.to_string_lossy().starts_with('/'))
            .unwrap_or_else(|| home.join(".local").join("share"))
            .join("openbot"),
    }
    .join("local-computer")
}

/// The built Recorder in a deployment, which is what the computer loads into the browser.
pub fn recorder_dir(root: &Path) -> PathBuf {
    root.join(RECORDER_DIST)
}

/// Whether the deployment's release carries the OpenBot Browser at all.
pub fn in_release(root: &Path) -> bool {
    root.join(CONTRACT).is_file()
}

/// Why this machine runs no browser for the person. Each is logged, none is a failure: OpenBot runs
/// without it. The server is told why (`BROWSER_ABSENT_ENV`, [`Absent::code`]), and the app says so
/// to the person in a sentence of their own beside whatever browser runs for them instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Absent {
    /// The deployment's release predates the OpenBot Browser.
    NotInRelease,
    /// The release carries it, and its Recorder is not in the deployment. Installation puts it
    /// there, and Start sends a deployment without it back to Installation, so this is a deployment
    /// changed by hand.
    RecorderNotBuilt,
    /// Neither Google Chrome nor Microsoft Edge is installed where the computer looks.
    NoChromeOrEdge,
    /// Only the Flatpak of this browser is installed, which the computer cannot open: see
    /// [`flatpak_only`].
    FlatpakOnly(Product),
    /// No home folder to keep the browser's profile in.
    NoHomeFolder,
}

impl Absent {
    pub fn said(self) -> &'static str {
        match self {
            Absent::NotInRelease => "this version of OpenBot has no browser of its own",
            Absent::RecorderNotBuilt => "the Recorder is not in this deployment",
            Absent::NoChromeOrEdge => {
                "neither Google Chrome nor Microsoft Edge is installed in its usual place"
            }
            Absent::FlatpakOnly(Product::Chrome) => {
                "Google Chrome is installed only as a Flatpak, which OpenBot cannot open"
            }
            Absent::FlatpakOnly(Product::Edge) => {
                "Microsoft Edge is installed only as a Flatpak, which OpenBot cannot open"
            }
            Absent::NoHomeFolder => "there is no home folder to keep the browser's profile in",
        }
    }

    /// The name the server knows this reason by, one of the contract's `BROWSER_ABSENCES`. None for
    /// a release from before the OpenBot Browser, whose server has no browser to explain.
    pub fn code(self) -> Option<&'static str> {
        match self {
            Absent::NotInRelease => None,
            Absent::RecorderNotBuilt => Some("recorder-not-built"),
            Absent::NoChromeOrEdge => Some("no-chrome-or-edge"),
            Absent::FlatpakOnly(Product::Chrome) => Some("flatpak-chrome"),
            Absent::FlatpakOnly(Product::Edge) => Some("flatpak-edge"),
            Absent::NoHomeFolder => Some("no-home-folder"),
        }
    }
}

/// The contract's `BROWSER_ABSENT_ENV`: on the server, why there is no browser of the person's own.
pub const BROWSER_ABSENT_ENV: &str = "OPENBOT_BROWSER_ABSENT";

/// The browser installed only as a Flatpak, where that is all there is: Chrome first, as ever.
///
/// The Flatpaks of Chrome (`com.google.Chrome`) and Edge (`com.microsoft.Edge`) are community
/// wrappers on Flathub that run the browser inside Flatpak's sandbox, which is given no access to
/// the person's home beyond a few named folders: not the profile kept in OpenBot's data root, and
/// not the Recorder in the deployment. So the computer cannot open them, and the person is told to
/// install the vendor's own package instead. Found by the `metadata` file every installed Flatpak
/// app has, system-wide (`/var/lib/flatpak/app`) or for this person (`flatpak/app` in
/// `$XDG_DATA_HOME`, or `~/.local/share`). Neither browser is published as a Snap.
/// <https://github.com/flathub/com.google.Chrome>
pub fn flatpak_only(
    os: Os,
    home: Option<&Path>,
    var: Variable,
    is_file: &dyn Fn(&Path) -> bool,
) -> Option<Product> {
    if os != Os::Linux {
        return None;
    }
    let mut roots = vec![PathBuf::from("/var/lib/flatpak/app")];
    let data_home = var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.to_string_lossy().starts_with('/'))
        .or_else(|| home.map(|home| home.join(".local").join("share")));
    if let Some(data_home) = data_home {
        roots.push(data_home.join("flatpak").join("app"));
    }
    [
        (Product::Chrome, "com.google.Chrome"),
        (Product::Edge, "com.microsoft.Edge"),
    ]
    .into_iter()
    .find(|(_, app)| {
        roots.iter().any(|root| {
            is_file(
                &root
                    .join(app)
                    .join("current")
                    .join("active")
                    .join("metadata"),
            )
        })
    })
    .map(|(product, _)| product)
}

/// The person's browser this start will run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalBrowser {
    pub product: Product,
    /// Where it was found. The computer finds it again by its channel; this is for the log.
    pub executable: PathBuf,
    /// The computer's data root. See [`data_root`].
    pub data: PathBuf,
}

/// Decide whether this machine runs the person's browser, from what is on disk and in `var`.
pub fn find(
    root: &Path,
    os: Os,
    home: Option<&Path>,
    var: Variable,
    is_file: &dyn Fn(&Path) -> bool,
) -> Result<LocalBrowser, Absent> {
    if !in_release(root) {
        return Err(Absent::NotInRelease);
    }
    if !recorder_dir(root).join("manifest.json").is_file() {
        return Err(Absent::RecorderNotBuilt);
    }
    let (product, executable) = installed(os, var, is_file).ok_or_else(|| {
        flatpak_only(os, home, var, is_file)
            .map(Absent::FlatpakOnly)
            .unwrap_or(Absent::NoChromeOrEdge)
    })?;
    let home = home.ok_or(Absent::NoHomeFolder)?;
    Ok(LocalBrowser {
        product,
        executable,
        data: data_root(os, home, var),
    })
}

/// [`find`], for this person on this machine.
pub fn for_this_person(root: &Path) -> Result<LocalBrowser, Absent> {
    let var = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty());
    let home = var("HOME")
        .or_else(|| var("USERPROFILE"))
        .map(PathBuf::from);
    find(
        root,
        Os::current(),
        home.as_deref(),
        &var,
        &|path: &Path| path.is_file(),
    )
}

/// What the computer is started with, beyond what it inherits from OpenBot Desktop.
///
/// What `scripts/start-local-chrome-computer.ts` sets, for the same reasons: the local Chrome
/// backend, headed (it refuses anything else, because the window is the point), Chromium's own
/// sandbox, and app-owned profile and workspace folders rather than any inherited ones. Then what the
/// helper leaves to whoever runs it:
///
/// - The computer token the stack already shares, which every route but `/health` demands.
/// - The deployment's built Recorder, which `/browser/open` refuses to open a browser without.
/// - Browsers kept resident. The idle sweep closes a browser no request has touched for a while,
///   which is right for a Bot's and wrong here: the person browses in the window itself, which
///   touches nothing, and closes it when they are done.
/// - That it runs people's browsers and no Bot (`PEOPLE_ONLY_ENV`), without which it refuses to run
///   a person's browser at all: a computer Bots run on is no place for one.
///
/// It is given nothing else. The server's and the worker's credentials stay with them: this
/// process drives a browser on whatever site the person opens.
pub fn environment(
    root: &Path,
    browser: &LocalBrowser,
    port: u16,
    computer_token: &str,
) -> Vec<(&'static str, OsString)> {
    vec![
        ("COMPUTER_TOKEN", computer_token.into()),
        ("COMPUTER_BROWSER_BACKEND", "local-chrome".into()),
        ("COMPUTER_BROWSER_MODE", "headed".into()),
        ("COMPUTER_SANDBOX", "on".into()),
        ("COMPUTER_BROWSER_IDLE_MS", "0".into()),
        (PEOPLE_ONLY_ENV, "on".into()),
        ("PORT", port.to_string().into()),
        ("PROFILES_DIR", browser.data.join("profiles").into()),
        ("WORKSPACE_DIR", browser.data.join("workspace").into()),
        (RECORDER_DIR_ENV, recorder_dir(root).into()),
    ]
}

/// Make the data root and its two folders, readable only by this person, as the helper does. The
/// profile holds the person's logins.
pub fn prepare_data(browser: &LocalBrowser) -> std::io::Result<()> {
    for directory in [
        browser.data.clone(),
        browser.data.join("profiles"),
        browser.data.join("workspace"),
    ] {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;
    use std::collections::{BTreeMap, HashSet};

    fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let map: BTreeMap<String, OsString> = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), OsString::from(value)))
            .collect();
        move |name: &str| map.get(name).cloned()
    }

    fn none(_: &str) -> Option<OsString> {
        None
    }

    /// Windows paths, written with forward slashes whatever OS the test runs on.
    fn slashed(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    /// The paths a real Windows 11 account has, from `set` in a Command Prompt.
    fn windows_account() -> impl Fn(&str) -> Option<OsString> {
        vars(&[
            ("LOCALAPPDATA", "C:\\Users\\Ada\\AppData\\Local"),
            ("PROGRAMFILES", "C:\\Program Files"),
            ("PROGRAMFILES(X86)", "C:\\Program Files (x86)"),
            ("HOMEDRIVE", "C:"),
        ])
    }

    #[test]
    fn the_browser_is_looked_for_where_playwright_launches_it_from() {
        assert_eq!(
            executable_candidates(Product::Chrome, Os::Mac, &none),
            [PathBuf::from(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            )]
        );
        assert_eq!(
            executable_candidates(Product::Edge, Os::Mac, &none),
            [PathBuf::from(
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
            )]
        );
        assert_eq!(
            executable_candidates(Product::Chrome, Os::Linux, &none),
            [PathBuf::from("/opt/google/chrome/chrome")]
        );
        assert_eq!(
            executable_candidates(Product::Edge, Os::Linux, &none),
            [PathBuf::from("/opt/microsoft/msedge/msedge")]
        );
        let windows = windows_account();
        let chrome: Vec<String> = executable_candidates(Product::Chrome, Os::Windows, &windows)
            .iter()
            .map(|path| slashed(path))
            .collect();
        assert_eq!(
            chrome,
            [
                "C:/Users/Ada/AppData/Local/Google/Chrome/Application/chrome.exe",
                "C:/Program Files/Google/Chrome/Application/chrome.exe",
                "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
                "C:/Program Files/Google/Chrome/Application/chrome.exe",
                "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
            ]
        );
        let edge: Vec<String> = executable_candidates(Product::Edge, Os::Windows, &windows)
            .iter()
            .map(|path| slashed(path))
            .collect();
        assert_eq!(
            edge[2], "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
            "Edge installs itself under Program Files (x86) even on 64-bit Windows"
        );
    }

    /// Playwright's own copy of this table is the one the computer launches from. Read it, so an
    /// upgrade that moves a path fails here rather than hiding the Browser button on somebody's
    /// machine.
    #[test]
    fn the_paths_match_the_playwright_the_computer_runs() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let pinned: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(repo.join("agent-computer/package.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            pinned["dependencies"]["playwright"], "1.62.1",
            "agent-computer moved Playwright: re-read its channel table and update this file"
        );
        let Ok(bundle) = std::fs::read_to_string(
            repo.join("agent-computer/node_modules/playwright-core/lib/coreBundle.js"),
        ) else {
            // A checkout without dependencies installed has nothing to read; the pin above still
            // ties this file to the version it was read from.
            return;
        };
        for (channel, linux, mac, windows) in [
            (
                "chrome",
                "/opt/google/chrome/chrome",
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe",
            ),
            (
                "msedge",
                "/opt/microsoft/msedge/msedge",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe",
            ),
        ] {
            let at = bundle
                .find(&format!("_createChromiumChannel(\"{channel}\", {{"))
                .unwrap_or_else(|| panic!("Playwright no longer names the {channel} channel"));
            let table = &bundle[at..at + 400];
            assert!(
                table.contains(&format!("\"linux\": \"{linux}\"")),
                "{table}"
            );
            assert!(table.contains(&format!("\"darwin\": \"{mac}\"")), "{table}");
            assert!(
                table.contains(&format!("\"win32\": `{windows}`")),
                "{table}"
            );
        }
    }

    /// On Linux only `/opt` used to be looked in, and anywhere else the Browser button changed with
    /// the reason only in Desktop's log. Google's and Microsoft's packages use
    /// `/opt` on every distribution; NixOS keeps the browser in its store, behind the vendor's
    /// launcher name on the PATH.
    #[test]
    fn on_linux_the_vendors_package_first_then_the_launcher_on_the_path() {
        let nixos = vars(&[(
            "PATH",
            "/run/wrappers/bin::relative/bin:/home/ada/.nix-profile/bin:/run/current-system/sw/bin",
        )]);
        assert_eq!(
            executable_candidates(Product::Chrome, Os::Linux, &nixos),
            [
                "/opt/google/chrome/chrome",
                "/run/wrappers/bin/google-chrome-stable",
                "/run/wrappers/bin/google-chrome",
                "/home/ada/.nix-profile/bin/google-chrome-stable",
                "/home/ada/.nix-profile/bin/google-chrome",
                "/run/current-system/sw/bin/google-chrome-stable",
                "/run/current-system/sw/bin/google-chrome",
            ]
            .map(PathBuf::from)
        );
        fn on_disk(files: &[&str]) -> impl Fn(&Path) -> bool {
            let files: Vec<PathBuf> = files.iter().map(PathBuf::from).collect();
            move |path: &Path| files.iter().any(|file| file == path)
        }
        let nix_edge = "/home/ada/.nix-profile/bin/microsoft-edge";
        assert_eq!(
            installed(Os::Linux, &nixos, &on_disk(&[nix_edge])),
            Some((Product::Edge, PathBuf::from(nix_edge)))
        );
        // The vendor's package links its launcher onto the PATH too: the browser itself is used.
        let packaged = vars(&[("PATH", "/usr/bin")]);
        assert_eq!(
            installed(
                Os::Linux,
                &packaged,
                &on_disk(&["/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"])
            ),
            Some((Product::Chrome, PathBuf::from("/opt/google/chrome/chrome")))
        );
        // A Flatpak's exported launcher and the Snap Store's Chromium are neither browser.
        let sandboxed = vars(&[(
            "PATH",
            "/var/lib/flatpak/exports/bin:/home/ada/.local/share/flatpak/exports/bin:/snap/bin",
        )]);
        assert_eq!(
            installed(
                Os::Linux,
                &sandboxed,
                &on_disk(&[
                    "/var/lib/flatpak/exports/bin/com.google.Chrome",
                    "/home/ada/.local/share/flatpak/exports/bin/com.microsoft.Edge",
                    "/snap/bin/chromium",
                ])
            ),
            None
        );
    }

    /// Only a Flatpak of Chrome or Edge, system-wide or the person's own: the reason names it, so
    /// the person is told to install the vendor's package rather than that there is no browser.
    #[test]
    fn a_machine_with_only_a_flatpak_is_told_so() {
        let ready = deployment("browser-flatpak", true, true);
        let home = Path::new("/home/ada");
        let at = |file: &'static str| move |path: &Path| path == Path::new(file);
        assert_eq!(
            find(
                &ready,
                Os::Linux,
                Some(home),
                &none,
                &at("/var/lib/flatpak/app/com.google.Chrome/current/active/metadata")
            ),
            Err(Absent::FlatpakOnly(Product::Chrome))
        );
        assert_eq!(
            find(
                &ready,
                Os::Linux,
                Some(home),
                &none,
                &at(
                    "/home/ada/.local/share/flatpak/app/com.microsoft.Edge/current/active/metadata"
                )
            ),
            Err(Absent::FlatpakOnly(Product::Edge))
        );
        assert_eq!(
            find(
                &ready,
                Os::Linux,
                Some(home),
                &vars(&[("XDG_DATA_HOME", "/data/ada")]),
                &at("/data/ada/flatpak/app/com.google.Chrome/current/active/metadata")
            ),
            Err(Absent::FlatpakOnly(Product::Chrome))
        );
        assert_eq!(
            find(&ready, Os::Linux, Some(home), &none, &|_| false),
            Err(Absent::NoChromeOrEdge)
        );
        std::fs::remove_dir_all(ready).unwrap();
    }

    /// Every reason the server is told is one it has a sentence for.
    #[test]
    fn every_reason_is_the_contracts() {
        let contract = include_str!("../../../shared/openbot-browser.ts");
        assert!(contract.contains(&format!(
            "export const BROWSER_ABSENT_ENV = \"{BROWSER_ABSENT_ENV}\";"
        )));
        for absent in [
            Absent::RecorderNotBuilt,
            Absent::NoChromeOrEdge,
            Absent::FlatpakOnly(Product::Chrome),
            Absent::FlatpakOnly(Product::Edge),
            Absent::NoHomeFolder,
        ] {
            let code = absent.code().unwrap();
            assert!(
                contract.contains(&format!("\"{code}\":")),
                "shared/openbot-browser.ts has no sentence for {code}"
            );
        }
        assert_eq!(Absent::NotInRelease.code(), None);
    }

    #[test]
    fn chrome_is_opened_and_edge_only_where_chrome_is_missing() {
        let windows = windows_account();
        let chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
        let edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
        let on_disk = |files: &[&str]| {
            let files: HashSet<String> = files.iter().map(|file| file.to_string()).collect();
            move |path: &Path| files.contains(&slashed(path))
        };

        let both = installed(Os::Windows, &windows, &on_disk(&[chrome, edge])).unwrap();
        assert_eq!(both.0, Product::Chrome);
        assert_eq!(slashed(&both.1), chrome);

        let only_edge = installed(Os::Windows, &windows, &on_disk(&[edge])).unwrap();
        assert_eq!(only_edge.0, Product::Edge);
        assert_eq!(only_edge.0.channel(), "msedge");

        assert_eq!(installed(Os::Windows, &windows, &on_disk(&[])), None);
        // A browser installed for this account alone is found too.
        let per_user = "C:/Users/Ada/AppData/Local/Google/Chrome/Application/chrome.exe";
        assert_eq!(
            installed(Os::Windows, &windows, &on_disk(&[per_user]))
                .unwrap()
                .0,
            Product::Chrome
        );
        let mac_edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
        assert_eq!(
            installed(Os::Mac, &none, &on_disk(&[mac_edge])).unwrap().0,
            Product::Edge
        );
        assert_eq!(
            installed(Os::Linux, &none, &on_disk(&[mac_edge])),
            None,
            "a macOS path means nothing on Linux"
        );
    }

    #[test]
    fn the_profile_lives_where_the_developer_helper_keeps_it() {
        let home = Path::new("/home/ada");
        assert_eq!(
            data_root(Os::Mac, Path::new("/Users/ada"), &none),
            PathBuf::from("/Users/ada/Library/Application Support/OpenBot/local-computer")
        );
        assert_eq!(
            data_root(Os::Linux, home, &none),
            PathBuf::from("/home/ada/.local/share/openbot/local-computer")
        );
        assert_eq!(
            data_root(Os::Linux, home, &vars(&[("XDG_DATA_HOME", "/data/ada")])),
            PathBuf::from("/data/ada/openbot/local-computer")
        );
        assert_eq!(
            data_root(
                Os::Linux,
                home,
                &vars(&[("XDG_DATA_HOME", "relative/data")])
            ),
            PathBuf::from("/home/ada/.local/share/openbot/local-computer"),
            "the XDG specification says a relative path is invalid and ignored"
        );
        assert_eq!(
            slashed(&data_root(Os::Windows, home, &windows_account())),
            "C:/Users/Ada/AppData/Local/OpenBot/local-computer"
        );
        assert_eq!(
            slashed(&data_root(Os::Windows, Path::new("C:\\Users\\Ada"), &none)),
            "C:/Users/Ada/AppData/Local/OpenBot/local-computer"
        );
    }

    /// A deployment laid out on disk: the contract, and the built Recorder when `built`.
    fn deployment(label: &str, contract: bool, built: bool) -> PathBuf {
        let root = temp_root(label);
        std::fs::create_dir_all(root.join("shared")).unwrap();
        if contract {
            std::fs::write(root.join(CONTRACT), "export {};\n").unwrap();
        }
        if built {
            std::fs::create_dir_all(recorder_dir(&root)).unwrap();
            std::fs::write(recorder_dir(&root).join("manifest.json"), "{}").unwrap();
        }
        root
    }

    #[test]
    fn the_browser_runs_only_where_the_release_the_recorder_and_a_browser_all_are() {
        let mac_chrome = |path: &Path| {
            path == Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        };
        let home = Path::new("/Users/ada");

        let old = deployment("browser-old-release", false, false);
        assert_eq!(
            find(&old, Os::Mac, Some(home), &none, &mac_chrome),
            Err(Absent::NotInRelease)
        );

        let unbuilt = deployment("browser-unbuilt", true, false);
        assert_eq!(
            find(&unbuilt, Os::Mac, Some(home), &none, &mac_chrome),
            Err(Absent::RecorderNotBuilt)
        );

        let ready = deployment("browser-ready", true, true);
        assert_eq!(
            find(&ready, Os::Mac, Some(home), &none, &|_| false),
            Err(Absent::NoChromeOrEdge)
        );
        assert_eq!(
            find(&ready, Os::Mac, None, &none, &mac_chrome),
            Err(Absent::NoHomeFolder)
        );
        assert_eq!(
            find(&ready, Os::Mac, Some(home), &none, &mac_chrome),
            Ok(LocalBrowser {
                product: Product::Chrome,
                executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into(),
                data: "/Users/ada/Library/Application Support/OpenBot/local-computer".into(),
            })
        );
        for root in [old, unbuilt, ready] {
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn the_computer_gets_its_token_its_folders_and_the_recorder_and_nothing_else() {
        let browser = LocalBrowser {
            product: Product::Edge,
            executable: "/opt/microsoft/msedge/msedge".into(),
            data: "/home/ada/.local/share/openbot/local-computer".into(),
        };
        let env: BTreeMap<&str, String> = environment(
            Path::new("/home/ada/OpenBot"),
            &browser,
            4107,
            "synthetic-token",
        )
        .into_iter()
        .map(|(key, value)| (key, value.to_string_lossy().into_owned()))
        .collect();
        assert_eq!(
            env,
            BTreeMap::from([
                ("COMPUTER_TOKEN", "synthetic-token".to_string()),
                ("COMPUTER_BROWSER_BACKEND", "local-chrome".into()),
                ("COMPUTER_BROWSER_MODE", "headed".into()),
                ("COMPUTER_SANDBOX", "on".into()),
                ("COMPUTER_BROWSER_IDLE_MS", "0".into()),
                ("COMPUTER_PEOPLE_ONLY", "on".into()),
                ("PORT", "4107".into()),
                // Joined as the code joins them, so Windows' separator is expected where it puts one.
                ("PROFILES_DIR", lossy(browser.data.join("profiles"))),
                ("WORKSPACE_DIR", lossy(browser.data.join("workspace"))),
                (
                    "OPENBOT_RECORDER_DIR",
                    lossy(Path::new("/home/ada/OpenBot").join(RECORDER_DIST))
                ),
            ])
        );
        fn lossy(path: PathBuf) -> String {
            path.to_string_lossy().into_owned()
        }
    }

    /// Each name is the contract's own. The contract is TypeScript the other slices import; reading
    /// it here is how Desktop stays on the same names without a second copy anybody must remember.
    #[test]
    fn the_names_are_the_contracts() {
        let contract = include_str!("../../../shared/openbot-browser.ts");
        for (constant, value) in [
            ("RECORDER_DIR_ENV", RECORDER_DIR_ENV),
            ("BROWSER_URL_ENV", BROWSER_URL_ENV),
            ("PEOPLE_ONLY_ENV", PEOPLE_ONLY_ENV),
        ] {
            assert!(
                contract.contains(&format!("export const {constant} = \"{value}\";")),
                "shared/openbot-browser.ts no longer says {constant} = {value}"
            );
        }
        assert!(contract.contains(&format!("http://127.0.0.1:{DEFAULT_PORT}")));
        for product in [Product::Chrome, Product::Edge] {
            assert!(contract.contains(&format!("\"{}\"", product.channel())));
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_profile_folders_are_private_to_the_person() {
        use std::os::unix::fs::PermissionsExt;
        let data = temp_root("local-browser-data").join("local-computer");
        let browser = LocalBrowser {
            product: Product::Chrome,
            executable: "/opt/google/chrome/chrome".into(),
            data: data.clone(),
        };
        prepare_data(&browser).unwrap();
        prepare_data(&browser).unwrap();
        for directory in [data.clone(), data.join("profiles"), data.join("workspace")] {
            let mode = std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{}", directory.display());
        }
        std::fs::remove_dir_all(data.parent().unwrap()).unwrap();
    }
}
