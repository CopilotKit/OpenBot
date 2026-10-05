/*!
Where a secret lives, which is not the `.env`.

WHAT EACH PLATFORM ACTUALLY GETS.

- **macOS and Linux: an owner-only file** under the selected deployment root.
- **Windows: DPAPI**, through PowerShell's `ProtectedData`, encrypting to the signed-in user so the
  ciphertext is useless to any other account on the machine, and to anybody who copies the file off
  it.

THE VALUE NEVER GOES ON A COMMAND LINE. `ps` is readable by every process the person runs. Windows
writes over stdin, since PowerShell reading the console to the end has no buffer limit of its own.
*/

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::problem::Problem;

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
            | crate::saved_intent::COMPATIBLE_CREDENTIAL
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
pub fn remember_all(root: &Path, secrets: &BTreeMap<String, String>) -> Result<(), Problem> {
    remember_all_with(root, secrets, &mut remember, &mut forget)
}

pub fn write_env_after_remembering(
    root: &Path,
    path: &Path,
    settings: &BTreeMap<String, String>,
    secrets: &BTreeMap<String, String>,
    purge: &BTreeMap<String, String>,
) -> Result<(), Problem> {
    write_env_after_remembering_with(root, path, settings, secrets, purge, remember, forget)
}

fn write_env_after_remembering_with(
    root: &Path,
    path: &Path,
    settings: &BTreeMap<String, String>,
    secrets: &BTreeMap<String, String>,
    purge: &BTreeMap<String, String>,
    mut remember_one: impl FnMut(&Path, &str, &str) -> Result<(), Problem>,
    mut forget_one: impl FnMut(&Path, &str) -> Result<(), Problem>,
) -> Result<(), Problem> {
    remember_all_with(root, secrets, &mut remember_one, &mut forget_one)?;
    crate::env::write(path, settings, purge)
        .map_err(|e| format!("could not write .env: {e}").into())
}

pub(crate) fn remember_all_with(
    root: &Path,
    secrets: &BTreeMap<String, String>,
    remember_one: &mut impl FnMut(&Path, &str, &str) -> Result<(), Problem>,
    forget_one: &mut impl FnMut(&Path, &str) -> Result<(), Problem>,
) -> Result<(), Problem> {
    for (key, value) in secrets {
        if value.trim().is_empty() {
            forget_one(root, key)?;
            continue;
        }
        remember_one(root, key, value)?;
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
    root: &Path,
    env_file: &Path,
    keys: &[&str],
    policy: ReadPolicy,
) -> Result<BTreeMap<String, String>, Problem> {
    already_given_with_reader(root, env_file, keys, policy, recall_no_ui)
}

fn already_given_with_reader(
    root: &Path,
    env_file: &Path,
    keys: &[&str],
    policy: ReadPolicy,
    mut read: impl FnMut(&Path, &str) -> Result<Option<String>, Problem>,
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
            ReadPolicy::NoUi => read(root, key)?,
        };
        if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
            found.insert(key.to_string(), value);
        }
    }
    Ok(found)
}

/// Passive startup hydration. It never asks protected storage for a raw secret.
pub fn already_given_file_only(env_file: &Path, keys: &[&str]) -> BTreeMap<String, String> {
    crate::env::already_set(env_file, keys)
}

/// Protected retrieval for a user-triggered action.
pub fn already_given_no_ui(
    root: &Path,
    env_file: &Path,
    keys: &[&str],
) -> Result<BTreeMap<String, String>, Problem> {
    already_given_with_policy(root, env_file, keys, ReadPolicy::NoUi)
}

// Cache only successfully retrieved credentials. Absence and refusal must be rechecked on the next
// attempt. Hold the cache lock across store access so a late read cannot overwrite a newer
// write/delete. Passive hydration never enters this cache.
type CachedRead = Result<Option<String>, Problem>;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct CacheKey {
    root: PathBuf,
    name: String,
}

static REMEMBERED: std::sync::OnceLock<std::sync::Mutex<BTreeMap<CacheKey, CachedRead>>> =
    std::sync::OnceLock::new();

fn cache() -> &'static std::sync::Mutex<BTreeMap<CacheKey, CachedRead>> {
    REMEMBERED.get_or_init(|| std::sync::Mutex::new(BTreeMap::new()))
}

pub fn recall(root: &Path, name: &str) -> Result<Option<String>, Problem> {
    recall_no_ui(root, name)
}

fn recall_no_ui(root: &Path, name: &str) -> Result<Option<String>, Problem> {
    recall_no_ui_cached(root, name, cache(), recall_from_store)
}

fn cache_problem() -> Problem {
    Problem::plain("OpenBot could not access its credential cache. Restart OpenBot and try again.")
}

fn recall_no_ui_cached(
    root: &Path,
    name: &str,
    cache: &std::sync::Mutex<BTreeMap<CacheKey, CachedRead>>,
    recall_one: impl FnOnce(&Path, &str) -> Result<Option<String>, Problem>,
) -> Result<Option<String>, Problem> {
    let mut held = cache.lock().map_err(|_| cache_problem())?;
    let key = CacheKey {
        root: root.to_path_buf(),
        name: name.to_string(),
    };
    if let Some(known) = held.get(&key) {
        return known.clone();
    }
    let found = recall_one(root, name);
    if matches!(&found, Ok(Some(_))) {
        held.insert(key, found.clone());
    }
    found
}

/// Store a secret, and keep the cache in step so the next read does not ask again.
pub fn remember(root: &Path, name: &str, value: &str) -> Result<(), Problem> {
    remember_cached(root, name, value, cache(), remember_in_store)
}

fn remember_cached(
    root: &Path,
    name: &str,
    value: &str,
    cache: &std::sync::Mutex<BTreeMap<CacheKey, CachedRead>>,
    remember_one: impl FnOnce(&Path, &str, &str) -> Result<(), Problem>,
) -> Result<(), Problem> {
    let mut held = cache.lock().map_err(|_| cache_problem())?;
    let key = CacheKey {
        root: root.to_path_buf(),
        name: name.to_string(),
    };
    // A successful store read/write confirms these exact bytes for this process. In particular,
    // do not repeat a just-authorized write on the person's explicit ordinary Start retry.
    if held
        .get(&key)
        .is_some_and(|known| matches!(known, Ok(Some(saved)) if saved == value))
    {
        return Ok(());
    }
    // A failed restoration can follow a successful OS write. Discard any stale cache entry.
    held.remove(&key);
    remember_one(root, name, value)?;
    held.insert(key, Ok(Some(value.to_string())));
    Ok(())
}

/// Drop a secret from the store. Refusal must not be published as absence.
pub fn forget(root: &Path, name: &str) -> Result<(), Problem> {
    forget_cached(root, name, cache(), forget_in_store)
}

fn forget_cached(
    root: &Path,
    name: &str,
    cache: &std::sync::Mutex<BTreeMap<CacheKey, CachedRead>>,
    forget_one: impl FnOnce(&Path, &str) -> Result<(), Problem>,
) -> Result<(), Problem> {
    let mut held = cache.lock().map_err(|_| cache_problem())?;
    held.remove(&CacheKey {
        root: root.to_path_buf(),
        name: name.to_string(),
    });
    forget_one(root, name)
}

/// Read back what was stored, preserving protected-store failures.
pub fn recall_all(root: &Path, keys: &[&str]) -> Result<BTreeMap<String, String>, Problem> {
    let mut found = BTreeMap::new();
    for key in keys {
        if let Some(value) = recall(root, key)? {
            if !value.trim().is_empty() {
                found.insert((*key).to_string(), value);
            }
        }
    }
    Ok(found)
}

/*
 * DPAPI, through the only interpreter Windows is guaranteed to have.
 *
 * `ProtectedData` with `CurrentUser` ties the ciphertext to the signed-in account, so the file is
 * useless on another account and useless copied off the machine. The plaintext arrives on stdin
 * and the ciphertext leaves on stdout, so neither is ever an argument.
 */
#[cfg(target_os = "windows")]
fn remember_in_store(root: &Path, name: &str, value: &str) -> Result<(), Problem> {
    const PROTECT: &str = r#"
$ErrorActionPreference = 'Stop'
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
Add-Type -AssemblyName System.Security
$sealed = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[Convert]::ToBase64String($sealed)
"#;
    let sealed = powershell(PROTECT, Some(value))?;
    let path = vault_dir(root)?.join(format!("{name}.dpapi"));
    std::fs::write(&path, sealed.trim())
        .map_err(|error| dpapi_write_problem(format!("{}: {error}", path.display())))
}

#[cfg(target_os = "windows")]
fn recall_from_store(root: &Path, name: &str) -> Result<Option<String>, Problem> {
    const UNPROTECT: &str = r#"
$ErrorActionPreference = 'Stop'
$sealed = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
Add-Type -AssemblyName System.Security
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $null, 'CurrentUser')
[Text.Encoding]::UTF8.GetString($bytes)
"#;
    let path = vault_dir(root)?.join(format!("{name}.dpapi"));
    let Some(sealed) = read_dpapi_store_file(&path)? else {
        return Ok(None);
    };
    powershell(UNPROTECT, Some(&sealed)).map(|plain| Some(plain.trim().to_string()))
}

#[cfg(any(target_os = "windows", test))]
fn read_dpapi_store_file(path: &Path) -> Result<Option<String>, Problem> {
    match std::fs::read_to_string(path) {
        Ok(sealed) => Ok(Some(sealed)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(dpapi_read_problem(format!("{}: {error}", path.display()))),
    }
}

#[cfg(target_os = "windows")]
fn forget_in_store(root: &Path, name: &str) -> Result<(), Problem> {
    remove_secret_file(&vault_dir(root)?.join(format!("{name}.dpapi")))
}

#[cfg(target_os = "windows")]
fn powershell(program: &str, input: Option<&str>) -> Result<String, Problem> {
    let child = powershell_command(program)
        .spawn()
        .map_err(|error| dpapi_problem(error.to_string()))?;
    dpapi_output(child, input)
}

#[cfg(any(target_os = "windows", test))]
fn powershell_command(program: &str) -> std::process::Command {
    let mut command = crate::quiet::command("powershell");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", program])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    command
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
    dpapi_write_problem(detail)
}

#[cfg(any(target_os = "windows", test))]
fn dpapi_write_problem(detail: String) -> Problem {
    Problem::with(
        "OpenBot could not save your sign-in details to this computer's protected storage.",
        detail,
    )
}

#[cfg(any(target_os = "windows", test))]
fn dpapi_read_problem(detail: String) -> Problem {
    Problem::with(
        "OpenBot could not read your sign-in details from this computer's protected storage.",
        detail,
    )
}

#[cfg(test)]
mod dpapi_tests {
    #[cfg(unix)]
    use super::dpapi_output;
    use super::{read_dpapi_store_file, remember_cached, write_dpapi_stdin};
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;
    use std::io::{self, Write};
    use std::rc::Rc;
    use std::sync::Mutex;

    #[test]
    fn powershell_uses_documented_noninteractive_arguments() {
        let program = "[Console]::Out.Write([Console]::In.ReadToEnd())";
        let command = super::powershell_command(program);
        assert_eq!(command.get_program(), "powershell");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["-NoProfile", "-NonInteractive", "-Command", program]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn powershell_round_trips_stdin_without_accessing_a_store() {
        let input = "synthetic input with spaces and $symbols";
        let output = super::powershell(
            "[Console]::Out.Write([Console]::In.ReadToEnd())",
            Some(input),
        )
        .expect("the production PowerShell invocation should accept a harmless stdin program");
        assert_eq!(output, input);
    }

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
    fn dpapi_store_file_read_reports_unreadable_or_corrupt_files_as_protected_store_errors() {
        let root = crate::test_support::temp_root("dpapi-read-errors");
        let vault = root.join(".dpapi");
        std::fs::create_dir_all(&vault).unwrap();
        let missing = vault.join("OPENAI_API_KEY.dpapi");
        assert_eq!(read_dpapi_store_file(&missing).unwrap(), None);

        let unreadable = vault.join("ANTHROPIC_API_KEY.dpapi");
        std::fs::create_dir(&unreadable).unwrap();
        let problem = read_dpapi_store_file(&unreadable)
            .expect_err("an existing unreadable DPAPI blob is not absence");
        assert_eq!(
            problem.said,
            "OpenBot could not read your sign-in details from this computer's protected storage."
        );
        let detail = problem.detail.as_deref().unwrap_or_default();
        assert!(
            detail.contains(&unreadable.display().to_string()),
            "{detail}"
        );

        let corrupt = vault.join("COMPATIBLE_API_KEY.dpapi");
        std::fs::write(&corrupt, b"\xff").unwrap();
        let problem = read_dpapi_store_file(&corrupt)
            .expect_err("invalid UTF-8 in an existing DPAPI blob is not absence");
        let detail = problem.detail.as_deref().unwrap_or_default();
        assert!(detail.contains(&corrupt.display().to_string()), "{detail}");
        assert!(!detail.contains("\\xff"), "{detail}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_stdin_delivery_does_not_populate_the_success_cache() {
        let root = crate::test_support::temp_root("dpapi-cache-root");
        std::fs::create_dir_all(&root).unwrap();
        let cache = Mutex::new(BTreeMap::new());
        let result = remember_cached(
            &root,
            "SYNTHETIC_TEST",
            "synthetic-stdin-value",
            &cache,
            |_, _, value| {
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
        std::fs::remove_dir_all(root).unwrap();
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

#[cfg(not(target_os = "windows"))]
fn remember_in_store(root: &Path, name: &str, value: &str) -> Result<(), Problem> {
    let path = vault_dir(root)?.join(format!("{name}.secret"));
    write_secret_file(&path, value)
}

#[cfg(not(target_os = "windows"))]
fn write_secret_file(path: &Path, value: &str) -> Result<(), Problem> {
    write_secret_file_with(path, value, |tmp, value| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(tmp)?;
        file.write_all(value.as_bytes())?;
        file.sync_all()
    })
}

#[cfg(not(target_os = "windows"))]
fn write_secret_file_with(
    path: &Path,
    value: &str,
    write_tmp: impl FnOnce(&Path, &str) -> std::io::Result<()>,
) -> Result<(), Problem> {
    reject_unsafe_final(path)?;
    let tmp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("credential"),
        std::process::id()
    ));
    let result = write_tmp(&tmp, value)
        .and_then(|()| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
            }
            std::fs::rename(&tmp, path)
        })
        .map_err(|error| {
            Problem::with(
                "OpenBot could not save your sign-in details on this computer.",
                format!("{}: {error}", path.display()),
            )
        });
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn reject_unsafe_final(path: &Path) -> Result<(), Problem> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.file_type().is_file() => {
            Err(Problem::with(
                "OpenBot could not save your sign-in details on this computer.",
                format!("{}: credential path is not a regular file", path.display()),
            ))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(Problem::with(
            "OpenBot could not save your sign-in details on this computer.",
            format!("{}: {error}", path.display()),
        )),
    }
}

#[cfg(not(target_os = "windows"))]
fn recall_from_store(root: &Path, name: &str) -> Result<Option<String>, Problem> {
    recall_secret_file(&vault_dir(root)?.join(format!("{name}.secret")))
}

#[cfg(not(target_os = "windows"))]
fn recall_secret_file(path: &Path) -> Result<Option<String>, Problem> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.file_type().is_file() => {
            return Err(Problem::with(
                "OpenBot could not read your saved sign-in details on this computer.",
                format!("{}: credential path is not a regular file", path.display()),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(Problem::with(
                "OpenBot could not read your saved sign-in details on this computer.",
                format!("{}: {error}", path.display()),
            ));
        }
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).map_err(|error| {
        Problem::with(
            "OpenBot could not read your saved sign-in details on this computer.",
            format!("{}: {error}", path.display()),
        )
    })?;
    let mut value = String::new();
    file.read_to_string(&mut value).map_err(|error| {
        Problem::with(
            "OpenBot could not read your saved sign-in details on this computer.",
            format!("{}: {error}", path.display()),
        )
    })?;
    Ok(Some(value.trim().to_string()))
}

#[cfg(not(target_os = "windows"))]
fn forget_in_store(root: &Path, name: &str) -> Result<(), Problem> {
    remove_secret_file(&vault_dir(root)?.join(format!("{name}.secret")))
}

fn remove_secret_file(path: &Path) -> Result<(), Problem> {
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
pub(crate) fn vault_dir(root: &Path) -> Result<PathBuf, Problem> {
    let dir = root.join(".secrets");
    let prepare = || -> std::io::Result<()> {
        match require_credential_directory(&dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut builder = std::fs::DirBuilder::new();
                builder.recursive(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    builder.mode(0o700);
                }
                builder.create(&dir)?;
                // Check again when another creator won the race to create this directory.
                require_credential_directory(&dir)
            }
            Err(error) => Err(error),
        }
    };
    prepare().map_err(|error| {
        Problem::with(
            "OpenBot could not access the place it keeps your sign-in details.",
            format!("{}: {error}", dir.display()),
        )
    })?;
    owner_only(&dir)?;
    Ok(dir)
}

/// Checking the final credential file alone does not stop `.secrets` redirecting into another
/// deployment. Validate the directory before changing its permissions or accessing any item.
fn require_credential_directory(path: &Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    let redirected = metadata.file_type().is_symlink();
    #[cfg(windows)]
    let redirected = {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_REPARSE_POINT also covers junctions, not just symbolic links.
        const REPARSE_POINT: u32 = 0x400;
        redirected || metadata.file_attributes() & REPARSE_POINT != 0
    };
    if redirected || !metadata.is_dir() {
        return Err(std::io::Error::other(
            "credential directory is not a plain directory",
        ));
    }
    Ok(())
}

/// Owner-only where the platform has the notion, and a no-op where it does not.
///
/// Only where a file is kept; the Windows store path uses its platform protection separately.
#[cfg(unix)]
fn owner_only(path: &Path) -> Result<(), Problem> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if path.is_dir() { 0o700 } else { 0o600 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).map_err(|error| {
        Problem::with(
            "OpenBot could not make your saved sign-in details private to your account.",
            format!("{}: {error}", path.display()),
        )
    })
}

#[cfg(not(unix))]
fn owner_only(_path: &Path) -> Result<(), Problem> {
    Ok(())
}

#[cfg(all(test, not(target_os = "windows")))]
mod file_store_tests {
    use super::{recall_secret_file, remove_secret_file, vault_dir, write_secret_file_with};
    use crate::test_support::temp_root;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[cfg(unix)]
    #[test]
    fn secret_directory_symlink_cannot_read_write_or_remove_another_root() {
        let root = temp_root("vault-parent-symlink");
        let selected = root.join("selected");
        let other = root.join("other");
        std::fs::create_dir_all(&selected).unwrap();
        std::fs::create_dir_all(other.join(".secrets")).unwrap();
        let other_dir = other.join(".secrets");
        std::fs::set_permissions(&other_dir, std::fs::Permissions::from_mode(0o750)).unwrap();
        let key = "SYNTHETIC_PARENT_SYMLINK";
        let original = other_dir.join(format!("{key}.secret"));
        std::fs::write(&original, "other-root-public-sentinel").unwrap();
        std::os::unix::fs::symlink(&other_dir, selected.join(".secrets")).unwrap();

        // Run all three public boundaries even on the old implementation, then clean up before
        // asserting so a failing regression never leaves synthetic credentials behind.
        let read = super::recall(&selected, key);
        let write = super::remember(&selected, key, "selected-root-public-sentinel");
        let remove = super::forget(&selected, key);
        let remaining = std::fs::read_to_string(&original);
        let mode = std::fs::metadata(&other_dir).unwrap().permissions().mode() & 0o777;
        std::fs::remove_dir_all(&root).unwrap();

        for result in [read.map(|_| ()), write, remove] {
            let problem = result.expect_err("a redirected credential directory must be refused");
            let detail = problem.detail.unwrap();
            assert!(detail.contains(".secrets"));
            assert!(!detail.contains("public-sentinel"));
        }
        assert_eq!(remaining.unwrap(), "other-root-public-sentinel");
        assert_eq!(mode, 0o750);
    }

    #[test]
    fn secret_directory_file_is_rejected_without_modification() {
        let root = temp_root("vault-parent-file");
        std::fs::create_dir_all(&root).unwrap();
        let dir = root.join(".secrets");
        std::fs::write(&dir, "public-sentinel").unwrap();
        let result = vault_dir(&root);
        let remaining = std::fs::read_to_string(&dir).unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert!(result.is_err());
        assert_eq!(remaining, "public-sentinel");
    }

    #[test]
    fn secret_directory_is_owner_only() {
        let root = temp_root("vault-dir-mode");
        std::fs::create_dir_all(&root).unwrap();
        let dir = vault_dir(&root).unwrap();

        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn secret_file_is_owner_only_before_bytes() {
        let root = temp_root("vault-file-mode");
        std::fs::create_dir_all(&root).unwrap();
        super::remember(&root, "OPENAI_API_KEY", "synthetic-secret").unwrap();
        let path = root.join(".secrets/OPENAI_API_KEY.secret");

        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            super::recall(&root, "OPENAI_API_KEY").unwrap().as_deref(),
            Some("synthetic-secret")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_secret_write_preserves_existing_value() {
        let root = temp_root("vault-failed-write");
        std::fs::create_dir_all(&root).unwrap();
        let path = vault_dir(&root).unwrap().join("OPENAI_API_KEY.secret");
        std::fs::write(&path, "previous-synthetic-value").unwrap();

        let problem = write_secret_file_with(&path, "new-secret-value", |_, _| {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        })
        .expect_err("failed write must be reported");

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "previous-synthetic-value"
        );
        let detail = problem.detail.unwrap();
        assert!(detail.contains(path.to_string_lossy().as_ref()), "{detail}");
        assert!(!detail.contains("new-secret-value"), "{detail}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn secret_write_rejects_symlink_target() {
        let root = temp_root("vault-symlink-target");
        let outside = temp_root("vault-symlink-outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let outside_file = outside.join("outside.secret");
        std::fs::write(&outside_file, "outside-original").unwrap();
        let path = vault_dir(&root).unwrap().join("OPENAI_API_KEY.secret");
        std::os::unix::fs::symlink(&outside_file, &path).unwrap();

        let problem = super::remember(&root, "OPENAI_API_KEY", "new-secret-value")
            .expect_err("symlink targets must be refused");

        assert_eq!(
            std::fs::read_to_string(&outside_file).unwrap(),
            "outside-original"
        );
        let detail = problem.detail.unwrap();
        assert!(detail.contains(path.to_string_lossy().as_ref()), "{detail}");
        assert!(!detail.contains("new-secret-value"), "{detail}");
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn secret_read_rejects_nonregular_path() {
        let root = temp_root("vault-directory-secret");
        std::fs::create_dir_all(&root).unwrap();
        let path = vault_dir(&root).unwrap().join("OPENAI_API_KEY.secret");
        std::fs::create_dir(&path).unwrap();

        let problem = recall_secret_file(&path).expect_err("directories are unreadable secrets");

        assert_eq!(
            problem.said,
            "OpenBot could not read your saved sign-in details on this computer."
        );
        let detail = problem.detail.unwrap();
        assert!(detail.contains(path.to_string_lossy().as_ref()), "{detail}");
        assert!(detail.contains("regular file"), "{detail}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn secret_forget_reports_non_not_found_remove_errors() {
        let root = temp_root("vault-forget-directory");
        std::fs::create_dir_all(&root).unwrap();
        let path = vault_dir(&root).unwrap().join("OPENAI_API_KEY.secret");
        std::fs::create_dir(&path).unwrap();

        let problem = remove_secret_file(&path).expect_err("directory removal must be reported");
        let detail = problem.detail.unwrap();
        assert!(detail.contains(path.to_string_lossy().as_ref()), "{detail}");
        remove_secret_file(&path.join("missing")).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn macos_backend_round_trips_without_restore_offer() {
        let root = temp_root("vault-no-restore-offer");
        std::fs::create_dir_all(&root).unwrap();

        super::remember(&root, "OPENAI_API_KEY", "synthetic-secret").unwrap();
        assert_eq!(
            super::recall(&root, "OPENAI_API_KEY").unwrap().as_deref(),
            Some("synthetic-secret")
        );
        let problem = recall_secret_file(&root.join(".secrets"))
            .expect_err("directories must be ordinary file errors");
        assert!(!problem.said.contains("macOS"), "{problem:?}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn public_file_store_apis_are_root_isolated() {
        let default = temp_root("vault-public-default-root");
        let selected = temp_root("vault-public-selected-root");
        std::fs::create_dir_all(&default).unwrap();
        std::fs::create_dir_all(&selected).unwrap();

        super::remember(&default, "OPENAI_API_KEY", "default-poison").unwrap();
        super::remember(&selected, "OPENAI_API_KEY", "selected-secret").unwrap();
        assert_eq!(
            super::recall(&selected, "OPENAI_API_KEY")
                .unwrap()
                .as_deref(),
            Some("selected-secret")
        );
        assert_eq!(
            super::recall(&default, "OPENAI_API_KEY")
                .unwrap()
                .as_deref(),
            Some("default-poison")
        );
        assert_eq!(
            std::fs::read_to_string(default.join(".secrets/OPENAI_API_KEY.secret")).unwrap(),
            "default-poison"
        );
        assert_eq!(
            std::fs::read_to_string(selected.join(".secrets/OPENAI_API_KEY.secret")).unwrap(),
            "selected-secret"
        );

        super::forget(&selected, "OPENAI_API_KEY").unwrap();
        assert_eq!(super::recall(&selected, "OPENAI_API_KEY").unwrap(), None);
        assert_eq!(
            super::recall(&default, "OPENAI_API_KEY")
                .unwrap()
                .as_deref(),
            Some("default-poison")
        );

        std::fs::remove_dir_all(default).unwrap();
        std::fs::remove_dir_all(selected).unwrap();
    }
}

#[cfg(test)]
mod cache_tests {
    use crate::problem::Problem;
    use crate::test_support::temp_root;
    use std::collections::BTreeMap;

    #[test]
    fn only_successful_reads_are_cached_and_mutations_keep_them_current() {
        let name = "OPENAI_API_KEY";
        let root = temp_root("cache-root");
        std::fs::create_dir_all(&root).unwrap();
        let cache = std::sync::Mutex::new(BTreeMap::new());
        for _ in 0..2 {
            assert_eq!(
                super::recall_no_ui_cached(&root, name, &cache, |_, _| Ok(None)),
                Ok(None)
            );
            assert!(cache.lock().unwrap().is_empty());
        }
        let found =
            super::recall_no_ui_cached(&root, name, &cache, |_, _| Ok(Some("retried".into())))
                .unwrap();
        assert_eq!(found.as_deref(), Some("retried"));
        assert_eq!(
            super::recall_no_ui_cached(&root, name, &cache, |_, _| panic!("success cached"))
                .unwrap(),
            found
        );
        super::remember_cached(&root, name, "replacement", &cache, |_, _, _| Ok(())).unwrap();
        assert_eq!(
            super::recall_no_ui_cached(&root, name, &cache, |_, _| panic!("write cached"))
                .unwrap()
                .as_deref(),
            Some("replacement")
        );
        super::forget_cached(&root, name, &cache, |_, _| Ok(())).unwrap();
        assert!(cache.lock().unwrap().is_empty());
        assert_eq!(
            super::recall_no_ui_cached(&root, name, &cache, |_, _| Ok(None)),
            Ok(None)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cached_reads_are_isolated_by_root() {
        let root_a = temp_root("cache-root-a");
        let root_b = temp_root("cache-root-b");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();
        let cache = std::sync::Mutex::new(BTreeMap::new());
        let calls = std::sync::Mutex::new(Vec::new());
        let read = |root: &std::path::Path, name: &str| {
            calls
                .lock()
                .unwrap()
                .push((root.to_path_buf(), name.to_string()));
            if root == root_a {
                Ok(Some("root-a-value".to_string()))
            } else if root == root_b {
                Ok(Some("root-b-value".to_string()))
            } else {
                panic!("unexpected root {}", root.display());
            }
        };

        assert_eq!(
            super::recall_no_ui_cached(&root_a, "OPENAI_API_KEY", &cache, read)
                .unwrap()
                .as_deref(),
            Some("root-a-value")
        );
        assert_eq!(
            super::recall_no_ui_cached(&root_b, "OPENAI_API_KEY", &cache, read)
                .unwrap()
                .as_deref(),
            Some("root-b-value")
        );
        assert_eq!(
            super::recall_no_ui_cached(&root_a, "OPENAI_API_KEY", &cache, |_, _| {
                panic!("root A should be cached")
            })
            .unwrap()
            .as_deref(),
            Some("root-a-value")
        );

        assert_eq!(
            calls.lock().unwrap().as_slice(),
            [
                (root_a.clone(), "OPENAI_API_KEY".to_string()),
                (root_b.clone(), "OPENAI_API_KEY".to_string()),
            ]
        );
        std::fs::remove_dir_all(root_a).unwrap();
        std::fs::remove_dir_all(root_b).unwrap();
    }

    #[test]
    fn remember_and_forget_touch_only_the_matching_root_cache_entry() {
        let root_a = temp_root("cache-mutation-root-a");
        let root_b = temp_root("cache-mutation-root-b");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();
        let cache = std::sync::Mutex::new(BTreeMap::new());
        super::remember_cached(
            &root_a,
            "OPENAI_API_KEY",
            "root-a-old",
            &cache,
            |_, _, _| Ok(()),
        )
        .unwrap();
        super::remember_cached(
            &root_b,
            "OPENAI_API_KEY",
            "root-b-old",
            &cache,
            |_, _, _| Ok(()),
        )
        .unwrap();

        super::remember_cached(
            &root_a,
            "OPENAI_API_KEY",
            "root-a-new",
            &cache,
            |root, _, _| {
                assert_eq!(root, root_a);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            super::recall_no_ui_cached(&root_b, "OPENAI_API_KEY", &cache, |_, _| {
                panic!("root B should remain cached")
            })
            .unwrap()
            .as_deref(),
            Some("root-b-old")
        );

        super::forget_cached(&root_a, "OPENAI_API_KEY", &cache, |root, _| {
            assert_eq!(root, root_a);
            Ok(())
        })
        .unwrap();
        assert_eq!(
            super::recall_no_ui_cached(&root_b, "OPENAI_API_KEY", &cache, |_, _| {
                panic!("root B should remain cached after root A forget")
            })
            .unwrap()
            .as_deref(),
            Some("root-b-old")
        );
        assert_eq!(
            super::recall_no_ui_cached(&root_a, "OPENAI_API_KEY", &cache, |_, _| {
                Ok(Some("root-a-store".into()))
            })
            .unwrap()
            .as_deref(),
            Some("root-a-store")
        );
        std::fs::remove_dir_all(root_a).unwrap();
        std::fs::remove_dir_all(root_b).unwrap();
    }

    #[test]
    fn an_unchanged_confirmed_value_skips_persistence_but_a_change_never_does() {
        let root = temp_root("unchanged-cache-root");
        std::fs::create_dir_all(&root).unwrap();
        let cache = std::sync::Mutex::new(BTreeMap::from([(
            super::CacheKey {
                root: root.clone(),
                name: "OPENAI_API_KEY".into(),
            },
            Ok(Some("confirmed".into())),
        )]));
        super::remember_cached(&root, "OPENAI_API_KEY", "confirmed", &cache, |_, _, _| {
            panic!("redundant persistence after cache hit")
        })
        .unwrap();
        let error = super::remember_cached(
            &root,
            "OPENAI_API_KEY",
            "changed",
            &cache,
            |seen_root, key, value| {
                assert_eq!(seen_root, root);
                assert_eq!(key, "OPENAI_API_KEY");
                assert_eq!(value, "changed");
                Err(Problem::plain("synthetic no-UI refusal"))
            },
        )
        .unwrap_err();
        assert_eq!(error.said, "synthetic no-UI refusal");
        assert!(cache.lock().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_write_or_delete_cannot_publish_success_or_stale_cache() {
        for delete in [false, true] {
            let root = temp_root("failed-cache-root");
            std::fs::create_dir_all(&root).unwrap();
            let cache = std::sync::Mutex::new(BTreeMap::new());
            super::remember_cached(&root, "OPENAI_API_KEY", "old", &cache, |_, _, _| Ok(()))
                .unwrap();
            let denied =
                Problem::plain("synthetic refusal, including restoration after OS success");
            let result = if delete {
                super::forget_cached(&root, "OPENAI_API_KEY", &cache, |_, _| Err(denied.clone()))
            } else {
                super::remember_cached(&root, "OPENAI_API_KEY", "new", &cache, |_, _, _| {
                    Err(denied.clone())
                })
            };
            assert_eq!(result, Err(denied));
            assert!(cache.lock().unwrap().is_empty());
            assert_eq!(
                super::recall_no_ui_cached(&root, "OPENAI_API_KEY", &cache, |_, _| Ok(Some(
                    "authoritative".into()
                )))
                .unwrap()
                .as_deref(),
                Some("authoritative")
            );
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn protected_store_read_failure_reaches_already_given_boundary_without_file_fallback() {
        let root = temp_root("vault-protected-store-read-failure");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join(".env");
        let legacy = "KEY_ENCRYPTION_KEY=synthetic-existing-valid-key\n";
        std::fs::write(&path, legacy).unwrap();
        let denied = super::dpapi_read_problem("synthetic protected store read denied".into());

        let problem = super::already_given_with_reader(
            &root,
            &path,
            &["KEY_ENCRYPTION_KEY"],
            super::ReadPolicy::NoUi,
            |_, _| Err(denied.clone()),
        )
        .expect_err("protected-store read failure must not be treated as absence");

        assert_eq!(problem, denied);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
        std::fs::remove_dir_all(root).unwrap();
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
                &root,
                &path,
                &["KEY_ENCRYPTION_KEY"],
                super::ReadPolicy::NoUi,
                |_, _| Err(denied.clone())
            ),
            Err(denied)
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
        let missing = super::already_given_with_reader(
            &root,
            &path,
            &["KEY_ENCRYPTION_KEY"],
            super::ReadPolicy::NoUi,
            |_, _| Ok(None),
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
            &dir,
            &path,
            &["INTELLIGENCE_API_URL"],
            super::ReadPolicy::FileOnly,
        )
        .unwrap();
        assert!(file_only.is_empty());

        let no_ui = super::already_given_with_policy(
            &dir,
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
    fn refused_reads_can_succeed_after_a_later_attempt() {
        let root = temp_root("refused-retry-cache-root");
        std::fs::create_dir_all(&root).unwrap();
        let cache = std::sync::Mutex::new(BTreeMap::new());
        let attempts = std::sync::Mutex::new(0);
        let denied = Problem::with(
            "OpenBot needs permission to read saved credentials for this action.",
            "interaction refused",
        );

        for _ in 0..2 {
            let result = super::recall_no_ui_cached(&root, "OPENAI_API_KEY", &cache, |_, _| {
                *attempts.lock().unwrap() += 1;
                Err(denied.clone())
            });
            assert_eq!(result, Err(denied.clone()));
        }

        assert_eq!(*attempts.lock().unwrap(), 2);
        assert!(cache.lock().unwrap().is_empty());
        assert_eq!(
            super::recall_no_ui_cached(&root, "OPENAI_API_KEY", &cache, |_, _| Ok(Some(
                "retried".into()
            )))
            .unwrap()
            .as_deref(),
            Some("retried")
        );
        std::fs::remove_dir_all(root).unwrap();
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
            &dir,
            &path,
            &settings,
            &secrets,
            &purge,
            |root, key, value| {
                assert_eq!(root, dir);
                assert!(
                    std::fs::read_to_string(&path)
                        .unwrap()
                        .contains("KEY_ENCRYPTION_KEY=old-key"),
                    "the file was purged before every credential was remembered"
                );
                remembered.push((key.to_string(), value.to_string()));
                Ok(())
            },
            |_, _| Ok(()),
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
            &dir,
            &path,
            &settings,
            &secrets,
            &secrets,
            |root, key, _| {
                assert_eq!(root, dir);
                attempted.push(key.to_string());
                Err(Problem::plain(format!("refused {key}")))
            },
            |_, _| Ok(()),
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
            &dir,
            &path,
            &settings,
            &secrets,
            &secrets,
            |_, key, _| panic!("empty secret should have been forgotten, not remembered: {key}"),
            |root, key| {
                assert_eq!(root, dir);
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

    #[test]
    fn vault_round_trip() {
        let root = temp_root("vault-round-trip");
        std::fs::create_dir_all(&root).unwrap();
        let name = "OPENBOT_VAULT_SELF_TEST";
        remember(&root, name, "a value with spaces and $ymbols").expect("could not store");
        assert_eq!(
            recall(&root, name).unwrap().as_deref(),
            Some("a value with spaces and $ymbols")
        );
        forget(&root, name).unwrap();
        assert_eq!(
            recall(&root, name).unwrap(),
            None,
            "forget left the credential behind"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /**
    A long credential survives, because a short one is not the case that broke.

    The `security` command truncated at 128 bytes and reported success, which turned every OpenAI
    project key into a broken one on the next run. Checked well past the 164 a real key happens to
    be today: that number is nobody's to promise, and a store proved to four times the longest key
    anyone issues will not be the thing that fails when somebody issues a longer one.
    */
    #[test]
    fn a_long_credential_is_not_truncated() {
        let root = temp_root("vault-long-round-trip");
        std::fs::create_dir_all(&root).unwrap();
        let name = "OPENBOT_VAULT_LENGTH_TEST";
        for length in [128, 129, 164, 256, 512] {
            let value: String = std::iter::repeat_n('k', length).collect();
            remember(&root, name, &value).expect("could not store");
            let read = recall(&root, name).unwrap().unwrap_or_default();
            assert_eq!(
                read.len(),
                length,
                "a {length}-character credential came back short"
            );
            assert_eq!(read, value);
        }
        forget(&root, name).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
