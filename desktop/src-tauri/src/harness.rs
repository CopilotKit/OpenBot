//! The harness picker's list, as data.
//!
//! One list, and every row resolves to the same thing: an AG-UI URL registered as a Bot. A row is
//! a manifest rather than a branch in wizard code, so adding a harness is an entry here plus an
//! image, and never a new screen.
//!
//! Two things this list deliberately does not contain. OpenBot's own `built-in` agent type, which
//! is a system prompt and not a harness: everybody leaves setup with a real one, either an image we
//! publish or an address they already run. And anything whose AG-UI integration we would have to
//! write ourselves. A harness earns a row only when the integration exists and somebody other than
//! us keeps it working, which is why Codex and Gemini CLI are absent despite being the two most
//! popular harnesses there are.
//!
//! Rows and maintainer classes come from the AG-UI repository's own support table, which is
//! canonical. `docs.ag-ui.com` disagrees on several and is wrong.

use serde::{Deserialize, Serialize};

/// Who keeps the AG-UI integration working.
///
/// Recorded because it is what the no-adapters rule is decided on, not because it ranks anything.
/// "Community" does not mean strangers: `integrations/claude-agent-sdk` lives in the AG-UI
/// repository and its history is largely CopilotKit's own people. It means the model vendor does
/// not maintain it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Maintainer {
    FirstParty,
    Partnership,
    Community,
}

/// What a harness needs before it can answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Credential {
    /// Any provider the model screen offers. The choice is the person's and this constrains it not
    /// at all.
    AnyProvider,
    /// Anthropic, and therefore the one row where a subscription can stand in for a key.
    ///
    /// Not because the SDK cannot reach another model: `ANTHROPIC_BASE_URL` aimed at a gateway that
    /// speaks the Anthropic Messages API runs GPT or Gemini through it perfectly well. It is that a
    /// *subscription* only ever buys its own vendor's models, and this is the row where the
    /// subscription path exists.
    Anthropic,
    /// Google, and only Google.
    ///
    /// Separate from `AnyProvider` because Antigravity's bundled harness requires a Gemini key
    /// wherever its base url points — the SDK's own README is explicit about it. Offered as
    /// "any provider you already have", it would install against an OpenAI-only deployment and
    /// answer nothing, which is the failure `webCreate` exists to prevent on the web side.
    Google,
    /// The person's own endpoint. Nothing is installed and no key is ours to ask for.
    TheirEndpoint,
}

/// One row.
/**
Which Bot can use a signed-in subscription, by vendor.

THE CONSTRAINT IS ON THE LOGIN, NOT THE FRAMEWORK, and this is where that bites. Every harness on
the list takes any model through an API key, so the Bot step and the model step are independent
there. A subscription is different: it only ever buys that vendor's own models, and only through a
path that speaks that vendor's subscription auth. Anthropic's is the Claude Agent SDK, which reads
`CLAUDE_CODE_OAUTH_TOKEN`; OpenAI's is the Codex model, which the LangGraph AG-UI image selects from
the token store.

A ChatGPT plan runs on the TypeScript LangGraph Bot, like every other sign-in but the Claude plan,
and that Bot sends its model calls to the Python LangGraph image, which holds the Codex transport.
So a ChatGPT-plan installation keeps the Python image running beside its Bot: see
`crate::plan::CHATGPT_PLAN_SERVICE`.

MEASURED, on the screen built to catch it: signing in to a Claude plan and keeping the default Bot
produced a stack that came up clean and a Bot whose own log said "Missing credentials. Please pass
an `api_key`". The last screen showed the failure, which is what it is for, but the person had done
nothing wrong and had no way to know which of two correct-looking answers to change.

Nobody is asked to know this. The plan picks the Bot that can use it.
*/
pub fn speaking_for(provider: &str) -> Option<&'static str> {
    match provider {
        "anthropic" => Some("claude-agent-sdk"),
        "openai" => Some(DEFAULT_HARNESS),
        _ => None,
    }
}

/**
The Bot a start runs, from the Bot the window asked for and the credential the model screen chose.

A plan chooses its own Bot, because only one Bot can spend it (see `speaking_for`). Anything else
is a key or a provider sign-in, where the Bot and the model are independent and the window's choice
stands.
*/
pub fn for_credential(
    credential: &crate::env::ModelCredential,
    chosen: Option<HarnessChoice>,
) -> Option<HarnessChoice> {
    let plan = match credential {
        crate::env::ModelCredential::ClaudePlan { .. } => speaking_for("anthropic"),
        crate::env::ModelCredential::ChatGptPlan { .. } => speaking_for("openai"),
        _ => return chosen,
    };
    plan.map(|id| HarnessChoice {
        id: id.into(),
        agent_url: None,
    })
}

/**
The id an installation's saved choice means in this release.

`langgraph` was the default Bot until the TypeScript LangGraph Bot replaced it. The setup window
has no picker: it installs the default, and a plan re-points it. So an installation that saved
`langgraph` either took the default or was on a ChatGPT plan, and both now run on the default.
Moved here, where the image is resolved, so Install pulls the image Start then runs, and the
installation's Bot (`picked-harness` in the package) keeps its id and its threads.
*/
fn current_id(id: &str) -> &str {
    match id {
        "langgraph" => DEFAULT_HARNESS,
        other => other,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Harness {
    pub id: String,
    pub name: String,
    pub summary: String,
    /// The published name of the image that speaks AG-UI. Resolved to a digest-pinned reference
    /// through the release's manifest; see `crate::deployment::reference`.
    ///
    /// `None` only for the row where the person supplies the address.
    pub image: Option<String>,
    /// Where the container says it is ready.
    pub health_path: Option<String>,
    /// Where AG-UI run requests are served inside the harness.
    ///
    /// Empty means the server root. Readiness stays in `health_path` because Compose polls that
    /// before a run token exists.
    pub run_path: String,
    /// The port the image listens on, which differs per harness and is fixed by its Dockerfile.
    ///
    /// Carried because the one compose service that runs the picked harness has to be told, and
    /// because the endpoint the Bot is registered at is built from it. `None` only for the row where
    /// the person supplies the address.
    pub port: Option<u16>,
    pub credential: Credential,
    pub maintainer: Maintainer,
    /// The vendored mark's file stem, or `None` where no maintained set has one.
    ///
    /// A row with `None` shows its name alone. Nothing is drawn to fill the gap: see
    /// `desktop/src/marks/README.md` for why an invented monogram is the one thing that would be a
    /// problem. The name is on every row regardless, so an unmarked row is not a lesser one.
    pub mark: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessChoice {
    pub id: String,
    #[serde(default)]
    pub agent_url: Option<String>,
}

fn byo_remote_ag_ui_url(value: &str) -> Result<String, String> {
    if value.chars().any(char::is_control) {
        return Err("Enter a valid http:// or https:// address for the agent endpoint.".into());
    }
    let trimmed = value.trim();
    let parsed = reqwest::Url::parse(trimmed).map_err(|_| {
        "Enter a valid http:// or https:// address for the agent endpoint.".to_string()
    })?;
    if matches!(parsed.scheme(), "http" | "https") && parsed.has_host() {
        Ok(trimmed.into())
    } else {
        Err("Enter a valid http:// or https:// address for the agent endpoint.".into())
    }
}

/// The Bot a first setup installs, as the setup window names it (`DEFAULT_HARNESS` in
/// desktop/src/harness.ts). The early downloads pull its images before Install is clicked.
pub const DEFAULT_HARNESS: &str = "langgraph-ts";

/// The list, ranked as the build doc ranks it: stars first, with downloads as the sanity check,
/// because each misleads alone.
///
/// Anything the AG-UI table marks In Progress is left out. OpenAI's Agents SDK, AWS Bedrock Agents
/// and Cloudflare Agents are all In Progress, and a picker that offers a harness which cannot yet
/// answer is worse than a shorter picker.
///
/// Mastra is here on different terms from the rest, and the difference is in the server rather than
/// in this list. Every other row is an image serving an AG-UI route; Mastra's image is a plain
/// Mastra server, and OpenBot dials it through `getRemoteAgents` from `@ag-ui/mastra`, the bridge
/// Mastra and AG-UI maintain between them. See `remoteTransport` in server/src/copilot.ts.
///
/// It reads as a harness like any other because the difference ends at the transport: a Mastra Bot
/// arrives as the same `AbstractAgent` and is governed by the same wrapper as an AG-UI one. What
/// this list still refuses is writing that translation by hand, which is what mounting
/// `registerCopilotKit` in the harness amounted to: that route serves the CopilotKit Runtime
/// protocol, not AG-UI, and a run reached it and came back asking for a `method` field.
pub fn catalogue() -> Vec<Harness> {
    /*
     * Read from `shared/harnesses.json`, the one file every language reads, rather than written
     * here. The web app's New Bot dialog names the same frameworks, and a second copy of this list
     * would drift — which matters more than for most lists, because this one carries other
     * companies' trade marks and the rules in `shared/marks/README.md` about what may be drawn for
     * them.
     *
     * Baked in with `include_str!` rather than read at runtime: the setup window draws before it
     * has a working directory it can rely on, and a catalogue that can fail to load is a catalogue
     * that can leave the picker empty on a first run with nothing on screen to say why.
     */
    #[derive(Deserialize)]
    struct CatalogFile {
        harnesses: Vec<CatalogRow>,
    }

    /*
     * Its own struct rather than deserializing `Harness` directly, because the two shapes differ on
     * purpose. The file is camelCase, which is what the web app reads; `Harness` is snake_case,
     * which is what the Tauri command has always sent `desktop/src/HarnessPicker.tsx`. Renaming
     * `Harness` to match the file would change that wire format for a UI that declares
     * `health_path`. Unknown keys — `_readme`, and the web-only `webSummary` and `webCreate` — are
     * ignored by serde, which is what lets the web app add a field without touching this.
     */
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CatalogRow {
        id: String,
        name: String,
        summary: String,
        image: Option<String>,
        port: Option<u16>,
        health_path: Option<String>,
        run_path: String,
        credential: Credential,
        maintainer: Maintainer,
        mark: Option<String>,
    }

    let file: CatalogFile = serde_json::from_str(include_str!("../../../shared/harnesses.json"))
        .expect("shared/harnesses.json is baked in at build time and must parse");

    file.harnesses
        .into_iter()
        .map(|row| Harness {
            id: row.id,
            name: row.name,
            summary: row.summary,
            image: row.image,
            health_path: row.health_path,
            run_path: row.run_path,
            port: row.port,
            credential: row.credential,
            maintainer: row.maintainer,
            mark: row.mark,
        })
        .collect()
}

/**
Which harness a picked id means, as the settings it implies.

Extracted from `start_stack` so the refusals can be tested. Each one is a real state: a window that
sends an id this build does not have (a downgrade, or a stale page), and the row that installs
nothing because the person is bringing their own address.

An unknown id is refused here rather than written into `.env`, where it would become a Bot pointing
at a container nobody started — which looks like a broken Bot rather than a bad pick.
*/
pub fn picked(
    choice: Option<&HarnessChoice>,
    // Where the deployment is, because the image reference is read from the manifest laid down
    // beside it. A name built from a version was what this took before, and an unqualified name
    // sends every engine to Docker Hub: the pull was refused there and the person was shown a
    // registry permissions error for a repository that had never been pushed.
    root: &std::path::Path,
) -> Result<Option<crate::env::PickedHarness>, String> {
    let Some(choice) = choice else {
        return Ok(None);
    };
    let id = current_id(choice.id.trim());
    if id.is_empty() {
        return Ok(None);
    };
    let row = catalogue()
        .into_iter()
        .find(|row| row.id == id)
        .ok_or_else(|| format!("There is no Bot called \"{id}\" to install."))?;
    if row.id == "byo-url" {
        let url = choice
            .agent_url
            .as_deref()
            .ok_or_else(|| {
                "Enter a valid http:// or https:// address for the agent endpoint.".to_string()
            })
            .and_then(byo_remote_ag_ui_url)?;
        return Ok(Some(crate::env::PickedHarness::RemoteAgUi {
            url,
            name: row.name,
            remote_agent_id: String::new(),
        }));
    }
    let (Some(image), Some(port)) = (row.image, row.port) else {
        return Err(format!("\"{id}\" is not a Bot this can install."));
    };
    let mastra = row.id == "mastra";
    Ok(Some(crate::env::PickedHarness::Installed {
        image: crate::deployment::reference(root, &image)?,
        port,
        name: row.name,
        mastra,
        run_path: row.run_path,
        // Our own Mastra image serves one agent, named for the product. Somebody pointing at their
        // own Mastra server names theirs on the Bot's page.
        remote_agent_id: if mastra {
            "openbot".to_string()
        } else {
            String::new()
        },
    }))
}

/**
The Bot an install of `root` puts in: `asked`, when the release laid out in `root` includes it.

A Mac on Docker Desktop, after Desktop was updated from 1.0.3 to 1.1.2: the folder was still laid out
at 1.0.3, since Start moves it to the app's release, and the first screen's install asked for the
new default Bot, which 1.0.3 does not have. Install failed with "OpenBot v1.0.3 does not include
agent-langgraph-ts", and Retry the same way, every time. Install puts in what the folder's own
release runs, so a release that lacks the Bot asked for keeps the one the folder already has
(`kept`), and without one takes the first Bot the release does include, in the catalogue's order.
The Bot asked for comes with the release that has it, when Start moves the folder to it. A Bot the
person typed an address for, or any other refusal, is left to `picked` to say.
*/
pub fn the_release_includes(
    asked: Option<HarnessChoice>,
    kept: Option<HarnessChoice>,
    root: &std::path::Path,
) -> Option<HarnessChoice> {
    let lacks = |choice: &HarnessChoice| {
        catalogue()
            .into_iter()
            .find(|row| row.id == current_id(choice.id.trim()))
            .and_then(|row| row.image)
            .is_some_and(|image| crate::deployment::reference(root, &image).is_err())
    };
    let Some(choice) = asked.as_ref().filter(|choice| lacks(choice)) else {
        return asked;
    };
    // The folder's own Bot is what its release was installed with, so it is never second-guessed
    // here: its finished install is kept as it is (`preparation::require`).
    let instead = kept.or_else(|| {
        catalogue()
            .into_iter()
            .filter(|row| row.image.is_some())
            .map(|row| HarnessChoice {
                id: row.id,
                agent_url: None,
            })
            .find(|row| picked(Some(row), root).is_ok())
    });
    match instead {
        Some(instead) => {
            log::warn!(
                "[install] the release laid out here does not include {}; installing {} until Start moves it to the release that does",
                choice.id,
                instead.id
            );
            Some(instead)
        }
        None => asked,
    }
}

#[derive(Debug)]
pub enum PickedAfterDeploymentError<E> {
    Deployment(E),
    Harness(String),
}

pub async fn picked_after_deployment_ready<E, Ready, ReadyFuture>(
    root: &std::path::Path,
    harness: Option<&HarnessChoice>,
    ready: Ready,
) -> Result<Option<crate::env::PickedHarness>, PickedAfterDeploymentError<E>>
where
    Ready: FnOnce() -> ReadyFuture,
    ReadyFuture: std::future::Future<Output = Result<(), E>>,
{
    ready()
        .await
        .map_err(PickedAfterDeploymentError::Deployment)?;
    picked(harness, root).map_err(PickedAfterDeploymentError::Harness)
}

#[cfg(test)]
mod tests {
    use crate::test_support::temp_root;

    /// The window installs this Bot on Install's click, and the early downloads pull its images
    /// before that click: the two must name the same one.
    #[test]
    fn the_default_bot_is_the_one_the_setup_window_installs() {
        let window = include_str!("../../src/harness.ts");
        assert!(
            window.contains(&format!("DEFAULT_HARNESS = \"{}\"", super::DEFAULT_HARNESS)),
            "desktop/src/harness.ts DEFAULT_HARNESS must equal harness::DEFAULT_HARNESS"
        );
        assert!(super::catalogue()
            .iter()
            .any(|row| row.id == super::DEFAULT_HARNESS && row.image.is_some()));
    }

    /// The default Bot is the TypeScript LangGraph image, replacing the Python one rather than
    /// running beside it.
    #[test]
    fn the_default_bot_is_the_typescript_langgraph_image() {
        let root = deployment_naming_everything("default-ts");
        let row = catalogue()
            .into_iter()
            .find(|row| row.id == DEFAULT_HARNESS)
            .expect("the default Bot is in the catalogue");
        assert_eq!(row.id, "langgraph-ts");
        assert_eq!(row.image.as_deref(), Some("agent-langgraph-ts"));
        assert_eq!(row.port, Some(4215));
        assert_eq!(row.health_path.as_deref(), Some("/health"));
        let crate::env::PickedHarness::Installed {
            image,
            port,
            run_path,
            ..
        } = picked(Some(&choice(DEFAULT_HARNESS)), &root)
            .expect("refused")
            .expect("nothing")
        else {
            panic!("the default Bot installs an image");
        };
        assert_eq!(
            image,
            "ghcr.io/copilotkit/openbot-agent-langgraph-ts@sha256:abc"
        );
        assert_eq!(port, 4215);
        assert_eq!(run_path, "");
        let _ = std::fs::remove_dir_all(&root);
    }

    fn installed_image(root: &std::path::Path, chosen: Option<HarnessChoice>) -> String {
        match picked(chosen.as_ref(), root).expect("refused") {
            Some(crate::env::PickedHarness::Installed { image, .. }) => image,
            other => panic!("expected an installed Bot, got {other:?}"),
        }
    }

    /**
    Which image each sign-in runs its Bot on.

    A Claude plan can only be spent through the Claude Agent SDK. Every other sign-in runs the
    TypeScript LangGraph Bot: an API key and a Gemini sign-in reach their provider directly, and a
    ChatGPT plan's Bot sends its model calls on to the Python image, which keeps running for it
    (`crate::env` writes the address, `crate::stack::selected_services` starts it).
    */
    #[test]
    fn each_sign_in_runs_the_bot_its_routing_names() {
        use crate::env::ModelCredential;
        let root = deployment_naming_everything("sign-ins");
        let default = Some(choice(DEFAULT_HARNESS));
        let ts = "ghcr.io/copilotkit/openbot-agent-langgraph-ts@sha256:abc";
        for (credential, image) in [
            (
                ModelCredential::OpenAi {
                    api_key: "sk-test".into(),
                },
                ts,
            ),
            (
                ModelCredential::Anthropic {
                    api_key: "sk-ant-test".into(),
                },
                ts,
            ),
            (
                ModelCredential::ProviderOAuth {
                    provider: "google".into(),
                    path: "/openbot/model-oauth.json".into(),
                    proxy_token: "proxy".into(),
                    model: "gemini-3-pro".into(),
                },
                ts,
            ),
            (ModelCredential::ChatGptPlan { store: "{}".into() }, ts),
            (
                ModelCredential::ClaudePlan {
                    token: "plan".into(),
                },
                "ghcr.io/copilotkit/openbot-agent-claude-sdk@sha256:abc",
            ),
        ] {
            assert_eq!(
                installed_image(&root, for_credential(&credential, default.clone())),
                image,
                "{credential:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An installation from before this release saved `langgraph`, the Python image, as its Bot.
    /// It moves to the TypeScript image on its next Install and Start, whatever it signs in with.
    #[test]
    fn an_installation_that_saved_the_python_default_moves_to_the_typescript_one() {
        use crate::env::ModelCredential;
        let root = deployment_naming_everything("saved-python");
        let saved = Some(choice("langgraph"));
        let ts = "ghcr.io/copilotkit/openbot-agent-langgraph-ts@sha256:abc";
        // Install, which has no credential and pulls what the saved choice resolves to.
        assert_eq!(installed_image(&root, saved.clone()), ts);
        for credential in [
            ModelCredential::OpenAi {
                api_key: "sk-test".into(),
            },
            ModelCredential::ChatGptPlan { store: "{}".into() },
        ] {
            assert_eq!(
                installed_image(&root, for_credential(&credential, saved.clone())),
                ts,
                "{credential:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Both plans name a Bot that exists and can actually use them.
    #[test]
    fn each_plan_names_a_bot_that_exists() {
        for provider in ["anthropic", "openai"] {
            let id = super::speaking_for(provider).expect("a plan with no Bot to run it");
            assert!(
                super::catalogue().iter().any(|row| row.id == id),
                "{provider} points at {id}, which is not in the catalogue"
            );
        }
        // Anything else is a key path, where the Bot and the model are genuinely independent.
        assert_eq!(super::speaking_for("openai-compatible"), None);
    }

    use super::*;

    /// OpenBot's own `built-in` agent type is a system prompt, not a harness, and the doc is
    /// explicit that it is not offered. Everybody leaves setup with a real one.
    #[test]
    fn the_built_in_agent_type_is_not_offered() {
        for harness in catalogue() {
            assert_ne!(harness.id, "built-in", "the built-in agent type is offered");
            assert_ne!(
                harness.id, "agent-bot",
                "the built-in agent type is offered"
            );
        }
    }

    /// Every row either ships an image or is the row where the person brings the address. A row
    /// that is neither cannot be started and should not be on screen.
    #[test]
    fn every_row_is_either_an_image_we_publish_or_an_address_they_give() {
        for harness in catalogue() {
            match harness.credential {
                Credential::TheirEndpoint => {
                    assert!(
                        harness.image.is_none(),
                        "{} installs and should not",
                        harness.id
                    );
                    assert!(
                        harness.health_path.is_none(),
                        "{} has no container to poll",
                        harness.id
                    );
                }
                _ => {
                    assert!(harness.image.is_some(), "{} offers no image", harness.id);
                    assert!(
                        harness.health_path.is_some(),
                        "{} has no readiness path",
                        harness.id
                    );
                }
            }
        }
    }

    /// Anything the AG-UI table marks In Progress stays off. These three were In Progress when the
    /// list was read, and offering one would mean a row that cannot answer.
    #[test]
    fn nothing_still_in_progress_upstream_is_offered() {
        let ids: Vec<String> = catalogue().into_iter().map(|h| h.id).collect();
        for absent in ["openai-agents-sdk", "bedrock-agents", "cloudflare-agents"] {
            assert!(
                !ids.contains(&absent.to_string()),
                "{absent} is In Progress upstream"
            );
        }
    }

    /**
    Every image this list names is one a release actually publishes.

    The guard on the defect that made this test exist: image names were derived from the row's id
    and the release derives them from the directory, so all twelve named something that would never
    be pushed. Nothing caught it, because a wrong image name is correct Rust and fails at the pull
    on somebody's first run.

    Read from `.github/published-images.json`, which is the same file CI checks against the
    Dockerfiles in the tree, so the picker, the tests and the release all agree or this fails.
    */
    #[test]
    fn every_image_is_one_a_release_publishes() {
        let listed = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../.github/published-images.json"),
        )
        .expect("published-images.json is not where this test expects it");
        // Crude on purpose: a substring check needs no JSON parser in a build with no reason to
        // carry one, and the file is a flat list of quoted names.
        for harness in catalogue() {
            let Some(image) = harness.image else { continue };
            assert!(
                listed.contains(&format!("\"{image}\"")),
                "{} names image {image}, which no release publishes",
                harness.id
            );
        }
    }

    /// A harness that is pulled has to say which port it listens on, because the one service that
    /// runs it is told, and the endpoint the Bot is registered at is built from it.
    #[test]
    fn a_pulled_harness_names_its_port() {
        for harness in catalogue() {
            assert_eq!(
                harness.image.is_some(),
                harness.port.is_some(),
                "{} has an image and no port, or a port and no image",
                harness.id
            );
        }
    }

    /// Two harnesses on one port would be one service that cannot run both, and a Bot registered at
    /// an address belonging to the other.
    #[test]
    fn no_two_harnesses_share_a_port() {
        let mut seen = std::collections::BTreeMap::new();
        for harness in catalogue() {
            let Some(port) = harness.port else { continue };
            if let Some(other) = seen.insert(port, harness.id.clone()) {
                panic!("{} and {} both claim port {port}", harness.id, other);
            }
        }
    }

    /// An id this build does not have is refused by name, not written into a `.env`.
    ///
    /// It happens: a window left open across a downgrade sends an id the catalogue has lost. Passed
    /// through, it becomes a Bot addressed at a container nobody started, which reads as a broken
    /// Bot rather than a pick that could not be honoured.
    #[test]
    fn an_unknown_id_is_refused_by_name() {
        let refusal = picked(Some(&choice("not-a-real-harness")), &std::env::temp_dir())
            .expect_err("it was accepted");
        assert!(refusal.contains("not-a-real-harness"), "{refusal}");
    }

    /// A deployment whose manifest names every image in the catalogue, the way a release does.
    ///
    /// Written to a real directory because resolution reads the manifest from disk, which is the
    /// behaviour under test: a fixture built in memory would not catch a path that is looked for in
    /// the wrong place.
    fn deployment_naming_everything(label: &str) -> std::path::PathBuf {
        let root = temp_root(&format!("harness-{label}"));
        std::fs::create_dir_all(&root).unwrap();
        let named: Vec<String> = catalogue()
            .into_iter()
            .filter_map(|row| row.image)
            .map(|image| {
                format!(
                    "\"{image}\": {{ \"repository\": \"ghcr.io/copilotkit/openbot-{image}\", \
                     \"digest\": \"sha256:abc\", \
                     \"reference\": \"ghcr.io/copilotkit/openbot-{image}@sha256:abc\" }}"
                )
            })
            .collect();
        std::fs::write(
            crate::deployment::images_path(&root),
            format!(
                "{{ \"version\": \"v1.2.3\", \"images\": {{ {} }} }}",
                named.join(", ")
            ),
        )
        .unwrap();
        root
    }

    fn scratch(label: &str) -> std::path::PathBuf {
        let root = temp_root(&format!("harness-{label}"));
        std::fs::create_dir_all(&root).expect("scratch root is made");
        root
    }

    fn write_crewai_manifest(root: &std::path::Path) {
        std::fs::write(
            crate::deployment::images_path(root),
            "{ \"version\": \"v9.9.9\", \"images\": { \
             \"agent-crewai\": { \
             \"reference\": \"ghcr.io/copilotkit/openbot-agent-crewai@sha256:abc\" } } }",
        )
        .expect("manifest is written");
    }

    fn choice(id: &str) -> HarnessChoice {
        HarnessChoice {
            id: id.into(),
            agent_url: None,
        }
    }

    #[test]
    fn start_fetches_deployment_before_resolving_a_selected_harness_image() {
        let root = scratch("fetch-before-pick");
        assert!(
            crate::deployment::needs_fetch(&root, "v9.9.9"),
            "the test must start like a clean install, with no manifest"
        );

        let picked = tauri::async_runtime::block_on(picked_after_deployment_ready(
            &root,
            Some(&choice("crewai")),
            || async {
                write_crewai_manifest(&root);
                crate::deployment::record(&root, "v9.9.9", false)
                    .map_err(|error| format!("could not record deployment: {error}"))
            },
        ));

        let picked = picked.expect("selected harness should resolve after the deployment is ready");
        let picked = picked.expect("crewai is installable");
        let crate::env::PickedHarness::Installed { image, .. } = picked else {
            panic!("crewai should install a harness image");
        };
        assert_eq!(image, "ghcr.io/copilotkit/openbot-agent-crewai@sha256:abc");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Bringing your own address registers that remote AG-UI endpoint, and installs nothing.
    #[test]
    fn the_byo_row_resolves_to_a_remote_ag_ui_endpoint() {
        let root = std::env::temp_dir();
        let byo = HarnessChoice {
            id: "byo-url".into(),
            agent_url: Some("  https://agent.example/ag-ui  ".into()),
        };
        assert_eq!(
            picked(Some(&byo), &root).expect("it was refused"),
            Some(crate::env::PickedHarness::RemoteAgUi {
                url: "https://agent.example/ag-ui".into(),
                name: "An agent you already run".into(),
                remote_agent_id: String::new(),
            })
        );
        assert_eq!(picked(None, &root).expect("it was refused"), None);
        assert_eq!(
            picked(Some(&choice("   ")), &root).expect("it was refused"),
            None
        );
    }

    #[test]
    fn byo_remote_endpoint_requires_a_parseable_http_url_with_host_before_env_persistence() {
        let root = std::env::temp_dir();
        for endpoint in [
            "http://",
            "https://",
            "https://exa mple.example/ag-ui",
            "https://agent.example/ag-ui\nOPENAI_API_KEY=injected",
            "https://agent.example/ag-ui\r\nPICKED_HARNESS_KIND=remote-mastra",
        ] {
            let byo = HarnessChoice {
                id: "byo-url".into(),
                agent_url: Some(endpoint.into()),
            };
            let refused = picked(Some(&byo), &root).expect_err(endpoint);
            assert!(
                refused.contains("valid http:// or https:// address"),
                "{endpoint:?}: {refused}"
            );
        }

        for (endpoint, expected) in [
            (
                "  http://localhost:11434/ag-ui  ",
                "http://localhost:11434/ag-ui",
            ),
            (
                "https://models.example/ag-ui",
                "https://models.example/ag-ui",
            ),
            ("http://[::1]:8000/ag-ui", "http://[::1]:8000/ag-ui"),
        ] {
            let byo = HarnessChoice {
                id: "byo-url".into(),
                agent_url: Some(endpoint.into()),
            };
            assert_eq!(
                picked(Some(&byo), &root).expect(endpoint),
                Some(crate::env::PickedHarness::RemoteAgUi {
                    url: expected.into(),
                    name: "An agent you already run".into(),
                    remote_agent_id: String::new(),
                })
            );
        }
    }

    #[test]
    fn picked_byo_endpoint_reaches_env_file_as_one_trimmed_setting() {
        let root = scratch("byo-env-persistence");
        let byo = HarnessChoice {
            id: "byo-url".into(),
            agent_url: Some("  https://agent.example/ag-ui  ".into()),
        };
        let picked = picked(Some(&byo), &root)
            .expect("BYO endpoint should be valid")
            .expect("BYO endpoint should register a harness");
        let env = crate::env::compose(
            &crate::env::Intelligence {
                api_url: "https://api.example".into(),
                gateway_ws_url: "wss://realtime.example".into(),
                api_key: "key".into(),
            },
            &crate::env::Model::default(),
            &crate::engine::EngineStatus {
                engine: None,
                address: None,
                responding: true,
                engine_socket: None,
                detail: String::new(),
            },
            &crate::env::Ports::default(),
            &[],
            Some(&picked),
            &std::collections::BTreeMap::new(),
        );
        let path = root.join(".env");
        crate::env::write(&path, &env, &std::collections::BTreeMap::new())
            .expect("env should be persisted");

        let written = std::fs::read_to_string(&path).expect("env should be readable");
        assert!(written.contains("\nPICKED_HARNESS_URL=https://agent.example/ag-ui\n"));
        assert_eq!(
            written.matches("PICKED_HARNESS_URL=").count(),
            1,
            "{written}"
        );
        assert!(!written.contains("OPENAI_API_KEY=injected"), "{written}");
        let _ = std::fs::remove_dir_all(root);
    }

    /// A real row resolves to the image the release publishes and the port that image listens on.
    #[test]
    fn a_real_row_resolves_to_its_image_and_port() {
        let root = deployment_naming_everything("crewai");
        let crewai = picked(Some(&choice("crewai")), &root)
            .expect("refused")
            .expect("nothing");
        let crate::env::PickedHarness::Installed {
            image,
            port,
            mastra,
            remote_agent_id,
            ..
        } = crewai
        else {
            panic!("crewai should install a harness image");
        };
        assert_eq!(image, "ghcr.io/copilotkit/openbot-agent-crewai@sha256:abc");
        assert_eq!(port, 4202);
        assert!(!mastra);
        assert!(remote_agent_id.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Mastra is dialled as Mastra and names the agent our image serves, because that endpoint is a
    /// roster and a Bot that names none gets the only one there or a refusal.
    #[test]
    fn mastra_resolves_as_mastra_and_names_its_agent() {
        let root = deployment_naming_everything("mastra");
        let mastra = picked(Some(&choice("mastra")), &root)
            .expect("refused")
            .expect("nothing");
        let crate::env::PickedHarness::Installed {
            mastra,
            remote_agent_id,
            ..
        } = mastra
        else {
            panic!("mastra should install a harness image");
        };
        assert!(mastra);
        assert_eq!(remote_agent_id, "openbot");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Health checks stay on their readiness path, but the Bot is registered at the harness's real
    /// run route. Agno and LlamaIndex do not serve AG-UI runs from the server root.
    #[test]
    fn picked_harnesses_keep_run_routes_separate_from_health_routes() {
        let root = deployment_naming_everything("routes");
        for (id, run_path) in [("agno", "/agui"), ("llamaindex", "/run")] {
            let row = catalogue()
                .into_iter()
                .find(|row| row.id == id)
                .expect("catalogue row missing");
            assert_eq!(row.health_path.as_deref(), Some("/health"));

            let picked = picked(Some(&choice(id)), &root)
                .expect("refused")
                .expect("nothing");
            let crate::env::PickedHarness::Installed {
                run_path: picked_run_path,
                ..
            } = picked
            else {
                panic!("{id} should install a harness image");
            };
            assert_eq!(picked_run_path, run_path);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A Mac updated from 1.0.3 to 1.1.2, its folder still laid out at 1.0.3: the first screen's
    /// install asked for the new default Bot, and failed every time with "OpenBot v1.0.3 does not
    /// include agent-langgraph-ts". Install now keeps the Bot the folder has, and without one takes
    /// one its release includes. A release that includes the Bot asked for installs it.
    #[test]
    fn install_never_asks_for_a_bot_the_folders_release_does_not_include() {
        let root = scratch("old-release");
        // 1.0.3 had no TypeScript LangGraph Bot; CrewAI stands in for what it did have.
        write_crewai_manifest(&root);
        let asked = Some(choice(DEFAULT_HARNESS));
        assert!(picked(asked.as_ref(), &root)
            .expect_err("1.0.3 has no such Bot")
            .contains("does not include agent-langgraph-ts"));

        // The folder's own Bot is kept: its finished install is what Start moves forward.
        let kept = Some(choice("langgraph"));
        assert_eq!(
            the_release_includes(asked.clone(), kept.clone(), &root),
            kept
        );
        // Without one, a Bot the release has, which installs.
        let instead = the_release_includes(asked.clone(), None, &root);
        assert_eq!(instead, Some(choice("crewai")));
        assert!(picked(instead.as_ref(), &root).is_ok());

        // Once the folder is on a release with it, the Bot asked for is what installs.
        let current = deployment_naming_everything("new-release");
        assert_eq!(
            the_release_includes(asked.clone(), kept.clone(), &current),
            asked
        );
        // An address the person typed, or no Bot at all, is never swapped.
        let byo = Some(HarnessChoice {
            id: "byo-url".into(),
            agent_url: Some("https://agent.example".into()),
        });
        assert_eq!(the_release_includes(byo.clone(), None, &root), byo);
        assert_eq!(the_release_includes(None, kept, &root), None);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&current);
    }

    /// An image this release does not publish is named as that, rather than left to the engine.
    ///
    /// The failure it replaces: an unqualified name is looked up on Docker Hub, so a Bot whose
    /// image was never pushed came back as "requested access to the resource is denied", which
    /// reads as a credentials problem and sends somebody to fix permissions on a repository that
    /// does not exist.
    #[test]
    fn a_bot_this_release_does_not_publish_is_named_rather_than_pulled() {
        let root = temp_root("empty");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            crate::deployment::images_path(&root),
            "{ \"version\": \"v1.2.3\", \"images\": {} }",
        )
        .unwrap();

        let refused = picked(Some(&choice("crewai")), &root).expect_err("it should be refused");
        assert!(refused.contains("agent-crewai"), "{refused}");
        assert!(refused.contains("v1.2.3"), "{refused}");
        assert!(!refused.contains("denied"), "{refused}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /**
    Every resolved image names the registry it comes from, and this is the guard that was missing.

    THE SAME BUG THREE TIMES. First the names were built from the ids and matched nothing a release
    publishes. Then the version stopped being appended, so an engine read the bare name as
    `:latest`. Then the name was correct and tagged and still unqualified, so Podman resolved
    `openbot-agent-langgraph-agui:v0.0.8` to `docker.io/library/...` and the person was told access
    was denied. Each one is a perfectly good string, each one failed at the pull on a first run, and
    the fix is that no reference is built here at all: they are read from the release's manifest.
    */
    #[test]
    fn every_resolved_image_names_the_registry_it_comes_from() {
        let root = deployment_naming_everything("registry");
        for row in catalogue() {
            if row.image.is_none() {
                continue;
            }
            let resolved = picked(Some(&choice(&row.id)), &root)
                .expect("refused")
                .expect("nothing");
            let crate::env::PickedHarness::Installed { image, .. } = resolved else {
                panic!("{} should install a harness image", row.id);
            };
            let host = image
                .split('/')
                .next()
                .expect("a reference has at least one segment");
            assert!(
                host.contains('.'),
                "{} resolved to {image}, which every engine looks up on Docker Hub",
                row.id
            );
            assert!(
                image.contains("@sha256:") || image.contains(':'),
                "{} resolved to {image}, which an engine reads as :latest",
                row.id
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A named mark has to be a file that is actually there. The failure this catches is silent at
    /// runtime: a row asks for a mark that was never vendored, and the tile draws empty, which
    /// looks like a rendering bug rather than a missing asset.
    #[test]
    fn every_named_mark_is_vendored() {
        for harness in catalogue() {
            let Some(mark) = harness.mark else { continue };
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../shared/marks")
                .join(format!("{mark}.svg"));
            assert!(
                path.exists(),
                "{} names mark {mark}, which is not vendored",
                harness.id
            );
        }
    }

    /// Every harness the picker runs an image for carries a mark. AG2, Agno and Langroid were the
    /// last three without one, until their own repositories supplied them (see shared/marks). An
    /// unmarked row appearing now means somebody dropped a mark rather than a brand lacking one, and
    /// that is worth stopping for.
    #[test]
    fn every_harness_with_an_image_carries_a_mark() {
        let unmarked: Vec<String> = catalogue()
            .into_iter()
            .filter(|h| h.mark.is_none() && h.image.is_some())
            .map(|h| h.id)
            .collect();
        assert!(unmarked.is_empty(), "unmarked harnesses: {unmarked:?}");
    }

    /// Mastra is offered, and the row is the assertion that the bridge on OpenBot's side works.
    /// It was out while the only thing a harness could mount served the wrong protocol; it is in
    /// because `remoteTransport` dials Mastra's own API instead. Removing the row means that path
    /// regressed, so this fails rather than the picker quietly shrinking.
    #[test]
    fn mastra_is_offered_now_that_it_is_dialled_through_its_own_bridge() {
        let ids: Vec<String> = catalogue().into_iter().map(|h| h.id).collect();
        assert!(ids.contains(&"mastra".to_string()), "Mastra is not offered");
    }

    /// Codex and Gemini CLI have no integration and we do not write adapters, so they cannot appear
    /// however popular they are.
    #[test]
    fn harnesses_with_no_integration_are_absent() {
        let ids: Vec<String> = catalogue().into_iter().map(|h| h.id).collect();
        for absent in ["codex", "gemini-cli"] {
            assert!(
                !ids.contains(&absent.to_string()),
                "{absent} has no AG-UI integration"
            );
        }
    }

    /// Exactly one row can take a subscription instead of a key, and the screen branches on it.
    /// Two would mean the branch is wrong; none would mean the Claude row was dropped.
    #[test]
    fn one_row_takes_a_plan_rather_than_a_key() {
        let anthropic: Vec<String> = catalogue()
            .into_iter()
            .filter(|h| h.credential == Credential::Anthropic)
            .map(|h| h.id)
            .collect();
        assert_eq!(anthropic, vec!["claude-agent-sdk".to_string()]);
    }

    /// Ranked, and the order is load-bearing: it is what somebody reads top-down. CrewAI leads on
    /// stars and the paste-a-URL row is last because it is the one that installs nothing.
    #[test]
    fn the_list_is_ranked_and_ends_with_the_address_row() {
        let ids: Vec<String> = catalogue().into_iter().map(|h| h.id).collect();
        assert_eq!(ids.first().map(String::as_str), Some("crewai"));
        assert_eq!(ids.last().map(String::as_str), Some("byo-url"));
    }

    /// Ids become image names and Compose service names, so they have to stay boring.
    #[test]
    fn ids_are_safe_to_use_as_image_and_service_names() {
        for harness in catalogue() {
            assert!(
                harness
                    .id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{} is not a usable image name",
                harness.id
            );
        }
    }
}
