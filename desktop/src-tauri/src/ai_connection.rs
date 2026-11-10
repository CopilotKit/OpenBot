//! Which AI provider and sign-in OpenBot starts with, for Settings in OpenBot's own page.
//!
//! Read from what Start recorded beside the installation (`saved_intent`): the kind of connection
//! chosen, the model named with it, and for a custom address, its host. Never a key, a token or a
//! whole address: the page only says which connection it is, and the setup window changes it.

use std::path::Path;

use crate::saved_intent::{ModelIntent, SavedIntent};

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConnection {
    /// The connection Start last saved; None before one was chosen.
    pub kind: Option<ModelIntent>,
    /// The model named on the setup screen. Only an address or a provider sign-in names one; with a
    /// key or a plan the server picks the provider's own.
    pub model: Option<String>,
    /// The host of a custom address, for the page to tell Gemini, xAI and Unbiased AI apart from
    /// a person's own server. Only the host: an address can carry a password or a key.
    pub endpoint_host: Option<String>,
}

/// What `root` starts with. Missing or unreadable records read as nothing chosen.
pub fn read(root: &Path) -> AiConnection {
    let kind = SavedIntent::read(root).model;
    let values = crate::vault::already_given_file_only(
        &root.join(".env"),
        &["BOT_MODEL", "OPENAI_BASE_URL"],
    );
    let named = |key: &str| {
        values
            .get(key)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    let model = matches!(
        kind,
        Some(ModelIntent::CompatibleEndpoint | ModelIntent::GoogleOauth | ModelIntent::XaiOauth)
    )
    .then(|| named("BOT_MODEL"))
    .flatten();
    let endpoint_host = (kind == Some(ModelIntent::CompatibleEndpoint))
        .then(|| named("OPENAI_BASE_URL"))
        .flatten()
        .and_then(|address| {
            tauri::Url::parse(&address)
                .ok()?
                .host_str()
                .map(str::to_owned)
        });
    AiConnection {
        kind,
        model,
        endpoint_host,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(name: &str, intent: &str, env: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "openbot-ai-connection-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !intent.is_empty() {
            std::fs::write(root.join(crate::saved_intent::FILE), intent).unwrap();
        }
        std::fs::write(root.join(".env"), env).unwrap();
        root
    }

    #[test]
    fn a_claude_plan_says_so_and_never_its_token() {
        let root = root(
            "claude-plan",
            r#"{"version":1,"categories":["claude-plan"],"model":"claude-plan"}"#,
            "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-secret\n",
        );
        let connection = read(&root);
        assert_eq!(connection.kind, Some(ModelIntent::ClaudePlan));
        assert_eq!(connection.model, None);
        let said = serde_json::to_string(&connection).unwrap();
        assert_eq!(
            said,
            r#"{"kind":"claude-plan","model":null,"endpointHost":null}"#
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_openai_api_key_says_so_and_never_the_key() {
        let root = root(
            "openai-key",
            r#"{"version":1,"categories":["open-ai-api-key"],"model":"open-ai-api-key"}"#,
            // A model left by hand is not what a key starts with: the server picks OpenAI's own.
            "OPENAI_API_KEY=sk-proj-secret\nBOT_MODEL=stale\n",
        );
        let said = serde_json::to_string(&read(&root)).unwrap();
        assert_eq!(
            said,
            r#"{"kind":"open-ai-api-key","model":null,"endpointHost":null}"#
        );
        assert!(!said.contains("secret"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_custom_address_gives_its_host_and_model_only() {
        let root = root(
            "compatible",
            r#"{"version":1,"categories":["compatible-endpoint-api-key"],"model":"compatible-endpoint","compatible_endpoint":"https://me:pw@api.x.ai/v1?key=k"}"#,
            "OPENAI_BASE_URL=https://me:pw@api.x.ai/v1?key=k\nBOT_MODEL=grok-4.7\nOPENAI_API_KEY=xai-secret\n",
        );
        let said = serde_json::to_string(&read(&root)).unwrap();
        assert_eq!(
            said,
            r#"{"kind":"compatible-endpoint","model":"grok-4.7","endpointHost":"api.x.ai"}"#
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nothing_chosen_reads_as_nothing() {
        let root = root("none", "", "");
        assert_eq!(read(&root), AiConnection::default());
        std::fs::remove_dir_all(root).unwrap();
    }
}
