//! The `.env` the shell writes, and the secrets it mints.
//!
//! `scripts/start.sh` writes the same file for a developer. This writes it for somebody who will
//! never open a terminal, which changes three things:
//!
//! - **No dev fallbacks.** `start.sh` falls back to fixed strings for `COMPUTER_TOKEN`,
//!   `SUPERVISOR_TOKEN` and `WORKER_SHARED_SECRET`, which are published in this repository. They are
//!   fine on a laptop somebody is debugging and they are not fine as the default a product ships.
//!   Every one of them is generated here.
//! - **A real `KEY_ENCRYPTION_KEY`.** `.env.example` carries a valid public key, and
//!   `server/src/config.ts` only throws on it under `NODE_ENV=production`. A desktop install is not
//!   production, so it would land in the warn branch and encrypt the credential vault with a key
//!   printed in a public repository, objected to by a `console.warn` nobody running a window reads.
//! - **`COMPUTER_SUPERVISOR_URL` is not optional.** Without it the server runs every Bot against one
//!   shared browser and says so only in a startup line. `start.sh` sets it at run time, so a `.env`
//!   copied from a developer's machine does not have it.

use std::collections::BTreeMap;
use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use rand::RngCore;

use crate::engine::EngineStatus;

/// Ports the stack publishes. Matched to `docker-compose.yml` defaults so a person who later runs
/// Compose by hand finds the deployment where the documentation says it is.
pub struct Ports {
    pub app: u16,
    pub server: u16,
    pub postgres: u16,
    pub computer: u16,
    pub bot: u16,
    pub langgraph: u16,
    pub supervisor: u16,
}

impl Default for Ports {
    fn default() -> Self {
        Self {
            app: 3010,
            server: 3001,
            postgres: 5432,
            computer: 4100,
            bot: 4200,
            langgraph: 4201,
            supervisor: 4500,
        }
    }
}

/// 32 random bytes, base64. The shape `KEY_ENCRYPTION_KEY` requires and a fine shape for the rest.
fn secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    BASE64.encode(bytes)
}

/// The settings the shell owns, in the order a person reading the file would want them.
///
/// Addresses use `127.0.0.1` rather than `localhost` deliberately. Compose publishes on both
/// loopback addresses, so either would connect, but naming one removes a whole class of question
/// about which the resolver picked.
pub fn compose(
    intelligence: &Intelligence,
    engine: &EngineStatus,
    ports: &Ports,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();

    env.insert("INTELLIGENCE_API_URL".into(), intelligence.api_url.clone());
    env.insert(
        "INTELLIGENCE_GATEWAY_WS_URL".into(),
        intelligence.gateway_ws_url.clone(),
    );
    env.insert("INTELLIGENCE_API_KEY".into(), intelligence.api_key.clone());

    env.insert("KEY_ENCRYPTION_KEY".into(), secret());
    env.insert("SUPERVISOR_TOKEN".into(), secret());
    env.insert("COMPUTER_TOKEN".into(), secret());
    env.insert("WORKER_SHARED_SECRET".into(), secret());
    env.insert("MANAGED_AGENT_TOKEN".into(), secret());
    env.insert("AGENT_TOOL_TOKEN".into(), secret());

    env.insert(
        "DATABASE_URL".into(),
        format!(
            "postgres://openbot:openbot@127.0.0.1:{}/openbot",
            ports.postgres
        ),
    );
    env.insert(
        "TRUSTED_ORIGINS".into(),
        format!("http://127.0.0.1:{}", ports.app),
    );
    env.insert(
        "AGENT_COMPUTER_URL".into(),
        format!("http://127.0.0.1:{}", ports.computer),
    );
    env.insert(
        "MANAGED_AGENT_AG_UI_URL".into(),
        format!("http://127.0.0.1:{}/ag-ui", ports.langgraph),
    );

    // Without this the server gives every Bot the same browser. It is the difference between the
    // product this installs and a demo of it.
    env.insert(
        "COMPUTER_SUPERVISOR_URL".into(),
        format!("http://127.0.0.1:{}", ports.supervisor),
    );

    env.insert("APP_PORT".into(), ports.app.to_string());
    env.insert("SERVER_PORT".into(), ports.server.to_string());
    env.insert("POSTGRES_PORT".into(), ports.postgres.to_string());
    env.insert("COMPUTER_PORT".into(), ports.computer.to_string());
    env.insert("BOT_PORT".into(), ports.bot.to_string());
    env.insert("LANGGRAPH_PORT".into(), ports.langgraph.to_string());
    env.insert("SUPERVISOR_PORT".into(), ports.supervisor.to_string());

    // Pull the published images rather than build them. A desktop install has no toolchain and no
    // reason to compile Chromium.
    env.insert("IMAGE_PULL_POLICY".into(), "missing".into());

    // Only rootless Podman on Linux needs this; see engine.rs.
    if let Some(socket) = &engine.engine_socket {
        env.insert("ENGINE_SOCKET".into(), socket.clone());
    }

    env
}

#[derive(Clone, Debug)]
pub struct Intelligence {
    pub api_url: String,
    pub gateway_ws_url: String,
    pub api_key: String,
}

/// Write the file, replacing only what this owns.
///
/// Lines the shell did not write are kept: somebody who added `OPENAI_API_KEY` by hand, or a
/// setting a later version of this app does not know about, should not lose it because the stack
/// was restarted.
pub fn write(path: &Path, owned: &BTreeMap<String, String>) -> std::io::Result<()> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let mut out = String::new();

    for line in existing.lines() {
        let key = line.split('=').next().unwrap_or("").trim();
        if key.is_empty() || line.trim_start().starts_with('#') || !owned.contains_key(key) {
            out.push_str(line);
            out.push('\n');
        }
    }

    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("\n# Written by OpenBot Desktop. Anything else in this file is left alone.\n");
    for (key, value) in owned {
        out.push_str(&format!("{key}={value}\n"));
    }

    std::fs::write(path, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intelligence() -> Intelligence {
        Intelligence {
            api_url: "https://api.example".into(),
            gateway_ws_url: "wss://realtime.example".into(),
            api_key: "key".into(),
        }
    }

    fn engine_status(socket: Option<&str>) -> EngineStatus {
        EngineStatus {
            engine: None,
            responding: true,
            engine_socket: socket.map(str::to_string),
            detail: String::new(),
        }
    }

    #[test]
    fn every_shared_secret_is_generated_rather_than_the_published_dev_default() {
        let env = compose(&intelligence(), &engine_status(None), &Ports::default());
        for key in [
            "COMPUTER_TOKEN",
            "SUPERVISOR_TOKEN",
            "WORKER_SHARED_SECRET",
            "KEY_ENCRYPTION_KEY",
        ] {
            let value = env.get(key).expect(key);
            assert!(!value.contains("openbot-dev"), "{key} kept a dev default");
            assert!(
                value.len() > 20,
                "{key} is too short to be a generated secret"
            );
        }
    }

    #[test]
    fn two_installs_do_not_share_a_key() {
        let a = compose(&intelligence(), &engine_status(None), &Ports::default());
        let b = compose(&intelligence(), &engine_status(None), &Ports::default());
        assert_ne!(a.get("KEY_ENCRYPTION_KEY"), b.get("KEY_ENCRYPTION_KEY"));
    }

    #[test]
    fn the_supervisor_url_is_set_or_every_bot_shares_one_browser() {
        let env = compose(&intelligence(), &engine_status(None), &Ports::default());
        assert_eq!(
            env.get("COMPUTER_SUPERVISOR_URL").map(String::as_str),
            Some("http://127.0.0.1:4500")
        );
    }

    #[test]
    fn the_engine_socket_is_written_only_when_the_default_is_wrong() {
        let without = compose(&intelligence(), &engine_status(None), &Ports::default());
        assert!(!without.contains_key("ENGINE_SOCKET"));

        let with = compose(
            &intelligence(),
            &engine_status(Some("/run/user/501/podman/podman.sock")),
            &Ports::default(),
        );
        assert_eq!(
            with.get("ENGINE_SOCKET").map(String::as_str),
            Some("/run/user/501/podman/podman.sock")
        );
    }

    #[test]
    fn addresses_name_an_address_rather_than_localhost() {
        let env = compose(&intelligence(), &engine_status(None), &Ports::default());
        for key in [
            "DATABASE_URL",
            "AGENT_COMPUTER_URL",
            "COMPUTER_SUPERVISOR_URL",
            "MANAGED_AGENT_AG_UI_URL",
        ] {
            assert!(!env[key].contains("localhost"), "{key} says localhost");
        }
    }

    #[test]
    fn writing_keeps_settings_the_shell_does_not_own() {
        let dir = std::env::temp_dir().join(format!("openbot-env-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(&path, "OPENAI_API_KEY=sk-somebodys-own\n# a comment\n").unwrap();

        let env = compose(&intelligence(), &engine_status(None), &Ports::default());
        write(&path, &env).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert!(
            written.contains("OPENAI_API_KEY=sk-somebodys-own"),
            "dropped a setting it does not own"
        );
        assert!(written.contains("# a comment"));
        assert!(written.contains("COMPUTER_SUPERVISOR_URL="));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rewriting_replaces_its_own_settings_rather_than_appending_them_twice() {
        let dir = std::env::temp_dir().join(format!("openbot-env-twice-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");

        let first = compose(&intelligence(), &engine_status(None), &Ports::default());
        write(&path, &first).unwrap();
        let second = compose(&intelligence(), &engine_status(None), &Ports::default());
        write(&path, &second).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            written.matches("KEY_ENCRYPTION_KEY=").count(),
            1,
            "the key was written twice"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
