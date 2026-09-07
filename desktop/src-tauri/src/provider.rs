//! The model provider screen's list, as data.
//!
//! Two providers are first-class and everything else is one row. That is not a shortlist waiting to
//! be grown: it is the shape, and growing it is how this screen turns into a directory nobody
//! maintains. Most people have a plan with one of two companies; everybody else has something that
//! speaks the OpenAI wire format, because at this point everything does.
//!
//! The row that asks for a URL is the last one, and it is the only one that asks. Keeping it there
//! is what keeps a base URL off the main path, which the audience rule at the top of the build doc
//! requires: somebody who has never opened a terminal finishes this screen by signing in.
//!
//! Independent of the harness picker, always. No harness on that list is tied to a vendor's models,
//! so nothing chosen there may narrow what is offered here.

use serde::{Deserialize, Serialize};

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
}

/// Something true about a provider that a person finds out too late otherwise.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Caution {
    pub says: String,
    pub reads_more_at: String,
}

pub fn catalogue() -> Vec<Provider> {
    vec![
        Provider {
            id: "openai".into(),
            name: "OpenAI".into(),
            summary: "Sign in with ChatGPT Plus, Pro, Team or Enterprise.".into(),
            logins: vec![Login::Plan, Login::ApiKey],
            mark: Some("openai".into()),
            caution: None,
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
        },
        Provider {
            id: "openai-compatible".into(),
            name: "Any OpenAI-compatible endpoint".into(),
            summary: "Azure, Bedrock, Mistral, DeepSeek, xAI, Ollama, vLLM or your own.".into(),
            logins: vec![Login::Endpoint],
            // Deliberately unmarked: it stands for every provider rather than one, so any single
            // vendor's logo here would be a lie about what the row does.
            mark: None,
            caution: None,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The audience rule, as a test. A base URL is a developer's tool, and exactly one row may ask
    /// for one; if a second ever does, the main path has grown a terminal-shaped step.
    #[test]
    fn only_one_row_asks_for_a_url() {
        let asking: Vec<String> = catalogue()
            .into_iter()
            .filter(|p| p.logins.contains(&Login::Endpoint))
            .map(|p| p.id)
            .collect();
        assert_eq!(asking, vec!["openai-compatible".to_string()]);
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

    /// Two first-class providers and one escape hatch. Growing this list is how the screen becomes
    /// a directory, so it fails here rather than in review.
    #[test]
    fn two_named_providers_and_one_way_in_for_everything_else() {
        let rows = catalogue();
        assert_eq!(rows.len(), 3, "the provider list grew");
        assert_eq!(rows[0].id, "openai");
        assert_eq!(rows[1].id, "anthropic");
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
