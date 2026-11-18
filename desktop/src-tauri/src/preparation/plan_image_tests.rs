/*!
Which sign-in downloads the two plan images.

- The Python LangGraph image (`plan::CHATGPT_SIGN_IN_IMAGE`) runs only on a ChatGPT plan, beside the
  TypeScript Bot, as the plan's model service.
- The Claude Agent SDK image (`plan::SIGN_IN_IMAGE`) runs only on a Claude plan, as its Bot.

Both carry their vendor's sign-in. An install on an API key still downloaded both ahead of Install,
pulled both at Install, and had its update download the next release's copies, and neither ran.
Each path that decides what to download is driven here as the app drives it, with the `.env` each
sign-in's Start writes (`harness::for_credential`, `env::compose`, `vault::split`, `env::write`):

- the first screen's early download, before anybody has signed in (`early_downloads::named_images`);
- Install, and the Install an update makes before its Start (`installation_pull_set_by`);
- the download an update makes ahead of the Update click (`images_it_runs`, `update_ready`).

A switch to a plan later downloads its image then: see `tests::a_switch_to_a_claude_plan_*` and
`tests::a_switch_to_a_chatgpt_plan_*` in `main.rs`, which drive Start.
*/

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::env::{Intelligence, Model, ModelCredential, Ports};
use crate::harness::{HarnessChoice, DEFAULT_HARNESS};

const CHATGPT_PLAN: &str = "openbot-agent-langgraph-agui@";
const CLAUDE_PLAN: &str = "openbot-agent-claude-sdk@";

/// A release laid out as Install lays it out: this repository's Compose file and an image list
/// that names the default Bot.
fn laid_out(label: &str) -> PathBuf {
    let root = crate::test_support::temp_root(label);
    std::fs::create_dir_all(&root).unwrap();
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    std::fs::copy(
        repository.join("docker-compose.yml"),
        root.join("docker-compose.yml"),
    )
    .unwrap();
    let mut manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("test-fixtures/release-images/container-images-v0.3.3.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let digest = format!("sha256:{}", "0".repeat(64));
    manifest["images"]["agent-langgraph-ts"] = serde_json::json!({
        "repository": "ghcr.io/copilotkit/openbot-agent-langgraph-ts",
        "digest": digest,
        "reference": format!("ghcr.io/copilotkit/openbot-agent-langgraph-ts@{digest}"),
    });
    std::fs::write(
        crate::deployment::images_path(&root),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
    crate::deployment::record(&root, "v0.3.3", false).unwrap();
    root
}

/// Compose, as far as `config --images` goes: a line for each service it is asked about that has
/// an image. The ChatGPT plan's service is answered with the release's own reference, as Compose
/// reads it from `LANGGRAPH_IMAGE`.
#[cfg(unix)]
fn compose_stand_in(root: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let plan = crate::deployment::reference(root, crate::plan::CHATGPT_SIGN_IN_IMAGE).unwrap();
    let path = root.join("compose-stand-in");
    std::fs::write(
        &path,
        format!(
            "#!/bin/sh\n\
             echo pgvector/pgvector:pg17\n\
             for service in \"$@\"; do\n\
             \x20 case \"$service\" in\n\
             \x20   server) echo ghcr.io/copilotkit/openbot-server@sha256:{server} ;;\n\
             \x20   {service}) echo {plan} ;;\n\
             \x20 esac\n\
             done\n",
            server = "1".repeat(64),
            service = crate::plan::CHATGPT_PLAN_SERVICE,
        ),
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// The `.env` Start writes for `credential`, written where Start writes it: the Bot the sign-in
/// picks, the settings for it, and none of the secrets, which go to the credential store.
fn signed_in(root: &Path, credential: ModelCredential) {
    let chosen = crate::harness::for_credential(
        &credential,
        Some(HarnessChoice {
            id: DEFAULT_HARNESS.into(),
            agent_url: None,
        }),
    );
    let picked = crate::harness::picked(chosen.as_ref(), root).unwrap();
    let all = crate::env::compose(
        &Intelligence {
            api_url: "https://api.example".into(),
            gateway_ws_url: "wss://realtime.example".into(),
            api_key: "key".into(),
        },
        &Model { credential },
        &crate::engine::EngineStatus {
            engine: None,
            address: None,
            responding: true,
            engine_socket: None,
            detail: String::new(),
        },
        &Ports::default(),
        &[],
        picked.as_ref(),
        &BTreeMap::new(),
    );
    let (settings, _secrets) = crate::vault::split(all);
    crate::env::write(&root.join(".env"), &settings, &BTreeMap::new()).unwrap();
}

/// A sign-in the model screen offers, and which plan image it runs.
struct SignIn {
    said: &'static str,
    credential: Option<ModelCredential>,
    chatgpt_plan: bool,
    claude_plan: bool,
}

fn sign_ins() -> Vec<SignIn> {
    let neither = |said, credential| SignIn {
        said,
        credential,
        chatgpt_plan: false,
        claude_plan: false,
    };
    vec![
        neither("nothing yet, a first install", None),
        neither(
            "an OpenAI key",
            Some(ModelCredential::OpenAi {
                api_key: "sk-test".into(),
            }),
        ),
        neither(
            "an Anthropic key",
            Some(ModelCredential::Anthropic {
                api_key: "sk-ant-api-test".into(),
            }),
        ),
        neither(
            "the Gemini sign-in",
            Some(ModelCredential::ProviderOAuth {
                provider: "google".into(),
                path: "/openbot/model-oauth.json".into(),
                proxy_token: "proxy".into(),
                model: "gemini-2.5-pro".into(),
            }),
        ),
        SignIn {
            said: "a Claude plan",
            credential: Some(ModelCredential::ClaudePlan {
                token: "sk-ant-oat-test".into(),
            }),
            chatgpt_plan: false,
            claude_plan: true,
        },
        SignIn {
            said: "a ChatGPT plan",
            credential: Some(ModelCredential::ChatGptPlan {
                store: "{\"access_token\":\"a\",\"refresh_token\":\"r\"}".into(),
            }),
            chatgpt_plan: true,
            claude_plan: false,
        },
    ]
}

fn names(images: &[String], repository: &str) -> bool {
    images.iter().any(|image| image.contains(repository))
}

/// The first screen downloads the default Bot's images before anybody has signed in, so it never
/// downloads either plan's: most people never sign in to one.
#[cfg(unix)]
#[test]
fn the_first_screen_downloads_neither_plan_image() {
    let release = laid_out("plan-image-first-screen");
    let compose = compose_stand_in(&release);
    let images = crate::early_downloads::named_images(&release, || Ok(compose.clone())).unwrap();
    assert!(names(&images, "openbot-server@"), "{images:?}");
    assert!(!names(&images, CHATGPT_PLAN), "{images:?}");
    assert!(!names(&images, CLAUDE_PLAN), "{images:?}");
    let _ = std::fs::remove_dir_all(&release);
}

/// Install pulls each plan's image only for that plan: API keys, the Gemini sign-in and an install
/// nobody has signed in to yet pull neither. A sign-in to a plan pulls its own (`main.rs`).
#[cfg(unix)]
#[test]
fn install_pulls_a_plan_image_only_for_its_plan() {
    let default = HarnessChoice {
        id: DEFAULT_HARNESS.into(),
        agent_url: None,
    };
    for sign_in in sign_ins() {
        let root = laid_out("plan-image-install");
        let compose = compose_stand_in(&root);
        if let Some(credential) = sign_in.credential {
            signed_in(&root, credential);
        }
        let images = super::installation_pull_set_by(
            |settings| crate::stack::standalone_compose_command(&compose, &root, settings),
            &root,
            &root,
            Some(&default),
        )
        .unwrap();
        let said = sign_in.said;
        assert_eq!(
            names(&images, CHATGPT_PLAN),
            sign_in.chatgpt_plan,
            "{said}: {images:?}"
        );
        assert_eq!(
            names(&images, CLAUDE_PLAN),
            sign_in.claude_plan,
            "{said}: {images:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// An installation on a ChatGPT plan from before the plan ran as a service beside the Bot: its
/// `.env` names the plan's token store and no service address, until the Start after the update
/// writes one. The update's Install pulls the plan's image for it, so that Start finds it.
#[cfg(unix)]
#[test]
fn an_update_over_a_chatgpt_plan_from_before_the_plan_service_pulls_its_image() {
    let root = laid_out("plan-image-update-older-plan");
    let compose = compose_stand_in(&root);
    std::fs::write(
        root.join(".env"),
        "OPENAI_API_KEY=\nCHATGPT_AUTH_FILE=/root/.langchain/chatgpt-auth.json\n",
    )
    .unwrap();
    let images = super::installation_pull_set_by(
        |settings| crate::stack::standalone_compose_command(&compose, &root, settings),
        &root,
        &root,
        Some(&HarnessChoice {
            id: "langgraph".into(),
            agent_url: None,
        }),
    )
    .unwrap();
    assert!(names(&images, CHATGPT_PLAN), "{images:?}");
    assert!(!names(&images, CLAUDE_PLAN), "{images:?}");
    let _ = std::fs::remove_dir_all(&root);
}

/// An update downloads the next release's images ahead of the Update click, by the images the last
/// install pulled. An installation from when every install pulled both plan images keeps them in
/// its record, and only that plan gets the next release's copy of each.
#[test]
fn an_update_downloads_a_plan_image_only_for_its_plan() {
    let next = crate::update_ready::Announced {
        openbot: "v9.9.9".into(),
        intelligence: "0.0.0".into(),
        images: [
            "openbot-server",
            "openbot-agent-langgraph-agui",
            "openbot-agent-claude-sdk",
        ]
        .iter()
        .map(|name| format!("ghcr.io/copilotkit/{name}@sha256:{}", "a".repeat(64)))
        .collect(),
    };
    for sign_in in sign_ins() {
        let root = laid_out("plan-image-update-ahead");
        if let Some(credential) = sign_in.credential {
            signed_in(&root, credential);
        }
        // What an install that always pulled both plan images recorded.
        let pulled = vec![
            crate::deployment::reference(&root, "server").unwrap(),
            crate::deployment::reference(&root, crate::plan::SIGN_IN_IMAGE).unwrap(),
            crate::deployment::reference(&root, crate::plan::CHATGPT_SIGN_IN_IMAGE).unwrap(),
        ];
        super::record(&root, None, pulled).unwrap();
        let runs = super::images_it_runs(&root).unwrap();
        let ahead = crate::update_ready::openbot_images(&runs, &next);
        let said = sign_in.said;
        assert_eq!(
            names(&ahead, CHATGPT_PLAN),
            sign_in.chatgpt_plan,
            "{said}: {ahead:?}"
        );
        assert_eq!(
            names(&ahead, CLAUDE_PLAN),
            sign_in.claude_plan,
            "{said}: {ahead:?}"
        );
        assert!(names(&ahead, "openbot-server@"), "{said}: {ahead:?}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
