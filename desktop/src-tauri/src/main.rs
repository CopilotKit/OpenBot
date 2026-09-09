// A window, not a console. Release builds on Windows must not open one behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use openbot_desktop_lib::{
    acquire, deployment, engine, env as openbot_env, harness, install, problem::Problem, provider,
    quiet, stack, supervise, windows as win,
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
    openai: bool,
    anthropic: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedModelSessions {
    openai: bool,
    anthropic: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedConfiguration {
    intelligence_api_key: bool,
    model_api_keys: SavedModelApiKeys,
    model_sessions: SavedModelSessions,
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

fn report(app: &tauri::AppHandle, step: &str, ok: bool, detail: impl Into<String>) {
    let _ = app.emit(
        "setup:progress",
        Progress {
            step: step.into(),
            ok,
            detail: detail.into(),
        },
    );
}

#[tauri::command]
fn detect_engine() -> engine::EngineStatus {
    engine::detect()
}

#[tauri::command]
fn windows_blocker() -> Option<win::Blocker> {
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
async fn deployment_ready(app: &tauri::AppHandle, root: &Path) -> Result<(), Problem> {
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
async fn sign_in_image(app: &tauri::AppHandle, published: &str) -> Result<String, Problem> {
    let root = stack::default_root();
    deployment_ready(app, &root).await?;
    deployment::reference(&root, published).map_err(|error| {
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
                let model = given(self.model);
                if model.is_empty() {
                    return Err("Enter the model name your endpoint serves.".into());
                }
                Ok(openbot_env::ModelCredential::Compatible {
                    base_url,
                    api_key: given(self.api_key),
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
    openbot_desktop_lib::vault::already_given_interactive(&root.join(".env"), &[key])
        .map(|found| found.get(key).cloned().unwrap_or_default())
}

/// Write the `.env`, raise the containers, migrate, then start the three host processes.
#[tauri::command]
async fn start_stack(
    app: tauri::AppHandle,
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
    let root = PathBuf::from(root);

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

    let api_key = if api_key.trim().is_empty() {
        saved_secret(&root, "INTELLIGENCE_API_KEY")?
    } else {
        api_key
    };

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
        &openbot_desktop_lib::vault::already_given_interactive(
            &root.join(".env"),
            &openbot_env::MINTED[..],
        )?,
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
    openbot_desktop_lib::vault::write_env_after_remembering(
        &root.join(".env"),
        &settings,
        &secrets,
        &purge,
    )?;
    // Beside the `.env` and before the containers, because compose mounts it. See
    // `write_plan_store`: an absent file becomes a directory the sign-in can never write into.
    openbot_env::write_plan_store(&root, &credential)
        .map_err(|e| format!("could not write the sign-in file: {e}"))?;
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

    // The harness is a service only when one was picked; see `stack::up`.
    /*
     * The bundled Bots only when there is a key for them.
     *
     * A plan is not a key, and both of them refuse to start without one, so a person signing in
     * with the subscription they already pay for was handed two dead containers and two red lines
     * about Bots they never chose. See `BOTS_NEEDING_A_KEY`.
     */
    let a_key_exists = matches!(
        credential,
        openbot_env::ModelCredential::OpenAi { .. }
            | openbot_env::ModelCredential::Anthropic { .. }
            | openbot_env::ModelCredential::Compatible { .. }
    );
    stack::up(&found, &root, picked.is_some(), a_key_exists, &secrets)?;
    report(&app, "services", true, "containers up");

    report(&app, "migrate", true, "applying migrations");
    stack::migrate(&found, &root, &secrets)?;
    report(&app, "migrate", true, "migrations applied");

    // `compose up` succeeds once it has asked for everything. A service that then exits is not its
    // problem, and both Bots exit immediately without a model key. Reported rather than passed
    // over, or the window shows a healthy stack while nothing can answer a question.
    for (name, why) in stack::services_that_exited(&found, &root) {
        report(&app, "services", false, format!("{name} stopped: {why}"));
    }

    /*
     * Reclaim this deployment's own host processes before deciding the ports are taken.
     *
     * Same failure as the containers above, by a different route: a start that got as far as
     * spawning the server and then stopped left it running, and the next attempt refused because
     * port 3001 was held. By its own server. These are found by working directory, so anything this
     * stops belongs to this deployment and to no other.
     */
    let reclaimed = stack::stop_processes_under(&root);

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

    let mut started = Vec::new();
    for process in stack::HOST_PROCESSES.iter() {
        let child = stack::spawn_host_process(process, &root, &logs, &bun, &secrets)
            .map_err(|e| format!("could not start {}: {e}", process.name))?;
        started.push((process.name, child));
        report(&app, process.name, true, "started");
    }

    // Spawning is not starting. Nothing is called running until the API answers.
    let logs_for_wait = logs.clone();
    let (outcome, started) = tauri::async_runtime::spawn_blocking(move || {
        let mut started = started;
        let outcome = stack::wait_until_answering(
            &mut started,
            &logs_for_wait,
            &stack::Ready {
                api: openbot_env::Ports::default().server,
                app: openbot_env::Ports::default().app,
            },
            std::time::Duration::from_secs(180),
        );
        (outcome, started)
    })
    .await
    .map_err(|error| format!("the wait did not run: {error}"))?;

    let shell = app.state::<Shell>();
    // Recorded before the handles are stashed, so a window that never gets to Stop still leaves
    // something the next one can stop. See `stack::host_pids_path`.
    stack::record_host_processes(
        &root,
        &started
            .iter()
            .map(|(name, child)| (*name, child.id()))
            .collect::<Vec<_>>(),
    );
    shell.children.lock().unwrap().extend(started);
    *shell.root.lock().unwrap() = Some(root.clone());

    // From here the shell is the restart policy `worker/src/index.ts` says it does not have.
    let generation = shell
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    supervise_host_processes(app.clone(), root, logs, bun, secrets, generation);

    outcome.inspect_err(|error| report(&app, "answering", false, error.clone()))?;
    report(&app, "answering", true, "the API and the app are answering");
    Ok(())
}

/// Stop what this started, and only what this started.
///
/// A Bot's computer belongs to the supervisor rather than to Compose and is deliberately left
/// running: its files and browser profile are volumes, and killing it here would sign somebody out
/// of everything their Bot had logged into.
#[tauri::command]
fn stop_stack(app: tauri::AppHandle, root: String) -> Result<(), String> {
    stop_everything(&app, &PathBuf::from(&root))
}

fn shutdown_root(shell: &Shell, fallback_root: &Path) -> PathBuf {
    let mut active = shell.root.lock().unwrap();
    let root = active
        .clone()
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
    // Ended first, so the watcher stops before anything is killed and does not read a death it
    // caused as one worth answering.
    shell
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let root = shutdown_root(&shell, fallback_root);
    for (_, mut child) in shell.children.lock().unwrap().drain(..) {
        let _ = child.kill();
        let _ = child.wait();
    }

    // The window may be a second one, holding no handles to a stack that is still up. Stop what is
    // there rather than only what this window started, or Stop is a button that does nothing and
    // reports success.
    stack::stop_processes_under(&root);

    match engine::detect().address {
        Some(found) => stack::down(&found, &root),
        None => Ok(()),
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
    let port = openbot_env::Ports::default().app;
    // Where it answered, not where it was asked to listen. A dev server binds whichever loopback
    // its runtime resolved `localhost` to, and navigating to the other one shows a blank window
    // that looks like the app failing to start.
    let url = stack::app_url(port).ok_or_else(|| {
        format!("OpenBot is not answering on port {port} yet, so there is nothing to show.")
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
fn show_setup(app: tauri::AppHandle) -> Result<(), String> {
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
#[tauri::command]
fn already_running(root: String) -> bool {
    let root = PathBuf::from(&root);
    if deployment::installed(&root).is_none() {
        return false;
    }
    let port = openbot_env::Ports::default().server;
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

/**
Put the wizard's last question to the Bot, and hand back what it said.

THE DEFINITION OF DONE FOR AN INSTALL. Everything before this proves that things started; only this
proves the configuration works. See `ask` for why a run that says nothing is a failure rather than
an empty answer, and why the harness's log is fetched to fill the developer half.

The endpoint and the token come out of the `.env` this run just wrote, not from the window. They are
facts about the deployment, and a window carrying them would be a second copy to keep in step.
*/
#[tauri::command]
async fn ask_the_bot(
    root: String,
    question: String,
) -> Result<String, openbot_desktop_lib::problem::Problem> {
    let root = PathBuf::from(root);
    // The addresses come from the file and the token from the credential store, which is where
    // this run put it. Asked for together, because one without the other cannot ask anything.
    let settings = openbot_desktop_lib::vault::already_given_interactive(
        &root.join(".env"),
        &[
            "PICKED_HARNESS_URL",
            "PICKED_HARNESS_KIND",
            "PICKED_HARNESS_AGENT_ID",
            "MANAGED_AGENT_AG_UI_URL",
            "MANAGED_AGENT_TOKEN",
        ],
    )?;
    ask_the_bot_with_settings(root, question, settings).await
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
    let root = PathBuf::from(root);
    let env_file = root.join(".env");
    let silent = openbot_desktop_lib::vault::already_given_silent(
        &env_file,
        &[
            "INTELLIGENCE_API_KEY",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ],
    );
    already_configured_from(root, silent)
}

fn already_configured_from(
    root: PathBuf,
    silent: std::collections::BTreeMap<String, String>,
) -> AlreadyConfigured {
    let env_file = root.join(".env");
    let values = openbot_desktop_lib::vault::already_given_file_only(
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
        ],
    );

    AlreadyConfigured {
        saved: SavedConfiguration {
            intelligence_api_key: values.contains_key("INTELLIGENCE_API_KEY")
                || silent.contains_key("INTELLIGENCE_API_KEY"),
            model_api_keys: SavedModelApiKeys {
                openai: values.contains_key("OPENAI_API_KEY")
                    || silent.contains_key("OPENAI_API_KEY"),
                anthropic: values.contains_key("ANTHROPIC_API_KEY")
                    || silent.contains_key("ANTHROPIC_API_KEY"),
            },
            model_sessions: SavedModelSessions {
                openai: openbot_env::saved_chatgpt_plan_store(&root),
                anthropic: values.contains_key("CLAUDE_CODE_OAUTH_TOKEN")
                    || silent.contains_key("CLAUDE_CODE_OAUTH_TOKEN"),
            },
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
async fn begin_claude_sign_in(app: tauri::AppHandle) -> Result<String, Problem> {
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
    let image = sign_in_image(&app, openbot_desktop_lib::plan::SIGN_IN_IMAGE).await?;
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
) -> Result<String, openbot_desktop_lib::problem::Problem> {
    // Set up rather than refused: see `engine_ready`.
    let address = engine_ready(&app).await?;
    let image = sign_in_image(&app, openbot_desktop_lib::plan::CHATGPT_SIGN_IN_IMAGE).await?;
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
fn supervise_host_processes(
    app: tauri::AppHandle,
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
                    shell
                        .children
                        .lock()
                        .unwrap()
                        .retain(|(held, _)| *held != name);

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
                match stack::spawn_host_process(process, &root, &logs, &bun, &secrets) {
                    Ok(child) => {
                        let mut children = shell.children.lock().unwrap();
                        children.retain(|(held, _)| *held != name);
                        children.push((name, child));
                        report(&app, name, true, "started again");
                    }
                    Err(error) => report(
                        &app,
                        name,
                        false,
                        format!("{name} would not start: {error}"),
                    ),
                }
            }
        }
    });
}

/// Point the window at OpenBot if it is up, and at the setup screen if it is not.
///
/// Used by the tray and by a second launch, both of which happen at moments when the caller has no
/// idea which of the two the person should be looking at.
fn show_whichever_applies(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Some(url) = stack::app_url(openbot_env::Ports::default().app) {
        if let Ok(parsed) = url.parse() {
            let _ = window.navigate(parsed);
        }
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
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
        "quit" => app.exit(0),
        _ => {}
    }
}

fn main() {
    tauri::Builder::default()
        // A second launch is somebody looking for the window they already have, not a request for a
        // second stack. Without this both copies bind the same ports and the loser reports a
        // failure that belongs to the winner.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_whichever_applies(app);
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

            // The menu bar the window's own text refers to. Two items, because there are two things
            // somebody wants from a status icon: get to it, or stop it.
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;

            let open = MenuItem::with_id(app, "open", "Open OpenBot", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop OpenBot", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &stop, &quit])?;

            TrayIconBuilder::with_id("openbot")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .tooltip("OpenBot")
                .menu(&menu)
                .on_menu_event(|app, event| chose(app, event.id().as_ref()))
                .build(app)?;

            // The same three items on the window itself, because the tray cannot be relied on and
            // Stop lives nowhere else.
            //
            // Two ways it fails, both measured rather than guessed. A bare Linux window manager has
            // no StatusNotifierWatcher, so the icon is never drawn at all. On Windows the icon
            // appears and then does not come back if Explorer restarts, because re-adding it on
            // `TaskbarCreated` is the application's job and nothing does it. Either way the window
            // is hidden on close, the stack keeps running, and the only thing that can stop it is
            // an icon that is not there.
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
            // Nothing this started may outlive it.
            //
            // A child that survives the window is the failure Tauri has a standing issue about: an
            // orphaned server keeps port 3001, the next launch cannot bind it, and nothing on
            // screen says why. Asked to stop first, then made to, because a server given a moment
            // closes its database connections and one that is shot does not.
            // `Exit` only. `ExitRequested` fires first and for the same quit, and running this
            // twice means a second SIGTERM to a process that has already gone and another wait
            // nobody is watching.
            if matches!(event, tauri::RunEvent::Exit) {
                let shell = app.state::<Shell>();
                let default = PathBuf::from(default_root());
                let root = shutdown_root(&shell, &default);
                {
                    let mut children = shell.children.lock().unwrap();
                    for (_, child) in children.iter_mut() {
                        ask_to_stop(child);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    for (_, child) in children.iter_mut() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    children.clear();
                }

                // The containers too. Leaving five of them running behind an application that is
                // no longer on screen is the one outcome nobody can act on: there is no window to
                // stop them from and nothing to say they are there.
                stack::stop_processes_under(&root);
                if let Some(found) = engine::detect().address {
                    let _ = stack::down(&found, &root);
                }
            }
        });
}

/// Ask a child to stop, rather than shooting it.
///
/// On Unix that is SIGTERM, which the runtime turns into an ordinary shutdown. Windows has no
/// equivalent for a process without a console, so there it is the same as being killed; the wait
/// below is what gives a well-behaved process its moment either way.
fn ask_to_stop(child: &std::process::Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    #[cfg(not(unix))]
    let _ = child;
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

        let configured = already_configured_from(root.clone(), std::collections::BTreeMap::new());

        assert_eq!(
            configured.values.get("INTELLIGENCE_API_KEY"),
            Some(&"file-cpk".to_string())
        );
        assert_eq!(
            configured.values.get("OPENAI_API_KEY"),
            Some(&"file-openai".to_string())
        );
        assert!(configured.saved.intelligence_api_key);
        assert!(configured.saved.model_api_keys.openai);
        assert!(configured.saved.model_sessions.openai);
        assert!(!configured.saved.model_sessions.anthropic);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn already_configured_reports_saved_anthropic_session_from_silent_map_only() {
        let root = temp_root("openbot-already-configured-anthropic-session");
        std::fs::create_dir_all(&root).unwrap();

        let configured = already_configured_from(
            root.clone(),
            std::collections::BTreeMap::from([(
                "CLAUDE_CODE_OAUTH_TOKEN".to_string(),
                "silent".to_string(),
            )]),
        );

        assert!(configured.saved.model_sessions.anthropic);
        assert!(!configured.values.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
        let _ = std::fs::remove_dir_all(root);
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
            model: model.map(String::from),
            token: None,
            saved: None,
        }
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
            let response = response.into();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
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
                "#!/bin/sh\nprintf '%s\\t%s\\n' \"$PWD\" \"$*\" >> \"$OPENBOT_TEST_ENGINE_RECORD\"\n",
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
            lines
                .lines()
                .any(|line| line == format!("{}\tcompose --profile harness down", root.display())),
            "{lines}"
        );
    }
}
