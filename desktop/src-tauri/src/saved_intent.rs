//! Root-local hints about credentials explicitly saved by Start. No protected-store discovery.
//! A hint records past persistence, never current authentication or the outcome of starting services.
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::env::ModelCredential;
use crate::problem::Problem;

pub const FILE: &str = ".openbot-saved.json";

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "kebab-case")]
pub enum Category {
    Intelligence,
    OpenAiApiKey,
    AnthropicApiKey,
    ClaudePlan,
    ChatGptPlan,
}

// A closed enum intentionally cannot contain fields from the secret-bearing ChosenModel request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelIntent {
    OpenAiApiKey,
    AnthropicApiKey,
    ClaudePlan,
    ChatGptPlan,
    CompatibleEndpoint,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedIntent {
    version: u8,
    pub categories: BTreeSet<Category>,
    pub model: Option<ModelIntent>,
}

impl Default for SavedIntent {
    fn default() -> Self {
        Self {
            version: 1,
            categories: BTreeSet::new(),
            model: None,
        }
    }
}

impl SavedIntent {
    /// Missing, unreadable and invalid records are unknown. Never discover or migrate secrets here.
    pub fn read(root: &Path) -> Self {
        std::fs::read(root.join(FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Self>(&bytes).ok())
            .filter(|record| record.version == 1)
            .unwrap_or_default()
    }

    fn record(&mut self, secrets: &BTreeMap<String, String>, credential: &ModelCredential) {
        for (key, category) in [
            ("INTELLIGENCE_API_KEY", Category::Intelligence),
            ("OPENAI_API_KEY", Category::OpenAiApiKey),
            ("ANTHROPIC_API_KEY", Category::AnthropicApiKey),
            ("CLAUDE_CODE_OAUTH_TOKEN", Category::ClaudePlan),
        ] {
            if let Some(value) = secrets.get(key) {
                if value.trim().is_empty() {
                    self.categories.remove(&category);
                } else {
                    self.categories.insert(category);
                }
            }
        }
        // Compatible endpoints share the legacy OPENAI_API_KEY slot, but that key was not
        // established for the OpenAI provider. Keep its recorded hint out of that provider's UI.
        if matches!(credential, ModelCredential::Compatible { .. }) {
            self.categories.remove(&Category::OpenAiApiKey);
        }
        // write_plan_store persists the selected plan, and clears it for other selections.
        if matches!(credential, ModelCredential::None) {
            return;
        }
        self.categories.remove(&Category::ChatGptPlan);
        self.model = Some(match credential {
            ModelCredential::None => unreachable!("no model selection was handled above"),
            ModelCredential::OpenAi { .. } => ModelIntent::OpenAiApiKey,
            ModelCredential::Anthropic { .. } => ModelIntent::AnthropicApiKey,
            ModelCredential::ClaudePlan { .. } => ModelIntent::ClaudePlan,
            ModelCredential::ChatGptPlan { store } => {
                if !store.trim().is_empty() {
                    self.categories.insert(Category::ChatGptPlan);
                }
                ModelIntent::ChatGptPlan
            }
            ModelCredential::Compatible { .. } => ModelIntent::CompatibleEndpoint,
        });
    }

    fn write(&self, root: &Path) -> std::io::Result<()> {
        crate::env::write_private_file(&root.join(FILE), &serde_json::to_vec(self)?)
    }
}

/// Start's credential transaction: protected writes, plan file, durable hints, then legacy purge.
/// On any persistence failure the old .env remains migration input for an explicit retry.
pub fn persist_configuration(
    root: &Path,
    settings: &BTreeMap<String, String>,
    secrets: &BTreeMap<String, String>,
    purge: &BTreeMap<String, String>,
    credential: &ModelCredential,
) -> Result<(), Problem> {
    persist_configuration_with(
        root,
        settings,
        secrets,
        purge,
        credential,
        crate::vault::remember_all,
    )
}

fn persist_configuration_with(
    root: &Path,
    settings: &BTreeMap<String, String>,
    secrets: &BTreeMap<String, String>,
    purge: &BTreeMap<String, String>,
    credential: &ModelCredential,
    remember: impl FnOnce(&Path, &BTreeMap<String, String>) -> Result<(), Problem>,
) -> Result<(), Problem> {
    remember(root, secrets)?;
    crate::env::write_plan_store(root, credential).map_err(|error| {
        Problem::with(
            "OpenBot could not save the model sign-in. Try Start again.",
            error.to_string(),
        )
    })?;
    let mut intent = SavedIntent::read(root);
    intent.record(secrets, credential);
    intent.write(root).map_err(|error| Problem::with(
        "OpenBot could not record the saved connections. Your previous settings are kept; try Start again.",
        error.to_string(),
    ))?;
    crate::env::write(&root.join(".env"), settings, purge)
        .map_err(|error| Problem::with("OpenBot could not write its settings.", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    fn fixture(label: &str) -> (std::path::PathBuf, BTreeMap<String, String>, String) {
        let root = temp_root(label);
        std::fs::create_dir_all(&root).unwrap();
        let secrets = BTreeMap::from([
            (
                "INTELLIGENCE_API_KEY".into(),
                "synthetic-intelligence".into(),
            ),
            ("OPENAI_API_KEY".into(), "synthetic-model".into()),
        ]);
        let legacy = "INTELLIGENCE_API_KEY=synthetic-intelligence\nOPENAI_API_KEY=synthetic-model\nCUSTOM=kept\n".to_string();
        std::fs::write(root.join(".env"), &legacy).unwrap();
        (root, secrets, legacy)
    }

    #[test]
    fn missing_malformed_unsupported_and_unexpected_fields_are_unknown() {
        let root = temp_root("unknown-intent");
        std::fs::create_dir_all(&root).unwrap();
        assert!(SavedIntent::read(&root).categories.is_empty());
        for input in [
            "not-json",
            "{}",
            r#"{"version":2,"categories":["intelligence"],"model":null}"#,
            r#"{"version":1,"categories":["unrecognized"],"model":null}"#,
            r#"{"version":1,"categories":["intelligence"],"model":null,"token":"synthetic"}"#,
            r#"{"version":1,"categories":[],"model":{"provider":"openai","token":"synthetic"}}"#,
        ] {
            std::fs::write(root.join(FILE), input).unwrap();
            let unknown = SavedIntent::read(&root);
            assert!(unknown.categories.is_empty());
            assert_eq!(unknown.model, None);
        }
        std::fs::remove_file(root.join(FILE)).unwrap();
        std::fs::create_dir(root.join(FILE)).unwrap();
        assert!(SavedIntent::read(&root).categories.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn each_persistence_failure_preserves_legacy_input_and_can_be_retried() {
        for failure in ["first-store", "later-store", "plan-file", "metadata"] {
            let (root, secrets, legacy) = fixture(failure);
            let credential = ModelCredential::ChatGptPlan {
                store: "{\"refresh_token\":\"synthetic-plan\"}".into(),
            };
            if failure == "plan-file" {
                std::fs::write(root.join(".langchain"), "synthetic blocker").unwrap();
            }
            if failure == "metadata" {
                std::fs::create_dir(root.join(FILE)).unwrap();
            }
            let mut persisted = BTreeMap::new();
            let mut attempts = 0;
            let problem = persist_configuration_with(
                &root,
                &BTreeMap::new(),
                &secrets,
                &secrets,
                &credential,
                |seen_root, all| {
                    assert_eq!(seen_root, root);
                    crate::vault::remember_all_with(
                        seen_root,
                        all,
                        &mut |store_root, key, value| {
                            assert_eq!(store_root, root);
                            attempts += 1;
                            if (failure == "first-store" && attempts == 1)
                                || (failure == "later-store" && attempts == 2)
                            {
                                return Err(Problem::plain("synthetic protected write refused"));
                            }
                            persisted.insert(key.to_string(), value.to_string());
                            Ok(())
                        },
                        &mut |_, _| panic!("fixture has no deletions"),
                    )
                },
            )
            .expect_err("the selected persistence boundary must fail");
            assert!(!problem.said.is_empty());
            assert_eq!(std::fs::read_to_string(root.join(".env")).unwrap(), legacy);
            assert!(!root.join(FILE).is_file());
            if failure.ends_with("store") {
                assert!(!root.join(crate::env::CHATGPT_STORE_FILE).exists());
            }
            if failure == "plan-file" {
                std::fs::remove_file(root.join(".langchain")).unwrap();
            }
            if failure == "metadata" {
                std::fs::remove_dir(root.join(FILE)).unwrap();
            }
            persist_configuration_with(
                &root,
                &BTreeMap::new(),
                &secrets,
                &secrets,
                &credential,
                |seen_root, all| {
                    assert_eq!(seen_root, root);
                    persisted.extend(all.clone());
                    Ok(())
                },
            )
            .unwrap();
            let written = std::fs::read_to_string(root.join(".env")).unwrap();
            assert!(written.contains("CUSTOM=kept"));
            assert!(!written.contains("synthetic"));
            assert_eq!(
                SavedIntent::read(&root).model,
                Some(ModelIntent::ChatGptPlan)
            );
            assert!(SavedIntent::read(&root)
                .categories
                .contains(&Category::ChatGptPlan));
            assert!(crate::env::saved_chatgpt_plan_store(&root));
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn secure_stage_refusal_preserves_existing_plan_intent_and_legacy_bytes() {
        for failure in ["first-save", "later-save", "delete", "restore-policy"] {
            let (root, mut secrets, legacy) = fixture(failure);
            let credential = ModelCredential::ChatGptPlan {
                store: "synthetic-new-plan".into(),
            };
            let plan = root.join(crate::env::CHATGPT_STORE_FILE);
            std::fs::create_dir_all(plan.parent().unwrap()).unwrap();
            std::fs::write(&plan, "synthetic-original-plan").unwrap();
            std::fs::write(root.join(FILE), "synthetic-original-intent").unwrap();
            if failure == "delete" {
                secrets.insert("ANTHROPIC_API_KEY".into(), String::new());
            }
            let mut attempts = 0;
            let result = persist_configuration_with(
                &root,
                &BTreeMap::new(),
                &secrets,
                &secrets,
                &credential,
                |seen_root, all| {
                    assert_eq!(seen_root, root);
                    crate::vault::remember_all_with(
                        seen_root,
                        all,
                        &mut |store_root, _, _| {
                            assert_eq!(store_root, root);
                            attempts += 1;
                            if failure == "first-save"
                                || failure == "restore-policy"
                                || (failure == "later-save" && attempts == 2)
                            {
                                Err(Problem::plain(format!("synthetic {failure} refusal")))
                            } else {
                                Ok(())
                            }
                        },
                        &mut |store_root, _| {
                            assert_eq!(store_root, root);
                            Err(Problem::plain("synthetic delete refusal"))
                        },
                    )
                },
            );
            assert!(result.is_err(), "{failure}");
            assert_eq!(std::fs::read_to_string(root.join(".env")).unwrap(), legacy);
            assert_eq!(
                std::fs::read_to_string(&plan).unwrap(),
                "synthetic-original-plan"
            );
            assert_eq!(
                std::fs::read_to_string(root.join(FILE)).unwrap(),
                "synthetic-original-intent"
            );
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn persist_configuration_remembers_secrets_under_the_selected_root() {
        let (root, secrets, _) = fixture("selected-root-persist");
        let credential = ModelCredential::OpenAi {
            api_key: "synthetic-openai".into(),
        };
        let mut remembered_root = None;
        let mut remembered = BTreeMap::new();

        persist_configuration_with(
            &root,
            &BTreeMap::new(),
            &secrets,
            &secrets,
            &credential,
            |seen_root, seen_secrets| {
                remembered_root = Some(seen_root.to_path_buf());
                remembered = seen_secrets.clone();
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(remembered_root.as_deref(), Some(root.as_path()));
        assert_eq!(remembered, secrets);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn successful_reuse_records_only_categories_and_scoped_model_intent_on_restart() {
        for (credential, key, category, model) in [
            (
                ModelCredential::OpenAi {
                    api_key: "synthetic-openai".into(),
                },
                "OPENAI_API_KEY",
                Category::OpenAiApiKey,
                ModelIntent::OpenAiApiKey,
            ),
            (
                ModelCredential::Anthropic {
                    api_key: "synthetic-anthropic".into(),
                },
                "ANTHROPIC_API_KEY",
                Category::AnthropicApiKey,
                ModelIntent::AnthropicApiKey,
            ),
            (
                ModelCredential::ClaudePlan {
                    token: "synthetic-claude".into(),
                },
                "CLAUDE_CODE_OAUTH_TOKEN",
                Category::ClaudePlan,
                ModelIntent::ClaudePlan,
            ),
            (
                ModelCredential::ChatGptPlan {
                    store: "{\"refresh_token\":\"synthetic-chatgpt\"}".into(),
                },
                "",
                Category::ChatGptPlan,
                ModelIntent::ChatGptPlan,
            ),
        ] {
            let root = temp_root("recorded-reuse");
            std::fs::create_dir_all(&root).unwrap();
            let mut secrets = BTreeMap::from([(
                "INTELLIGENCE_API_KEY".into(),
                "synthetic-intelligence".into(),
            )]);
            if !key.is_empty() {
                secrets.insert(key.into(), "synthetic-selected-secret".into());
            }
            persist_configuration_with(
                &root,
                &BTreeMap::new(),
                &secrets,
                &secrets,
                &credential,
                |seen_root, _| {
                    assert_eq!(seen_root, root);
                    Ok(())
                },
            )
            .unwrap();
            let reopened = SavedIntent::read(&root);
            assert_eq!(reopened.model, Some(model));
            assert_eq!(
                reopened.categories,
                BTreeSet::from([Category::Intelligence, category])
            );
            let json = std::fs::read_to_string(root.join(FILE)).unwrap();
            assert!(!json.contains("synthetic"));
            assert!(!json.contains("token"));
            assert!(serde_json::from_str::<SavedIntent>(&json).is_ok());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    std::fs::metadata(root.join(FILE))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
                assert_eq!(
                    std::fs::metadata(root.join(crate::env::CHATGPT_STORE_FILE))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
            }
            // Losing the protected value later cannot be discovered passively. It remains a hint.
            assert_eq!(SavedIntent::read(&root).model, Some(model));
            let other = temp_root("different-root");
            assert!(SavedIntent::read(&other).categories.is_empty());
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn compatible_endpoint_key_does_not_record_an_openai_provider_hint() {
        let (root, secrets, _) = fixture("compatible-intent");
        let credential = ModelCredential::Compatible {
            base_url: "https://synthetic-model.example".into(),
            api_key: "synthetic-endpoint-key".into(),
            model: "synthetic-model".into(),
        };
        persist_configuration_with(
            &root,
            &BTreeMap::new(),
            &secrets,
            &secrets,
            &credential,
            |seen_root, _| {
                assert_eq!(seen_root, root);
                Ok(())
            },
        )
        .unwrap();
        let recorded = SavedIntent::read(&root);
        assert_eq!(recorded.model, Some(ModelIntent::CompatibleEndpoint));
        assert!(!recorded.categories.contains(&Category::OpenAiApiKey));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saved_credentials_remain_recorded_if_later_settings_write_fails() {
        let root = temp_root("post-persistence-settings-failure");
        std::fs::create_dir_all(root.join(".env")).unwrap();
        let secrets =
            BTreeMap::from([("CLAUDE_CODE_OAUTH_TOKEN".into(), "synthetic-claude".into())]);
        let credential = ModelCredential::ClaudePlan {
            token: "synthetic-claude".into(),
        };
        let problem = persist_configuration_with(
            &root,
            &BTreeMap::new(),
            &secrets,
            &secrets,
            &credential,
            |seen_root, _| {
                assert_eq!(seen_root, root);
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(problem.said, "OpenBot could not write its settings.");
        assert_eq!(
            SavedIntent::read(&root).model,
            Some(ModelIntent::ClaudePlan)
        );
        assert!(SavedIntent::read(&root)
            .categories
            .contains(&Category::ClaudePlan));
        std::fs::remove_dir_all(root).unwrap();
    }
}
