//! Optional native application delivery: a `shell-updater` build's compiled trust supplies the
//! updater's `plugins.updater` block when the bundle carries none. Runtime publisher policy never
//! supplies the shell's key. Checking and installing go through `app_update`, as in every build.
use serde_json::json;
#[cfg(test)]
use serde_json::Value;

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
/// Whether to register the updater plugin, making sure the configuration it reads exists first.
///
/// Registering `tauri_plugin_updater` makes Tauri deserialize `plugins.updater` into the plugin's
/// `Config`, which requires a `pubkey`. With no such block that is `null`, the registration fails,
/// and the app panicked at launch. A bundled block (a distributor's `tauri.conf.json`) is used as
/// it is; otherwise this build's compiled trust supplies one; with neither, the plugin is not
/// registered and the build is offered no updates (`app_update::Feed::of`). One answer, so one
/// registration.
pub fn configure_plugin(
    plugins: &mut tauri::utils::config::PluginConfig,
    trust: Option<&Trust>,
) -> bool {
    if plugins
        .0
        .get("updater")
        .is_some_and(|block| !block.is_null())
    {
        return true;
    }
    let Some(trust) = trust else {
        return false;
    };
    plugins.0.insert(
        "updater".into(),
        json!({"pubkey": trust.public_key, "endpoints": [trust.endpoint.as_str()]}),
    );
    true
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
    /// The `plugins` block of `tauri.conf.json` with each overlay merged over it the way
    /// `tauri build --config` does.
    fn plugins_from(files: &[&str]) -> tauri::utils::config::PluginConfig {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut plugins = serde_json::Map::new();
        for file in files {
            let config: Value =
                serde_json::from_slice(&std::fs::read(directory.join(file)).unwrap()).unwrap();
            if let Some(found) = config["plugins"].as_object() {
                plugins.extend(found.clone());
            }
        }
        serde_json::from_value(Value::Object(plugins)).unwrap()
    }

    /// The `plugins` block a shell-updater build actually ships: `tauri.conf.json`, with
    /// `tauri.updater.conf.json` merged over it.
    #[cfg(feature = "shell-updater")]
    fn shipped_plugins() -> tauri::utils::config::PluginConfig {
        plugins_from(&["tauri.conf.json", "tauri.updater.conf.json"])
    }

    /// The default build has no updater, and the signed Mac build has one, decided by its
    /// overlay alone. `main` registers the plugin from this answer and nowhere else.
    #[test]
    fn updater_registers_only_where_the_signed_overlay_configures_it() {
        assert!(!plugins_from(&["tauri.conf.json"]).0.contains_key("updater"));
        assert!(
            plugins_from(&["tauri.conf.json", "tauri.macos-signing.conf.json"])
                .0
                .contains_key("updater")
        );
    }

    /// One registration: the updater plugin is built in exactly one place in `main`, behind
    /// its `plugins.updater` check, whichever of the signed overlay and `shell-updater` supplied
    /// the block. A second registration would silently replace the first and hide which
    /// configuration is in effect.
    #[test]
    fn updater_plugin_is_registered_in_one_place() {
        let main = include_str!("main.rs");
        assert_eq!(main.matches("tauri_plugin_updater::Builder").count(), 1);
        let at = main.find("tauri_plugin_updater::Builder").unwrap();
        assert!(main[..at]
            .rfind("if app.config().plugins.0.contains_key(\"updater\")")
            .is_some_and(|guard| at - guard < 200));
    }

    /// The signed overlay together with `shell-updater` compiled trust: the bundled block is
    /// kept as written, so the one registration uses the signed build key and feed.
    #[cfg(feature = "shell-updater")]
    #[test]
    fn signed_overlay_wins_over_compiled_trust_with_one_registration() {
        let compiled = trust(
            Some("synthetic-public-key"),
            Some("https://updates.example/latest.json"),
        )
        .unwrap()
        .unwrap();
        let signed = plugins_from(&["tauri.conf.json", "tauri.macos-signing.conf.json"]);
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins = signed.clone();
        assert!(configure_plugin(
            &mut context.config_mut().plugins,
            Some(&compiled)
        ));
        assert_eq!(context.config().plugins.0["updater"], signed.0["updater"]);
        let app = tauri::test::mock_builder().build(context).unwrap();
        assert!(app.config().plugins.0.contains_key("updater"));
        app.handle()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .expect("the updater plugin initializes from the signed overlay");
    }

    #[test]
    fn shell_updates_plugin_configuration_follows_bundle_then_compiled_trust() {
        let trust = trust(
            Some("synthetic-public-key"),
            Some("https://updates.example/latest.json"),
        )
        .unwrap()
        .unwrap();
        let mut empty = tauri::utils::config::PluginConfig::default();
        assert!(!configure_plugin(&mut empty, None));
        assert!(empty.0.is_empty());
        assert!(configure_plugin(&mut empty, Some(&trust)));
        assert_eq!(
            empty.0["updater"],
            json!({"pubkey":"synthetic-public-key","endpoints":["https://updates.example/latest.json"]})
        );
        // A distributor's own block is kept as written, and still means one registration.
        let bundled =
            json!({"pubkey":"bundled-key","endpoints":["https://bundled.example/latest.json"]});
        let mut configured = tauri::utils::config::PluginConfig::default();
        configured.0.insert("updater".into(), bundled.clone());
        assert!(configure_plugin(&mut configured, Some(&trust)));
        assert!(configure_plugin(&mut configured, None));
        assert_eq!(configured.0["updater"], bundled);
    }

    /// Every `shell-updater` build panicked at launch: the plugin was registered with no
    /// `plugins.updater` block, so Tauri handed it `null` for a config that requires a `pubkey`.
    /// This registers the real plugin on a real (mock-runtime) app with the shipped configuration,
    /// exactly as `main` does, with and without compiled trust.
    #[cfg(feature = "shell-updater")]
    #[test]
    fn shell_updates_plugin_registers_with_shipped_configuration() {
        use tauri_plugin_updater::UpdaterExt;
        let compiled = trust(
            Some("synthetic-public-key"),
            Some("https://updates.example/latest.json"),
        )
        .unwrap()
        .unwrap();
        for trust in [None, Some(compiled)] {
            let mut context = tauri::test::mock_context(tauri::test::noop_assets());
            context.config_mut().plugins = shipped_plugins();
            let register = configure_plugin(&mut context.config_mut().plugins, trust.as_ref());
            let app = tauri::test::mock_builder().build(context).unwrap();
            if register {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())
                    .expect("the updater plugin initializes from the shipped configuration");
                app.updater_builder()
                    .build()
                    .expect("the registered updater builds");
            }
            assert_eq!(
                register,
                trust.is_some() || shipped_plugins().0.contains_key("updater")
            );
        }
    }
}
