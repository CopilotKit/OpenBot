/*!
The model local Intelligence's Learning agent thinks with, from the model the person signed in to.

Learning and skills are on for every personal Bot, and the Learning agent runs in the local cluster
the bundled CLI made, so it needs a model of its own. It gets the person's, in this order:

1. **Their own API key.** Signed in with an OpenAI or an Anthropic key, Learning is given that key,
   on Intelligence's own default model for the provider (`DEFAULT_OPENAI_MODEL` and
   `DEFAULT_ANTHROPIC_MODEL`, Intelligence `libs/learning-agent/src/model-selection.ts`).
2. **Their plan, through OpenBot.** Signed in with a Claude or ChatGPT plan, there is no key to give.
   Learning is pointed at the OpenBot server's Learning endpoint
   (`server/src/learning/model-endpoint.ts`), which answers each call on the plan's own harness, the
   way the Bots are answered. The key Learning sends there is a secret minted once per installation
   ([`TOKEN`]) and given to the server and the Learning agent alone.

Anything else (a Google or xAI sign-in, an endpoint of their own) has neither, and Learning is left
without a model. The server says why on Settings, Learning ([`UNAVAILABLE`]).

There is no CopilotKit key behind any of this. Nobody gets a model through CopilotKit.

The choice reaches the agent through the CLI, which owns the cluster: `local setup --model-config`
on the stack that is already running changes the Learning agent alone, and the same choice changes
nothing (Intelligence `apps/cli/src/services/local-setup.ts`). The file is the CLI's own shape
(`apps/cli/src/services/local-inputs.ts`), and the CLI turns it into `LEARNING_AGENT_MODEL`, the
provider key or `LEARNING_AGENT_MODEL_BASE_URL` and `LEARNING_AGENT_MODEL_API_KEY`, and the limits
(`apps/cli/src/services/local-values.ts`).

THE PLAN ENDPOINT IS GIVEN BY NUMBER, the IPv4 address the engine gives containers for this machine
(`host.docker.internal` inside OpenBot's own `server` container, see `stack::host_gateway_ipv4`).
Inside the cluster, 127.0.0.1 is the pod. Given a loopback address, the CLI swaps in
`host.k3d.internal` (`localModelEndpoint` in `local-values.ts`), and that name does not survive a
restart: k3s rewrites CoreDNS's NodeHosts every time the cluster starts and drops the entry k3d
added (k3d-io/k3d#1221), and OpenBot starts the cluster on every Start. Measured on Docker Desktop:
every Learning call then failed with "Connection error.". The CLI passes any other address through
as written, and the engine's address for this machine does not depend on the cluster's DNS: Docker
Desktop's is 192.168.65.254, a Podman machine's the address `acquire` configures (192.168.127.254),
and both lead to this machine's loopback, where the server's port is published.
*/

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::env::ModelCredential;

/// The secret the Learning agent proves itself to the server's Learning endpoint with. Minted once
/// per installation, like the other tokens in `env::MINTED`.
pub const TOKEN: &str = "LEARNING_MODEL_TOKEN";

/// The setting that tells the server why Learning has no model, so Settings can say so.
pub const UNAVAILABLE: &str = "OPENBOT_LEARNING_MODEL_UNAVAILABLE";

/// Where the server answers Learning, under its own port.
pub const ENDPOINT_PATH: &str = "/api/learning-model/v1";

/// Intelligence's own defaults for a key, both in the model catalogue the agent runs on.
pub const OPENAI_MODEL: &str = "openai/gpt-5.5";
pub const ANTHROPIC_MODEL: &str = "anthropic/claude-haiku-4-5";

/// The model names Learning records for a plan. The plan's harness answers on the model the plan
/// offers, the way it answers a Bot that names none.
pub const CHATGPT_PLAN_MODEL: &str = "openbot/chatgpt-plan";
pub const CLAUDE_PLAN_MODEL: &str = "openbot/claude-plan";

/**
The limits of a plan's model, which the agent cannot look up for a name outside its catalogue.

ChatGPT: every ChatGPT-plan model in the catalogue the agent runs on but the newest has a 272,000
token window and a 128,000 token reply (`@earendil-works/pi-ai` 1.4.0, `openai-codex.json`).
Claude: the plan's harness answers on a 200,000 token window at the least
(`agent-claude-sdk/src/replay.py`), and the 200,000 token Claude models reply in up to 64,000
(the same catalogue, `anthropic.json`).
*/
const CHATGPT_PLAN_LIMITS: (u32, u32) = (272_000, 128_000);
const CLAUDE_PLAN_LIMITS: (u32, u32) = (200_000, 64_000);

/// Why Learning has no model, as the server's setting says it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unavailable {
    /// A sign-in Learning can use neither as a key nor through a plan.
    Unsupported,
}

impl Unavailable {
    pub fn as_str(self) -> &'static str {
        match self {
            Unavailable::Unsupported => "unsupported",
        }
    }
}

/// What this Start does to the Learning agent's model.
#[derive(Clone, Debug, PartialEq)]
pub enum Learning {
    /// Nothing was chosen on the model screen, so nothing changes. A model somebody set by hand is
    /// theirs to keep, as `env::compose` keeps a key set by hand.
    Keep,
    /// The CLI's `--model-config` file, as JSON.
    Model(Value),
    /// No model, and any model an earlier sign-in gave it taken away. Left in place, a key the
    /// person moved away from would go on paying for Learning.
    Without(Unavailable),
}

/// Whether this sign-in reaches Learning through the server, and so needs its address.
pub fn through_openbot(credential: &ModelCredential) -> bool {
    matches!(
        credential,
        ModelCredential::ChatGptPlan { .. } | ModelCredential::ClaudePlan { .. }
    )
}

/**
The Learning agent's model for this sign-in. `server` is where the cluster reaches OpenBot's server:
this machine's address as the engine gives it to containers, and the server's port on this machine.
*/
pub fn for_credential(
    credential: &ModelCredential,
    server: std::net::SocketAddrV4,
    token: &str,
) -> Learning {
    let plan = |model: &str, (context, output): (u32, u32)| {
        Learning::Model(json!({
            "model": model,
            "baseUrl": format!("http://{server}{ENDPOINT_PATH}"),
            "apiKey": token,
            "contextWindow": context,
            "maxTokens": output,
        }))
    };
    let key = |model: &str, api_key: &str| match api_key.trim() {
        "" => Learning::Without(Unavailable::Unsupported),
        key => Learning::Model(json!({ "model": model, "apiKey": key })),
    };
    match credential {
        ModelCredential::None => Learning::Keep,
        ModelCredential::OpenAi { api_key } => key(OPENAI_MODEL, api_key),
        ModelCredential::Anthropic { api_key } => key(ANTHROPIC_MODEL, api_key),
        ModelCredential::ChatGptPlan { .. } => plan(CHATGPT_PLAN_MODEL, CHATGPT_PLAN_LIMITS),
        ModelCredential::ClaudePlan { .. } => plan(CLAUDE_PLAN_MODEL, CLAUDE_PLAN_LIMITS),
        ModelCredential::ProviderOAuth { .. } | ModelCredential::Compatible { .. } => {
            Learning::Without(Unavailable::Unsupported)
        }
    }
}

/// The server's setting for this sign-in: the reason, or empty. None leaves the file alone.
pub fn unavailable_setting(credential: &ModelCredential) -> Option<&'static str> {
    match for_credential(
        credential,
        std::net::SocketAddrV4::new(std::net::Ipv4Addr::UNSPECIFIED, 0),
        "",
    ) {
        Learning::Keep => None,
        Learning::Model(_) => Some(""),
        Learning::Without(why) => Some(why.as_str()),
    }
}

/**
This machine's IPv4 address in `getent ahostsv4 host.docker.internal` output, as the engine gives it
to containers: the first address on a line, if it is one a container can dial. Loopback and the
unspecified address would be the pod or nothing at all.
*/
pub fn host_gateway_in(getent: &str) -> Option<std::net::Ipv4Addr> {
    getent
        .lines()
        .filter_map(|line| line.split_whitespace().next()?.parse().ok())
        .find(|ip: &std::net::Ipv4Addr| {
            !ip.is_loopback() && !ip.is_unspecified() && !ip.is_broadcast()
        })
}

/// The folder the model file is handed over in, beside the installation's other handoffs.
const HANDOFF: &str = ".openbot-learning";
const HANDOFF_FILE: &str = "model.json";

/**
Hand `learning` to the CLI: `configure` runs `local setup` with the file's path, or with `None` to
take the model away. The file holds a key, so it is written in a folder only this account can read,
and the folder is gone again before this returns, whatever the CLI did.
*/
pub fn give<T, E>(
    root: &Path,
    learning: &Learning,
    configure: impl FnOnce(Option<&Path>) -> Result<T, E>,
) -> Result<Option<T>, GiveError<E>> {
    let config = match learning {
        Learning::Keep => return Ok(None),
        Learning::Without(_) => return configure(None).map(Some).map_err(GiveError::Cli),
        Learning::Model(config) => config,
    };
    let folder = root.join(HANDOFF);
    // One an interrupted Start left behind may hold a key; it never outlives a retry.
    match std::fs::remove_dir_all(&folder) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(GiveError::Handoff),
    }
    let written = write_private(&folder, config);
    let result = match written {
        Ok(file) => configure(Some(&file)).map(Some).map_err(GiveError::Cli),
        Err(()) => Err(GiveError::Handoff),
    };
    let _ = std::fs::remove_dir_all(&folder);
    result
}

/// Why the model was not handed over.
#[derive(Debug, PartialEq, Eq)]
pub enum GiveError<E> {
    /// The private file could not be written.
    Handoff,
    /// The CLI did not take it.
    Cli(E),
}

fn write_private(folder: &Path, config: &Value) -> Result<PathBuf, ()> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(folder).map_err(|_| ())?;
    let file = folder.join(HANDOFF_FILE);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut handle = options.open(&file).map_err(|_| ())?;
    use std::io::Write;
    handle
        .write_all(config.to_string().as_bytes())
        .and_then(|()| handle.sync_all())
        .map_err(|_| ())?;
    Ok(file)
}

/// What giving the Learning agent its model came to, for the log. Never a key or a CLI word.
#[derive(Debug, PartialEq, Eq)]
pub enum Given {
    /// Nothing to do: nothing chosen, or no stack OpenBot made for this installation.
    Nothing,
    /// The stack was not running and ready. A setup there would install all of it again, so it
    /// waits for the next Start.
    NotReady,
    Given,
    /// The CLI answered, but not completed.
    Refused(crate::local_eval::Outcome),
    /// The address the cluster reaches this machine at could not be found, so a plan's endpoint
    /// could not be given. Never a name the cluster may not resolve in its place.
    NoAddress,
    Failed(String),
}

/**
Give the Learning agent of the stack OpenBot made for `root` the model for `credential`.

Only a stack OpenBot made: one that was already there serves other apps, and their Learning is not
this sign-in's to change. Only once `status` says it is running and ready, because there the CLI
changes the Learning agent alone.
*/
pub fn apply(
    root: &Path,
    credential: &ModelCredential,
    server_port: u16,
    token: &str,
    host: impl FnOnce() -> Option<std::net::Ipv4Addr>,
    status: impl FnOnce(
        &crate::local_eval::StackId,
    ) -> Result<crate::local_eval::Report, crate::local_eval::Failure>,
    configure: impl FnOnce(
        Option<&Path>,
    ) -> Result<crate::local_eval::Report, crate::local_eval::Failure>,
) -> Given {
    use crate::local_eval::{Outcome, Readiness};
    if *credential == ModelCredential::None {
        return Given::Nothing;
    }
    let Some(state) =
        crate::local_eval_state::read(root, None).filter(|state| state.tied_to_openbot())
    else {
        return Given::Nothing;
    };
    match status(&state.stack_id()) {
        Ok(report) if report.readiness == Readiness::Ready => {}
        Ok(_) => return Given::NotReady,
        Err(failure) => return Given::Failed(format!("{failure:?}")),
    }
    let address = if through_openbot(credential) {
        match host() {
            Some(ip) => ip,
            None => return Given::NoAddress,
        }
    } else {
        std::net::Ipv4Addr::UNSPECIFIED
    };
    let learning = for_credential(
        credential,
        std::net::SocketAddrV4::new(address, server_port),
        token,
    );
    match give(root, &learning, configure) {
        Ok(None) => Given::Nothing,
        Ok(Some(report)) if report.outcome == Outcome::Completed => Given::Given,
        Ok(Some(report)) => Given::Refused(report.outcome),
        Err(GiveError::Handoff) => Given::Failed("the model file could not be written".into()),
        Err(GiveError::Cli(failure)) => Given::Failed(format!("{failure:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN_VALUE: &str = "per-install-learning-secret";
    /// Docker Desktop's address for this machine, as `getent` answered inside a container there.
    const DOCKER_DESKTOP_HOST: std::net::Ipv4Addr = std::net::Ipv4Addr::new(192, 168, 65, 254);
    const DOCKER_DESKTOP_SERVER: std::net::SocketAddrV4 =
        std::net::SocketAddrV4::new(DOCKER_DESKTOP_HOST, 3011);

    fn config(credential: ModelCredential) -> Learning {
        for_credential(&credential, DOCKER_DESKTOP_SERVER, TOKEN_VALUE)
    }

    /// Each sign-in, and the file the CLI is given for it, exactly: the CLI refuses any field it
    /// does not know (`local-inputs.ts` is `.strict()`), and needs the key beside a native model.
    #[test]
    fn an_openai_key_is_given_to_learning_on_intelligences_default_model() {
        assert_eq!(
            config(ModelCredential::OpenAi {
                api_key: " sk-person \n".into()
            }),
            Learning::Model(json!({ "model": "openai/gpt-5.5", "apiKey": "sk-person" }))
        );
    }

    #[test]
    fn an_anthropic_key_is_given_to_learning_on_intelligences_default_model() {
        assert_eq!(
            config(ModelCredential::Anthropic {
                api_key: "sk-ant-person".into()
            }),
            Learning::Model(json!({
                "model": "anthropic/claude-haiku-4-5",
                "apiKey": "sk-ant-person"
            }))
        );
    }

    #[test]
    fn a_chatgpt_plan_points_learning_at_openbot_with_the_installation_secret() {
        assert_eq!(
            config(ModelCredential::ChatGptPlan {
                store: "{\"access_token\":\"plan-token\"}".into()
            }),
            Learning::Model(json!({
                "model": "openbot/chatgpt-plan",
                "baseUrl": "http://192.168.65.254:3011/api/learning-model/v1",
                "apiKey": TOKEN_VALUE,
                "contextWindow": 272_000,
                "maxTokens": 128_000
            }))
        );
    }

    #[test]
    fn a_claude_plan_points_learning_at_openbot_and_never_hands_over_the_plan_token() {
        let learning = config(ModelCredential::ClaudePlan {
            token: "sk-ant-oat01-plan-token".into(),
        });
        assert_eq!(
            learning,
            Learning::Model(json!({
                "model": "openbot/claude-plan",
                "baseUrl": "http://192.168.65.254:3011/api/learning-model/v1",
                "apiKey": TOKEN_VALUE,
                "contextWindow": 200_000,
                "maxTokens": 64_000
            }))
        );
        let Learning::Model(file) = learning else {
            unreachable!()
        };
        assert!(!file.to_string().contains("plan-token"));
    }

    #[test]
    fn nothing_chosen_keeps_learning_as_it_is_and_other_sign_ins_take_its_model_away() {
        assert_eq!(config(ModelCredential::None), Learning::Keep);
        assert_eq!(unavailable_setting(&ModelCredential::None), None);
        for credential in [
            ModelCredential::ProviderOAuth {
                provider: "google".into(),
                path: "/x/.openbot/model-oauth.json".into(),
                proxy_token: "proxy".into(),
                model: "gemini-3-pro".into(),
            },
            ModelCredential::Compatible {
                base_url: "http://127.0.0.1:11434/v1".into(),
                container_base_url: None,
                api_key: String::new(),
                model: "llama".into(),
            },
            ModelCredential::OpenAi {
                api_key: "  ".into(),
            },
        ] {
            assert_eq!(
                config(credential.clone()),
                Learning::Without(Unavailable::Unsupported)
            );
            assert_eq!(unavailable_setting(&credential), Some("unsupported"));
        }
        assert_eq!(
            unavailable_setting(&ModelCredential::ClaudePlan { token: "t".into() }),
            Some("")
        );
    }

    #[test]
    fn the_file_is_private_while_the_cli_reads_it_and_gone_after() {
        let root = crate::test_support::temp_root("learning-model");
        std::fs::create_dir_all(&root).unwrap();
        let learning = config(ModelCredential::OpenAi {
            api_key: "sk-person".into(),
        });
        let seen = give(&root, &learning, |file| {
            let file = file.expect("a model is handed over as a file");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(file).unwrap().permissions().mode();
                assert_eq!(mode & 0o077, 0, "another account could read the key");
                let folder = std::fs::metadata(file.parent().unwrap()).unwrap();
                assert_eq!(folder.permissions().mode() & 0o077, 0);
            }
            let written: Value =
                serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
            Ok::<_, ()>(written)
        })
        .unwrap();
        assert_eq!(
            seen,
            Some(json!({ "model": "openai/gpt-5.5", "apiKey": "sk-person" }))
        );
        assert!(!root.join(HANDOFF).exists());

        // A failed CLI call leaves nothing behind either.
        assert_eq!(
            give(&root, &learning, |_| Err::<(), _>("refused")),
            Err(GiveError::Cli("refused"))
        );
        assert!(!root.join(HANDOFF).exists());
        std::fs::remove_dir_all(&root).ok();
    }

    fn report(readiness: crate::local_eval::Readiness) -> crate::local_eval::Report {
        crate::local_eval::Report {
            outcome: crate::local_eval::Outcome::Completed,
            stack: None,
            reason: None,
            readiness,
            licence: crate::local_eval::Licence::Valid,
            licence_expires_at: None,
            update_to: None,
            checks_passed: readiness == crate::local_eval::Readiness::Ready,
            shortfall: None,
        }
    }

    fn recorded(label: &str, ownership: crate::local_eval_state::Ownership) -> PathBuf {
        let root = crate::test_support::temp_root(label);
        std::fs::create_dir_all(&root).unwrap();
        crate::local_eval_state::begin(
            &root,
            &crate::local_eval::StackId::parse("local-abc123").unwrap(),
            ownership,
            &"a".repeat(64),
        )
        .unwrap();
        root
    }

    /// A Start on a ChatGPT plan gives the stack OpenBot made the plan's Learning file, once that
    /// stack answers ready.
    #[test]
    fn a_start_gives_the_ready_stack_openbot_made_its_learning_model() {
        use crate::local_eval::Readiness;
        let root = recorded(
            "learning-apply",
            crate::local_eval_state::Ownership::Created,
        );
        let plan = ModelCredential::ChatGptPlan { store: "{}".into() };
        let mut handed = None;
        let given = apply(
            &root,
            &plan,
            3011,
            TOKEN_VALUE,
            || Some(DOCKER_DESKTOP_HOST),
            |stack| {
                assert_eq!(stack.as_str(), "local-abc123");
                Ok(report(Readiness::Ready))
            },
            |file| {
                let file = file.expect("a plan is handed over as a file");
                handed = Some(std::fs::read_to_string(file).unwrap());
                Ok(report(Readiness::Ready))
            },
        );
        assert_eq!(given, Given::Given);
        let handed: Value = serde_json::from_str(&handed.unwrap()).unwrap();
        assert_eq!(handed["apiKey"], TOKEN_VALUE);
        assert_eq!(
            handed["baseUrl"],
            "http://192.168.65.254:3011/api/learning-model/v1"
        );

        // No address for this machine: no endpoint is given, rather than a name the cluster may not
        // resolve.
        let given = apply(
            &root,
            &plan,
            3011,
            TOKEN_VALUE,
            || None,
            |_| Ok(report(Readiness::Ready)),
            |_| panic!("no endpoint is given without this machine's address"),
        );
        assert_eq!(given, Given::NoAddress);

        // A stack that is not ready is left for the next Start: setup there installs it all again.
        let given = apply(
            &root,
            &plan,
            3011,
            TOKEN_VALUE,
            || Some(DOCKER_DESKTOP_HOST),
            |_| Ok(report(Readiness::Stopped)),
            |_| panic!("setup must not run on a stack that is not ready"),
        );
        assert_eq!(given, Given::NotReady);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_stack_openbot_found_already_running_keeps_its_own_learning_model() {
        let root = recorded(
            "learning-shared",
            crate::local_eval_state::Ownership::Shared,
        );
        let given = apply(
            &root,
            &ModelCredential::OpenAi {
                api_key: "sk-person".into(),
            },
            3011,
            TOKEN_VALUE,
            || panic!("a shared stack is not asked"),
            |_| panic!("a shared stack is not asked"),
            |_| panic!("a shared stack is not changed"),
        );
        assert_eq!(given, Given::Nothing);
        std::fs::remove_dir_all(&root).ok();
    }

    /**
    The plan endpoint the Learning agent is given is dialled by number, so it still resolves after the
    cluster restarts.

    Measured on Docker Desktop: given `127.0.0.1`, the CLI wrote `host.k3d.internal`, which k3s drops
    from CoreDNS on every cluster start (k3d-io/k3d#1221), and every Learning call failed with
    "Connection error.". The CLI rewrites only `localhost`, `localhost.`, `[::1]`,
    `host.docker.internal` and `127.*` (`localModelEndpoint` in the pinned CLI's `local-values.ts`)
    and passes anything else through, so the host here is what the pod dials.
    */
    #[test]
    fn a_plan_endpoint_is_an_address_the_cluster_reaches_without_its_dns() {
        for credential in [
            ModelCredential::ChatGptPlan { store: "{}".into() },
            ModelCredential::ClaudePlan { token: "t".into() },
        ] {
            let Learning::Model(file) = config(credential) else {
                panic!("a plan gets a model")
            };
            let base = file["baseUrl"].as_str().unwrap();
            let host = base
                .strip_prefix("http://")
                .and_then(|rest| rest.split(':').next())
                .unwrap();
            let ip: std::net::Ipv4Addr = host.parse().expect("a number, never a name");
            assert!(!ip.is_loopback(), "{base} would be the pod itself");
            for rewritten in ["localhost", "localhost.", "[::1]", "host.docker.internal"] {
                assert_ne!(host, rewritten);
            }
        }
    }

    /// `getent ahostsv4 host.docker.internal` as it answers inside a container on Docker Desktop and
    /// on a Podman machine.
    #[test]
    fn this_machines_address_is_read_from_what_the_engine_gives_containers() {
        assert_eq!(
            host_gateway_in(
                "192.168.65.254  STREAM host.docker.internal\n192.168.65.254  DGRAM  host.docker.internal\n"
            ),
            Some(DOCKER_DESKTOP_HOST)
        );
        assert_eq!(
            host_gateway_in("192.168.127.254 STREAM host.docker.internal\n"),
            Some(std::net::Ipv4Addr::new(192, 168, 127, 254))
        );
        assert_eq!(
            host_gateway_in("127.0.0.1 STREAM host.docker.internal\n"),
            None
        );
        assert_eq!(host_gateway_in(""), None);
        assert_eq!(host_gateway_in("getent: not found"), None);
    }

    #[test]
    fn taking_the_model_away_hands_over_no_file_and_keep_runs_nothing() {
        let root = crate::test_support::temp_root("learning-model-defer");
        let mut asked = Vec::new();
        give(
            &root,
            &Learning::Without(Unavailable::Unsupported),
            |file| {
                asked.push(file.map(Path::to_path_buf));
                Ok::<_, ()>(())
            },
        )
        .unwrap();
        assert_eq!(asked, vec![None]);
        let kept = give(&root, &Learning::Keep, |_| -> Result<(), ()> {
            panic!("nothing chosen must not run the CLI")
        });
        assert_eq!(kept, Ok(None));
    }
}
