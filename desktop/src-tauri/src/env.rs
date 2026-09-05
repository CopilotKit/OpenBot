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
    model: &Model,
    engine: &EngineStatus,
    ports: &Ports,
    images: &[(String, String)],
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();

    // Left out entirely when blank: written empty, Compose passes an empty string and the Bot's own
    // refusal becomes a confusing one about a key that is set and useless.
    if !model.openai_api_key.trim().is_empty() {
        env.insert(
            "OPENAI_API_KEY".into(),
            model.openai_api_key.trim().to_string(),
        );
    }

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
    // Every address the app is actually reachable at, because it is reachable at more than one.
    //
    // The app's dev server binds `[::1]` and not `127.0.0.1`, so a browser sent to one of those
    // arrives with an origin the other would not match, and the deployment refuses a request it
    // should have accepted. Naming all three costs nothing: they are the same machine, and the
    // question this setting answers is which origins are this deployment's own.
    env.insert(
        "TRUSTED_ORIGINS".into(),
        format!(
            "http://localhost:{app},http://127.0.0.1:{app},http://[::1]:{app}",
            app = ports.app
        ),
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

    // The worker refuses to start without this, by design: it is a fact about where this process
    // runs, and it would rather stop than guess. `start.sh` sets it at run time, so a `.env` copied
    // from a developer's machine does not carry it either.
    env.insert(
        "SERVER_INTERNAL_URL".into(),
        format!("http://127.0.0.1:{}", ports.server),
    );

    env.insert("APP_PORT".into(), ports.app.to_string());
    env.insert("SERVER_PORT".into(), ports.server.to_string());
    env.insert("POSTGRES_PORT".into(), ports.postgres.to_string());
    env.insert("COMPUTER_PORT".into(), ports.computer.to_string());
    env.insert("BOT_PORT".into(), ports.bot.to_string());
    env.insert("LANGGRAPH_PORT".into(), ports.langgraph.to_string());
    env.insert("SUPERVISOR_PORT".into(), ports.supervisor.to_string());

    // The whole deployment is on this machine, so the server must be allowed to talk to it.
    //
    // The private-address floor stops a hosted deployment reaching into its own network, which is
    // right there and wrong here: the supervisor, the computers and the Bots are all on loopback by
    // design. Without this the server refuses to call its own supervisor and the failure arrives as
    // an Unauthorized wrapped in a 500, which names neither the address nor the rule.
    env.insert("AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS".into(), "true".into());

    // Which package the deployment runs. Without it the server falls back rather than using the one
    // that came with the deployment, and the Bots somebody was given are not the Bots they get.
    env.insert("TENANT_PACKAGE_DIR".into(), "../examples/fintech".into());

    // The one person, named. `OPENBOT_SINGLE_USER` says there is nobody else; this says who that
    // somebody is, so the routes that ask what an actor may do have an actor to answer about.
    env.insert("INITIAL_ADMIN_EMAILS".into(), "dev@openbot.local".into());

    // One machine, one person, no sign-in.
    //
    // The server refuses to start with no identity provider rather than serve a deployment where
    // every visitor is an administrator, which is the right refusal on a server and the wrong
    // question on a laptop: there is nobody else here. Saying so explicitly is how that refusal is
    // answered, and it is the same switch `ci.yml` uses for the same reason.
    env.insert("OPENBOT_SINGLE_USER".into(), "true".into());

    // Pull the published images rather than build them. A desktop install has no toolchain and no
    // reason to compile Chromium.
    env.insert("IMAGE_PULL_POLICY".into(), "missing".into());

    // Which images, by digest, from the release's own manifest. Compose's defaults are local build
    // names, so leaving these unset does not fall back to something workable: it asks a registry
    // for `openbot-supervisor:latest`, which nobody publishes, and the denial that comes back
    // reads as a login problem.
    for (variable, reference) in images {
        env.insert(variable.clone(), reference.clone());
    }

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

/// The model credential, which belongs to the provider and not to the harness.
///
/// Both Bots the deployment ships refuse to start without one, saying so plainly: "This Bot cannot
/// answer without a model." Choosing between providers is its own screen later; this is the one key
/// without which nothing answers at all.
#[derive(Clone, Debug, Default)]
pub struct Model {
    pub openai_api_key: String,
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

    /// A pinned image per Compose variable, as a release manifest supplies.
    fn pinned() -> Vec<(String, String)> {
        crate::deployment::IMAGE_VARIABLES
            .iter()
            .map(|(published, variable)| {
                (
                    (*variable).to_string(),
                    format!("ghcr.io/copilotkit/openbot-{published}@sha256:abc"),
                )
            })
            .collect()
    }

    fn engine_status(socket: Option<&str>) -> EngineStatus {
        EngineStatus {
            engine: None,
            address: None,
            responding: true,
            engine_socket: socket.map(str::to_string),
            detail: String::new(),
        }
    }

    #[test]
    fn every_shared_secret_is_generated_rather_than_the_published_dev_default() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
        );
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
        let a = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
        );
        let b = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
        );
        assert_ne!(a.get("KEY_ENCRYPTION_KEY"), b.get("KEY_ENCRYPTION_KEY"));
    }

    #[test]
    fn the_server_may_reach_its_own_supervisor_on_loopback() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
        );
        assert_eq!(
            env.get("AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS")
                .map(String::as_str),
            Some("true"),
            "everything a desktop install talks to is on this machine"
        );
    }

    #[test]
    fn the_deployment_runs_its_own_package_rather_than_a_fallback() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
        );
        assert_eq!(
            env.get("TENANT_PACKAGE_DIR").map(String::as_str),
            Some("../examples/fintech")
        );
    }

    #[test]
    fn a_desktop_install_is_single_user_or_the_server_refuses_to_start() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
        );
        assert_eq!(
            env.get("OPENBOT_SINGLE_USER").map(String::as_str),
            Some("true")
        );
    }

    #[test]
    fn the_worker_is_told_where_the_server_is_or_it_refuses_to_start() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
        );
        assert_eq!(
            env.get("SERVER_INTERNAL_URL").map(String::as_str),
            Some("http://127.0.0.1:3001")
        );
    }

    #[test]
    fn the_supervisor_url_is_set_or_every_bot_shares_one_browser() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
        );
        assert_eq!(
            env.get("COMPUTER_SUPERVISOR_URL").map(String::as_str),
            Some("http://127.0.0.1:4500")
        );
    }

    #[test]
    fn the_engine_socket_is_written_only_when_the_default_is_wrong() {
        let without = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
        );
        assert!(!without.contains_key("ENGINE_SOCKET"));

        let with = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(Some("/run/user/501/podman/podman.sock")),
            &Ports::default(),
            &pinned(),
        );
        assert_eq!(
            with.get("ENGINE_SOCKET").map(String::as_str),
            Some("/run/user/501/podman/podman.sock")
        );
    }

    #[test]
    fn addresses_name_an_address_rather_than_localhost() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
        );
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

        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
        );
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

        let first = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
        );
        write(&path, &first).unwrap();
        let second = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
        );
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

#[cfg(test)]
mod model_tests {
    use super::*;

    fn intelligence() -> Intelligence {
        Intelligence {
            api_url: "https://api.example".into(),
            gateway_ws_url: "wss://realtime.example".into(),
            api_key: "key".into(),
        }
    }

    fn pinned() -> Vec<(String, String)> {
        crate::deployment::IMAGE_VARIABLES
            .iter()
            .map(|(published, variable)| {
                (
                    (*variable).to_string(),
                    format!("ghcr.io/copilotkit/openbot-{published}@sha256:abc"),
                )
            })
            .collect()
    }

    fn engine() -> EngineStatus {
        EngineStatus {
            engine: None,
            address: None,
            responding: true,
            engine_socket: None,
            detail: String::new(),
        }
    }

    #[test]
    fn every_image_is_named_by_digest_so_compose_never_reaches_for_a_local_build() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine(),
            &Ports::default(),
            &pinned(),
        );
        for (_, variable) in crate::deployment::IMAGE_VARIABLES {
            let reference = env
                .get(variable)
                .unwrap_or_else(|| panic!("{variable} is not set, so Compose would build instead"));
            assert!(reference.contains("@sha256:"), "{variable}={reference}");
        }
    }

    #[test]
    fn the_model_key_is_written_when_one_is_given() {
        let env = compose(
            &intelligence(),
            &Model {
                openai_api_key: "sk-a-real-one".into(),
            },
            &engine(),
            &Ports::default(),
            &pinned(),
        );
        assert_eq!(
            env.get("OPENAI_API_KEY").map(String::as_str),
            Some("sk-a-real-one")
        );
    }

    #[test]
    fn a_blank_model_key_is_left_out_rather_than_written_empty() {
        let env = compose(
            &intelligence(),
            &Model {
                openai_api_key: "   ".into(),
            },
            &engine(),
            &Ports::default(),
            &pinned(),
        );
        assert!(!env.contains_key("OPENAI_API_KEY"));
    }
}
