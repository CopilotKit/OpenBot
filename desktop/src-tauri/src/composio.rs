//! Preparing this installation's app broker with the existing native CopilotKit sign-in.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

use rand::RngCore;

use crate::problem::Problem;

#[derive(Debug, PartialEq, Eq)]
pub enum Prepared {
    Configured,
    Preserved,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectConnection {
    installation_id: String,
    project_id: String,
    api_key: String,
    #[serde(rename = "reused")]
    _reused: bool,
}

pub const BROKER_KEYS: [&str; 2] = ["COMPOSIO_API_KEY", "ARCADE_API_KEY"];

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
pub fn configured(root: &Path) -> Result<BTreeMap<String, String>, Problem> {
    let mut values = file_settings(&root.join(".env"))?;
    for name in BROKER_KEYS {
        if let Some(value) =
            crate::vault::recall(root, name)?.filter(|value| !value.trim().is_empty())
        {
            values.insert(name.into(), value);
        }
    }
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
    Ok(values)
}

pub fn ensure(root: &Path, session: &str) -> Result<Prepared, Problem> {
    ensure_at(root, session, crate::intelligence::OPS_API)
}

fn ensure_at(root: &Path, session: &str, origin: &str) -> Result<Prepared, Problem> {
    let values = configured(root)?;
    prepare_with(
        root,
        &values,
        |id| provision_at(origin, session, id),
        |key| crate::vault::remember(root, "COMPOSIO_API_KEY", key),
    )
}

fn provision_at(origin: &str, session: &str, id: &str) -> Result<ProjectConnection, Problem> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| setup_problem())?;
    let response = client
        .post(format!("{origin}/api/cli/integrations/composio/project"))
        .bearer_auth(session)
        .json(&serde_json::json!({ "installationId": id }))
        .send()
        .map_err(|_| setup_problem())?;
    if !response.status().is_success() {
        return Err(setup_problem());
    }
    response.json().map_err(|_| setup_problem())
}

fn setup_problem() -> Problem {
    Problem::plain("OpenBot could not prepare your apps. Check your connection and try signing in again. If this continues, your administrator should check that the Ops app provisioning service is deployed.")
}

fn prepare_with(
    root: &Path,
    configured: &BTreeMap<String, String>,
    request: impl FnOnce(&str) -> Result<ProjectConnection, Problem>,
    remember: impl FnOnce(&str) -> Result<(), Problem>,
) -> Result<Prepared, Problem> {
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
        return Ok(Prepared::Preserved);
    }
    if !provider.is_empty() && provider != "composio" {
        return Err(Problem::plain("The app provider must be composio or arcade. Ask your administrator to check OPENBOT_BROKER_PROVIDER, then sign in again."));
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
    remember(&connection.api_key).map_err(|_| Problem::plain("OpenBot could not save your app connection securely. Check access to its folder and try signing in again."))?;
    Ok(Prepared::Configured)
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
    Problem::plain("OpenBot could not keep this installation's app setup. Check access to its folder and try signing in again.")
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

    #[test]
    fn quoted_dotenv_broker_keys_are_decoded_before_native_migration() {
        if crate::test_support::isolated_process(
            "composio::tests::quoted_dotenv_broker_keys_are_decoded_before_native_migration",
        ) {
            return;
        }
        for name in BROKER_KEYS
            .into_iter()
            .chain(["OPENBOT_BROKER_PROVIDER", "OPENBOT_INSTALLATION_ID"])
        {
            std::env::remove_var(name);
        }
        for name in BROKER_KEYS {
            for quote in ['\'', '"', '`'] {
                let root = crate::test_support::temp_root("quoted-broker-migration");
                std::fs::create_dir_all(&root).unwrap();
                let path = root.join(".env");
                std::fs::write(
                    &path,
                    format!(
                        "{name}={quote}synthetic#key{quote} # comment with {quote}quotes{quote}\n"
                    ),
                )
                .unwrap();
                let values = configured(&root).unwrap();
                assert_eq!(values[name], "synthetic#key");
                let (settings, secrets) = crate::vault::split(values);
                crate::vault::write_env_after_remembering(
                    &root, &path, &settings, &secrets, &secrets,
                )
                .unwrap();
                assert_eq!(
                    crate::vault::recall(&root, name).unwrap().as_deref(),
                    Some("synthetic#key")
                );
                assert!(!std::fs::read_to_string(&path)
                    .unwrap()
                    .contains("synthetic#key"));
                assert_eq!(configured(&root).unwrap()[name], "synthetic#key");
                std::fs::remove_dir_all(root).unwrap();
            }
        }
    }

    #[test]
    fn quoted_file_provider_and_identity_are_decoded_but_native_credentials_are_not() {
        if crate::test_support::isolated_process("composio::tests::quoted_file_provider_and_identity_are_decoded_but_native_credentials_are_not") { return; }
        for name in BROKER_KEYS
            .into_iter()
            .chain(["OPENBOT_BROKER_PROVIDER", "OPENBOT_INSTALLATION_ID"])
        {
            std::env::remove_var(name);
        }
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
        let values = configured(&root).unwrap();
        assert_eq!(
            prepare_with(
                &root,
                &values,
                |_| panic!("active Arcade must be preserved"),
                |_| panic!("no new key")
            )
            .unwrap(),
            Prepared::Preserved
        );
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
        prepare_with(
            &root,
            &configured(&root).unwrap(),
            |actual| {
                assert_eq!(actual, id.to_ascii_lowercase());
                Ok(connection(actual))
            },
            |_| Ok(()),
        )
        .unwrap();
        crate::vault::remember(&root, "COMPOSIO_API_KEY", "\"literal-native-quotes\"").unwrap();
        assert_eq!(
            configured(&root).unwrap()["COMPOSIO_API_KEY"],
            "\"literal-native-quotes\""
        );
        std::env::set_var("COMPOSIO_API_KEY", "'literal-process-quotes'");
        assert_eq!(
            configured(&root).unwrap()["COMPOSIO_API_KEY"],
            "'literal-process-quotes'"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ops_request_uses_only_the_cli_session_and_rejects_errors_without_body_details() {
        let id = "e1503aba-d1ba-4d21-ab5e-7b6cb109bfb6";
        let (url, requests) = crate::http_test_support::response_server(vec![
            (
                "200 OK",
                r#"{"installationId":"e1503aba-d1ba-4d21-ab5e-7b6cb109bfb6","projectId":"pr_fixture","apiKey":"synthetic-key","reused":true}"#,
            ),
            ("503 Unavailable", "synthetic-private-error-body"),
        ]);
        let result = provision_at(&url, "synthetic-ops-session", id).unwrap();
        assert_eq!(result.api_key, "synthetic-key");
        let error = provision_at(&url, "synthetic-ops-session", id)
            .err()
            .unwrap();
        let rendered = serde_json::to_string(&error).unwrap();
        assert!(!rendered.contains("synthetic-"));
        let requests = requests.join().unwrap();
        for (headers, body) in requests {
            assert!(headers.starts_with("POST /api/cli/integrations/composio/project HTTP/1.1"));
            assert!(headers
                .to_ascii_lowercase()
                .contains("authorization: bearer synthetic-ops-session\r\n"));
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                serde_json::json!({"installationId": id})
            );
        }
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
    fn broker_keys_are_native_secrets_and_are_carried_into_startup_without_minting() {
        let keys = BTreeMap::from([
            ("COMPOSIO_API_KEY".into(), "fresh-project-key".into()),
            ("ARCADE_API_KEY".into(), "existing-arcade".into()),
            ("OPENBOT_BROKER_PROVIDER".into(), "arcade".into()),
        ]);
        let (settings, secrets) = crate::vault::split(keys.clone());
        assert_eq!(secrets.len(), 2);
        assert_eq!(
            settings.get("OPENBOT_BROKER_PROVIDER").map(String::as_str),
            Some("arcade")
        );
    }

    #[test]
    fn native_http_retry_stores_project_key_privately_and_next_sign_in_skips_remote() {
        if crate::test_support::isolated_process("composio::tests::native_http_retry_stores_project_key_privately_and_next_sign_in_skips_remote") { return; }
        for name in BROKER_KEYS
            .into_iter()
            .chain(["OPENBOT_BROKER_PROVIDER", "OPENBOT_INSTALLATION_ID"])
        {
            std::env::remove_var(name);
        }
        let root = crate::test_support::temp_root("composio-native-roundtrip");
        std::fs::create_dir_all(&root).unwrap();
        let id = "e1503aba-d1ba-4d21-ab5e-7b6cb109bfb6";
        std::fs::write(
            root.join(".env"),
            format!("OPENBOT_INSTALLATION_ID={id}\nCOMPOSIO_API_KEY=   \n"),
        )
        .unwrap();
        let (url, requests) = crate::http_test_support::response_server(vec![
            ("503 Unavailable", "synthetic-private-error"),
            (
                "200 OK",
                r#"{"installationId":"e1503aba-d1ba-4d21-ab5e-7b6cb109bfb6","projectId":"pr_fixture","apiKey":"synthetic-native-key","reused":true}"#,
            ),
        ]);
        assert!(ensure_at(&root, "synthetic-ops-session", &url).is_err());
        assert_eq!(
            ensure_at(&root, "synthetic-ops-session", &url).unwrap(),
            Prepared::Configured
        );
        assert_eq!(
            ensure_at(&root, "synthetic-ops-session", "http://127.0.0.1:1").unwrap(),
            Prepared::Preserved
        );
        assert_eq!(
            configured(&root).unwrap()["COMPOSIO_API_KEY"],
            "synthetic-native-key"
        );
        assert!(!std::fs::read_to_string(root.join(".env"))
            .unwrap()
            .contains("synthetic-native-key"));
        let requests = requests.join().unwrap();
        assert_eq!(requests[0].1, requests[1].1);
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
            assert_eq!(
                prepare_with(
                    &root,
                    &configured,
                    |_| panic!("must preserve broker"),
                    |_| panic!("must preserve key")
                )
                .unwrap(),
                Prepared::Preserved
            );
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
        let mut saved = false;
        let result = prepare_with(
            &root,
            &values,
            |id| Ok(connection(id)),
            |_| {
                saved = true;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(result, Prepared::Configured);
        assert!(saved);
        assert_eq!(values["ARCADE_API_KEY"], "existing-arcade");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_request_and_storage_failure_reuse_identity_without_exposing_errors() {
        let root = crate::test_support::temp_root("composio-retry");
        std::fs::create_dir_all(&root).unwrap();
        let mut seen = String::new();
        let failed = prepare_with(
            &root,
            &BTreeMap::new(),
            |id| {
                seen = id.into();
                Err(Problem::plain("synthetic-private-session"))
            },
            |_| panic!("no key"),
        );
        assert!(!serde_json::to_string(&failed.unwrap_err())
            .unwrap()
            .contains("synthetic-private-session"));
        let failed = prepare_with(
            &root,
            &BTreeMap::new(),
            |id| {
                assert_eq!(id, seen);
                Ok(connection(id))
            },
            |_| Err(Problem::plain("synthetic-private-key")),
        );
        assert!(!serde_json::to_string(&failed.unwrap_err())
            .unwrap()
            .contains("synthetic-private-key"));
        prepare_with(
            &root,
            &BTreeMap::new(),
            |id| {
                assert_eq!(id, seen);
                Ok(connection(id))
            },
            |_| Ok(()),
        )
        .unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn wrong_response_identity_and_invalid_saved_identity_cannot_save_a_key() {
        let root = crate::test_support::temp_root("composio-identity");
        std::fs::create_dir_all(&root).unwrap();
        assert!(prepare_with(
            &root,
            &BTreeMap::new(),
            |_| Ok(connection("wrong-installation")),
            |_| panic!("invalid response must not be saved")
        )
        .is_err());
        std::fs::write(
            root.join(".env.openbot-installation-id"),
            "OPENBOT_INSTALLATION_ID=invalid\n",
        )
        .unwrap();
        assert!(prepare_with(
            &root,
            &BTreeMap::new(),
            |_| panic!("invalid identity must not request"),
            |_| panic!("no key")
        )
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
        prepare_with(
            &root,
            &configured,
            |actual| {
                assert_eq!(actual, id.to_ascii_lowercase());
                Ok(connection(actual))
            },
            |_| Ok(()),
        )
        .unwrap();
        let different = BTreeMap::from([(
            "OPENBOT_INSTALLATION_ID".into(),
            "a1503aba-d1ba-4d21-ab5e-7b6cb109bfb6".into(),
        )]);
        assert!(prepare_with(
            &root,
            &different,
            |_| panic!("identity mismatch"),
            |_| panic!("no key")
        )
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fresh_setup_persists_identity_before_request_and_saves_only_project_key() {
        let root = crate::test_support::temp_root("desktop-composio-order");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(".env"), "DEPLOYMENT_ID=shared-tenant\n").unwrap();
        let mut requests = 0;
        let mut remembered = None;
        let result = prepare_with(
            &root,
            &BTreeMap::new(),
            |id| {
                requests += 1;
                let saved = std::fs::read_to_string(root.join(".env.openbot-installation-id"))
                    .expect("identity must exist before provisioning starts");
                assert_eq!(saved, format!("OPENBOT_INSTALLATION_ID={id}\n"));
                assert_eq!(id.len(), 36);
                assert!(!id.contains("shared-tenant"));
                Ok(ProjectConnection {
                    installation_id: id.into(),
                    project_id: "pr_fixture".into(),
                    api_key: "synthetic-project-only".into(),
                    _reused: false,
                })
            },
            |key| {
                remembered = Some(key.to_owned());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(result, Prepared::Configured);
        assert_eq!(requests, 1);
        assert_eq!(remembered.as_deref(), Some("synthetic-project-only"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
