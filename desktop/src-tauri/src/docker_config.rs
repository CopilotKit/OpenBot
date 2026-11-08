/*!
A Docker configuration of OpenBot's own, without the person's registry credentials, for every
container command OpenBot runs and for the Intelligence CLI.

WHY.

Docker Desktop writes `"credsStore": "desktop"` into `~/.docker/config.json`. From then on every
download through Docker's configuration (`docker pull`, `docker compose pull`, `docker run` of an
image that is not here yet, and Helm's `helm pull oci://`, which reads the same file) first runs
`docker-credential-desktop get`, even for a public image. Run by OpenBot, that helper is OpenBot
reading another app's data, and macOS stops it to ask the person whether "OpenBot" may access data
from other apps. Nothing downloads until somebody answers: the CLI's chart download times out and
setup fails, and every build signed ad hoc is a new app to macOS, so it asks again.

Everything OpenBot downloads is public. So its commands get `DOCKER_CONFIG` pointing at a
directory of OpenBot's own whose `config.json` names no credential store, no credential helper and
no saved logins, and keeps what Docker needs to find the engine the person uses: the current
context, the proxy settings and the extra plug-in folders. The person's `contexts` and
`cli-plugins` folders are linked in, so `docker context`, an explicit `DOCKER_CONTEXT` and
`docker compose` resolve exactly as they do in a terminal. An inherited `DOCKER_CONFIG` is the
configuration mirrored; an inherited `DOCKER_HOST` or `DOCKER_CONTEXT` is left alone and still
wins, as it does for Docker.

Measured with Helm 3.17: `HELM_REGISTRY_CONFIG` alone still reaches the helper, because Helm also
reads Docker's configuration; an empty `DOCKER_CONFIG` does not.

Rewritten for every command, so a context switched while OpenBot runs is the context the next
command uses. Written only when it changed, and replaced by rename, so a command started meanwhile
never reads half a file or a missing link.

Not on Windows: Docker Desktop's helper there is the Windows Credential Manager, which asks
nobody, and a directory link there needs Developer Mode.
*/

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

/// The keys of the person's `config.json` that OpenBot's copy keeps. Everything else, the
/// credential store, the credential helpers and the saved logins above all, is left out.
const KEPT: &[&str] = &["currentContext", "proxies", "cliPluginsExtraDirs"];

/// The folders of the person's Docker configuration linked into OpenBot's: where contexts are
/// defined, and where Docker Desktop installs Compose and the other plug-ins.
const LINKED: &[&str] = &["contexts", "cli-plugins"];

/// The keys that must never reach OpenBot's copy.
pub const CREDENTIAL_KEYS: &[&str] = &["credsStore", "credHelpers", "auths"];

static OWNED: OnceLock<PathBuf> = OnceLock::new();
static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(0);

/// Tell this module where OpenBot's Docker configuration lives. Set once, at start-up, because
/// the app knows its data directory and the modules that run commands do not.
pub fn lives_in(dir: PathBuf) {
    let _ = OWNED.set(dir);
}

/// Where OpenBot's Docker configuration lives, once the app has said.
pub fn owned() -> Option<&'static Path> {
    OWNED.get().map(PathBuf::as_path)
}

/// The `DOCKER_CONFIG` for a command OpenBot runs, prepared in `owned` from the environment `var`
/// reads, or None to leave the command with the configuration it inherits.
pub fn for_commands_in(owned: &Path, var: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    if cfg!(windows) {
        return None;
    }
    match prepare(owned, var) {
        Ok(dir) => Some(dir),
        // The command runs as it always did, with the configuration it inherits.
        Err(error) => {
            log::warn!(
                "[docker config] could not prepare OpenBot's Docker configuration at {}: {error}",
                owned.display()
            );
            None
        }
    }
}

/// The person's Docker configuration directory, as Docker finds it: `DOCKER_CONFIG` when set,
/// `~/.docker` otherwise.
pub fn source(var: &impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    if let Some(dir) = var("DOCKER_CONFIG").filter(|dir| !dir.to_string_lossy().trim().is_empty()) {
        return Some(PathBuf::from(dir));
    }
    var("HOME")
        .or_else(|| var("USERPROFILE"))
        .filter(|home| !home.is_empty())
        .map(|home| PathBuf::from(home).join(".docker"))
}

/// Write OpenBot's Docker configuration into `owned` from the person's, and answer `owned`.
pub fn prepare(owned: &Path, var: impl Fn(&str) -> Option<OsString>) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(owned)?;
    let source = source(&var);
    // OpenBot started from a shell that already points at OpenBot's copy: nothing to mirror.
    if let Some(source) = &source {
        if same_place(source, owned) {
            return Ok(owned.to_path_buf());
        }
    }
    let person = source
        .as_deref()
        .and_then(|dir| std::fs::read(dir.join("config.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let mut kept = serde_json::Map::new();
    for key in KEPT {
        if let Some(value) = person.as_ref().and_then(|person| person.get(*key)) {
            kept.insert((*key).to_string(), value.clone());
        }
    }
    let mut config = serde_json::to_vec_pretty(&serde_json::Value::Object(kept))
        .map_err(std::io::Error::other)?;
    config.push(b'\n');
    let at = owned.join("config.json");
    if std::fs::read(&at).ok().as_deref() != Some(config.as_slice()) {
        let temporary = temporary(owned, "config.json");
        std::fs::write(&temporary, &config)?;
        replace(&temporary, &at)?;
    }
    for name in LINKED {
        let at = owned.join(name);
        let target = source
            .as_deref()
            .map(|dir| dir.join(name))
            .filter(|target| target.is_dir());
        match target {
            Some(target) => {
                if std::fs::read_link(&at).ok().as_deref() == Some(target.as_path()) {
                    continue;
                }
                let temporary = temporary(owned, name);
                link_dir(&target, &temporary)?;
                replace(&temporary, &at)?;
            }
            // Gone from the person's configuration: gone from OpenBot's, so nothing stale resolves.
            None => {
                if std::fs::symlink_metadata(&at).is_ok_and(|meta| meta.file_type().is_symlink()) {
                    std::fs::remove_file(&at)?;
                }
            }
        }
    }
    Ok(owned.to_path_buf())
}

fn same_place(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn temporary(dir: &Path, name: &str) -> PathBuf {
    let next = NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".{name}.{}.{next}.tmp", std::process::id()))
}

fn replace(temporary: &Path, at: &Path) -> std::io::Result<()> {
    std::fs::rename(temporary, at).inspect_err(|_| {
        let _ = std::fs::remove_file(temporary);
    })
}

#[cfg(unix)]
fn link_dir(target: &Path, at: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, at)
}

#[cfg(windows)]
fn link_dir(target: &Path, at: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(target, at)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::test_support::temp_root;
    use std::collections::HashMap;

    fn environment(pairs: &[(&str, &Path)]) -> impl Fn(&str) -> Option<OsString> {
        let pairs: HashMap<String, OsString> = pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.as_os_str().to_owned()))
            .collect();
        move |name| pairs.get(name).cloned()
    }

    /// Docker Desktop's own `~/.docker`, as it writes it on a Mac: a credential store, saved
    /// logins, its context, and Compose among the plug-ins.
    fn docker_desktop_config(dir: &Path) {
        std::fs::create_dir_all(dir.join("contexts/meta/fe9c6bd7")).unwrap();
        std::fs::write(
            dir.join("contexts/meta/fe9c6bd7/meta.json"),
            r#"{"Name":"desktop-linux","Endpoints":{"docker":{"Host":"unix:///Users/a/.docker/run/docker.sock"}}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("cli-plugins")).unwrap();
        std::fs::write(dir.join("cli-plugins/docker-compose"), "").unwrap();
        std::fs::write(
            dir.join("config.json"),
            r#"{
                "auths": {"604598162673.dkr.ecr.us-east-2.amazonaws.com": {}, "ghcr.io": {"auth": "c2VjcmV0"}},
                "credsStore": "desktop",
                "credHelpers": {"gcr.io": "gcloud"},
                "currentContext": "desktop-linux",
                "proxies": {"default": {"httpsProxy": "http://127.0.0.1:3128"}},
                "plugins": {"scout": {"hooks": "pull,buildx build"}},
                "features": {"hooks": "true"}
            }"#,
        )
        .unwrap();
    }

    fn read(owned: &Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(owned.join("config.json")).unwrap()).unwrap()
    }

    #[test]
    fn openbots_copy_names_no_credential_and_keeps_the_context() {
        let root = temp_root("docker-config-home");
        let home = root.join("home");
        docker_desktop_config(&home.join(".docker"));
        let owned = root.join("owned");

        let prepared = prepare(&owned, environment(&[("HOME", &home)])).unwrap();

        assert_eq!(prepared, owned);
        let config = read(&owned);
        for key in CREDENTIAL_KEYS {
            assert!(config.get(key).is_none(), "{key} reached OpenBot's copy");
        }
        assert!(
            !String::from_utf8(std::fs::read(owned.join("config.json")).unwrap())
                .unwrap()
                .contains("c2VjcmV0")
        );
        assert_eq!(config["currentContext"], "desktop-linux");
        assert_eq!(
            config["proxies"]["default"]["httpsProxy"],
            "http://127.0.0.1:3128"
        );
        assert!(config.get("plugins").is_none() && config.get("features").is_none());
        // Docker resolves the context by its meta under DOCKER_CONFIG/contexts, and Compose under
        // DOCKER_CONFIG/cli-plugins.
        assert!(owned.join("contexts/meta/fe9c6bd7/meta.json").is_file());
        assert!(owned.join("cli-plugins/docker-compose").is_file());
        assert_eq!(
            std::fs::read_link(owned.join("contexts")).unwrap(),
            home.join(".docker/contexts")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// Somebody who keeps Docker's configuration elsewhere: that is the one mirrored, not `~/.docker`.
    #[test]
    fn an_inherited_docker_config_is_the_one_mirrored() {
        let root = temp_root("docker-config-explicit");
        let home = root.join("home");
        docker_desktop_config(&home.join(".docker"));
        let theirs = root.join("theirs");
        std::fs::create_dir_all(theirs.join("contexts/meta/abc")).unwrap();
        std::fs::write(
            theirs.join("config.json"),
            r#"{"credsStore":"osxkeychain","currentContext":"colima"}"#,
        )
        .unwrap();
        let owned = root.join("owned");

        prepare(
            &owned,
            environment(&[("HOME", &home), ("DOCKER_CONFIG", &theirs)]),
        )
        .unwrap();

        let config = read(&owned);
        assert_eq!(config["currentContext"], "colima");
        assert!(config.get("credsStore").is_none());
        assert_eq!(
            std::fs::read_link(owned.join("contexts")).unwrap(),
            theirs.join("contexts")
        );
        // They have no plug-in folder, so OpenBot's has none either.
        assert!(std::fs::symlink_metadata(owned.join("cli-plugins")).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    /// A person who switches context, or removes Docker's configuration, while OpenBot runs.
    #[test]
    fn the_copy_follows_the_persons_configuration_between_commands() {
        let root = temp_root("docker-config-follow");
        let home = root.join("home");
        let docker = home.join(".docker");
        docker_desktop_config(&docker);
        let owned = root.join("owned");
        prepare(&owned, environment(&[("HOME", &home)])).unwrap();

        std::fs::write(
            docker.join("config.json"),
            r#"{"currentContext":"orbstack"}"#,
        )
        .unwrap();
        prepare(&owned, environment(&[("HOME", &home)])).unwrap();
        assert_eq!(read(&owned)["currentContext"], "orbstack");

        std::fs::remove_dir_all(&docker).unwrap();
        prepare(&owned, environment(&[("HOME", &home)])).unwrap();
        assert_eq!(read(&owned), serde_json::json!({}));
        assert!(std::fs::symlink_metadata(owned.join("contexts")).is_err());
        let leftovers: Vec<_> = std::fs::read_dir(&owned)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    /// OpenBot started from a shell that already points DOCKER_CONFIG at OpenBot's copy.
    #[test]
    fn openbots_own_copy_is_never_mirrored_into_itself() {
        let root = temp_root("docker-config-self");
        let owned = root.join("owned");
        std::fs::create_dir_all(&owned).unwrap();
        std::fs::write(owned.join("config.json"), r#"{"currentContext":"x"}"#).unwrap();

        prepare(&owned, environment(&[("DOCKER_CONFIG", &owned)])).unwrap();

        assert_eq!(read(&owned)["currentContext"], "x");
        assert!(std::fs::symlink_metadata(owned.join("contexts")).is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
