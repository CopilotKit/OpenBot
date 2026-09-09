/*!
Where a secret lives, which is not the `.env`.

WHY NOT THE FILE. Everything OpenBot needs to run is settings, and settings belong in a file
somebody can read. A model key, a plan token and the generated tokens the services authenticate to
each other with are not settings: they are credentials, and a credential in a dotfile is one
`cat`, one screen-share or one support ticket away from being somewhere else. This machine has a
place for them already, so they go there and the file keeps the settings.

WHAT EACH PLATFORM ACTUALLY GETS.

- **macOS: the login Keychain**, through the Security framework rather than the `security` command,
  which truncates at 128 bytes without saying so. One generic-password item per setting, so a
  person can see and revoke them one at a time in Keychain Access.
- **Windows: DPAPI**, through PowerShell's `ProtectedData`, encrypting to the signed-in user so the
  ciphertext is useless to any other account on the machine, and to anybody who copies the file off
  it.
- **Linux: an owner-only file**, and said out loud rather than pretended otherwise. There is no
  keystore a desktop Linux install can be assumed to have: Secret Service needs a session daemon
  that a headless or minimal machine does not run, and failing to save a credential because
  `gnome-keyring` is absent would be a worse product than a 0600 file.

THE VALUE NEVER GOES ON A COMMAND LINE. `ps` is readable by every process the person runs. macOS
hands the bytes to the framework directly; Windows writes over stdin, since PowerShell reading the
console to the end has no buffer limit of its own.
*/

use std::collections::BTreeMap;
// Only the two platforms that hand a value to another program need to write to a pipe, and only
// the two that keep a file need a path to keep it at.
#[cfg(target_os = "windows")]
use std::io::Write;
#[cfg(not(target_os = "macos"))]
use std::path::PathBuf;

use crate::problem::Problem;

/// What the Keychain files these under.
///
/// macOS only, because only the Keychain has a service name: Windows keys DPAPI blobs by filename
/// and the Linux fallback is a file in the config directory. Left unscoped it is dead code
/// everywhere else, and CI runs clippy with `-D warnings`, so a Linux build failed on it.
#[cfg(target_os = "macos")]
const SERVICE: &str = "OpenBot";

/**
Whether a setting is a credential.

By name, and the list is the point. A classifier that guessed from the value would be wrong in both
directions: `INTELLIGENCE_API_URL` looks like nothing and `POSTGRES_PORT` looks like nothing, while
a generated token looks exactly like a random string of settings. Anything not named here is a
setting and goes in the file where somebody can read it.
*/
pub fn is_secret(key: &str) -> bool {
    matches!(
        key,
        // Somebody's own credentials, pasted or signed in for.
        "INTELLIGENCE_API_KEY"
            | "OPENAI_API_KEY"
            | "ANTHROPIC_API_KEY"
            | "CLAUDE_CODE_OAUTH_TOKEN"
            // Retired, and still swept up: a machine that ran an older version has one of these.
            | "CHATGPT_OAUTH_TOKEN"
            // Generated here, and no less a credential for it. These are what the services prove
            // themselves to each other with, and what a Bot's computer is driven with.
            | "MANAGED_AGENT_TOKEN"
            | "AGENT_TOOL_TOKEN"
            | "COMPUTER_TOKEN"
            | "SUPERVISOR_TOKEN"
            | "WORKER_SHARED_SECRET"
            | "KEY_ENCRYPTION_KEY"
    )
}

/// Split what a run produced into what the file may hold and what it may not.
pub fn split(
    all: BTreeMap<String, String>,
) -> (BTreeMap<String, String>, BTreeMap<String, String>) {
    let mut settings = BTreeMap::new();
    let mut secrets = BTreeMap::new();
    for (key, value) in all {
        if is_secret(&key) {
            secrets.insert(key, value);
        } else {
            settings.insert(key, value);
        }
    }
    (settings, secrets)
}

/**
Put every secret away, and take each one out of the file it used to be written to.

Both halves matter. Storing without clearing would leave the old copy behind on every machine that
has run an earlier version, which is the same credential in the same file for no benefit at all.
*/
pub fn remember_all(secrets: &BTreeMap<String, String>) -> Result<(), Problem> {
    remember_all_with(secrets, &mut remember, &mut forget)
}

pub fn write_env_after_remembering(
    path: &std::path::Path,
    settings: &BTreeMap<String, String>,
    secrets: &BTreeMap<String, String>,
    purge: &BTreeMap<String, String>,
) -> Result<(), Problem> {
    write_env_after_remembering_with(path, settings, secrets, purge, remember, forget)
}

fn write_env_after_remembering_with(
    path: &std::path::Path,
    settings: &BTreeMap<String, String>,
    secrets: &BTreeMap<String, String>,
    purge: &BTreeMap<String, String>,
    mut remember_one: impl FnMut(&str, &str) -> Result<(), Problem>,
    mut forget_one: impl FnMut(&str),
) -> Result<(), Problem> {
    remember_all_with(secrets, &mut remember_one, &mut forget_one)?;
    crate::env::write(path, settings, purge)
        .map_err(|e| format!("could not write .env: {e}").into())
}

pub(crate) fn remember_all_with(
    secrets: &BTreeMap<String, String>,
    remember_one: &mut impl FnMut(&str, &str) -> Result<(), Problem>,
    forget_one: &mut impl FnMut(&str),
) -> Result<(), Problem> {
    for (key, value) in secrets {
        if value.trim().is_empty() {
            forget_one(key);
            continue;
        }
        remember_one(key, value)?;
    }
    Ok(())
}

/// A raw secret read, separated by whether the operating system may ask the person.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadPolicy {
    /// No protected store at all. This is the startup and React-mount policy.
    FileOnly,
    /// A user-triggered action may ask the operating system for access.
    Interactive,
}

/**
What a previous run left, under the selected interaction policy.

The file path is always read first because legacy `.env` credentials must still migrate. Protected
storage is layered on top only for interactive Start and Ask, where the action needs the credential
now and can show a refusal. Passive saved hints come from local nonsecret intent metadata.
*/
pub fn already_given_with_policy(
    env_file: &std::path::Path,
    keys: &[&str],
    policy: ReadPolicy,
) -> Result<BTreeMap<String, String>, Problem> {
    let mut found = crate::env::already_set(env_file, keys);
    if policy == ReadPolicy::FileOnly {
        return Ok(found);
    }

    for key in keys.iter().copied().filter(|key| is_secret(key)) {
        let value = match policy {
            ReadPolicy::FileOnly => None,
            ReadPolicy::Interactive => recall_interactive(key)?,
        };
        if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
            found.insert(key.to_string(), value);
        }
    }
    Ok(found)
}

/// Passive startup hydration. It never asks protected storage for a raw secret.
pub fn already_given_file_only(
    env_file: &std::path::Path,
    keys: &[&str],
) -> BTreeMap<String, String> {
    already_given_with_policy(env_file, keys, ReadPolicy::FileOnly).unwrap_or_default()
}

/// Protected retrieval for a user-triggered action.
pub fn already_given_interactive(
    env_file: &std::path::Path,
    keys: &[&str],
) -> Result<BTreeMap<String, String>, Problem> {
    already_given_with_policy(env_file, keys, ReadPolicy::Interactive)
}

/*
 * ONE READ PER SECRET PER RUN, and this is not a performance note.
 *
 * macOS may authorize protected reads, including after a development build is re-signed.
 * Only explicit Start/Ask actions read the store. Cache success, absence, and refusal once per
 * name per process so one action does not ask again for the same item. Writes and deletions keep
 * the cache in step. Passive startup uses local intent metadata and never reaches this cache.
 */
type CachedRead = Result<Option<String>, Problem>;

static REMEMBERED: std::sync::OnceLock<std::sync::Mutex<BTreeMap<String, CachedRead>>> =
    std::sync::OnceLock::new();

fn cache() -> &'static std::sync::Mutex<BTreeMap<String, CachedRead>> {
    REMEMBERED.get_or_init(|| std::sync::Mutex::new(BTreeMap::new()))
}

/// Read a stored secret, asking the store at most once per name per run.
pub fn recall(name: &str) -> Option<String> {
    recall_interactive(name).ok().flatten()
}

fn recall_interactive(name: &str) -> Result<Option<String>, Problem> {
    recall_interactive_cached(name, cache(), recall_from_store)
}

fn recall_interactive_cached(
    name: &str,
    cache: &std::sync::Mutex<BTreeMap<String, CachedRead>>,
    recall_one: impl FnOnce(&str) -> Result<Option<String>, Problem>,
) -> Result<Option<String>, Problem> {
    if let Ok(held) = cache.lock() {
        if let Some(known) = held.get(name) {
            return known.clone();
        }
    }
    let found = recall_one(name);
    if let Ok(mut held) = cache.lock() {
        held.insert(name.to_string(), found.clone());
    }
    found
}

/// Store a secret, and keep the cache in step so the next read does not ask again.
pub fn remember(name: &str, value: &str) -> Result<(), Problem> {
    remember_cached(name, value, cache(), remember_in_store)
}

fn remember_cached(
    name: &str,
    value: &str,
    cache: &std::sync::Mutex<BTreeMap<String, CachedRead>>,
    remember_one: impl FnOnce(&str, &str) -> Result<(), Problem>,
) -> Result<(), Problem> {
    remember_one(name, value)?;
    if let Ok(mut held) = cache.lock() {
        held.insert(name.to_string(), Ok(Some(value.to_string())));
    }
    Ok(())
}

/// Drop a secret from the store and from the cache.
pub fn forget(name: &str) {
    forget_cached(name, cache(), forget_in_store)
}

fn forget_cached(
    name: &str,
    cache: &std::sync::Mutex<BTreeMap<String, CachedRead>>,
    forget_one: impl FnOnce(&str),
) {
    forget_one(name);
    if let Ok(mut held) = cache.lock() {
        held.insert(name.to_string(), Ok(None));
    }
}

/// Read back what was stored, for the settings named.
pub fn recall_all(keys: &[&str]) -> BTreeMap<String, String> {
    let mut found = BTreeMap::new();
    for key in keys {
        if let Some(value) = recall(key) {
            if !value.trim().is_empty() {
                found.insert((*key).to_string(), value);
            }
        }
    }
    found
}

/*
 * The Keychain through the framework, NOT through the `security` command.
 *
 * MEASURED, AND IT SILENTLY CORRUPTS KEYS. `security add-generic-password` takes its password
 * through a password prompt whose buffer is 128 bytes, and anything longer is cut off with no
 * error and an exit status of zero. Probed one length at a time: 128 stores 128, 129 stores 128,
 * 200 stores 128. An OpenAI project key is 164 characters, so every one of them would have been
 * saved broken and read back broken on the next run, while the run that saved it worked fine
 * because the value it used came straight from the window. No flag raises that buffer, and the
 * only ways past the prompt put the credential on a command line where `ps` can read it. This
 * path has neither a length limit nor an argv.
 */
#[cfg(target_os = "macos")]
fn remember_in_store(name: &str, value: &str) -> Result<(), Problem> {
    // Set, not add: a second run updates the item rather than colliding with the first.
    security_framework::passwords::set_generic_password(SERVICE, name, value.as_bytes())
        .map_err(|error| keychain_problem(error.to_string()))
}

#[cfg(target_os = "macos")]
fn recall_from_store(name: &str) -> Result<Option<String>, Problem> {
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    match security_framework::passwords::get_generic_password(SERVICE, name) {
        Ok(raw) => Ok(String::from_utf8(raw).ok()),
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        Err(error) => Err(keychain_read_problem(error.to_string())),
    }
}

#[cfg(target_os = "macos")]
fn forget_in_store(name: &str) {
    let _ = security_framework::passwords::delete_generic_password(SERVICE, name);
}

#[cfg(target_os = "macos")]
fn keychain_problem(detail: String) -> Problem {
    Problem::with(
        "OpenBot could not save your sign-in details to this Mac's Keychain.",
        detail,
    )
}

#[cfg(target_os = "macos")]
fn keychain_read_problem(detail: String) -> Problem {
    Problem::with(
        "OpenBot needs permission to read saved credentials for this action.",
        detail,
    )
}

/*
 * DPAPI, through the only interpreter Windows is guaranteed to have.
 *
 * `ProtectedData` with `CurrentUser` ties the ciphertext to the signed-in account, so the file is
 * useless on another account and useless copied off the machine. The plaintext arrives on stdin
 * and the ciphertext leaves on stdout, so neither is ever an argument.
 */
#[cfg(target_os = "windows")]
fn remember_in_store(name: &str, value: &str) -> Result<(), Problem> {
    const PROTECT: &str = r#"
$ErrorActionPreference = 'Stop'
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
Add-Type -AssemblyName System.Security
$sealed = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[Convert]::ToBase64String($sealed)
"#;
    let sealed = powershell(PROTECT, Some(value))?;
    let path = vault_dir()?.join(format!("{name}.dpapi"));
    std::fs::write(&path, sealed.trim())
        .map_err(|error| dpapi_problem(format!("{}: {error}", path.display())))
}

#[cfg(target_os = "windows")]
fn recall_from_store(name: &str) -> Result<Option<String>, Problem> {
    const UNPROTECT: &str = r#"
$ErrorActionPreference = 'Stop'
$sealed = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
Add-Type -AssemblyName System.Security
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $null, 'CurrentUser')
[Text.Encoding]::UTF8.GetString($bytes)
"#;
    let path = vault_dir()?.join(format!("{name}.dpapi"));
    let Ok(sealed) = std::fs::read_to_string(path) else {
        return Ok(None);
    };
    powershell(UNPROTECT, Some(&sealed)).map(|plain| Some(plain.trim().to_string()))
}

#[cfg(target_os = "windows")]
fn forget_in_store(name: &str) {
    if let Ok(dir) = vault_dir() {
        let _ = std::fs::remove_file(dir.join(format!("{name}.dpapi")));
    }
}

#[cfg(target_os = "windows")]
fn powershell(program: &str, input: Option<&str>) -> Result<String, Problem> {
    let mut child = crate::quiet::command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", program])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| dpapi_problem(error.to_string()))?;
    if let (Some(mut stdin), Some(text)) = (child.stdin.take(), input) {
        let _ = stdin.write_all(text.as_bytes());
    }
    let done = child
        .wait_with_output()
        .map_err(|error| dpapi_problem(error.to_string()))?;
    if !done.status.success() {
        return Err(dpapi_problem(
            String::from_utf8_lossy(&done.stderr).to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&done.stdout).to_string())
}

#[cfg(target_os = "windows")]
fn dpapi_problem(detail: String) -> Problem {
    Problem::with(
        "OpenBot could not save your sign-in details to this computer's protected storage.",
        detail,
    )
}

/*
 * Linux, where there is nothing to be assumed.
 *
 * Not a lesser fallback pretending to be a keystore: an owner-only file, in the same place the app
 * keeps its own state, and named as what it is. Secret Service would be better on a desktop that
 * runs it and is simply absent on one that does not, and refusing to save a credential because a
 * daemon is missing would fail more people than the file protects.
 */
#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn remember_in_store(name: &str, value: &str) -> Result<(), Problem> {
    use std::io::Write;

    let path = vault_dir()?.join(format!("{name}.secret"));
    let mut file = open_secret_file(&path)?;
    file.set_len(0)
        .and_then(|()| file.write_all(value.as_bytes()))
        .map_err(|error| {
            Problem::with(
                "OpenBot could not save your sign-in details on this computer.",
                format!("{}: {error}", path.display()),
            )
        })
}

/// Create privately, and secure existing files before truncating or writing any credential bytes.
#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn open_secret_file(path: &std::path::Path) -> Result<std::fs::File, Problem> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path).map_err(|error| {
        Problem::with(
            "OpenBot could not save your sign-in details on this computer.",
            format!("{}: {error}", path.display()),
        )
    })?;
    owner_only(path)?;
    Ok(file)
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn recall_from_store(name: &str) -> Result<Option<String>, Problem> {
    Ok(
        std::fs::read_to_string(vault_dir()?.join(format!("{name}.secret")))
            .ok()
            .map(|value| value.trim().to_string()),
    )
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn forget_in_store(name: &str) {
    if let Ok(dir) = vault_dir() {
        let _ = std::fs::remove_file(dir.join(format!("{name}.secret")));
    }
}

/// Where the platforms that keep a file keep it. Created owner-only, not merely written so.
#[cfg(not(target_os = "macos"))]
fn vault_dir() -> Result<PathBuf, Problem> {
    let dir = crate::stack::default_root().join(".secrets");
    std::fs::create_dir_all(&dir).map_err(|error| {
        Problem::with(
            "OpenBot could not create the place it keeps your sign-in details.",
            format!("{}: {error}", dir.display()),
        )
    })?;
    owner_only(&dir)?;
    Ok(dir)
}

/// Owner-only where the platform has the notion, and a no-op where it does not.
///
/// Only where a file is kept. The Keychain owns its own protection and has no path to set.
#[cfg(all(unix, not(target_os = "macos")))]
fn owner_only(path: &std::path::Path) -> Result<(), Problem> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if path.is_dir() { 0o700 } else { 0o600 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).map_err(|error| {
        Problem::with(
            "OpenBot could not make your saved sign-in details private to your account.",
            format!("{}: {error}", path.display()),
        )
    })
}

#[cfg(all(not(unix), not(target_os = "macos")))]
fn owner_only(_path: &std::path::Path) -> Result<(), Problem> {
    Ok(())
}

#[cfg(all(test, unix, not(target_os = "macos")))]
mod file_permissions_tests {
    use super::{open_secret_file, owner_only};
    use crate::test_support::temp_root;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn a_secret_file_is_private_before_writing_any_bytes() {
        let root = temp_root("vault-file-mode");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("synthetic.secret");

        let file = open_secret_file(&path).unwrap();
        let metadata = file.metadata().unwrap();
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        assert_eq!(metadata.len(), 0);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_existing_file_is_secured_without_truncating_its_value() {
        let root = temp_root("vault-existing-mode");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("synthetic.secret");
        std::fs::write(&path, "previous-synthetic-value").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();

        let file = open_secret_file(&path).unwrap();
        assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "previous-synthetic-value"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_permission_failure_keeps_the_path_and_os_error() {
        let path = temp_root("vault-missing-permissions");
        let expected =
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap_err();

        let problem = owner_only(&path).unwrap_err();

        assert_eq!(
            problem.detail,
            Some(format!("{}: {expected}", path.display()))
        );
    }
}

#[cfg(test)]
mod cache_tests {
    use crate::problem::Problem;
    use crate::test_support::temp_root;
    use std::collections::BTreeMap;

    #[test]
    fn unignored_tests_do_not_call_real_store_entrypoints() {
        let source = include_str!("vault.rs");
        let mut pending_test = false;
        let mut ignored = false;
        let mut in_body = false;
        let mut braces = 0isize;
        let mut name = String::new();
        let mut body = String::new();

        for line in source.lines() {
            let trimmed = line.trim();
            if !in_body {
                if trimmed.starts_with("#[ignore") {
                    ignored = true;
                } else if trimmed == "#[test]" {
                    pending_test = true;
                } else if pending_test && trimmed.starts_with("fn ") {
                    name = trimmed
                        .trim_start_matches("fn ")
                        .split('(')
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    body.clear();
                    in_body = true;
                    pending_test = false;
                    braces =
                        line.matches('{').count() as isize - line.matches('}').count() as isize;
                    body.push_str(line);
                    body.push('\n');
                    continue;
                } else if !trimmed.starts_with("#[") && !trimmed.is_empty() {
                    pending_test = false;
                    ignored = false;
                }
            }

            if in_body {
                body.push_str(line);
                body.push('\n');
                braces += line.matches('{').count() as isize - line.matches('}').count() as isize;
                if braces == 0 {
                    if !ignored {
                        for entrypoint in ["recall", "remember", "forget"] {
                            let direct = format!("{entrypoint}(");
                            let qualified = format!("super::{entrypoint}(");
                            assert!(
                                !body.contains(&direct) && !body.contains(&qualified),
                                "{name} must use injected fake stores, not {entrypoint}()"
                            );
                        }
                    }
                    in_body = false;
                    ignored = false;
                }
            }
        }
    }

    /// The store is asked once per name, then not again.
    ///
    /// The failure this pins is not a slow read, it is a person clicking Deny four times every
    /// time a screen mounts: macOS authorizes each read of a stored password separately unless the
    /// build's signature is one the item already trusts, and a development build's never is.
    #[test]
    fn a_secret_is_read_from_the_store_once_per_run() {
        let name = format!("OPENBOT_TEST_CACHE_{}", std::process::id());
        let cache = std::sync::Mutex::new(BTreeMap::new());
        let store = std::sync::Mutex::new(BTreeMap::<String, String>::new());
        let reads = std::sync::Mutex::new(Vec::new());

        // Absent to begin with, and the absence is remembered rather than asked again.
        assert_eq!(
            super::recall_interactive_cached(&name, &cache, |key| {
                reads.lock().unwrap().push(key.to_string());
                Ok(store.lock().unwrap().get(key).cloned())
            }),
            Ok(None)
        );
        assert_eq!(
            super::recall_interactive_cached(&name, &cache, |key| {
                reads.lock().unwrap().push(key.to_string());
                Ok(store.lock().unwrap().get(key).cloned())
            }),
            Ok(None)
        );
        assert_eq!(
            reads.lock().unwrap().as_slice(),
            std::slice::from_ref(&name)
        );

        // A write goes through and updates what a read sees, without asking the store.
        super::remember_cached(&name, "a-value", &cache, |key, value| {
            store
                .lock()
                .unwrap()
                .insert(key.to_string(), value.to_string());
            Ok(())
        })
        .expect("the store should accept a write");
        assert_eq!(
            super::recall_interactive_cached(&name, &cache, |key| {
                reads.lock().unwrap().push(key.to_string());
                Ok(store.lock().unwrap().get(key).cloned())
            })
            .unwrap()
            .as_deref(),
            Some("a-value")
        );
        assert_eq!(
            super::recall_interactive_cached(&name, &cache, |key| {
                reads.lock().unwrap().push(key.to_string());
                Ok(store.lock().unwrap().get(key).cloned())
            })
            .unwrap()
            .as_deref(),
            Some("a-value")
        );
        assert_eq!(
            reads.lock().unwrap().as_slice(),
            std::slice::from_ref(&name)
        );

        // And forgetting is reflected in both.
        super::forget_cached(&name, &cache, |key| {
            store.lock().unwrap().remove(key);
        });
        assert_eq!(
            super::recall_interactive_cached(&name, &cache, |key| {
                reads.lock().unwrap().push(key.to_string());
                Ok(store.lock().unwrap().get(key).cloned())
            }),
            Ok(None)
        );
        assert_eq!(
            reads.lock().unwrap().as_slice(),
            std::slice::from_ref(&name)
        );
    }

    #[test]
    fn passive_hydration_reads_only_the_file() {
        let dir = temp_root("passive");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(
            &path,
            "OPENAI_API_KEY=file-key\nINTELLIGENCE_API_URL=https://api.example\n",
        )
        .unwrap();

        let found =
            super::already_given_file_only(&path, &["OPENAI_API_KEY", "INTELLIGENCE_API_URL"]);

        assert_eq!(found.get("OPENAI_API_KEY"), Some(&"file-key".to_string()));
        assert_eq!(
            found.get("INTELLIGENCE_API_URL"),
            Some(&"https://api.example".to_string())
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn interactive_reads_cache_denial_once_per_key() {
        let cache = std::sync::Mutex::new(BTreeMap::new());
        let attempts = std::sync::Mutex::new(0);
        let denied = Problem::with(
            "OpenBot needs permission to read saved credentials for this action.",
            "interaction refused",
        );

        for _ in 0..2 {
            let result = super::recall_interactive_cached("OPENAI_API_KEY", &cache, |_| {
                *attempts.lock().unwrap() += 1;
                Err(denied.clone())
            });
            assert_eq!(result, Err(denied.clone()));
        }

        assert_eq!(*attempts.lock().unwrap(), 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    /// The list is the security boundary, so it is asserted rather than trusted to a reading.
    #[test]
    fn every_credential_is_named_and_nothing_else_is() {
        for key in [
            "INTELLIGENCE_API_KEY",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CHATGPT_OAUTH_TOKEN",
            "MANAGED_AGENT_TOKEN",
            "AGENT_TOOL_TOKEN",
            "COMPUTER_TOKEN",
            "SUPERVISOR_TOKEN",
            "WORKER_SHARED_SECRET",
            "KEY_ENCRYPTION_KEY",
        ] {
            assert!(is_secret(key), "{key} would have been written to the file");
        }
        for key in [
            "INTELLIGENCE_API_URL",
            "INTELLIGENCE_GATEWAY_WS_URL",
            "OPENAI_BASE_URL",
            "BOT_PROVIDER",
            "BOT_MODEL",
            "PICKED_HARNESS_IMAGE",
            "PICKED_HARNESS_URL",
            "SERVER_PORT",
            "DATABASE_URL",
            "TRUSTED_ORIGINS",
            "CHATGPT_AUTH_FILE",
        ] {
            assert!(
                !is_secret(key),
                "{key} would have been hidden from the file"
            );
        }
    }

    /// A path, not a credential. The store it points at is written owner-only by its own writer.
    #[test]
    fn the_plan_store_path_is_a_setting() {
        assert!(!is_secret("CHATGPT_AUTH_FILE"));
    }

    #[test]
    fn splitting_keeps_every_key_on_exactly_one_side() {
        let mut all = BTreeMap::new();
        all.insert("OPENAI_API_KEY".to_string(), "sec".to_string());
        all.insert("SERVER_PORT".to_string(), "3001".to_string());
        let (settings, secrets) = split(all);
        assert_eq!(settings.len(), 1);
        assert_eq!(secrets.len(), 1);
        assert!(settings.contains_key("SERVER_PORT"));
        assert!(secrets.contains_key("OPENAI_API_KEY"));
    }

    /**
    An upgrade takes the credential OUT of the file, rather than merely also storing it.

    The case this is for: a machine that ran a version which wrote keys to the `.env`. Storing
    without purging would leave that copy exactly where it was, so the change would have bought
    nothing on every machine that already existed. Uses the real writer, because the rule lives
    there.
    */
    #[test]
    fn an_upgrade_leaves_no_credential_behind_in_the_file() {
        let dir = temp_root("purge");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(
            &path,
            "AGENT_TOOL_TOKEN=old-agent-token\n\
KEY_ENCRYPTION_KEY=old-key\n\
OPENAI_API_KEY=old-openai-key\n\
SERVER_PORT=3001\n\
BOT_MODEL=old-compatible-model\n\
SOMETHING_ELSE=kept\n",
        )
        .unwrap();

        let settings = BTreeMap::from([("SERVER_PORT".to_string(), "3001".to_string())]);
        let secrets = BTreeMap::from([
            (
                "AGENT_TOOL_TOKEN".to_string(),
                "new-agent-token".to_string(),
            ),
            ("KEY_ENCRYPTION_KEY".to_string(), "new-key".to_string()),
            ("OPENAI_API_KEY".to_string(), "new-openai-key".to_string()),
        ]);
        let mut purge = secrets.clone();
        purge.insert("BOT_MODEL".to_string(), String::new());
        let mut remembered = Vec::new();
        write_env_after_remembering_with(
            &path,
            &settings,
            &secrets,
            &purge,
            |key, value| {
                assert!(
                    std::fs::read_to_string(&path)
                        .unwrap()
                        .contains("KEY_ENCRYPTION_KEY=old-key"),
                    "the file was purged before every credential was remembered"
                );
                remembered.push((key.to_string(), value.to_string()));
                Ok(())
            },
            |_| {},
        )
        .unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert!(
            !written.contains("old-agent-token")
                && !written.contains("new-agent-token")
                && !written.contains("old-key")
                && !written.contains("new-key")
                && !written.contains("old-openai-key")
                && !written.contains("new-openai-key"),
            "a credential is still in the file:\n{written}"
        );
        assert_eq!(
            remembered,
            [
                (
                    "AGENT_TOOL_TOKEN".to_string(),
                    "new-agent-token".to_string()
                ),
                ("KEY_ENCRYPTION_KEY".to_string(), "new-key".to_string()),
                ("OPENAI_API_KEY".to_string(), "new-openai-key".to_string()),
            ]
        );
        assert!(!written.contains("AGENT_TOOL_TOKEN"), "{written}");
        assert!(!written.contains("KEY_ENCRYPTION_KEY"), "{written}");
        assert!(!written.contains("OPENAI_API_KEY"), "{written}");
        assert!(!written.contains("BOT_MODEL"), "{written}");
        assert!(written.contains("SERVER_PORT=3001"), "{written}");
        // A line nobody here owns is still nobody's to remove.
        assert!(written.contains("SOMETHING_ELSE=kept"), "{written}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_failed_upgrade_keeps_old_credentials_in_the_file() {
        let dir = temp_root("migration-fail");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(
            &path,
            "AGENT_TOOL_TOKEN=old-agent-token\n\
KEY_ENCRYPTION_KEY=old-key\n\
OPENAI_API_KEY=old-openai-key\n\
SERVER_PORT=3001\n\
SOMETHING_ELSE=kept\n",
        )
        .unwrap();

        let settings = BTreeMap::from([("SERVER_PORT".to_string(), "3001".to_string())]);
        let secrets = BTreeMap::from([
            (
                "AGENT_TOOL_TOKEN".to_string(),
                "new-agent-token".to_string(),
            ),
            ("KEY_ENCRYPTION_KEY".to_string(), "new-key".to_string()),
            ("OPENAI_API_KEY".to_string(), "new-openai-key".to_string()),
        ]);
        let mut attempted = Vec::new();
        let error = write_env_after_remembering_with(
            &path,
            &settings,
            &secrets,
            &secrets,
            |key, _| {
                attempted.push(key.to_string());
                Err(Problem::plain(format!("refused {key}")))
            },
            |_| {},
        )
        .unwrap_err();

        let written = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(error.said, "refused AGENT_TOOL_TOKEN");
        assert_eq!(attempted, ["AGENT_TOOL_TOKEN"]);
        assert!(
            written.contains("AGENT_TOOL_TOKEN=old-agent-token"),
            "{written}"
        );
        assert!(written.contains("KEY_ENCRYPTION_KEY=old-key"), "{written}");
        assert!(
            written.contains("OPENAI_API_KEY=old-openai-key"),
            "{written}"
        );
        assert!(written.contains("SERVER_PORT=3001"), "{written}");
        assert!(written.contains("SOMETHING_ELSE=kept"), "{written}");
    }

    #[test]
    fn an_empty_upgrade_secret_is_forgotten_and_purged() {
        let dir = temp_root("migration-empty");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(
            &path,
            "OPENAI_API_KEY=old-openai-key\nSERVER_PORT=3001\nSOMETHING_ELSE=kept\n",
        )
        .unwrap();

        let settings = BTreeMap::from([("SERVER_PORT".to_string(), "3001".to_string())]);
        let secrets = BTreeMap::from([("OPENAI_API_KEY".to_string(), String::new())]);
        let mut forgotten = Vec::new();
        write_env_after_remembering_with(
            &path,
            &settings,
            &secrets,
            &secrets,
            |key, _| panic!("empty secret should have been forgotten, not remembered: {key}"),
            |key| forgotten.push(key.to_string()),
        )
        .unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(forgotten, ["OPENAI_API_KEY"]);
        assert!(!written.contains("OPENAI_API_KEY"), "{written}");
        assert!(written.contains("SERVER_PORT=3001"), "{written}");
        assert!(written.contains("SOMETHING_ELSE=kept"), "{written}");
    }

    /**
    The real store on this machine, round-tripped.

    Ignored because it writes to the person's own Keychain, which a test run should not do without
    being asked. Run it by hand: `cargo test --lib vault_round_trip -- --ignored`.
    */
    #[test]
    #[ignore = "writes to this machine's real credential store"]
    fn vault_round_trip() {
        let name = "OPENBOT_VAULT_SELF_TEST";
        remember(name, "a value with spaces and $ymbols").expect("could not store");
        assert_eq!(
            recall(name).as_deref(),
            Some("a value with spaces and $ymbols")
        );
        forget(name);
        assert_eq!(recall(name), None, "forget left the credential behind");
    }

    /**
    A long credential survives, because a short one is not the case that broke.

    The `security` command truncated at 128 bytes and reported success, which turned every OpenAI
    project key into a broken one on the next run. Checked well past the 164 a real key happens to
    be today: that number is nobody's to promise, and a store proved to four times the longest key
    anyone issues will not be the thing that fails when somebody issues a longer one.
    */
    #[test]
    #[ignore = "writes to this machine's real credential store"]
    fn a_long_credential_is_not_truncated() {
        let name = "OPENBOT_VAULT_LENGTH_TEST";
        for length in [128, 129, 164, 256, 512] {
            let value: String = std::iter::repeat_n('k', length).collect();
            remember(name, &value).expect("could not store");
            let read = recall(name).unwrap_or_default();
            assert_eq!(
                read.len(),
                length,
                "a {length}-character credential came back short"
            );
            assert_eq!(read, value);
        }
        forget(name);
    }
}
