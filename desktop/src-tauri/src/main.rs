// A window, not a console. Release builds on Windows must not open one behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use openbot_desktop_lib::{
    acquire, deployment, engine, env as openbot_env, harness, install, problem::Problem, provider,
    quiet, stack, supervise, tray, windows as win,
};

/// The deployment this app installs.
///
/// Pinned rather than "latest": the images a release runs are pinned per release, so the tree that
/// names them has to be too, and an app that fetches whatever shipped this morning is not a version
/// anybody can be given. Moved deliberately, with the app.
const DEPLOYMENT_VERSION: &str = "v0.0.8";
use serde::Serialize;
use tauri::{Emitter, Manager};

/// What the shell is running, so the window and the tray say the same thing.
#[derive(Default)]
struct Shell {
    /// Named, because a restart policy that cannot say which process died cannot start it again.
    children: Mutex<Vec<(&'static str, std::process::Child)>>,
    /// Which run is the current one.
    ///
    /// Stopping and starting again inside two seconds would otherwise leave the previous watcher
    /// alive beside the new one, both answering the same death, and a process restarted twice is
    /// one process and one orphan holding a port.
    generation: std::sync::atomic::AtomicU64,
    /// Why the stack stopped, kept for the screen that has not loaded yet.
    ///
    /// Going back to the setup screen is a navigation, and a navigation is a fresh page: React
    /// remounts with no progress and the sentence explaining what happened is lost at the one
    /// moment it is worth reading. Held here instead, and asked for on load.
    last_failure: Mutex<Option<openbot_desktop_lib::problem::Problem>>,
    selected_root: Mutex<Option<PathBuf>>,
    root: Mutex<Option<PathBuf>>,
    /// An Intelligence sign-in waiting for its loopback callback.
    signing_in_to_intelligence:
        Mutex<Option<openbot_desktop_lib::intelligence::SigningInToIntelligence>>,
    /// The credential that sign-in produced, held so a project can be chosen with it.
    intelligence_credential: Mutex<Option<String>>,
    /// A ChatGPT sign-in waiting for the browser redirect to complete it.
    ///
    /// Held for the same reason the Claude one is: a person leaves and comes back in the middle.
    /// Unlike that one, nothing is typed here — the callback finishes it.
    signing_in_to_chatgpt: Mutex<Option<openbot_desktop_lib::plan::SigningInToChatGpt>>,
    /// A plan sign-in waiting for the code from the browser.
    ///
    /// Held across two commands because a person has to leave and approve in the middle of it, and
    /// the flow that showed the URL is the only one that can redeem the code: each start mints its
    /// own PKCE challenge and state, so a second start invalidates the first.
    signing_in: Mutex<Option<openbot_desktop_lib::plan::SigningIn>>,
    /// Where the shell's own interface lives, read from the window rather than spelled out.
    ///
    /// Tauri does not serve the bundle from the same address on every platform: macOS and Linux
    /// get `tauri://localhost`, Windows gets `http://tauri.localhost`. Spelling one of them into
    /// the code means Stop leaves Windows staring at a page whose servers have just been killed,
    /// which is what it did. The window knows its own address, so it is asked once and kept.
    setup_url: Mutex<Option<String>>,
}

#[derive(Serialize, Clone)]
struct Progress {
    step: String,
    ok: bool,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedModelApiKeys {
    openai: Option<bool>,
    anthropic: Option<bool>,
    compatible: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedModelSessions {
    openai: Option<bool>,
    anthropic: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedConfiguration {
    intelligence_api_key: Option<bool>,
    model_api_keys: SavedModelApiKeys,
    model_sessions: SavedModelSessions,
    model: Option<openbot_desktop_lib::saved_intent::ModelIntent>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlreadyConfigured {
    values: std::collections::BTreeMap<String, String>,
    saved: SavedConfiguration,
}

struct ReadyRespondingEngine {
    address: engine::Address,
    detail: String,
    installed: Option<String>,
}

/// Return a responding engine only after Compose is present too.
fn ready_responding_engine_after_compose_repair(
    found: engine::EngineStatus,
    mut install_engine: impl FnMut() -> Result<String, Problem>,
    mut detect: impl FnMut() -> engine::EngineStatus,
    mut composes: impl FnMut(&engine::Address) -> bool,
) -> Result<Option<ReadyRespondingEngine>, Problem> {
    let Some(address) = found.address.clone().filter(|_| found.responding) else {
        return Ok(None);
    };
    if composes(&address) {
        return Ok(Some(ReadyRespondingEngine {
            address,
            detail: found.detail,
            installed: None,
        }));
    }

    let installed = install_engine()?;
    let ready = detect();
    let Some(address) = ready.address.clone().filter(|_| ready.responding) else {
        return Err(Problem::with(
            "OpenBot installed Compose, but the container engine is not answering. Try again.",
            ready.detail,
        ));
    };
    if !composes(&address) {
        return Err(Problem::plain(acquire::missing_compose(
            address.engine.binary(),
        )));
    }
    Ok(Some(ReadyRespondingEngine {
        address,
        detail: ready.detail,
        installed: Some(installed),
    }))
}

fn report<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    step: &str,
    ok: bool,
    detail: impl Into<String>,
) {
    let _ = app.emit(
        "setup:progress",
        Progress {
            step: step.into(),
            ok,
            detail: detail.into(),
        },
    );
}

fn remember_selected_root(shell: &Shell, root: &Path) {
    *shell.selected_root.lock().unwrap() = Some(root.to_path_buf());
}

fn cleanup_root(shell: &Shell, fallback_root: &Path) -> PathBuf {
    shell
        .root
        .lock()
        .unwrap()
        .clone()
        .or_else(|| shell.selected_root.lock().unwrap().clone())
        .unwrap_or_else(|| fallback_root.to_path_buf())
}

#[tauri::command]
fn detect_engine() -> engine::EngineStatus {
    engine::detect()
}

#[tauri::command]
fn windows_blocker() -> Result<Option<win::Blocker>, Problem> {
    win::blocker()
}

#[tauri::command]
fn windows_blocker_instruction(blocker: win::Blocker) -> String {
    blocker.instruction().to_string()
}

/// Bring the engine up: create the machine if it is missing, start it, then prove it answers.
///
/// Reported step by step rather than as one result, because these take minutes and a window with
/// nothing moving in it reads as a hang.
#[tauri::command]
async fn prepare_engine(app: tauri::AppHandle) -> Result<engine::EngineStatus, Problem> {
    engine_ready(&app).await?;
    Ok(engine::detect())
}

/// An engine that can run a container: installed, its machine up, and answering.
///
/// ONE function, because three screens need it and they used to disagree. Start installed and
/// created; both plan sign-ins only looked, and answered "No container engine is answering, so the
/// sign-in cannot run" on a machine whose whole setup exists to put one there. That sentence named
/// an obstacle and no way past it, on a screen where the way past it is ours to take.
///
/// Reported step by step rather than as one result, because these take minutes and a window with
/// nothing moving in it reads as a hang.
async fn engine_ready(app: &tauri::AppHandle) -> Result<engine::Address, Problem> {
    let found = engine::detect();
    let root = stack::default_root();
    let existing = tauri::async_runtime::spawn_blocking(move || {
        ready_responding_engine_after_compose_repair(
            found,
            || install::install_engine(&root),
            engine::detect,
            engine::Address::composes,
        )
    })
    .await
    .map_err(|error| {
        Problem::with(
            "OpenBot could not check the software it runs on. Try again.",
            format!("the engine check did not run: {error}"),
        )
    })?;
    match existing {
        Ok(Some(ready)) => {
            if let Some(installed) = ready.installed {
                report(app, "install-engine", true, installed);
            }
            report(app, "engine", true, ready.detail);
            return Ok(ready.address);
        }
        Ok(None) => {}
        Err(problem) => {
            report(app, "install-engine", false, problem.said.clone());
            return Err(problem);
        }
    }

    // Fetch and install an engine when there is none, and the Compose provider Podman ships
    // without either way. Nobody is sent to a download page: see `install.rs`.
    //
    // On a blocking thread for the reason the deployment fetch is: a blocking HTTP client dropped
    // inside an async context panics the worker instead of returning an error, and the window
    // survives that with a step that never ends.
    report(
        app,
        "install-engine",
        true,
        "Looking for the software OpenBot runs on.",
    );
    let installed =
        tauri::async_runtime::spawn_blocking(|| install::install_engine(&stack::default_root()))
            .await
            .map_err(|error| {
                Problem::with(
                    "OpenBot could not install the software it needs. Try again.",
                    format!("the install task did not run: {error}"),
                )
            })?;
    match installed {
        Ok(said) => report(app, "install-engine", true, said),
        Err(problem) => {
            report(app, "install-engine", false, problem.said.clone());
            return Err(problem);
        }
    }

    // One at a time, and each only if the last one worked. Written as a loop over an array once,
    // which ran all three before the first was checked: a failed `machine init` was still followed
    // by `machine start`.
    let created = acquire::create_machine(4, 6144, 60);
    report(app, "create-machine", created.ok, created.said.clone());
    if !created.ok {
        return Err(created.problem());
    }

    let started = acquire::start_machine();
    report(app, "start-machine", started.ok, started.said.clone());
    if !started.ok {
        return Err(started.problem());
    }

    let gate = acquire::health_gate(&acquire::address());
    report(app, "health-gate", gate.ok, gate.said.clone());
    if !gate.ok {
        return Err(gate.problem());
    }

    let ready = engine::detect();
    ready
        .address
        .clone()
        .filter(|_| ready.responding)
        .ok_or_else(|| {
            Problem::with(
                "OpenBot set up the software it runs on, but it is still not answering. Try again.",
                ready.detail,
            )
        })
}

/// The deployment on disk, fetched if it is not there or is the wrong version.
///
/// Extracted from `start_stack` because Start is no longer the only thing that needs it: a plan
/// sign-in runs a published image, and the reference for that image is read from the manifest this
/// lays down. Skipped when the recorded version already matches, so a restart is not a download.
async fn deployment_ready<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    root: &Path,
) -> Result<(), Problem> {
    if deployment::needs_fetch(root, DEPLOYMENT_VERSION) {
        report(
            app,
            "deployment",
            true,
            format!("fetching {DEPLOYMENT_VERSION}"),
        );
        // On a blocking thread, not this one. A blocking HTTP client builds its own runtime, and
        // dropping one inside an async context panics the worker rather than returning an error:
        // "Cannot drop a runtime in a context where blocking is not allowed". The window survives
        // that, which is worse than a crash, because the only symptom is a step that never ends.
        let target = root.to_path_buf();
        tauri::async_runtime::spawn_blocking(move || {
            deployment::fetch(&target, DEPLOYMENT_VERSION)
        })
        .await
        .map_err(|error| {
            Problem::with(
                "OpenBot could not download what it needs to run. Check the internet \
                     connection and try again.",
                format!("the download did not run: {error}"),
            )
        })?
        .inspect_err(|error| {
            report(app, "deployment", false, error.clone());
        })?;
    }
    report(
        app,
        "deployment",
        true,
        format!("{DEPLOYMENT_VERSION} in {}", root.display()),
    );
    Ok(())
}

/// The reference for an image the shell runs directly, rather than through Compose.
///
/// The deployment first, because the manifest that names the image is part of it. A sign-in on a
/// machine that has never started the stack has no manifest yet, and building a name instead is
/// what sent Podman to Docker Hub.
async fn sign_in_image(
    app: &tauri::AppHandle,
    root: &Path,
    published: &str,
) -> Result<String, Problem> {
    sign_in_image_with(
        root,
        published,
        |ready_root| async move { deployment_ready(app, &ready_root).await },
        deployment::reference,
    )
    .await
}

async fn sign_in_image_with<Ready, ReadyFuture, Reference>(
    root: &Path,
    published: &str,
    deployment_ready: Ready,
    reference: Reference,
) -> Result<String, Problem>
where
    Ready: FnOnce(PathBuf) -> ReadyFuture,
    ReadyFuture: std::future::Future<Output = Result<(), Problem>>,
    Reference: FnOnce(&Path, &str) -> Result<String, String>,
{
    deployment_ready(root.to_path_buf()).await?;
    sign_in_reference(root, published, reference)
}

fn sign_in_reference(
    root: &Path,
    published: &str,
    reference: impl FnOnce(&Path, &str) -> Result<String, String>,
) -> Result<String, Problem> {
    reference(root, published).map_err(|error| {
        Problem::with(
            "This version of OpenBot cannot sign in to that plan. Use an API key instead, or \
             update OpenBot.",
            error,
        )
    })
}

/// What the model screen chose, as the window sends it.
///
/// Deliberately not the same type as `ModelCredential`: this is whatever arrived over the bridge,
/// and turning it into a credential is a conversion that can fail. Accepting the credential type
/// directly would make an impossible combination representable at the boundary.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChosenModel {
    provider: String,
    login: String,
    api_key: Option<String>,
    base_url: Option<String>,
    container_base_url: Option<String>,
    model: Option<String>,
    /// Minted by signing in, never typed. Absent for every path but a plan.
    token: Option<String>,
    /// A saved credential/session indicator chosen in the window. The value is resolved here.
    saved: Option<bool>,
}

impl ChosenModel {
    fn into_credential(self, root: &Path) -> Result<openbot_env::ModelCredential, Problem> {
        self.into_credential_with(root, saved_secret)
    }

    fn into_credential_with(
        self,
        root: &Path,
        mut saved_secret: impl FnMut(&Path, &str) -> Result<String, Problem>,
    ) -> Result<openbot_env::ModelCredential, Problem> {
        let given = |value: Option<String>| value.unwrap_or_default().trim().to_string();
        let saved = self.saved.unwrap_or(false);
        match (self.provider.as_str(), self.login.as_str()) {
            ("openai", "api-key") => {
                let api_key = if saved {
                    saved_secret(root, "OPENAI_API_KEY")?
                } else {
                    given(self.api_key)
                };
                if saved && api_key.is_empty() {
                    return Err("That saved OpenAI API key is no longer available.".into());
                }
                Ok(openbot_env::ModelCredential::OpenAi { api_key })
            }
            ("anthropic", "api-key") => {
                let api_key = if saved {
                    saved_secret(root, "ANTHROPIC_API_KEY")?
                } else {
                    given(self.api_key)
                };
                if saved && api_key.is_empty() {
                    return Err("That saved Anthropic API key is no longer available.".into());
                }
                Ok(openbot_env::ModelCredential::Anthropic { api_key })
            }
            ("anthropic", "plan") => {
                let token = if saved {
                    saved_secret(root, "CLAUDE_CODE_OAUTH_TOKEN")?
                } else {
                    given(self.token)
                };
                if token.is_empty() {
                    // Said rather than written blank. A plan with no token produces a stack that
                    // comes up and a Bot that cannot answer, which reads as a broken product.
                    return Err("That Claude plan was not signed in to.".into());
                }
                Ok(openbot_env::ModelCredential::ClaudePlan { token })
            }
            /*
             * The sign-in hands back the vendor's whole token store, not one token, and it travels
             * in the same field the Claude plan uses. See `ModelCredential::ChatGptPlan`: the
             * refresh token in there is what keeps the Bot answering past the first hour.
             */
            ("openai", "plan") => {
                let store = if saved {
                    openbot_env::read_plan_store(root)
                        .map_err(|error| {
                            Problem::with(
                                "OpenBot could not read the saved ChatGPT sign-in.",
                                format!("{}: {error}", root.join(openbot_env::CHATGPT_STORE_FILE).display()),
                            )
                        })?
                        .unwrap_or_default()
                } else {
                    given(self.token)
                };
                if store.is_empty() {
                    return Err("That ChatGPT plan was not signed in to.".into());
                }
                Ok(openbot_env::ModelCredential::ChatGptPlan { store })
            }
            ("openai-compatible", "endpoint") => {
                let base_url = given(self.base_url);
                if !reqwest::Url::parse(&base_url)
                    .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
                {
                    return Err(
                        "Enter a valid http:// or https:// address for your model endpoint.".into(),
                    );
                }
                let container_base_url = given(self.container_base_url);
                if !container_base_url.is_empty()
                    && !reqwest::Url::parse(&container_base_url)
                        .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
                {
                    return Err(
                        "Enter a valid http:// or https:// address for the container model endpoint.".into(),
                    );
                }
                let model = given(self.model);
                if model.is_empty() {
                    return Err("Enter the model name your endpoint serves.".into());
                }
                let api_key = if saved {
                    use openbot_desktop_lib::saved_intent::{
                        compatible_key_from_record, SavedIntent, COMPATIBLE_CREDENTIAL,
                    };
                    if !SavedIntent::read(root).has_compatible_key_for(&base_url) {
                        return Err("That saved endpoint key does not belong to this address. Enter its API key again.".into());
                    }
                    let record = saved_secret(root, COMPATIBLE_CREDENTIAL)?;
                    compatible_key_from_record(&base_url, &record)?
                } else {
                    given(self.api_key)
                };
                Ok(openbot_env::ModelCredential::Compatible {
                    base_url,
                    container_base_url: (!container_base_url.is_empty())
                        .then_some(container_base_url),
                    api_key,
                    model,
                })
            }
            (provider, login) => Err(format!(
                "{provider} cannot be connected by {login}, which is not a way in that screen offers."
            )
            .into()),
        }
    }
}

fn start_stack_credential(
    root: &Path,
    model: ChosenModel,
) -> Result<openbot_env::ModelCredential, Problem> {
    model.into_credential(root)
}

#[cfg(test)]
fn start_stack_credential_with(
    root: &Path,
    model: ChosenModel,
    saved_secret: impl FnMut(&Path, &str) -> Result<String, Problem>,
) -> Result<openbot_env::ModelCredential, Problem> {
    model.into_credential_with(root, saved_secret)
}

fn saved_secret(root: &Path, key: &str) -> Result<String, Problem> {
    openbot_desktop_lib::vault::already_given_no_ui(root, &root.join(".env"), &[key])
        .map(|found| found.get(key).cloned().unwrap_or_default())
}

fn intelligence_key_for_start(
    root: &Path,
    given: String,
    mut resolve: impl FnMut(&Path, &str) -> Result<String, Problem>,
) -> Result<String, Problem> {
    let key = if given.trim().is_empty() {
        resolve(root, "INTELLIGENCE_API_KEY")?
    } else {
        given
    };
    if key.trim().is_empty() {
        return Err("That saved CopilotKit connection is no longer available. Sign in again or enter a project key.".into());
    }
    Ok(key)
}

fn require_existing_encryption_key(
    root: &Path,
    secrets: &std::collections::BTreeMap<String, String>,
) -> Result<(), Problem> {
    let configured = openbot_desktop_lib::saved_intent::SavedIntent::read(root)
        .model
        .is_some()
        || openbot_env::already_set(&root.join(".env"), &["DATABASE_URL"])
            .contains_key("DATABASE_URL");
    if configured
        && !secrets
            .get("KEY_ENCRYPTION_KEY")
            .is_some_and(|value| openbot_env::usable_encryption_key(value))
    {
        return Err(Problem::plain(
            "This installation's saved encryption key is missing, invalid, or public. Restore its original private key from backup, or get help preserving its saved data. OpenBot will not replace the key automatically.",
        ));
    }
    Ok(())
}

/// Write the `.env`, raise the containers, migrate, then start the three host processes.
#[tauri::command]
async fn start_stack<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: String,
    api_url: String,
    gateway_ws_url: String,
    api_key: String,
    model: ChosenModel,
    // The row the person picked, with the address only for the bring-your-own row.
    harness: Option<harness::HarnessChoice>,
    // Both registers on the way out: see `problem.rs`. Anything that still returns a bare string
    // converts to the plain half, so a path without its own sentence reads as it always did.
) -> Result<(), openbot_desktop_lib::problem::Problem> {
    let root = stack::root_from(&root);
    remember_selected_root(&app.state::<Shell>(), &root);
    start_stack_inner(app, root, api_url, gateway_ws_url, api_key, model, harness).await
}

async fn start_stack_inner<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: PathBuf,
    api_url: String,
    gateway_ws_url: String,
    api_key: String,
    model: ChosenModel,
    harness: Option<harness::HarnessChoice>,
) -> Result<(), Problem> {
    /*
     * Resolved from the catalogue rather than taken from the window.
     *
     * The image, the port and how it is dialled are facts about the harness, and the window
     * knowing them would mean two lists to keep in step. An id that is not in the catalogue is
     * refused here rather than written into `.env`, where it would become a Bot pointing at a
     * container nobody started.
     */
    // Resolved from the catalogue rather than taken from the window: the image, the port and how
    // it is dialled are facts about the harness, and the window knowing them would be a second
    // list to keep in step. See `harness::picked` for what each refusal is for.
    // Named rather than inlined: the Bot choice below reads it, the store file is written from it,
    // and reading the model screen twice could not be relied on to give the same answer.
    let credential = start_stack_credential(&root, model)?;

    /*
     * A PLAN CHOOSES ITS OWN BOT, because only one Bot can spend it.
     *
     * Every harness takes any model through a key, so the Bot step and the model step are
     * independent there. A subscription is not: it buys that vendor's own models through a path
     * that speaks that vendor's subscription auth, and nothing else. Signing in to a Claude plan
     * and keeping the default Bot produced a clean start and a Bot whose log said "Missing
     * credentials. Please pass an `api_key`" — the person had answered both screens correctly and
     * had no way to know which answer to change.
     *
     * Nobody is asked to know this, which is the audience rule. The plan re-points the Bot, and
     * the window says which Bot it will be while there is still a screen to say it on.
     */
    let harness =
        match &credential {
            openbot_env::ModelCredential::ClaudePlan { .. } => harness::speaking_for("anthropic")
                .map(|id| harness::HarnessChoice {
                    id: id.into(),
                    agent_url: None,
                }),
            openbot_env::ModelCredential::ChatGptPlan { .. } => harness::speaking_for("openai")
                .map(|id| harness::HarnessChoice {
                    id: id.into(),
                    agent_url: None,
                }),
            _ => harness,
        };
    let picked = harness::picked_after_deployment_ready(&root, harness.as_ref(), || async {
        deployment_ready(&app, &root).await
    })
    .await
    .map_err(|error| match error {
        harness::PickedAfterDeploymentError::Deployment(problem) => problem,
        // Two registers, because one of these refusals is about a release and the other is
        // about a pick. "OpenBot v0.0.8 does not include agent-langgraph-agui" is the
        // evidence, not the sentence: it names a published image, which is not a thing the
        // person chose or can change.
        harness::PickedAfterDeploymentError::Harness(error) => Problem::with(
            "This version of OpenBot does not include the Bot you picked. Go back and choose \
                 another, or update OpenBot.",
            error,
        ),
    })?;

    // Belt and braces: a fetch that reported success and left something out is still not a
    // deployment, and Compose's own error would not say which part was missing.
    if let Some(problem) = stack::deployment_problem(&root) {
        report(&app, "deployment", false, problem.clone());
        return Err(problem.into());
    }

    let status = engine::detect();
    let Some(found) = status.address.clone().filter(|_| status.responding) else {
        return Err(status.detail.into());
    };

    // Checked here as well as in the health gate, because the gate only runs when an engine had to
    // be installed. A machine that already had Podman skips all of that and arrives at Compose,
    // which is exactly the machine this was found on.
    if !found.composes() {
        let problem = acquire::missing_compose(found.engine.binary());
        report(&app, "engine", false, problem.clone());
        return Err(problem.into());
    }

    let api_key = intelligence_key_for_start(&root, api_key, saved_secret)?;
    let existing_secrets = openbot_desktop_lib::vault::already_given_no_ui(
        &root,
        &root.join(".env"),
        &openbot_env::MINTED[..],
    )?;
    require_existing_encryption_key(&root, &existing_secrets)?;

    let settings = openbot_env::compose(
        &openbot_env::Intelligence {
            api_url,
            gateway_ws_url,
            api_key,
        },
        &openbot_env::Model {
            credential: credential.clone(),
        },
        &status,
        &openbot_env::Ports::default(),
        &deployment::image_variables(&root)?,
        picked.as_ref(),
        // What a previous start of this deployment already minted. Without it every Start writes a
        // new KEY_ENCRYPTION_KEY and orphans everything the server had encrypted under the old one.
        &existing_secrets,
    );
    /*
     * The credentials come out here and never reach the file.
     *
     * `.env` is a settings file, and a settings file is something somebody can open, read out to
     * support or paste into a chat. A model key, a plan token and the tokens these services prove
     * themselves to each other with are not settings. They go to this machine's own credential
     * store, and travel from there to the processes that need them as environment, which is where
     * a secret can live without being written down. See `vault` for what each platform gets.
     */
    let (settings, secrets) = openbot_desktop_lib::vault::split(settings);
    /*
     * The credentials, plus any setting this answer dropped.
     *
     * `write` keeps lines it does not own, which is what protects a hand-set value. The cost is
     * that a key this run deliberately stopped writing would otherwise survive: `BOT_MODEL` did,
     * leaving an OpenAI key asking OpenAI for the model name a previous compatible-endpoint answer
     * had given. Anything the writer owns and did not produce this time is taken out.
     */
    let mut purge = secrets.clone();
    for key in ["BOT_PROVIDER", "BOT_MODEL", "AGENT_BOT_MODEL"] {
        if !settings.contains_key(key) {
            purge.insert(key.into(), String::new());
        }
    }
    openbot_desktop_lib::saved_intent::persist_configuration(
        &root,
        &settings,
        &secrets,
        &purge,
        &credential,
    )?;
    report(&app, "env", true, "settings written, credentials stored");

    // Said before rather than after. On a machine that has never run OpenBot this pulls five
    // images, and a person watching a button that says "Working" has no way to tell a download
    // from a hang.
    report(
        &app,
        "services",
        true,
        "pulling images and starting containers",
    );
    /*
     * The harness's port, before the containers rather than after.
     *
     * The check below covers the host processes, and it runs too late for this: a port already held
     * makes `compose up` fail inside the daemon, and what reaches the person is
     * "Bind for 0.0.0.0:4202 failed: port is already allocated". Every harness has a fixed port of
     * its own, so this is not a rare case — anything else using it, including a previous run's
     * container, produces that sentence.
     */
    /*
     * Our own containers are not somebody else on the port.
     *
     * A start that failed after the containers went up left them running, and the next press of
     * Start refused because of them, naming a port the person never chose and cannot find. See
     * `ports_we_already_publish`. `compose up` reuses what is already there, so the only thing this
     * check is for is a stranger on the port.
     */
    let ours = stack::ports_we_already_publish(&found, &root);
    if let Some(port) = picked.as_ref().and_then(|picked| picked.installed_port()) {
        if let Some(problem) = stack::port_already_taken_except(&[("Bot you picked", port)], &ours)
        {
            report(&app, "ports", false, problem.clone());
            return Err(problem.into());
        }
    }

    // Only an installed harness needs the local service; a BYO endpoint is already running elsewhere.
    let installed_harness = picked
        .as_ref()
        .and_then(|picked| picked.installed_port())
        .is_some();
    /*
     * The bundled Bots only when there is a key for them.
     *
     * A plan is not a key, and both of them refuse to start without one, so a person signing in
     * with the subscription they already pay for was handed two dead containers and two red lines
     * about Bots they never chose. See `BOTS_NEEDING_A_KEY`.
     */
    let bundled_bots = stack::BundledBots::for_credential(&credential);
    let requested_services = stack::up(&found, &root, installed_harness, bundled_bots, &secrets)?;
    report(&app, "services", true, "containers up");

    report(&app, "migrate", true, "applying migrations");
    stack::migrate(&found, &root, &secrets)?;
    report(&app, "migrate", true, "migrations applied");

    // `compose up` succeeds once it has asked for everything. A service that then exits is not its
    // problem, and both Bots exit immediately without a model key. Reported and made fatal here;
    // otherwise the window can show a healthy stack while nothing can answer a question.
    require_no_exited_compose_services(&found, &root, &requested_services, |detail| {
        report(&app, "services", false, detail);
    })?;

    /*
     * Reclaim this deployment's own host processes before deciding the ports are taken.
     *
     * Same failure as the containers above, by a different route: a start that got as far as
     * spawning the server and then stopped left it running, and the next attempt refused because
     * port 3001 was held. By its own server. These are found by working directory, so anything this
     * stops belongs to this deployment and to no other.
     */
    let reclaimed = cleanup_before_start(&app, &root, stack::stop_processes_under)?;

    // Before spawning: if these are still held, whatever answers later is not ours.
    let ports = openbot_env::Ports::default();
    if reclaimed > 0 {
        // A kill is not instant and the check is. Without this the socket of a process this run
        // just stopped reads as somebody else's, and the refusal names a process that no longer
        // exists. See `wait_for_ports_to_clear`.
        stack::wait_for_ports_to_clear(
            &[ports.server, ports.app],
            std::time::Duration::from_secs(5),
        );
    }
    if let Some(problem) =
        stack::port_already_taken(&[("API server", ports.server), ("app", ports.app)])
    {
        report(&app, "ports", false, problem.clone());
        return Err(problem.into());
    }

    let logs = root.join(".logs");
    let bun = which_bun().ok_or("bun was not found, so the API server cannot be started")?;

    // The source alone will not run: without this the server stops at a package it cannot resolve
    // and the app at a missing `vite`, neither of which mentions dependencies.
    report(&app, "dependencies", true, "installing");
    {
        let target = root.clone();
        let bun = bun.clone();
        tauri::async_runtime::spawn_blocking(move || stack::install_dependencies(&target, &bun))
            .await
            .map_err(|error| format!("the install did not run: {error}"))?
            .inspect_err(|error| report(&app, "dependencies", false, error.clone()))?;
    }
    report(&app, "dependencies", true, "installed");

    let logs_for_wait = logs.clone();
    let shell = app.state::<Shell>();
    let generation = start_host_processes(
        &shell,
        &root,
        &logs,
        &bun,
        &secrets,
        |name| report(&app, name, true, "started"),
        move |started| {
            stack::wait_until_answering(
                started,
                &logs_for_wait,
                &stack::Ready {
                    api: openbot_env::Ports::default().server,
                    app: openbot_env::Ports::default().app,
                },
                std::time::Duration::from_secs(180),
            )
        },
    )
    .await
    .inspect_err(|problem| report(&app, "answering", false, problem_detail(problem.clone())))?;
    // Only a stack that answered successfully acquires a restart policy.
    supervise_host_processes(app.clone(), root, logs, bun, secrets, generation);

    report(&app, "answering", true, "the API and the app are answering");
    Ok(())
}

/// This dedicated command accepts no setting, value, root or policy from the webview.
/// Stop what this started, and only what this started.
///
/// A Bot's computer belongs to the supervisor rather than to Compose and is deliberately left
/// running: its files and browser profile are volumes, and killing it here would sign somebody out
/// of everything their Bot had logged into.
#[tauri::command]
fn stop_stack(app: tauri::AppHandle, root: String) -> Result<(), String> {
    stop_everything(&app, &stack::root_from(&root))
}

#[cfg(test)]
fn shutdown_root(shell: &Shell, fallback_root: &Path) -> PathBuf {
    let mut active = shell.root.lock().unwrap();
    let root = active
        .clone()
        .or_else(|| shell.selected_root.lock().unwrap().clone())
        .unwrap_or_else(|| fallback_root.to_path_buf());
    *active = None;
    root
}

/// Take the whole stack down: the host processes, anything left over, and the containers.
///
/// One implementation, because there are three ways to ask for it (the button, the menu bar, and
/// quitting) and a person who used one of them and got a different amount of stopping would be
/// right to call that a bug.
fn stop_everything(app: &tauri::AppHandle, fallback_root: &Path) -> Result<(), String> {
    let shell = app.state::<Shell>();
    let root = root_for_stop(&shell, fallback_root);
    stop_everything_with(
        &shell,
        &root,
        stack::stop_processes_under,
        |root| match engine::detect().address {
            Some(found) => stack::down(&found, root),
            None => Ok(()),
        },
    )
}

fn root_for_stop(shell: &Shell, fallback_root: &Path) -> PathBuf {
    let root = cleanup_root(shell, fallback_root);
    remember_selected_root(shell, &root);
    root
}

fn stop_everything_with<C, D>(
    shell: &Shell,
    fallback_root: &Path,
    cleanup: C,
    down: D,
) -> Result<(), String>
where
    C: FnOnce(&Path) -> Result<usize, openbot_desktop_lib::problem::Problem>,
    D: FnOnce(&Path) -> Result<(), String>,
{
    let root = cleanup_root(shell, fallback_root);
    let mut failures = Vec::new();
    if let Err(problem) = retire_host_processes(shell, &root, cleanup) {
        failures.push(problem_detail(problem));
    }

    if let Err(problem) = down(&root) {
        failures.push(format!("Compose down failed: {problem}"));
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("\n"))
    }
}

/// Reclaim held replacements before consulting durable inventory. Keep the handles and pidfile
/// if any phase fails, so the next Stop or Start can retry with the same ownership evidence.
fn cleanup_host_children<C>(
    root: &Path,
    children: &mut Vec<(&'static str, std::process::Child)>,
    cleanup: C,
) -> Result<usize, Problem>
where
    C: FnOnce(&Path) -> Result<usize, Problem>,
{
    let held = stack::stop_host_children(root, children)?;
    stop_held_process_handles(children)?;
    let recorded = cleanup(root)?;
    Ok(held + recorded)
}

fn stop_held_process_handles(
    children: &mut Vec<(&'static str, std::process::Child)>,
) -> Result<(), Problem> {
    for (name, child) in children.iter_mut() {
        let failure = |error| {
            Problem::with(
                "OpenBot could not stop one of its host processes.",
                format!("could not finish stopping held {name}: {error}"),
            )
        };
        if child.try_wait().map_err(failure)?.is_none() {
            child.kill().map_err(failure)?;
        }
        child.wait().map_err(failure)?;
    }
    children.clear();
    Ok(())
}

fn cleanup_after_host_recording_failure<C, F>(
    shell: &Shell,
    root: &Path,
    children: &mut Vec<(&'static str, std::process::Child)>,
    recording: Problem,
    cleanup: C,
    force_handles: F,
) -> Result<u64, Problem>
where
    C: FnOnce(&Path, &mut Vec<(&'static str, std::process::Child)>) -> Result<usize, Problem>,
    F: FnOnce(&mut Vec<(&'static str, std::process::Child)>) -> Result<(), Problem>,
{
    shell
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let cleanup = cleanup(root, children);
    let failure = match cleanup {
        Ok(_) => {
            *shell.root.lock().unwrap() = None;
            return Err(recording);
        }
        Err(cleanup) => cleanup,
    };
    let forced = force_handles(children);
    let mut detail = recording.detail.unwrap_or_default();
    if !detail.is_empty() {
        detail.push('\n');
    }
    detail.push_str(&problem_detail(failure));
    match forced {
        Ok(()) => {
            *shell.root.lock().unwrap() = None;
        }
        Err(forced) => {
            detail.push('\n');
            detail.push_str(&problem_detail(forced));
        }
    }
    Err(Problem::with(recording.said, detail))
}

fn retire_host_processes<C>(shell: &Shell, root: &Path, cleanup: C) -> Result<usize, Problem>
where
    C: FnOnce(&Path) -> Result<usize, Problem>,
{
    // Invalidate before waiting for a restart that already owns the lock. That restart either
    // observes retirement before spawning, or publishes its handle before cleanup can proceed.
    shell
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let mut children = shell.children.lock().unwrap();
    let selected = shell
        .root
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| root.to_path_buf());
    let result = cleanup_host_children(&selected, &mut children, cleanup);
    if result.is_ok() {
        *shell.root.lock().unwrap() = None;
    }
    result
}

/// The initial host launch, including ownership handoff on every outcome.
async fn start_host_processes<R, W>(
    shell: &Shell,
    root: &Path,
    logs: &Path,
    bun: &Path,
    secrets: &stack::Secrets,
    mut report_started: R,
    wait: W,
) -> Result<u64, Problem>
where
    R: FnMut(&'static str),
    W: FnOnce(&mut Vec<(&'static str, std::process::Child)>) -> Result<(), String> + Send + 'static,
{
    let mut started = Vec::new();
    for process in stack::HOST_PROCESSES.iter() {
        let child = match stack::spawn_host_process(process, root, logs, bun, secrets) {
            Ok(child) => child,
            Err(error) => {
                return finish_host_start(
                    shell,
                    root,
                    started,
                    Err(format!("could not start {}: {error}", process.name)),
                );
            }
        };
        started.push((process.name, child));
        report_started(process.name);
    }
    // A failed blocking task must not drop the only handles either. The caller retains the
    // vector while readiness borrows it; even a panic returns every child to the same cleanup.
    let owned = std::sync::Arc::new(Mutex::new(started));
    let waiting = std::sync::Arc::clone(&owned);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut started = waiting.lock().unwrap();
        wait(&mut started)
    })
    .await
    .unwrap_or_else(|error| Err(format!("the wait did not run: {error}")));
    let started = std::mem::take(
        &mut *owned
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    );
    finish_host_start(shell, root, started, outcome)
}

fn finish_host_start(
    shell: &Shell,
    root: &Path,
    started: Vec<(&'static str, std::process::Child)>,
    outcome: Result<(), String>,
) -> Result<u64, Problem> {
    let mut children = shell.children.lock().unwrap();
    children.extend(started);
    *shell.root.lock().unwrap() = Some(root.to_path_buf());
    if let Err(original) = outcome {
        shell
            .generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // The initial failure is the reason Start failed, even if its cleanup also needs help.
        return match cleanup_host_children(root, &mut children, stack::stop_processes_under) {
            Ok(_) => {
                *shell.root.lock().unwrap() = None;
                Err(original.into())
            }
            Err(cleanup) => Err(Problem::with(original, problem_detail(cleanup))),
        };
    }
    // Keep handles only while the recording failure is being cleaned up. Reporting Start failure
    // while leaving the just-spawned host processes alive would recreate the orphan this ownership
    // record exists to prevent.
    if let Err(recording) = stack::record_host_processes(
        root,
        &children
            .iter()
            .map(|(name, child)| (*name, child.id()))
            .collect::<Vec<_>>(),
    ) {
        return cleanup_after_host_recording_failure(
            shell,
            root,
            &mut children,
            recording,
            |root, children| cleanup_host_children(root, children, stack::stop_processes_under),
            stop_held_process_handles,
        );
    }
    Ok(shell
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1)
}

fn require_no_exited_compose_services(
    found: &engine::Address,
    root: &Path,
    requested_services: &[&str],
    mut report_failure: impl FnMut(String),
) -> Result<(), Problem> {
    let requested: std::collections::HashSet<&str> = requested_services.iter().copied().collect();
    let dead = stack::services_that_exited_among(found, root, Some(&requested)).inspect_err(
        |problem| {
            report_failure(problem.said.clone());
        },
    )?;
    if dead.is_empty() {
        return Ok(());
    }

    let detail = dead
        .iter()
        .map(|(name, why)| format!("{name} stopped: {why}"))
        .collect::<Vec<_>>()
        .join("\n");
    for line in detail.lines() {
        report_failure(line.to_string());
    }
    Err(Problem::with(
        "Part of OpenBot stopped during startup.",
        detail,
    ))
}

fn cleanup_before_start<R, C>(
    app: &tauri::AppHandle<R>,
    root: &Path,
    cleanup: C,
) -> Result<usize, openbot_desktop_lib::problem::Problem>
where
    R: tauri::Runtime,
    C: FnOnce(&Path) -> Result<usize, openbot_desktop_lib::problem::Problem>,
{
    retire_host_processes(&app.state::<Shell>(), root, cleanup).inspect_err(|problem| {
        report(app, "cleanup", false, problem_detail(problem.clone()));
    })
}

fn problem_detail(problem: openbot_desktop_lib::problem::Problem) -> String {
    match problem.detail {
        Some(detail) => format!("{}\n{}", problem.said, detail),
        None => problem.said,
    }
}

fn exit_cleanup_with<C, D>(shell: &Shell, fallback_root: &Path, cleanup: C, down: D) -> Vec<String>
where
    C: FnOnce(&Path) -> Result<usize, openbot_desktop_lib::problem::Problem>,
    D: FnOnce(&Path) -> Result<(), String>,
{
    let root = cleanup_root(shell, fallback_root);
    let mut failures = Vec::new();
    if let Err(problem) = retire_host_processes(shell, &root, cleanup) {
        failures.push(problem_detail(problem));
    }
    if let Err(problem) = down(&root) {
        failures.push(format!("Compose down failed: {problem}"));
    }
    failures
}

fn report_exit_cleanup_failures<F>(failures: Vec<String>, mut sink: F)
where
    F: FnMut(&str),
{
    for failure in failures {
        sink(&format!("[exit] cleanup failed: {failure}"));
    }
}

/// Show OpenBot itself in this window.
///
/// The point of a desktop application is that it is the application. A window that sets things up
/// and then sends somebody to a browser tab is a launcher, and nobody wanted a launcher: they
/// double-clicked OpenBot to get OpenBot.
///
/// So the window navigates to the running app, and the tray keeps the controls that would otherwise
/// have nowhere to live. Setup comes back if the stack is stopped, because then there is something
/// to set up again.
///
/// The address is asked for rather than named. `stack::app_url` tries `127.0.0.1` and `[::1]` and
/// returns whichever answered, because a dev server binds whichever loopback its runtime resolved
/// and naming one guesses wrong half the time. Never the word `localhost`: it does not resolve the
/// same way on every operating system, which is the whole reason both are asked.
#[tauri::command]
fn show_openbot(app: tauri::AppHandle) -> Result<(), String> {
    show_openbot_on(app, &openbot_env::Ports::default())
}

fn show_openbot_on<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    ports: &openbot_env::Ports,
) -> Result<(), String> {
    let port = ports.app;
    // Where it answered, not where it was asked to listen. A dev server binds whichever loopback
    // its runtime resolved `localhost` to, and navigating to the other one shows a blank window
    // that looks like the app failing to start.
    let root = cleanup_root(&app.state::<Shell>(), &stack::default_root());
    let url = owned_app_url(&root, ports).ok_or_else(|| {
        format!("OpenBot could not verify its app on port {port} belongs to this installation. Try starting OpenBot again.")
    })?;
    eprintln!("[show] navigating the window to {url}");
    let window = app
        .get_webview_window("main")
        .ok_or("the OpenBot window is not there to show it in")?;
    let outcome = window
        .navigate(
            url.parse()
                .map_err(|error| format!("{url} is not a URL: {error}"))?,
        )
        .map_err(|error| format!("could not show OpenBot: {error}"));
    eprintln!("[show] navigate returned {outcome:?}");
    outcome
}

/// Put the setup screen back, when there is something to set up again.
#[tauri::command]
fn show_setup<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("the OpenBot window is not there")?;
    // Whatever this build serves its own interface from, recorded at startup from the window
    // itself. The dev server is the fallback because in development that is where it starts.
    let setup = app
        .state::<Shell>()
        .setup_url
        .lock()
        .unwrap()
        .clone()
        // Asked for, not named, and numeric either way: `localhost` resolves differently per
        // operating system, so the two loopbacks are tried and whichever answers is used. The
        // v4 literal is the last resort rather than a hostname.
        .unwrap_or_else(|| {
            stack::app_url(3020).unwrap_or_else(|| "http://127.0.0.1:3020".to_string())
        });
    window
        .navigate(
            setup
                .parse()
                .map_err(|error| format!("{setup} is not a URL: {error}"))?,
        )
        .map_err(|error| format!("could not go back to setup: {error}"))
}

/// Is a deployment this app manages already running?
///
/// The shell keeps what it started in memory, so closing the window and opening it again forgets a
/// stack that is still up. Without asking, the second launch offers to set up something already
/// running, and the port check then reports OpenBot as a foreign process holding its own port.
///
/// Asked of the deployment rather than of a file: a stamp says a deployment was installed, and only
/// an answer on the port says one is running now.
fn server_capabilities_answer(port: u16) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .ok()
        .and_then(|client| {
            client
                .get(format!("http://127.0.0.1:{port}/api/capabilities"))
                .send()
                .ok()
        })
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn already_running_on<F>(root: &Path, port: u16, owns_server: F) -> bool
where
    F: FnOnce(&Path, u16) -> Result<bool, Problem>,
{
    if deployment::installed(root).is_none() {
        return false;
    }
    server_capabilities_answer(port) && owns_server(root, port).unwrap_or(false)
}

#[tauri::command]
fn already_running(root: String) -> bool {
    let root = stack::root_from(&root);
    already_running_at(&root, &openbot_env::Ports::default())
}

fn already_running_at(root: &Path, ports: &openbot_env::Ports) -> bool {
    owned_app_url(root, ports).is_some()
}

/// Neither an owned API nor an answering app port alone authorizes showing a deployment.
fn owned_app_url(root: &Path, ports: &openbot_env::Ports) -> Option<String> {
    if !already_running_on(root, ports.server, stack::recorded_server_owns_port)
        || !stack::recorded_process_owns_port(root, "app", ports.app).unwrap_or(false)
    {
        return None;
    }
    stack::app_url(ports.app)
}

/// What stopped the stack, if anything did, and forget it once it has been read.
///
/// Cleared on reading so a failure from an hour ago does not greet somebody who has since fixed it.
#[tauri::command]
fn last_failure(app: tauri::AppHandle) -> Option<openbot_desktop_lib::problem::Problem> {
    app.state::<Shell>().last_failure.lock().unwrap().take()
}

#[tauri::command]
fn default_root() -> String {
    stack::default_root().to_string_lossy().into_owned()
}

#[tauri::command]
fn selected_root(app: tauri::AppHandle) -> Option<String> {
    app.state::<Shell>()
        .selected_root
        .lock()
        .unwrap()
        .as_ref()
        .map(|root| root.to_string_lossy().into_owned())
}

/**
Put the wizard's last question to the Bot, and hand back what it said.

THE DEFINITION OF DONE FOR AN INSTALL. Everything before this proves that things started; only this
proves the configuration works. See `ask` for why a run that says nothing is a failure rather than
an empty answer, and why the harness's log is fetched to fill the developer half.

The endpoint and the token come out of the `.env` this run just wrote, not from the window. They are
facts about the deployment, and a window carrying them would be a second copy to keep in step.
*/
#[tauri::command]
async fn ask_the_bot<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    root: String,
    question: String,
) -> Result<String, openbot_desktop_lib::problem::Problem> {
    ask_the_bot_inner(stack::root_from(&root), question).await
}

async fn ask_the_bot_inner(root: PathBuf, question: String) -> Result<String, Problem> {
    // The addresses come from the file and the token from the credential store, which is where
    // this run put it. Asked for together, because one without the other cannot ask anything.
    let settings = ask_saved_settings(&root)?;
    ask_the_bot_with_settings(root, question, settings).await
}

fn ask_saved_settings(root: &Path) -> Result<std::collections::BTreeMap<String, String>, Problem> {
    openbot_desktop_lib::vault::already_given_no_ui(
        root,
        &root.join(".env"),
        &[
            "PICKED_HARNESS_URL",
            "PICKED_HARNESS_KIND",
            "PICKED_HARNESS_AGENT_ID",
            "MANAGED_AGENT_AG_UI_URL",
            "MANAGED_AGENT_TOKEN",
        ],
    )
}

async fn ask_the_bot_with_settings(
    root: PathBuf,
    question: String,
    settings: std::collections::BTreeMap<String, String>,
) -> Result<String, openbot_desktop_lib::problem::Problem> {
    // The picked harness if there is one, and the Bot that ships with OpenBot if there is not.
    // Both speak AG-UI at the same address shape, so this screen does not care which it got.
    let picked_endpoint = settings
        .get("PICKED_HARNESS_URL")
        .filter(|url| !url.trim().is_empty());
    let (endpoint, log_service, kind, agent_id) = match picked_endpoint {
        Some(endpoint) => (
            endpoint.clone(),
            "agent-harness",
            settings.get("PICKED_HARNESS_KIND").cloned(),
            settings.get("PICKED_HARNESS_AGENT_ID").cloned(),
        ),
        None => (
            settings
                .get("MANAGED_AGENT_AG_UI_URL")
                .cloned()
                .unwrap_or_default(),
            "agent-langgraph",
            None,
            None,
        ),
    };
    let token = settings
        .get("MANAGED_AGENT_TOKEN")
        .cloned()
        .unwrap_or_default();
    if endpoint.trim().is_empty() || token.trim().is_empty() {
        return Err(openbot_desktop_lib::problem::Problem::plain(
            "OpenBot cannot find the Bot it just set up. Stop OpenBot and start it again.",
        ));
    }

    let question = if question.trim().is_empty() {
        openbot_desktop_lib::ask::SUGGESTED.to_string()
    } else {
        question
    };

    let asked = tauri::async_runtime::spawn_blocking(move || {
        match openbot_desktop_lib::ask::ask_harness(
            &endpoint,
            &token,
            &question,
            kind.as_deref(),
            agent_id.as_deref(),
        ) {
            Ok(answer) => Ok(answer),
            // The empty sentence is `ask` saying it has no reason to give, which is the case the
            // log exists for. Anything else already carries both halves.
            Err(problem) if problem.said.is_empty() => Err(None),
            Err(problem) => Err(Some(problem)),
        }
    })
    .await
    .map_err(|error| {
        openbot_desktop_lib::problem::Problem::plain(format!(
            "The question could not be asked: {error}"
        ))
    })?;

    match asked {
        Ok(answer) => Ok(answer),
        Err(Some(problem)) => Err(problem),
        Err(None) => {
            let log = engine::detect()
                .address
                .map(|found| stack::service_log(&found, &root, log_service, 40))
                .unwrap_or_default();
            Err(openbot_desktop_lib::ask::why_nothing_came_back(&log))
        }
    }
}

/**
What a previous run already wrote, so the wizard can arrive filled in.

Returned to the window because that is where the fields are, and it is the same machine and the
same person: reading their own file back to them is not a disclosure. The key is not logged here or
anywhere, and only the settings the wizard asks about are read.
*/
#[tauri::command]
fn already_configured(root: String) -> AlreadyConfigured {
    let root = stack::root_from(&root);
    let env_file = root.join(".env");
    let mut values = openbot_desktop_lib::vault::already_given_file_only(
        &env_file,
        &[
            "INTELLIGENCE_API_KEY",
            "INTELLIGENCE_API_URL",
            "INTELLIGENCE_GATEWAY_WS_URL",
            /*
             * The model credentials too, so the wizard never asks twice for one of these either.
             *
             * A key already in the file is one somebody has already produced, and making them find
             * it again means opening a dotfile in an editor. Read back for the same reason the
             * Intelligence key is: it is their own file, on their own machine, and this is the
             * screen that asks for it.
             */
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "OPENAI_BASE_URL",
            "OPENAI_CONTAINER_BASE_URL",
            "BOT_MODEL",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ],
    );

    use openbot_desktop_lib::saved_intent::{Category, SavedIntent};
    let intent = SavedIntent::read(&root);
    let hint = |category, file_present| {
        (file_present || intent.categories.contains(&category)).then_some(true)
    };
    let claude_plan = values.remove("CLAUDE_CODE_OAUTH_TOKEN").is_some();
    AlreadyConfigured {
        saved: SavedConfiguration {
            intelligence_api_key: hint(
                Category::Intelligence,
                values.contains_key("INTELLIGENCE_API_KEY"),
            ),
            model_api_keys: SavedModelApiKeys {
                openai: hint(
                    Category::OpenAiApiKey,
                    values.contains_key("OPENAI_API_KEY"),
                ),
                anthropic: hint(
                    Category::AnthropicApiKey,
                    values.contains_key("ANTHROPIC_API_KEY"),
                ),
                compatible: values
                    .get("OPENAI_BASE_URL")
                    .is_some_and(|url| intent.has_compatible_key_for(url))
                    .then_some(true),
            },
            model_sessions: SavedModelSessions {
                openai: hint(
                    Category::ChatGptPlan,
                    openbot_env::saved_chatgpt_plan_store(&root),
                ),
                anthropic: hint(Category::ClaudePlan, claude_plan),
            },
            model: intent.model,
        },
        values,
    }
}

/// The harness picker's rows. Data, so the screen is a list and not twelve branches.
#[tauri::command]
fn harnesses() -> Vec<harness::Harness> {
    harness::catalogue()
}

/// Start a Claude plan sign-in and return the address a browser has to open.
///
/// Blocking work on a blocking thread: it starts a container and waits on its output, and doing
/// that on the UI thread is a window that stops repainting mid-setup.
#[tauri::command]
async fn begin_claude_sign_in(app: tauri::AppHandle, root: String) -> Result<String, Problem> {
    let root = stack::root_from(&root);
    remember_selected_root(&app.state::<Shell>(), &root);
    /*
     * The image is decided here, not by the window, and it is the Claude Agent SDK harness whatever
     * harness the person picked. It is not being used as a Bot: it is the container that happens to
     * carry Anthropic's bundled CLI, which is what does the OAuth. Letting the screen name an image
     * would make the sign-in depend on a choice that has nothing to do with it.
     */
    // Set up rather than refused. The sign-in runs in a container, so it needs the same engine
    // Start needs and the same deployment Start needs, and on a first run nothing has fetched or
    // installed either yet.
    let address = engine_ready(&app).await?;
    let image = sign_in_image(&app, &root, openbot_desktop_lib::plan::SIGN_IN_IMAGE).await?;
    let (signing, url) = tauri::async_runtime::spawn_blocking(move || {
        openbot_desktop_lib::plan::SigningIn::begin(&address, &image)
    })
    .await
    .map_err(|error| {
        Problem::with(
            "The sign-in did not start. Try again.",
            format!("the sign-in task did not run: {error}"),
        )
    })??;
    *app.state::<Shell>().signing_in.lock().unwrap() = Some(signing);

    /*
     * Opened here rather than by the window, because the window would need the shell plugin's JS
     * half for the one call. The URL is returned as well, and the screen shows it: on Linux without
     * a registered browser, and in a session where the open silently does nothing, a link somebody
     * can copy is the difference between a stuck screen and a finished sign-in.
     */
    let _ = tauri_plugin_opener::OpenerExt::opener(&app).open_url(&url, None::<&str>);
    Ok(url)
}

/**
Redeem the code from the browser and return the plan token.

The token crosses to the window and comes back in the model choice, which is the same path a typed
key takes. It is never logged, and the failure messages never carry the command's output: see
`SigningIn::gave_up`.
*/
#[tauri::command]
async fn finish_claude_sign_in(app: tauri::AppHandle, code: String) -> Result<String, String> {
    // Taken, not borrowed. A sign-in is single-use, and leaving it in place would let a second
    // attempt write a code into a flow that has already finished.
    let signing = app
        .state::<Shell>()
        .signing_in
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "That sign-in is no longer running. Start it again.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || signing.finish(&code))
        .await
        .map_err(|error| format!("The sign-in did not finish: {error}"))?
}

/// Start a ChatGPT plan sign-in and return the address a browser has to open.
#[tauri::command]
async fn begin_chatgpt_sign_in(
    app: tauri::AppHandle,
    root: String,
) -> Result<String, openbot_desktop_lib::problem::Problem> {
    let root = stack::root_from(&root);
    remember_selected_root(&app.state::<Shell>(), &root);
    // Set up rather than refused: see `engine_ready`.
    let address = engine_ready(&app).await?;
    let image = sign_in_image(
        &app,
        &root,
        openbot_desktop_lib::plan::CHATGPT_SIGN_IN_IMAGE,
    )
    .await?;
    let (signing, url) = tauri::async_runtime::spawn_blocking(move || {
        openbot_desktop_lib::plan::SigningInToChatGpt::begin(&address, &image)
    })
    .await
    .map_err(|error| {
        Problem::with(
            "The sign-in did not start. Try again.",
            format!("the sign-in task did not run: {error}"),
        )
    })??;
    *app.state::<Shell>().signing_in_to_chatgpt.lock().unwrap() = Some(signing);
    let _ = tauri_plugin_opener::OpenerExt::opener(&app).open_url(&url, None::<&str>);
    Ok(url)
}

/**
Wait for the ChatGPT redirect to land, and return the plan token.

Nothing is sent: the browser's callback is what finishes it. So this is a wait rather than a
redemption, which is why there is no code field on that half of the screen.
*/
#[tauri::command]
async fn finish_chatgpt_sign_in(app: tauri::AppHandle) -> Result<String, String> {
    let signing = app
        .state::<Shell>()
        .signing_in_to_chatgpt
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "That sign-in is no longer running. Start it again.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || signing.finish())
        .await
        .map_err(|error| format!("The sign-in did not finish: {error}"))?
}

/// Start signing in to Intelligence and return the address a browser has to open.
#[tauri::command]
async fn begin_intelligence_sign_in(app: tauri::AppHandle) -> Result<String, String> {
    let (signing, url) = openbot_desktop_lib::intelligence::SigningInToIntelligence::begin()?;
    *app.state::<Shell>()
        .signing_in_to_intelligence
        .lock()
        .unwrap() = Some(signing);
    let _ = tauri_plugin_opener::OpenerExt::opener(&app).open_url(&url, None::<&str>);
    Ok(url)
}

/// Wait for that sign-in, and answer with the projects it can see.
///
/// The credential is kept on this side rather than handed to the window: the window's business is
/// which project, and a credential it never holds is one it cannot leak into a log or a screenshot.
#[tauri::command]
async fn finish_intelligence_sign_in(
    app: tauri::AppHandle,
) -> Result<Vec<openbot_desktop_lib::intelligence::Project>, openbot_desktop_lib::problem::Problem>
{
    let signing = app
        .state::<Shell>()
        .signing_in_to_intelligence
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| {
            openbot_desktop_lib::problem::Problem::plain(
                "That sign-in is no longer running. Start it again.",
            )
        })?;
    let (credential, projects) = tauri::async_runtime::spawn_blocking(move || signing.finish())
        .await
        .map_err(|error| {
            openbot_desktop_lib::problem::Problem::plain(format!(
                "The sign-in did not finish: {error}"
            ))
        })??;
    *app.state::<Shell>().intelligence_credential.lock().unwrap() = Some(credential);
    Ok(projects)
}

/// Create a key for the project somebody chose, and hand it back for the field.
#[tauri::command]
async fn intelligence_key_for(
    app: tauri::AppHandle,
    project: String,
) -> Result<String, openbot_desktop_lib::problem::Problem> {
    let credential = app
        .state::<Shell>()
        .intelligence_credential
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| {
            openbot_desktop_lib::problem::Problem::plain("Sign in to CopilotKit first.")
        })?;
    tauri::async_runtime::spawn_blocking(move || {
        openbot_desktop_lib::intelligence::provision_key(&credential, &project)
    })
    .await
    .map_err(|error| {
        openbot_desktop_lib::problem::Problem::plain(format!("A key could not be created: {error}"))
    })?
}

/// The model screen's rows. Independent of the picker above, and required to stay that way: no
/// harness on that list is tied to a vendor's models, so choosing one may not narrow this.
#[tauri::command]
fn providers() -> Vec<provider::Provider> {
    provider::catalogue()
}

/// `bun` from PATH, or the places an installer puts it when PATH has not been reloaded.
fn which_bun() -> Option<PathBuf> {
    if quiet::command("bun")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Some(PathBuf::from("bun"));
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let candidates = [
        PathBuf::from(&home).join(".bun/bin/bun"),
        PathBuf::from(&home).join(".bun/bin/bun.exe"),
    ];
    candidates.into_iter().find(|path| path.exists())
}

/// Watch the three host processes and start one again when it dies.
///
/// The policy is in `supervise.rs`; this is the loop that applies it. It ends when the stack is
/// stopped, which is what clearing the root means, so stopping does not race a restart.
fn supervise_host_processes<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: PathBuf,
    logs: PathBuf,
    bun: PathBuf,
    // Carried rather than fetched again on each restart. A restart happens when something is
    // already wrong, and a credential prompt at that moment is the worst time to ask for one.
    secrets: stack::Secrets,
    generation: u64,
) {
    std::thread::spawn(move || {
        eprintln!(
            "[watch] supervising {} host processes",
            stack::HOST_PROCESSES.len()
        );
        let mut watches: Vec<supervise::Watch> = stack::HOST_PROCESSES
            .iter()
            .map(|process| supervise::Watch::new(process.name))
            .collect();

        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let shell = app.state::<Shell>();
            // Not this run's any more, or no run at all.
            if shell.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
                || shell.root.lock().unwrap().is_none()
            {
                return;
            }

            // Which ones have died. Collected rather than acted on under the lock, because a
            // restart waits, and waiting while holding the children is how Stop would block on a
            // backoff nobody asked it to sit through.
            let dead: Vec<&'static str> = {
                let mut children = shell.children.lock().unwrap();
                let mut dead = Vec::new();
                for (name, child) in children.iter_mut() {
                    if let Ok(Some(_)) = child.try_wait() {
                        dead.push(*name);
                    }
                }
                dead
            };

            if !dead.is_empty() {
                eprintln!("[watch] dead: {dead:?}");
            }
            for name in dead {
                let Some(watch) = watches.iter_mut().find(|watch| watch.name == name) else {
                    continue;
                };
                if !watch.should_restart(std::time::Instant::now()) {
                    // Let go of it. A dead child left in the list is found dead again two seconds
                    // later, and forever after: the count climbs past what actually happened, the
                    // window is sent back to the setup screen on a loop, and the giving up that was
                    // supposed to stop a hot laptop becomes one.
                    {
                        let mut children = shell.children.lock().unwrap();
                        if shell.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
                        {
                            return;
                        }
                        children.retain(|(held, _)| *held != name);
                    }

                    let reason = watch.gave_up();
                    report(&app, name, false, reason.clone());
                    /*
                     * Both registers here too. `gave_up` names the process and quotes the tail of
                     * its log, which is the developer half; the person needs to know a piece of
                     * OpenBot stopped and that starting again is the thing to try.
                     */
                    *shell.last_failure.lock().unwrap() =
                        Some(openbot_desktop_lib::problem::Problem::with(
                            format!(
                                "Part of OpenBot ({name}) stopped and could not be started again. \
                                 Try starting OpenBot once more."
                            ),
                            reason,
                        ));
                    // Back to the setup screen. By now the window is showing OpenBot, and OpenBot
                    // is not running: leaving it there is a window that lies.
                    let _ = show_setup(app.clone());
                    continue;
                }
                report(
                    &app,
                    name,
                    false,
                    format!("{name} stopped. Starting it again."),
                );
                std::thread::sleep(supervise::backoff(watch.restarts - 1));

                // Asked again after the backoff: a stop, or another start, may have happened while
                // this was waiting, and starting a process into either is how an orphan is made.
                if shell.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
                    || shell.root.lock().unwrap().is_none()
                {
                    return;
                }
                let Some(process) = stack::HOST_PROCESSES
                    .iter()
                    .find(|process| process.name == name)
                else {
                    continue;
                };
                match restart_host_process_with(&shell, &root, name, generation, || {
                    stack::spawn_host_process(process, &root, &logs, &bun, &secrets)
                }) {
                    Ok(true) => report(&app, name, true, "started again"),
                    Ok(false) => return,
                    Err(problem) => {
                        report(&app, name, false, problem.said.clone());
                        *shell.last_failure.lock().unwrap() = Some(problem);
                    }
                }
            }
        }
    });
}

/// The same lock covers generation validation, launch, publication, and owned cleanup on every
/// platform. Stop can retire during spawn, but cannot finish before receiving that child handle.
fn restart_host_process_with<F>(
    shell: &Shell,
    root: &Path,
    name: &'static str,
    generation: u64,
    spawn: F,
) -> Result<bool, Problem>
where
    F: FnOnce() -> std::io::Result<std::process::Child>,
{
    let mut children = shell.children.lock().unwrap();
    if shell.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
        || shell.root.lock().unwrap().as_deref() != Some(root)
    {
        return Ok(false);
    }
    let child = spawn().map_err(|error| {
        Problem::with(
            format!("OpenBot could not restart {name}."),
            error.to_string(),
        )
    })?;
    #[cfg(unix)]
    stack::replace_host_process(root, &mut children, name, child)?;
    #[cfg(not(unix))]
    {
        children.retain(|(held, _)| *held != name);
        children.push((name, child));
    }
    Ok(shell.generation.load(std::sync::atomic::Ordering::SeqCst) == generation)
}

/// Point the window at OpenBot if it is up, and at the setup screen if it is not.
///
/// Used by the tray and by a second launch, both of which happen at moments when the caller has no
/// idea which of the two the person should be looking at.
fn show_whichever_applies(app: &tauri::AppHandle) {
    restore_window_on(app, &openbot_env::Ports::default());
}

fn restore_window_on<R: tauri::Runtime>(app: &tauri::AppHandle<R>, ports: &openbot_env::Ports) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let shell = app.state::<Shell>();
    let root = cleanup_root(&shell, &stack::default_root());
    // Restore has the same deployment ownership requirement as the setup page's passive probe.
    // A successful app-port response alone may belong to another installation or application.
    if let Some(url) = owned_app_url(&root, ports) {
        if let Ok(parsed) = url.parse() {
            let _ = window.navigate(parsed);
        }
    } else {
        let _ = show_setup(app.clone());
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn schedule_second_instance_restore<T, F>(
    context: T,
    restore: F,
) -> std::io::Result<std::thread::JoinHandle<()>>
where
    T: Send + 'static,
    F: FnOnce(T) + Send + 'static,
{
    std::thread::Builder::new()
        .name("openbot-second-instance-restore".into())
        .spawn(move || restore(context))
}

fn restore_after_second_instance(app: &tauri::AppHandle) {
    let app = app.clone();
    let reporting_app = app.clone();
    if let Err(error) = schedule_second_instance_restore(app, |app| {
        show_whichever_applies(&app);
    }) {
        eprintln!("[single-instance] restore scheduling failed: {error}");
        report(
            &reporting_app,
            "open",
            false,
            format!("OpenBot could not show the existing window: {error}"),
        );
    }
}

/// What each of the three items does, wherever it was chosen from.
///
/// The tray and the window menu carry the same items, so they share one function: two copies would
/// be two chances for Stop to mean something different depending on where somebody clicked.
fn chose(app: &tauri::AppHandle, item: &str) {
    match item {
        "open" => show_whichever_applies(app),
        // Stop without quitting: the stack is what costs something to leave running, and somebody
        // who wants it stopped does not necessarily want the application gone.
        "stop" => {
            let app = app.clone();
            std::thread::spawn(move || {
                let root = default_root();
                eprintln!("[menu] stopping the stack under {root}");
                match stop_everything(&app, &PathBuf::from(root)) {
                    Ok(()) => {
                        eprintln!("[menu] stopped");
                        report(&app, "stopped", true, "OpenBot has been stopped");
                    }
                    // Said rather than swallowed. A menu item that fails silently is worse than one
                    // that is not there: the person believes the stack is down and it is not.
                    Err(problem) => {
                        eprintln!("[menu] stop failed: {problem}");
                        report(&app, "stopped", false, problem);
                    }
                }
                let _ = show_setup(app.clone());
            });
        }
        // Exit rather than hide: quitting is a decision to stop, and the exit handler is what stops
        // the processes with it.
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

fn main() {
    tauri::Builder::default()
        // A second launch is somebody looking for the window they already have, not a request for a
        // second stack. Without this both copies bind the same ports and the loser reports a
        // failure that belongs to the winner.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            restore_after_second_instance(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![
            detect_engine,
            windows_blocker,
            windows_blocker_instruction,
            prepare_engine,
            start_stack,
            stop_stack,
            show_openbot,
            show_setup,
            already_running,
            last_failure,
            default_root,
            selected_root,
            harnesses,
            providers,
            already_configured,
            begin_claude_sign_in,
            finish_claude_sign_in,
            begin_chatgpt_sign_in,
            finish_chatgpt_sign_in,
            begin_intelligence_sign_in,
            finish_intelligence_sign_in,
            intelligence_key_for,
            ask_the_bot,
        ])
        // A packaged application is not a browser tab. Left alone, WebView2 answers a right-click
        // with Back, Refresh, Save as and Print: Back walks the window out of OpenBot with nothing
        // to walk it home, and Save as offers to write the page to disk as `Webpage, complete`.
        // macOS never showed this because Tauri suppresses it there in release builds; Windows has
        // no such setting, and Tauri has no configuration option for it either, so the page is
        // asked to refuse. Every navigation, because the window navigates to OpenBot and back.
        .on_page_load(|window, _| {
            let _ = window
                .eval("document.addEventListener('contextmenu', e => e.preventDefault(), true)");
        })
        // Closing the window hides it. A tray application whose window is destroyed on close has a
        // menu item that points at nothing: `get_webview_window` returns None from then on, and the
        // only way back is to quit and start again, with a stack still running that nothing on
        // screen can reach.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            // Where the Compose provider OpenBot installs itself lives, told once so every engine
            // command can put it on the child's PATH. Before anything asks for an engine.
            engine::tools_live_in(engine::tools_dir_under(&acquire::download_dir(
                &stack::default_root(),
            )));

            if let Some(window) = app.get_webview_window("main") {
                // Asked before anything navigates away from it.
                *app.state::<Shell>().setup_url.lock().unwrap() = Some(window.url()?.to_string());
            }

            // The status menu lets somebody open the window, stop the stack, or quit the app.
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;

            let open = MenuItem::with_id(app, "open", "Open OpenBot", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop OpenBot", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &stop, &quit])?;

            TrayIconBuilder::with_id("openbot")
                .icon(tray::icon())
                .icon_as_template(false)
                .tooltip("OpenBot")
                .menu(&menu)
                .build(app)?;

            // The same three items on the window itself, because the tray cannot be relied on and
            // Stop lives nowhere else.
            //
            // Linux needs a tray host to draw the icon, and Windows can place it in overflow.
            // The tray library restores the Windows icon after Explorer restarts, but the window
            // menu still provides access when the tray is unavailable or hard to find.
            // Its own items, not the tray's: a menu item belongs to one menu, and the two menus
            // outlive each other. The ids match so both arrive at the same function.
            use tauri::menu::Submenu;
            let window_open = MenuItem::with_id(app, "open", "Open OpenBot", true, None::<&str>)?;
            let window_stop = MenuItem::with_id(app, "stop", "Stop OpenBot", true, None::<&str>)?;
            let window_quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            // A submenu, because a top-level entry in a menu bar has to be one to open at all.
            let openbot = Submenu::with_items(
                app,
                "OpenBot",
                true,
                &[&window_open, &window_stop, &window_quit],
            )?;
            /*
             * AN EDIT MENU, WITHOUT WHICH COMMAND-V DOES NOTHING.
             *
             * MEASURED, on the screen that asks for a paste. macOS routes the clipboard shortcuts
             * through the menu bar, so a window with no Edit menu has no Paste, and a webview text
             * field silently ignores the keystroke. Typing worked and pasting did not, on the one
             * screen whose own instruction is "paste the code it shows you". Every person signing
             * in to a Claude plan would have reached that field, pressed the shortcut everybody
             * knows, and had nothing happen.
             *
             * Predefined items rather than our own: these carry the standard shortcuts and the
             * standard behaviour, which is the whole point of them being where a person expects.
             */
            use tauri::menu::PredefinedMenuItem;
            let edit = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            app.set_menu(Menu::with_items(app, &[&openbot, &edit])?)?;
            app.on_menu_event(|app, event| chose(app, event.id().as_ref()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the OpenBot window could not be created")
        .run(|app, event| {
            match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    show_whichever_applies(app);
                }
                tauri::RunEvent::Exit => {
                    // Nothing this started may outlive it.
                    //
                    // A child that survives the window is the failure Tauri has a standing issue about: an
                    // orphaned server keeps port 3001, the next launch cannot bind it, and nothing on
                    // screen says why. Asked to stop first, then made to, because a server given a moment
                    // closes its database connections and one that is shot does not.
                    // `Exit` only. `ExitRequested` fires first and for the same quit, and running this
                    // twice means a second SIGTERM to a process that has already gone and another wait
                    // nobody is watching.
                    let shell = app.state::<Shell>();
                    let default = PathBuf::from(default_root());

                    // The containers too. Leaving five of them running behind an application that is
                    // no longer on screen is the one outcome nobody can act on: there is no window to
                    // stop them from and nothing to say they are there.
                    report_exit_cleanup_failures(
                        exit_cleanup_with(&shell, &default, stack::stop_processes_under, |root| {
                            match engine::detect().address {
                                Some(found) => stack::down(&found, root),
                                None => Ok(()),
                            }
                        }),
                        |failure| eprintln!("{failure}"),
                    );
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    #[test]
    fn ask_transport_regressions_do_not_load_from_the_vault() {
        let source = include_str!("main.rs");
        let test = source
            .split("\n    fn ask_the_bot_uses_native_mastra_for_a_picked_mastra_harness()")
            .nth(1)
            .expect("ID12 regression")
            .split("struct TestRequest")
            .next()
            .expect("ID12 regression body");

        assert!(
            !test.contains("ask_the_bot("),
            "ID12 must test dispatch with resolved settings instead of loading vault-backed settings"
        );
    }

    #[test]
    fn public_already_configured_reads_only_passive_files() {
        let root = temp_root("public-passive-boundary");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(".env"),
            "INTELLIGENCE_API_URL=https://synthetic.example\n",
        )
        .unwrap();
        for metadata in [
            None,
            Some("malformed"),
            Some(r#"{"version":9,"categories":["intelligence"],"model":null}"#),
            Some(
                r#"{"version":1,"categories":["intelligence","claude-plan"],"model":"claude-plan"}"#,
            ),
        ] {
            if let Some(metadata) = metadata {
                std::fs::write(root.join(openbot_desktop_lib::saved_intent::FILE), metadata)
                    .unwrap();
            }
            for legacy in ["", "INTELLIGENCE_API_KEY=synthetic-cpk\nOPENAI_API_KEY=synthetic-openai\nANTHROPIC_API_KEY=synthetic-anthropic\nCLAUDE_CODE_OAUTH_TOKEN=synthetic-claude\n"] {
                std::fs::write(root.join(".env"), format!("INTELLIGENCE_API_URL=https://synthetic.example\n{legacy}")).unwrap();
                let configured = already_configured(root.to_string_lossy().into_owned());
                assert_eq!(configured.values["INTELLIGENCE_API_URL"], "https://synthetic.example");
                assert!(!configured.values.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plan_sign_in_boundary_uses_selected_root_for_deploy_and_reference() {
        let default = temp_root("signin-default-root");
        let selected = temp_root("signin-selected-root");
        std::fs::create_dir_all(&default).unwrap();
        std::fs::create_dir_all(&selected).unwrap();
        std::fs::write(default.join("manifest.json"), "poisoned-default").unwrap();
        let ready_root = std::cell::RefCell::new(None);
        let reference_root = std::cell::RefCell::new(None);

        let image = tauri::async_runtime::block_on(sign_in_image_with(
            &selected,
            openbot_desktop_lib::plan::CHATGPT_SIGN_IN_IMAGE,
            |root| {
                *ready_root.borrow_mut() = Some(root);
                async { Ok(()) }
            },
            |root, published| {
                *reference_root.borrow_mut() = Some((root.to_path_buf(), published.to_string()));
                Ok(format!("{}@{}", published, root.display()))
            },
        ))
        .unwrap();

        assert_eq!(ready_root.into_inner(), Some(selected.clone()));
        assert_eq!(
            reference_root.into_inner(),
            Some((
                selected.clone(),
                openbot_desktop_lib::plan::CHATGPT_SIGN_IN_IMAGE.to_string()
            ))
        );
        assert!(image.contains(&selected.to_string_lossy().to_string()));
        assert!(!image.contains(&default.to_string_lossy().to_string()));
        assert_eq!(
            std::fs::read_to_string(default.join("manifest.json")).unwrap(),
            "poisoned-default"
        );
        let _ = std::fs::remove_dir_all(default);
        let _ = std::fs::remove_dir_all(selected);
    }

    #[test]
    fn command_roots_trim_paste_padding_and_preserve_interior_spaces() {
        let root = temp_root("openbot-command-root My Files");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("settings-marker"), "this deployment").unwrap();
        for typed in [
            root.display().to_string(),
            format!(" \n{}\t ", root.display()),
        ] {
            let work_root = stack::root_from(&typed);
            assert_eq!(
                std::fs::read_to_string(work_root.join("settings-marker")).unwrap(),
                "this deployment"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn credential_restore_commands_are_not_registered() {
        let source = include_str!("main.rs");
        let handlers = source
            .split("tauri::generate_handler![")
            .nth(1)
            .expect("handler list exists")
            .split("])")
            .next()
            .expect("handler list closes");
        for command in [
            ["reco", "ver", "_credential"].concat(),
            ["cancel", "_credential", "_reco", "very"].concat(),
        ] {
            assert!(
                !handlers.contains(&command),
                "{command} is still registered"
            );
        }
    }

    #[test]
    fn already_configured_trims_pasted_root_and_preserves_interior_spaces() {
        let root = temp_root("openbot-pasted-root My Files");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(".env"),
            "INTELLIGENCE_API_URL=https://trim.example.test\n",
        )
        .unwrap();
        let typed = format!(" \n{}\t ", root.display());
        let configured = already_configured(typed);
        let normal = already_configured(root.to_string_lossy().into_owned());
        assert_eq!(configured.values, normal.values);
        assert_eq!(
            configured.values.get("INTELLIGENCE_API_URL"),
            Some(&"https://trim.example.test".to_string())
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn already_configured_returns_file_values_and_saved_indicators() {
        let root = temp_root("openbot-already-configured");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(".env"),
            "INTELLIGENCE_API_KEY=file-cpk\nOPENAI_API_KEY=file-openai\nOPENAI_BASE_URL=https://models.example/v1\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join(".langchain")).unwrap();
        std::fs::write(
            root.join(openbot_env::CHATGPT_STORE_FILE),
            "{\"refresh_token\":\"stored\"}\n",
        )
        .unwrap();

        let configured = already_configured(root.to_string_lossy().into_owned());

        assert_eq!(
            configured.values.get("INTELLIGENCE_API_KEY"),
            Some(&"file-cpk".to_string())
        );
        assert_eq!(
            configured.values.get("OPENAI_API_KEY"),
            Some(&"file-openai".to_string())
        );
        assert_eq!(configured.saved.intelligence_api_key, Some(true));
        assert_eq!(configured.saved.model_api_keys.openai, Some(true));
        assert_eq!(configured.saved.model_sessions.openai, Some(true));
        assert_eq!(configured.saved.model_sessions.anthropic, None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn already_configured_reports_legacy_anthropic_plan_without_returning_token() {
        let root = temp_root("openbot-already-configured-anthropic-session");
        std::fs::create_dir_all(&root).unwrap();

        std::fs::write(
            root.join(".env"),
            "CLAUDE_CODE_OAUTH_TOKEN=synthetic-legacy-plan\n",
        )
        .unwrap();
        let configured = already_configured(root.to_string_lossy().into_owned());

        assert_eq!(configured.saved.model_sessions.anthropic, Some(true));
        assert!(!configured.values.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn second_instance_restore_runs_blocking_probe_outside_the_async_listener() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 512];
            let _ = stream.read(&mut request).unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });
        let (sent, received) = std::sync::mpsc::channel();

        let scheduled = tauri::async_runtime::block_on(async move {
            tauri::async_runtime::spawn(async move {
                schedule_second_instance_restore(port, move |port| {
                    sent.send(stack::app_url(port).is_some()).unwrap();
                })
                .unwrap()
                .join()
                .unwrap();
            })
            .await
        });

        assert!(
            scheduled.is_ok(),
            "the async single-instance listener must not panic while scheduling restore"
        );
        assert!(received.recv().unwrap());
        server.join().unwrap();
    }

    #[test]
    fn passive_metadata_and_legacy_hints_are_root_and_provider_scoped() {
        let root = temp_root("public-intent-cases");
        std::fs::create_dir_all(&root).unwrap();
        for input in [
            None,
            Some("bad json"),
            Some(r#"{"version":42,"categories":["intelligence"],"model":null}"#),
        ] {
            if let Some(input) = input {
                std::fs::write(root.join(openbot_desktop_lib::saved_intent::FILE), input).unwrap();
            }
            let unknown = already_configured(root.to_string_lossy().into_owned());
            assert_eq!(unknown.saved.intelligence_api_key, None);
            assert_eq!(unknown.saved.model_sessions.anthropic, None);
        }
        std::fs::write(
            root.join(openbot_desktop_lib::saved_intent::FILE),
            r#"{"version":1,"categories":["intelligence","claude-plan"],"model":"claude-plan"}"#,
        )
        .unwrap();
        let recorded = already_configured(root.to_string_lossy().into_owned());
        assert_eq!(recorded.saved.intelligence_api_key, Some(true));
        assert_eq!(recorded.saved.model_sessions.anthropic, Some(true));
        assert_eq!(recorded.saved.model_api_keys.anthropic, None);
        assert_eq!(recorded.saved.model_sessions.openai, None);
        assert!(recorded.values.is_empty());
        let fresh = already_configured(
            temp_root("different-public-root")
                .to_string_lossy()
                .into_owned(),
        );
        assert_eq!(fresh.saved.model_sessions.anthropic, None);
        std::fs::write(
            root.join(".env"),
            "ANTHROPIC_API_KEY=synthetic-legacy-anthropic\n",
        )
        .unwrap();
        let legacy = already_configured(root.to_string_lossy().into_owned());
        assert_eq!(legacy.saved.model_api_keys.anthropic, Some(true));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saved_selection_refusal_never_falls_back_to_a_different_provider_or_billing_mode() {
        let root = temp_root("explicit-saved-refusal");
        for (provider, login, expected) in [
            ("openai", "api-key", "OPENAI_API_KEY"),
            ("anthropic", "api-key", "ANTHROPIC_API_KEY"),
            ("anthropic", "plan", "CLAUDE_CODE_OAUTH_TOKEN"),
        ] {
            for denied in [false, true] {
                let mut calls = Vec::new();
                let choice = ChosenModel {
                    provider: provider.into(),
                    login: login.into(),
                    api_key: Some("synthetic-unselected-billable-key".into()),
                    base_url: None,
                    container_base_url: None,
                    model: None,
                    token: None,
                    saved: Some(true),
                };
                let result = start_stack_credential_with(&root, choice, |_, key| {
                    calls.push(key.to_string());
                    if denied {
                        Err(Problem::plain("synthetic access denied"))
                    } else {
                        Ok(String::new())
                    }
                });
                let problem = result.expect_err("selected credential is unavailable");
                assert!(!problem.said.is_empty());
                if denied {
                    assert_eq!(problem.said, "synthetic access denied");
                }
                assert_eq!(calls, [expected]);
            }
        }
        for denied in [false, true] {
            let result = intelligence_key_for_start(&root, String::new(), |_, key| {
                assert_eq!(key, "INTELLIGENCE_API_KEY");
                if denied {
                    Err(Problem::plain("synthetic access denied"))
                } else {
                    Ok(String::new())
                }
            });
            assert!(result.is_err());
        }
        // A missing or unreadable ChatGPT file is an action error; no API-key resolver is called.
        std::fs::create_dir_all(&root).unwrap();
        for unreadable in [false, true] {
            if unreadable {
                std::fs::create_dir_all(root.join(openbot_env::CHATGPT_STORE_FILE)).unwrap();
            }
            let choice = ChosenModel {
                provider: "openai".into(),
                login: "plan".into(),
                api_key: Some("synthetic-unselected-key".into()),
                base_url: None,
                container_base_url: None,
                model: None,
                token: None,
                saved: Some(true),
            };
            assert!(start_stack_credential_with(&root, choice, |_, _| panic!(
                "plan must not fall back to an API key"
            ))
            .is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn start_and_ask_resolve_saved_secrets_from_the_selected_root() {
        let root_a = temp_root("selected-saved-root-a");
        let root_b = temp_root("selected-saved-root-b");
        for (root, label) in [(&root_a, "a"), (&root_b, "b")] {
            std::fs::create_dir_all(root).unwrap();
            std::fs::write(
                root.join(".env"),
                format!("MANAGED_AGENT_AG_UI_URL=https://agent-{label}.example\n"),
            )
            .unwrap();
            openbot_desktop_lib::vault::remember(
                root,
                "OPENAI_API_KEY",
                &format!("openai-{label}"),
            )
            .unwrap();
            openbot_desktop_lib::vault::remember(
                root,
                "MANAGED_AGENT_TOKEN",
                &format!("agent-{label}"),
            )
            .unwrap();
        }

        let credential = start_stack_credential_with(
            &root_b,
            ChosenModel {
                provider: "openai".into(),
                login: "api-key".into(),
                api_key: None,
                base_url: None,
                container_base_url: None,
                model: None,
                token: None,
                saved: Some(true),
            },
            saved_secret,
        )
        .unwrap();
        assert_eq!(
            credential,
            openbot_env::ModelCredential::OpenAi {
                api_key: "openai-b".into()
            }
        );

        let settings = ask_saved_settings(&root_b).unwrap();
        assert_eq!(
            settings.get("MANAGED_AGENT_AG_UI_URL").map(String::as_str),
            Some("https://agent-b.example")
        );
        assert_eq!(
            settings.get("MANAGED_AGENT_TOKEN").map(String::as_str),
            Some("agent-b")
        );

        std::fs::remove_dir_all(root_a).unwrap();
        std::fs::remove_dir_all(root_b).unwrap();
    }

    #[test]
    fn saved_api_key_start_reports_unreadable_env_before_store_resolution() {
        let root = temp_root("start-unreadable-env");
        std::fs::create_dir_all(root.join(".env")).unwrap();

        let problem = start_stack_credential(
            &root,
            ChosenModel {
                provider: "openai".into(),
                login: "api-key".into(),
                api_key: None,
                base_url: None,
                container_base_url: None,
                model: None,
                token: None,
                saved: Some(true),
            },
        )
        .expect_err("unreadable .env must stop saved-key resolution");

        assert_eq!(problem.said, "OpenBot could not read its settings.");
        assert!(
            problem
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains(root.join(".env").to_string_lossy().as_ref())),
            "{problem:?}"
        );
        assert!(root.join(".env").is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ask_reports_unreadable_env_before_store_resolution_or_http() {
        let root = temp_root("ask-unreadable-env");
        std::fs::create_dir_all(root.join(".env")).unwrap();

        let problem =
            tauri::async_runtime::block_on(ask_the_bot_inner(root.clone(), "hello".into()))
                .expect_err("unreadable .env must stop Ask before transport");

        assert_eq!(problem.said, "OpenBot could not read its settings.");
        assert!(
            problem
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains(root.join(".env").to_string_lossy().as_ref())),
            "{problem:?}"
        );
        assert!(root.join(".env").is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_installation_rejects_unusable_original_encryption_keys() {
        for marker in ["database", "model"] {
            let root = temp_root(&format!("unusable-existing-encryption-key-{marker}"));
            std::fs::create_dir_all(&root).unwrap();
            if marker == "database" {
                std::fs::write(
                    root.join(".env"),
                    "DATABASE_URL=postgres://synthetic-local\n",
                )
                .unwrap();
            } else {
                std::fs::write(
                    root.join(openbot_desktop_lib::saved_intent::FILE),
                    r#"{"version":1,"categories":[],"model":"open-ai-api-key"}"#,
                )
                .unwrap();
                assert!(openbot_desktop_lib::saved_intent::SavedIntent::read(&root)
                    .model
                    .is_some());
            }
            for original in [
                None,
                Some(""),
                Some("   "),
                Some("not-base64"),
                Some("c2hvcnQ="),
                Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
            ] {
                let secrets = original
                    .map(|value| {
                        std::collections::BTreeMap::from([(
                            "KEY_ENCRYPTION_KEY".into(),
                            value.into(),
                        )])
                    })
                    .unwrap_or_default();
                assert!(
                    require_existing_encryption_key(&root, &secrets).is_err(),
                    "{marker}: {original:?}"
                );
            }
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn configured_root_without_original_key_is_rejected_but_fresh_root_is_allowed() {
        let root = temp_root("valid-existing-encryption-key");
        std::fs::create_dir_all(&root).unwrap();
        assert!(require_existing_encryption_key(&root, &std::collections::BTreeMap::new()).is_ok());
        std::fs::write(
            root.join(".env"),
            "DATABASE_URL=postgres://synthetic-local\n",
        )
        .unwrap();
        let original = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
        let secrets =
            std::collections::BTreeMap::from([("KEY_ENCRYPTION_KEY".into(), original.into())]);
        assert!(require_existing_encryption_key(&root, &secrets).is_ok());
        assert_eq!(secrets["KEY_ENCRYPTION_KEY"], original);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saved_api_key_selection_without_a_saved_key_is_rejected_before_starting_services() {
        for (provider, expected) in [
            (
                "openai",
                "That saved OpenAI API key is no longer available.",
            ),
            (
                "anthropic",
                "That saved Anthropic API key is no longer available.",
            ),
        ] {
            let root = temp_root(&format!("openbot-missing-saved-{provider}"));
            std::fs::create_dir_all(&root).unwrap();
            let mut trace = Vec::new();

            let result = start_stack_credential_with(
                &root,
                ChosenModel {
                    provider: provider.to_string(),
                    login: "api-key".to_string(),
                    api_key: None,
                    base_url: None,
                    container_base_url: None,
                    model: None,
                    token: None,
                    saved: Some(true),
                },
                |_, key| {
                    trace.push(format!("saved-secret:{key}"));
                    Ok(String::new())
                },
            );
            if result.is_ok() {
                trace.push("external-start-boundary".to_string());
            }
            let problem = result.expect_err("missing saved key should stop before compose");

            println!(
                "DTA-004 missing provider={provider} error={} trace={trace:?}",
                problem.said
            );
            assert_eq!(problem.said, expected);
            assert_eq!(trace, [format!("saved-secret:{}", saved_api_key(provider))]);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn saved_api_key_selection_uses_the_saved_key_when_it_still_exists() {
        for (provider, expected_key) in [
            ("openai", "sk-openai-still-saved"),
            ("anthropic", "sk-ant-still-saved"),
        ] {
            let root = temp_root(&format!("openbot-present-saved-{provider}"));
            std::fs::create_dir_all(&root).unwrap();

            let credential = start_stack_credential_with(
                &root,
                ChosenModel {
                    provider: provider.to_string(),
                    login: "api-key".to_string(),
                    api_key: None,
                    base_url: None,
                    container_base_url: None,
                    model: None,
                    token: None,
                    saved: Some(true),
                },
                |_, key| {
                    assert_eq!(key, saved_api_key(provider));
                    Ok(expected_key.to_string())
                },
            )
            .expect("saved key should be accepted");

            match credential {
                openbot_env::ModelCredential::OpenAi { api_key }
                | openbot_env::ModelCredential::Anthropic { api_key } => {
                    assert_eq!(api_key, expected_key);
                    println!(
                        "DTA-004 present provider={provider} saved_key_len={}",
                        api_key.len()
                    );
                }
                other => panic!("unexpected credential: {other:?}"),
            }
            let _ = std::fs::remove_dir_all(root);
        }
    }

    fn saved_api_key(provider: &str) -> &'static str {
        match provider {
            "openai" => "OPENAI_API_KEY",
            "anthropic" => "ANTHROPIC_API_KEY",
            other => panic!("unexpected provider: {other}"),
        }
    }

    fn compatible_choice(base_url: Option<&str>, model: Option<&str>) -> ChosenModel {
        ChosenModel {
            provider: "openai-compatible".into(),
            login: "endpoint".into(),
            api_key: None,
            base_url: base_url.map(String::from),
            container_base_url: None,
            model: model.map(String::from),
            token: None,
            saved: None,
        }
    }

    fn persist_endpoint_fixture(root: &Path, credential: &openbot_env::ModelCredential) {
        let settings = openbot_env::compose(
            &openbot_env::Intelligence {
                api_url: "https://api.example.test".into(),
                gateway_ws_url: "wss://api.example.test".into(),
                api_key: "synthetic-intelligence".into(),
            },
            &openbot_env::Model {
                credential: credential.clone(),
            },
            &engine::EngineStatus {
                engine: None,
                address: None,
                responding: false,
                engine_socket: None,
                detail: "synthetic".into(),
            },
            &openbot_env::Ports::default(),
            &[],
            None,
            &Default::default(),
        );
        let (public, secrets) = openbot_desktop_lib::vault::split(settings);
        openbot_desktop_lib::saved_intent::persist_configuration(
            root, &public, &secrets, &secrets, credential,
        )
        .unwrap();
    }

    #[test]
    fn saved_compatible_endpoint_roundtrips_public_settings_and_scoped_key() {
        let root = temp_root("compatible-roundtrip");
        std::fs::create_dir_all(&root).unwrap();
        let mut chosen = compatible_choice(Some("https://models.example/v1"), Some("local-model"));
        chosen.api_key = Some("synthetic-endpoint-key".into());
        let credential = chosen.into_credential(&root).unwrap();
        persist_endpoint_fixture(&root, &credential);
        let configured = already_configured(root.to_string_lossy().into_owned());
        assert_eq!(
            configured.values.get("BOT_MODEL").map(String::as_str),
            Some("local-model")
        );
        assert_eq!(configured.saved.model_api_keys.compatible, Some(true));
        assert_eq!(configured.saved.model_api_keys.openai, None);
        assert!(!serde_json::to_string(&configured)
            .unwrap()
            .contains("synthetic-endpoint-key"));
        let mut reopened = compatible_choice(
            configured.values.get("OPENAI_BASE_URL").map(String::as_str),
            configured.values.get("BOT_MODEL").map(String::as_str),
        );
        reopened.saved = Some(true);
        assert_eq!(reopened.into_credential(&root).unwrap(), credential);

        for url in [
            "https://other.example/v1",
            "https://models.example/v2",
            "https://models.example:8443/v1",
        ] {
            let mut changed = compatible_choice(Some(url), Some("local-model"));
            changed.saved = Some(true);
            assert!(changed
                .into_credential_with(&root, |_, _| panic!(
                    "different endpoint must not read a credential"
                ))
                .is_err());
        }
        let other = root.join("other-root");
        let mut changed_root =
            compatible_choice(Some("https://models.example/v1"), Some("local-model"));
        changed_root.saved = Some(true);
        assert!(changed_root
            .into_credential_with(&other, |_, _| panic!(
                "different root must not read a credential"
            ))
            .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_endpoint_hint_cannot_relabel_another_endpoints_stored_key() {
        let root = temp_root("compatible-stale-record");
        std::fs::create_dir_all(&root).unwrap();
        let credential = openbot_env::ModelCredential::Compatible {
            base_url: "https://models.example/v1".into(),
            container_base_url: None,
            api_key: "synthetic-old-key".into(),
            model: "model".into(),
        };
        persist_endpoint_fixture(&root, &credential);
        let mut choice = compatible_choice(Some("https://models.example/v1"), Some("model"));
        choice.saved = Some(true);
        let mut reads = 0;
        let error = choice
            .into_credential_with(&root, |_, key| {
                reads += 1;
                assert_eq!(
                    key,
                    openbot_desktop_lib::saved_intent::COMPATIBLE_CREDENTIAL
                );
                Ok(
                    r#"{"base_url":"https://other.example/v1","api_key":"synthetic-other-key"}"#
                        .into(),
                )
            })
            .unwrap_err();
        assert_eq!(reads, 1);
        assert!(!error.said.contains("synthetic-other-key"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compatible_endpoint_accepts_trimmed_container_url_and_rejects_invalid_one() {
        let mut choice =
            compatible_choice(Some(" http://127.0.0.1:11434/v1 "), Some(" qwen3-vl:2b "));
        choice.container_base_url = Some(" http://ollama:11434/v1 ".into());
        let credential =
            start_stack_credential(Path::new("synthetic-unused-compatible-root"), choice)
                .expect("a valid container endpoint may be stored with the compatible credential");
        let openbot_env::ModelCredential::Compatible {
            base_url,
            container_base_url,
            model,
            ..
        } = credential
        else {
            panic!("the endpoint must retain its compatible credential");
        };
        assert_eq!(base_url, "http://127.0.0.1:11434/v1");
        assert_eq!(
            container_base_url.as_deref(),
            Some("http://ollama:11434/v1")
        );
        assert_eq!(model, "qwen3-vl:2b");

        let mut invalid = compatible_choice(Some("http://127.0.0.1:11434/v1"), Some("qwen3-vl:2b"));
        invalid.container_base_url = Some("ollama:11434/v1".into());
        let problem =
            start_stack_credential(Path::new("synthetic-unused-compatible-root"), invalid)
                .expect_err("a container endpoint URL must be an absolute HTTP(S) URL");
        assert_eq!(
            problem.said,
            "Enter a valid http:// or https:// address for the container model endpoint."
        );
    }

    #[test]
    fn compatible_endpoint_rejects_missing_or_invalid_http_url() {
        for base_url in [
            None,
            Some(""),
            Some(" \t\n "),
            Some("ftp://localhost/v1"),
            Some("file:///tmp/model"),
            Some("httpx://localhost/v1"),
            Some("localhost:11434/v1"),
            Some("http://"),
            Some("https://?query"),
            Some("http://[invalid]/v1"),
        ] {
            let problem = start_stack_credential(
                Path::new("synthetic-unused-compatible-root"),
                compatible_choice(base_url, Some("local-model")),
            )
            .expect_err("a missing or invalid endpoint URL must stop setup");
            assert_eq!(
                problem.said, "Enter a valid http:// or https:// address for your model endpoint.",
                "base_url={base_url:?}"
            );
        }
    }

    #[test]
    fn compatible_endpoint_rejects_missing_or_blank_model() {
        for model in [None, Some(""), Some(" \t\n ")] {
            let problem = start_stack_credential(
                Path::new("synthetic-unused-compatible-root"),
                compatible_choice(Some("http://127.0.0.1:11434/v1"), model),
            )
            .expect_err("a missing model name must stop setup");
            assert_eq!(problem.said, "Enter the model name your endpoint serves.");
        }
    }

    #[test]
    fn compatible_endpoint_accepts_trimmed_http_urls_and_optional_keys() {
        for base_url in [
            "http://127.0.0.1:11434/v1",
            "https://models.example.invalid/v1",
        ] {
            for api_key in [None, Some(" \t "), Some(" synthetic-endpoint-key ")] {
                let mut choice =
                    compatible_choice(Some(&format!(" {base_url} ")), Some(" local-model "));
                choice.api_key = api_key.map(String::from);
                let credential =
                    start_stack_credential(Path::new("synthetic-unused-compatible-root"), choice)
                        .expect("a valid endpoint may run without an API key");
                let openbot_env::ModelCredential::Compatible {
                    base_url: actual_url,
                    api_key: actual_key,
                    model,
                    ..
                } = credential
                else {
                    panic!("the endpoint must retain its compatible credential");
                };
                assert_eq!(actual_url, base_url);
                assert_eq!(model, "local-model");
                assert_eq!(actual_key, api_key.unwrap_or_default().trim());
            }
        }
    }

    #[test]
    fn responding_engine_without_compose_installs_then_redetects_before_returning() {
        let before = engine::EngineStatus {
            engine: Some(engine::Engine::Podman),
            address: Some(engine::Address::new(engine::Engine::Podman, None)),
            responding: true,
            engine_socket: None,
            detail: "podman is answering.".into(),
        };
        let after = engine::EngineStatus {
            engine: Some(engine::Engine::Podman),
            address: Some(engine::Address::new(
                engine::Engine::Podman,
                Some("openbot".into()),
            )),
            responding: true,
            engine_socket: None,
            detail: "podman is answering on openbot.".into(),
        };
        let trace = std::cell::RefCell::new(Vec::new());
        let mut compose_checks = 0;

        let ready = ready_responding_engine_after_compose_repair(
            before,
            || {
                trace.borrow_mut().push("install-engine".to_string());
                Ok("Compose installed.".into())
            },
            || {
                trace.borrow_mut().push("re-detect".to_string());
                after.clone()
            },
            |_| {
                compose_checks += 1;
                compose_checks > 1
            },
        )
        .expect("missing Compose should be repaired")
        .expect("responding engine should be returned");

        assert_eq!(&*trace.borrow(), &["install-engine", "re-detect"]);
        assert_eq!(ready.installed.as_deref(), Some("Compose installed."));
        assert_eq!(ready.address.connection.as_deref(), Some("openbot"));
    }

    #[test]
    fn disposable_provider_fixture_repairs_missing_compose_at_process_boundary() {
        let path = SerializedPath::set_only_with(
            "podman",
            "#!/bin/sh\ncase \"$*\" in\n\"version --format {{.Server.APIVersion}}\") printf '1.44\\n' ;;\n\"compose version\") command -v docker-compose >/dev/null 2>&1 && exec docker-compose version; printf 'missing compose\\n' >&2; exit 1 ;;\n*) printf 'unexpected podman args: %s\\n' \"$*\" >&2; exit 2 ;;\nesac\n",
        );
        let address = engine::Address::new(engine::Engine::Podman, None);
        assert!(address.responds(), "fake podman must answer before repair");
        assert!(
            !address.composes(),
            "fake podman must start without a compose provider"
        );
        let mut installed = false;
        let mut detections = 0;

        let ready = ready_responding_engine_after_compose_repair(
            engine::EngineStatus {
                engine: Some(engine::Engine::Podman),
                address: Some(address.clone()),
                responding: address.responds(),
                engine_socket: None,
                detail: "podman is answering.".into(),
            },
            || {
                std::fs::write(
                    path.bin().join(install::compose_provider_name()),
                    "#!/bin/sh\nprintf 'Docker Compose version disposable-provider\\n'\n",
                )
                .unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let provider = path.bin().join(install::compose_provider_name());
                    let mut permissions = std::fs::metadata(&provider).unwrap().permissions();
                    permissions.set_mode(0o755);
                    std::fs::set_permissions(&provider, permissions).unwrap();
                }
                installed = true;
                Ok("Compose installed into disposable PATH.".into())
            },
            || {
                detections += 1;
                engine::EngineStatus {
                    engine: Some(engine::Engine::Podman),
                    address: Some(address.clone()),
                    responding: address.responds(),
                    engine_socket: None,
                    detail: "podman is answering after disposable provider install.".into(),
                }
            },
            engine::Address::composes,
        )
        .expect("disposable provider should repair Compose")
        .expect("responding fake podman should be ready");

        assert!(installed, "install path must run before readiness returns");
        assert_eq!(detections, 1, "readiness must re-detect after install");
        assert_eq!(ready.address.engine, engine::Engine::Podman);
        assert!(
            ready.address.composes(),
            "the later start_stack compose gate should now pass"
        );
        println!(
            "DTA-007 functional proof: installed={installed} detections={detections} composes={}",
            ready.address.composes()
        );
    }

    #[test]
    fn stop_shutdown_uses_the_active_root_at_the_external_command_boundary() {
        let _path = SerializedPath::set();
        let active = temp_root("openbot-active-stop-root");
        let fallback = temp_root("openbot-default-stop-root");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::write(active.join("docker-compose.yml"), "services: {}\n").unwrap();
        std::fs::create_dir_all(&fallback).unwrap();
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(active.clone());
        let selected = shutdown_root(&shell, &fallback);

        let record = temp_root("openbot-stop-record").join("commands.log");
        let engine = fake_engine(&record);
        stack::down(&engine, &selected).expect("fake compose down");

        assert_compose_down_ran_under(&record, &active);
        assert!(shell.root.lock().unwrap().is_none());
        let _ = std::fs::remove_dir_all(active);
        let _ = std::fs::remove_dir_all(fallback);
    }

    #[test]
    fn quit_shutdown_uses_the_active_root_at_the_external_command_boundary() {
        let _path = SerializedPath::set();
        let active = temp_root("openbot-active-quit-root");
        let fallback = temp_root("openbot-default-quit-root");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::write(active.join("docker-compose.yml"), "services: {}\n").unwrap();
        std::fs::create_dir_all(&fallback).unwrap();
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(active.clone());
        let selected = shutdown_root(&shell, &fallback);

        let record = temp_root("openbot-quit-record").join("commands.log");
        let engine = fake_engine(&record);
        stack::down(&engine, &selected).expect("fake compose down");

        assert_compose_down_ran_under(&record, &active);
        assert!(shell.root.lock().unwrap().is_none());
        let _ = std::fs::remove_dir_all(active);
        let _ = std::fs::remove_dir_all(fallback);
    }

    #[test]
    fn stop_reports_cleanup_and_down_failures_after_using_the_active_root() {
        let active = temp_root("openbot-active-stop-failures");
        let fallback = temp_root("openbot-default-stop-failures");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::write(active.join("docker-compose.yml"), "services: {}\n").unwrap();
        std::fs::create_dir_all(&fallback).unwrap();
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(active.clone());
        let phases = std::cell::RefCell::new(Vec::new());

        let problem = stop_everything_with(
            &shell,
            &fallback,
            |root| {
                phases
                    .borrow_mut()
                    .push(format!("cleanup:{}", root.display()));
                Err(Problem::with(
                    "OpenBot could not inspect or stop its host processes.",
                    "lsof exited with status 2",
                ))
            },
            |root| {
                phases.borrow_mut().push(format!("down:{}", root.display()));
                Err("compose refused".to_string())
            },
        )
        .expect_err("Stop must surface both cleanup and Compose failures");

        assert_eq!(
            phases.into_inner(),
            vec![
                format!("cleanup:{}", active.display()),
                format!("down:{}", active.display())
            ]
        );
        assert!(
            problem.contains("OpenBot could not inspect or stop its host processes."),
            "{problem}"
        );
        assert!(problem.contains("lsof exited with status 2"), "{problem}");
        assert!(
            problem.contains("Compose down failed: compose refused"),
            "{problem}"
        );
        assert_eq!(shell.root.lock().unwrap().as_ref(), Some(&active));
        let _ = std::fs::remove_dir_all(active);
        let _ = std::fs::remove_dir_all(fallback);
    }

    #[test]
    fn exit_cleanup_body_records_cleanup_and_down_failures_after_using_the_active_root() {
        let active = temp_root("openbot-active-exit-failures");
        let fallback = temp_root("openbot-default-exit-failures");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::write(active.join("docker-compose.yml"), "services: {}\n").unwrap();
        std::fs::create_dir_all(&fallback).unwrap();
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(active.clone());
        let phases = std::cell::RefCell::new(Vec::new());

        let failures = exit_cleanup_with(
            &shell,
            &fallback,
            |root| {
                phases
                    .borrow_mut()
                    .push(format!("cleanup:{}", root.display()));
                Err(Problem::with(
                    "OpenBot could not inspect or stop its host processes.",
                    "taskkill exited with status 5",
                ))
            },
            |root| {
                phases.borrow_mut().push(format!("down:{}", root.display()));
                Err("compose down refused".to_string())
            },
        );

        assert_eq!(
            phases.into_inner(),
            vec![
                format!("cleanup:{}", active.display()),
                format!("down:{}", active.display())
            ]
        );
        assert_eq!(failures.len(), 2, "{failures:?}");
        assert!(
            failures[0].contains("taskkill exited with status 5"),
            "{failures:?}"
        );
        assert!(
            failures[1].contains("Compose down failed: compose down refused"),
            "{failures:?}"
        );
        assert_eq!(shell.root.lock().unwrap().as_ref(), Some(&active));
        let _ = std::fs::remove_dir_all(active);
        let _ = std::fs::remove_dir_all(fallback);
    }

    #[test]
    fn production_stop_root_selection_retains_resolved_root_not_menu_fallback() {
        let selected = temp_root("openbot-production-stop-selected-root");
        let fallback = temp_root("openbot-production-stop-default-root");
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(selected.clone());
        remember_selected_root(&shell, &fallback);

        let stop_root = root_for_stop(&shell, &fallback);

        assert_eq!(stop_root, selected);
        assert_eq!(
            shell.selected_root.lock().unwrap().as_ref(),
            Some(&selected)
        );
        let _ = std::fs::remove_dir_all(selected);
        let _ = std::fs::remove_dir_all(fallback);
    }

    #[test]
    fn production_stop_root_selection_retains_stopped_selected_root_not_menu_fallback() {
        let selected = temp_root("openbot-production-stop-stopped-selected-root");
        let fallback = temp_root("openbot-production-stop-stopped-default-root");
        let shell = Shell::default();
        remember_selected_root(&shell, &selected);

        let stop_root = root_for_stop(&shell, &fallback);

        assert_eq!(stop_root, selected);
        assert_eq!(
            shell.selected_root.lock().unwrap().as_ref(),
            Some(&selected)
        );
        let _ = std::fs::remove_dir_all(selected);
        let _ = std::fs::remove_dir_all(fallback);
    }

    #[test]
    fn production_stop_root_selection_uses_menu_fallback_when_no_root_is_known() {
        let fallback = temp_root("openbot-production-stop-only-default-root");
        let shell = Shell::default();

        let stop_root = root_for_stop(&shell, &fallback);

        assert_eq!(stop_root, fallback);
        assert_eq!(
            shell.selected_root.lock().unwrap().as_ref(),
            Some(&fallback)
        );
        let _ = std::fs::remove_dir_all(fallback);
    }

    #[test]
    fn successful_stop_then_exit_uses_the_retained_selected_root_not_default() {
        let selected = temp_root("openbot-selected-stop-exit");
        let fallback = temp_root("openbot-default-stop-exit");
        std::fs::create_dir_all(&selected).unwrap();
        std::fs::create_dir_all(&fallback).unwrap();
        std::fs::write(fallback.join("sentinel"), "default-root-untouched").unwrap();
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(selected.clone());
        remember_selected_root(&shell, &selected);
        let phases = std::cell::RefCell::new(Vec::new());

        stop_everything_with(
            &shell,
            &fallback,
            |root| {
                phases
                    .borrow_mut()
                    .push(format!("stop-cleanup:{}", root.display()));
                Ok(0)
            },
            |root| {
                phases
                    .borrow_mut()
                    .push(format!("stop-down:{}", root.display()));
                Ok(())
            },
        )
        .unwrap();
        assert!(shell.root.lock().unwrap().is_none());

        let failures = exit_cleanup_with(
            &shell,
            &fallback,
            |root| {
                phases
                    .borrow_mut()
                    .push(format!("exit-cleanup:{}", root.display()));
                Ok(0)
            },
            |root| {
                phases
                    .borrow_mut()
                    .push(format!("exit-down:{}", root.display()));
                Ok(())
            },
        );

        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(
            phases.into_inner(),
            vec![
                format!("stop-cleanup:{}", selected.display()),
                format!("stop-down:{}", selected.display()),
                format!("exit-cleanup:{}", selected.display()),
                format!("exit-down:{}", selected.display()),
            ]
        );
        assert_eq!(
            std::fs::read_to_string(fallback.join("sentinel")).unwrap(),
            "default-root-untouched"
        );
        let _ = std::fs::remove_dir_all(selected);
        let _ = std::fs::remove_dir_all(fallback);
    }

    #[cfg(unix)]
    fn harness_start_ipc_case(case: &str) {
        struct Cleanup(Vec<PathBuf>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                for path in &self.0 {
                    std::fs::remove_dir_all(path).expect("remove owned IPC fixture");
                }
            }
        }
        let root = temp_root("openbot-harness-start-ipc");
        write_installed_deployment(&root);
        let mut images: deployment::Images =
            serde_json::from_str(&std::fs::read_to_string(deployment::images_path(&root)).unwrap())
                .unwrap();
        for name in ["agent-langgraph-agui", "agent-claude-sdk"] {
            images.images.insert(
                name.into(),
                deployment::Image {
                    reference: format!("localhost/{name}@sha256:00"),
                },
            );
        }
        std::fs::write(
            deployment::images_path(&root),
            serde_json::to_string(&images).unwrap(),
        )
        .unwrap();
        let _path = SerializedPath::set_only_with("docker", HARNESS_START_IPC_DOCKER);
        let _cleanup = Cleanup(vec![root.clone(), _path.bin().to_path_buf()]);
        let record = root.join("commands.log");
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        // Reserve only an owned ephemeral loopback endpoint; no service thread until Start returns.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let remote = format!("http://{}/ag-ui", listener.local_addr().unwrap());
        let mut model = serde_json::json!({
            "provider":"openai", "login":"api-key", "apiKey":"synthetic-provider-key"
        });
        let mut choice = serde_json::json!({"id":"byo-url", "agentUrl":remote});
        let (expected_up, expected_image) = match case {
            "remote" | "remote-stale-image" => (
                "compose up -d --no-build postgres supervisor agent-computer agent-bot agent-langgraph",
                None,
            ),
            "anthropic-api" => {
                model = serde_json::json!({"provider":"anthropic", "login":"api-key", "apiKey":"synthetic-anthropic-key"});
                choice = serde_json::json!({"id":"langgraph"});
                ("compose --profile harness up -d --no-build postgres supervisor agent-computer agent-langgraph agent-harness", Some("agent-langgraph-agui"))
            }
            "compatible" => {
                model = serde_json::json!({"provider":"openai-compatible", "login":"endpoint", "baseUrl":"http://127.0.0.1:11434/v1", "model":"synthetic-model", "apiKey":""});
                ("compose up -d --no-build postgres supervisor agent-computer agent-bot agent-langgraph", None)
            }
            "installed" => {
                choice = serde_json::json!({"id":"langgraph"});
                ("compose --profile harness up -d --no-build postgres supervisor agent-computer agent-bot agent-langgraph agent-harness", Some("agent-langgraph-agui"))
            }
            "none" => {
                choice = serde_json::Value::Null;
                ("compose up -d --no-build postgres supervisor agent-computer agent-bot agent-langgraph", None)
            }
            "chatgpt-plan" => {
                model = serde_json::json!({"provider":"openai", "login":"plan", "token":"{\"refresh_token\":\"synthetic-plan\"}"});
                ("compose --profile harness up -d --no-build postgres supervisor agent-computer agent-harness", Some("agent-langgraph-agui"))
            }
            "claude-plan" => {
                model = serde_json::json!({"provider":"anthropic", "login":"plan", "token":"synthetic-claude-plan"});
                ("compose --profile harness up -d --no-build postgres supervisor agent-computer agent-harness", Some("agent-claude-sdk"))
            }
            _ => panic!("unknown test case"),
        };
        if case.ends_with("-plan") {
            std::fs::write(
                root.join(".env"),
                "MANAGED_AGENT_AG_UI_URL=http://127.0.0.1:4201/ag-ui\n",
            )
            .unwrap();
        }
        if case == "remote-stale-image" {
            std::fs::write(
                root.join(".env"),
                "PICKED_HARNESS_IMAGE=localhost/old-image@sha256:00\nPICKED_HARNESS_PORT=4206\n",
            )
            .unwrap();
        }
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .invoke_handler(tauri::generate_handler![start_stack, ask_the_bot])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let invoke = |command: &str, body: serde_json::Value| {
            tauri::test::get_ipc_response(
                &window,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
            .map(|body| body.deserialize::<serde_json::Value>().unwrap())
        };
        let problem = invoke("start_stack", serde_json::json!({
            "root":root, "apiUrl":"https://intelligence.example.test", "gatewayWsUrl":"wss://gateway.example.test",
            "apiKey":"synthetic-intelligence-key", "model":model, "harness":choice,
        })).expect_err("intentional migration barrier prevents host/DB startup");
        let commands = std::fs::read_to_string(&record).unwrap_or_default();
        assert!(
            problem["detail"]
                .as_str()
                .unwrap_or_default()
                .contains("synthetic migration barrier"),
            "{problem:?} {commands}"
        );
        let up: Vec<_> = commands
            .lines()
            .filter_map(|line| {
                let (_, command) = line.split_once('\t')?;
                command.contains(" up -d ").then_some(command)
            })
            .collect();
        assert_eq!(
            up,
            vec![expected_up],
            "case={case}, actual Start IPC commands:\n{commands}"
        );
        assert!(commands.contains("\tcompose run --rm migrate\n"));
        assert!(!root.join(".logs").exists(), "no host runtime was launched");
        let settings = openbot_env::read_already_set(
            &root.join(".env"),
            &[
                "TENANT_PACKAGE_DIR",
                "MANAGED_AGENT_AG_UI_URL",
                "PICKED_HARNESS_NAME",
                "PICKED_HARNESS_URL",
                "PICKED_HARNESS_KIND",
                "PICKED_HARNESS_IMAGE",
            ],
        )
        .unwrap();
        assert_eq!(
            settings.get("TENANT_PACKAGE_DIR").map(String::as_str),
            Some("../examples/fintech")
        );
        let bundled_url = settings
            .get("MANAGED_AGENT_AG_UI_URL")
            .map(String::as_str)
            .unwrap_or("");
        assert_eq!(
            bundled_url.is_empty(),
            !expected_up
                .split_whitespace()
                .any(|service| service == "agent-langgraph"),
            "case={case}, persisted advertisement must match actual Start services"
        );
        let mut asked = false;
        if case.starts_with("remote") || case == "compatible" {
            assert_eq!(settings.get("PICKED_HARNESS_URL"), Some(&remote));
            assert_eq!(
                settings.get("PICKED_HARNESS_KIND").map(String::as_str),
                Some("remote-ag-ui")
            );
            let server = TestServer::from_listener(listener,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
                 data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m1\",\"delta\":\"D53-BYO-REMOTE-ANSWER\"}\n\n\
                 data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n");
            let answer = invoke(
                "ask_the_bot",
                serde_json::json!({"root":root,"question":"D53 remote IPC question"}),
            )
            .unwrap();
            let request = server.request();
            assert_eq!(answer, "D53-BYO-REMOTE-ANSWER");
            assert_eq!(request.path, "/ag-ui");
            assert!(request.body.contains("D53 remote IPC question"));
            assert!(request
                .headers
                .iter()
                .any(|line| line.starts_with("x-openbot-agent-token: ")));
            asked = true;
        } else if let Some(image) = expected_image {
            assert_eq!(
                settings.get("PICKED_HARNESS_IMAGE"),
                Some(&format!("localhost/{image}@sha256:00"))
            );
            assert_ne!(settings.get("PICKED_HARNESS_URL"), Some(&remote));
        } else {
            assert!(!settings.contains_key("PICKED_HARNESS_URL"));
        }
        println!(
            "D53_START_IPC={}",
            serde_json::json!({
                "case":case, "composeUp":up, "commands":commands, "intentionalMigrationBarrier":true,
                "publicSettings":settings,
                "defaultPackage":"../examples/fintech", "remoteEndpointPersistedAndConsumed":asked,
                "actualAskIpcResponse":asked.then_some("D53-BYO-REMOTE-ANSWER"),
                "noHostStartup":true, "nativeGui":false, "realEngineOrDatabase":false,
            })
        );
    }

    #[cfg(unix)]
    #[test]
    fn remote_harness_start_ipc_skips_local_service_and_asks_persisted_endpoint() {
        harness_start_ipc_case("remote");
    }

    #[cfg(unix)]
    #[test]
    fn remote_harness_start_ipc_ignores_stale_local_image() {
        harness_start_ipc_case("remote-stale-image");
    }

    #[cfg(unix)]
    #[test]
    fn installed_harness_start_ipc_keeps_local_service() {
        harness_start_ipc_case("installed");
    }

    #[cfg(unix)]
    #[test]
    fn no_harness_start_ipc_keeps_only_core_and_eligible_bundled_services() {
        harness_start_ipc_case("none");
    }

    #[cfg(unix)]
    #[test]
    fn chatgpt_plan_harness_start_ipc_overrides_remote_choice() {
        harness_start_ipc_case("chatgpt-plan");
    }

    #[cfg(unix)]
    #[test]
    fn claude_plan_harness_start_ipc_overrides_remote_choice() {
        harness_start_ipc_case("claude-plan");
    }

    #[cfg(unix)]
    #[test]
    fn anthropic_api_harness_start_ipc_advertises_eligible_bundled_agent() {
        harness_start_ipc_case("anthropic-api");
    }

    #[cfg(unix)]
    #[test]
    fn compatible_harness_start_ipc_advertises_eligible_bundled_agent() {
        harness_start_ipc_case("compatible");
    }

    #[cfg(unix)]
    const HARNESS_START_IPC_DOCKER: &str = r#"#!/bin/sh
printf '%s\t%s\n' "$PWD" "$*" >> "$OPENBOT_TEST_ENGINE_RECORD"
case "$*" in
  "version --format {{.Server.APIVersion}}") printf '1.44\n' ;;
  "compose version") printf 'Docker Compose synthetic\n' ;;
  "compose ps --format {{.Ports}}") printf '127.0.0.1:4206->4206/tcp, 127.0.0.1:4212->4212/tcp\n' ;;
  "compose up -d --no-build "* | "compose --profile harness up -d --no-build "*) ;;
  "compose run --rm migrate") printf 'synthetic migration barrier\n' >&2; exit 71 ;;
  *) printf 'forbidden synthetic engine command: %s\n' "$*" >&2; exit 99 ;;
esac
"#;

    #[test]
    fn start_fails_when_required_compose_service_exited_before_host_startup() {
        let root = temp_root("openbot-dead-compose-start");
        write_installed_deployment(&root);
        let record = temp_root("openbot-dead-compose-record").join("commands.log");
        std::fs::create_dir_all(record.parent().expect("record parent")).unwrap();
        let _path = SerializedPath::set_only_with("docker", DEAD_SERVICE_START_DOCKER);
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();

        let problem = tauri::async_runtime::block_on(start_stack_inner(
            app.handle().clone(),
            root.clone(),
            "https://intelligence.example.test".into(),
            "wss://gateway.example.test".into(),
            "synthetic-intelligence-key".into(),
            ChosenModel {
                provider: "openai".into(),
                login: "api-key".into(),
                api_key: Some("synthetic-openai-key".into()),
                base_url: None,
                container_base_url: None,
                model: None,
                token: None,
                saved: Some(false),
            },
            None,
        ))
        .expect_err("a dead required Compose service must fail Start");

        let commands = std::fs::read_to_string(&record).expect("command record");
        assert_eq!(
            problem.said, "Part of OpenBot stopped during startup.",
            "problem={problem:?} commands={commands}"
        );
        assert_eq!(
            problem.detail.as_deref(),
            Some("agent-computer stopped: agent-computer died after boot")
        );
        println!("SLOT1B dead Compose Start proof:\nproblem={problem:?}\ncommands={commands}");
        assert!(
            commands.contains("\tversion --format {{.Server.APIVersion}}\n"),
            "{commands}"
        );
        assert!(commands.contains("\tcompose version\n"), "{commands}");
        assert!(commands.contains("\tcompose up -d --no-build postgres supervisor agent-computer agent-bot agent-langgraph\n"), "{commands}");
        assert!(
            commands.contains("\tcompose run --rm migrate\n"),
            "{commands}"
        );
        assert!(
            commands.contains("\tcompose ps -a --format {{.Service}}\t{{.State}}\n"),
            "{commands}"
        );
        assert!(
            commands.contains("\tcompose logs --tail 3 agent-computer\n"),
            "{commands}"
        );
        assert!(
            !root.join(".logs/server.log").exists(),
            "host processes must not spawn after dead service"
        );
        assert!(
            !root.join("node_modules").exists(),
            "dependency install must not run after dead service"
        );
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(record.parent().expect("record parent"));
    }

    #[test]
    fn anthropic_start_does_not_raise_openai_only_agent_bot_or_fail_on_its_stale_exit() {
        let root = temp_root("openbot-anthropic-bot-selection-start");
        write_installed_deployment(&root);
        let record = temp_root("openbot-anthropic-bot-selection-record").join("commands.log");
        std::fs::create_dir_all(record.parent().expect("record parent")).unwrap();
        let _path = SerializedPath::set_only_with("docker", ANTHROPIC_SERVICE_SELECTION_DOCKER);
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        let app = tauri::test::mock_builder()
            .manage(Shell::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();

        let problem = tauri::async_runtime::block_on(start_stack_inner(
            app.handle().clone(),
            root.clone(),
            "https://intelligence.example.test".into(),
            "wss://gateway.example.test".into(),
            "synthetic-intelligence-key".into(),
            ChosenModel {
                provider: "anthropic".into(),
                login: "api-key".into(),
                api_key: Some("synthetic-anthropic-key".into()),
                base_url: None,
                container_base_url: None,
                model: None,
                token: None,
                saved: Some(false),
            },
            None,
        ))
        .expect_err("dead selected LangGraph service must fail Start");

        let commands = std::fs::read_to_string(&record).expect("command record");
        assert!(
            commands.contains(
                "\tcompose up -d --no-build postgres supervisor agent-computer agent-langgraph\n"
            ),
            "{commands}"
        );
        assert!(
            !commands
                .contains("compose up -d --no-build postgres supervisor agent-computer agent-bot"),
            "Anthropic Start must not target the OpenAI-only agent-bot: {commands}"
        );
        assert_eq!(problem.said, "Part of OpenBot stopped during startup.");
        let detail = problem.detail.as_deref().unwrap_or_default();
        assert!(
            detail.contains("agent-langgraph stopped: langgraph died after boot"),
            "{detail}"
        );
        assert!(
            !detail.contains("agent-bot"),
            "stale, unrequested agent-bot exit must not fail this Anthropic Start: {detail}"
        );
        assert!(
            !commands.contains("\tcompose logs --tail 3 agent-bot\n"),
            "stale unrequested agent-bot should not get reported: {commands}"
        );
        assert!(
            commands.contains("\tcompose logs --tail 3 agent-langgraph\n"),
            "selected dead LangGraph service should get reported: {commands}"
        );
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(record.parent().expect("record parent"));
    }

    #[test]
    fn ask_the_bot_uses_native_mastra_for_a_picked_mastra_harness() {
        let server = TestServer::new(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
             data: {\"type\":\"text-delta\",\"payload\":{\"text\":\"391\"}}\n\n\
             data: {\"type\":\"finish\",\"payload\":{\"stepResult\":{\"reason\":\"stop\"}}}\n\n",
        );
        let root = temp_root("openbot-mastra-ask");
        let answer = tauri::async_runtime::block_on(ask_the_bot_with_settings(
            root.clone(),
            "What is 17 times 23?".to_string(),
            std::collections::BTreeMap::from([
                ("PICKED_HARNESS_URL".to_string(), server.url.clone()),
                (
                    "PICKED_HARNESS_KIND".to_string(),
                    "remote-mastra".to_string(),
                ),
                ("PICKED_HARNESS_AGENT_ID".to_string(), "openbot".to_string()),
                (
                    "MANAGED_AGENT_TOKEN".to_string(),
                    "managed-token".to_string(),
                ),
            ]),
        ))
        .expect("answer");

        let request = server.request();
        assert_eq!(answer, "391");
        assert_eq!(request.path, "/api/agents/openbot/stream");
        assert!(
            request
                .headers
                .iter()
                .any(|line| line == "x-openbot-agent-token: managed-token"),
            "{:?}",
            request.headers
        );
        let body: serde_json::Value = serde_json::from_str(&request.body).expect("json body");
        assert_eq!(
            body.pointer("/messages/0/content").and_then(|v| v.as_str()),
            Some("What is 17 times 23?")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ask_the_bot_uses_the_picked_byo_ag_ui_endpoint_before_managed_fallback() {
        let server = TestServer::new(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
             data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m1\",\"delta\":\"391\"}\n\n\
             data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        );
        let root = temp_root("openbot-byo-ask");
        let answer = tauri::async_runtime::block_on(ask_the_bot_with_settings(
            root.clone(),
            "What is 17 times 23?".to_string(),
            std::collections::BTreeMap::from([
                ("PICKED_HARNESS_URL".to_string(), server.url.clone()),
                (
                    "PICKED_HARNESS_KIND".to_string(),
                    "remote-ag-ui".to_string(),
                ),
                (
                    "MANAGED_AGENT_AG_UI_URL".to_string(),
                    "http://127.0.0.1:9/ag-ui".to_string(),
                ),
                (
                    "MANAGED_AGENT_TOKEN".to_string(),
                    "managed-token".to_string(),
                ),
            ]),
        ))
        .expect("answer");

        let request = server.request();
        assert_eq!(answer, "391");
        assert_eq!(request.path, "/");
        assert!(
            request
                .headers
                .iter()
                .any(|line| line == "x-openbot-agent-token: managed-token"),
            "{:?}",
            request.headers
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ask_the_bot_keeps_body_read_errors_out_of_the_empty_answer_path() {
        let body = "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m1\",\"delta\":\"391";
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len() + 64
        );
        let server = TestServer::new(response);
        let root = temp_root("openbot-body-read-ask");

        let problem = tauri::async_runtime::block_on(ask_the_bot_with_settings(
            root.clone(),
            "What is 17 times 23?".to_string(),
            std::collections::BTreeMap::from([
                ("PICKED_HARNESS_URL".to_string(), server.url.clone()),
                (
                    "PICKED_HARNESS_KIND".to_string(),
                    "remote-ag-ui".to_string(),
                ),
                (
                    "MANAGED_AGENT_TOKEN".to_string(),
                    "managed-token".to_string(),
                ),
            ]),
        ))
        .expect_err("body read errors must propagate as real problems");

        assert!(
            problem
                .said
                .contains("The Bot started answering and then stopped"),
            "{}",
            problem.said
        );
        let detail = problem.detail.as_deref().expect("body read detail");
        assert!(detail.contains("kind remote-ag-ui"), "{detail}");
        assert!(detail.contains(&server.url), "{detail}");
        assert!(detail.contains("HTTP 200 OK"), "{detail}");
        assert!(
            detail.contains("body") || detail.contains("error"),
            "{detail}"
        );
        let _ = server.request();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ask_the_bot_uses_managed_log_for_managed_fallback_empty_answer() {
        let _path = SerializedPath::set_with("docker", EMPTY_ANSWER_LOG_DOCKER);
        let record = temp_root("openbot-managed-empty-answer-record").join("commands.log");
        std::fs::create_dir_all(record.parent().expect("record parent")).unwrap();
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        let server = TestServer::new(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
             data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n\
             data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        );
        let root = temp_root("openbot-managed-empty-answer");
        std::fs::create_dir_all(&root).unwrap();

        let problem = tauri::async_runtime::block_on(ask_the_bot_with_settings(
            root.clone(),
            "What is 17 times 23?".to_string(),
            std::collections::BTreeMap::from([
                ("MANAGED_AGENT_AG_UI_URL".to_string(), server.url.clone()),
                (
                    "MANAGED_AGENT_TOKEN".to_string(),
                    "managed-token".to_string(),
                ),
            ]),
        ))
        .expect_err("empty managed answer must be diagnosed from managed Bot logs");

        let request = server.request();
        assert_eq!(request.path, "/");
        assert!(
            problem.said.contains("That key was refused"),
            "{}",
            problem.said
        );
        let detail = problem.detail.as_deref().expect("managed log detail");
        assert!(
            detail.contains("agent-langgraph refused the key"),
            "{detail}"
        );
        let commands = std::fs::read_to_string(&record).expect("command record");
        assert!(
            commands
                .lines()
                .any(|line| line.ends_with("\tcompose logs --tail 40 agent-langgraph")),
            "{commands}"
        );
        assert!(
            !commands
                .lines()
                .any(|line| line.ends_with("\tcompose logs --tail 40 agent-harness")),
            "{commands}"
        );
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(record.parent().expect("record parent"));
    }

    #[test]
    fn ask_the_bot_keeps_harness_log_for_picked_harness_empty_answer() {
        let _path = SerializedPath::set_with("docker", EMPTY_ANSWER_LOG_DOCKER);
        let record = temp_root("openbot-picked-empty-answer-record").join("commands.log");
        std::fs::create_dir_all(record.parent().expect("record parent")).unwrap();
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        let server = TestServer::new(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
             data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n\
             data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        );
        let root = temp_root("openbot-picked-empty-answer");
        std::fs::create_dir_all(&root).unwrap();

        let problem = tauri::async_runtime::block_on(ask_the_bot_with_settings(
            root.clone(),
            "What is 17 times 23?".to_string(),
            std::collections::BTreeMap::from([
                ("PICKED_HARNESS_URL".to_string(), server.url.clone()),
                (
                    "PICKED_HARNESS_KIND".to_string(),
                    "remote-ag-ui".to_string(),
                ),
                (
                    "MANAGED_AGENT_AG_UI_URL".to_string(),
                    "http://127.0.0.1:9/ag-ui".to_string(),
                ),
                (
                    "MANAGED_AGENT_TOKEN".to_string(),
                    "managed-token".to_string(),
                ),
            ]),
        ))
        .expect_err("picked harness empty answer must still be diagnosed from harness logs");

        let request = server.request();
        assert_eq!(request.path, "/");
        assert!(
            problem.said.contains("That key was refused"),
            "{}",
            problem.said
        );
        let detail = problem.detail.as_deref().expect("harness log detail");
        assert!(detail.contains("agent-harness refused the key"), "{detail}");
        let commands = std::fs::read_to_string(&record).expect("command record");
        assert!(
            commands
                .lines()
                .any(|line| line.ends_with("\tcompose logs --tail 40 agent-harness")),
            "{commands}"
        );
        assert!(
            !commands
                .lines()
                .any(|line| line.ends_with("\tcompose logs --tail 40 agent-langgraph")),
            "{commands}"
        );
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(record.parent().expect("record parent"));
    }

    const DEAD_SERVICE_START_DOCKER: &str = r#"#!/bin/sh
if [ -n "$OPENBOT_TEST_ENGINE_RECORD" ]; then
  printf '%s	%s
' "$PWD" "$*" >> "$OPENBOT_TEST_ENGINE_RECORD"
fi
case "$*" in
  "version --format {{.Server.APIVersion}}") printf '1.44
' ;;
  "compose version") printf 'Docker Compose version v2.0.0
' ;;
  "compose ps --format {{.Ports}}") ;;
  "compose up -d --no-build postgres supervisor agent-computer agent-bot agent-langgraph") ;;
  "compose run --rm migrate") ;;
  "compose ps -a --format "*) printf 'agent-computer	Exited
migrate	Exited
' ;;
  "compose logs --tail 3 agent-computer") printf 'agent-computer died after boot
' ;;
  *) printf 'unexpected docker args: %s
' "$*" >&2; exit 42 ;;
esac
"#;

    const ANTHROPIC_SERVICE_SELECTION_DOCKER: &str = r#"#!/bin/sh
if [ -n "$OPENBOT_TEST_ENGINE_RECORD" ]; then
  printf '%s	%s
' "$PWD" "$*" >> "$OPENBOT_TEST_ENGINE_RECORD"
fi
case "$*" in
  "version --format {{.Server.APIVersion}}") printf '1.44
' ;;
  "compose version") printf 'Docker Compose version v2.0.0
' ;;
  "compose ps --format {{.Ports}}") ;;
  "compose up -d --no-build postgres supervisor agent-computer agent-langgraph") ;;
  "compose run --rm migrate") ;;
  "compose ps -a --format "*) printf 'agent-computer	Up
migrate	Exited
agent-bot	Exited
agent-langgraph	Exited
' ;;
  "compose logs --tail 3 agent-bot") printf 'agent-bot missing OPENAI_API_KEY
' ;;
  "compose logs --tail 3 agent-langgraph") printf 'langgraph died after boot
' ;;
  *) printf 'unexpected docker args: %s
' "$*" >&2; exit 42 ;;
esac
"#;

    fn write_installed_deployment(root: &Path) {
        std::fs::create_dir_all(root.join("server")).unwrap();
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::create_dir_all(root.join("worker")).unwrap();
        std::fs::write(root.join("docker-compose.yml"), "services: {}\n").unwrap();
        std::fs::write(
            root.join("app/package.json"),
            r#"{"scripts":{"serve":"vite preview"}}"#,
        )
        .unwrap();
        let images = deployment::Images {
            version: DEPLOYMENT_VERSION.into(),
            images: std::collections::BTreeMap::from([
                (
                    "server".into(),
                    deployment::Image {
                        reference: "localhost/openbot-server@sha256:00".into(),
                    },
                ),
                (
                    "supervisor".into(),
                    deployment::Image {
                        reference: "localhost/openbot-supervisor@sha256:00".into(),
                    },
                ),
                (
                    "agent-computer".into(),
                    deployment::Image {
                        reference: "localhost/openbot-agent-computer@sha256:00".into(),
                    },
                ),
                (
                    "agent-bot".into(),
                    deployment::Image {
                        reference: "localhost/openbot-agent-bot@sha256:00".into(),
                    },
                ),
                (
                    "agent-langgraph".into(),
                    deployment::Image {
                        reference: "localhost/openbot-agent-langgraph@sha256:00".into(),
                    },
                ),
            ]),
        };
        std::fs::write(
            deployment::images_path(root),
            serde_json::to_string(&images).unwrap(),
        )
        .unwrap();
        deployment::record(root, DEPLOYMENT_VERSION).unwrap();
    }

    const EMPTY_ANSWER_LOG_DOCKER: &str = "#!/bin/sh\n\
if [ -n \"$OPENBOT_TEST_ENGINE_RECORD\" ]; then\n\
  printf '%s\\t%s\\n' \"$PWD\" \"$*\" >> \"$OPENBOT_TEST_ENGINE_RECORD\"\n\
fi\n\
if [ \"$1\" = \"version\" ]; then\n\
  printf '1.0\\n'\n\
  exit 0\n\
fi\n\
last=''\n\
for arg in \"$@\"; do\n\
  last=\"$arg\"\n\
done\n\
if [ \"$1\" = \"compose\" ] && [ \"$2\" = \"logs\" ]; then\n\
  case \"$last\" in\n\
    agent-langgraph)\n\
      printf 'OpenAIAuthenticationError: agent-langgraph refused the key\\n'\n\
      ;;\n\
    agent-harness)\n\
      printf 'OpenAIAuthenticationError: agent-harness refused the key\\n'\n\
      ;;\n\
  esac\n\
fi\n";

    struct TestRequest {
        path: String,
        headers: Vec<String>,
        body: String,
    }

    struct TestServer {
        url: String,
        received: std::sync::mpsc::Receiver<TestRequest>,
        done: Option<std::thread::JoinHandle<()>>,
    }

    impl TestServer {
        fn new(response: impl Into<String>) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
            Self::from_listener(listener, response)
        }

        fn from_listener(listener: std::net::TcpListener, response: impl Into<String>) -> Self {
            let response = response.into();
            let url = format!("http://{}", listener.local_addr().expect("addr"));
            let (sender, received) = std::sync::mpsc::channel();
            let done = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                loop {
                    let read = stream.read(&mut buffer).expect("read");
                    request.extend_from_slice(&buffer[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                let header_end = request
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .expect("headers")
                    + 4;
                let headers = String::from_utf8_lossy(&request[..header_end]).to_string();
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().expect("content length"))
                    })
                    .unwrap_or(0);
                while request.len() < header_end + content_length {
                    let read = stream.read(&mut buffer).expect("read body");
                    request.extend_from_slice(&buffer[..read]);
                }
                let mut lines = headers.lines();
                let path = lines
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .expect("path")
                    .to_string();
                let headers = lines
                    .filter(|line| !line.trim().is_empty())
                    .map(|line| line.to_ascii_lowercase())
                    .collect();
                let body =
                    String::from_utf8_lossy(&request[header_end..header_end + content_length])
                        .to_string();
                sender
                    .send(TestRequest {
                        path,
                        headers,
                        body,
                    })
                    .expect("send request");
                stream
                    .write_all(response.as_bytes())
                    .expect("write response");
            });
            Self {
                url,
                received,
                done: Some(done),
            }
        }

        fn request(mut self) -> TestRequest {
            let request = self.received.recv().expect("request");
            self.done.take().expect("thread").join().expect("join");
            request
        }
    }

    fn test_server_port(server: &TestServer) -> u16 {
        server
            .url
            .strip_prefix("http://127.0.0.1:")
            .expect("loopback url")
            .parse()
            .expect("port")
    }

    #[test]
    fn already_running_requires_selected_root_ownership_for_loopback_answer() {
        let root_a = temp_root("already-running-root-a");
        let root_b = temp_root("already-running-root-b");
        write_installed_deployment(&root_a);
        write_installed_deployment(&root_b);

        let server_a = TestServer::new("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
        let port_a = test_server_port(&server_a);
        assert!(
            !already_running_on(&root_a, port_a, |root, port| {
                assert_eq!(root, root_a.as_path());
                assert_eq!(port, port_a);
                Ok(false)
            }),
            "an answering shared port without selected-root ownership must not auto-adopt root A"
        );
        assert_eq!(server_a.request().path, "/api/capabilities");

        let server_b = TestServer::new("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
        let port_b = test_server_port(&server_b);
        assert!(already_running_on(&root_b, port_b, |root, port| {
            assert_eq!(root, root_b.as_path());
            assert_eq!(port, port_b);
            Ok(true)
        }));
        assert_eq!(server_b.request().path, "/api/capabilities");

        std::fs::remove_dir_all(root_a).unwrap();
        std::fs::remove_dir_all(root_b).unwrap();
    }

    #[test]
    fn already_running_returns_false_when_ownership_is_unproven() {
        let root = temp_root("already-running-unproven-root");
        write_installed_deployment(&root);
        let server = TestServer::new("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
        let port = test_server_port(&server);
        assert!(!already_running_on(&root, port, |_, _| {
            Err(Problem::with("ownership unavailable", "synthetic failure"))
        }));
        assert_eq!(server.request().path, "/api/capabilities");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    struct InitialHostFixture {
        base: PathBuf,
        root: PathBuf,
        bun: PathBuf,
        pids: std::cell::RefCell<Vec<u32>>,
    }

    #[cfg(unix)]
    impl InitialHostFixture {
        fn new(mode: &str) -> Self {
            use std::os::unix::fs::PermissionsExt;
            let base = temp_root("initial-host-launch");
            let root = base.join("deployment");
            std::fs::create_dir_all(&root).unwrap();
            for process in stack::HOST_PROCESSES {
                if mode == "first-fails"
                    || ((mode == "second-fails" || mode == "cleanup-refuses")
                        && process.name != "server")
                {
                    break;
                }
                std::fs::create_dir(root.join(process.cwd)).unwrap();
            }
            let bun = base.join("bun");
            // The production spawn boundary supplies cwd/argv/log files. Only the executable is
            // synthetic: one direct child with no network, engine, or credential access.
            std::fs::write(
                &bun,
                "#!/bin/sh\nprintf '%s' \"$$\" > child.pid\nexec /bin/sleep 60\n",
            )
            .unwrap();
            std::fs::set_permissions(&bun, std::fs::Permissions::from_mode(0o700)).unwrap();
            Self {
                base,
                root,
                bun,
                pids: std::cell::RefCell::new(Vec::new()),
            }
        }

        fn observe(&self, name: &str) {
            let path = self.root.join(name).join("child.pid");
            let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
            let pid = loop {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    if let Ok(pid) = text.parse::<u32>() {
                        break pid;
                    }
                }
                assert!(std::time::Instant::now() < until, "child did not start");
                std::thread::sleep(std::time::Duration::from_millis(5));
            };
            self.pids.borrow_mut().push(pid);
        }

        fn alive(&self) -> Vec<u32> {
            self.pids
                .borrow()
                .iter()
                .copied()
                .filter(|pid| unsafe { libc::kill(*pid as i32, 0) } == 0)
                .collect()
        }
    }

    #[cfg(unix)]
    impl Drop for InitialHostFixture {
        fn drop(&mut self) {
            // Even an old-code regression failure must not orphan the fixture. waitpid first
            // proves this is still our direct, unreaped child; ECHILD never authorizes a signal.
            for pid in self.pids.get_mut() {
                if unsafe { libc::waitpid(*pid as i32, std::ptr::null_mut(), libc::WNOHANG) } == 0 {
                    unsafe {
                        libc::kill(*pid as i32, libc::SIGKILL);
                        libc::waitpid(*pid as i32, std::ptr::null_mut(), 0);
                    }
                }
            }
            if self.base.is_file() {
                std::fs::remove_file(&self.base).unwrap();
            } else {
                std::fs::remove_dir_all(&self.base).unwrap();
            }
        }
    }

    #[cfg(unix)]
    fn initial_host_case(mode: &'static str) {
        let fixture = InitialHostFixture::new(mode);
        let shell = Shell::default();
        let result = tauri::async_runtime::block_on(start_host_processes(
            &shell,
            &fixture.root,
            &fixture.root.join(".logs"),
            &fixture.bun,
            &stack::Secrets::new(),
            |name| {
                fixture.observe(name);
                if mode == "cleanup-refuses" {
                    // A real filesystem failure prevents both the second spawn and verification
                    // of the first child's deployment. No cleanup failure is mocked away.
                    std::fs::remove_dir_all(&fixture.base).unwrap();
                    std::fs::write(&fixture.base, b"blocked fixture parent").unwrap();
                }
            },
            move |_| match mode {
                "wait-fails" => Err("synthetic readiness failure".into()),
                "wait-panics" => panic!("synthetic readiness task panic"),
                "success" => Ok(()),
                _ => panic!("readiness must not run after a spawn failure"),
            },
        ));
        let alive = fixture.alive();
        eprintln!(
            "{}",
            serde_json::json!({
                "initialHostCase": mode,
                "spawned": fixture.pids.borrow().len(),
                "aliveAfterStart": alive,
                "heldAfterStart": shell.children.lock().unwrap().len(),
                "error": result.as_ref().err().map(|problem| &problem.said),
            })
        );
        if mode == "success" {
            assert!(result.is_ok(), "{result:?}");
            assert_eq!(alive.len(), 3);
            assert_eq!(stack::recorded_host_pids(&fixture.root).unwrap().len(), 3);
        } else {
            let problem = result.unwrap_err();
            let expected = match mode {
                "first-fails" => "could not start server:",
                "second-fails" | "cleanup-refuses" => "could not start app:",
                "wait-fails" => "synthetic readiness failure",
                "wait-panics" => "the wait did not run:",
                _ => unreachable!(),
            };
            assert!(problem.said.starts_with(expected), "{problem:?}");
            if mode == "cleanup-refuses" {
                assert_eq!(alive.len(), 1);
                assert_eq!(shell.children.lock().unwrap().len(), 1);
                assert_eq!(shell.root.lock().unwrap().as_ref(), Some(&fixture.root));
                assert!(
                    problem.detail.is_some(),
                    "cleanup failure must remain visible"
                );
                std::fs::remove_file(&fixture.base).unwrap();
                std::fs::create_dir_all(&fixture.root).unwrap();
            } else {
                assert!(
                    alive.is_empty(),
                    "failed Start left owned children alive: {alive:?}"
                );
                assert!(shell.children.lock().unwrap().is_empty());
                assert!(shell.root.lock().unwrap().is_none());
            }
        }
        if mode == "success" || mode == "cleanup-refuses" {
            retire_host_processes(&shell, &fixture.root, stack::stop_processes_under).unwrap();
            assert!(fixture.alive().is_empty());
            assert!(shell.children.lock().unwrap().is_empty());
            assert!(shell.root.lock().unwrap().is_none());
        }
    }

    #[cfg(unix)]
    #[test]
    fn initial_host_second_spawn_failure_cleans_the_real_first_child() {
        initial_host_case("second-fails");
    }

    #[cfg(unix)]
    #[test]
    fn initial_host_first_spawn_failure_never_waits_or_publishes() {
        initial_host_case("first-fails");
    }

    #[cfg(unix)]
    #[test]
    fn initial_host_success_records_then_stops_all_children() {
        initial_host_case("success");
    }

    #[cfg(unix)]
    #[test]
    fn initial_host_readiness_failure_preserves_error_and_cleans_children() {
        initial_host_case("wait-fails");
    }

    #[cfg(unix)]
    #[test]
    fn initial_host_wait_panic_keeps_children_available_for_cleanup() {
        initial_host_case("wait-panics");
    }

    #[cfg(unix)]
    #[test]
    fn initial_host_cleanup_refusal_keeps_original_error_and_stop_ownership() {
        initial_host_case("cleanup-refuses");
    }

    #[cfg(unix)]
    #[test]
    fn failed_host_recording_retires_children_and_preserves_recording_failure() {
        let root = temp_root("failed-recording-lifecycle");
        std::fs::create_dir_all(&root).unwrap();
        let worker = std::process::Command::new("/bin/sleep")
            .arg("60")
            .current_dir(&root)
            .spawn()
            .unwrap();
        let children = vec![("bogus", worker)];
        let shell = Shell::default();
        let result = finish_host_start(&shell, &root, children, Ok(())).unwrap_err();
        assert_eq!(
            result.said,
            "OpenBot could not verify its host process ownership."
        );
        assert!(
            result
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("invalid host launch bogus")),
            "{result:?}"
        );
        assert!(shell.children.lock().unwrap().is_empty());
        assert!(shell.root.lock().unwrap().is_none());
        assert_eq!(
            shell.generation.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert!(
            !restart_host_process_with(&shell, &root, "worker", 0, || panic!(
                "failed recording attempt restarted"
            ))
            .unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_host_recording_keeps_root_and_handles_when_forced_cleanup_fails() {
        let root = temp_root("failed-recording-stubborn-child");
        std::fs::create_dir_all(&root).unwrap();
        let child = std::process::Command::new("/bin/sleep")
            .arg("60")
            .current_dir(&root)
            .spawn()
            .unwrap();
        let pid = child.id();
        let mut children = vec![("server", child)];
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(root.clone());
        let result = cleanup_after_host_recording_failure(
            &shell,
            &root,
            &mut children,
            Problem::with("recording failed", "recording detail"),
            |_, _| {
                Err(Problem::with(
                    "normal cleanup failed",
                    "normal cleanup detail",
                ))
            },
            |_| {
                Err(Problem::with(
                    "forced cleanup failed",
                    "forced cleanup detail",
                ))
            },
        )
        .unwrap_err();

        assert_eq!(result.said, "recording failed");
        let detail = result.detail.as_deref().unwrap_or_default();
        assert!(detail.contains("recording detail"), "{detail}");
        assert!(detail.contains("normal cleanup detail"), "{detail}");
        assert!(detail.contains("forced cleanup detail"), "{detail}");
        assert_eq!(shell.root.lock().unwrap().as_deref(), Some(root.as_path()));
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].1.id(), pid);
        for (_, child) in children.iter_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_host_recording_clears_root_and_handles_when_forced_cleanup_succeeds() {
        let root = temp_root("failed-recording-forced-cleanup");
        std::fs::create_dir_all(&root).unwrap();
        let child = std::process::Command::new("/bin/sleep")
            .arg("60")
            .current_dir(&root)
            .spawn()
            .unwrap();
        let mut children = vec![("server", child)];
        let shell = Shell::default();
        *shell.root.lock().unwrap() = Some(root.clone());
        let result = cleanup_after_host_recording_failure(
            &shell,
            &root,
            &mut children,
            Problem::with("recording failed", "recording detail"),
            |_, _| {
                Err(Problem::with(
                    "normal cleanup failed",
                    "normal cleanup detail",
                ))
            },
            |children| {
                for (_, child) in children.iter_mut() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                children.clear();
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(result.said, "recording failed");
        let detail = result.detail.as_deref().unwrap_or_default();
        assert!(detail.contains("recording detail"), "{detail}");
        assert!(detail.contains("normal cleanup detail"), "{detail}");
        assert!(!detail.contains("forced cleanup"), "{detail}");
        assert!(shell.root.lock().unwrap().is_none());
        assert!(children.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_readiness_retires_children_and_preserves_original_failure() {
        let root = temp_root("failed-readiness-lifecycle");
        std::fs::create_dir_all(&root).unwrap();
        let mut failed = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 71"])
            .spawn()
            .unwrap();
        failed.wait().unwrap();
        let worker = std::process::Command::new("/bin/sleep")
            .arg("60")
            .current_dir(&root)
            .spawn()
            .unwrap();
        let mut children = vec![("server", failed), ("worker", worker)];
        let original = stack::wait_until_answering(
            &mut children,
            &root,
            &stack::Ready { api: 0, app: 0 },
            std::time::Duration::from_secs(1),
        )
        .unwrap_err();
        let shell = Shell::default();
        let result = finish_host_start(&shell, &root, children, Err(original.clone())).unwrap_err();
        assert_eq!(result.said, original);
        assert!(result.detail.is_none());
        assert!(shell.children.lock().unwrap().is_empty());
        assert!(shell.root.lock().unwrap().is_none());
        assert_eq!(
            shell.generation.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert!(
            !restart_host_process_with(&shell, &root, "server", 0, || panic!(
                "failed attempt restarted"
            ))
            .unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stop_serializes_with_a_restart_already_inside_spawn() {
        use std::sync::{atomic::Ordering::SeqCst, Arc, Barrier};
        let root = temp_root("restart-stop-barrier");
        std::fs::create_dir_all(&root).unwrap();
        let shell = Arc::new(Shell::default());
        *shell.root.lock().unwrap() = Some(root.clone());
        shell.generation.store(1, SeqCst);
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let restart = {
            let (shell, root, entered, release) = (
                shell.clone(),
                root.clone(),
                entered.clone(),
                release.clone(),
            );
            std::thread::spawn(move || {
                restart_host_process_with(&shell, &root, "server", 1, || {
                    entered.wait();
                    release.wait();
                    std::process::Command::new("/bin/sleep")
                        .arg("60")
                        .current_dir(&root)
                        .spawn()
                })
            })
        };
        entered.wait();
        let (sent, completed) = std::sync::mpsc::channel();
        let stop = {
            let (shell, root) = (shell.clone(), root.clone());
            std::thread::spawn(move || {
                let result =
                    stop_everything_with(&shell, &root, stack::stop_processes_under, |_| Ok(()));
                sent.send(()).unwrap();
                result
            })
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while shell.generation.load(SeqCst) == 1 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert!(matches!(
            completed.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        release.wait();
        assert!(!restart.join().unwrap().unwrap());
        stop.join().unwrap().unwrap();
        assert!(shell.children.lock().unwrap().is_empty());
        assert!(shell.root.lock().unwrap().is_none());
        assert!(
            !restart_host_process_with(&shell, &root, "server", 1, || panic!(
                "retired restart spawned"
            ))
            .unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_retry_cleanup_retires_generation_and_retains_selected_root() {
        let shell = Shell::default();
        let root = temp_root("retry-cleanup-failure");
        *shell.root.lock().unwrap() = Some(root.clone());
        shell
            .generation
            .store(4, std::sync::atomic::Ordering::SeqCst);
        let problem = retire_host_processes(&shell, Path::new("unused-fallback"), |selected| {
            assert_eq!(selected, root);
            Err(Problem::plain("synthetic cleanup refused"))
        })
        .unwrap_err();
        assert_eq!(problem.said, "synthetic cleanup refused");
        assert_eq!(
            shell.generation.load(std::sync::atomic::Ordering::SeqCst),
            5
        );
        assert_eq!(shell.root.lock().unwrap().as_ref(), Some(&root));
        assert!(
            !restart_host_process_with(&shell, &root, "server", 4, || panic!(
                "old generation resumed"
            ))
            .unwrap()
        );
    }

    fn temp_root(name: &str) -> PathBuf {
        static NEXT_TEMP_ROOT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let next = NEXT_TEMP_ROOT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut path = std::env::temp_dir();
        path.push(format!("{name}-{}-{next}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    struct SerializedPath {
        previous: Option<std::ffi::OsString>,
        previous_record: Option<std::ffi::OsString>,
        bin: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl SerializedPath {
        fn set() -> Self {
            Self::set_with(
                "docker",
                "#!/bin/sh\nprintf '%s\\t%s\\n' \"$PWD\" \"$*\" >> \"$OPENBOT_TEST_ENGINE_RECORD\"\ncase \"$*\" in *'config --format json') printf '{\"services\":{\"supervisor\":{\"environment\":{\"COMPUTER_NAMESPACE\":\"openbot\"}}}}\\n';; esac\n",
            )
        }

        fn set_with(binary: &str, script: &str) -> Self {
            Self::set_with_path(binary, script, true)
        }

        fn set_only_with(binary: &str, script: &str) -> Self {
            Self::set_with_path(binary, script, false)
        }

        fn set_with_path(binary: &str, script: &str, inherit_path: bool) -> Self {
            static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let previous = std::env::var_os("PATH");
            let previous_record = std::env::var_os("OPENBOT_TEST_ENGINE_RECORD");
            let bin = temp_root("openbot-fake-engine-bin");
            std::fs::create_dir_all(&bin).unwrap();
            let command = bin.join(binary);
            std::fs::write(&command, script).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut permissions = std::fs::metadata(&command).unwrap().permissions();
                permissions.set_mode(0o755);
                std::fs::set_permissions(&command, permissions).unwrap();
            }
            let mut path = std::ffi::OsString::from(bin.clone());
            if inherit_path {
                if let Some(previous) = previous.as_ref().filter(|previous| !previous.is_empty()) {
                    path.push(if cfg!(windows) { ";" } else { ":" });
                    path.push(previous);
                }
            }
            std::env::set_var("PATH", path);
            Self {
                previous,
                previous_record,
                bin,
                _guard: guard,
            }
        }

        fn bin(&self) -> &Path {
            &self.bin
        }
    }

    impl Drop for SerializedPath {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                std::env::set_var("PATH", previous);
            } else {
                std::env::remove_var("PATH");
            }
            if let Some(previous) = &self.previous_record {
                std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", previous);
            } else {
                std::env::remove_var("OPENBOT_TEST_ENGINE_RECORD");
            }
        }
    }

    fn fake_engine(record: &Path) -> engine::Address {
        std::fs::create_dir_all(record.parent().expect("record parent")).unwrap();
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", record);
        engine::Address::new(engine::Engine::Docker, None)
    }

    fn assert_compose_down_ran_under(record: &Path, root: &Path) {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let lines = std::fs::read_to_string(record).expect("command record");
        assert!(
            lines.lines().any(|line| line
                == format!(
                    "{}\tcompose -f docker-compose.yml --profile harness down",
                    root.display()
                )),
            "{lines}"
        );
    }
    /// Real loopback responder in a separate process, so root/PID ownership checks use the same
    /// OS inventory as production. The Tauri mock replaces only the window, never the HTTP/PID path.
    #[cfg(unix)]
    struct RestoreFixture {
        base: PathBuf,
        selected: PathBuf,
        owned: PathBuf,
        child: std::process::Child,
        app_child: std::process::Child,
        app_descendant_pid: Option<u32>,
        ports: openbot_env::Ports,
    }

    #[cfg(unix)]
    impl RestoreFixture {
        fn new() -> Self {
            Self::with_app_descendant(false)
        }

        fn with_app_descendant(descendant: bool) -> Self {
            let base = temp_root("restore-owned-loopback");
            let selected = base.join("selected");
            let owned = base.join("owned");
            write_installed_deployment(&selected);
            write_installed_deployment(&owned);
            let source = base.join("listener.rs");
            std::fs::write(&source, r#"
use std::io::{Read, Write};
use std::net::TcpListener;
fn serve(listener: TcpListener) {
    for stream in listener.incoming() {
        let mut stream = stream.unwrap();
        stream.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
        let mut request = [0; 2048];
        if stream.read(&mut request).unwrap_or(0) > 0 {
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
        }
    }
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--parent") {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--record-pid").arg(&args[2]).spawn().unwrap();
        child.wait().unwrap();
        return;
    }
    if args.get(1).map(String::as_str) == Some("--record-pid") {
        std::fs::write(&args[2], std::process::id().to_string()).unwrap();
    }
    let api = TcpListener::bind("127.0.0.1:0").unwrap();
    let app = TcpListener::bind("127.0.0.1:0").unwrap();
    println!("{} {}", api.local_addr().unwrap().port(), app.local_addr().unwrap().port());
    std::io::stdout().flush().unwrap();
    std::thread::spawn(move || serve(api));
    serve(app);
}
"#).unwrap();
            let binary = base.join("listener");
            let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
            let output = std::process::Command::new(rustc)
                .arg(&source)
                .arg("-o")
                .arg(&binary)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let mut child = std::process::Command::new(&binary)
                .current_dir(&owned)
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let mut line = String::new();
            std::io::BufRead::read_line(
                &mut std::io::BufReader::new(child.stdout.take().unwrap()),
                &mut line,
            )
            .unwrap();
            let numbers: Vec<u16> = line
                .split_whitespace()
                .map(|n| n.parse().unwrap())
                .collect();
            let mut app_command = std::process::Command::new(&binary);
            let descendant_file = base.join("app-listener.pid");
            if descendant {
                app_command.arg("--parent").arg(&descendant_file);
            }
            let mut app_child = app_command
                .current_dir(&owned)
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let mut app_line = String::new();
            std::io::BufRead::read_line(
                &mut std::io::BufReader::new(app_child.stdout.take().unwrap()),
                &mut app_line,
            )
            .unwrap();
            let app_numbers: Vec<u16> = app_line
                .split_whitespace()
                .map(|n| n.parse().unwrap())
                .collect();
            let app_descendant_pid = descendant.then(|| {
                std::fs::read_to_string(descendant_file)
                    .unwrap()
                    .parse()
                    .unwrap()
            });
            let fixture = Self {
                base,
                selected,
                owned,
                child,
                app_child,
                app_descendant_pid,
                ports: openbot_env::Ports {
                    server: numbers[0],
                    app: app_numbers[1],
                    ..Default::default()
                },
            };
            stack::record_host_processes(
                &fixture.owned,
                &[
                    ("server", fixture.child.id()),
                    ("app", fixture.app_child.id()),
                ],
            )
            .unwrap();
            fixture
        }

        fn app(&self, root: &Path, setup: &str) -> tauri::App<tauri::test::MockRuntime> {
            let shell = Shell::default();
            remember_selected_root(&shell, root);
            *shell.setup_url.lock().unwrap() = Some(setup.into());
            let app = tauri::test::mock_builder()
                .manage(shell)
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap();
            window
                .navigate("http://127.0.0.1:9/stale-page".parse().unwrap())
                .unwrap();
            app
        }
    }

    #[cfg(unix)]
    impl Drop for RestoreFixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            if let Some(pid) = self.app_descendant_pid {
                // This PID was emitted by our own helper before its port announcement.
                let _ = std::process::Command::new("kill")
                    .args(["-TERM", &pid.to_string()])
                    .status();
            }
            let _ = self.app_child.kill();
            let _ = self.app_child.wait();
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[cfg(unix)]
    #[test]
    fn restore_window_refuses_answering_other_deployment_and_shows_recorded_setup() {
        let f = RestoreFixture::new();
        assert!(server_capabilities_answer(f.ports.server));
        assert!(stack::app_url(f.ports.app).is_some());
        assert!(!stack::recorded_server_owns_port(&f.selected, f.ports.server).unwrap());
        assert!(stack::recorded_server_owns_port(&f.owned, f.ports.server).unwrap());
        for setup in ["tauri://localhost/", "http://tauri.localhost/"] {
            let app = f.app(&f.selected, setup);
            restore_window_on(app.handle(), &f.ports);
            assert_eq!(
                app.get_webview_window("main")
                    .unwrap()
                    .url()
                    .unwrap()
                    .as_str(),
                setup,
                "tray/reopen must not adopt an unrelated successful app-port responder"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn restore_window_owned_runtime_opens_app_and_active_root_takes_precedence() {
        let f = RestoreFixture::new();
        for active in [false, true] {
            let app = f.app(
                if active { &f.selected } else { &f.owned },
                "tauri://localhost/",
            );
            if active {
                *app.state::<Shell>().root.lock().unwrap() = Some(f.owned.clone());
            }
            restore_window_on(app.handle(), &f.ports);
            assert_eq!(
                app.get_webview_window("main")
                    .unwrap()
                    .url()
                    .unwrap()
                    .as_str(),
                format!("http://127.0.0.1:{}/", f.ports.app)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn restore_window_unavailable_runtime_replaces_stale_page_with_setup() {
        let mut f = RestoreFixture::new();
        f.child.kill().unwrap();
        f.child.wait().unwrap();
        let app = f.app(&f.owned, "tauri://localhost/");
        restore_window_on(app.handle(), &f.ports);
        assert_eq!(
            app.get_webview_window("main")
                .unwrap()
                .url()
                .unwrap()
                .as_str(),
            "tauri://localhost/"
        );
    }

    #[cfg(unix)]
    #[test]
    fn restore_window_unproven_identity_shows_setup_without_losing_selected_root() {
        let f = RestoreFixture::new();
        std::fs::write(f.owned.join(".logs/host-pids.json"), "not-json").unwrap();
        let app = f.app(&f.owned, "tauri://localhost/");
        restore_window_on(app.handle(), &f.ports);
        assert_eq!(
            app.get_webview_window("main")
                .unwrap()
                .url()
                .unwrap()
                .as_str(),
            "tauri://localhost/"
        );
        assert_eq!(
            app.state::<Shell>()
                .selected_root
                .lock()
                .unwrap()
                .as_deref(),
            Some(f.owned.as_path())
        );
    }
    #[cfg(unix)]
    #[test]
    fn app_adoption_and_restore_refuse_foreign_app_with_owned_api_still_running() {
        let f = RestoreFixture::new();
        stack::record_host_processes(&f.owned, &[("server", f.child.id())]).unwrap();
        stack::record_host_processes(&f.selected, &[("app", f.app_child.id())]).unwrap();
        assert!(already_running_on(
            &f.owned,
            f.ports.server,
            stack::recorded_server_owns_port
        ));
        assert!(stack::app_url(f.ports.app).is_some());
        let initial_adoption = already_running_at(&f.owned, &f.ports);
        let app = f.app(&f.owned, "tauri://localhost/");
        let shown = show_openbot_on(app.handle().clone(), &f.ports);
        restore_window_on(app.handle(), &f.ports);
        let destination = app.get_webview_window("main").unwrap().url().unwrap();
        assert!(!initial_adoption && shown.is_err() && destination.as_str() == "tauri://localhost/",
            "owned API must not authorize a foreign app: initial={initial_adoption}, shown={shown:?}, restore={destination}");
    }

    #[cfg(unix)]
    #[test]
    fn app_adoption_and_restore_allow_owned_app_direct_and_launcher_descendant() {
        for descendant in [false, true] {
            let f = RestoreFixture::with_app_descendant(descendant);
            assert_ne!(f.child.id(), f.app_child.id());
            if descendant {
                assert_ne!(f.app_descendant_pid.unwrap(), f.app_child.id());
            }
            assert!(already_running_at(&f.owned, &f.ports));
            let app = f.app(&f.owned, "tauri://localhost/");
            show_openbot_on(app.handle().clone(), &f.ports).unwrap();
            restore_window_on(app.handle(), &f.ports);
            assert_eq!(
                app.get_webview_window("main")
                    .unwrap()
                    .url()
                    .unwrap()
                    .as_str(),
                format!("http://127.0.0.1:{}/", f.ports.app)
            );
        }
    }
}
