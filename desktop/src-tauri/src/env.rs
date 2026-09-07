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

/**
Where a signed-in ChatGPT plan's token store lives, on this machine and inside the harness.

Two paths for one file, joined by a bind mount `docker-compose.yml` declares. It has to be a file
rather than a setting because the harness's provider WRITES to it: when the access token expires it
renews and saves, and the mount is what makes that renewal outlast the container.

The host file is always written, even when nobody signed in to a plan. A bind mount whose source is
missing does not fail, it silently creates a DIRECTORY at that path, and the next real sign-in then
cannot write its file. Writing an empty store costs nothing and removes the trap.
*/
pub const CHATGPT_STORE_FILE: &str = "chatgpt-auth.json";
pub const CHATGPT_STORE_INSIDE: &str = "/root/.langchain/chatgpt-auth.json";

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
/// Blank is not a value. See the note in `compose`.
fn insert_if_given(env: &mut BTreeMap<String, String>, key: &str, value: &str) {
    if !value.trim().is_empty() {
        env.insert(key.into(), value.trim().to_string());
    }
}

pub fn compose(
    intelligence: &Intelligence,
    model: &Model,
    engine: &EngineStatus,
    ports: &Ports,
    images: &[(String, String)],
    // Absent means no harness was picked, and the package's gated rows stay dropped.
    harness: Option<&PickedHarness>,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();

    /*
     * Only the keys the choice actually implies, and never a blank one: written empty, Compose
     * passes an empty string and the Bot's refusal becomes a confusing one about a key that is set
     * and useless.
     *
     * THE CLAUDE PLAN DELIBERATELY WRITES NO `ANTHROPIC_API_KEY`. The SDK prefers the key over the
     * OAuth token, so a stale key from an earlier attempt would quietly bill a person who just
     * signed in to a plan. Since `write` below preserves lines it does not own, the key is written
     * as empty here rather than omitted: omitting it would leave an older one in place, which is
     * the same failure by a different route.
     */
    /*
     * Every model key, every time, and empty unless the choice implies it.
     *
     * Clearing only the one key a given arm conflicts with left the others stale, and `write` below
     * preserves lines it does not own, so switching from a key to a plan kept the old key in the
     * file and handed it to every harness. Measured: a run that signed in to a Claude plan still
     * carried the OPENAI_API_KEY from the run before it. Whichever key a harness reads first then
     * decides what the person is billed for, which is the failure the plan path exists to avoid.
     *
     * Written empty rather than omitted, for the same reason: omitting leaves the old line in place.
     */
    if model.credential != ModelCredential::None {
        for key in [
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CHATGPT_AUTH_FILE",
        ] {
            env.insert(key.into(), String::new());
        }
    }
    match &model.credential {
        /*
         * Nothing chosen touches nothing, deliberately.
         *
         * The clearing above is for the case where the model screen HAS answered: whichever keys
         * that answer does not imply are emptied, so switching from a key to a plan cannot leave
         * the old key behind for a harness to prefer. With no answer there is nothing to be
         * consistent with, and a key somebody set by hand is theirs to keep — see `write`, which
         * preserves lines this does not own.
         */
        ModelCredential::None => {}
        ModelCredential::OpenAi { api_key } => {
            insert_if_given(&mut env, "OPENAI_API_KEY", api_key);
        }
        ModelCredential::Anthropic { api_key } => {
            insert_if_given(&mut env, "ANTHROPIC_API_KEY", api_key);
        }
        ModelCredential::ClaudePlan { token } => {
            insert_if_given(&mut env, "CLAUDE_CODE_OAUTH_TOKEN", token);
        }
        /*
         * A path, not the credential. The store itself goes to a file beside this one, because the
         * harness's provider does not merely read it: it writes the renewed tokens back. Through a
         * bind mount that renewal lands on this machine and survives the container; carried as an
         * environment variable it would be lost on every restart, and the refresh token it replaced
         * would already have been spent.
         */
        ModelCredential::ChatGptPlan { store } => {
            if !store.trim().is_empty() {
                env.insert("CHATGPT_AUTH_FILE".into(), CHATGPT_STORE_INSIDE.into());
            }
        }
        ModelCredential::Compatible {
            base_url,
            api_key,
            model: name,
        } => {
            insert_if_given(&mut env, "OPENAI_API_KEY", api_key);
            insert_if_given(&mut env, "OPENAI_BASE_URL", base_url);
            insert_if_given(&mut env, "BOT_MODEL", name);
        }
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

    /*
     * The picked harness, if there is one.
     *
     * Addressed on loopback rather than by a compose service name, because the server is a host
     * process here and not a container: it reaches `agent-bot` and `agent-langgraph` the same way,
     * over the port those services publish.
     *
     * One address and one kind. The package's single row drops itself while the address is blank,
     * so a deployment that picked nothing registers nothing.
     */
    if let Some(picked) = harness {
        env.insert("PICKED_HARNESS_IMAGE".into(), picked.image.clone());
        env.insert("PICKED_HARNESS_PORT".into(), picked.port.to_string());
        env.insert("PICKED_HARNESS_NAME".into(), picked.name.clone());
        env.insert(
            "PICKED_HARNESS_URL".into(),
            format!("http://127.0.0.1:{}", picked.port),
        );
        /*
         * The kind, as the package spells it.
         *
         * Interpolated rather than written as a literal row per kind, because the loader refuses an
         * unknown `agent.type` by refusing the whole file: a package carrying a literal
         * `remote-mastra` row stops any server predating that kind from starting at all, picked or
         * not. Measured, not guessed — it is what a v0.0.8 deployment did.
         */
        env.insert(
            "PICKED_HARNESS_KIND".into(),
            if picked.mastra {
                "remote-mastra".to_string()
            } else {
                "remote-ag-ui".to_string()
            },
        );
        insert_if_given(&mut env, "PICKED_HARNESS_AGENT_ID", &picked.remote_agent_id);
    }

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

/**
The harness somebody picked, as the deployment has to describe it.

Registration is not an API call in this product: Bots come from the tenant package, whose
`agents.yaml` interpolates `${...}` and drops any Bot whose endpoint comes out blank. So a picked
harness becomes these settings, the package's own gated row materialises, and seeding registers it.
Nothing new had to be built to make a Bot appear.

`None` is a deployment that has not picked one, which writes nothing and leaves those rows dropped.
*/
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PickedHarness {
    /// The published image, e.g. `openbot-agent-crewai`. Named by the release, not derived.
    pub image: String,
    /// The port that image listens on, fixed by its own Dockerfile.
    pub port: u16,
    /// What the Bot is called on screen.
    pub name: String,
    /// How it is dialled. A Mastra server has no AG-UI route of its own.
    pub mastra: bool,
    /// Which agent on that server, for a Mastra roster. Empty means the only one there.
    pub remote_agent_id: String,
}

/// The model credential, which belongs to the provider and not to the harness.
///
/// Both Bots the deployment ships refuse to start without one, saying so plainly: "This Bot cannot
/// answer without a model." Which provider is the person's own screen, and no harness constrains
/// it: see `provider::catalogue`.
#[derive(Clone, Debug, Default)]
pub struct Model {
    pub credential: ModelCredential,
}

/// How this deployment reaches a model.
///
/// One type rather than a bag of optional strings, because the combinations that must never be
/// written are the whole point. `ANTHROPIC_API_KEY` takes precedence over the plan's OAuth token in
/// the Claude Agent SDK, so writing both silently bills a person who signed in to a plan they
/// already pay for. Two fields cannot express "never both"; a choice can.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ModelCredential {
    /// Nothing chosen. Written as nothing at all rather than as empty strings: an empty key set is
    /// a key that is present and useless, and the Bot's refusal then names a key it can see.
    #[default]
    None,
    /// A key typed for OpenAI.
    OpenAi { api_key: String },
    /// A key typed for Anthropic.
    Anthropic { api_key: String },
    /// A Claude plan, signed in to. The token is minted by `claude setup-token` and never typed.
    ClaudePlan { token: String },
    /**
    A ChatGPT plan, signed in to.

    NOT the compatible shape below, and that distinction is load-bearing. A plan token is a bearer
    for `https://chatgpt.com/backend-api/codex`, and `langchain-openai` PINS that address and
    refuses a caller-supplied one, deliberately, so a token cannot be aimed at somebody else's
    server and handed over. Writing this as `OPENAI_BASE_URL` plus a key would be us hand-rolling
    the thing the library exists to prevent, and the Codex path also shapes its requests
    differently, so it would not have worked anyway.

    THE WHOLE STORE, NOT THE ACCESS TOKEN. The token in it lasts under an hour and nothing can
    renew it; the refresh token beside it is what keeps the Bot answering tomorrow. Carrying one
    field would produce a Bot that works this morning and fails this afternoon with an auth error,
    which is the hardest kind of fault for somebody to report.

    The harness picks its model class from the presence of this store. See the harness note in the
    build doc.
    */
    ChatGptPlan { store: String },
    /// Anything that speaks the OpenAI wire format, at an address the person gave.
    ///
    /// Also where a signed-in ChatGPT plan lands, because that login yields a token and the address
    /// to send it to, which is this shape and not a special case.
    Compatible {
        base_url: String,
        api_key: String,
        model: String,
    },
}

/// Write the file, replacing only what this owns.
///
/// Lines the shell did not write are kept: somebody who added `OPENAI_API_KEY` by hand, or a
/// setting a later version of this app does not know about, should not lose it because the stack
/// was restarted.
/**
What a previous run already put in the `.env`.

So the wizard never asks twice. A person who has set this up before, or whose IT department laid the
file down for them, should not be made to find a key again — and "find it again" in practice means
opening a dotfile in a text editor, which is the exact thing this product exists not to require.

Only the settings the wizard asks about are read back. Everything else in that file is somebody
else's, and this has no business handing it to a window.
*/
pub fn already_set(path: &Path, keys: &[&str]) -> BTreeMap<String, String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let mut found = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        // Blank is not a value: the writer clears keys a choice does not imply, and offering those
        // back as though somebody had set them would undo that.
        if keys.contains(&key) && !value.is_empty() {
            found.insert(key.to_string(), value.to_string());
        }
    }
    found
}

/**
Lay down the token store a signed-in ChatGPT plan reads from, beside the `.env`.

Always written, and see `CHATGPT_STORE_FILE` for why: an absent source turns the mount into a
directory. Answering the model screen with anything else clears it, on the same reasoning as the
keys the writer empties. A plan that was signed out of should not leave a credential on disk for a
later run to pick up.

Not called when the screen was not answered at all, which is the one case that must not disturb what
is already there.
*/
pub fn write_plan_store(dir: &Path, credential: &ModelCredential) -> std::io::Result<()> {
    let store = match credential {
        ModelCredential::ChatGptPlan { store } if !store.trim().is_empty() => store.trim(),
        _ => "{}",
    };
    let path = dir.join(CHATGPT_STORE_FILE);
    std::fs::write(&path, format!("{store}\n"))?;
    /*
     * Owner-only, because this IS the credential. `.env` beside it holds keys and gets whatever
     * umask the machine has; this one is not left to that, since a refresh token is a standing
     * grant rather than a value somebody can rotate from a dashboard they already have open.
     */
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

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
            None,
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
            None,
        );
        let b = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
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
            None,
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
            None,
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
            None,
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
            None,
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
            None,
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
            None,
        );
        assert!(!without.contains_key("ENGINE_SOCKET"));

        let with = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(Some("/run/user/501/podman/podman.sock")),
            &Ports::default(),
            &pinned(),
            None,
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
            None,
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
            None,
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
            None,
        );
        write(&path, &first).unwrap();
        let second = compose(
            &intelligence(),
            &Model::default(),
            &engine_status(None),
            &Ports::default(),
            &pinned(),
            None,
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
            None,
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
                credential: ModelCredential::OpenAi {
                    api_key: "sk-a-real-one".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
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
                credential: ModelCredential::OpenAi {
                    api_key: "   ".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
        );
        assert_eq!(env.get("OPENAI_API_KEY"), Some(&String::new()));
    }

    /// The must-not case, and the reason `ModelCredential` is a choice rather than two fields.
    ///
    /// `ANTHROPIC_API_KEY` wins over the plan's OAuth token in the Claude Agent SDK, so a stack
    /// carrying both bills a person who signed in to a plan they already pay for. The key is
    /// written EMPTY rather than left out, because `write` preserves lines it does not own and an
    /// older key would otherwise survive.
    #[test]
    fn a_claude_plan_never_leaves_an_anthropic_key_in_place() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::ClaudePlan {
                    token: "oauth-token".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
        );
        assert_eq!(
            env.get("CLAUDE_CODE_OAUTH_TOKEN"),
            Some(&"oauth-token".to_string())
        );
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&String::new()));
    }

    /// The kind is written the way the package spells it, and the address is the image's own port
    /// on loopback because the server is a host process rather than a container.
    ///
    /// The kind matters beyond correctness: a package carrying a literal `remote-mastra` row stops
    /// any server predating that kind from starting at all, since the loader refuses an unknown
    /// `agent.type` by refusing the whole file.
    #[test]
    fn a_picked_harness_is_addressed_once_and_named_as_a_kind() {
        for (mastra, expected) in [(false, "remote-ag-ui"), (true, "remote-mastra")] {
            let env = compose(
                &intelligence(),
                &Model::default(),
                &engine(),
                &Ports::default(),
                &pinned(),
                Some(&PickedHarness {
                    image: "openbot-agent-crewai".into(),
                    port: 4202,
                    name: "CrewAI".into(),
                    mastra,
                    remote_agent_id: String::new(),
                }),
            );
            assert_eq!(
                env.get("PICKED_HARNESS_KIND").map(String::as_str),
                Some(expected)
            );
            assert_eq!(
                env.get("PICKED_HARNESS_URL").map(String::as_str),
                Some("http://127.0.0.1:4202")
            );
        }
    }

    /// Nothing picked writes none of it, so the package's gated rows stay dropped.
    #[test]
    fn no_harness_picked_writes_no_harness_settings() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
        );
        for key in [
            "PICKED_HARNESS_IMAGE",
            "PICKED_HARNESS_PORT",
            "PICKED_HARNESS_URL",
            "PICKED_HARNESS_KIND",
        ] {
            assert!(
                !env.contains_key(key),
                "{key} was written with nothing picked"
            );
        }
    }

    /// The must-not case for the other plan. A ChatGPT plan token is not an OpenAI key and is not
    /// aimed with a base URL: the library pins the Codex address precisely so a token cannot be
    /// pointed at somebody else's server, and a leftover key would outrank the plan.
    #[test]
    fn a_chatgpt_plan_writes_no_key_and_aims_at_nothing() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::ChatGptPlan {
                    store: "{\"access_token\":\"a\",\"refresh_token\":\"r\"}".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
        );
        assert_eq!(
            env.get("CHATGPT_AUTH_FILE"),
            Some(&CHATGPT_STORE_INSIDE.to_string())
        );
        assert_eq!(env.get("OPENAI_API_KEY"), Some(&String::new()));
        assert_eq!(env.get("OPENAI_BASE_URL"), Some(&String::new()));
    }

    /// THE CREDENTIAL ITSELF NEVER REACHES THE `.env`, only the path of the file holding it.
    ///
    /// Worth asserting rather than assuming: the `.env` is the file a person is most likely to open
    /// or paste, and a refresh token in it is a standing grant on somebody's ChatGPT subscription.
    #[test]
    fn the_plan_store_is_not_written_into_the_env() {
        let secret = "refresh-token-that-must-not-appear";
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::ChatGptPlan {
                    store: format!("{{\"refresh_token\":\"{secret}\"}}"),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
        );
        assert!(
            !env.values().any(|value| value.contains(secret)),
            "the plan's store reached the .env"
        );
    }

    /// The file is laid down even with no plan, because a missing mount source becomes a directory.
    #[test]
    fn the_store_file_is_written_whatever_the_choice() {
        let dir = std::env::temp_dir().join(format!("openbot-store-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        write_plan_store(
            &dir,
            &ModelCredential::OpenAi {
                api_key: "sk-x".into(),
            },
        )
        .unwrap();
        let path = dir.join(CHATGPT_STORE_FILE);
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), "{}");

        write_plan_store(
            &dir,
            &ModelCredential::ChatGptPlan {
                store: "{\"refresh_token\":\"r\"}".into(),
            },
        )
        .unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("\"r\""));

        // And signing out of the plan clears it, on the same reasoning as the keys that get emptied.
        write_plan_store(&dir, &ModelCredential::None).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), "{}");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "the store was readable by others");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Switching provider does not leave the last one's key behind.
    ///
    /// Measured, not imagined: a run that signed in to a Claude plan still carried the
    /// OPENAI_API_KEY written by the run before it, and every harness was handed both. Whichever a
    /// harness reads first then decides what the person is billed for, which is the whole thing the
    /// plan path exists to avoid.
    #[test]
    fn answering_the_model_screen_clears_the_keys_it_does_not_imply() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::ClaudePlan {
                    token: "oauth-token".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
        );
        assert_eq!(
            env.get("CLAUDE_CODE_OAUTH_TOKEN"),
            Some(&"oauth-token".to_string())
        );
        for cleared in ["OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY"] {
            assert_eq!(
                env.get(cleared),
                Some(&String::new()),
                "{cleared} survived a switch to a Claude plan"
            );
        }
    }

    /// An Anthropic key is written as one, and does not become an OpenAI key because that is the
    /// field this struct used to have.
    #[test]
    fn an_anthropic_key_is_an_anthropic_key() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::Anthropic {
                    api_key: "sk-ant-real".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
        );
        assert_eq!(
            env.get("ANTHROPIC_API_KEY"),
            Some(&"sk-ant-real".to_string())
        );
        assert_eq!(env.get("OPENAI_API_KEY"), Some(&String::new()));
    }

    /// The everything-else row writes all three, since an endpoint without a model name is an
    /// endpoint that answers with a complaint about a model nobody chose.
    #[test]
    fn a_compatible_endpoint_carries_its_address_and_its_model() {
        let env = compose(
            &intelligence(),
            &Model {
                credential: ModelCredential::Compatible {
                    base_url: "https://example.test/v1".into(),
                    api_key: "sk-whatever".into(),
                    model: "some-model".into(),
                },
            },
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
        );
        assert_eq!(
            env.get("OPENAI_BASE_URL"),
            Some(&"https://example.test/v1".to_string())
        );
        assert_eq!(env.get("BOT_MODEL"), Some(&"some-model".to_string()));
        assert_eq!(env.get("OPENAI_API_KEY"), Some(&"sk-whatever".to_string()));
        // Nothing about Anthropic is implied by choosing an OpenAI-compatible endpoint.
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&String::new()));
    }

    /// Nothing chosen writes no model keys at all, rather than empty ones.
    #[test]
    fn no_choice_writes_no_model_keys() {
        let env = compose(
            &intelligence(),
            &Model::default(),
            &engine(),
            &Ports::default(),
            &pinned(),
            None,
        );
        // Untouched, not cleared: a key somebody set by hand is theirs to keep while the model
        // screen has not answered. See the note in `compose`.
        for key in [
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CHATGPT_AUTH_FILE",
        ] {
            assert!(
                !env.contains_key(key),
                "{key} was written with no choice made"
            );
        }
    }

    /// The wizard does not ask twice for something already in the file.
    #[test]
    fn what_is_already_set_is_read_back() {
        let dir = std::env::temp_dir().join(format!("openbot-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(
            &path,
            "# a comment\nINTELLIGENCE_API_KEY=already-here\nINTELLIGENCE_API_URL=\nSOMETHING_ELSE=theirs\n",
        )
        .unwrap();

        let found = already_set(
            &path,
            &[
                "INTELLIGENCE_API_KEY",
                "INTELLIGENCE_API_URL",
                "SOMETHING_ELSE",
            ],
        );
        assert_eq!(
            found.get("INTELLIGENCE_API_KEY").map(String::as_str),
            Some("already-here")
        );
        // Blank is not a value: the writer clears keys a choice does not imply, and handing those
        // back would undo that.
        assert!(!found.contains_key("INTELLIGENCE_API_URL"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Only what the wizard asks about. The rest of that file is somebody else's.
    #[test]
    fn nothing_the_wizard_did_not_ask_for_is_read_back() {
        let dir = std::env::temp_dir().join(format!("openbot-read2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(&path, "PRIVATE_THING=not-yours\nINTELLIGENCE_API_KEY=k\n").unwrap();
        let found = already_set(&path, &["INTELLIGENCE_API_KEY"]);
        assert_eq!(found.len(), 1);
        assert!(!found.contains_key("PRIVATE_THING"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// No file is not an error; it is a first run.
    #[test]
    fn a_missing_file_reads_back_nothing() {
        let found = already_set(Path::new("/nowhere/at/all/.env"), &["INTELLIGENCE_API_KEY"]);
        assert!(found.is_empty());
    }
}
