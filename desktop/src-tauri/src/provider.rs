//! The model provider screen's list, as data.
//!
//! OpenAI and Anthropic offer plan sign-in alongside API keys. Google and xAI use named endpoint
//! presets with API keys; their official addresses are supplied by the frontend. Unbiased AI signs in
//! through its own device authorization, which ends in an API key for the same named endpoint
//! shape, so the key is then carried like a typed one.
//!
//! The row that asks for a URL is the last one, and it is the only one that asks. Keeping it there
//! is what keeps a base URL off the main path, which the audience rule at the top of the build doc
//! requires: somebody who has never opened a terminal finishes this screen by signing in.
//!
//! Independent of the harness picker, always. No harness on that list is tied to a vendor's models,
//! so nothing chosen there may narrow what is offered here.

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// When the Unbiased AI launch offer stops being announced: the end of November 2026, Pacific
/// time (2026-12-01T08:00:00Z). From then on the row reads as if it never carried one. The offer
/// itself is the platform's to end; this only stops the picker promising it.
const UNBIASED_OFFER_ENDS: u64 = 1_796_112_000;

/// How a person proves they may use a provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Login {
    /// Sign in to the plan they already pay for. The default wherever it exists.
    Plan,
    /// Paste a key. Offered beside the plan, never behind it.
    ApiKey,
    /// A base URL, a key and a model name. The developer row and the everything-else row at once.
    Endpoint,
    /// Browser authorization for the provider's model API, with renewable credentials.
    Oauth,
}

/// One row on the model screen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    /// Shown on every row, mark or no mark. See `mark`.
    pub name: String,
    pub summary: String,
    /// The ways in, in the order the screen offers them. First is the default.
    pub logins: Vec<Login>,
    /// The vendored icon's file stem, or `None` where no maintained set has one.
    ///
    /// A row with `None` is drawn with its name and nothing else. Nothing is invented to fill the
    /// space: a monogram somebody made up reads as the vendor's own mark.
    pub mark: Option<String>,
    /// One sentence the screen must show when this provider is chosen, and the page it links to.
    pub caution: Option<Caution>,
    /// A few words the row shows as a badge beside its name while the provider runs an offer,
    /// such as "50% off". Absent for every row with nothing to announce, and left out of the
    /// serialized row rather than sent as null, so the window treats it as optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promotion: Option<String>,
}

/// Something true about a provider that a person finds out too late otherwise.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Caution {
    pub says: String,
    pub reads_more_at: String,
}

pub fn catalogue() -> Vec<Provider> {
    catalogue_at(SystemTime::now())
}

/// The rows as of `now`, so an offer's end is a fact about time rather than about a release.
pub fn catalogue_at(now: SystemTime) -> Vec<Provider> {
    let launch_offer = now
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs() < UNBIASED_OFFER_ENDS)
        .unwrap_or(false);
    vec![
        Provider {
            id: "openai".into(),
            name: "OpenAI".into(),
            summary: "Sign in with ChatGPT Plus, Pro, Team or Enterprise.".into(),
            /*
             * A plan first, and this is the row where that is least controversial.
             *
             * OpenAI supports subscription OAuth in other people's tools: `codex login` exists for
             * it, third-party harnesses are a tenth of Codex traffic, and the login yields a token
             * plus the address to send it to, which is the compatible shape rather than a special
             * case. Of the two named providers it is the better-supported one, not the weaker.
             */
            logins: vec![Login::Plan, Login::ApiKey],
            mark: Some("openai".into()),
            caution: None,
            promotion: None,
        },
        Provider {
            id: "anthropic".into(),
            name: "Anthropic".into(),
            summary: "Sign in with a Claude Pro, Max, Team or Enterprise plan.".into(),
            logins: vec![Login::Plan, Login::ApiKey],
            mark: Some("anthropic".into()),
            /*
             * The one provider that can stop working part-way through a month for somebody who has
             * done nothing wrong, so it is said before it happens rather than diagnosed after. It
             * changes nothing else: same default, same flow, same list.
             */
            caution: Some(Caution {
                says: "A Claude plan carries a separate monthly pool of Agent SDK credits. \
                       When that pool is empty, Bots stop until it renews or you add API credits."
                    .into(),
                reads_more_at: "https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan"
                    .into(),
            }),
            promotion: None,
        },
        Provider {
            id: "google".into(),
            name: "Google Gemini".into(),
            summary: "Use a Google AI Studio key or sign in for Gemini API access.".into(),
            logins: vec![Login::Endpoint, Login::Oauth],
            mark: None,
            caution: None,
            promotion: None,
        },
        Provider {
            id: "xai".into(),
            name: "xAI".into(),
            summary: "Use an xAI API key or sign in to your xAI account.".into(),
            logins: vec![Login::Endpoint, Login::Oauth],
            mark: None,
            caution: None,
            promotion: None,
        },
        Provider {
            id: "unbiased".into(),
            name: "Unbiased AI".into(),
            summary: if launch_offer {
                "Sign in with Unbiased AI to use Pareto at 50% off for your first 3 months, or use an API key."
            } else {
                "Sign in with Unbiased AI to use Pareto, or use an API key."
            }
            .into(),
            /*
             * Sign-in first, because it is the whole point of the row: the person signs in or
             * creates an account in the browser and comes back holding a key they never saw.
             * The sign-in is a device authorization that ends in an API key for Unbiased AI's
             * OpenAI-compatible gateway, so what it produces is exactly what the API key tab
             * takes, and the key travels the same way from here on. The key tab is for somebody
             * who already made one in the Unbiased AI dashboard.
             */
            logins: vec![Login::Oauth, Login::Endpoint],
            mark: Some("unbiased".into()),
            caution: None,
            // The launch offer for accounts created through this sign-in, through November 2026.
            promotion: launch_offer.then(|| "50% off".into()),
        },
        Provider {
            id: "openai-compatible".into(),
            name: "Any OpenAI-compatible endpoint".into(),
            summary: "Azure, Bedrock, Mistral, DeepSeek, Ollama, vLLM or your own.".into(),
            logins: vec![Login::Endpoint],
            // Deliberately unmarked: it stands for every provider rather than one, so any single
            // vendor's logo here would be a lie about what the row does.
            mark: None,
            caution: None,
            promotion: None,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Named endpoint presets use API keys and never claim support for a subscription sign-in.
    #[test]
    fn endpoint_providers_do_not_offer_plan_sign_in() {
        let asking: Vec<String> = catalogue()
            .into_iter()
            .filter(|p| p.logins.contains(&Login::Endpoint))
            .map(|p| p.id)
            .collect();
        assert_eq!(
            asking,
            vec!["google", "xai", "unbiased", "openai-compatible"]
        );
        for provider in catalogue()
            .into_iter()
            .filter(|provider| provider.logins.contains(&Login::Endpoint))
        {
            assert!(!provider.logins.contains(&Login::Plan));
        }
    }

    /// Where a plan can stand in for a key, it is the default. Reordering these is a product change
    /// and has to look like one.
    #[test]
    fn a_plan_is_offered_before_a_key() {
        for provider in catalogue() {
            if provider.logins.contains(&Login::Plan) {
                assert_eq!(
                    provider.logins.first(),
                    Some(&Login::Plan),
                    "{} offers a plan but not first",
                    provider.id
                );
            }
        }
    }

    /// Named providers stay ahead of the custom endpoint escape hatch.
    #[test]
    fn five_named_providers_and_one_custom_endpoint() {
        let rows = catalogue();
        let ids: Vec<&str> = rows.iter().map(|provider| provider.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "openai",
                "anthropic",
                "google",
                "xai",
                "unbiased",
                "openai-compatible"
            ]
        );
    }

    /// Unbiased AI's sign-in mints an API key, so the row leads with it and never asks for a plan.
    #[test]
    fn unbiased_signs_in_before_asking_for_a_key() {
        let unbiased = catalogue()
            .into_iter()
            .find(|p| p.id == "unbiased")
            .expect("unbiased is not offered");
        assert_eq!(unbiased.logins, vec![Login::Oauth, Login::Endpoint]);
        assert_eq!(unbiased.name, "Unbiased AI");
    }

    /// A second before the offer ends, and the second it does.
    fn offer_edge(seconds_before: u64) -> SystemTime {
        UNIX_EPOCH + std::time::Duration::from_secs(UNBIASED_OFFER_ENDS - seconds_before)
    }

    /// The launch offer is announced on the one row that carries it, and nowhere else.
    #[test]
    fn only_unbiased_announces_a_promotion() {
        for provider in catalogue_at(offer_edge(1)) {
            assert_eq!(
                provider.promotion.as_deref(),
                (provider.id == "unbiased").then_some("50% off"),
                "{} promotion",
                provider.id
            );
        }
    }

    /// The offer ends with November 2026: from the first second of December (Pacific) the row
    /// announces nothing and its summary no longer names the discount, with no release needed.
    #[test]
    fn the_launch_offer_ends_with_november_2026() {
        let before = catalogue_at(offer_edge(1));
        let unbiased = before.iter().find(|p| p.id == "unbiased").unwrap();
        assert_eq!(unbiased.promotion.as_deref(), Some("50% off"));
        assert!(unbiased.summary.contains("50% off for your first 3 months"));

        let after = catalogue_at(offer_edge(0));
        let unbiased = after.iter().find(|p| p.id == "unbiased").unwrap();
        assert_eq!(unbiased.promotion, None);
        assert!(!unbiased.summary.contains("50%"), "{}", unbiased.summary);
        assert!(after.iter().all(|p| p.promotion.is_none()));
        // Nothing else about the row moves with the date.
        assert_eq!(unbiased.name, "Unbiased AI");
        assert_eq!(unbiased.logins, vec![Login::Oauth, Login::Endpoint]);
        assert_eq!(after.len(), before.len());
        // The date is the one that was agreed: 2026-12-01T08:00:00Z, the end of November, Pacific.
        assert_eq!(UNBIASED_OFFER_ENDS, 1_796_112_000);
    }

    /// A row with nothing to announce serializes without the field, so the window's optional
    /// `promotion` stays absent rather than null.
    #[test]
    fn a_missing_promotion_is_left_out_of_the_row() {
        let rows = serde_json::to_value(catalogue_at(offer_edge(1))).unwrap();
        assert!(rows[0].get("promotion").is_none());
        assert_eq!(
            rows.as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == "unbiased")
                .unwrap()["promotion"],
            "50% off"
        );
    }

    /// Every row is readable without recognising a logo.
    #[test]
    fn every_row_has_a_name() {
        for provider in catalogue() {
            assert!(
                !provider.name.trim().is_empty(),
                "{} has no name",
                provider.id
            );
        }
    }

    /// The Anthropic sentence is required, because it is the one thing about that plan a person
    /// cannot discover until their Bots stop answering.
    #[test]
    fn anthropic_says_what_the_plan_actually_buys() {
        let anthropic = catalogue()
            .into_iter()
            .find(|p| p.id == "anthropic")
            .expect("anthropic is not offered");
        let caution = anthropic.caution.expect("anthropic carries no caution");
        assert!(caution.says.contains("Agent SDK credits"));
        assert!(caution.reads_more_at.starts_with("https://"));
    }
}
