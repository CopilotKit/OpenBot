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

/// What the Keychain and the fallback file file these under.
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
    for (key, value) in secrets {
        if value.trim().is_empty() {
            // An empty value is this run clearing a credential the model choice does not imply.
            forget(key);
            continue;
        }
        remember(key, value)?;
    }
    Ok(())
}

/**
What a previous run left, wherever it left it.

The file first and the store on top, which is what makes an upgrade silent. A machine that ran a
version before the store existed still has its credentials in the `.env`; reading only the store
would ask that person for a key they already gave, and reading only the file would ignore the one
they gave since. The store wins because it is the one this version writes.
*/
pub fn already_given(env_file: &std::path::Path, keys: &[&str]) -> BTreeMap<String, String> {
    let mut found = crate::env::already_set(env_file, keys);
    found.extend(recall_all(
        &keys
            .iter()
            .copied()
            .filter(|k| is_secret(k))
            .collect::<Vec<_>>(),
    ));
    found
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
pub fn remember(name: &str, value: &str) -> Result<(), Problem> {
    // Set, not add: a second run updates the item rather than colliding with the first.
    security_framework::passwords::set_generic_password(SERVICE, name, value.as_bytes())
        .map_err(|error| keychain_problem(error.to_string()))
}

#[cfg(target_os = "macos")]
pub fn recall(name: &str) -> Option<String> {
    let raw = security_framework::passwords::get_generic_password(SERVICE, name).ok()?;
    String::from_utf8(raw).ok()
}

#[cfg(target_os = "macos")]
pub fn forget(name: &str) {
    let _ = security_framework::passwords::delete_generic_password(SERVICE, name);
}

#[cfg(target_os = "macos")]
fn keychain_problem(detail: String) -> Problem {
    Problem::with(
        "OpenBot could not save your sign-in details to this Mac's Keychain.",
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
pub fn remember(name: &str, value: &str) -> Result<(), Problem> {
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
pub fn recall(name: &str) -> Option<String> {
    const UNPROTECT: &str = r#"
$ErrorActionPreference = 'Stop'
$sealed = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
Add-Type -AssemblyName System.Security
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $null, 'CurrentUser')
[Text.Encoding]::UTF8.GetString($bytes)
"#;
    let sealed = std::fs::read_to_string(vault_dir().ok()?.join(format!("{name}.dpapi"))).ok()?;
    powershell(UNPROTECT, Some(&sealed))
        .ok()
        .map(|plain| plain.trim().to_string())
}

#[cfg(target_os = "windows")]
pub fn forget(name: &str) {
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
pub fn remember(name: &str, value: &str) -> Result<(), Problem> {
    let path = vault_dir()?.join(format!("{name}.secret"));
    std::fs::write(&path, value).map_err(|error| {
        Problem::with(
            "OpenBot could not save your sign-in details on this computer.",
            format!("{}: {error}", path.display()),
        )
    })?;
    owner_only(&path);
    Ok(())
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
pub fn recall(name: &str) -> Option<String> {
    std::fs::read_to_string(vault_dir().ok()?.join(format!("{name}.secret")))
        .ok()
        .map(|value| value.trim().to_string())
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
pub fn forget(name: &str) {
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
    owner_only(&dir);
    Ok(dir)
}

/// Owner-only where the platform has the notion, and a no-op where it does not.
///
/// Only where a file is kept. The Keychain owns its own protection and has no path to set.
#[cfg(all(unix, not(target_os = "macos")))]
fn owner_only(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let mode = if path.is_dir() { 0o700 } else { 0o600 };
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(all(not(unix), not(target_os = "macos")))]
fn owner_only(_path: &std::path::Path) {}

#[cfg(test)]
mod tests {
    use super::*;

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
        let dir = std::env::temp_dir().join(format!("openbot-purge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(
            &path,
            "OPENAI_API_KEY=the-old-copy\nSERVER_PORT=3001\nSOMETHING_ELSE=kept\n",
        )
        .unwrap();

        let mut all = BTreeMap::new();
        all.insert("OPENAI_API_KEY".to_string(), "the-new-one".to_string());
        all.insert("SERVER_PORT".to_string(), "3001".to_string());
        let (settings, secrets) = split(all);
        crate::env::write(&path, &settings, &secrets).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert!(
            !written.contains("the-old-copy") && !written.contains("the-new-one"),
            "a credential is still in the file:\n{written}"
        );
        assert!(!written.contains("OPENAI_API_KEY"), "{written}");
        assert!(written.contains("SERVER_PORT=3001"), "{written}");
        // A line nobody here owns is still nobody's to remove.
        assert!(written.contains("SOMETHING_ELSE=kept"), "{written}");
        std::fs::remove_dir_all(&dir).ok();
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
