/*!
Which sign-in downloads the Python LangGraph image (`plan::CHATGPT_PLAN_SERVICE`).

The default Bot is the TypeScript LangGraph engine. The Python image runs only on a ChatGPT plan,
beside that Bot, as the plan's model service. A Windows install on an API key still downloaded it
ahead of Install, pulled it at Install, and had its update download the next release's copy, and it
never ran. Each path that decides what to download is driven here as the app drives it, with the
`.env` each sign-in's Start writes (`env::compose`, `env::write`):

- the first screen's early download, before anybody has signed in (`early_downloads::named_images`);
- Install, and the Install an update makes before its Start (`installation_pull_set_by`);
- the download an update makes ahead of the Update click (`images_it_runs`, `update_ready`).
*/

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::env::{Intelligence, Model, ModelCredential, Ports};
use crate::harness::{HarnessChoice, DEFAULT_HARNESS};

const PLAN_REPOSITORY: &str = "openbot-agent-langgraph-agui@";

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
/// an image. The plan's service is answered with the release's own reference, as Compose reads it
/// from `LANGGRAPH_IMAGE`.
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

/// The `.env` Start writes for `credential`, written where Start writes it.
fn signed_in(root: &Path, credential: ModelCredential) {
    let settings = crate::env::compose(
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
        None,
        &BTreeMap::new(),
    );
    crate::env::write(&root.join(".env"), &settings, &BTreeMap::new()).unwrap();
}

/// Every sign-in the model screen offers, and whether it runs the plan's service.
fn sign_ins() -> Vec<(&'static str, Option<ModelCredential>, bool)> {
    vec![
        ("nothing yet, a first install", None, false),
        (
            "an OpenAI key",
            Some(ModelCredential::OpenAi {
                api_key: "sk-test".into(),
            }),
            false,
        ),
        (
            "an Anthropic key",
            Some(ModelCredential::Anthropic {
                api_key: "sk-ant-api-test".into(),
            }),
            false,
        ),
        (
            "a Claude plan",
            Some(ModelCredential::ClaudePlan {
                token: "sk-ant-oat-test".into(),
            }),
            false,
        ),
        (
            "the Gemini sign-in",
            Some(ModelCredential::ProviderOAuth {
                provider: "google".into(),
                path: "/openbot/model-oauth.json".into(),
                proxy_token: "proxy".into(),
                model: "gemini-2.5-pro".into(),
            }),
            false,
        ),
        (
            "a ChatGPT plan",
            Some(ModelCredential::ChatGptPlan {
                store: "{\"access_token\":\"a\",\"refresh_token\":\"r\"}".into(),
            }),
            true,
        ),
    ]
}

fn names_the_plan_image(images: &[String]) -> bool {
    images.iter().any(|image| image.contains(PLAN_REPOSITORY))
}

/// The first screen downloads the default Bot's images before anybody has signed in, so it never
/// downloads the plan's: most people never sign in to one.
#[cfg(unix)]
#[test]
fn the_first_screen_never_downloads_the_chatgpt_plan_image() {
    let release = laid_out("plan-image-first-screen");
    let compose = compose_stand_in(&release);
    let images = crate::early_downloads::named_images(&release, || Ok(compose.clone())).unwrap();
    assert!(
        images.iter().any(|image| image.contains("openbot-server@")),
        "{images:?}"
    );
    assert!(
        images
            .iter()
            .any(|image| image.contains("openbot-agent-claude-sdk@")),
        "the Claude sign-in image still comes ahead: {images:?}"
    );
    assert!(!names_the_plan_image(&images), "{images:?}");
    let _ = std::fs::remove_dir_all(&release);
}

/// Install pulls the plan's image only for a ChatGPT plan: every other sign-in leaves it out, and
/// so does an install nobody has signed in to yet. The ChatGPT sign-in pulls it itself.
#[cfg(unix)]
#[test]
fn install_pulls_the_chatgpt_plan_image_only_on_a_chatgpt_plan() {
    let default = HarnessChoice {
        id: DEFAULT_HARNESS.into(),
        agent_url: None,
    };
    for (said, credential, plan) in sign_ins() {
        let root = laid_out("plan-image-install");
        let compose = compose_stand_in(&root);
        if let Some(credential) = credential {
            signed_in(&root, credential);
        }
        let images = super::installation_pull_set_by(
            |settings| crate::stack::standalone_compose_command(&compose, &root, settings),
            &root,
            &root,
            Some(&default),
        )
        .unwrap();
        assert_eq!(names_the_plan_image(&images), plan, "{said}: {images:?}");
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
    assert!(names_the_plan_image(&images), "{images:?}");
    let _ = std::fs::remove_dir_all(&root);
}

/// An update downloads the next release's images ahead of the Update click, by the images the last
/// install pulled. An installation from when every install pulled the plan's image keeps that image
/// in its record, and only a ChatGPT plan gets the next release's copy.
#[test]
fn an_update_downloads_the_next_chatgpt_plan_image_only_on_a_chatgpt_plan() {
    let next = crate::update_ready::Announced {
        openbot: "v9.9.9".into(),
        intelligence: "0.0.0".into(),
        images: vec![
            format!(
                "ghcr.io/copilotkit/openbot-server@sha256:{}",
                "a".repeat(64)
            ),
            format!(
                "ghcr.io/copilotkit/openbot-agent-langgraph-agui@sha256:{}",
                "a".repeat(64)
            ),
            format!(
                "ghcr.io/copilotkit/openbot-agent-claude-sdk@sha256:{}",
                "a".repeat(64)
            ),
        ],
    };
    for (said, credential, plan) in sign_ins() {
        let root = laid_out("plan-image-update-ahead");
        if let Some(credential) = credential {
            signed_in(&root, credential);
        }
        // What an install that always pulled the plan's image recorded.
        let pulled = vec![
            crate::deployment::reference(&root, "server").unwrap(),
            crate::deployment::reference(&root, crate::plan::SIGN_IN_IMAGE).unwrap(),
            crate::deployment::reference(&root, crate::plan::CHATGPT_SIGN_IN_IMAGE).unwrap(),
        ];
        super::record(&root, None, pulled).unwrap();
        let runs = super::images_it_runs(&root).unwrap();
        let ahead = crate::update_ready::openbot_images(&runs, &next);
        assert_eq!(names_the_plan_image(&ahead), plan, "{said}: {ahead:?}");
        assert!(
            ahead.iter().any(|image| image.contains("openbot-server@")),
            "{said}: {ahead:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
