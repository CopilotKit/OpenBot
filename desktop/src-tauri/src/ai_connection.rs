//! The AI connection, as this desktop app keeps its half of it.
//!
//! THE CONNECTION CHANGES INSIDE OPENBOT, WITH NO RESTART. OpenBot's server keeps the connection
//! and every engine reaches models through the server's model gateway with a token this app mints
//! (`GATEWAY_TOKEN`), so no engine holds a provider key and a key changed in the app reaches every
//! Bot on its next request. What this app still does:
//!
//! - the plans, whose credentials it keeps: each runs on an engine of its own (`Plan`), a Compose
//!   service behind its own profile, started alone when somebody signs in to it in the app
//!   (`prepare`) and stopped alone when it is no longer the connection (`settle`), while the server,
//!   the database and every other Bot keep running;
//! - the picked Bot, which `settle` points at another engine, and restarts alone, when the new
//!   connection is one its engine cannot speak, as the setup window's Start would have picked it;
//! - two non-secret settings the server imports from: which connection the setup window chose
//!   (`CONNECTION_ENV`) and when (`CHOSEN_AT_ENV`), so a newer choice made there wins over the one
//!   OpenBot keeps and an older one does not.
//!
//! And Settings' AI model row on an older server, read from what Start recorded beside the
//! installation (`saved_intent`): the kind of connection chosen, the model named with it, and for a
//! custom address, its host. Never a key, a token or a whole address.

use std::collections::BTreeMap;
use std::path::Path;

use crate::engine::Address;
use crate::env::{ModelCredential, PickedHarness};
use crate::harness::HarnessChoice;
use crate::problem::Problem;
use crate::saved_intent::{ModelIntent, SavedIntent};
use crate::stack::{Alone, Secrets};

/// What every engine proves itself to the server's model gateway with. Minted once per
/// installation (`crate::env::MINTED`) and kept in the credential store.
pub const GATEWAY_TOKEN: &str = "MODEL_GATEWAY_TOKEN";
/// Which connection the setup window chose, as `{"provider":"anthropic","login":"plan"}`.
pub const CONNECTION_ENV: &str = "OPENBOT_AI_CONNECTION";
/// When the setup window's AI screen last saved a choice, kept in [`CHOSEN_AT_FILE`].
pub const CHOSEN_AT_ENV: &str = "OPENBOT_AI_CONNECTION_CHOSEN_AT";
/// Where the picked harness's file is, for the server to read per run.
pub const PICKED_HARNESS_FILE_ENV: &str = "OPENBOT_PICKED_HARNESS_FILE";
/// Its own small file rather than a field of `SavedIntent`, which refuses fields it does not know:
/// an app from before this one would read a record carrying it as no record at all.
pub const CHOSEN_AT_FILE: &str = ".openbot-ai-chosen-at";
/// The connection last changed in the app ([`Settled`]).
pub const SETTLED_FILE: &str = ".openbot-ai-settled.json";
/// In the sign-in folder, which Compose already mounts into the server at `/openbot`.
pub const PICKED_HARNESS_FILE: &str = ".openbot/picked-harness.json";
/// The server's model gateway, by name on the Bots' network, as `OPENBOT_TOOL_URL` names it.
const GATEWAY: &str = "http://server:3001/api/model-provider";
/// The Claude plan's token, in the credential store.
const CLAUDE_PLAN_TOKEN: &str = "CLAUDE_CODE_OAUTH_TOKEN";

/// The gateway's addresses and the two plan engines', which never change, for every Start.
pub fn gateway_settings() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("OPENBOT_MODEL_GATEWAY_URL".to_string(), GATEWAY.to_string()),
        (
            "MODEL_GATEWAY_OPENAI_URL".to_string(),
            format!("{GATEWAY}/v1"),
        ),
        (
            "MODEL_GATEWAY_ANTHROPIC_URL".to_string(),
            format!("{GATEWAY}/anthropic"),
        ),
        (
            "CLAUDE_PLAN_HARNESS_URL".to_string(),
            Plan::Claude.address(),
        ),
        (
            "CHATGPT_PLAN_HARNESS_URL".to_string(),
            Plan::ChatGpt.address(),
        ),
    ])
}

/// A plan, and the engine of its own it runs on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
pub enum Plan {
    #[serde(rename = "claude")]
    Claude,
    #[serde(rename = "chatgpt")]
    ChatGpt,
}

impl Plan {
    pub const ALL: [Plan; 2] = [Plan::Claude, Plan::ChatGpt];

    /// The Compose service and its profile.
    pub fn alone(self) -> Alone {
        match self {
            Plan::Claude => Alone {
                profile: "claude-plan",
                service: "agent-claude-plan",
            },
            Plan::ChatGpt => Alone {
                profile: "chatgpt-plan",
                service: crate::plan::CHATGPT_PLAN_SERVICE,
            },
        }
    }

    /// The port the engine's image listens on, fixed by its own Dockerfile.
    pub fn port(self) -> u16 {
        match self {
            Plan::Claude => 4212,
            Plan::ChatGpt => 4216,
        }
    }

    /// Where the server reaches it: by name, on the Bots' network.
    pub fn address(self) -> String {
        format!("http://{}:{}", self.alone().service, self.port())
    }

    /// The published image the engine runs: the one its sign-in already runs in.
    pub fn published_image(self) -> &'static str {
        match self {
            Plan::Claude => crate::plan::SIGN_IN_IMAGE,
            Plan::ChatGpt => crate::plan::CHATGPT_SIGN_IN_IMAGE,
        }
    }

    /// The setting `docker-compose.yml` reads the engine's image from.
    pub fn image_variable(self) -> &'static str {
        match self {
            Plan::Claude => "CLAUDE_PLAN_IMAGE",
            Plan::ChatGpt => "CHATGPT_PLAN_IMAGE",
        }
    }

    /// The vendor whose plan this is, as the harness catalogue names it (`harness::speaking_for`).
    fn vendor(self) -> &'static str {
        match self {
            Plan::Claude => "anthropic",
            Plan::ChatGpt => "openai",
        }
    }

    pub fn of(intent: ModelIntent) -> Option<Plan> {
        match intent {
            ModelIntent::ClaudePlan => Some(Plan::Claude),
            ModelIntent::ChatGptPlan => Some(Plan::ChatGpt),
            _ => None,
        }
    }

    pub fn of_credential(credential: &ModelCredential) -> Option<Plan> {
        match credential {
            ModelCredential::ClaudePlan { .. } => Some(Plan::Claude),
            ModelCredential::ChatGptPlan { .. } => Some(Plan::ChatGpt),
            _ => None,
        }
    }

    /// The plan whose own engine is the picked Bot: the plan's, when the Bot picked for it is the
    /// one its engine runs (which a plan always picks, `harness_for`).
    pub fn serving(credential: &ModelCredential, harness: Option<&PickedHarness>) -> Option<Plan> {
        Self::serving_plan(Self::of_credential(credential), harness)
    }

    pub fn serving_plan(plan: Option<Plan>, harness: Option<&PickedHarness>) -> Option<Plan> {
        let plan = plan?;
        match harness? {
            PickedHarness::Installed { image, port, .. }
                if *port == plan.port() && image.contains(plan.published_image()) =>
            {
                Some(plan)
            }
            _ => None,
        }
    }

    /// The picked Bot's address, as the plan's own engine: the server dials it by name, and no
    /// host port is published for it.
    pub fn picked_harness_settings(
        self,
        harness: Option<&PickedHarness>,
    ) -> BTreeMap<String, String> {
        let run_path = match harness {
            Some(PickedHarness::Installed { run_path, .. }) => {
                let run_path = run_path.trim();
                if run_path.is_empty() || run_path.starts_with('/') {
                    run_path.to_string()
                } else {
                    format!("/{run_path}")
                }
            }
            _ => String::new(),
        };
        let address = format!("{}{run_path}", self.address());
        BTreeMap::from([
            ("PICKED_HARNESS_URL".to_string(), address.clone()),
            ("PICKED_HARNESS_CONTAINER_URL".to_string(), address),
        ])
    }
}

/**
The Bot a connection runs, as Start picks it: a plan picks the Bot that can spend it, and anything
else keeps the one the person chose. See `harness::speaking_for` for why a plan decides.
*/
pub fn harness_for(plan: Option<Plan>, requested: Option<HarnessChoice>) -> Option<HarnessChoice> {
    match plan {
        Some(plan) => crate::harness::speaking_for(plan.vendor()).map(|id| HarnessChoice {
            id: id.into(),
            agent_url: None,
        }),
        None => requested,
    }
}

/// The connection a provider and a way in name, as the setup window records it. None for a pair
/// no screen offers.
pub fn intent_for(provider: &str, login: &str) -> Option<ModelIntent> {
    Some(match (provider, login) {
        ("openai", "api-key") => ModelIntent::OpenAiApiKey,
        ("anthropic", "api-key") => ModelIntent::AnthropicApiKey,
        ("anthropic", "plan") => ModelIntent::ClaudePlan,
        ("openai", "plan") => ModelIntent::ChatGptPlan,
        ("google", "oauth") => ModelIntent::GoogleOauth,
        ("xai", "oauth") => ModelIntent::XaiOauth,
        ("google" | "xai" | "unbiased" | "trustedrouter" | "openai-compatible", "endpoint") => {
            ModelIntent::CompatibleEndpoint
        }
        _ => return None,
    })
}

/// Which connection a credential is, for the server: provider and way in, and nothing else.
pub fn connection_setting(credential: &ModelCredential) -> Option<String> {
    let (provider, login) = match credential {
        ModelCredential::None => return None,
        ModelCredential::OpenAi { .. } => ("openai", "api-key"),
        ModelCredential::Anthropic { .. } => ("anthropic", "api-key"),
        ModelCredential::ClaudePlan { .. } => ("anthropic", "plan"),
        ModelCredential::ChatGptPlan { .. } => ("openai", "plan"),
        ModelCredential::ProviderOAuth { provider, .. } => match provider.as_str() {
            "google" => ("google", "oauth"),
            _ => ("xai", "oauth"),
        },
        ModelCredential::Compatible { base_url, .. } => (endpoint_provider(base_url), "endpoint"),
    };
    Some(serde_json::json!({ "provider": provider, "login": login }).to_string())
}

/// The named provider an address is, by its host, as the setup window's rows give them; any other
/// address is a compatible endpoint of the person's own.
fn endpoint_provider(base_url: &str) -> &'static str {
    let host = reqwest::Url::parse(base_url.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase));
    match host.as_deref() {
        Some("generativelanguage.googleapis.com") => "google",
        Some("api.x.ai") => "xai",
        Some("api.unbiased.ai") => "unbiased",
        Some("api.trustedrouter.com") => "trustedrouter",
        _ => "openai-compatible",
    }
}

/// Record that the setup window's AI screen saved a choice, now. That choice is the connection from
/// here on, so the one last changed in the app ([`Settled`]) no longer is.
pub fn record_chosen_at(root: &Path) -> std::io::Result<()> {
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(std::io::Error::other)?;
    crate::env::write_private_file(&root.join(CHOSEN_AT_FILE), format!("{now}\n").as_bytes())?;
    match std::fs::remove_file(root.join(SETTLED_FILE)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// When the setup window's AI screen last saved a choice, if it ever did.
pub fn chosen_at(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join(CHOSEN_AT_FILE)).ok()?;
    let at = text.trim();
    time::OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|_| at.to_string())
}

/**
The connection last changed in the app, as the page settled it: provider, way in, the model named
with it and an address's host. Never a key, and never a whole address.

What lets Desktop's next Start carry on with a connection whose key OpenBot keeps and this app
never saw: the setup window resumes the recorded connection as a saved one, and Start then writes no
key for it (`Settled::kept`), so the server keeps the one it holds.
*/
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settled {
    pub provider: String,
    pub login: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub endpoint_host: Option<String>,
}

impl Settled {
    pub fn read(root: &Path) -> Option<Self> {
        serde_json::from_slice(&std::fs::read(root.join(SETTLED_FILE)).ok()?).ok()
    }

    fn write(&self, root: &Path) -> Result<(), Problem> {
        let bytes = serde_json::to_vec(self).map_err(|error| {
            Problem::with(
                "OpenBot couldn't record the new AI connection.",
                error.to_string(),
            )
        })?;
        crate::env::write_private_file(&root.join(SETTLED_FILE), &bytes).map_err(|error| {
            Problem::with(
                "OpenBot couldn't record the new AI connection.",
                error.to_string(),
            )
        })
    }

    /// Whether this is the connection a saved choice for `provider` by `login` names. Every
    /// address row resumes as the compatible endpoint, whichever named row it was.
    pub fn names(&self, provider: &str, login: &str) -> bool {
        intent_for(&self.provider, &self.login).is_some()
            && intent_for(&self.provider, &self.login) == intent_for(provider, login)
    }
}

/**
The settings Start writes that depend on the installation folder: the plan engines' images, from the
release's manifest; when the setup window's AI screen last saved a choice; and the files the server
reads, at the paths the Compose file mounts.

`OPENBOT_MODEL_OAUTH_FILE` names where a Google or xAI sign-in is kept whether or not one is the
connection now, so one made in the app reaches the server with no restart.
*/
pub fn start_settings(root: &Path) -> BTreeMap<String, String> {
    let mut settings = plan_images(root);
    settings.insert(CHOSEN_AT_ENV.into(), chosen_at(root).unwrap_or_default());
    settings.insert(
        PICKED_HARNESS_FILE_ENV.into(),
        root.join(PICKED_HARNESS_FILE)
            .to_string_lossy()
            .into_owned(),
    );
    settings.insert(
        "OPENBOT_MODEL_OAUTH_FILE".into(),
        root.join(crate::provider_oauth::FILE)
            .to_string_lossy()
            .into_owned(),
    );
    settings
}

/// Each plan engine's image, from the release's manifest. One the release does not carry is left
/// out, and Compose's stand-in applies: that plan cannot start, and says so when asked.
fn plan_images(root: &Path) -> BTreeMap<String, String> {
    Plan::ALL
        .into_iter()
        .filter_map(|plan| {
            crate::deployment::reference(root, plan.published_image())
                .ok()
                .map(|image| (plan.image_variable().to_string(), image))
        })
        .collect()
}

/// The picked harness as the server reads it per run, from `settings` as `.env` has them.
#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedHarnessFile {
    pub image: String,
    pub url: String,
    pub container_url: String,
    pub kind: String,
    pub name: String,
    pub source: String,
}

impl PickedHarnessFile {
    pub fn from_settings(settings: &BTreeMap<String, String>) -> Self {
        let get = |key: &str| settings.get(key).cloned().unwrap_or_default();
        Self {
            image: get("PICKED_HARNESS_IMAGE"),
            url: get("PICKED_HARNESS_URL"),
            container_url: get("PICKED_HARNESS_CONTAINER_URL"),
            kind: get("PICKED_HARNESS_KIND"),
            name: get("PICKED_HARNESS_NAME"),
            source: get("PICKED_HARNESS_SOURCE"),
        }
    }
}

/// Write the picked harness's file. Replaced whole, so a run reads one harness or the other.
pub fn write_picked_harness_file(
    root: &Path,
    settings: &BTreeMap<String, String>,
) -> Result<(), Problem> {
    let failed =
        |error: String| Problem::with("OpenBot couldn't record what your Bot runs on.", error);
    let path = root.join(PICKED_HARNESS_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| failed(error.to_string()))?;
    }
    let bytes = serde_json::to_vec(&PickedHarnessFile::from_settings(settings))
        .map_err(|error| failed(error.to_string()))?;
    crate::env::write_private_file(&path, &bytes).map_err(|error| failed(error.to_string()))
}

/// The secrets the engines this changes are started with, from the credential store.
fn engine_secrets(root: &Path) -> Result<Secrets, Problem> {
    let mut keys: Vec<&str> = crate::env::MINTED.to_vec();
    keys.push(CLAUDE_PLAN_TOKEN);
    crate::vault::already_given_no_ui(root, &root.join(".env"), &keys)
}

/**
Get the connection's own engine ready, for a plan: start that plan's engine alone, or recreate it
with a new token, and wait until it answers. Nothing else is started, stopped or touched. A
connection with no plan has no engine of its own and is ready as it is.

Refused, with the step to take, when the plan was not signed in to on this computer.
*/
pub fn prepare(engine: &Address, root: &Path, provider: &str, login: &str) -> Result<(), Problem> {
    let intent = intent_for(provider, login)
        .ok_or_else(|| Problem::plain("OpenBot can't connect that way."))?;
    let Some(plan) = Plan::of(intent) else {
        return Ok(());
    };
    let mut secrets = engine_secrets(root)?;
    match plan {
        Plan::Claude => {
            if secrets
                .get(CLAUDE_PLAN_TOKEN)
                .is_none_or(|token| token.trim().is_empty())
            {
                return Err(Problem::plain("Sign in to your Claude plan first."));
            }
        }
        Plan::ChatGpt => {
            if crate::env::chatgpt_sign_in_changed(root) {
                return Err(Problem::plain(crate::env::CHATGPT_SIGN_IN_CHANGED));
            }
            if !crate::env::saved_chatgpt_plan_store(root) {
                return Err(Problem::plain("Sign in to your ChatGPT plan first."));
            }
            // Never handed to the ChatGPT engine, which the Compose file gives no such setting.
            secrets.remove(CLAUDE_PLAN_TOKEN);
        }
    }
    // The engine's image, for an installation whose last Start predates it.
    let images = plan_images(root);
    if !images.is_empty() {
        crate::env::write(&root.join(".env"), &images, &BTreeMap::new()).map_err(|error| {
            Problem::with("OpenBot couldn't save its settings.", error.to_string())
        })?;
    }
    crate::stack::start_alone(engine, root, plan.alone(), &secrets)
}

/// What the page settles on: the connection now in use, as the page names it.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub provider: String,
    pub login: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub endpoint_host: Option<String>,
}

/// What `settle` did to the engines, for the log and for tests.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Settlement {
    /// Plan engines stopped because their plan is no longer the connection.
    pub stopped: Vec<&'static str>,
    /// The picked Bot was restarted (or started) to speak the new connection.
    pub restarted_harness: bool,
    /// The picked Bot's own container was stopped: a plan's engine is the Bot now, or none is.
    pub stopped_harness: bool,
}

/// The settings `settle` compares to decide whether the picked Bot must start again.
const HARNESS_KEYS: [&str; 6] = [
    "PICKED_HARNESS_IMAGE",
    "PICKED_HARNESS_PORT",
    "PICKED_HARNESS_URL",
    "PICKED_HARNESS_CONTAINER_URL",
    "BOT_PROVIDER",
    "BOT_MODEL",
];

/**
Settle on the connection now in use, after the server took it (or, after a refusal, on the one it
reports): record it for Desktop's next Start, stop a plan engine it no longer needs, and, when the
picked Bot's engine cannot use it, point that Bot at the engine Start would pick and restart only
that container. The server, the database and every other container keep running.

Never records when the setup window last chose (`CHOSEN_AT_FILE`): this choice was made in the app,
and the server already keeps it.
*/
pub fn settle(engine: &Address, root: &Path, change: &Change) -> Result<Settlement, Problem> {
    let intent = intent_for(&change.provider, &change.login)
        .ok_or_else(|| Problem::plain("OpenBot can't connect that way."))?;
    let plan = Plan::of(intent);
    Settled {
        provider: change.provider.clone(),
        login: change.login.clone(),
        model: change
            .model
            .clone()
            .filter(|model| !model.trim().is_empty()),
        endpoint_host: change
            .endpoint_host
            .clone()
            .filter(|host| !host.trim().is_empty()),
    }
    .write(root)?;
    crate::saved_intent::record_settled(root, intent)?;

    // The Bot as Start would pick it for this connection.
    let requested = crate::preparation::launch(root)
        .or_else(|| crate::preparation::installation(root))
        .and_then(|launch| launch.harness);
    let effective = harness_for(plan, requested);
    // An image list that is missing or unreadable is an unfinished install, not a release without
    // the Bot: Install downloads the list again (`deployment::ReferenceError`).
    let picked = crate::harness::pick(effective.as_ref(), root).map_err(|error| match error {
        crate::harness::PickError::ImageList(detail) => crate::preparation::required(detail),
        crate::harness::PickError::Refused(detail) => Problem::with(
            "This version of OpenBot does not include the Bot that connection needs.",
            detail,
        ),
    })?;
    let ports = crate::env::Ports::read(root).map_err(|error| {
        Problem::with("OpenBot could not read its local ports.", error.to_string())
    })?;
    let serving = Plan::serving_plan(plan, picked.as_ref());
    let mut settings = crate::env::harness_settings(picked.as_ref(), &ports);
    if let Some(serving) = serving {
        settings.extend(serving.picked_harness_settings(picked.as_ref()));
    }
    settings.insert("BOT_PROVIDER".into(), bot_provider(intent).into());
    let mut purge = BTreeMap::new();
    match change
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        Some(model)
            if matches!(
                intent,
                ModelIntent::CompatibleEndpoint | ModelIntent::GoogleOauth | ModelIntent::XaiOauth
            ) =>
        {
            settings.insert("BOT_MODEL".into(), model.into());
        }
        _ => {
            purge.insert("BOT_MODEL".to_string(), String::new());
        }
    }
    if picked.is_none() {
        for key in [
            "PICKED_HARNESS_URL",
            "PICKED_HARNESS_IMAGE",
            "PICKED_HARNESS_KIND",
        ] {
            purge.insert(key.into(), String::new());
        }
    }
    settings.insert(
        CONNECTION_ENV.into(),
        serde_json::json!({ "provider": change.provider, "login": change.login }).to_string(),
    );
    settings.extend(gateway_settings());
    settings.extend(plan_images(root));

    let env_file = root.join(".env");
    let before = crate::env::read_already_set(&env_file, &HARNESS_KEYS)
        .map_err(|error| Problem::with("OpenBot couldn't read its settings.", error.to_string()))?;
    crate::env::write(&env_file, &settings, &purge)
        .map_err(|error| Problem::with("OpenBot couldn't save its settings.", error.to_string()))?;
    write_picked_harness_file(root, &settings)?;

    let mut settlement = Settlement::default();
    for other in Plan::ALL.into_iter().filter(|other| Some(*other) != plan) {
        crate::stack::remove_alone(engine, root, other.alone())?;
        settlement.stopped.push(other.alone().service);
    }
    let installed = matches!(picked, Some(PickedHarness::Installed { .. })) && serving.is_none();
    if !installed {
        crate::stack::remove_alone(
            engine,
            root,
            Alone {
                profile: "harness",
                service: "agent-harness",
            },
        )?;
        settlement.stopped_harness = true;
    } else if harness_changed(&before, &settings) {
        crate::stack::recreate_harness(engine, root, &engine_secrets(root)?)?;
        settlement.restarted_harness = true;
    }
    Ok(settlement)
}

/// The wire a harness that fixes it at start speaks. Empty is Compose's default, OpenAI's.
fn bot_provider(intent: ModelIntent) -> &'static str {
    match intent {
        ModelIntent::AnthropicApiKey | ModelIntent::ClaudePlan => "anthropic",
        _ => "",
    }
}

/// Whether the picked Bot's container would start differently now.
fn harness_changed(before: &BTreeMap<String, String>, after: &BTreeMap<String, String>) -> bool {
    HARNESS_KEYS.iter().any(|key| {
        let value = |settings: &BTreeMap<String, String>| {
            let value = settings.get(*key).map(|value| value.trim()).unwrap_or("");
            match (*key, value) {
                ("BOT_PROVIDER", "") => "openai".to_string(),
                _ => value.to_string(),
            }
        };
        value(before) != value(after)
    })
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConnection {
    /// The connection Start last saved; None before one was chosen.
    pub kind: Option<ModelIntent>,
    /// The model named on the setup screen. Only an address or a provider sign-in names one; with a
    /// key or a plan the server picks the provider's own.
    pub model: Option<String>,
    /// The host of a custom address, for the page to tell Gemini, xAI, Unbiased AI and TrustedRouter
    /// apart from a person's own server. Only the host: an address can carry a password or a key.
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

    /// Changing the connection reads the picked Bot's image from the release's list. A list that
    /// is gone is an unfinished install, not a release without the Bot; a list without the Bot
    /// still says that.
    #[test]
    fn a_change_with_the_image_list_gone_is_an_install_problem_not_a_missing_bot() {
        let root = root("image-list-gone", "", "");
        std::fs::write(root.join("docker-compose.yml"), "services:\n  server: {}\n").unwrap();
        let list = serde_json::json!({
            "version": "v0.0.8",
            "images": { "server": { "reference": "ghcr.io/copilotkit/openbot-server@sha256:00" } },
        })
        .to_string();
        std::fs::write(crate::deployment::images_path(&root), &list).unwrap();
        crate::deployment::record(&root, "v0.0.8", false).unwrap();
        let bot = crate::harness::HarnessChoice {
            id: crate::harness::DEFAULT_HARNESS.into(),
            agent_url: None,
        };
        crate::preparation::record(&root, Some(&bot), vec!["synthetic-image".into()]).unwrap();
        let engine = Address::new(crate::engine::Engine::Docker, None);
        let change = Change {
            provider: "openai".into(),
            login: "api-key".into(),
            model: None,
            endpoint_host: None,
        };

        // The list is there and names no such Bot: the release's answer.
        let refused = settle(&engine, &root, &change).unwrap_err();
        assert_eq!(
            refused.said,
            "This version of OpenBot does not include the Bot that connection needs."
        );

        std::fs::remove_file(crate::deployment::images_path(&root)).unwrap();
        let refused = settle(&engine, &root, &change).unwrap_err();
        assert!(!refused.said.contains("does not include"), "{refused:?}");
        assert_eq!(refused.said, crate::preparation::REQUIRED, "{refused:?}");
        assert_eq!(
            refused.connection,
            Some(crate::problem::Connection::Installation)
        );
        assert!(
            refused
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("container-images.json")),
            "{refused:?}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nothing_chosen_reads_as_nothing() {
        let root = root("none", "", "");
        assert_eq!(read(&root), AiConnection::default());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Every pair the setup window offers names one connection, and nothing else does.
    #[test]
    fn each_way_in_the_setup_window_offers_is_one_connection() {
        for (provider, login, intent) in [
            ("openai", "api-key", ModelIntent::OpenAiApiKey),
            ("anthropic", "api-key", ModelIntent::AnthropicApiKey),
            ("anthropic", "plan", ModelIntent::ClaudePlan),
            ("openai", "plan", ModelIntent::ChatGptPlan),
            ("google", "oauth", ModelIntent::GoogleOauth),
            ("xai", "oauth", ModelIntent::XaiOauth),
            ("google", "endpoint", ModelIntent::CompatibleEndpoint),
            ("xai", "endpoint", ModelIntent::CompatibleEndpoint),
            ("unbiased", "endpoint", ModelIntent::CompatibleEndpoint),
            ("trustedrouter", "endpoint", ModelIntent::CompatibleEndpoint),
            (
                "openai-compatible",
                "endpoint",
                ModelIntent::CompatibleEndpoint,
            ),
        ] {
            assert_eq!(
                intent_for(provider, login),
                Some(intent),
                "{provider} {login}"
            );
        }
        for (provider, login) in [
            ("openai", "endpoint"),
            ("google", "plan"),
            ("unbiased", "oauth"),
            ("trustedrouter", "oauth"),
            ("anthropic", "oauth"),
            ("", ""),
        ] {
            assert_eq!(intent_for(provider, login), None, "{provider} {login}");
        }
    }

    /// The server is told which connection, by provider and way in, and never a key or an address.
    #[test]
    fn the_server_is_told_the_connection_and_never_its_key() {
        for (credential, said) in [
            (
                ModelCredential::OpenAi {
                    api_key: "sentinel-key".into(),
                },
                r#"{"login":"api-key","provider":"openai"}"#,
            ),
            (
                ModelCredential::ClaudePlan {
                    token: "sentinel-key".into(),
                },
                r#"{"login":"plan","provider":"anthropic"}"#,
            ),
            (
                ModelCredential::Compatible {
                    base_url: "https://generativelanguage.googleapis.com/v1beta/openai/".into(),
                    container_base_url: None,
                    api_key: "sentinel-key".into(),
                    model: "gemini-3-pro".into(),
                },
                r#"{"login":"endpoint","provider":"google"}"#,
            ),
            (
                ModelCredential::Compatible {
                    base_url: "https://api.trustedrouter.com/v1".into(),
                    container_base_url: None,
                    api_key: "sentinel-key".into(),
                    model: "anthropic/claude-sonnet-5.5".into(),
                },
                r#"{"login":"endpoint","provider":"trustedrouter"}"#,
            ),
            (
                ModelCredential::Compatible {
                    base_url: "http://127.0.0.1:11434/v1".into(),
                    container_base_url: None,
                    api_key: String::new(),
                    model: "llama".into(),
                },
                r#"{"login":"endpoint","provider":"openai-compatible"}"#,
            ),
            (
                ModelCredential::ProviderOAuth {
                    provider: "xai".into(),
                    path: "/x".into(),
                    proxy_token: "sentinel-key".into(),
                    model: "grok".into(),
                },
                r#"{"login":"oauth","provider":"xai"}"#,
            ),
        ] {
            let setting = connection_setting(&credential).unwrap();
            assert_eq!(setting, said);
            assert!(!setting.contains("sentinel"));
        }
        assert_eq!(connection_setting(&ModelCredential::None), None);
    }

    /// A plan's own engine is the picked Bot only when the Bot picked for that plan is the one its
    /// engine runs; a ChatGPT plan's TypeScript Bot keeps its own container and calls the engine.
    #[test]
    fn a_plan_serves_the_bot_only_when_its_engine_is_that_bot() {
        let installed = |image: &str, port: u16| PickedHarness::Installed {
            image: format!("ghcr.io/copilotkit/openbot-{image}@sha256:abc"),
            port,
            name: "Bot".into(),
            mastra: false,
            run_path: String::new(),
            remote_agent_id: String::new(),
        };
        let claude_sdk = installed("agent-claude-sdk", 4212);
        let typescript = installed("agent-langgraph-ts", 4215);
        let claude = ModelCredential::ClaudePlan {
            token: "sentinel".into(),
        };
        let chatgpt = ModelCredential::ChatGptPlan { store: "{}".into() };
        assert_eq!(
            Plan::serving(&claude, Some(&claude_sdk)),
            Some(Plan::Claude)
        );
        assert_eq!(Plan::serving(&claude, Some(&typescript)), None);
        assert_eq!(Plan::serving(&chatgpt, Some(&typescript)), None);
        assert_eq!(
            Plan::serving(
                &ModelCredential::Anthropic {
                    api_key: "sentinel".into()
                },
                Some(&claude_sdk)
            ),
            None
        );
        let settings = Plan::Claude.picked_harness_settings(Some(&claude_sdk));
        assert_eq!(
            settings["PICKED_HARNESS_CONTAINER_URL"],
            "http://agent-claude-plan:4212"
        );
        assert_eq!(
            settings["PICKED_HARNESS_URL"],
            "http://agent-claude-plan:4212"
        );
        assert_eq!(Plan::ChatGpt.address(), crate::plan::CHATGPT_PLAN_URL);
    }

    /// Every Start writes the gateway and both plan engines' addresses, so a connection changed in
    /// the app reaches them with no restart.
    #[test]
    fn every_start_names_the_gateway_and_both_plan_engines() {
        let settings = gateway_settings();
        assert_eq!(
            settings["OPENBOT_MODEL_GATEWAY_URL"],
            "http://server:3001/api/model-provider"
        );
        assert_eq!(
            settings["MODEL_GATEWAY_OPENAI_URL"],
            "http://server:3001/api/model-provider/v1"
        );
        assert_eq!(
            settings["MODEL_GATEWAY_ANTHROPIC_URL"],
            "http://server:3001/api/model-provider/anthropic"
        );
        assert_eq!(
            settings["CLAUDE_PLAN_HARNESS_URL"],
            "http://agent-claude-plan:4212"
        );
        assert_eq!(
            settings["CHATGPT_PLAN_HARNESS_URL"],
            "http://agent-chatgpt-plan:4216"
        );
        assert!(crate::env::MINTED.contains(&GATEWAY_TOKEN));
        assert!(crate::vault::is_secret(GATEWAY_TOKEN));
    }

    /// A choice made in the setup window is recorded with its time and ends the one changed in the
    /// app; one changed in the app names only its own connection.
    #[test]
    fn a_setup_choice_is_timed_and_replaces_the_one_changed_in_the_app() {
        let root = crate::test_support::temp_root("ai-chosen-at");
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(chosen_at(&root), None);
        Settled {
            provider: "google".into(),
            login: "endpoint".into(),
            model: Some("gemini-3-pro".into()),
            endpoint_host: Some("generativelanguage.googleapis.com".into()),
        }
        .write(&root)
        .unwrap();
        let kept = Settled::read(&root).unwrap();
        // The setup window resumes every address as the compatible endpoint row.
        assert!(kept.names("openai-compatible", "endpoint"));
        assert!(!kept.names("openai", "api-key"));
        record_chosen_at(&root).unwrap();
        let at = chosen_at(&root).expect("recorded");
        assert!(
            time::OffsetDateTime::parse(&at, &time::format_description::well_known::Rfc3339)
                .is_ok()
        );
        assert_eq!(Settled::read(&root), None);
        assert_eq!(start_settings(&root)[CHOSEN_AT_ENV], at);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The picked Bot starts again only when what it starts with changed.
    #[test]
    fn the_picked_bot_starts_again_only_when_its_settings_changed() {
        let settings = |pairs: &[(&str, &str)]| -> BTreeMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        let before = settings(&[
            ("PICKED_HARNESS_IMAGE", "image"),
            ("PICKED_HARNESS_CONTAINER_URL", "http://agent-harness:4215"),
            ("BOT_PROVIDER", ""),
        ]);
        assert!(!harness_changed(
            &before,
            &settings(&[
                ("PICKED_HARNESS_IMAGE", "image"),
                ("PICKED_HARNESS_CONTAINER_URL", "http://agent-harness:4215"),
                ("BOT_PROVIDER", "openai"),
            ])
        ));
        assert!(harness_changed(
            &before,
            &settings(&[
                ("PICKED_HARNESS_IMAGE", "image"),
                ("PICKED_HARNESS_CONTAINER_URL", "http://agent-harness:4215"),
                ("BOT_PROVIDER", "anthropic"),
            ])
        ));
    }

    /*
     * ON A REAL ENGINE, with this repository's own docker-compose.yml: the connection changed in the
     * app starts and stops one container at a time, and everything else keeps running.
     *
     * Needs Docker, so ignored unless asked for, as the other live tests are; CI runs them on Linux:
     *
     *   cargo test --lib ai_connection::tests::real_engine -- --ignored --test-threads=1
     *
     * The Claude Agent SDK harness image is built from this tree, unless
     * OPENBOT_TEST_CLAUDE_SDK_IMAGE names one already built.
     */
    fn claude_sdk_image() -> String {
        if let Ok(image) = std::env::var("OPENBOT_TEST_CLAUDE_SDK_IMAGE") {
            return image;
        }
        let image = "openbot-test-agent-claude-sdk:live".to_string();
        let tree = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let built = std::process::Command::new("docker")
            .args(["build", "--quiet", "-f"])
            .arg(tree.join("agent-claude-sdk/Dockerfile"))
            .args(["-t", &image])
            .arg(&tree)
            .output()
            .unwrap();
        assert!(
            built.status.success(),
            "{}",
            String::from_utf8_lossy(&built.stderr)
        );
        image
    }
    struct RealStack {
        root: std::path::PathBuf,
        engine: Address,
        project: String,
    }

    impl RealStack {
        fn new(label: &str) -> Self {
            let image = claude_sdk_image();
            let root = crate::test_support::temp_root(label);
            std::fs::create_dir_all(root.join(".openbot")).unwrap();
            std::fs::create_dir_all(root.join(".langchain")).unwrap();
            std::fs::copy(
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docker-compose.yml"),
                root.join("docker-compose.yml"),
            )
            .unwrap();
            let project = format!("openbot-s4-{}-{}", label, std::process::id());
            std::fs::write(
                root.join(crate::stack::PROJECT_FILE),
                serde_json::json!({ "project": project }).to_string(),
            )
            .unwrap();
            std::fs::write(root.join(".openbot-deployment"), "{}").unwrap();
            std::fs::write(
                crate::deployment::images_path(&root),
                serde_json::json!({
                    "version": "test",
                    "images": { "agent-claude-sdk": { "reference": image } }
                })
                .to_string(),
            )
            .unwrap();
            let free = || {
                std::net::TcpListener::bind("127.0.0.1:0")
                    .unwrap()
                    .local_addr()
                    .unwrap()
                    .port()
            };
            // The Bot the person picked: the Claude Agent SDK, on the gateway token.
            crate::preparation::record(
                &root,
                Some(&HarnessChoice {
                    id: "claude-agent-sdk".into(),
                    agent_url: None,
                }),
                vec![],
            )
            .unwrap();
            // As Start writes them for that Bot on an Anthropic key.
            let ports = crate::env::Ports {
                harness: Some(free()),
                ..Default::default()
            };
            let picked = crate::harness::picked(
                Some(&HarnessChoice {
                    id: "claude-agent-sdk".into(),
                    agent_url: None,
                }),
                &root,
            )
            .unwrap();
            let mut env = crate::env::harness_settings(picked.as_ref(), &ports);
            env.extend(ports.settings());
            env.insert("POSTGRES_PORT".into(), free().to_string());
            env.insert("BOT_PROVIDER".into(), "anthropic".into());
            env.extend(gateway_settings());
            crate::env::write(&root.join(".env"), &env, &BTreeMap::new()).unwrap();
            for (key, value) in [
                (GATEWAY_TOKEN, "real-engine-gateway-token"),
                ("MANAGED_AGENT_TOKEN", "real-engine-managed-token"),
                (CLAUDE_PLAN_TOKEN, "real-engine-plan-token"),
            ] {
                crate::vault::remember(&root, key, value).unwrap();
            }
            let stack = Self {
                root,
                engine: Address::new(crate::engine::Engine::Docker, None),
                project,
            };
            // The rest of OpenBot, as Start raised it: the database and the picked Bot.
            let secrets = engine_secrets(&stack.root).unwrap();
            let output = crate::stack::compose_command_for(&stack.engine, &stack.root, &secrets)
                .args(["up", "-d", "--wait", "postgres"])
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            // On its host port, through the overlay Start's own `up` uses.
            crate::stack::recreate_harness(&stack.engine, &stack.root, &secrets).unwrap();
            stack
        }

        /// Each running container of the project, by service: its id and when it started.
        fn running(&self) -> BTreeMap<String, String> {
            let listed = self
                .engine
                .command()
                .args(["ps", "--filter"])
                .arg(format!("label=com.docker.compose.project={}", self.project))
                .args(["--format", "{{.ID}}"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&listed.stdout)
                .split_whitespace()
                .map(|id| {
                    let inspected = self
                        .engine
                        .command()
                        .args([
                            "inspect",
                            "--format",
                            "{{index .Config.Labels \"com.docker.compose.service\"}} {{.Id}} {{.State.StartedAt}} {{json .State}}",
                            id,
                        ])
                        .output()
                        .unwrap();
                    let said = String::from_utf8_lossy(&inspected.stdout).trim().to_string();
                    let (service, rest) = said.split_once(' ').unwrap_or_else(|| {
                        panic!(
                            "inspect {id}: {said:?} {}",
                            String::from_utf8_lossy(&inspected.stderr)
                        )
                    });
                    // Its id, when it started, and its health where it has a check.
                    let (started, state) = rest.split_once(" {").unwrap();
                    let state: serde_json::Value =
                        serde_json::from_str(&format!("{{{state}")).unwrap();
                    let health = state["Health"]["Status"].as_str().unwrap_or("");
                    (service.to_string(), format!("{started} {health}").trim().to_string())
                })
                .collect()
        }
    }

    impl Drop for RealStack {
        fn drop(&mut self) {
            let _ = crate::stack::compose_command_for(&self.engine, &self.root, &Secrets::new())
                .args([
                    "--profile",
                    "harness",
                    "--profile",
                    "claude-plan",
                    "--profile",
                    "chatgpt-plan",
                    "down",
                    "--volumes",
                ])
                .output();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /**
    Changing the AI connection in the app leaves OpenBot running.

    Signing in to a Claude plan starts the Claude plan's engine alone, healthy, while the database
    and the picked Bot keep their containers; moving to an Anthropic key stops that engine alone and
    leaves the Bot, which already speaks Anthropic's wire through the gateway, as it was; moving to
    an OpenAI key restarts the Bot alone, to speak OpenAI's wire, and the database never stops.
    */
    #[test]
    #[ignore = "needs Docker"]
    fn real_engine_changing_the_connection_in_the_app_leaves_openbot_running() {
        let stack = RealStack::new("change");
        let at_start = stack.running();
        assert_eq!(
            at_start.keys().collect::<Vec<_>>(),
            vec!["agent-harness", "postgres"],
            "{at_start:?}"
        );

        prepare(&stack.engine, &stack.root, "anthropic", "plan").unwrap();
        let planned = stack.running();
        assert!(
            planned["agent-claude-plan"].ends_with(" healthy"),
            "{planned:?}"
        );
        for service in ["postgres", "agent-harness"] {
            assert_eq!(planned[service], at_start[service], "{service} was touched");
        }
        assert_eq!(planned.len(), 3, "{planned:?}");
        // The plan's engine was handed the plan token and an empty key, and nothing else was.
        let environment = stack
            .engine
            .command()
            .args(["inspect", "--format", "{{json .Config.Env}}"])
            .arg(format!("{}-agent-claude-plan-1", stack.project))
            .output()
            .unwrap();
        let environment = String::from_utf8_lossy(&environment.stdout);
        assert!(environment.contains("CLAUDE_CODE_OAUTH_TOKEN=real-engine-plan-token"));
        assert!(environment.contains("\"ANTHROPIC_API_KEY=\""));
        assert!(!environment.contains("real-engine-gateway-token"));

        let to_key = Change {
            provider: "anthropic".into(),
            login: "api-key".into(),
            model: None,
            endpoint_host: None,
        };
        let settled = settle(&stack.engine, &stack.root, &to_key).unwrap();
        assert!(
            !settled.restarted_harness && !settled.stopped_harness,
            "{settled:?}"
        );
        let on_key = stack.running();
        assert_eq!(on_key.get("agent-claude-plan"), None, "{on_key:?}");
        assert_eq!(on_key["postgres"], at_start["postgres"]);
        assert_eq!(on_key["agent-harness"], at_start["agent-harness"]);

        let to_openai = Change {
            provider: "openai".into(),
            login: "api-key".into(),
            model: None,
            endpoint_host: None,
        };
        let settled = settle(&stack.engine, &stack.root, &to_openai).unwrap();
        assert!(settled.restarted_harness, "{settled:?}");
        let on_openai = stack.running();
        assert_eq!(
            on_openai["postgres"], at_start["postgres"],
            "the database stopped"
        );
        assert_ne!(on_openai["agent-harness"], at_start["agent-harness"]);
        assert_eq!(on_openai.len(), 2, "{on_openai:?}");
        // Recorded for the next Start, and the server reads the Bot from its file.
        assert_eq!(
            SavedIntent::read(&stack.root).model,
            Some(ModelIntent::OpenAiApiKey)
        );
        let picked: PickedHarnessFile =
            serde_json::from_slice(&std::fs::read(stack.root.join(PICKED_HARNESS_FILE)).unwrap())
                .unwrap();
        assert_eq!(picked.container_url, "http://agent-harness:4212");
    }

    /// A plan's engine starts alone on a real engine, and a Claude plan never signed in to starts
    /// nothing and says what to do.
    #[test]
    #[ignore = "needs Docker"]
    fn real_engine_a_plan_engine_starts_alone_and_only_when_signed_in() {
        let stack = RealStack::new("alone");
        let before = stack.running();
        crate::vault::forget(&stack.root, CLAUDE_PLAN_TOKEN).unwrap();
        let refused = prepare(&stack.engine, &stack.root, "anthropic", "plan").unwrap_err();
        assert_eq!(refused.said, "Sign in to your Claude plan first.");
        assert_eq!(stack.running(), before);
        // A key needs no engine of its own: ready, and nothing started.
        prepare(&stack.engine, &stack.root, "openai", "api-key").unwrap();
        assert_eq!(stack.running(), before);
    }
}
