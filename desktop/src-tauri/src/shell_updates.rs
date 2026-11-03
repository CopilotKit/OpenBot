//! Optional native application delivery. Runtime publisher policy never supplies the shell's key.
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone)]
pub struct Trust {
    pub public_key: String,
    pub endpoint: reqwest::Url,
}

pub fn trust(public_key: Option<&str>, endpoint: Option<&str>) -> Result<Option<Trust>, String> {
    match (
        public_key.filter(|v| !v.trim().is_empty()),
        endpoint.filter(|v| !v.trim().is_empty()),
    ) {
        (None, None) => Ok(None),
        (Some(public_key), Some(endpoint)) => {
            let endpoint = reqwest::Url::parse(endpoint).map_err(|e| e.to_string())?;
            if endpoint.scheme() != "https"
                || !endpoint.has_host()
                || !endpoint.username().is_empty()
                || endpoint.password().is_some()
                || endpoint.fragment().is_some()
            {
                return Err(
                    "shell update endpoint must use HTTPS without credentials or fragments".into(),
                );
            }
            Ok(Some(Trust {
                public_key: public_key.into(),
                endpoint,
            }))
        }
        _ => Err(
            "shell update delivery requires both a compiled public key and HTTPS endpoint".into(),
        ),
    }
}
pub fn compiled_trust() -> Result<Option<Trust>, String> {
    trust(
        option_env!("OPENBOT_SHELL_UPDATE_PUBLIC_KEY"),
        option_env!("OPENBOT_SHELL_UPDATE_ENDPOINT"),
    )
}
pub fn delivery_status() -> &'static str {
    if cfg!(feature = "shell-updater") && matches!(compiled_trust(), Ok(Some(_))) {
        "Signed desktop shell update support is configured; check application updates separately."
    } else {
        "Signed desktop shell update delivery is not configured."
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub configured: bool,
    pub available: bool,
    pub version: Option<String>,
    pub detail: String,
}
pub fn unavailable(detail: impl Into<String>) -> Status {
    Status {
        configured: false,
        available: false,
        version: None,
        detail: detail.into(),
    }
}

/// Tauri's artifact signature is checked by the plugin. Additional publisher identity is matched
/// to the shell build's own independent distribution policy, never to mutable runtime settings.
pub fn validate_identity(manifest: &Value) -> Result<(), String> {
    let distribution = crate::updates::compiled_distribution();
    let expected = json!({"id":distribution.distribution_id,"repository":distribution.repository,"channel":distribution.channel});
    if manifest["distribution"] != expected {
        return Err("native shell update publisher identity does not match this build".into());
    }
    Ok(())
}

#[cfg(feature = "shell-updater")]
pub async fn candidate<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let trust = compiled_trust()?
        .ok_or("Signed desktop shell updates are not configured in this build.")?;
    let update = app
        .updater_builder()
        .pubkey(trust.public_key)
        .endpoints(vec![trust.endpoint])
        .map_err(|e| e.to_string())?
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(update) = &update {
        validate_identity(&update.raw_json)?;
        if update.download_url.scheme() != "https"
            || !update.download_url.username().is_empty()
            || update.download_url.password().is_some()
        {
            return Err("native shell artifact URL must use HTTPS without credentials".into());
        }
    }
    Ok(update)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_updates_require_independent_https_trust() {
        assert!(trust(None, None).unwrap().is_none());
        assert!(trust(Some("synthetic-public-key"), None).is_err());
        for endpoint in [
            "http://updates.example/latest.json",
            "https://user:password@updates.example/latest.json",
            "https://updates.example/latest.json#fragment",
        ] {
            assert!(trust(Some("synthetic-public-key"), Some(endpoint)).is_err());
        }
        assert!(trust(
            Some("synthetic-public-key"),
            Some("https://updates.example/latest.json")
        )
        .unwrap()
        .is_some());
    }
    #[test]
    fn shell_updates_do_not_accept_runtime_candidate_policy_as_shell_trust() {
        let distribution = crate::updates::compiled_distribution();
        let expected = json!({"distribution":{"id":distribution.distribution_id,"repository":distribution.repository,"channel":distribution.channel}});
        validate_identity(&expected).unwrap();
        assert!(validate_identity(
            &json!({"distribution":{"id":"other","repository":"other/fork","channel":"stable"}})
        )
        .is_err());
    }
}
