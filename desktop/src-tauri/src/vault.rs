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
// Windows hands values to a child over stdin; tests exercise that pipe without a real store.
#[cfg(any(target_os = "windows", test))]
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
    mut forget_one: impl FnMut(&str) -> Result<(), Problem>,
) -> Result<(), Problem> {
    remember_all_with(secrets, &mut remember_one, &mut forget_one)?;
    crate::env::write(path, settings, purge)
        .map_err(|e| format!("could not write .env: {e}").into())
}

pub(crate) fn remember_all_with(
    secrets: &BTreeMap<String, String>,
    remember_one: &mut impl FnMut(&str, &str) -> Result<(), Problem>,
    forget_one: &mut impl FnMut(&str) -> Result<(), Problem>,
) -> Result<(), Problem> {
    for (key, value) in secrets {
        if value.trim().is_empty() {
            forget_one(key)?;
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
    /// Access protected storage without permitting operating-system authorization UI.
    NoUi,
}

/**
What a previous run left, under the selected interaction policy.

The file path is always read first because legacy `.env` credentials must still migrate. Protected
storage is layered on top only for Start and Ask, without authorization UI. Refusal is an error. Passive saved hints come from local nonsecret intent metadata.
*/
pub fn already_given_with_policy(
    env_file: &std::path::Path,
    keys: &[&str],
    policy: ReadPolicy,
) -> Result<BTreeMap<String, String>, Problem> {
    already_given_with_reader(env_file, keys, policy, recall_no_ui)
}

fn already_given_with_reader(
    env_file: &std::path::Path,
    keys: &[&str],
    policy: ReadPolicy,
    mut read: impl FnMut(&str) -> Result<Option<String>, Problem>,
) -> Result<BTreeMap<String, String>, Problem> {
    let mut found = match policy {
        ReadPolicy::FileOnly => crate::env::already_set(env_file, keys),
        ReadPolicy::NoUi => crate::env::read_already_set(env_file, keys).map_err(|error| {
            Problem::with(
                "OpenBot could not read its settings.",
                format!("{}: {error}", env_file.display()),
            )
        })?,
    };
    if policy == ReadPolicy::FileOnly {
        return Ok(found);
    }

    for key in keys.iter().copied().filter(|key| is_secret(key)) {
        let value = match policy {
            ReadPolicy::FileOnly => None,
            ReadPolicy::NoUi => read(key)?,
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
pub fn already_given_no_ui(
    env_file: &std::path::Path,
    keys: &[&str],
) -> Result<BTreeMap<String, String>, Problem> {
    already_given_with_policy(env_file, keys, ReadPolicy::NoUi)
}

// Cache only successfully retrieved credentials. Absence and refusal must be rechecked after
// deliberate recovery. Hold the cache lock across store access so a late read cannot overwrite
// a newer write/delete. Passive hydration never enters this cache.
type CachedRead = Result<Option<String>, Problem>;

static REMEMBERED: std::sync::OnceLock<std::sync::Mutex<BTreeMap<String, CachedRead>>> =
    std::sync::OnceLock::new();

fn cache() -> &'static std::sync::Mutex<BTreeMap<String, CachedRead>> {
    REMEMBERED.get_or_init(|| std::sync::Mutex::new(BTreeMap::new()))
}

pub fn recall(name: &str) -> Result<Option<String>, Problem> {
    recall_no_ui(name)
}

fn recall_no_ui(name: &str) -> Result<Option<String>, Problem> {
    recall_no_ui_cached(name, cache(), recall_from_store)
}

fn cache_problem() -> Problem {
    Problem::plain("OpenBot could not access its credential cache. Restart OpenBot and try again.")
}

fn recall_no_ui_cached(
    name: &str,
    cache: &std::sync::Mutex<BTreeMap<String, CachedRead>>,
    recall_one: impl FnOnce(&str) -> Result<Option<String>, Problem>,
) -> Result<Option<String>, Problem> {
    let mut held = cache.lock().map_err(|_| cache_problem())?;
    if let Some(known) = held.get(name) {
        return known.clone();
    }
    let found = recall_one(name);
    if matches!(&found, Ok(Some(_))) {
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
    let mut held = cache.lock().map_err(|_| cache_problem())?;
    // A successful store read/write confirms these exact bytes for this process. In particular,
    // do not repeat a just-authorized write on the person's explicit ordinary Start retry.
    if held
        .get(name)
        .is_some_and(|known| matches!(known, Ok(Some(saved)) if saved == value))
    {
        return Ok(());
    }
    // A failed restoration can follow a successful OS write. Discard any stale cache entry.
    held.remove(name);
    remember_one(name, value)?;
    held.insert(name.to_string(), Ok(Some(value.to_string())));
    Ok(())
}

/// Drop a secret from the store. Refusal must not be published as absence.
pub fn forget(name: &str) -> Result<(), Problem> {
    forget_cached(name, cache(), forget_in_store)
}

fn forget_cached(
    name: &str,
    cache: &std::sync::Mutex<BTreeMap<String, CachedRead>>,
    forget_one: impl FnOnce(&str) -> Result<(), Problem>,
) -> Result<(), Problem> {
    let mut held = cache.lock().map_err(|_| cache_problem())?;
    held.remove(name);
    forget_one(name)
}

/// Read back what was stored, preserving protected-store failures.
pub fn recall_all(keys: &[&str]) -> Result<BTreeMap<String, String>, Problem> {
    let mut found = BTreeMap::new();
    for key in keys {
        if let Some(value) = recall(key)? {
            if !value.trim().is_empty() {
                found.insert((*key).to_string(), value);
            }
        }
    }
    Ok(found)
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
#[path = "vault/keychain.rs"]
mod keychain;

#[cfg(target_os = "macos")]
fn mutate_primitive(
    primitive: crate::recovery::Primitive,
    name: &str,
    value: Option<&str>,
) -> Result<(), Problem> {
    use crate::recovery::Primitive;
    use core_foundation::string::CFString;
    use core_foundation::{base::TCFType, data::CFData, dictionary::CFDictionary};
    use security_framework_sys::item::{
        kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword,
    };
    use security_framework_sys::{
        item::kSecValueData,
        keychain_item::{SecItemAdd, SecItemUpdate},
    };
    // Exactly the legacy generic-password selector used by security-framework, with no new
    // access-group, ACL, access-control or data-protection attributes.
    let mut pairs = unsafe {
        vec![
            (
                CFString::wrap_under_get_rule(kSecClass),
                CFString::wrap_under_get_rule(kSecClassGenericPassword).as_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecAttrService),
                CFString::new(SERVICE).as_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecAttrAccount),
                CFString::new(name).as_CFType(),
            ),
        ]
    };
    let status = match primitive {
        Primitive::Add => {
            pairs.push((
                unsafe { CFString::wrap_under_get_rule(kSecValueData) },
                CFData::from_buffer(value.ok_or_else(|| Problem::plain("The captured credential mutation has no value. Start this step again."))?.as_bytes()).as_CFType(),
            ));
            let query = CFDictionary::from_CFType_pairs(&pairs);
            unsafe { SecItemAdd(query.as_concrete_TypeRef(), std::ptr::null_mut()) }
        }
        Primitive::Update => {
            let query = CFDictionary::from_CFType_pairs(&pairs);
            let data = CFData::from_buffer(
                value
                    .ok_or_else(|| {
                        Problem::plain(
                            "The captured credential mutation has no value. Start this step again.",
                        )
                    })?
                    .as_bytes(),
            );
            let attributes = CFDictionary::from_CFType_pairs(&[(
                unsafe { core_foundation::string::CFString::wrap_under_get_rule(kSecValueData) }
                    .as_CFType(),
                data.as_CFType(),
            )]);
            unsafe {
                SecItemUpdate(
                    query.as_concrete_TypeRef(),
                    attributes.as_concrete_TypeRef(),
                )
            }
        }
        Primitive::Delete => {
            match security_framework::passwords::delete_generic_password(SERVICE, name) {
                Ok(()) => 0,
                Err(error) => error.code(),
            }
        }
        Primitive::Read => return Err(Problem::plain("A read is not a credential mutation.")),
    };
    if status == 0 || (primitive == Primitive::Delete && status == -25300) {
        Ok(())
    } else {
        Err(keychain::item_problem(primitive, name, status, value))
    }
}

#[cfg(target_os = "macos")]
fn remember_in_store(name: &str, value: &str) -> Result<(), Problem> {
    use crate::recovery::Primitive;
    keychain::without_ui("save", name, || {
        match mutate_primitive(Primitive::Add, name, Some(value)) {
            // A duplicate may update only on the ordinary no-UI path. The interactive command
            // calls exactly its captured primitive and cannot enter this branch.
            Err(error)
                if error
                    .item
                    .as_ref()
                    .is_some_and(|item| item.status == -25299) =>
            {
                mutate_primitive(Primitive::Update, name, Some(value))
            }
            result => result,
        }
    })
}

#[cfg(target_os = "macos")]
fn read_primitive(name: &str) -> Result<Option<String>, Problem> {
    match security_framework::passwords::get_generic_password(SERVICE, name) {
        Ok(raw) => String::from_utf8(raw)
            .map(Some)
            .map_err(|_| keychain::problem("read", name, "invalid-utf8", None)),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(error) => Err(keychain::item_problem(
            crate::recovery::Primitive::Read,
            name,
            error.code(),
            None,
        )),
    }
}
#[cfg(target_os = "macos")]
fn recall_from_store(name: &str) -> Result<Option<String>, Problem> {
    keychain::without_ui("read", name, || read_primitive(name))
}
#[cfg(target_os = "macos")]
fn forget_in_store(name: &str) -> Result<(), Problem> {
    keychain::without_ui("delete", name, || {
        mutate_primitive(crate::recovery::Primitive::Delete, name, None)
    })
}

pub(crate) fn recover_claimed(
    state: &crate::recovery::Recovery,
    claimed: crate::recovery::Claimed,
) -> Result<(), Problem> {
    // Preserve cache -> policy-gate order. No native state lock is held while waiting for macOS.
    let mut held = match cache().lock() {
        Ok(held) => held,
        Err(_) => return state.complete(claimed, Err::<(), _>(cache_problem()), |_| {}),
    };
    let name = claimed.operation.setting.clone();
    let result = state.dispatch(&claimed).and_then(|()| {
        // A mutation may reach the OS before restoration fails. Invalidate before dispatch;
        // no late success or cancellation is permitted to publish new cache bytes.
        if claimed.operation.primitive != crate::recovery::Primitive::Read {
            held.remove(&name);
        }
        recover_one(&claimed.operation)
    });
    state.complete(claimed, result, |value| {
        held.remove(&name);
        if let Some(value) = value {
            held.insert(name, Ok(Some(value)));
        }
    })
}
#[cfg(target_os = "macos")]
fn recover_one(operation: &crate::recovery::RefusedOperation) -> Result<Option<String>, Problem> {
    use crate::recovery::Primitive;
    keychain::with_ui(operation.primitive.name(), &operation.setting, || {
        if operation.primitive == Primitive::Read {
            let value = read_primitive(&operation.setting)?.filter(|value| !value.trim().is_empty()).ok_or_else(|| Problem::plain("That saved credential is missing or empty. Authorization cannot recreate it."))?;
            if operation.setting == "KEY_ENCRYPTION_KEY"
                && !crate::env::usable_encryption_key(&value)
            {
                return Err(Problem::plain("This installation's original saved encryption key is invalid or public. Restore its original private key; authorization cannot recreate it."));
            }
            Ok(Some(value))
        } else {
            mutate_primitive(
                operation.primitive,
                &operation.setting,
                operation.value.as_deref(),
            )?;
            Ok(operation.value.clone())
        }
    })
}
#[cfg(not(target_os = "macos"))]
fn recover_one(_: &crate::recovery::RefusedOperation) -> Result<Option<String>, Problem> {
    Err(Problem::plain(
        "macOS credential authorization is unavailable on this platform.",
    ))
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
fn forget_in_store(name: &str) -> Result<(), Problem> {
    remove_secret_file(&vault_dir()?.join(format!("{name}.dpapi")))
}

#[cfg(target_os = "windows")]
fn powershell(program: &str, input: Option<&str>) -> Result<String, Problem> {
    let child = crate::quiet::command("powershell")
        .args(["-NoProfile", "-NonNoUi", "-Command", program])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| dpapi_problem(error.to_string()))?;
    dpapi_output(child, input)
}

#[cfg(any(target_os = "windows", test))]
fn write_dpapi_stdin(stdin: Option<impl Write>, input: Option<&str>) -> Result<(), Problem> {
    if let Some(text) = input {
        let mut stdin = stdin.ok_or_else(|| {
            dpapi_problem("DPAPI stdin write failed: piped stdin is missing".into())
        })?;
        stdin
            .write_all(text.as_bytes())
            .map_err(|error| dpapi_problem(format!("DPAPI stdin write failed: {error}")))?;
    }
    // Taking ownership closes the pipe before the caller waits, including empty/absent input.
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
fn dpapi_output(mut child: std::process::Child, input: Option<&str>) -> Result<String, Problem> {
    if let Err(mut problem) = write_dpapi_stdin(child.stdin.take(), input) {
        // The input pipe is already closed. Do not leave a protector waiting after an early return,
        // and keep the stdin failure primary even if termination or reaping also fails.
        if let Err(error) = child.kill() {
            problem
                .detail
                .get_or_insert_with(String::new)
                .push_str(&format!("; terminating DPAPI child: {error}"));
        }
        if let Err(error) = child.wait() {
            problem
                .detail
                .get_or_insert_with(String::new)
                .push_str(&format!("; reaping DPAPI child: {error}"));
        }
        return Err(problem);
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

#[cfg(any(target_os = "windows", test))]
fn dpapi_problem(detail: String) -> Problem {
    Problem::with(
        "OpenBot could not save your sign-in details to this computer's protected storage.",
        detail,
    )
}

#[cfg(test)]
mod dpapi_tests {
    #[cfg(unix)]
    use super::dpapi_output;
    use super::{remember_cached, write_dpapi_stdin};
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;
    use std::io::{self, Write};
    use std::rc::Rc;
    use std::sync::Mutex;

    struct StdinWriter {
        bytes: Rc<RefCell<Vec<u8>>>,
        closed: Rc<Cell<bool>>,
        fail_after: Option<usize>,
    }

    impl Write for StdinWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let mut delivered = self.bytes.borrow_mut();
            let remaining = self.fail_after.unwrap_or(usize::MAX) - delivered.len();
            if remaining == 0 {
                return Err(io::Error::from(io::ErrorKind::BrokenPipe));
            }
            let count = bytes.len().min(remaining).min(3);
            delivered.extend_from_slice(&bytes[..count]);
            Ok(count)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Drop for StdinWriter {
        fn drop(&mut self) {
            self.closed.set(true);
        }
    }

    #[test]
    fn partial_stdin_write_reports_broken_pipe_and_closes_the_writer() {
        let bytes = Rc::new(RefCell::new(Vec::new()));
        let closed = Rc::new(Cell::new(false));
        let problem = write_dpapi_stdin(
            Some(StdinWriter {
                bytes: Rc::clone(&bytes),
                closed: Rc::clone(&closed),
                fail_after: Some(3),
            }),
            Some("synthetic-stdin-value"),
        )
        .expect_err("incomplete stdin must not be accepted");
        let detail = problem.detail.unwrap();
        assert!(detail.contains("stdin"), "{detail}");
        assert!(detail.contains(&io::Error::from(io::ErrorKind::BrokenPipe).to_string()));
        assert!(!detail.contains("synthetic-stdin-value"));
        assert_eq!(bytes.borrow().as_slice(), b"syn");
        assert!(closed.get());
    }

    #[test]
    fn supplied_input_requires_a_pipe_even_when_empty() {
        for input in ["synthetic-stdin-value", ""] {
            let problem = write_dpapi_stdin(None::<StdinWriter>, Some(input))
                .expect_err("supplied input requires piped stdin");
            let detail = problem.detail.unwrap();
            assert!(detail.contains("stdin"), "{detail}");
            assert!(detail.contains("pipe"), "{detail}");
        }
    }

    #[test]
    fn complete_empty_and_absent_stdin_close_the_writer() {
        for input in [Some("synthetic-stdin-value"), Some(""), None] {
            let bytes = Rc::new(RefCell::new(Vec::new()));
            let closed = Rc::new(Cell::new(false));
            write_dpapi_stdin(
                Some(StdinWriter {
                    bytes: Rc::clone(&bytes),
                    closed: Rc::clone(&closed),
                    fail_after: None,
                }),
                input,
            )
            .unwrap();
            assert_eq!(
                bytes.borrow().as_slice(),
                input.unwrap_or_default().as_bytes()
            );
            assert!(closed.get());
        }
        assert_eq!(write_dpapi_stdin(None::<StdinWriter>, None), Ok(()));
    }

    #[test]
    fn failed_stdin_delivery_does_not_populate_the_success_cache() {
        let cache = Mutex::new(BTreeMap::new());
        let result = remember_cached(
            "SYNTHETIC_TEST",
            "synthetic-stdin-value",
            &cache,
            |_, value| {
                write_dpapi_stdin(
                    Some(StdinWriter {
                        bytes: Rc::new(RefCell::new(Vec::new())),
                        closed: Rc::new(Cell::new(false)),
                        fail_after: Some(3),
                    }),
                    Some(value),
                )
            },
        );
        assert!(result.is_err());
        assert!(cache.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn complete_stdin_reaches_child_eof_and_preserves_output() {
        for input in [Some("synthetic-stdin-value"), Some(""), None] {
            let child = crate::quiet::command("sh")
                .args(["-c", "cat >/dev/null; printf SYNTHETIC_CIPHERTEXT"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            assert_eq!(dpapi_output(child, input).unwrap(), "SYNTHETIC_CIPHERTEXT");
        }
    }
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
    recall_secret_file(&vault_dir()?.join(format!("{name}.secret")))
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn recall_secret_file(path: &std::path::Path) -> Result<Option<String>, Problem> {
    match std::fs::read_to_string(path) {
        Ok(value) => Ok(Some(value.trim().to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(Problem::with(
            "OpenBot could not read your saved sign-in details on this computer.",
            format!("{}: {error}", path.display()),
        )),
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn forget_in_store(name: &str) -> Result<(), Problem> {
    remove_secret_file(&vault_dir()?.join(format!("{name}.secret")))
}

#[cfg(not(target_os = "macos"))]
fn remove_secret_file(path: &std::path::Path) -> Result<(), Problem> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(Problem::with(
            "OpenBot could not remove a saved credential on this computer.",
            format!("{}: {error}", path.display()),
        )),
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
    use super::{open_secret_file, owner_only, recall_secret_file};
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

    #[test]
    fn missing_secret_file_is_absent() {
        let root = temp_root("vault-missing-secret");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("OPENAI_API_KEY.secret");

        assert_eq!(recall_secret_file(&path), Ok(None));

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn readable_secret_file_trims_surrounding_whitespace() {
        let root = temp_root("vault-readable-secret");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("OPENAI_API_KEY.secret");
        std::fs::write(&path, "\n  synthetic-secret-value  \n").unwrap();

        assert_eq!(
            recall_secret_file(&path),
            Ok(Some("synthetic-secret-value".to_string()))
        );

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn directory_secret_path_reports_the_path_and_os_error() {
        let root = temp_root("vault-directory-secret");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("OPENAI_API_KEY.secret");
        std::fs::create_dir(&path).unwrap();

        let problem = recall_secret_file(&path).expect_err("directories are unreadable secrets");
        assert_eq!(
            problem.said,
            "OpenBot could not read your saved sign-in details on this computer."
        );
        let detail = problem.detail.unwrap();
        assert!(detail.contains(path.to_string_lossy().as_ref()), "{detail}");
        assert!(detail.contains("directory"), "{detail}");

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn invalid_utf8_secret_file_reports_the_path_and_os_error_without_bytes() {
        let root = temp_root("vault-invalid-utf8-secret");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("OPENAI_API_KEY.secret");
        std::fs::write(&path, b"synthetic-prefix-\xff-secret").unwrap();

        let problem = recall_secret_file(&path).expect_err("invalid UTF-8 is unreadable");
        assert_eq!(
            problem.said,
            "OpenBot could not read your saved sign-in details on this computer."
        );
        let detail = problem.detail.unwrap();
        assert!(detail.contains(path.to_string_lossy().as_ref()), "{detail}");
        assert!(
            detail.contains("stream did not contain valid UTF-8"),
            "{detail}"
        );
        assert!(!detail.contains("synthetic-prefix"), "{detail}");

        std::fs::remove_dir_all(root).ok();
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

    #[test]
    fn only_successful_reads_are_cached_and_mutations_keep_them_current() {
        let name = "OPENAI_API_KEY";
        let cache = std::sync::Mutex::new(BTreeMap::new());
        for _ in 0..2 {
            assert_eq!(
                super::recall_no_ui_cached(name, &cache, |_| Ok(None)),
                Ok(None)
            );
            assert!(cache.lock().unwrap().is_empty());
        }
        let found =
            super::recall_no_ui_cached(name, &cache, |_| Ok(Some("recovered".into()))).unwrap();
        assert_eq!(found.as_deref(), Some("recovered"));
        assert_eq!(
            super::recall_no_ui_cached(name, &cache, |_| panic!("success cached")).unwrap(),
            found
        );
        super::remember_cached(name, "replacement", &cache, |_, _| Ok(())).unwrap();
        assert_eq!(
            super::recall_no_ui_cached(name, &cache, |_| panic!("write cached"))
                .unwrap()
                .as_deref(),
            Some("replacement")
        );
        super::forget_cached(name, &cache, |_| Ok(())).unwrap();
        assert!(cache.lock().unwrap().is_empty());
        assert_eq!(
            super::recall_no_ui_cached(name, &cache, |_| Ok(None)),
            Ok(None)
        );
    }

    #[test]
    fn an_unchanged_confirmed_value_skips_persistence_but_a_change_never_does() {
        let cache = std::sync::Mutex::new(BTreeMap::from([(
            "OPENAI_API_KEY".into(),
            Ok(Some("confirmed".into())),
        )]));
        super::remember_cached("OPENAI_API_KEY", "confirmed", &cache, |_, _| {
            panic!("redundant persistence after recovery")
        })
        .unwrap();
        let error = super::remember_cached("OPENAI_API_KEY", "changed", &cache, |key, value| {
            assert_eq!(key, "OPENAI_API_KEY");
            assert_eq!(value, "changed");
            Err(Problem::plain("synthetic no-UI refusal"))
        })
        .unwrap_err();
        assert_eq!(error.said, "synthetic no-UI refusal");
        assert!(cache.lock().unwrap().is_empty());
    }

    #[test]
    fn failed_write_or_delete_cannot_publish_success_or_stale_cache() {
        for delete in [false, true] {
            let cache = std::sync::Mutex::new(BTreeMap::new());
            super::remember_cached("OPENAI_API_KEY", "old", &cache, |_, _| Ok(())).unwrap();
            let denied =
                Problem::plain("synthetic refusal, including restoration after OS success");
            let result = if delete {
                super::forget_cached("OPENAI_API_KEY", &cache, |_| Err(denied.clone()))
            } else {
                super::remember_cached("OPENAI_API_KEY", "new", &cache, |_, _| Err(denied.clone()))
            };
            assert_eq!(result, Err(denied));
            assert!(cache.lock().unwrap().is_empty());
            assert_eq!(
                super::recall_no_ui_cached("OPENAI_API_KEY", &cache, |_| Ok(Some(
                    "authoritative".into()
                )))
                .unwrap()
                .as_deref(),
                Some("authoritative")
            );
        }
    }

    #[test]
    fn denied_encryption_key_does_not_use_valid_legacy_fallback() {
        let root = temp_root("vault-denied-legacy-key");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join(".env");
        let legacy = "KEY_ENCRYPTION_KEY=synthetic-existing-valid-key\n";
        std::fs::write(&path, legacy).unwrap();
        let denied = Problem::plain("synthetic read refused");
        assert_eq!(
            super::already_given_with_reader(
                &path,
                &["KEY_ENCRYPTION_KEY"],
                super::ReadPolicy::NoUi,
                |_| Err(denied.clone())
            ),
            Err(denied)
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
        let missing = super::already_given_with_reader(
            &path,
            &["KEY_ENCRYPTION_KEY"],
            super::ReadPolicy::NoUi,
            |_| Ok(None),
        )
        .unwrap();
        assert_eq!(
            missing["KEY_ENCRYPTION_KEY"],
            "synthetic-existing-valid-key"
        );
        std::fs::remove_dir_all(root).unwrap();
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
    fn file_only_hydration_keeps_unreadable_env_unknown_but_no_ui_reports_it() {
        let dir = temp_root("vault-strict-read");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(&path, b"INTELLIGENCE_API_URL=\xff\n").unwrap();

        let file_only = super::already_given_with_policy(
            &path,
            &["INTELLIGENCE_API_URL"],
            super::ReadPolicy::FileOnly,
        )
        .unwrap();
        assert!(file_only.is_empty());

        let no_ui = super::already_given_with_policy(
            &path,
            &["INTELLIGENCE_API_URL"],
            super::ReadPolicy::NoUi,
        )
        .expect_err("no_ui Start/Ask must report unreadable .env input");
        assert_eq!(no_ui.said, "OpenBot could not read its settings.");
        assert!(
            no_ui
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains(path.to_string_lossy().as_ref())),
            "{no_ui:?}"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refused_reads_can_succeed_after_deliberate_recovery() {
        let cache = std::sync::Mutex::new(BTreeMap::new());
        let attempts = std::sync::Mutex::new(0);
        let denied = Problem::with(
            "OpenBot needs permission to read saved credentials for this action.",
            "interaction refused",
        );

        for _ in 0..2 {
            let result = super::recall_no_ui_cached("OPENAI_API_KEY", &cache, |_| {
                *attempts.lock().unwrap() += 1;
                Err(denied.clone())
            });
            assert_eq!(result, Err(denied.clone()));
        }

        assert_eq!(*attempts.lock().unwrap(), 2);
        assert!(cache.lock().unwrap().is_empty());
        assert_eq!(
            super::recall_no_ui_cached("OPENAI_API_KEY", &cache, |_| Ok(Some("recovered".into())))
                .unwrap()
                .as_deref(),
            Some("recovered")
        );
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
            |_| Ok(()),
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
            |_| Ok(()),
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
            |key| {
                forgotten.push(key.to_string());
                Ok(())
            },
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
            recall(name).unwrap().as_deref(),
            Some("a value with spaces and $ymbols")
        );
        forget(name).unwrap();
        assert_eq!(
            recall(name).unwrap(),
            None,
            "forget left the credential behind"
        );
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
            let read = recall(name).unwrap().unwrap_or_default();
            assert_eq!(
                read.len(),
                length,
                "a {length}-character credential came back short"
            );
            assert_eq!(read, value);
        }
        forget(name).unwrap();
    }
}
