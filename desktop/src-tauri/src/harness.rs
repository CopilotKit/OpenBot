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
    /// The person's own endpoint. Nothing is installed and no key is ours to ask for.
    TheirEndpoint,
}

/// One row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Harness {
    pub id: String,
    pub name: String,
    pub summary: String,
    /// The image that speaks AG-UI, pinned by the release like every other image.
    ///
    /// `None` only for the row where the person supplies the address.
    pub image: Option<String>,
    /// Where the container says it is ready.
    pub health_path: Option<String>,
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
    // Marks are vendored under the row's own id, so a row finds its own without a second mapping.
    // The three with none are named here rather than discovered at draw time, because a missing
    // file and a brand with no mark are different things and only one of them is a bug.
    const UNMARKED: [&str; 3] = ["agno", "ag2", "langroid"];
    /*
     * The directory is given, not derived from the id, and that is deliberate.
     *
     * A release publishes `openbot-<directory>`, taken from the Dockerfile paths in the tree, so
     * the image name belongs to the directory and not to whatever this list calls the row. Derived
     * from the id it was wrong for every row — `openbot-harness-crewai` against a published
     * `openbot-agent-crewai` — and wrong twice for the four whose id does not match their folder.
     * A picker that names an image nobody publishes fails at the pull, on a first run, with nothing
     * on screen to say why. `every_image_is_one_a_release_publishes` holds it.
     */
    let ours = |id: &str,
                directory: &str,
                port: u16,
                name: &str,
                summary: &str,
                maintainer: Maintainer| Harness {
        id: id.into(),
        name: name.into(),
        summary: summary.into(),
        image: Some(format!("openbot-{directory}")),
        port: Some(port),
        health_path: Some("/health".into()),
        credential: Credential::AnyProvider,
        maintainer,
        mark: (!UNMARKED.contains(&id)).then(|| id.to_string()),
    };

    vec![
        ours(
            "crewai",
            "agent-crewai",
            4202,
            "CrewAI",
            "Crews of agents with roles and tasks.",
            Maintainer::Partnership,
        ),
        ours(
            "llamaindex",
            "agent-llamaindex",
            4204,
            "LlamaIndex",
            "Agents built around your own documents.",
            Maintainer::FirstParty,
        ),
        ours(
            "agno",
            "agent-agno",
            4203,
            "Agno",
            "Fast, small, and multi-modal.",
            Maintainer::FirstParty,
        ),
        ours(
            "langgraph",
            "agent-langgraph-agui",
            4206,
            "LangGraph",
            "Graphs you can change, from LangChain.",
            Maintainer::Partnership,
        ),
        ours(
            "google-adk",
            "agent-adk",
            4208,
            "Google ADK",
            "Google's agent kit. Gemini first, any model after.",
            Maintainer::FirstParty,
        ),
        ours(
            "pydantic-ai",
            "agent-pydantic-ai",
            4205,
            "Pydantic AI",
            "Typed agents, validated in and out.",
            Maintainer::FirstParty,
        ),
        ours(
            "microsoft-agent-framework",
            "agent-microsoft",
            4211,
            "Microsoft Agent Framework",
            "Microsoft's, model-agnostic by design.",
            Maintainer::FirstParty,
        ),
        Harness {
            id: "claude-agent-sdk".into(),
            name: "Claude Agent SDK".into(),
            summary: "Anthropic's own. The one that takes a Claude plan instead of a key.".into(),
            image: Some("openbot-agent-claude-sdk".into()),
            port: Some(4212),
            health_path: Some("/health".into()),
            credential: Credential::Anthropic,
            maintainer: Maintainer::Community,
            mark: Some("claude-agent-sdk".into()),
        },
        ours(
            "strands",
            "agent-strands",
            4207,
            "AWS Strands",
            "Amazon's. Bedrock first, any model after.",
            Maintainer::FirstParty,
        ),
        ours(
            "ag2",
            "agent-ag2",
            4210,
            "AG2",
            "The AutoGen line, continued.",
            Maintainer::FirstParty,
        ),
        ours(
            "langroid",
            "agent-langroid",
            4209,
            "Langroid",
            "Multi-agent, deliberately small.",
            Maintainer::Community,
        ),
        ours(
            "mastra",
            "agent-mastra",
            4213,
            "Mastra",
            "TypeScript agents, with their own server.",
            Maintainer::Partnership,
        ),
        Harness {
            id: "byo-url".into(),
            name: "An agent you already run".into(),
            summary: "Give its address. It is proved with a real AG-UI run before it is saved."
                .into(),
            image: None,
            port: None,
            health_path: None,
            credential: Credential::TheirEndpoint,
            maintainer: Maintainer::Community,
            // Stands for whatever the person already runs, so no vendor's mark is honest here.
            mark: None,
        },
    ]
}

#[cfg(test)]
mod tests {
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
            let component = image
                .strip_prefix("openbot-")
                .expect("a harness image is named openbot-<component>");
            assert!(
                listed.contains(&format!("\"{component}\"")),
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

    /// A named mark has to be a file that is actually there. The failure this catches is silent at
    /// runtime: a row asks for a mark that was never vendored, and the tile draws empty, which
    /// looks like a rendering bug rather than a missing asset.
    #[test]
    fn every_named_mark_is_vendored() {
        for harness in catalogue() {
            let Some(mark) = harness.mark else { continue };
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../src/marks")
                .join(format!("{mark}.svg"));
            assert!(
                path.exists(),
                "{} names mark {mark}, which is not vendored",
                harness.id
            );
        }
    }

    /// The unmarked rows are the three brands with no mark in any maintained set. If a fourth
    /// appears, somebody dropped a mark rather than a brand losing one, and that is worth stopping
    /// for.
    #[test]
    fn only_the_three_brands_without_a_mark_are_unmarked() {
        let unmarked: Vec<String> = catalogue()
            .into_iter()
            .filter(|h| h.mark.is_none() && h.image.is_some())
            .map(|h| h.id)
            .collect();
        assert_eq!(unmarked, vec!["agno", "ag2", "langroid"]);
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
