//! The security floor, in OpenBot Desktop: the lowest safe release of this app and of the back end
//! it runs on this computer, which CopilotKit raises only when a release has a security problem.
//!
//! The same rules as `shared/security-floor.ts`, which the phone app, the Recorder and OpenBot Cloud
//! follow. A small document beside the update feed, signed with Ed25519 over its payload's exact
//! bytes (Tauri's own signatures cover the installers, not `latest.json`). The app reads nothing in
//! it until the signature verifies against a key it was built with (`keys` in
//! `shared/security-floor.json`), and keeps the floor with the highest serial it has verified, in its
//! config directory, so a replayed older floor can't lift a block and the floor still holds offline.
//! An app that has never verified one runs as normal.
//!
//! Where it holds: always for the back end this app runs on this computer, which ships with the app.
//! Connected to an OpenBot that runs elsewhere, only when the floor lists that OpenBot's address in
//! `cloud` (OpenBot Cloud). A company's own OpenBot is never there, so the app connected to one
//! ignores the floor, and so does that server.
//!
//! Below the floor the window shows one notice and nothing else (`desktop/src/SecurityFloor.tsx`),
//! and the back end on this computer is stopped and not started again: no Bot runs, routines pause,
//! nothing is deleted. Update and restart installs the newer app, whose next Start upgrades the back
//! end as every update does.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What the payload says it is, so no other signed JSON passes for a floor.
pub const KIND: &str = "openbot-security-floor";

/// Where the app keeps the last floor it verified, in its config directory, as it was published.
pub const FILE: &str = "security-floor.json";

/// The largest floor read. A real one is a few hundred bytes.
const LARGEST: u64 = 64 * 1024;

/// One read's time limit. A floor that hangs is a failed check.
const TIMEOUT: Duration = Duration::from_secs(30);

/**
The variables that point an internal build at a test floor and a test key, so the notice and the
stopped back end can be tried on a test machine before any real floor exists: an `http(s)` address
or a file, and one more Ed25519 public key (raw 32 bytes, base64) to trust beside the built-in ones.
Only an internal build reads them (`app_update::internal`). A stable or candidate build never does,
whatever its environment says.
*/
pub const TEST_FLOOR: &str = "OPENBOT_TEST_SECURITY_FLOOR";
pub const TEST_KEY: &str = "OPENBOT_TEST_SECURITY_FLOOR_KEY";

/// `shared/security-floor.json`: the keys a floor must be signed with, and where it is read.
const CONFIG: &str = include_str!("../../../shared/security-floor.json");

#[derive(Deserialize)]
struct Config {
    keys: Vec<String>,
    addresses: Vec<String>,
}

fn config() -> Config {
    serde_json::from_str(CONFIG).expect("shared/security-floor.json is the floor's configuration")
}

/// The keys this app was built with.
pub fn keys() -> Vec<[u8; 32]> {
    config()
        .keys
        .iter()
        .filter_map(|key| key_bytes(key))
        .collect()
}

/// A key as `shared/security-floor.json` lists it: the raw 32 bytes, in base64.
pub fn key_bytes(text: &str) -> Option<[u8; 32]> {
    base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .ok()?
        .try_into()
        .ok()
}

/// Where the floor is read, in order: beside the update feed on downloads.copilotkit.ai, then on
/// the Latest GitHub release.
pub fn addresses() -> Vec<reqwest::Url> {
    config()
        .addresses
        .iter()
        .filter_map(|address| reqwest::Url::parse(address).ok())
        .collect()
}

/// The apps a floor names that this app follows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum App {
    Desktop,
    /// The back end this app runs on this computer.
    Backend,
}

impl App {
    fn key(self) -> &'static str {
        match self {
            App::Desktop => "desktop",
            App::Backend => "backend",
        }
    }
}

/// A verified floor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Floor {
    /// Raised by one each time a floor is published. The highest verified wins.
    pub serial: u64,
    /// The lowest safe release of each app the floor names, by its name there.
    pub floors: BTreeMap<String, Version>,
    /// The OpenBot Cloud addresses (origins) it holds for, besides this app's own back end.
    pub cloud: Vec<String>,
}

#[derive(Deserialize)]
struct Envelope {
    payload: String,
    signature: String,
}

/// The floor in `text`, when its signature over its payload verifies against one of `keys`.
/// Nothing in the payload is read before that.
pub fn verify(text: &str, keys: &[[u8; 32]]) -> Result<Floor, String> {
    if text.len() as u64 > LARGEST {
        return Err("it is larger than any floor".into());
    }
    let envelope: Envelope =
        serde_json::from_str(text).map_err(|_| "it is not a signed floor".to_string())?;
    let engine = base64::engine::general_purpose::STANDARD;
    let payload = engine
        .decode(&envelope.payload)
        .map_err(|_| "it is not a signed floor".to_string())?;
    let signature: [u8; 64] = engine
        .decode(&envelope.signature)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or("it is not a signed floor")?;
    let signature = ed25519_dalek::Signature::from_bytes(&signature);
    let signed = keys.iter().any(|key| {
        ed25519_dalek::VerifyingKey::from_bytes(key)
            .is_ok_and(|key| key.verify_strict(&payload, &signature).is_ok())
    });
    if !signed {
        return Err("it is not signed by a key this app trusts".into());
    }
    read_payload(&payload)
}

fn release(text: &str) -> Option<Version> {
    let version = Version::parse(text).ok()?;
    (version.pre.is_empty() && version.build.is_empty()).then_some(version)
}

/// The payload, read strictly. Fields and apps it doesn't know are left out, so a later floor that
/// names a new app still holds for the apps this one knows.
fn read_payload(bytes: &[u8]) -> Result<Floor, String> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| "its payload is not JSON".to_string())?;
    if value.get("kind").and_then(Value::as_str) != Some(KIND) {
        return Err(format!("its payload is not a {KIND}"));
    }
    let serial = value
        .get("serial")
        .and_then(Value::as_u64)
        .filter(|serial| *serial >= 1 && *serial < (1u64 << 53))
        .ok_or("its serial is not a whole number from 1")?;
    if !value.get("issued").is_some_and(Value::is_string) {
        return Err("it names no issue time".into());
    }
    let listed = value
        .get("floors")
        .and_then(Value::as_object)
        .ok_or("it lists no floors")?;
    let mut floors = BTreeMap::new();
    for app in ["desktop", "backend", "mobile", "recorder"] {
        let Some(entry) = listed.get(app) else {
            continue;
        };
        let version = entry
            .as_str()
            .and_then(release)
            .ok_or_else(|| format!("its {app} floor is not a release such as 1.2.0"))?;
        floors.insert(app.to_string(), version);
    }
    let cloud = match value.get("cloud") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(origins)) => origins
            .iter()
            .map(|origin| {
                origin
                    .as_str()
                    .filter(|text| is_origin(text))
                    .map(str::to_string)
            })
            .collect::<Option<Vec<_>>>()
            .ok_or("its cloud list is not a list of https origins")?,
        Some(_) => return Err("its cloud list is not a list of https origins".into()),
    };
    Ok(Floor {
        serial,
        floors,
        cloud,
    })
}

/// An `https` origin written exactly as its origin.
fn is_origin(text: &str) -> bool {
    reqwest::Url::parse(text)
        .is_ok_and(|url| url.scheme() == "https" && url.origin().ascii_serialization() == text)
}

/// Major, minor and patch: a candidate or internal build of 1.2.0 counts as 1.2.0.
fn triple(version: &Version) -> (u64, u64, u64) {
    (version.major, version.minor, version.patch)
}

/// The floor's release for `app` when `version` is below it: the release to update to. None when it
/// is at or above it, or the floor doesn't name the app.
pub fn below(floor: Option<&Floor>, app: App, version: &Version) -> Option<Version> {
    let lowest = floor?.floors.get(app.key())?;
    (triple(version) < triple(lowest)).then(|| lowest.clone())
}

/// Where this app is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Place {
    /// Running its own back end on this computer, or setting one up.
    Contained,
    /// Connected to an OpenBot that runs somewhere else, at this address.
    Connected(String),
}

/// Whether the floor holds here: always for this app's own back end, and for any other OpenBot only
/// when the floor lists its origin in `cloud`.
pub fn applies(floor: &Floor, place: &Place) -> bool {
    match place {
        Place::Contained => true,
        Place::Connected(address) => reqwest::Url::parse(address).is_ok_and(|url| {
            floor
                .cloud
                .iter()
                .any(|origin| *origin == url.origin().ascii_serialization())
        }),
    }
}

/// What holds this app back here, if anything: the release to update to.
///
/// Contained, the app is below the floor when it is below the Desktop floor, or when its own
/// release, the one it lays out for its back end, is below the back end's floor: no Start of this
/// app can then run a safe back end, so only the app's update helps. A back end on this computer
/// older than its floor while the app's own release is not is upgraded at Start, as every
/// installation behind the app is (`upgrade.rs`); `backend_due` says so.
pub fn blocked(
    floor: Option<&Floor>,
    app: &Version,
    own_release: &Version,
    place: &Place,
) -> Option<Version> {
    let floor = floor.filter(|floor| applies(floor, place))?;
    let desktop = below(Some(floor), App::Desktop, app);
    match place {
        Place::Contained => desktop.or_else(|| below(Some(floor), App::Backend, own_release)),
        Place::Connected(_) => desktop,
    }
}

/// Whether the back end laid out on this computer is below its floor, and so must be upgraded
/// before it starts again.
pub fn backend_due(floor: Option<&Floor>, deployment: &Version) -> bool {
    below(floor, App::Backend, deployment).is_some()
}

/// Whether `candidate` replaces `held`: only a higher serial does.
pub fn replaces(held: Option<&Floor>, candidate: &Floor) -> bool {
    held.is_none_or(|held| candidate.serial > held.serial)
}

/// The floor this app keeps, in its config directory, exactly as it was published.
pub struct Kept {
    path: PathBuf,
}

impl Kept {
    pub fn at(folder: &Path) -> Self {
        Self {
            path: folder.join(FILE),
        }
    }

    /// The kept floor, verified again as it is read, so a changed copy on disk counts for nothing.
    pub fn read(&self, keys: &[[u8; 32]]) -> Option<Floor> {
        let text = std::fs::read_to_string(&self.path).ok()?;
        verify(&text, keys).ok()
    }

    fn write(&self, text: &str) -> Result<(), String> {
        if let Some(folder) = self.path.parent() {
            std::fs::create_dir_all(folder).map_err(|error| error.to_string())?;
        }
        let partial = self.path.with_extension("json.partial");
        std::fs::write(&partial, text).map_err(|error| error.to_string())?;
        std::fs::rename(&partial, &self.path).map_err(|error| error.to_string())
    }
}

/// Where a floor is read from: an address, or, for an internal build's test floor, a file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    Address(reqwest::Url),
    File(PathBuf),
}

fn read_source(client: &reqwest::blocking::Client, source: &Source) -> Result<String, String> {
    match source {
        Source::File(path) => std::fs::read_to_string(path).map_err(|error| error.to_string()),
        Source::Address(url) => {
            let response = client
                .get(url.clone())
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .map_err(|error| error.to_string())?;
            if !response.status().is_success() {
                return Err(format!("answered {}", response.status()));
            }
            let mut body = Vec::new();
            response
                .take(LARGEST + 1)
                .read_to_end(&mut body)
                .map_err(|error| error.to_string())?;
            String::from_utf8(body).map_err(|_| "it is not text".to_string())
        }
    }
}

/// What a read of the published floor came to, for the log.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// A newer floor verified, and is kept now.
    Newer(u64),
    /// The published floor verified and is not newer than the kept one.
    NotNewer(u64),
    /// Nothing that verified was found: why, for the last source tried.
    Nothing(String),
}

/// Reads the published floor and keeps it when it verifies and its serial is higher than the kept
/// one's. Answers the floor that holds now, and what the read came to.
pub fn refresh(kept: &Kept, sources: &[Source], keys: &[[u8; 32]]) -> (Option<Floor>, Outcome) {
    let held = kept.read(keys);
    let client = match reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => return (held, Outcome::Nothing(error.to_string())),
    };
    let mut last = String::from("no address to read");
    for source in sources {
        let text = match read_source(&client, source) {
            Ok(text) => text,
            Err(error) => {
                last = format!("{source:?}: {error}");
                continue;
            }
        };
        let floor = match verify(&text, keys) {
            Ok(floor) => floor,
            Err(error) => {
                last = format!("{source:?}: {error}");
                continue;
            }
        };
        if !replaces(held.as_ref(), &floor) {
            return (held, Outcome::NotNewer(floor.serial));
        }
        if let Err(error) = kept.write(&text) {
            log::warn!(
                "[security floor] could not keep floor {}: {error}",
                floor.serial
            );
        }
        let serial = floor.serial;
        return (Some(floor), Outcome::Newer(serial));
    }
    (held, Outcome::Nothing(last))
}

/// The floor this app holds now, for the window and for Start to ask.
#[derive(Default)]
pub struct Known {
    floor: Mutex<Option<Floor>>,
}

impl Known {
    pub fn get(&self) -> Option<Floor> {
        self.floor.lock().unwrap().clone()
    }

    /// Keeps `floor` when it is newer than the one held, and says whether it was.
    pub fn record(&self, floor: Option<Floor>) -> bool {
        let Some(floor) = floor else {
            return false;
        };
        let mut held = self.floor.lock().unwrap();
        if replaces(held.as_ref(), &floor) {
            *held = Some(floor);
            true
        } else {
            false
        }
    }
}

/// What the window asks the shell (`security_floor`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub blocked: bool,
}

/// The sources an internal build reads instead, and the extra key it trusts, from its environment.
/// None for any other build.
pub fn test_sources(
    version: &Version,
    var: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Option<(Vec<Source>, Option<[u8; 32]>)> {
    if !crate::app_update::internal(version) {
        return None;
    }
    let named = var(TEST_FLOOR)?.into_string().ok()?;
    if named.is_empty() {
        return None;
    }
    let source = match reqwest::Url::parse(&named) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => Source::Address(url),
        _ => Source::File(PathBuf::from(named)),
    };
    let key = var(TEST_KEY)
        .and_then(|key| key.into_string().ok())
        .and_then(|key| key_bytes(&key));
    Some((vec![source], key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Cases {
        #[serde(rename = "publicKey")]
        public_key: String,
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        document: String,
        verifies: bool,
        serial: Option<u64>,
        desktop: Option<String>,
    }

    fn cases() -> Cases {
        serde_json::from_str(include_str!(
            "../../../shared/fixtures/security-floor/cases.json"
        ))
        .unwrap()
    }

    fn doc(name: &str) -> String {
        cases()
            .cases
            .into_iter()
            .find(|case| case.name == name)
            .unwrap()
            .document
    }

    fn trusted() -> Vec<[u8; 32]> {
        vec![key_bytes(&cases().public_key).unwrap()]
    }

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    /// The same documents the TypeScript apps verify, decided the same way.
    #[test]
    fn verifies_what_every_app_verifies_and_nothing_else() {
        let keys = trusted();
        for case in cases().cases {
            let verified = verify(&case.document, &keys);
            assert_eq!(verified.is_ok(), case.verifies, "{}", case.name);
            if let Ok(floor) = verified {
                assert_eq!(Some(floor.serial), case.serial, "{}", case.name);
                assert_eq!(
                    floor.floors.get("desktop").map(Version::to_string),
                    case.desktop,
                    "{}",
                    case.name
                );
            }
        }
        // Built with no key, the app trusts no floor at all.
        assert!(verify(&doc("current"), &[]).is_err());
    }

    #[test]
    fn the_app_is_built_with_the_addresses_beside_the_update_feed() {
        let found: Vec<String> = addresses().iter().map(reqwest::Url::to_string).collect();
        assert_eq!(
            found,
            [
                "https://downloads.copilotkit.ai/latest/security-floor.json",
                "https://github.com/CopilotKit/OpenBot/releases/latest/download/security-floor.json",
            ]
        );
    }

    #[test]
    fn below_the_floor_here_blocks_and_a_company_server_ignores_it() {
        let floor = verify(&doc("current"), &trusted()).unwrap();
        let contained = Place::Contained;
        // Below the Desktop floor: blocked, to the floor's release.
        assert_eq!(
            blocked(Some(&floor), &v("1.1.1"), &v("1.1.1"), &contained),
            Some(v("1.1.2"))
        );
        // At it, with its own release at the back end's floor: not blocked.
        assert_eq!(
            blocked(Some(&floor), &v("1.1.2"), &v("1.1.2"), &contained),
            None
        );
        // A candidate or internal build of the floor's release counts as that release.
        assert_eq!(
            blocked(Some(&floor), &v("1.1.2-rc.1"), &v("1.1.2"), &contained),
            None
        );
        assert_eq!(
            blocked(
                Some(&floor),
                &v("1.1.1-internal.3.gabc"),
                &v("1.1.1"),
                &contained
            ),
            Some(v("1.1.2"))
        );
        // Connected to a company's own OpenBot: the floor is not for it.
        let company = Place::Connected("https://openbot.acme.example/".into());
        assert_eq!(
            blocked(Some(&floor), &v("1.0.0"), &v("1.0.0"), &company),
            None
        );
        // Connected to an OpenBot Cloud address the floor lists: it holds.
        let cloud = Place::Connected("https://cloud.openbot.example/some/page".into());
        assert_eq!(
            blocked(Some(&floor), &v("1.0.0"), &v("1.0.0"), &cloud),
            Some(v("1.1.2"))
        );
        // No floor verified yet: nothing is blocked.
        assert_eq!(blocked(None, &v("0.0.1"), &v("0.0.1"), &contained), None);
    }

    #[test]
    fn a_back_end_below_its_floor_is_due_an_upgrade() {
        let floor = verify(&doc("current"), &trusted()).unwrap();
        assert!(backend_due(Some(&floor), &v("1.1.1")));
        assert!(!backend_due(Some(&floor), &v("1.1.2")));
        assert!(!backend_due(None, &v("0.0.1")));
    }

    fn folder(label: &str) -> PathBuf {
        let folder = crate::test_support::temp_root(label);
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    fn file_with(dir: &Path, name: &str, text: &str) -> Source {
        let path = dir.join(name);
        std::fs::write(&path, text).unwrap();
        Source::File(path)
    }

    #[test]
    fn a_verified_floor_is_kept_and_still_blocks_offline() {
        let dir = folder("security-floor-kept");
        let kept = Kept::at(&dir.join("config"));
        let keys = trusted();
        let published = file_with(&dir, "published.json", &doc("current"));
        let (floor, read) = refresh(&kept, &[published], &keys);
        assert_eq!(read, Outcome::Newer(2));
        assert_eq!(floor.as_ref().map(|floor| floor.serial), Some(2));
        // Offline: nothing answers, and the kept floor still holds.
        let unreachable =
            Source::Address("http://127.0.0.1:9/security-floor.json".parse().unwrap());
        let (offline, read) = refresh(&kept, &[unreachable], &keys);
        assert!(matches!(read, Outcome::Nothing(_)));
        assert_eq!(
            blocked(
                offline.as_ref(),
                &v("1.1.1"),
                &v("1.1.1"),
                &Place::Contained
            ),
            Some(v("1.1.2"))
        );
    }

    #[test]
    fn an_older_unsigned_or_tampered_floor_changes_nothing() {
        let keys = trusted();
        for name in [
            "older",
            "unsigned",
            "zero signature",
            "tampered",
            "other key",
            "not a floor",
        ] {
            let dir = folder(&format!("security-floor-{}", name.replace(' ', "-")));
            let kept = Kept::at(&dir);
            std::fs::write(dir.join(FILE), doc("current")).unwrap();
            let published = file_with(&dir, "published.json", &doc(name));
            let (floor, _) = refresh(&kept, &[published], &keys);
            assert_eq!(floor.map(|floor| floor.serial), Some(2), "{name}");
            assert_eq!(
                std::fs::read_to_string(dir.join(FILE)).unwrap(),
                doc("current"),
                "{name}"
            );
        }
    }

    #[test]
    fn a_first_launch_that_never_reached_the_feed_runs() {
        let dir = folder("security-floor-first-launch");
        let kept = Kept::at(&dir);
        let unreachable =
            Source::Address("http://127.0.0.1:9/security-floor.json".parse().unwrap());
        let (floor, _) = refresh(&kept, &[unreachable], &trusted());
        assert_eq!(floor, None);
        assert_eq!(
            blocked(floor.as_ref(), &v("0.0.1"), &v("0.0.1"), &Place::Contained),
            None
        );
        assert!(!dir.join(FILE).exists());
    }

    #[test]
    fn a_kept_copy_changed_on_disk_counts_for_nothing() {
        let dir = folder("security-floor-changed");
        std::fs::write(dir.join(FILE), doc("tampered")).unwrap();
        assert_eq!(Kept::at(&dir).read(&trusted()), None);
    }

    #[test]
    fn the_shell_keeps_only_a_higher_serial() {
        let keys = trusted();
        let known = Known::default();
        assert!(known.record(verify(&doc("current"), &keys).ok()));
        assert!(!known.record(verify(&doc("older"), &keys).ok()));
        assert_eq!(known.get().map(|floor| floor.serial), Some(2));
    }

    #[test]
    fn only_an_internal_build_reads_a_test_floor() {
        let var = |name: &str| match name {
            TEST_FLOOR => Some("http://127.0.0.1:8123/security-floor.json".into()),
            TEST_KEY => Some(cases().public_key.into()),
            _ => None,
        };
        assert_eq!(test_sources(&v("1.1.1"), var), None);
        assert_eq!(test_sources(&v("1.1.2-rc.1"), var), None);
        let (sources, key) = test_sources(&v("1.1.1-internal.4.gabc"), var).unwrap();
        assert_eq!(
            sources,
            [Source::Address(
                "http://127.0.0.1:8123/security-floor.json".parse().unwrap()
            )]
        );
        assert_eq!(key, key_bytes(&cases().public_key));
    }
}
