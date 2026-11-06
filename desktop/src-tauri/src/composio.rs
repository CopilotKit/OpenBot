//! Preparing this installation's app broker with the CopilotKit sign-in the Intelligence CLI holds.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

use rand::RngCore;

use crate::local_eval::AppsProvisioned;
use crate::problem::Problem;

/// What came back for this installation: the CLI's report, and the key from the file it wrote.
struct ProjectConnection {
    installation_id: String,
    project_id: String,
    api_key: String,
    _reused: bool,
}

pub const BROKER_KEYS: [&str; 2] = ["COMPOSIO_API_KEY", "ARCADE_API_KEY"];

/// The protected-store name of a key provisioned at sign-in.
///
/// Never `COMPOSIO_API_KEY`. That name belongs to the person's own key, in `.env` or the
/// environment, and the two must stay apart: a supplied key always wins and is never moved.
const PROVISIONED_KEY: &str = "COMPOSIO_PROVISIONED_API_KEY";

/// Where the Composio key this installation runs with comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySource {
    /// The person's own, in `.env` or the environment. It always wins and is never moved or removed.
    Supplied,
    /// Made for this installation at CopilotKit sign-in, and kept only in its protected store.
    Provisioned,
}

/// The broker settings this installation runs with, and where its Composio key came from.
pub struct Brokers {
    values: BTreeMap<String, String>,
    composio: Option<KeySource>,
}

impl Brokers {
    pub fn composio_source(&self) -> Option<KeySource> {
        self.composio
    }

    /// What the server is given as its environment on Start and on every supervised restart.
    ///
    /// Never written to a file. A supplied key is already where the person put it, and a
    /// provisioned one stays in the protected store.
    pub fn runtime(&self) -> BTreeMap<String, String> {
        self.values
            .iter()
            .filter(|(name, _)| name.as_str() != "OPENBOT_INSTALLATION_ID")
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect()
    }
}

// Decode only dotenv source bytes. Vault/process values below are already decoded and may
// legitimately contain quote characters. Keep this boundary local to the new broker settings.
fn file_settings(path: &Path) -> Result<BTreeMap<String, String>, Problem> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(_) => return Err(identity_problem()),
    };
    let mut values = BTreeMap::new();
    for line in text.lines() {
        let Some((name, raw)) = line.trim().split_once('=') else {
            continue;
        };
        let name = name.trim();
        if !BROKER_KEYS.contains(&name)
            && !["OPENBOT_BROKER_PROVIDER", "OPENBOT_INSTALLATION_ID"].contains(&name)
        {
            continue;
        }
        let raw = raw.trim();
        let value = match raw.chars().next() {
            Some(quote @ ('\'' | '"' | '`')) => {
                let remaining = &raw[1..];
                let mut escaped = false;
                let closing = remaining
                    .char_indices()
                    .find_map(|(index, ch)| {
                        let closes = ch == quote && !escaped;
                        escaped = ch == '\\' && !escaped;
                        closes.then_some(index)
                    })
                    .ok_or_else(identity_problem)?;
                let trailing = remaining[closing + 1..].trim();
                if !trailing.is_empty() && !trailing.starts_with('#') {
                    return Err(identity_problem());
                }
                remaining[..closing].to_owned()
            }
            _ => raw
                .split('#')
                .next()
                .unwrap_or_default()
                .trim_end()
                .to_owned(),
        };
        if !value.trim().is_empty() {
            values.insert(name.into(), value);
        }
    }
    Ok(values)
}

/// Resolve only broker settings; neither these credentials nor the Ops session cross IPC.
///
/// What the person supplied comes first: the environment over `.env`, as Bun reads them. Only
/// when neither holds a Composio key does a provisioned one fill in.
pub fn resolve(root: &Path) -> Result<Brokers, Problem> {
    let mut values = file_settings(&root.join(".env"))?;
    for name in BROKER_KEYS
        .into_iter()
        .chain(["OPENBOT_BROKER_PROVIDER", "OPENBOT_INSTALLATION_ID"])
    {
        if let Ok(value) = std::env::var(name) {
            if !value.trim().is_empty() {
                values.insert(name.into(), value);
            }
        }
    }
    let composio = if values.contains_key("COMPOSIO_API_KEY") {
        Some(KeySource::Supplied)
    } else if let Some(key) =
        crate::vault::recall(root, PROVISIONED_KEY)?.filter(|value| !value.trim().is_empty())
    {
        values.insert("COMPOSIO_API_KEY".into(), key);
        Some(KeySource::Provisioned)
    } else {
        None
    };
    Ok(Brokers { values, composio })
}

/// A project key provisioning brought back, not yet saved. Opaque: no `Debug`, no `Serialize`.
pub struct ProvisionedKey(String);

impl ProvisionedKey {
    pub fn new(key: String) -> Self {
        Self(key)
    }
}

pub enum Provisioned {
    /// A key or an Arcade choice is already in place, so nothing was asked for.
    Preserved,
    /// A new key. The caller saves it once it knows the sign-in it came from is still current.
    New(ProvisionedKey),
}

/// Where the CLI writes the key it brings back. OpenBot's own folder, owner-only, removed with
/// what is in it as soon as the key is read, whatever the CLI did.
const HANDOFF: &str = ".openbot-apps";
const HANDOFF_FILE: &str = "composio.env";

/// One connection at a time, so a retry and a Start never both ask for the same installation.
static CONNECTING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/**
Connect this installation's apps, once a CopilotKit sign-in is in place.

`cli` runs `copilotkit integrations composio provision` for the installation id, writing into the
file it is given (`local_eval::provision_apps_installed`). The CLI is the one that talks to
CopilotKit Ops, with the session its own `login` saved: OpenBot never reads that session. Ops
makes one Composio project per installation, owned by the signed-in account and organization, and
replays the same key for it later.

Only adds a key. A key the person supplied, an Arcade choice, or a key kept from an earlier
connection means nothing is asked for. A new key goes to the protected store, never to `.env`.
Callers treat a failure as apps unavailable: OpenBot still starts.
*/
pub fn connect(
    root: &Path,
    cli: impl FnOnce(&str, &Path) -> Result<AppsProvisioned, Problem>,
) -> Result<(), Problem> {
    let _one = CONNECTING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match provision(root, cli)? {
        Provisioned::Preserved => Ok(()),
        Provisioned::New(key) => save(root, key),
    }
}

/// Ask for this installation's project key through the CLI. Only the installation identity and
/// the short-lived handoff folder are written.
pub fn provision(
    root: &Path,
    cli: impl FnOnce(&str, &Path) -> Result<AppsProvisioned, Problem>,
) -> Result<Provisioned, Problem> {
    let brokers = resolve(root)?;
    provision_with(root, &brokers.values, |id| request_with_cli(root, id, cli))
}

/// Keep a provisioned key in the protected store. Never in `.env`, and never under the name of a
/// key the person supplies.
pub fn save(root: &Path, key: ProvisionedKey) -> Result<(), Problem> {
    crate::vault::remember(root, PROVISIONED_KEY, &key.0).map_err(|_| {
        Problem::plain(
            "OpenBot couldn't save your apps securely. Check access to its folder, then choose Connect apps.",
        )
    })
}

fn request_with_cli(
    root: &Path,
    id: &str,
    cli: impl FnOnce(&str, &Path) -> Result<AppsProvisioned, Problem>,
) -> Result<ProjectConnection, Problem> {
    let folder = root.join(HANDOFF);
    // A handoff an interrupted attempt left behind. It may hold a key; it never outlives a retry.
    match std::fs::remove_dir_all(&folder) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(setup_problem()),
    }
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        // The CLI refuses a folder another account can write to.
        builder.mode(0o700);
    }
    builder.create(&folder).map_err(|_| setup_problem())?;
    let env_file = folder.join(HANDOFF_FILE);
    let received = cli(id, &env_file).and_then(|reported| {
        let key = file_settings(&env_file)?
            .remove("COMPOSIO_API_KEY")
            .ok_or_else(setup_problem)?;
        Ok(ProjectConnection {
            installation_id: reported.installation_id,
            project_id: reported.project_id,
            api_key: key,
            _reused: reported.reused,
        })
    });
    let removed = std::fs::remove_dir_all(&folder);
    let connection = received.map_err(|_| setup_problem())?;
    // A key that could not be cleared from the handoff is not taken up. The next attempt clears
    // it first, and Ops replays the same key then.
    removed.map_err(|_| setup_problem())?;
    Ok(connection)
}

/// What the person reads when apps could not be connected. Nothing the CLI or Ops said is in it.
pub fn setup_problem() -> Problem {
    Problem::plain("OpenBot couldn't connect your apps. Check your connection, then choose Connect apps. If it keeps happening, ask an admin.")
}

fn provision_with(
    root: &Path,
    configured: &BTreeMap<String, String>,
    request: impl FnOnce(&str) -> Result<ProjectConnection, Problem>,
) -> Result<Provisioned, Problem> {
    let present = |name| {
        configured
            .get(name)
            .is_some_and(|value| !value.trim().is_empty())
    };
    let provider = configured
        .get("OPENBOT_BROKER_PROVIDER")
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if present("COMPOSIO_API_KEY")
        || provider == "arcade"
        || (provider.is_empty() && present("ARCADE_API_KEY"))
    {
        return Ok(Provisioned::Preserved);
    }
    if !provider.is_empty() && provider != "composio" {
        return Err(Problem::with(
            "OpenBot's app settings aren't valid. Ask an admin to check them.",
            "OPENBOT_BROKER_PROVIDER must be composio or arcade.",
        ));
    }
    let id = installation_identity(
        root,
        configured
            .get("OPENBOT_INSTALLATION_ID")
            .map(String::as_str),
    )?;
    let connection = request(&id).map_err(|_| setup_problem())?;
    if connection.installation_id != id
        || connection.project_id.trim().is_empty()
        || connection.api_key.trim().is_empty()
        || connection.api_key.contains(['\r', '\n', '\0'])
    {
        return Err(setup_problem());
    }
    Ok(Provisioned::New(ProvisionedKey(connection.api_key)))
}

fn new_uuid() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let mut id = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if [4, 6, 8, 10].contains(&index) {
            id.push('-');
        }
        use std::fmt::Write;
        write!(id, "{byte:02x}").expect("writing to a String cannot fail");
    }
    id
}

fn canonical_uuid(value: &str) -> Result<String, Problem> {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || !bytes.iter().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
        || !(b'1'..=b'8').contains(&bytes[14])
        || !b"89abAB".contains(&bytes[19])
    {
        return Err(identity_problem());
    }
    Ok(value.to_ascii_lowercase())
}

fn installation_identity(root: &Path, configured: Option<&str>) -> Result<String, Problem> {
    let configured = configured.map(canonical_uuid).transpose()?;
    std::fs::create_dir_all(root).map_err(|_| identity_problem())?;
    let path = root.join(".env.openbot-installation-id");
    if !path.exists() {
        let temporary = root.join(format!(".env.openbot-installation-id.{}", new_uuid()));
        let prepared = (|| -> std::io::Result<()> {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            writeln!(
                file,
                "OPENBOT_INSTALLATION_ID={}",
                configured.clone().unwrap_or_else(new_uuid)
            )?;
            file.sync_all()?;
            drop(file);
            match std::fs::hard_link(&temporary, &path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
            #[cfg(unix)]
            std::fs::File::open(root)?.sync_all()?;
            Ok(())
        })();
        let cleanup = std::fs::remove_file(&temporary);
        prepared.and(cleanup).map_err(|_| identity_problem())?;
    }
    let settings = file_settings(&path)?;
    let saved = settings
        .get("OPENBOT_INSTALLATION_ID")
        .ok_or_else(identity_problem)?;
    let canonical = canonical_uuid(saved)?;
    if configured.is_some_and(|value| value != canonical) {
        return Err(identity_problem());
    }
    if *saved != canonical {
        crate::env::write_private_file(
            &path,
            format!("OPENBOT_INSTALLATION_ID={canonical}\n").as_bytes(),
        )
        .map_err(|_| identity_problem())?;
    }
    Ok(canonical)
}

fn identity_problem() -> Problem {
    Problem::plain("OpenBot couldn't read this installation's app settings. Check access to its folder, then choose Connect apps.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(id: &str) -> ProjectConnection {
        ProjectConnection {
            installation_id: id.into(),
            project_id: "pr_fixture".into(),
            api_key: "synthetic-project-only".into(),
            _reused: false,
        }
    }

    fn clear_broker_environment() {
        for name in BROKER_KEYS
            .into_iter()
            .chain(["OPENBOT_BROKER_PROVIDER", "OPENBOT_INSTALLATION_ID"])
        {
            std::env::remove_var(name);
        }
    }

    fn new_key(result: Result<Provisioned, Problem>) -> String {
        match result {
            Ok(Provisioned::New(key)) => key.0,
            Ok(Provisioned::Preserved) => panic!("expected a new key, nothing was provisioned"),
            Err(problem) => panic!("expected a new key: {}", problem.said),
        }
    }

    /**
    A KEY THE PERSON SUPPLIES ALWAYS WINS, AND STAYS WHERE THEY PUT IT.

    The provisioned key used to override `.env`, so once one existed a key the person added was
    ignored. Each source is checked on real files and the real protected store: `.env`, then the
    environment over it, and the provisioned key only when neither has one.
    */
    #[test]
    fn a_key_the_person_supplies_always_wins_over_a_provisioned_one() {
        if crate::test_support::isolated_process(
            "composio::tests::a_key_the_person_supplies_always_wins_over_a_provisioned_one",
        ) {
            return;
        }
        clear_broker_environment();
        let root = crate::test_support::temp_root("composio-supplied-wins");
        std::fs::create_dir_all(&root).unwrap();
        let env = "COMPOSIO_API_KEY=\"synthetic-person-key\" # mine\n";
        std::fs::write(root.join(".env"), env).unwrap();
        crate::vault::remember(&root, PROVISIONED_KEY, "synthetic-provisioned-key").unwrap();

        let brokers = resolve(&root).unwrap();
        assert_eq!(brokers.composio_source(), Some(KeySource::Supplied));
        assert_eq!(
            brokers.runtime()["COMPOSIO_API_KEY"],
            "synthetic-person-key"
        );
        // A supplied key is never replaced, so nothing is asked for.
        assert!(matches!(
            provision(&root, |_, _| panic!("a supplied key is never replaced")).unwrap(),
            Provisioned::Preserved
        ));

        std::env::set_var("COMPOSIO_API_KEY", "synthetic-environment-key");
        let brokers = resolve(&root).unwrap();
        assert_eq!(brokers.composio_source(), Some(KeySource::Supplied));
        assert_eq!(
            brokers.runtime()["COMPOSIO_API_KEY"],
            "synthetic-environment-key"
        );

        std::env::set_var("COMPOSIO_API_KEY", "   ");
        std::fs::write(root.join(".env"), "COMPOSIO_API_KEY=\n").unwrap();
        let brokers = resolve(&root).unwrap();
        assert_eq!(brokers.composio_source(), Some(KeySource::Provisioned));
        assert_eq!(
            brokers.runtime()["COMPOSIO_API_KEY"],
            "synthetic-provisioned-key"
        );
        assert_eq!(
            std::fs::read_to_string(root.join(".env")).unwrap(),
            "COMPOSIO_API_KEY=\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The person's broker keys are settings. Start's credential sweep never takes them out of `.env`.
    #[test]
    fn broker_keys_the_person_supplies_are_never_swept_into_the_vault() {
        for name in BROKER_KEYS.into_iter().chain(["OPENBOT_BROKER_PROVIDER"]) {
            assert!(!crate::vault::is_secret(name), "{name}");
        }
        assert!(!crate::vault::is_secret(PROVISIONED_KEY));
    }

    #[test]
    fn quoted_dotenv_broker_keys_are_decoded_for_the_server() {
        if crate::test_support::isolated_process(
            "composio::tests::quoted_dotenv_broker_keys_are_decoded_for_the_server",
        ) {
            return;
        }
        clear_broker_environment();
        for name in BROKER_KEYS {
            for quote in ['\'', '"', '`'] {
                let root = crate::test_support::temp_root("quoted-broker-runtime");
                std::fs::create_dir_all(&root).unwrap();
                let path = root.join(".env");
                let line = format!(
                    "{name}={quote}synthetic#key{quote} # comment with {quote}quotes{quote}\n"
                );
                std::fs::write(&path, &line).unwrap();
                assert_eq!(resolve(&root).unwrap().runtime()[name], "synthetic#key");
                assert_eq!(std::fs::read_to_string(&path).unwrap(), line);
                std::fs::remove_dir_all(root).unwrap();
            }
        }
    }

    #[test]
    fn quoted_file_provider_and_identity_are_decoded_but_native_credentials_are_not() {
        if crate::test_support::isolated_process("composio::tests::quoted_file_provider_and_identity_are_decoded_but_native_credentials_are_not") { return; }
        clear_broker_environment();
        let root = crate::test_support::temp_root("quoted-broker-settings");
        std::fs::create_dir_all(&root).unwrap();
        let id = "E1503ABA-D1BA-4D21-AB5E-7B6CB109BFB6";
        std::fs::write(
            root.join(".env"),
            format!(
                "OPENBOT_BROKER_PROVIDER=\"arcade\" # choice\nOPENBOT_INSTALLATION_ID='{id}'\n"
            ),
        )
        .unwrap();
        assert!(matches!(
            provision_with(&root, &resolve(&root).unwrap().values, |_| panic!(
                "active Arcade must be preserved"
            ))
            .unwrap(),
            Provisioned::Preserved
        ));
        std::fs::write(
            root.join(".env"),
            format!(
                "OPENBOT_BROKER_PROVIDER=`composio`\nOPENBOT_INSTALLATION_ID='{id}' # identity\n"
            ),
        )
        .unwrap();
        std::fs::write(
            root.join(".env.openbot-installation-id"),
            format!("OPENBOT_INSTALLATION_ID=\"{id}\"\n"),
        )
        .unwrap();
        new_key(provision_with(
            &root,
            &resolve(&root).unwrap().values,
            |actual| {
                assert_eq!(actual, id.to_ascii_lowercase());
                Ok(connection(actual))
            },
        ));
        save(
            &root,
            ProvisionedKey::new("\"literal-native-quotes\"".into()),
        )
        .unwrap();
        assert_eq!(
            resolve(&root).unwrap().runtime()["COMPOSIO_API_KEY"],
            "\"literal-native-quotes\""
        );
        std::env::set_var("COMPOSIO_API_KEY", "'literal-process-quotes'");
        assert_eq!(
            resolve(&root).unwrap().runtime()["COMPOSIO_API_KEY"],
            "'literal-process-quotes'"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The CLI as `integrations composio provision` behaves on success: the key in the file it
    /// was given, and metadata in its report.
    fn cli_writes(
        key: &'static str,
        reused: bool,
    ) -> impl FnOnce(&str, &Path) -> Result<AppsProvisioned, Problem> {
        move |id, env_file| {
            assert!(env_file.is_absolute());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let folder = std::fs::metadata(env_file.parent().unwrap()).unwrap();
                assert_eq!(folder.permissions().mode() & 0o777, 0o700);
            }
            assert!(!env_file.exists(), "the CLI gets an empty file to write");
            std::fs::write(env_file, format!("COMPOSIO_API_KEY={key}\n")).unwrap();
            Ok(AppsProvisioned {
                installation_id: id.into(),
                project_id: "pr_fixture".into(),
                reused,
            })
        }
    }

    /// A failed CLI leaves nothing behind and says nothing it was told; a report for another
    /// installation, or no key in the file, is not taken up either.
    #[test]
    fn a_failed_or_mismatched_cli_answer_keeps_no_key_and_no_handoff() {
        let root = crate::test_support::temp_root("composio-cli-failures");
        std::fs::create_dir_all(&root).unwrap();
        let failed = provision_with(&root, &BTreeMap::new(), |id| {
            request_with_cli(&root, id, |_, env_file| {
                // Even a file the CLI left half-written goes with the handoff.
                std::fs::write(env_file, "COMPOSIO_API_KEY=synthetic-partial\n").unwrap();
                Err(Problem::plain("synthetic-private-cli-error"))
            })
        });
        let rendered = serde_json::to_string(&failed.err().unwrap()).unwrap();
        assert!(rendered.contains("OpenBot couldn't connect your apps."));
        assert!(!rendered.contains("synthetic-"));
        assert!(!root.join(HANDOFF).exists());

        assert!(provision_with(&root, &BTreeMap::new(), |id| {
            request_with_cli(&root, id, |_, env_file| {
                std::fs::write(env_file, "COMPOSIO_API_KEY=synthetic-key\n").unwrap();
                Ok(AppsProvisioned {
                    installation_id: "a1503aba-d1ba-4d21-ab5e-7b6cb109bfb6".into(),
                    project_id: "pr_fixture".into(),
                    reused: false,
                })
            })
        })
        .is_err());
        assert!(provision_with(&root, &BTreeMap::new(), |id| {
            request_with_cli(&root, id, |id, _| {
                Ok(AppsProvisioned {
                    installation_id: id.into(),
                    project_id: "pr_fixture".into(),
                    reused: false,
                })
            })
        })
        .is_err());
        assert!(!root.join(HANDOFF).exists());

        // A handoff an interrupted attempt left behind is cleared before the CLI runs again.
        std::fs::create_dir_all(root.join(HANDOFF)).unwrap();
        std::fs::write(
            root.join(HANDOFF).join(HANDOFF_FILE),
            "COMPOSIO_API_KEY=stale\n",
        )
        .unwrap();
        let key = new_key(provision_with(&root, &BTreeMap::new(), |id| {
            request_with_cli(&root, id, cli_writes("synthetic-fresh-key", false))
        }));
        assert_eq!(key, "synthetic-fresh-key");
        assert!(!root.join(HANDOFF).exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn simultaneous_first_attempts_share_one_private_identity() {
        let root = crate::test_support::temp_root("composio-concurrent");
        std::fs::create_dir_all(&root).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let root = root.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    installation_identity(&root, None).unwrap()
                })
            })
            .collect();
        let identities: std::collections::BTreeSet<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(identities.len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.join(".env.openbot-installation-id"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_retry_through_the_cli_keeps_the_key_privately_and_the_next_connect_asks_nobody() {
        if crate::test_support::isolated_process("composio::tests::a_retry_through_the_cli_keeps_the_key_privately_and_the_next_connect_asks_nobody") { return; }
        clear_broker_environment();
        let root = crate::test_support::temp_root("composio-cli-roundtrip");
        std::fs::create_dir_all(&root).unwrap();
        let id = "e1503aba-d1ba-4d21-ab5e-7b6cb109bfb6";
        let env = format!("OPENBOT_INSTALLATION_ID={id}\nCOMPOSIO_API_KEY=   \n");
        std::fs::write(root.join(".env"), &env).unwrap();
        let mut asked = Vec::new();
        assert!(connect(&root, |id, _| {
            asked.push(id.to_owned());
            Err(Problem::plain("synthetic-expired-session"))
        })
        .is_err());
        assert!(crate::vault::recall(&root, PROVISIONED_KEY)
            .unwrap()
            .is_none());
        // Ops replays the key it made for this installation: `reused` is still a key to keep.
        connect(&root, |id, env_file| {
            asked.push(id.to_owned());
            cli_writes("synthetic-native-key", true)(id, env_file)
        })
        .unwrap();
        connect(&root, |_, _| panic!("a kept key is never asked for again")).unwrap();
        let brokers = resolve(&root).unwrap();
        assert_eq!(brokers.composio_source(), Some(KeySource::Provisioned));
        assert_eq!(
            brokers.runtime()["COMPOSIO_API_KEY"],
            "synthetic-native-key"
        );
        assert!(!brokers.runtime().contains_key("OPENBOT_INSTALLATION_ID"));
        assert_eq!(std::fs::read_to_string(root.join(".env")).unwrap(), env);
        assert!(!root.join(HANDOFF).exists());
        assert_eq!(asked, [id, id]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn supplied_keys_and_active_arcade_never_request_or_replace_a_key() {
        for configured in [
            BTreeMap::from([("COMPOSIO_API_KEY".into(), "supplied".into())]),
            BTreeMap::from([("ARCADE_API_KEY".into(), "supplied".into())]),
            BTreeMap::from([("OPENBOT_BROKER_PROVIDER".into(), "arcade".into())]),
        ] {
            let root = crate::test_support::temp_root("composio-preserve");
            assert!(matches!(
                provision_with(&root, &configured, |_| panic!("must preserve broker")).unwrap(),
                Provisioned::Preserved
            ));
            assert!(!root.exists());
        }
    }

    #[test]
    fn explicit_composio_selection_can_prepare_while_an_unused_arcade_key_is_preserved() {
        let root = crate::test_support::temp_root("composio-explicit-provider");
        let values = BTreeMap::from([
            ("ARCADE_API_KEY".into(), "existing-arcade".into()),
            ("OPENBOT_BROKER_PROVIDER".into(), "composio".into()),
        ]);
        assert_eq!(
            new_key(provision_with(&root, &values, |id| Ok(connection(id)))),
            "synthetic-project-only"
        );
        assert_eq!(values["ARCADE_API_KEY"], "existing-arcade");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_interrupted_request_reuses_identity_without_exposing_errors() {
        let root = crate::test_support::temp_root("composio-retry");
        std::fs::create_dir_all(&root).unwrap();
        let mut seen = String::new();
        let failed = provision_with(&root, &BTreeMap::new(), |id| {
            seen = id.into();
            Err(Problem::plain("synthetic-private-session"))
        });
        assert!(!serde_json::to_string(&failed.err().unwrap())
            .unwrap()
            .contains("synthetic-private-session"));
        new_key(provision_with(&root, &BTreeMap::new(), |id| {
            assert_eq!(id, seen);
            Ok(connection(id))
        }));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn wrong_response_identity_and_invalid_saved_identity_cannot_save_a_key() {
        let root = crate::test_support::temp_root("composio-identity");
        std::fs::create_dir_all(&root).unwrap();
        assert!(provision_with(&root, &BTreeMap::new(), |_| Ok(connection(
            "wrong-installation"
        )))
        .is_err());
        std::fs::write(
            root.join(".env.openbot-installation-id"),
            "OPENBOT_INSTALLATION_ID=invalid\n",
        )
        .unwrap();
        assert!(provision_with(&root, &BTreeMap::new(), |_| panic!(
            "invalid identity must not request"
        ))
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn configured_and_saved_uppercase_identity_are_canonical_and_must_agree() {
        let root = crate::test_support::temp_root("composio-canonical");
        std::fs::create_dir_all(&root).unwrap();
        let id = "E1503ABA-D1BA-4D21-AB5E-7B6CB109BFB6";
        let configured = BTreeMap::from([("OPENBOT_INSTALLATION_ID".into(), id.into())]);
        std::fs::write(
            root.join(".env.openbot-installation-id"),
            format!("OPENBOT_INSTALLATION_ID={id}\n"),
        )
        .unwrap();
        new_key(provision_with(&root, &configured, |actual| {
            assert_eq!(actual, id.to_ascii_lowercase());
            Ok(connection(actual))
        }));
        let different = BTreeMap::from([(
            "OPENBOT_INSTALLATION_ID".into(),
            "a1503aba-d1ba-4d21-ab5e-7b6cb109bfb6".into(),
        )]);
        assert!(provision_with(&root, &different, |_| panic!("identity mismatch")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fresh_setup_persists_identity_before_request_and_returns_only_project_key() {
        let root = crate::test_support::temp_root("desktop-composio-order");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(".env"), "DEPLOYMENT_ID=shared-tenant\n").unwrap();
        let mut requests = 0;
        let key = new_key(provision_with(&root, &BTreeMap::new(), |id| {
            requests += 1;
            let saved = std::fs::read_to_string(root.join(".env.openbot-installation-id"))
                .expect("identity must exist before provisioning starts");
            assert_eq!(saved, format!("OPENBOT_INSTALLATION_ID={id}\n"));
            assert_eq!(id.len(), 36);
            assert!(!id.contains("shared-tenant"));
            Ok(connection(id))
        }));
        assert_eq!(requests, 1);
        assert_eq!(key, "synthetic-project-only");
        std::fs::remove_dir_all(root).unwrap();
    }
}
