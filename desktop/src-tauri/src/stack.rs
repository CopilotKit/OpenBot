//! Raising the stack: the Compose services.
//!
//! Compose runs all of OpenBot: postgres, the supervisor, `agent-computer`, the Bots, a one-shot
//! `migrate`, and the published image's `server` and `worker` under the `openbot` profile. Docker's
//! restart policy keeps them up. Nothing runs on the host: the person's own browser is on the one
//! computer, shown in the OpenBot window.
//!
//! [`HOST_PROCESSES`] still names what earlier versions ran on the host, the server, the app, the
//! worker and a browser of the person's own on their desktop, so a Start or a Stop can find and end
//! what one of those left running.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::quiet::{command, said as command_said};

use serde::{Deserialize, Serialize};

use crate::engine::Address;
use crate::problem::Problem;

/// The services Compose owns. `migrate` is deliberately absent: it is run once, to completion,
/// rather than raised, and treating it as a long-lived service makes it look like a crash loop.
///
/// `server` and `worker` are OpenBot itself, from the published server image: the API, the app it
/// serves, and the routines sweep. They used to be Bun processes this app started on the host after
/// downloading Bun and running `bun install`, which on a fresh Windows machine took longer than
/// everything else in the install put together. Now they are containers like the rest, and the
/// restart policy that keeps them up is Docker's.
///
/// No `supervisor`, and none of the bundled Bots. This app runs the personal edition (see
/// `env::compose`): every Bot shares the one `agent-computer`, and its Personal Assistant runs inside
/// the server. The supervisor is still stopped on Stop (`stop_computers`), for the
/// computers an installation that predates this made for each Bot.
const SERVICES: [&str; 4] = ["postgres", "agent-computer", "server", "worker"];

/// The Compose profile `server` and `worker` sit behind, so `scripts/start.sh`, whose server is a
/// host process, never starts a second one. Named on every command rather than only on `up`, so
/// `down` stops them and `config` describes them.
const OPENBOT_PROFILE: &str = "openbot";

pub fn selected_services(harness: bool) -> Vec<&'static str> {
    let mut services = SERVICES.to_vec();
    if harness {
        services.push("agent-harness");
    }
    services
}

/// What earlier versions ran on the host rather than in a container, by the name each was recorded
/// under (`host-pids.json`): the server, the app and the worker, which run from the server image
/// now, and the person's own browser, which runs on the one computer now. Nothing is started under
/// these names any more. They are kept so a Start or a Stop recognises a record one of those left,
/// and ends what it still runs.
pub const HOST_PROCESSES: [&str; 4] = ["server", "app", "worker", "browser"];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    EngineMissing,
    Starting,
    Migrating,
    WaitingForServices,
    Running,
    Stopped,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StackStatus {
    pub phase: Phase,
    pub detail: String,
}

/**
The credentials a deployment needs, handed to a child process rather than left in its `.env`.

THIS IS WHY THE FILE CAN STOP HOLDING THEM. Compose resolves `${VAR}` from its own environment
before it reads `.env`, so a secret passed here reaches exactly the containers that declare it and
is written down nowhere. The host processes take theirs the same way, alongside the `--env-file`
that still carries the settings.

A `BTreeMap` rather than the vault directly: reading a credential store once per run and passing
what it gave is one prompt and one failure point, where reading it per command is neither.
*/
pub type Secrets = std::collections::BTreeMap<String, String>;

/// Every Compose command for the installation, run as its own project (see `project`).
///
/// Named through the environment, which Compose ranks above `.env` and the folder's name and
/// below only `-p`, so every caller's arguments stay exactly as they were. A project that could not
/// be decided, because the engine could not be asked, is `DESKTOP_PROJECT`: never the folder's
/// name, which would be adopting whatever else runs under it.
/// The engine's Compose for the installation in `root`, with `secrets` in its environment.
pub fn compose_command_for(engine: &Address, root: &Path, secrets: &Secrets) -> Command {
    compose_command(engine, root, secrets)
}

fn compose_command(engine: &Address, root: &Path, secrets: &Secrets) -> Command {
    let project = project(engine, root).unwrap_or_else(|_| DESKTOP_PROJECT.to_owned());
    let mut command = engine.command();
    command.current_dir(root).args(["compose"]).envs(secrets);
    command.env("COMPOSE_PROJECT_NAME", &project);
    if let Some(namespace) = computer_namespace_for(&project) {
        command.env("COMPUTER_NAMESPACE", namespace);
    }
    command
}

/// Check the actual selected deployment before minting an encryption key. Compose resolves
/// project names, explicit volume names, and override files; the pinned engine owns the volume.
/// Never include config output in diagnostics: interpolation may have put credentials in it.
pub fn postgres_volume_exists(
    engine: &Address,
    root: &Path,
    secrets: &Secrets,
) -> Result<bool, Problem> {
    let configuration = postgres_configuration(engine, root, secrets)?;
    let volume = postgres_volume_name(&configuration)?;
    named_volume_exists(engine, root, &volume)
}

fn postgres_configuration(
    engine: &Address,
    root: &Path,
    secrets: &Secrets,
) -> Result<Vec<u8>, Problem> {
    let configuration = compose_command(engine, root, secrets)
        .args(["config", "--format", "json"])
        .output()
        .map_err(|error| {
            postgres_volume_problem(format!("Could not run Compose config: {error}"))
        })?;
    if !configuration.status.success() {
        return Err(postgres_volume_problem(format!(
            "Compose config exited with {}. Output omitted because it can contain credentials.",
            configuration.status
        )));
    }
    Ok(configuration.stdout)
}

fn named_volume_exists(engine: &Address, root: &Path, volume: &str) -> Result<bool, Problem> {
    Ok(volume_inventory(engine, root)?
        .iter()
        .any(|name| name == volume))
}

fn volume_inventory(engine: &Address, root: &Path) -> Result<Vec<String>, Problem> {
    let inventory = engine
        .command()
        .current_dir(root)
        .args(["volume", "ls", "--format", "{{.Name}}"])
        .output()
        .map_err(|error| postgres_volume_problem(format!("Could not list volumes: {error}")))?;
    if !inventory.status.success() {
        return Err(postgres_volume_problem(format!(
            "Volume inventory exited with {}.",
            inventory.status
        )));
    }
    let names = std::str::from_utf8(&inventory.stdout)
        .map_err(|_| postgres_volume_problem("Volume inventory was not valid UTF-8."))?;
    Ok(names
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect())
}

fn postgres_volume_problem(detail: impl Into<String>) -> Problem {
    Problem::with(
        "OpenBot couldn't check whether this installation already has your data saved, so it \
         changed nothing. Try again.",
        detail,
    )
}

/// A surviving database is recoverable only when Compose and the engine agree it is owned.
pub fn leftover_database_volume(
    engine: &Address,
    root: &Path,
    secrets: &Secrets,
) -> Result<Option<String>, Problem> {
    let config = leftover_configuration(engine, root, secrets)?;
    let inventory = volume_inventory(engine, root)?;
    owned_database_volume(engine, root, &config, &inventory)
}

fn leftover_configuration(
    engine: &Address,
    root: &Path,
    secrets: &Secrets,
) -> Result<serde_json::Value, Problem> {
    let configuration = postgres_configuration(engine, root, secrets)?;
    serde_json::from_slice(&configuration)
        .map_err(|_| postgres_volume_problem("Compose config did not return valid JSON."))
}

fn owned_database_volume(
    engine: &Address,
    root: &Path,
    config: &serde_json::Value,
    inventory: &[String],
) -> Result<Option<String>, Problem> {
    let Some((source, definition)) = postgres_data_volume(config) else {
        return Ok(None);
    };
    let Some(project) = config["name"].as_str().filter(|name| !name.is_empty()) else {
        return Ok(None);
    };
    let Some(name) = ordinary_project_volume(project, source, definition) else {
        return Ok(None);
    };
    // Another service mounting the database volume, under any alias, makes it shared storage.
    if config["services"].as_object().is_some_and(|services| {
        services.iter().any(|(service, configuration)| {
            service != "postgres"
                && configuration["volumes"].as_array().is_some_and(|mounts| {
                    mounts.iter().any(|mount| {
                        mount["source"].as_str().is_some_and(|other_source| {
                            other_source == source
                                || config["volumes"][other_source]["name"].as_str() == Some(name)
                        })
                    })
                })
        })
    }) {
        return Ok(None);
    }
    owned_compose_volume(engine, root, project, source, name, inventory)
}

/// Compose's explicit names and external volumes can refer to somebody else's data.
/// Permit only ordinary project-scoped, local storage, even if a custom volume has labels.
fn ordinary_project_volume<'a>(
    project: &str,
    source: &str,
    definition: &'a serde_json::Value,
) -> Option<&'a str> {
    let name = definition["name"].as_str()?;
    (name == format!("{project}_{source}")
        && name.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && b"_.-".contains(&byte))
        })
        && matches!(
            definition.get("external"),
            None | Some(serde_json::Value::Bool(false))
        )
        && !definition["driver"]
            .as_str()
            .is_some_and(|driver| driver != "local")
        && empty_volume_options(&definition["driver_opts"]))
    .then_some(name)
}

fn owned_compose_volume(
    engine: &Address,
    root: &Path,
    project: &str,
    source: &str,
    name: &str,
    inventory: &[String],
) -> Result<Option<String>, Problem> {
    if !inventory.iter().any(|listed| listed == name) {
        return Ok(None);
    }
    let Some(labels) = inspect_local_volume(engine, root, name)? else {
        return Ok(None);
    };
    Ok(
        (labels["com.docker.compose.project"].as_str() == Some(project)
            && labels["com.docker.compose.volume"].as_str() == Some(source))
        .then(|| name.to_owned()),
    )
}

/// The labels of exactly this local volume, or `None` when the engine describes anything else.
fn inspect_local_volume(
    engine: &Address,
    root: &Path,
    name: &str,
) -> Result<Option<serde_json::Value>, Problem> {
    let inspect = engine
        .command()
        .current_dir(root)
        .args(["volume", "inspect", name])
        .output()
        .map_err(|error| {
            postgres_volume_problem(format!("Could not inspect volume {name}: {error}"))
        })?;
    if !inspect.status.success() {
        return Err(postgres_volume_problem(format!("Inspection of volume {name} exited with {}. Output omitted because it can contain credentials.", inspect.status)));
    }
    let inspected: serde_json::Value = serde_json::from_slice(&inspect.stdout).map_err(|_| {
        postgres_volume_problem(format!(
            "Inspection of volume {name} did not return valid JSON."
        ))
    })?;
    let Some(volumes) = inspected.as_array().filter(|volumes| volumes.len() == 1) else {
        return Ok(None);
    };
    let volume = &volumes[0];
    // Podman accepts unique name prefixes. Exact inventory and inspect matches keep the command
    // tied to the full name the person confirmed, never a similarly named backup.
    Ok((volume["Name"].as_str() == Some(name)
        && volume["Driver"].as_str() == Some("local")
        && empty_volume_options(&volume["Options"]))
    .then(|| volume["Labels"].clone()))
}

/// A Bot's profile or workspace volume, created by the supervisor in this namespace.
/// Matches `supervisor/src/names.ts` names and `labelsFor` in `supervisor/src/docker.ts`;
/// all three labels are required, so an older or foreign volume is never claimed.
fn owned_supervisor_volume(
    engine: &Address,
    root: &Path,
    namespace: &str,
    name: &str,
) -> Result<Option<String>, Problem> {
    let Some(bot) = ["profile", "workspace"]
        .iter()
        .find_map(|kind| name.strip_prefix(&format!("{namespace}-{kind}-")))
        .filter(|bot| supervisor_identifier(bot))
    else {
        return Ok(None);
    };
    let Some(labels) = inspect_local_volume(engine, root, name)? else {
        return Ok(None);
    };
    Ok((labels["openbot.supervisor"].as_str() == Some("true")
        && labels["openbot.bot-id"].as_str() == Some(bot)
        && labels["openbot.namespace"].as_str() == Some(namespace))
    .then(|| name.to_owned()))
}

/// The namespace the selected supervisor will run with, as `supervisor/src/names.ts` reads it.
/// No supervisor, or a namespace it would refuse, owns no volumes.
fn supervisor_namespace(config: &serde_json::Value) -> Option<String> {
    let supervisor = config["services"]["supervisor"].as_object()?;
    let configured = match supervisor
        .get("environment")
        .and_then(|environment| environment.get("COMPUTER_NAMESPACE"))
    {
        None | Some(serde_json::Value::Null) => "",
        Some(value) => value.as_str()?,
    };
    resolve_namespace(configured).map(str::to_owned)
}

/// Match supervisor/src/names.ts: trim, default only an empty value, then the same 64-character
/// ASCII identifier grammar.
fn resolve_namespace(configured: &str) -> Option<&str> {
    let namespace = match configured.trim() {
        "" => "openbot",
        value => value,
    };
    supervisor_identifier(namespace).then_some(namespace)
}

fn supervisor_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// What a previous installation of this deployment left on the selected engine.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LeftoverVolumes {
    /// The Postgres volume, when Compose and the engine agree this project owns it.
    pub database: Option<String>,
    /// Whether the volume Compose selects for Postgres exists at all, owned or not.
    pub database_exists: bool,
    /// Every verified, owned volume, sorted. This is exactly what a reset removes.
    pub volumes: Vec<String>,
    /// Stopped containers this deployment provably owns, sorted by name. They still hold the
    /// volumes, so a reset removes them first.
    pub containers: Vec<LeftoverContainer>,
    /// Owned containers that are not stopped, by name. Any one of them blocks a reset.
    pub running: Vec<String>,
}

/// A stopped container a reset may remove, named for the person and removed by its exact id.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LeftoverContainer {
    pub name: String,
    pub id: String,
}

impl LeftoverVolumes {
    /// A reset must not leave a database it cannot verify for the new installation to reuse,
    /// and never touches a container that is still running.
    pub fn resettable(&self) -> bool {
        !self.volumes.is_empty()
            && (self.database.is_some() || !self.database_exists)
            && self.running.is_empty()
    }

    pub fn container_names(&self) -> Vec<String> {
        self.containers
            .iter()
            .map(|container| container.name.clone())
            .collect()
    }

    /// The sentence for a reset that a running container blocks, or `None` when none is running.
    pub fn running_said(&self) -> Option<String> {
        (!self.running.is_empty()).then(|| {
            format!(
                "Part of the previous installation is still running: {}. Stop it in Docker Desktop \
                 or Podman, then try Start again.",
                self.running.join(", ")
            )
        })
    }
}

fn leftover_container_problem(detail: impl Into<String>) -> Problem {
    Problem::with(
        "OpenBot couldn't check what an earlier installation left behind, so it changed nothing. \
         Try again.",
        detail,
    )
}

/// The ids carrying every one of these labels. Only a hint: each one is inspected before use.
fn labelled_containers(
    engine: &Address,
    root: &Path,
    labels: &[(&str, &str)],
) -> Result<Vec<String>, Problem> {
    let mut command = engine.command();
    command
        .current_dir(root)
        .args(["ps", "--all", "--quiet", "--no-trunc"]);
    for (key, value) in labels {
        command.args(["--filter", &format!("label={key}={value}")]);
    }
    let listed = command.output().map_err(|error| {
        leftover_container_problem(format!("Could not list containers: {error}"))
    })?;
    if !listed.status.success() {
        return Err(leftover_container_problem(format!(
            "Container listing exited with {}. Output omitted because it can contain credentials.",
            listed.status
        )));
    }
    let listed = std::str::from_utf8(&listed.stdout)
        .map_err(|_| leftover_container_problem("Container listing was not valid UTF-8."))?;
    Ok(listed.split_whitespace().map(str::to_owned).collect())
}

enum ContainerState {
    Stopped,
    Running,
}

/// The name and state of a container whose labels prove this deployment owns it, or `None`.
fn owned_container(
    engine: &Address,
    root: &Path,
    id: &str,
    project: Option<&str>,
    namespace: Option<&str>,
) -> Result<Option<(String, ContainerState)>, Problem> {
    let inspect = engine
        .command()
        .current_dir(root)
        .args(["container", "inspect", id])
        .output()
        .map_err(|error| {
            leftover_container_problem(format!("Could not inspect container {id}: {error}"))
        })?;
    if !inspect.status.success() {
        return Err(leftover_container_problem(format!(
            "Inspection of container {id} exited with {}. Output omitted because it can contain credentials.",
            inspect.status
        )));
    }
    let inspected: serde_json::Value = serde_json::from_slice(&inspect.stdout).map_err(|_| {
        leftover_container_problem(format!(
            "Inspection of container {id} did not return valid JSON."
        ))
    })?;
    let Some(containers) = inspected
        .as_array()
        .filter(|containers| containers.len() == 1)
    else {
        return Ok(None);
    };
    let container = &containers[0];
    // Exact ids only: an engine resolving a prefix to something else is not this container.
    if container["Id"].as_str() != Some(id) {
        return Ok(None);
    }
    // Docker reports `/name`; Podman reports `name`.
    let Some(name) = container["Name"]
        .as_str()
        .map(|name| name.strip_prefix('/').unwrap_or(name))
        .filter(|name| !name.is_empty())
    else {
        return Ok(None);
    };
    let labels = &container["Config"]["Labels"];
    let compose_owned = project
        .is_some_and(|project| labels["com.docker.compose.project"].as_str() == Some(project));
    // Matches `namesFor` in supervisor/src/names.ts and `labelsFor` in supervisor/src/docker.ts.
    let supervisor_owned = namespace.is_some_and(|namespace| {
        labels["openbot.supervisor"].as_str() == Some("true")
            && labels["openbot.namespace"].as_str() == Some(namespace)
            && labels["openbot.bot-id"].as_str().is_some_and(|bot| {
                supervisor_identifier(bot) && name == format!("{namespace}-computer-{bot}")
            })
    });
    if !compose_owned && !supervisor_owned {
        return Ok(None);
    }
    let state = &container["State"];
    // Only states a plain removal accepts count as stopped. Anything else, or anything unknown,
    // is treated as running so it is never touched.
    let stopped = state["Running"].as_bool() == Some(false)
        && state["Status"].as_str().is_some_and(|status| {
            matches!(status, "created" | "exited" | "stopped" | "configured")
        });
    Ok(Some((
        name.to_owned(),
        if stopped {
            ContainerState::Stopped
        } else {
            ContainerState::Running
        },
    )))
}

fn leftover_containers(
    engine: &Address,
    root: &Path,
    project: Option<&str>,
    namespace: Option<&str>,
) -> Result<(Vec<LeftoverContainer>, Vec<String>), Problem> {
    let mut ids = Vec::new();
    if let Some(project) = project {
        ids.extend(labelled_containers(
            engine,
            root,
            &[("com.docker.compose.project", project)],
        )?);
    }
    if let Some(namespace) = namespace {
        ids.extend(labelled_containers(
            engine,
            root,
            &[
                ("openbot.supervisor", "true"),
                ("openbot.namespace", namespace),
            ],
        )?);
    }
    ids.sort();
    ids.dedup();
    let mut stopped = Vec::new();
    let mut running = Vec::new();
    for id in ids {
        match owned_container(engine, root, &id, project, namespace)? {
            Some((name, ContainerState::Stopped)) => stopped.push(LeftoverContainer { name, id }),
            Some((name, ContainerState::Running)) => running.push(name),
            None => {}
        }
    }
    stopped.sort_by(|a, b| a.name.cmp(&b.name));
    running.sort();
    Ok((stopped, running))
}

/**
Every volume a previous installation of this deployment left behind, and that it provably owns.

A deleted installation folder removes `.env` and the vault, but not the engine's volumes. Compose
and the supervisor reattach them by name, so a new installation silently inherits the old one's
Bots' workspace files and browser sign-ins. Only three kinds are claimed: the verified Postgres
volume, the other ordinary project-scoped Compose volumes labelled for this project, and the
per-Bot volumes the supervisor labelled for this namespace. Never include config output in
diagnostics: interpolation may have put credentials in it.
*/
pub fn leftover_volumes(
    engine: &Address,
    root: &Path,
    secrets: &Secrets,
) -> Result<LeftoverVolumes, Problem> {
    let config = leftover_configuration(engine, root, secrets)?;
    let inventory = volume_inventory(engine, root)?;
    let postgres = postgres_data_volume(&config);
    let database_exists = postgres
        .and_then(|(_, definition)| definition["name"].as_str())
        .is_some_and(|name| inventory.iter().any(|listed| listed == name));
    let database = owned_database_volume(engine, root, &config, &inventory)?;
    let mut volumes: Vec<String> = database.iter().cloned().collect();
    let project = config["name"].as_str().filter(|name| !name.is_empty());
    let namespace = supervisor_namespace(&config);
    if let (Some(project), Some(definitions)) = (project, config["volumes"].as_object()) {
        for (source, definition) in definitions {
            // The database has its own, stricter test above.
            if postgres.is_some_and(|(postgres_source, _)| postgres_source == source) {
                continue;
            }
            let Some(name) = ordinary_project_volume(project, source, definition) else {
                continue;
            };
            volumes.extend(owned_compose_volume(
                engine, root, project, source, name, &inventory,
            )?);
        }
    }
    if let Some(namespace) = &namespace {
        for name in &inventory {
            volumes.extend(owned_supervisor_volume(engine, root, namespace, name)?);
        }
    }
    volumes.sort();
    volumes.dedup();
    // Stopped containers keep their volumes attached, so the engine refuses to remove them. Only
    // worth listing when there is data to reset.
    let (containers, running) = if volumes.is_empty() {
        Default::default()
    } else {
        leftover_containers(engine, root, project, namespace.as_deref())?
    };
    Ok(LeftoverVolumes {
        database,
        database_exists,
        volumes,
        containers,
        running,
    })
}

/// Remove exactly the leftover containers and volumes the person confirmed, containers first,
/// or nothing when either set changed or an owned container is running.
pub fn reset_leftover_volumes(
    engine: &Address,
    root: &Path,
    secrets: &Secrets,
    confirmed: &[String],
    confirmed_containers: &[String],
) -> Result<(), Problem> {
    let leftovers = leftover_volumes(engine, root, secrets)?;
    if let Some(said) = leftovers.running_said() {
        return Err(Problem::plain(format!("{said} Nothing was removed.")));
    }
    let sorted = |names: &[String]| {
        let mut names = names.to_vec();
        names.sort();
        names
    };
    if !leftovers.resettable()
        || leftovers.volumes != sorted(confirmed)
        || leftovers.container_names() != sorted(confirmed_containers)
    {
        return Err(Problem::with(
            "What the earlier installation left has changed since you confirmed it, so nothing was \
             removed. Try Start again.",
            "the leftovers no longer match the containers and volumes confirmed, or their \
             ownership could not be verified",
        ));
    }
    let mut removed: Vec<&str> = Vec::new();
    let removals = leftovers
        .containers
        .iter()
        .map(|container| ("container", container.id.as_str(), container.name.as_str()))
        .chain(
            leftovers
                .volumes
                .iter()
                .map(|volume| ("volume", volume.as_str(), volume.as_str())),
        );
    for (kind, target, name) in removals {
        let so_far = || match removed.as_slice() {
            [] => "Nothing was removed.".to_owned(),
            removed => format!("Already removed: {}.", removed.join(", ")),
        };
        // Never force this operation: the engine must refuse a running container and any
        // container attachment, including one created after inspection. Do not stop containers
        // to make it pass.
        let output = engine
            .command()
            .current_dir(root)
            .args([kind, "rm", target])
            .output()
            .map_err(|error| {
                Problem::with(
                    format!("OpenBot could not remove {name}. {}", so_far()),
                    format!("Could not run {kind} removal: {error}"),
                )
            })?;
        if !output.status.success() {
            let why = if kind == "container" {
                "It may have started again."
            } else {
                "It may still be in use."
            };
            return Err(Problem::with(
                format!("OpenBot could not remove {name}. {why} {} Stop the installation using it, then try Start again.", so_far()),
                format!("{kind} removal exited with {}. Output omitted because it can contain credentials.", output.status),
            ));
        }
        removed.push(name);
    }
    Ok(())
}

fn empty_volume_options(options: &serde_json::Value) -> bool {
    options.is_null()
        || options
            .as_object()
            .is_some_and(|options| options.is_empty())
}

fn postgres_volume_name(configuration: &[u8]) -> Result<String, Problem> {
    let config: serde_json::Value = serde_json::from_slice(configuration)
        .map_err(|_| postgres_volume_problem("Compose config did not return valid JSON."))?;
    postgres_data_volume(&config)
        .and_then(|(_, definition)| definition["name"].as_str())
        .filter(|name| !name.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            postgres_volume_problem("Compose did not resolve a named volume for Postgres data.")
        })
}

fn postgres_data_volume(config: &serde_json::Value) -> Option<(&str, &serde_json::Value)> {
    let postgres = &config["services"]["postgres"];
    let data = postgres["environment"]["PGDATA"]
        .as_str()
        .unwrap_or("/var/lib/postgresql/data");
    // A PGDATA subdirectory still belongs to its containing mount. Prefer the closest mount
    // so a nested override cannot make us inspect an unrelated volume.
    let mount = postgres["volumes"].as_array().and_then(|mounts| {
        mounts
            .iter()
            .filter(|mount| {
                mount["target"].as_str().is_some_and(|target| {
                    data == target
                        || data.starts_with(&format!("{}/", target.trim_end_matches('/')))
                })
            })
            .max_by_key(|mount| mount["target"].as_str().unwrap().len())
    });
    mount
        .filter(|mount| mount["type"].as_str() == Some("volume"))
        .and_then(|mount| mount["source"].as_str())
        .and_then(|source| {
            config["volumes"]
                .get(source)
                .map(|definition| (source, definition))
        })
}

const MACOS_PODMAN_PORTS_FILE: &str = ".openbot-macos-podman.yml";
const MACOS_PODMAN_PORTS: &str = include_str!("macos-podman-ports.yml");
const HARNESS_PORT_FILE: &str = ".openbot-harness-port.yml";

fn harness_port_overlay(root: &Path, ipv4_only: bool) -> Result<Option<String>, Problem> {
    let values = crate::env::read_already_set(
        &root.join(".env"),
        &["PICKED_HARNESS_HOST_PORT", "PICKED_HARNESS_PORT"],
    )
    .map_err(|error| {
        Problem::with(
            "OpenBot could not read the Bot's local port.",
            error.to_string(),
        )
    })?;
    let Some(host) = values.get("PICKED_HARNESS_HOST_PORT") else {
        return Ok(None);
    };
    let parse = |value: &str| {
        value
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .ok_or_else(|| {
                Problem::plain("The Bot's local port setting is invalid. Try Start again.")
            })
    };
    let host = parse(host)?;
    let target = parse(
        values
            .get("PICKED_HARNESS_PORT")
            .map(String::as_str)
            .unwrap_or("4202"),
    )?;
    if host == target {
        return Ok(None);
    }
    let mut overlay = format!("services:\n  agent-harness:\n    ports: !override\n      - \"127.0.0.1:{host}:{target}\"\n");
    if !ipv4_only {
        overlay.push_str(&format!("      - \"[::1]:{host}:{target}\"\n"));
    }
    Ok(Some(overlay))
}

const DESKTOP_TELEMETRY_FILE: &str = ".openbot-desktop-telemetry.yml";
const DESKTOP_TELEMETRY: &str = include_str!("../telemetry.compose.yml");
const DESKTOP_TELEMETRY_DISABLED_FILE: &str = ".openbot-desktop-telemetry-disabled.yml";
const DESKTOP_TELEMETRY_DISABLED: &str = include_str!("../telemetry-disabled.compose.yml");

fn desktop_telemetry_disabled(secrets: &Secrets) -> bool {
    ["COPILOTKIT_TELEMETRY_DISABLED", "DO_NOT_TRACK"]
        .iter()
        .any(|key| {
            secrets
                .get(*key)
                .is_some_and(|value| matches!(value.as_str(), "1" | "true"))
        })
}

/// Overlays contain configuration names only; identities and credentials remain in environment.
fn append_compose_overlay(
    command: &mut Command,
    root: &Path,
    file: &str,
    contents: &str,
) -> Result<(), Problem> {
    let overlay = root.join(file);
    if std::fs::read(&overlay).ok().as_deref() != Some(contents.as_bytes()) {
        std::fs::write(&overlay, contents).map_err(|error| {
            Problem::with(
                "OpenBot couldn't prepare its settings on this computer. Try again.",
                error.to_string(),
            )
        })?;
    }
    command.arg("-f").arg(file);
    Ok(())
}

/// The native personal edition alone may hand its installation identity to its server.
fn uses_desktop_telemetry(root: &Path, secrets: &Secrets) -> bool {
    let settings = crate::env::already_set(&root.join(".env"), &["OPENBOT_EDITION"]);
    settings.get("OPENBOT_EDITION").map(String::as_str) == Some("personal")
        && (secrets.get("OPENBOT_DISTRIBUTION").map(String::as_str) == Some("desktop")
            || secrets
                .get("COPILOTKIT_TELEMETRY_DISABLED")
                .is_some_and(|value| matches!(value.as_str(), "1" | "true")))
}

/// Only service creation needs the Mac Podman port overlay. In particular, `run migrate` can
/// create its Postgres dependency, so it must use the same configuration as `up`.
fn compose_start_command(
    engine: &Address,
    root: &Path,
    secrets: &Secrets,
    os: &str,
) -> Result<Command, Problem> {
    let mut command = compose_command(engine, root, secrets);
    let macos_podman = os == "macos" && engine.engine == crate::engine::Engine::Podman;
    let harness_ports = harness_port_overlay(root, macos_podman)?;
    let desktop_telemetry = uses_desktop_telemetry(root, secrets);
    if !macos_podman && harness_ports.is_none() && !desktop_telemetry {
        return Ok(command);
    }

    // Let Compose read/interpolate .env and COMPOSE_ENV_FILES itself. Adding -f directly would
    // otherwise discard both implicit override files and COMPOSE_FILE from that environment.
    // This output can contain credentials: retain only file-selection settings, never log it.
    let environment = compose_command(engine, root, secrets)
        .args(["config", "--environment"])
        .output();
    // Only the optional telemetry overrides need the probe here. An older Compose without it, or
    // one that fails it, starts OpenBot as before: telemetry never blocks Start, opted out or not.
    let optional_only = desktop_telemetry && !macos_podman && harness_ports.is_none();
    if optional_only
        && environment
            .as_ref()
            .map_or(true, |output| !output.status.success())
    {
        log::warn!(
            "[telemetry] Compose settings unavailable; starting without the desktop telemetry \
             overrides (opted out: {})",
            desktop_telemetry_disabled(secrets)
        );
        return Ok(command);
    }
    let environment = environment.map_err(|error| {
        Problem::with(
            "OpenBot couldn't read its installation's settings. Repair the installation.",
            error.to_string(),
        )
    })?;
    if !environment.status.success() {
        return Err(Problem::with(
            "OpenBot couldn't read its installation's settings. Repair the installation.",
            command_said(&environment.stderr),
        ));
    }
    let environment = String::from_utf8(environment.stdout).map_err(|_| {
        Problem::with(
            "OpenBot couldn't read its installation's settings. Repair the installation.",
            "Compose returned unreadable deployment settings",
        )
    })?;
    let files = compose_files(root, &environment)?;
    for (index, file) in files.iter().enumerate() {
        command.arg("-f").arg(file);
        // Desktop defaults precede user overrides, so a server-level opt-out is preserved.
        if index == 0 && desktop_telemetry {
            if let Err(error) = append_compose_overlay(
                &mut command,
                root,
                DESKTOP_TELEMETRY_FILE,
                DESKTOP_TELEMETRY,
            ) {
                log::warn!(
                    "[telemetry] Compose overlay unavailable; starting without it: {}",
                    error.detail.as_deref().unwrap_or(&error.said)
                );
            }
        }
    }
    for (file, contents) in [
        (
            MACOS_PODMAN_PORTS_FILE,
            macos_podman.then_some(MACOS_PODMAN_PORTS),
        ),
        (HARNESS_PORT_FILE, harness_ports.as_deref()),
    ] {
        if let Some(contents) = contents {
            append_compose_overlay(&mut command, root, file, contents)?;
        }
    }
    // Last, so the native opt-out wins over any override. Optional like the rest of telemetry: a
    // file that cannot be written is logged, and OpenBot starts.
    if desktop_telemetry && desktop_telemetry_disabled(secrets) {
        if let Err(error) = append_compose_overlay(
            &mut command,
            root,
            DESKTOP_TELEMETRY_DISABLED_FILE,
            DESKTOP_TELEMETRY_DISABLED,
        ) {
            log::warn!(
                "[telemetry] Compose opt-out override unavailable; starting without it: {}",
                error.detail.as_deref().unwrap_or(&error.said)
            );
        }
    }
    Ok(command)
}

fn compose_files(root: &Path, environment: &str) -> Result<Vec<String>, Problem> {
    let setting = |key: &str| {
        environment.lines().find_map(|line| {
            let (name, value) = line.split_once('=')?;
            (name == key).then_some(value)
        })
    };
    if let Some(files) = setting("COMPOSE_FILE") {
        let separator = setting("COMPOSE_PATH_SEPARATOR")
            .filter(|value| !value.is_empty())
            .unwrap_or(if cfg!(windows) { ";" } else { ":" });
        return Ok(files.split(separator).map(str::to_owned).collect());
    }

    // Compose-go's default discovery order. A valid installed deployment contains its base
    // file in this directory, so there is no need to search outside the selected installation.
    let first = |names: &[&str]| {
        names
            .iter()
            .find(|name| root.join(name).exists())
            .map(|name| (*name).to_owned())
    };
    let base = first(&[
        "compose.yaml",
        "compose.yml",
        "docker-compose.yml",
        "docker-compose.yaml",
    ])
    .ok_or_else(|| {
        Problem::with(
            "Part of OpenBot's installation is missing. Repair the installation.",
            "the selected installation has no Compose file",
        )
    })?;
    let mut files = vec![base];
    if let Some(existing) = first(&[
        "compose.override.yml",
        "compose.override.yaml",
        "docker-compose.override.yml",
        "docker-compose.override.yaml",
    ]) {
        files.push(existing);
    }
    Ok(files)
}

/// Resolve only image references, using public installation overrides before credentials exist.
pub fn installation_images(
    engine: &Address,
    root: &Path,
    harness: bool,
    settings: &Secrets,
) -> Result<Vec<String>, Problem> {
    installation_images_in(engine, root, root, harness, settings)
}

/// [`installation_images`] for a release laid out in `release`, resolved as `root`'s own project
/// with `root`'s settings.
pub fn installation_images_in(
    engine: &Address,
    root: &Path,
    release: &Path,
    harness: bool,
    settings: &Secrets,
) -> Result<Vec<String>, Problem> {
    installation_images_by(
        compose_command(engine, root, settings),
        root,
        release,
        harness,
    )
}

/// A Compose of OpenBot's own that runs without any engine, for `config`: the standalone binary
/// `install.rs` downloads (`docker-compose`), with the same settings as `compose_command`. Before
/// Podman is on a computer, this is the only Compose there is.
pub fn standalone_compose_command(compose: &Path, root: &Path, secrets: &Secrets) -> Command {
    let mut command = crate::quiet::command(compose);
    command.current_dir(root).envs(secrets);
    command.env("COMPOSE_PROJECT_NAME", DESKTOP_PROJECT);
    command
}

/// [`installation_images_in`], with the Compose `command` to ask given.
pub fn installation_images_by(
    mut command: Command,
    root: &Path,
    release: &Path,
    harness: bool,
) -> Result<Vec<String>, Problem> {
    let mut requested = selected_services(harness);
    requested.push("migrate");
    if release != root {
        // Compose reads the release's file from where it runs, and `.env` from there too, so the
        // installation's own settings are named explicitly.
        command.current_dir(release);
        if root.join(".env").is_file() {
            command.arg("--env-file").arg(root.join(".env"));
        }
    }
    if harness {
        command.args(["--profile", "harness"]);
    }
    let output = command
        .args(["config", "--images"])
        .args(requested)
        .output()
        .map_err(|e| {
            Problem::with(
                "OpenBot could not check which software to install.",
                e.to_string(),
            )
        })?;
    if !output.status.success() {
        return Err(Problem::with(
            "OpenBot could not check which software to install.",
            command_said(&output.stderr),
        ));
    }
    let images: std::collections::BTreeSet<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    if images.is_empty() {
        return Err(Problem::plain(
            "This deployment does not identify the software OpenBot needs to install.",
        ));
    }
    Ok(images.into_iter().collect())
}

/// Pull the selected stack before `up`, including the one-shot migration and service dependencies.
/// Keep this separate from `up`: image transfer must not include container startup or migrations.
/// Legacy batch helper for providers with a missing-only pull policy. The desktop installation
/// step uses `pull_image` for explicit acquisition on every provider; `up` never pulls.
pub fn pull(
    engine: &Address,
    root: &Path,
    harness: bool,
    secrets: &Secrets,
    on_complete: impl FnOnce(crate::pull_metrics::PullMetrics),
) -> Result<(), Problem> {
    let Some(json_progress) = crate::pull_metrics::compose_pull_progress(engine) else {
        return Ok(());
    };
    let mut requested = selected_services(harness);
    requested.push("migrate");
    let mut command = compose_command(engine, root, secrets);
    if json_progress {
        command.args(["--progress", "json"]);
    }
    if harness {
        command.args(["--profile", "harness"]);
    }
    command
        .args(["pull", "--policy", "missing", "--include-deps"])
        .args(&requested);
    crate::pull_metrics::run(command, None, json_progress, on_complete)
}

/// Raise the containers.
///
/// `--no-build` is the point of the whole published-images job: a desktop install has no toolchain,
/// and without it Compose quietly starts compiling Chromium. Failing loudly on a missing image is
/// the better answer, because it names a pull that did not happen.
pub fn up(
    engine: &Address,
    root: &Path,
    harness: bool,
    secrets: &Secrets,
) -> Result<Vec<&'static str>, crate::problem::Problem> {
    crate::logging::timed("compose up", || {
        up_retrying(engine, root, harness, secrets, &FOLDER_NOT_SHARED_YET_WAITS)
    })
}

/**
Make the sign-in folder Compose bind-mounts into the server, as the person.

Compose's bind mount does not create it, because Docker would make it as root on Linux and this app
could then not write a sign-in into it. Installation makes it, minutes before the first Start, and
Start makes it again in case it went since: a folder made a moment before `up` was refused by Docker
Desktop's file sharing on a Mac (`folder_not_shared_yet`).
*/
pub fn make_sign_in_folder(root: &Path) -> Result<PathBuf, crate::problem::Problem> {
    let folder = root.join(".openbot");
    std::fs::create_dir_all(&folder).map_err(|error| {
        crate::problem::Problem::with(
            "OpenBot couldn't prepare its sign-in folder. Try again.",
            format!("{}: {error}", folder.display()),
        )
    })?;
    Ok(folder)
}

/// How long `up` waits before each new try while Docker Desktop cannot see a folder yet: 15
/// seconds in all. On OpenBot Desktop 1.0.0's first Start it took seconds.
const FOLDER_NOT_SHARED_YET_WAITS: [std::time::Duration; 4] = [
    std::time::Duration::from_secs(1),
    std::time::Duration::from_secs(2),
    std::time::Duration::from_secs(4),
    std::time::Duration::from_secs(8),
];

/**
Docker Desktop's file sharing refused a bind mount's source folder, which the host has.

Seen on a Mac on the first Start of a new installation, for the sign-in folder Start had made a
moment before: `invalid mount config for type "bind": stat /host_mnt/Users/<name>/OpenBot/.openbot:
operation not permitted`. A few seconds later the same mount worked, and so did Retry. Docker Desktop
documents no such delay, so this matches the daemon's own words for exactly that refusal and nothing
else: every other error still fails the `up` at once.
*/
fn folder_not_shared_yet(said: &str) -> bool {
    said.lines().any(|line| {
        line.contains("invalid mount config for type \"bind\": stat ")
            && line.trim_end().ends_with(": operation not permitted")
    })
}

/// `up`, tried again after each of `waits` while the engine still cannot see a bind mount's folder.
fn up_retrying(
    engine: &Address,
    root: &Path,
    harness: bool,
    secrets: &Secrets,
    waits: &[std::time::Duration],
) -> Result<Vec<&'static str>, crate::problem::Problem> {
    let mut waits = waits.iter();
    loop {
        match up_now(engine, root, harness, secrets) {
            Err(problem) if problem.detail.as_deref().is_some_and(folder_not_shared_yet) => {
                let Some(wait) = waits.next() else {
                    return Err(problem);
                };
                log::warn!(
                    "[compose up] the engine cannot see a folder it mounts yet; trying again in {}s",
                    wait.as_secs()
                );
                std::thread::sleep(*wait);
            }
            answer => return answer,
        }
    }
}

fn up_now(
    engine: &Address,
    root: &Path,
    harness: bool,
    secrets: &Secrets,
) -> Result<Vec<&'static str>, crate::problem::Problem> {
    /*
     * The picked harness rides in on its profile.
     *
     * `agent-harness` is profile-gated so a deployment that picked nothing does not try to start
     * it: its image comes from `.env`, and with nothing picked it is a stand-in docker-compose.yml
     * names so older Compose will read the file at all. The flag comes before
     * `up`, because `--profile` is an option of `compose` itself and not of the subcommand.
     */
    let requested = selected_services(harness);
    let mut command = compose_start_command(engine, root, secrets, std::env::consts::OS)?;
    if harness {
        command.args(["--profile", "harness"]);
    }
    let output = command
        .args(["up", "-d", "--no-build", "--pull", "never"])
        .args(&requested)
        .output()
        .map_err(|error| format!("could not run {} compose: {error}", engine.engine.binary()))?;

    if output.status.success() {
        return Ok(requested);
    }
    // Both registers: the sentence is chosen from what the engine said, and what it said is kept
    // beside it rather than shown as the headline. See `problem.rs`.
    let raw = command_said(&output.stderr);
    Err(crate::problem::Problem::with(
        crate::problem::said_about(&raw),
        raw,
    ))
}

/// The label the supervisor stamps on every container it creates.
///
/// Matching on this rather than on a name prefix. `openbot-` is also the prefix of a kind cluster's
/// nodes and of anything else somebody has called openbot, and stopping a person's Kubernetes
/// cluster because it shares six letters with this one would be unforgivable.
/// Written as the whole filter, `label=` and all. Handed to the engine without that prefix it
/// answers `invalid filter`, and it does so at the moment somebody is being told their stack has
/// stopped, so the prefix belongs with the label rather than at the call site.
const SUPERVISOR_FILTER: &str = "label=openbot.supervisor=true";

/// Resolve the same namespace the selected deployment gives its supervisor. Compose owns
/// interpolation, env-file quoting and defaults; parsing .env independently can select a different
/// deployment. Never include the resolved configuration (which can contain secrets) in an error.
fn computer_namespace(engine: &Address, root: &Path) -> Result<Option<String>, String> {
    let config = root.join("docker-compose.yml");
    match std::fs::metadata(&config) {
        Ok(metadata) if metadata.is_file() => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !crate::deployment::stamp_path(root)
                .try_exists()
                .map_err(|error| format!("could not verify computer namespace ownership: {error}"))?
            {
                // Welcome/setup has no deployment yet. In particular, do not let Compose search
                // a parent directory for a file belonging to another installation.
                return Ok(None);
            }
            return Err("could not resolve computer namespace: installed deployment is missing docker-compose.yml".into());
        }
        _ => return Err("could not resolve computer namespace: selected deployment configuration is not readable".into()),
    }
    let output = compose_command(engine, root, &Secrets::new())
        .args(["-f", "docker-compose.yml", "config", "--format", "json"])
        .output()
        .map_err(|error| format!("could not resolve computer namespace: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "could not resolve computer namespace: Compose configuration failed ({})",
            output.status
        ));
    }
    let config: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!("could not resolve computer namespace: unreadable Compose response ({error})")
    })?;
    let configured = config
        .pointer("/services/supervisor/environment/COMPUTER_NAMESPACE")
        .and_then(serde_json::Value::as_str)
        .ok_or("could not resolve computer namespace: supervisor configuration has no namespace")?;
    // A malformed/missing response never becomes an unscoped filter.
    let namespace = resolve_namespace(configured)
        .ok_or("could not resolve computer namespace: supervisor namespace is invalid")?;
    Ok(Some(namespace.to_string()))
}

/// Stop the computers the supervisor made, which Compose does not know about.
///
/// A Bot's computer is created at runtime, not declared in `docker-compose.yml`, so `compose down`
/// leaves it running: an idle Ubuntu container per Bot, with the application gone and nothing on
/// screen to stop it from. Stopped rather than removed, because the supervisor starts an existing
/// owned container back up and the Bot keeps the profile and workspace volumes attached to it.
/// Quiesce the supervisor before listing so in-flight creates and restarts are included.
/// Returns false only when the selected root has no installed deployment to take down.
pub fn stop_computers(engine: &Address, root: &Path) -> Result<bool, String> {
    crate::logging::timed("stop Bots' computers", || stop_computers_now(engine, root))
}

fn stop_computers_now(engine: &Address, root: &Path) -> Result<bool, String> {
    let Some(namespace) = computer_namespace(engine, root)? else {
        return Ok(false);
    };
    // Validate ownership before stopping anything, then wait for the creator to exit. A list taken
    // while the supervisor is active can miss a new computer or one it restarts after being stopped.
    let supervisor = compose_command(engine, root, &Secrets::new())
        .args(["-f", "docker-compose.yml", "stop", "supervisor"])
        .output()
        .map_err(|error| format!("could not stop the supervisor: {error}"))?;
    if !supervisor.status.success() {
        return Err(format!(
            "could not stop the supervisor ({}): {}",
            supervisor.status,
            command_said(&supervisor.stderr)
        ));
    }

    let namespace_filter = format!("label=openbot.namespace={namespace}");
    let listed = engine
        .command()
        .args([
            "ps",
            "--quiet",
            "--filter",
            SUPERVISOR_FILTER,
            "--filter",
            &namespace_filter,
        ])
        .output()
        .map_err(|error| format!("could not list the Bots' computers: {error}"))?;
    if !listed.status.success() {
        return Err(command_said(&listed.stderr));
    }

    let running: Vec<String> = String::from_utf8_lossy(&listed.stdout)
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if running.is_empty() {
        return Ok(true);
    }

    let stopped = engine
        .command()
        .arg("stop")
        .args(&running)
        .output()
        .map_err(|error| format!("could not stop the Bots' computers: {error}"))?;
    if stopped.status.success() {
        return Ok(true);
    }
    Err(command_said(&stopped.stderr))
}

pub fn down(engine: &Address, root: &Path) -> Result<(), String> {
    crate::logging::timed("compose down", || {
        // Stop the supervisor and its runtime-created computers before removing the Compose stack.
        if !stop_computers(engine, root)? {
            return Ok(());
        }

        /*
         * WITH THE PROFILE, OR THE PICKED BOT KEEPS RUNNING.
         *
         * Measured: after pressing Stop, `compose ps` still listed `agent-harness`. Compose only acts
         * on a profiled service when the profile is named, so Stop was leaving the one container the
         * person actually chose running on their laptop, still holding its port. The next Start then
         * refused because something was listening on it.
         *
         * Named unconditionally rather than only when a harness was picked: this has to stop what an
         * earlier run started, and whether that run picked one is not something a Stop can know.
         *
         * `openbot` for the same reason: `server` and `worker` sit behind it, and a Stop that left them
         * running would leave the app answering a window that says OpenBot is stopped.
         */
        let output = compose_command(engine, root, &Secrets::new())
            .args([
                "-f",
                "docker-compose.yml",
                "--profile",
                "harness",
                "--profile",
                OPENBOT_PROFILE,
                "down",
            ])
            .output()
            .map_err(|error| format!("could not stop the stack: {error}"))?;

        if output.status.success() {
            return Ok(());
        }
        Err(command_said(&output.stderr))
    })
}

/// Where the pids of the host processes are written, so a later window can stop them.
///
/// The handles a window holds die with the window. Everything else about a running stack survives
/// it: the containers are Compose's, and the three host processes just keep going. Without this,
/// Stop from a restarted window had nothing to work with.
pub fn host_pids_path(root: &Path) -> PathBuf {
    root.join(".logs").join("host-pids.json")
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordedHostProcess {
    pub name: String,
    pub pid: u32,
    pub executable_path: String,
    pub command_line: String,
    pub creation_date: String,
}

/// Unix v2 evidence binds a process instance to the deployment and named launch.
/// Unlike the legacy PID list, this survives reopening without trusting PID reuse or cwd.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct UnixHostProcess {
    name: String,
    deployment: PathBuf,
    pid: u32,
    start: String,
}

#[cfg(unix)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct UnixProcess {
    pid: u32,
    parent: u32,
    start: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RecordedHostPidFile {
    UnixRecords {
        version: u8,
        unix_processes: Vec<UnixHostProcess>,
    },
    Records {
        version: u8,
        processes: Vec<RecordedHostProcess>,
    },
    Pids(Vec<u32>),
}

/// Record the pids of the processes this window started.
pub fn record_host_pids(root: &Path, pids: &[u32]) -> Result<(), Problem> {
    write_host_pid_file(root, &pids)
}

/// Record the host processes this window started.
pub fn record_host_processes(root: &Path, processes: &[(&str, u32)]) -> Result<(), Problem> {
    #[cfg(windows)]
    record_windows_host_processes_with(root, processes, Path::new("powershell"))?;
    #[cfg(not(windows))]
    {
        let records = unix_host_records(root, processes)?;
        write_host_pid_file(
            root,
            &serde_json::json!({"version": 2, "unix_processes": records}),
        )?;
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn record_windows_host_processes_with(
    root: &Path,
    processes: &[(&str, u32)],
    powershell: &Path,
) -> Result<(), Problem> {
    let problem = |detail| {
        Problem::with(
            "OpenBot could not verify its Windows host process ownership.",
            format!(
                "{}: {detail}; ownership records retained",
                host_pids_path(root).display()
            ),
        )
    };
    let mut seen_names = std::collections::HashSet::new();
    let mut seen_pids = std::collections::HashSet::new();
    for (name, pid) in processes {
        if !HOST_PROCESSES.contains(name) {
            return Err(problem(format!("unknown host launch {name}, pid {pid}")));
        }
        if !seen_names.insert(*name) || !seen_pids.insert(*pid) {
            return Err(problem(format!("duplicate host launch {name}, pid {pid}")));
        }
    }

    let snapshot = windows_processes_with(powershell)?;
    let mut records = Vec::with_capacity(processes.len());
    for (name, pid) in processes {
        let matches: Vec<_> = snapshot
            .iter()
            .filter(|process| process.process_id == *pid)
            .collect();
        let live = match matches.as_slice() {
            [] => {
                return Err(problem(format!(
                    "host {name}, pid {pid} is missing from the process inventory"
                )));
            }
            [live] => *live,
            _ => {
                return Err(problem(format!(
                    "host {name}, pid {pid} appeared more than once in the process inventory"
                )));
            }
        };
        let record = RecordedHostProcess::from_live(name, live)
            .filter(|record| {
                !record.executable_path.is_empty()
                    && !record.command_line.is_empty()
                    && !record.creation_date.is_empty()
            })
            .ok_or_else(|| {
                problem(format!(
                    "host {name}, pid {pid} has incomplete process identity metadata"
                ))
            })?;
        records.push(record);
    }
    write_host_pid_file(
        root,
        &serde_json::json!({ "version": 1, "processes": records }),
    )?;
    Ok(())
}

/// The pids a previous window recorded, if any.
pub fn recorded_host_pids(root: &Path) -> Result<Vec<u32>, Problem> {
    Ok(match recorded_host_pid_file(root)? {
        Some(RecordedHostPidFile::Records {
            version: 1,
            processes,
        }) => processes.into_iter().map(|process| process.pid).collect(),
        Some(RecordedHostPidFile::UnixRecords {
            version: 2,
            unix_processes,
        }) => unix_processes
            .into_iter()
            .map(|process| process.pid)
            .collect(),
        Some(RecordedHostPidFile::Pids(pids)) => pids,
        _ => Vec::new(),
    })
}

/// The recorded host processes with enough identity to verify a live Windows process.
pub fn recorded_host_processes(root: &Path) -> Result<Vec<RecordedHostProcess>, Problem> {
    Ok(match recorded_host_pid_file(root)? {
        Some(RecordedHostPidFile::Records {
            version: 1,
            processes,
        }) => processes,
        _ => Vec::new(),
    })
}

fn recorded_host_pid_file(root: &Path) -> Result<Option<RecordedHostPidFile>, Problem> {
    let path = host_pids_path(root);
    let problem = |detail| {
        Problem::with(
            "OpenBot could not read its recorded host processes.",
            format!("{}: {detail}", path.display()),
        )
    };
    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(problem(format!("could not read pidfile: {error}"))),
    };
    let recorded = serde_json::from_slice::<RecordedHostPidFile>(&raw)
        .map_err(|error| problem(format!("could not decode pidfile JSON: {error}")))?;
    let (version, supported) = match &recorded {
        RecordedHostPidFile::Records { version, .. } => (*version, 1),
        RecordedHostPidFile::UnixRecords { version, .. } => (*version, 2),
        RecordedHostPidFile::Pids(_) => (0, 0),
    };
    if version != supported {
        return Err(problem(format!("unsupported pidfile version {version}")));
    }
    Ok(Some(recorded))
}

/// Commit a complete pidfile with one replacement. Every fallible preparation step happens
/// before the rename, so an error leaves the previous ownership evidence available for retry.
fn write_host_pid_file<T: Serialize>(root: &Path, value: &T) -> Result<(), Problem> {
    use std::io::Write;

    let path = host_pids_path(root);
    let problem = |operation: &str, error: &dyn std::fmt::Display| {
        Problem::with(
            "OpenBot could not record its host processes.",
            format!("{}: {operation}: {error}", path.display()),
        )
    };
    let bytes = serde_json::to_vec(value)
        .map_err(|error| problem("could not serialize pidfile", &error))?;
    let parent = path.parent().expect("host pidfile has a .logs parent");
    std::fs::create_dir_all(parent)
        .map_err(|error| problem("could not create pidfile parent directory", &error))?;
    let temporary = parent.join(format!(".host-pids-{:016x}.tmp", rand::random::<u64>()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    // Only clean up a temporary file this call created, including on a name collision.
    let mut file = options
        .open(&temporary)
        .map_err(|error| problem("could not create temporary pidfile", &error))?;
    let prepared = file
        .write_all(&bytes)
        .map_err(|error| problem("could not write temporary pidfile", &error))
        .and_then(|()| {
            file.sync_all()
                .map_err(|error| problem("could not sync temporary pidfile", &error))
        });
    drop(file);
    let result = prepared.and_then(|()| {
        std::fs::rename(&temporary, &path)
            .map_err(|error| problem("could not replace pidfile", &error))
    });
    if let Err(mut failure) = result {
        if let Err(error) = std::fs::remove_file(&temporary) {
            failure.detail = Some(format!(
                "{}; could not remove temporary pidfile {}: {error}",
                failure.detail.as_deref().unwrap_or_default(),
                temporary.display(),
            ));
        }
        return Err(failure);
    }
    Ok(())
}

/// Keep a replacement handle even if refreshing durable ownership fails. The caller must
/// report success only after this Result succeeds; Stop still has the handle on failure.
#[cfg(unix)]
pub fn replace_host_process(
    root: &Path,
    children: &mut Vec<(&'static str, std::process::Child)>,
    name: &'static str,
    child: std::process::Child,
) -> Result<(), Problem> {
    children.retain(|(held, _)| *held != name);
    children.push((name, child));
    let mut live = Vec::new();
    for (name, child) in children.iter_mut() {
        if child
            .try_wait()
            .map_err(|error| {
                unix_ownership_problem(format!("could not inspect held {name}: {error}"))
            })?
            .is_none()
        {
            live.push((*name, child.id()));
        }
    }
    record_host_processes(root, &live)
}

/// Publish only the new Windows instance. Other roles may already be dead, and their
/// durable identities must remain available for cleanup without trusting their old PIDs again.
#[cfg(any(not(unix), test))]
pub fn replace_windows_host_process_with(
    root: &Path,
    children: &mut Vec<(&'static str, std::process::Child)>,
    name: &'static str,
    child: std::process::Child,
    powershell: &Path,
) -> Result<(), Problem> {
    // Retire only handles known to have exited. On any later failure Stop keeps the
    // replacement, as well as any predecessor whose exit could not be confirmed.
    children.retain_mut(|(held, child)| *held != name || !matches!(child.try_wait(), Ok(Some(_))));
    children.push((name, child));
    let child = &mut children.last_mut().unwrap().1;
    let pid = child.id();
    let problem = |detail| {
        Problem::with(
            "OpenBot could not verify its Windows replacement process ownership.",
            format!("{name}, pid {pid}: {detail}; ownership retained"),
        )
    };
    let require_live = |child: &mut std::process::Child| match child.try_wait() {
        Ok(None) => Ok(()),
        Ok(Some(_)) => Err(problem("replacement has exited".to_string())),
        Err(error) => Err(problem(format!("could not inspect replacement: {error}"))),
    };
    require_live(child)?;
    if !HOST_PROCESSES.contains(&name) {
        return Err(problem("unknown host role".to_string()));
    }
    let snapshot = windows_processes_with(powershell)?;
    // The held Child must remain live through capture: a PID alone cannot authorize
    // recording a process that replaced it while the inventory command was running.
    require_live(child)?;
    let mut matches = snapshot.iter().filter(|live| live.process_id == pid);
    let record = matches
        .next()
        .filter(|live| live.parent_process_id == std::process::id())
        .and_then(|live| RecordedHostProcess::from_live(name, live))
        .filter(|record| {
            !record.executable_path.is_empty()
                && !record.command_line.is_empty()
                && windows_creation_time(&record.creation_date).is_some()
        })
        .ok_or_else(|| problem("complete direct-child identity is unavailable".to_string()))?;
    if matches.next().is_some() {
        return Err(problem("duplicate process inventory identity".to_string()));
    }
    let mut records = recorded_host_processes(root)?;
    if !records.contains(&record) {
        records.push(record);
    }
    write_host_pid_file(root, &serde_json::json!({"version":1,"processes":records}))
}

#[cfg(unix)]
fn unix_ownership_problem(detail: impl Into<String>) -> Problem {
    Problem::with(
        "OpenBot could not verify its host process ownership.",
        detail,
    )
}

#[cfg(unix)]
fn safe_unix_pid(pid: u32) -> bool {
    pid > 1
        && pid <= i32::MAX as u32
        && pid != std::process::id()
        && pid != unsafe { libc::getppid() } as u32
}

#[cfg(unix)]
fn unix_host_records(
    root: &Path,
    processes: &[(&str, u32)],
) -> Result<Vec<UnixHostProcess>, Problem> {
    let deployment = std::fs::canonicalize(root).map_err(|error| {
        unix_ownership_problem(format!(
            "{}: could not resolve deployment: {error}",
            root.display()
        ))
    })?;
    processes
        .iter()
        .map(|(name, pid)| {
            if !safe_unix_pid(*pid) || !HOST_PROCESSES.contains(name) {
                return Err(unix_ownership_problem(format!(
                    "invalid host launch {name}, pid {pid}"
                )));
            }
            let live = unix_process(*pid)?.ok_or_else(|| {
                unix_ownership_problem(format!("host {name}, pid {pid} is no longer running"))
            })?;
            if live.parent != std::process::id() {
                return Err(unix_ownership_problem(format!(
                    "host {name}, pid {pid} is not a child of this window"
                )));
            }
            Ok(UnixHostProcess {
                name: name.to_string(),
                deployment: deployment.clone(),
                pid: *pid,
                start: live.start,
            })
        })
        .collect()
}

#[cfg(unix)]
fn unix_process(pid: u32) -> Result<Option<UnixProcess>, Problem> {
    Ok(unix_process_state(pid)?.map(|(process, _)| process))
}

#[cfg(target_os = "macos")]
fn unix_process_state(pid: u32) -> Result<Option<(UnixProcess, bool)>, Problem> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if read != size {
        let error = std::io::Error::last_os_error();
        if read == 0 && error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        return Err(unix_ownership_problem(format!(
            "proc_pidinfo({pid}) returned {read}/{size} bytes: {error}"
        )));
    }
    let info = unsafe { info.assume_init() };
    if info.pbi_status == libc::SZOMB {
        return Ok(None);
    }
    if info.pbi_pid != pid || info.pbi_start_tvsec == 0 {
        return Err(unix_ownership_problem(format!(
            "proc_pidinfo({pid}) returned invalid identity"
        )));
    }
    Ok(Some((
        UnixProcess {
            pid,
            parent: info.pbi_ppid,
            start: format!("macos:{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
        },
        info.pbi_status == libc::SSTOP,
    )))
}

#[cfg(target_os = "linux")]
fn unix_process_state(pid: u32) -> Result<Option<(UnixProcess, bool)>, Problem> {
    let path = format!("/proc/{pid}/stat");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(unix_ownership_problem(format!("{path}: {error}"))),
    };
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(|error| {
        unix_ownership_problem(format!("could not read Linux boot identity: {error}"))
    })?;
    parse_linux_process_state(pid, &raw, boot.trim())
}

#[cfg(all(unix, test))]
fn parse_linux_process(pid: u32, raw: &str, boot: &str) -> Result<Option<UnixProcess>, Problem> {
    Ok(parse_linux_process_state(pid, raw, boot)?.map(|(process, _)| process))
}

#[cfg(all(unix, any(target_os = "linux", test)))]
fn parse_linux_process_state(
    pid: u32,
    raw: &str,
    boot: &str,
) -> Result<Option<(UnixProcess, bool)>, Problem> {
    let invalid =
        || unix_ownership_problem(format!("invalid Linux process inventory for pid {pid}"));
    let (head, tail) = raw.rsplit_once(')').ok_or_else(invalid)?;
    let (listed, _) = head.split_once('(').ok_or_else(invalid)?;
    if listed.trim().parse::<u32>().ok() != Some(pid) || boot.is_empty() {
        return Err(invalid());
    }
    let fields: Vec<_> = tail.split_whitespace().collect();
    let parent = fields
        .get(1)
        .and_then(|s| s.parse::<u32>().ok())
        .ok_or_else(invalid)?;
    let start = fields
        .get(19)
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)
        .ok_or_else(invalid)?;
    if fields.first() == Some(&"Z") {
        return Ok(None);
    }
    Ok(Some((
        UnixProcess {
            pid,
            parent,
            start: format!("linux:{boot}:{start}"),
        },
        fields.first() == Some(&"T"),
    )))
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn unix_process_state(_pid: u32) -> Result<Option<(UnixProcess, bool)>, Problem> {
    Err(unix_ownership_problem(
        "process-instance verification is unsupported on this Unix platform",
    ))
}

#[cfg(unix)]
fn unix_inventory() -> Result<Vec<(u32, u32)>, Problem> {
    unix_inventory_with(Path::new("/bin/ps"))
}

#[cfg(unix)]
fn unix_inventory_with(ps: &Path) -> Result<Vec<(u32, u32)>, Problem> {
    let operation = format!("{} -axo pid=,ppid=", ps.display());
    let listing = command(ps)
        .args(["-axo", "pid=,ppid="])
        .output()
        .map_err(|error| cleanup_spawn_problem(&operation, error))?;
    if !listing.status.success() {
        return Err(cleanup_status_problem(&operation, &listing));
    }
    let raw = std::str::from_utf8(&listing.stdout).map_err(|error| {
        unix_ownership_problem(format!("invalid process inventory encoding: {error}"))
    })?;
    let mut rows = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in raw.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        let invalid = || unix_ownership_problem("malformed Unix process inventory");
        if fields.len() != 2 {
            return Err(invalid());
        }
        let pid = fields[0].parse::<u32>().map_err(|_| invalid())?;
        let parent = fields[1].parse::<u32>().map_err(|_| invalid())?;
        if pid == 0 || !seen.insert(pid) {
            return Err(invalid());
        }
        rows.push((pid, parent));
    }
    if rows.is_empty() {
        return Err(unix_ownership_problem("empty Unix process inventory"));
    }
    Ok(rows)
}

/// Stop only recorded Unix instances and descendants whose ancestry is verified while the
/// recorded parent is still alive. Cwd, command names and legacy PIDs never authorize a signal.
#[cfg(unix)]
pub fn stop_processes_under(root: &Path) -> Result<usize, Problem> {
    let records = match recorded_host_pid_file(root)? {
        None => return Ok(0),
        Some(RecordedHostPidFile::UnixRecords { version: 2, unix_processes }) => unix_processes,
        _ => return Err(unix_ownership_problem(format!("{}: legacy ownership evidence has no Unix process-instance identity; cleanup unresolved", host_pids_path(root).display()))),
    };
    stop_unix_records(root, &records)
}

#[cfg(unix)]
fn stop_unix_records(root: &Path, records: &[UnixHostProcess]) -> Result<usize, Problem> {
    if records.is_empty() {
        return Ok(0);
    }
    let deployment = std::fs::canonicalize(root).map_err(|error| {
        unix_ownership_problem(format!(
            "{}: could not resolve deployment: {error}",
            root.display()
        ))
    })?;
    let inventory = unix_inventory()?;
    stop_unix_records_with(
        &deployment,
        records,
        &inventory,
        unix_process,
        quiesce_unix_process,
        unix_inventory,
        terminate_unix_process,
    )
}

#[cfg(unix)]
fn stop_unix_records_with<I, Q, L, T>(
    deployment: &Path,
    records: &[UnixHostProcess],
    inventory: &[(u32, u32)],
    mut inspect: I,
    mut quiesce: Q,
    mut inventory_now: L,
    mut terminate: T,
) -> Result<usize, Problem>
where
    I: FnMut(u32) -> Result<Option<UnixProcess>, Problem>,
    Q: FnMut(i32, &mut dyn FnMut() -> Result<bool, Problem>) -> Result<(), Problem>,
    L: FnMut() -> Result<Vec<(u32, u32)>, Problem>,
    T: FnMut(i32, &mut dyn FnMut() -> Result<bool, Problem>) -> Result<bool, Problem>,
{
    let mut stopped = 0;
    let mut failures = Vec::new();
    for record in records {
        let result = (|| {
            if record.deployment != deployment
                || record.start.is_empty()
                || !safe_unix_pid(record.pid)
                || !HOST_PROCESSES.contains(&record.name.as_str())
            {
                return Err(unix_ownership_problem(format!(
                    "invalid Unix ownership record for pid {}",
                    record.pid
                )));
            }
            let Some(live) = inspect(record.pid)? else {
                return Ok(0);
            };
            if live.start != record.start {
                return Ok(0);
            }
            if !inventory.contains(&(live.pid, live.parent)) {
                return Err(unix_ownership_problem(format!(
                    "process inventory lost the owned root pid {}",
                    live.pid
                )));
            }
            let mut tree = vec![(live, None)];
            let mut seen = std::collections::HashSet::from([record.pid]);
            let mut index = 0;
            while index < tree.len() {
                let parent = tree[index].0.pid;
                // Freeze the verified parent before enumerating its children. A snapshot taken
                // while a launcher can run misses children born during build-to-serve transitions.
                quiesce(parent as i32, &mut || {
                    unix_tree_owned(&tree, index, &mut inspect)
                })?;
                let children = inventory_now()?;
                if !unix_tree_owned(&tree, index, &mut inspect)? {
                    return Err(unix_ownership_problem(format!(
                        "quiesced process {parent} exited before its descendants were inventoried"
                    )));
                }
                for (pid, ppid) in children.iter().filter(|(_, ppid)| *ppid == parent) {
                    if !safe_unix_pid(*pid) || !seen.insert(*pid) {
                        return Err(unix_ownership_problem(
                            "unsafe or cyclic owned process ancestry",
                        ));
                    }
                    if let Some(child) = inspect(*pid)? {
                        if child.parent != *ppid {
                            return Err(unix_ownership_problem(format!(
                                "process ancestry changed for pid {pid}"
                            )));
                        }
                        tree.push((child, Some(index)));
                    }
                }
                index += 1;
            }
            let mut count = 0;
            // Descendants must actually exit before their ownership ancestor is killed.
            // Failed cleanup leaves the anchors stopped and the durable records available
            // for another Stop; resuming an incomplete tree would reopen the spawn race.
            for index in (0..tree.len()).rev() {
                let mut still_owned = || unix_tree_owned(&tree, index, &mut inspect);
                if still_owned()? && terminate(tree[index].0.pid as i32, &mut still_owned)? {
                    count += 1;
                }
            }
            Ok(count)
        })();
        match result {
            Ok(count) => stopped += count,
            Err(problem) => failures.push(problem),
        }
    }
    cleanup_result(stopped, failures)
}

#[cfg(unix)]
fn unix_tree_owned<I>(
    tree: &[(UnixProcess, Option<usize>)],
    index: usize,
    inspect: &mut I,
) -> Result<bool, Problem>
where
    I: FnMut(u32) -> Result<Option<UnixProcess>, Problem>,
{
    let mut ancestor = Some(index);
    while let Some(at) = ancestor {
        match inspect(tree[at].0.pid)? {
            Some(now) if now == tree[at].0 => {}
            None if at == index => return Ok(false),
            _ => {
                return Err(unix_ownership_problem(format!(
                    "process identity or ancestry changed for pid {}",
                    tree[at].0.pid
                )))
            }
        }
        ancestor = tree[at].1;
    }
    Ok(true)
}

#[cfg(unix)]
fn quiesce_unix_process(
    pid: i32,
    still_owned: &mut dyn FnMut() -> Result<bool, Problem>,
) -> Result<(), Problem> {
    quiesce_unix_process_with(
        pid,
        still_owned,
        signal_unix_process,
        |pid| Ok(unix_process_state(pid)?.is_some_and(|(_, stopped)| stopped)),
        std::time::Duration::from_secs(2),
    )
}

#[cfg(unix)]
fn quiesce_unix_process_with<S, Q>(
    pid: i32,
    still_owned: &mut dyn FnMut() -> Result<bool, Problem>,
    mut signal: S,
    mut is_stopped: Q,
    patience: std::time::Duration,
) -> Result<(), Problem>
where
    S: FnMut(i32, i32) -> Result<bool, Problem>,
    Q: FnMut(u32) -> Result<bool, Problem>,
{
    let unresolved = || {
        unix_ownership_problem(format!(
        "could not confirm pid {pid} stopped before descendant inventory; ownership ancestor and records retained"
    ))
    };
    if !still_owned()? || !signal(pid, libc::SIGSTOP)? {
        return Err(unresolved());
    }
    let deadline = std::time::Instant::now() + patience;
    loop {
        let stopped = is_stopped(pid as u32)?;
        // Status is not identity. Revalidate the complete chain after the status query too.
        if !still_owned()? {
            return Err(unresolved());
        }
        if stopped {
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(unresolved());
        }
        std::thread::sleep(remaining.min(std::time::Duration::from_millis(25)));
    }
}

#[cfg(unix)]
fn terminate_unix_process(
    pid: i32,
    still_owned: &mut dyn FnMut() -> Result<bool, Problem>,
) -> Result<bool, Problem> {
    terminate_unix_process_with(
        pid,
        still_owned,
        signal_unix_process,
        std::time::Duration::from_secs(2),
    )
}

#[cfg(unix)]
fn terminate_unix_process_with<S>(
    pid: i32,
    still_owned: &mut dyn FnMut() -> Result<bool, Problem>,
    mut signal: S,
    patience: std::time::Duration,
) -> Result<bool, Problem>
where
    S: FnMut(i32, i32) -> Result<bool, Problem>,
{
    // Keep the complete tree stopped through removal: SIGCONT would let a launcher or
    // TERM handler spawn again. SIGKILL is delivered to stopped processes without resuming
    // them. Orderly handlers do not run; all exits still require verified ownership.
    if !still_owned()? || !signal(pid, libc::SIGKILL)? {
        return Ok(false);
    }
    if wait_for_verified_unix_exit(still_owned, patience)? {
        return Ok(true);
    }
    Err(Problem::with(
        "OpenBot could not stop one of its host processes.",
        format!(
            "pid {pid} is still running after SIGKILL; ownership ancestor and records retained"
        ),
    ))
}

#[cfg(unix)]
fn wait_for_verified_unix_exit(
    still_owned: &mut dyn FnMut() -> Result<bool, Problem>,
    patience: std::time::Duration,
) -> Result<bool, Problem> {
    let deadline = std::time::Instant::now() + patience;
    loop {
        if !still_owned()? {
            return Ok(true);
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Ok(false);
        }
        std::thread::sleep(remaining.min(std::time::Duration::from_millis(25)));
    }
}

#[cfg(unix)]
fn signal_unix_process(pid: i32, signal: i32) -> Result<bool, Problem> {
    if pid <= 1 || !safe_unix_pid(pid as u32) {
        return Err(unix_ownership_problem("refused unsafe process target"));
    }
    let killed = unsafe { libc::kill(pid, signal) };
    if killed == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(false);
    }
    Err(Problem::with(
        "OpenBot could not stop one of its host processes.",
        format!("could not send signal {signal} to pid {pid}: {error}"),
    ))
}

#[cfg(not(unix))]
pub fn stop_processes_under(_root: &Path) -> Result<usize, Problem> {
    /*
     * Windows cannot be asked which process is in which directory cheaply, so this used to answer
     * 0 and say the host processes end with the session. They do not, and the case it dismissed is
     * the common one: the handles this window holds are gone the moment the window is restarted,
     * so a window Stopping a stack an earlier one started holds nothing at all.
     *
     * MEASURED ON WINDOWS SERVER 2022. Stop took the five containers down, reported success, and
     * left every host process running: the server on 3001, the worker, and both halves of the app
     * still answering 200 on 3010. Somebody who pressed Stop still had OpenBot serving.
     *
     * So they are found by the ports the deployment publishes, which the shell already owns and
     * already checks for clashes, and each is ended WITH ITS CHILDREN: `bun run serve` starts the
     * real server as a grandchild, so ending only the process holding the port leaves that behind.
     */
    /*
     * The pids this window or an earlier one recorded, which is the only way to reach the worker.
     *
     * It listens on no port, so the sweep below cannot see it. The server has its own loader entry,
     * but that does not make the worker visible to the port sweep: after the port sweep alone, 3001
     * and 3010 were free and the worker was still running.
     */
    stop_windows_processes_with_inventory(_root, Path::new("powershell"), Path::new("taskkill"))
}

#[cfg(any(not(unix), test))]
fn stop_windows_processes_with_inventory(
    root: &Path,
    powershell: &Path,
    taskkill: &Path,
) -> Result<usize, Problem> {
    let recorded = match recorded_host_pid_file(root)? {
        Some(RecordedHostPidFile::Pids(pids)) if !pids.is_empty() => {
            // A previous Start wrote these PIDs, but a reopened window cannot prove their
            // process instances. Keep that unresolved evidence without authorizing a signal.
            return Err(Problem::with(
                "OpenBot could not verify its recorded host processes.",
                format!(
                    "{}: legacy PID-only evidence lacks Windows process-instance identity; cleanup unresolved; ownership records retained",
                    host_pids_path(root).display()
                ),
            ));
        }
        Some(RecordedHostPidFile::Records {
            version: 1,
            processes,
        }) => processes,
        _ => Vec::new(),
    };
    let processes = windows_processes_with(powershell)?;
    stop_windows_processes_under_with(root, &recorded, &processes, taskkill)
}

#[cfg(any(not(unix), test))]
fn stop_windows_processes_under_with(
    root: &Path,
    recorded: &[RecordedHostProcess],
    processes: &[WindowsProcess],
    taskkill: &Path,
) -> Result<usize, Problem> {
    // A same-PID row without usable identity metadata is unresolved, not proof of PID reuse.
    // Keep the original evidence for a later inventory that can positively verify or reject it.
    if let Some(record) = recorded.iter().find(|record| {
        processes.iter().any(|live| {
            live.process_id == record.pid
                && ([&live.executable_path, &live.command_line]
                    .iter()
                    .any(|field| matches!(field.as_deref(), None | Some("")))
                    || live
                        .creation_date
                        .as_deref()
                        .and_then(windows_creation_time)
                        .is_none()
                    || windows_creation_time(&record.creation_date).is_none())
        })
    }) {
        return Err(Problem::with(
            "OpenBot could not verify one of its recorded host processes.",
            format!(
                "{}: process inventory lacks usable identity metadata for pid {}; ownership records retained",
                host_pids_path(root).display(),
                record.pid
            ),
        ));
    }
    // /T already terminates each verified root's tree. A later port sweep must not reuse
    // that pre-termination identity: Windows can assign a terminated PID to another process.
    // Keep all ownership records on any failure so a retry can obtain a fresh inventory.
    let stopped = stop_verified_windows_roots_with(recorded, processes, |pid| {
        taskkill_process_tree_with(taskkill, pid)
    })?;
    let path = host_pids_path(root);
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(Problem::with(
                "OpenBot could not remove its recorded host processes.",
                format!("{}: could not remove pidfile: {error}", path.display()),
            ));
        }
    }
    Ok(stopped)
}

fn cleanup_result(stopped: usize, failures: Vec<Problem>) -> Result<usize, Problem> {
    if failures.is_empty() {
        return Ok(stopped);
    }
    Err(combined_cleanup_problem(failures))
}

#[cfg(not(unix))]
fn taskkill_process_tree(pid: u32) -> Result<bool, Problem> {
    taskkill_process_tree_with(Path::new("taskkill"), pid)
}

#[cfg(any(not(unix), test))]
fn taskkill_process_tree_with(taskkill: &Path, pid: u32) -> Result<bool, Problem> {
    let operation = format!("{} /PID {pid} /T /F", taskkill.display());
    let output = command(taskkill)
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output()
        .map_err(|error| cleanup_spawn_problem(&operation, error))?;
    if output.status.success() {
        return Ok(true);
    }
    Err(cleanup_status_problem(&operation, &output))
}

#[cfg(any(not(unix), test))]
fn stop_verified_windows_roots_with<F>(
    recorded: &[RecordedHostProcess],
    processes: &[WindowsProcess],
    mut taskkill: F,
) -> Result<usize, Problem>
where
    F: FnMut(u32) -> Result<bool, Problem>,
{
    let mut stopped = 0;
    let mut failures = Vec::new();
    for pid in verified_openbot_root_pids(recorded, processes) {
        // With its children: `bun run serve` starts the real server as a grandchild, so ending
        // only the process holding the port leaves that one behind.
        match taskkill(pid) {
            Ok(true) => stopped += 1,
            Ok(false) => {}
            Err(problem) => failures.push(problem),
        }
    }
    cleanup_result(stopped, failures)
}

fn cleanup_spawn_problem(operation: &str, error: std::io::Error) -> Problem {
    Problem::with(
        "OpenBot could not inspect or stop its host processes.",
        format!("could not run {operation}: {error}"),
    )
}

fn cleanup_status_problem(operation: &str, output: &std::process::Output) -> Problem {
    let stderr = command_said(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut detail = format!("{operation} exited with status {}", output.status);
    if !stderr.is_empty() {
        detail.push_str("\nstderr:\n");
        detail.push_str(&stderr);
    }
    if !stdout.is_empty() {
        detail.push_str("\nstdout:\n");
        detail.push_str(&stdout);
    }
    Problem::with(
        "OpenBot could not inspect or stop its host processes.",
        detail,
    )
}

fn combined_cleanup_problem(failures: Vec<Problem>) -> Problem {
    Problem::with(
        "OpenBot could not inspect or stop its host processes.",
        failures
            .into_iter()
            .map(problem_detail)
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn problem_detail(problem: Problem) -> String {
    match problem.detail {
        Some(detail) => format!("{}\n{}", problem.said, detail),
        None => problem.said,
    }
}

/// The TCP processes listening on any of `ports`, from `netstat -ano` output.
///
/// Pure and tested, because the column layout is the thing that goes wrong. Read as four columns
/// rather than five, the foreign address is taken for the state and the state for the pid: nothing
/// matches, and Stop reports success while leaving everything running. That is exactly what
/// happened, and this test is why it did not survive.
pub fn pids_listening_on(listing: &str, ports: &[u16]) -> Vec<u32> {
    let mut found: Vec<u32> = Vec::new();
    for line in listing.lines() {
        // Protocol, local address, foreign address, state, pid.
        let mut fields = line.split_whitespace();
        let (Some(proto), Some(local), Some(_foreign), Some(state), Some(pid)) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            continue;
        };
        if !proto.eq_ignore_ascii_case("TCP") || !state.eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        // `rsplit` rather than `split`, because an IPv6 local address is `[::1]:3010`.
        let Some(port) = local.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) else {
            continue;
        };
        if !ports.contains(&port) {
            continue;
        }
        let Ok(pid) = pid.parse::<u32>() else {
            continue;
        };
        // A port answers on both loopbacks, so one process appears on two lines.
        if !found.contains(&pid) {
            found.push(pid);
        }
    }
    found
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct WindowsProcess {
    pub process_id: u32,
    pub parent_process_id: u32,
    #[serde(default)]
    pub executable_path: Option<String>,
    #[serde(default)]
    pub command_line: Option<String>,
    #[serde(default)]
    pub creation_date: Option<String>,
}

impl RecordedHostProcess {
    #[cfg_attr(not(windows), allow(dead_code))]
    fn from_live(name: &str, live: &WindowsProcess) -> Option<Self> {
        Some(Self {
            name: name.to_string(),
            pid: live.process_id,
            executable_path: live.executable_path.clone()?,
            command_line: live.command_line.clone()?,
            creation_date: live.creation_date.clone()?,
        })
    }

    fn matches(&self, live: &WindowsProcess) -> bool {
        live.process_id == self.pid
            && live.executable_path.as_deref() == Some(self.executable_path.as_str())
            && live.command_line.as_deref() == Some(self.command_line.as_str())
            && live.creation_date.as_deref() == Some(self.creation_date.as_str())
    }
}

#[cfg(any(windows, test))]
fn windows_processes_with(powershell: &Path) -> Result<Vec<WindowsProcess>, Problem> {
    let operation = format!("{} Get-CimInstance Win32_Process", powershell.display());
    let output = command(powershell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate)",
        ])
        .output()
        .map_err(|error| cleanup_spawn_problem(&operation, error))?;
    if !output.status.success() {
        // The inventory includes other processes' command lines. Never echo a partial snapshot.
        return Err(Problem::with(
            "OpenBot could not inspect its Windows host processes.",
            format!("{operation} exited with status {}", output.status),
        ));
    }
    windows_process_output(&output.stdout)
}

#[cfg(any(windows, test))]
fn windows_process_output(output: &[u8]) -> Result<Vec<WindowsProcess>, Problem> {
    let invalid_encoding = || {
        Problem::with(
            "OpenBot could not inspect its Windows host processes.",
            "powershell Get-CimInstance Win32_Process returned invalid UTF-8 or UTF-16LE",
        )
    };
    // Windows PowerShell redirection can produce UTF-16LE, even though the script requests UTF-8.
    if output.starts_with(&[0xff, 0xfe]) || output.get(1) == Some(&0) {
        let bytes = output.strip_prefix(&[0xff, 0xfe]).unwrap_or(output);
        if !bytes.len().is_multiple_of(2) {
            return Err(invalid_encoding());
        }
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let text = String::from_utf16(&units).map_err(|_| invalid_encoding())?;
        windows_processes_in(&text)
    } else {
        let bytes = output.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(output);
        let text = std::str::from_utf8(bytes).map_err(|_| invalid_encoding())?;
        windows_processes_in(text)
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WindowsProcessListing {
    Many(Vec<WindowsProcess>),
    One(WindowsProcess),
}

pub fn windows_processes_in(listing: &str) -> Result<Vec<WindowsProcess>, Problem> {
    let listing = serde_json::from_str::<WindowsProcessListing>(listing).map_err(|error| {
        Problem::with(
            "OpenBot could not inspect its Windows host processes.",
            format!(
                "powershell Get-CimInstance Win32_Process returned invalid process JSON: {error}"
            ),
        )
    })?;
    Ok(match listing {
        WindowsProcessListing::Many(processes) => processes,
        WindowsProcessListing::One(process) => vec![process],
    })
}

/// Recorded OpenBot root processes whose live identity still matches the pid file.
pub fn verified_openbot_root_pids(
    recorded: &[RecordedHostProcess],
    processes: &[WindowsProcess],
) -> Vec<u32> {
    recorded
        .iter()
        .filter_map(|record| {
            let live = processes
                .iter()
                .find(|process| process.process_id == record.pid)?;
            (record.matches(live) && windows_creation_time(&record.creation_date).is_some())
                .then_some(record.pid)
        })
        .collect()
}

/// Recorded OpenBot processes, or their live children, listening on one of the host ports.
///
/// A pid file entry is not ownership by itself: the live process must still match the recorded
/// executable, command line and creation time before its tree is eligible for cleanup.
pub fn verified_openbot_pids_listening_on(
    listing: &str,
    ports: &[u16],
    recorded: &[RecordedHostProcess],
    processes: &[WindowsProcess],
) -> Vec<u32> {
    let roots = verified_openbot_root_pids(recorded, processes);
    pids_listening_on(listing, ports)
        .into_iter()
        .filter(|pid| belongs_to_any_root(*pid, &roots, processes))
        .collect()
}

/// A UTC instant in microseconds, preserving both Windows PowerShell's JSON date format
/// and the CIM datetime format. Unknown fields or malformed timestamps cannot prove ancestry.
fn windows_creation_time(value: &str) -> Option<i64> {
    fn digits(value: &str) -> Option<i64> {
        (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| value.parse().ok())?
    }

    // ConvertTo-Json in Windows PowerShell emits /Date(milliseconds[+/-HHmm])/.
    // The number is already UTC; the optional offset describes its local DateTime kind.
    if let Some(value) = value
        .strip_prefix("/Date(")
        .and_then(|s| s.strip_suffix(")/"))
    {
        let offset_index = value
            .char_indices()
            .skip(1)
            .find(|(_, ch)| matches!(ch, '+' | '-'))
            .map(|(index, _)| index);
        let milliseconds = if let Some(index) = offset_index {
            let offset = value.get(index + 1..)?;
            if offset.len() != 4 || digits(offset.get(..2)?)? > 23 || digits(offset.get(2..)?)? > 59
            {
                return None;
            }
            value.get(..index)?
        } else {
            value
        };
        digits(milliseconds.strip_prefix('-').unwrap_or(milliseconds))?;
        let milliseconds: i64 = milliseconds.parse().ok()?;
        // The .NET DateTime range is 0001-01-01 through 9999-12-31.
        return (-62_135_596_800_000..=253_402_300_799_999)
            .contains(&milliseconds)
            .then(|| milliseconds * 1_000);
    }

    // CIM: yyyymmddHHMMSS.mmmmmm+/-UUU, with a signed UTC offset in minutes.
    // https://learn.microsoft.com/en-us/windows/win32/wmisdk/cim-datetime
    if value.len() != 25 || value.get(14..15)? != "." {
        return None;
    }
    let year = digits(value.get(..4)?)?;
    let month = digits(value.get(4..6)?)?;
    let day = digits(value.get(6..8)?)?;
    let hour = digits(value.get(8..10)?)?;
    let minute = digits(value.get(10..12)?)?;
    let second = digits(value.get(12..14)?)?;
    let micros = digits(value.get(15..21)?)?;
    let offset = digits(value.get(22..)?)?
        * match value.get(21..22)? {
            "+" => 1,
            "-" => -1,
            _ => return None,
        };
    if year == 0 || !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let month_index = usize::try_from(month - 1).ok()?;
    if !(1..=month_days[month_index]).contains(&day) {
        return None;
    }
    let prior_year = year - 1;
    let days = 365 * prior_year + prior_year / 4 - prior_year / 100
        + prior_year / 400
        + month_days[..month_index].iter().sum::<i64>()
        + day
        - 1
        - 719_162;
    Some((((days * 24 + hour) * 60 + minute - offset) * 60 + second) * 1_000_000 + micros)
}

fn belongs_to_any_root(pid: u32, roots: &[u32], processes: &[WindowsProcess]) -> bool {
    if roots.contains(&pid) {
        return true;
    }

    let mut seen = std::collections::HashSet::new();
    let mut current = pid;
    loop {
        if !seen.insert(current) {
            return false;
        }
        let Some(process) = processes
            .iter()
            .find(|process| process.process_id == current)
        else {
            return false;
        };
        let parent = process.parent_process_id;
        if parent == 0 || parent == current {
            return false;
        }
        let Some(parent_process) = processes
            .iter()
            .find(|process| process.process_id == parent)
        else {
            return false;
        };
        let times = process
            .creation_date
            .as_deref()
            .and_then(windows_creation_time)
            .zip(
                parent_process
                    .creation_date
                    .as_deref()
                    .and_then(windows_creation_time),
            );
        // ParentProcessId can refer to a reused PID. A newer parent instance cannot have
        // created this child. Validate every link, including the final link to an owned root.
        // https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process
        if !times.is_some_and(|(child, parent)| parent <= child) {
            return false;
        }
        if roots.contains(&parent) {
            return true;
        }
        current = parent;
    }
}

/// Whether this deployment has recorded ownership for the server answering `port`.
///
/// Used by the passive startup probe. Absence of current, root-scoped ownership is not fatal
/// there; it means the app must show setup instead of adopting a process on the shared port.
pub fn recorded_server_owns_port(root: &Path, port: u16) -> Result<bool, Problem> {
    recorded_process_owns_port(root, "server", port)
}

/// Every listener on the port must belong to the requested recorded host role. This also rejects
/// ambiguous IPv4/IPv6 ownership rather than showing whichever unrelated address answers first.
pub fn recorded_process_owns_port(root: &Path, name: &str, port: u16) -> Result<bool, Problem> {
    if !HOST_PROCESSES.contains(&name) {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        recorded_process_owns_port_unix(root, name, port)
    }
    #[cfg(not(unix))]
    {
        recorded_process_owns_port_windows_with(
            root,
            name,
            port,
            Path::new("powershell"),
            Path::new("netstat"),
        )
    }
}

#[cfg(unix)]
fn recorded_process_owns_port_unix(root: &Path, name: &str, port: u16) -> Result<bool, Problem> {
    let deployment = std::fs::canonicalize(root).map_err(|error| {
        unix_ownership_problem(format!(
            "{}: could not resolve deployment: {error}",
            root.display()
        ))
    })?;
    let records = match recorded_host_pid_file(root)? {
        Some(RecordedHostPidFile::UnixRecords {
            version: 2,
            unix_processes,
        }) => unix_processes,
        _ => return Ok(false),
    };
    let listening = unix_pids_listening_on(port)?;
    if listening.is_empty() {
        return Ok(false);
    }
    let records: Vec<_> = records
        .iter()
        .filter(|record| record.name == name && record.deployment == deployment)
        .collect();
    for pid in listening {
        let mut owned = false;
        for record in &records {
            if unix_listener_belongs_to_record(pid, record, unix_process)? {
                owned = true;
                break;
            }
        }
        if !owned {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(unix)]
fn unix_listener_belongs_to_record<I>(
    pid: u32,
    record: &UnixHostProcess,
    mut inspect: I,
) -> Result<bool, Problem>
where
    I: FnMut(u32) -> Result<Option<UnixProcess>, Problem>,
{
    let mut seen = std::collections::HashSet::new();
    let mut chain = Vec::new();
    let mut current = pid;
    loop {
        if !safe_unix_pid(current) || !seen.insert(current) {
            return Ok(false);
        }
        let Some(live) = inspect(current)? else {
            return Ok(false);
        };
        let parent = live.parent;
        let at_root = current == record.pid;
        if at_root && (record.start.is_empty() || live.start != record.start) {
            return Ok(false);
        }
        chain.push(live);
        if at_root {
            // The app launcher may own a Vite child. Recheck every instance and parent link so a
            // dead/reused anchor or a changed ancestry cannot authorize an unrelated listener.
            for process in chain {
                if inspect(process.pid)?.as_ref() != Some(&process) {
                    return Ok(false);
                }
            }
            return Ok(true);
        }
        current = parent;
    }
}

#[cfg(unix)]
fn unix_pids_listening_on(port: u16) -> Result<Vec<u32>, Problem> {
    let operation = format!("lsof -nP -iTCP:{port} -sTCP:LISTEN -Fp");
    let output = command("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fp"])
        .output()
        .map_err(|error| cleanup_spawn_problem(&operation, error))?;
    if !output.status.success() {
        if output.status.code() == Some(1) {
            return Ok(Vec::new());
        }
        return Err(cleanup_status_problem(&operation, &output));
    }
    let listed = String::from_utf8_lossy(&output.stdout);
    Ok(parse_lsof_pid_fields(&listed))
}

#[cfg(unix)]
fn parse_lsof_pid_fields(listing: &str) -> Vec<u32> {
    let mut found = Vec::new();
    for line in listing.lines() {
        let Some(pid) = line
            .strip_prefix('p')
            .and_then(|pid| pid.parse::<u32>().ok())
        else {
            continue;
        };
        if !found.contains(&pid) {
            found.push(pid);
        }
    }
    found
}

#[cfg(any(not(unix), test))]
fn recorded_process_owns_port_windows_with(
    root: &Path,
    name: &str,
    port: u16,
    powershell: &Path,
    netstat: &Path,
) -> Result<bool, Problem> {
    let recorded: Vec<_> = recorded_host_processes(root)?
        .into_iter()
        .filter(|record| record.name == name)
        .collect();
    if recorded.is_empty() {
        return Ok(false);
    }
    let processes = windows_processes_with(powershell)?;
    // `-p tcp` omits IPv6 (`tcpv6`); inventory both families before requiring every
    // TCP listener to be owned. The parser ignores UDP rows in the unfiltered output.
    let operation = format!("{} -ano", netstat.display());
    let listing = command(netstat)
        .arg("-ano")
        .output()
        .map_err(|error| cleanup_spawn_problem(&operation, error))?;
    if !listing.status.success() {
        return Err(cleanup_status_problem(&operation, &listing));
    }
    let listed = String::from_utf8_lossy(&listing.stdout);
    let listening = pids_listening_on(&listed, &[port]);
    let verified = verified_openbot_pids_listening_on(&listed, &[port], &recorded, &processes);
    Ok(!listening.is_empty() && listening.iter().all(|pid| verified.contains(pid)))
}

/**
The tail of one service's log.

For the case where the wire says nothing. A framework that catches its own exception and ends the
stream leaves the cause here and nowhere else, so this is not a debugging convenience: without it
the developer half of that failure would be empty.

An engine that cannot be asked returns nothing rather than failing. This is only ever called to
explain a failure that has already happened, and a second failure on top of it helps nobody.
*/
/**
This machine's IPv4 address as the engine gives it to containers: what `host.docker.internal`
resolves to inside OpenBot's own `server` container, which `docker-compose.yml` maps to the
engine's host gateway (or `OPENBOT_HOST_GATEWAY`). The same address the Bots reach this machine at.
None when the server is not running or answers nothing usable. See `learning_model` for why the
local cluster is given this rather than a name.
*/
pub fn host_gateway_ipv4(engine: &Address, root: &Path) -> Option<std::net::Ipv4Addr> {
    let out = compose_command(engine, root, &Secrets::new())
        .args([
            "exec",
            "-T",
            "server",
            "getent",
            "ahostsv4",
            crate::env::CONTAINER_HOST,
        ])
        .output()
        .ok()
        .filter(|out| out.status.success())?;
    crate::learning_model::host_gateway_in(&String::from_utf8_lossy(&out.stdout))
}

pub fn service_log(engine: &Address, root: &Path, service: &str, lines: u16) -> String {
    compose_command(engine, root, &Secrets::new())
        .args(["logs", "--tail", &lines.to_string(), service])
        .output()
        .ok()
        .map(|out| {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            text.trim().to_string()
        })
        .unwrap_or_default()
}

/// Which Compose services are not running, and the last thing each said.
///
/// `compose up` succeeds once it has asked for everything; a service that then exits is not its
/// problem. Both Bots exit immediately without a model key, saying exactly that, and without this
/// the window reports a healthy stack while nothing can answer a question.
pub fn services_that_exited(
    engine: &Address,
    root: &Path,
) -> Result<Vec<(String, String)>, crate::problem::Problem> {
    services_that_exited_among(engine, root, None)
}

pub fn services_that_exited_among(
    engine: &Address,
    root: &Path,
    requested_services: Option<&std::collections::HashSet<&str>>,
) -> Result<Vec<(String, String)>, crate::problem::Problem> {
    let operation = format!("{} compose ps -a", engine.engine.binary());
    let output = compose_command(engine, root, &Secrets::new())
        .args(["ps", "-a", "--format", "{{.Service}}\t{{.State}}"])
        .output()
        .map_err(|error| {
            crate::problem::Problem::with(
                "OpenBot couldn't check on its own services. Try again.",
                format!("could not run {operation}: {error}"),
            )
        })?;

    if !output.status.success() {
        let stderr = command_said(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let mut detail = format!("{operation} exited with status {}", output.status);
        if !stderr.is_empty() {
            detail.push_str("\nstderr:\n");
            detail.push_str(&stderr);
        }
        if !stdout.is_empty() {
            detail.push_str("\nstdout:\n");
            detail.push_str(&stdout);
        }
        return Err(crate::problem::Problem::with(
            "OpenBot couldn't check on its own services. Try again.",
            detail,
        ));
    }

    let mut dead = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Some((service, state)) = line.split_once('\t') else {
            return Err(crate::problem::Problem::with(
                "OpenBot couldn't check on its own services. Try again.",
                format!("unusable {operation} row: {line}"),
            ));
        };
        let service = service.trim();
        let state = state.trim();
        if service.is_empty() || state.is_empty() {
            return Err(crate::problem::Problem::with(
                "OpenBot couldn't check on its own services. Try again.",
                format!("unusable {operation} row: {line}"),
            ));
        }
        if !state.trim().eq_ignore_ascii_case("exited") {
            continue;
        }
        // `migrate` is meant to exit: it is run to completion, not raised.
        if service == "migrate" {
            continue;
        }
        if requested_services.is_some_and(|requested| !requested.contains(service)) {
            continue;
        }
        let why = compose_command(engine, root, &Secrets::new())
            .args(["logs", "--tail", "3", service])
            .output()
            .ok()
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .unwrap_or_default();
        let why = why
            .lines()
            .rfind(|line| !line.trim().is_empty())
            .unwrap_or("no reason in its log")
            .trim()
            .to_string();
        dead.push((service.to_string(), why));
    }
    Ok(dead)
}

/**
The ports this deployment's own containers already publish.

MEASURED, AND IT LEAVES A PERSON STUCK. A start that fails after `compose up` leaves the containers
it raised running, so the next press of Start finds the harness port held and refuses with
"something is already listening on port 4206, which OpenBot uses for the Bot you picked" — about a
container OpenBot itself started, which the person never saw and cannot find. There is no way
forward from that screen.

Our own containers are not a conflict: `compose up` is idempotent and reuses them. The check exists
to catch somebody ELSE on the port, so what this deployment already publishes is excluded from it.

An engine that cannot be asked returns nothing, which leaves the check exactly as strict as it was.
*/
pub fn ports_we_already_publish(engine: &Address, root: &Path) -> std::collections::HashSet<u16> {
    let Ok(output) = compose_command(engine, root, &Secrets::new())
        .args(["ps", "--format", "{{.Ports}}"])
        .output()
    else {
        return std::collections::HashSet::new();
    };
    let listing = String::from_utf8_lossy(&output.stdout);
    published_in(&listing)
}

/**
Whether this deployment's own `server` container publishes every one of `ports` on the host.

THIS IS WHAT OWNERSHIP MEANS NOW. The server and the app used to be host processes, and a port
belonged to this deployment when a process recorded in its `host-pids.json` was listening on it.
They are one container now, and the listener on the host is the engine's port forwarder, which no
pid file names. What does name it is Compose: this project's `server` row lists the host ports it
was given. Something else answering on the same port, another installation's server or a stranger,
is not in that row.

Every service rather than `server` alone, read row by row: naming a service on `ps` makes Compose
resolve it, and `server` sits behind a profile this command would otherwise have to repeat.
*/
pub fn server_publishes(engine: &Address, root: &Path, ports: &[u16]) -> Result<bool, Problem> {
    let operation = format!("{} compose ps", engine.engine.binary());
    let output = compose_command(engine, root, &Secrets::new())
        .args(["ps", "--format", "{{.Service}}\t{{.Ports}}"])
        .output()
        .map_err(|error| {
            Problem::with(
                "OpenBot couldn't check on its own services. Try again.",
                format!("could not run {operation}: {error}"),
            )
        })?;
    if !output.status.success() {
        return Err(Problem::with(
            "OpenBot couldn't check on its own services. Try again.",
            format!("{operation}: {}", command_said(&output.stderr)),
        ));
    }
    Ok(server_publishes_in(
        &String::from_utf8_lossy(&output.stdout),
        ports,
    ))
}

/// `server_publishes` over a `{{.Service}}\t{{.Ports}}` listing. Pure, for the reason
/// `published_in` is.
pub fn server_publishes_in(listing: &str, ports: &[u16]) -> bool {
    let published: std::collections::HashSet<u16> = listing
        .lines()
        .filter_map(|row| row.split_once('\t'))
        .filter(|(service, _)| service.trim() == "server")
        .flat_map(|(_, mappings)| published_in(mappings))
        .collect();
    !ports.is_empty() && ports.iter().all(|port| published.contains(port))
}

/**
The per-run host token the installation's running `server` container was given, if it has one.

Start mints it, hands it to Compose for `server` alone and keeps it only in memory, so a session
that shows a deployment an earlier session raised (after a crash, a force quit, or an installer
that closed the app without its Quit) never had it. The container's own environment is the one
place it is still kept, and it is exactly the token the server checks. Only reads, and the token is
never logged.

Every service's row rather than `server` named, for the reason `server_publishes` gives.
*/
pub fn server_host_token(engine: &Address, root: &Path) -> Result<Option<String>, String> {
    let listed = compose_command(engine, root, &Secrets::new())
        .args(["ps", "--format", "{{.Service}}\t{{.ID}}"])
        .output()
        .map_err(|error| format!("could not list the Compose services: {error}"))?;
    if !listed.status.success() {
        return Err(command_said(&listed.stderr));
    }
    let listing = String::from_utf8_lossy(&listed.stdout);
    let Some(id) = listing
        .lines()
        .filter_map(|row| row.split_once('\t'))
        .find(|(service, id)| service.trim() == "server" && !id.trim().is_empty())
        .map(|(_, id)| id.trim().to_owned())
    else {
        return Ok(None);
    };
    let inspected = engine
        .command()
        .current_dir(root)
        .args([
            "container",
            "inspect",
            "--format",
            "{{json .Config.Env}}",
            &id,
        ])
        .output()
        .map_err(|error| format!("could not read the server container's settings: {error}"))?;
    if !inspected.status.success() {
        return Err(command_said(&inspected.stderr));
    }
    host_token_in(&inspected.stdout)
}

/// `server_host_token` over a container's `{{json .Config.Env}}`. Pure, for the reason
/// `published_in` is. An empty value is no token, as the server reads it.
pub fn host_token_in(environment: &[u8]) -> Result<Option<String>, String> {
    let environment: Vec<String> = serde_json::from_slice(environment)
        .map_err(|_| "the server container's settings could not be read".to_string())?;
    Ok(environment
        .iter()
        .find_map(|entry| entry.strip_prefix("OPENBOT_DESKTOP_HOST_TOKEN="))
        .filter(|token| !token.trim().is_empty())
        .map(str::to_owned))
}

/**
Restart OpenBot itself, the server and the worker, and leave everything else running.

What the Status window's Restart did to the host processes, now done by the engine that runs them:
the database and the Bots stay up, so nothing is lost and it takes seconds. The profile is named
because both services sit behind it, and Compose refuses to restart a service it cannot see.
*/
pub fn restart_openbot(engine: &Address, root: &Path) -> Result<(), String> {
    crate::logging::timed("compose restart", || restart_openbot_now(engine, root))
}

fn restart_openbot_now(engine: &Address, root: &Path) -> Result<(), String> {
    let output = compose_command(engine, root, &Secrets::new())
        .args(["--profile", OPENBOT_PROFILE, "restart", "server", "worker"])
        .output()
        .map_err(|error| format!("could not restart OpenBot: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(command_said(&output.stderr))
}

/**
The name Compose gave an installation made by an earlier app, which ran Compose with no project.

Those apps ran Compose from the deployment folder with no `-p` and the file names no `name:`, so
the project was the folder's own name as Compose normalises it: lower case, with everything but
`a-z`, `0-9`, `_` and `-` dropped, then any leading `_` or `-` trimmed. `~/OpenBot` is `openbot`.

ONLY A LEGACY NAME NOW, NEVER ONE TO ADOPT. A developer who runs OpenBot from a source checkout
called `openbot` gets Compose project `openbot` too, and on such a machine an installation that
named itself after its folder took the developer's containers and data for its own previous
installation and refused to start over them. See `project` for the name an installation runs as.
*/
pub fn project_name(root: &Path) -> String {
    let base = root
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    base.chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_' || *c == '-')
        .collect::<String>()
        .trim_start_matches(['_', '-'])
        .to_string()
}

/// Written beside the other `.openbot-*` records: the Compose project this installation runs as.
pub const PROJECT_FILE: &str = ".openbot-project.json";

/// The Compose project every installation this app makes runs as.
///
/// Not the folder's name, because a folder name is not ours: a source checkout called `openbot`
/// runs as `openbot` too, and Compose treats every container and volume labelled with a project as
/// that project's whoever made it. Fixed rather than random so a person reading `docker ps` can
/// tell which containers are the app's.
pub const DESKTOP_PROJECT: &str = "openbot-desktop";

#[derive(Serialize, Deserialize)]
struct SavedProject {
    project: String,
}

/// What Compose accepts as a project name: lower-case letters, digits, `_` and `-`, starting with a
/// letter or digit. A record holding anything else is damaged and reads as absent.
fn compose_project_name(name: &str) -> bool {
    name.as_bytes()
        .first()
        .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
}

/// The project this installation recorded, or `None` when it has recorded none yet.
pub fn saved_project(root: &Path) -> Option<String> {
    let record: SavedProject =
        serde_json::from_slice(&std::fs::read(root.join(PROJECT_FILE)).ok()?).ok()?;
    compose_project_name(&record.project).then_some(record.project)
}

/**
The Compose project this installation runs as, decided once and then read from its record.

Every Compose command for the installation is given it (see `compose_command`), so Install, Start,
Stop, the cleanup at Quit, status and Start fresh all name the same project, and none of them can
name one that is not the installation's own.

A new installation runs as `DESKTOP_PROJECT`. One made by an earlier app ran as its folder's name
(`project_name`), and keeps it ONLY when the engine holds containers of that project that Compose
ran from this very folder: Compose labels each container with the folder it ran from, which is
the one thing a folder-named project cannot fake. Any other answer is `DESKTOP_PROJECT`. A tester's
`~/OpenBot` found a developer's checkout called `openbot` running as `openbot`, adopted its
containers and its database as a previous installation's, and stopped on a key that was never
its own; this is what keeps that from happening again.

AN UPGRADE KEEPS ITS DATA. Stop and Quit take an earlier app's containers down, so most
installations reach this app with none left, only their volumes. Volumes do not carry the folder
Compose ran from, so the folder has to prove it instead: an earlier app finished installing here
(`preparation::installed_before`) and the legacy project's database volume is still on the
engine. Such an installation keeps its legacy project, and with it its database, its Bots'
computers and their volumes, provided no other folder is running that project right now.

When another folder is running it (a developer's checkout called `openbot`), whose data the volume
holds cannot be told, so nothing is decided and nothing is recorded: Install stops and says so,
and runs again once that other OpenBot is stopped. Old volumes are never deleted or renamed here.
*/
pub fn project(engine: &Address, root: &Path) -> Result<String, Problem> {
    project_choosing(engine, root, &project_name(root))
}

/// `project`, with the legacy name to consider given rather than derived from the folder.
pub fn project_choosing(engine: &Address, root: &Path, legacy: &str) -> Result<String, Problem> {
    if let Some(saved) = saved_project(root) {
        return Ok(saved);
    }
    // No folder, no installation: nothing to decide for, and nowhere to record it.
    if !root.is_dir() {
        return Ok(DESKTOP_PROJECT.to_owned());
    }
    let chosen = if legacy != DESKTOP_PROJECT && compose_project_name(legacy) {
        let running = legacy_containers(engine, root, legacy)?;
        if running.here {
            legacy.to_owned()
        } else if crate::preparation::installed_before(root)
            && legacy_database(engine, root, legacy)?
        {
            if let Some(folder) = running.elsewhere.first() {
                return Err(legacy_in_use_problem(legacy, folder));
            }
            legacy.to_owned()
        } else {
            DESKTOP_PROJECT.to_owned()
        }
    } else {
        DESKTOP_PROJECT.to_owned()
    };
    crate::preparation::write_checkpoint(
        root,
        PROJECT_FILE,
        &SavedProject {
            project: chosen.clone(),
        },
    )
    .map_err(|error| {
        Problem::with(
            "OpenBot couldn't save which parts of OpenBot belong to this installation. Try again.",
            error,
        )
    })?;
    Ok(chosen)
}

fn project_choice_problem(detail: impl Into<String>) -> Problem {
    Problem::with(
        "OpenBot couldn't tell which parts of OpenBot belong to this installation, so it changed \
         nothing. Try again.",
        detail,
    )
}

/// The earlier installation's data is there, but another folder runs its Compose project now.
fn legacy_in_use_problem(legacy: &str, folder: &Path) -> Problem {
    Problem::with(
        format!(
            "OpenBot found the data of your earlier installation, but another copy of OpenBot on this computer is using it right now, from {}. Stop that copy, then try again. Nothing was changed or deleted.",
            folder.display()
        ),
        format!(
            "Compose project `{legacy}` and its volume `{legacy}_postgres-data` are in use by containers that ran from {}.",
            folder.display()
        ),
    )
}

/// Which folders the containers of Compose project `legacy` ran from: this one, or others.
#[derive(Default)]
struct LegacyContainers {
    here: bool,
    elsewhere: Vec<PathBuf>,
}

/// Whether the engine still holds the database volume Compose made for project `legacy`: named
/// `<legacy>_postgres-data` and labelled as that project's `postgres-data`. Only reads.
fn legacy_database(engine: &Address, root: &Path, legacy: &str) -> Result<bool, Problem> {
    let volume = format!("{legacy}_postgres-data");
    let listed = volume_inventory(engine, root)
        .map_err(|problem| project_choice_problem(problem.detail.unwrap_or_default()))?;
    if !listed.contains(&volume) {
        return Ok(false);
    }
    let inspect = engine
        .command()
        .current_dir(root)
        .args(["volume", "inspect", &volume])
        .output()
        .map_err(|error| {
            project_choice_problem(format!("Could not inspect volume {volume}: {error}"))
        })?;
    // Gone since it was listed.
    if !inspect.status.success() {
        return Ok(false);
    }
    let inspected: serde_json::Value = serde_json::from_slice(&inspect.stdout).map_err(|_| {
        project_choice_problem(format!(
            "Inspection of volume {volume} did not return valid JSON."
        ))
    })?;
    Ok(inspected.as_array().into_iter().flatten().any(|found| {
        let labels = &found["Labels"];
        labels["com.docker.compose.project"].as_str() == Some(legacy)
            && labels["com.docker.compose.volume"].as_str() == Some("postgres-data")
    }))
}

/// Which folders ran the containers of Compose project `legacy`. Only reads: lists and inspects,
/// and never stops, removes or takes down anything, whoever's it is.
fn legacy_containers(
    engine: &Address,
    root: &Path,
    legacy: &str,
) -> Result<LegacyContainers, Problem> {
    let listed = engine
        .command()
        .current_dir(root)
        .args(["ps", "--all", "--quiet", "--no-trunc", "--filter"])
        .arg(format!("label=com.docker.compose.project={legacy}"))
        .output()
        .map_err(|error| project_choice_problem(format!("Could not list containers: {error}")))?;
    if !listed.status.success() {
        return Err(project_choice_problem(format!(
            "Container listing exited with {}.",
            listed.status
        )));
    }
    let here = canonical(root);
    let mut found = LegacyContainers::default();
    for id in String::from_utf8_lossy(&listed.stdout).split_whitespace() {
        let inspect = engine
            .command()
            .current_dir(root)
            .args(["container", "inspect", id])
            .output()
            .map_err(|error| {
                project_choice_problem(format!("Could not inspect container {id}: {error}"))
            })?;
        // Gone since it was listed: nothing left of it to prove anything.
        if !inspect.status.success() {
            continue;
        }
        let inspected: serde_json::Value =
            serde_json::from_slice(&inspect.stdout).map_err(|_| {
                project_choice_problem(format!(
                    "Inspection of container {id} did not return valid JSON."
                ))
            })?;
        for container in inspected.as_array().into_iter().flatten() {
            let labels = &container["Config"]["Labels"];
            if labels["com.docker.compose.project"].as_str() != Some(legacy) {
                continue;
            }
            let Some(folder) = labels["com.docker.compose.project.working_dir"].as_str() else {
                continue;
            };
            let folder = canonical(Path::new(folder));
            if folder == here {
                found.here = true;
            } else if !found.elsewhere.contains(&folder) {
                found.elsewhere.push(folder);
            }
        }
    }
    Ok(found)
}

/// The folder as the file system resolves it, so `/var` and `/private/var`, or `..` in a label,
/// compare equal. A folder that no longer exists compares as written. Plain, because the folder of
/// another copy goes into the message that says where it runs from.
fn canonical(folder: &Path) -> PathBuf {
    std::fs::canonicalize(folder)
        .map(crate::paths::plain)
        .unwrap_or_else(|_| folder.to_path_buf())
}

/// The namespace the supervisor gives this installation's Bots' computers and volumes, when the
/// installation has to say: `None` leaves it what earlier apps always ran with.
///
/// `DESKTOP_PROJECT`'s own, so a new installation's `<namespace>-computer-…`, `-profile-…` and
/// `-workspace-…` cannot be a source checkout's either. A legacy installation keeps the default its
/// Bots' computers and volumes were made under, or it would lose them.
pub fn computer_namespace_for(project: &str) -> Option<&str> {
    (project == DESKTOP_PROJECT).then_some(DESKTOP_PROJECT)
}

/**
The running containers that are this installation's, by name, for the Status listing. Only reads.

By the Compose project label, which Compose puts on its own containers and the supervisor on the
Bots' computers, and not by name: an installation running as `openbot` would otherwise claim every
`openbot-…` container on the engine, another project's `openbot-kite-demo-…` among them.
*/
pub fn running_containers_of(engine: &Address, root: &Path) -> Vec<String> {
    let project = recorded_project(root);
    let listed = engine
        .command()
        .current_dir(root)
        .args(["ps", "--all", "--quiet", "--no-trunc", "--filter"])
        .arg(format!("label=com.docker.compose.project={project}"))
        .output();
    let Ok(listed) = listed.map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
    else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for id in listed.split_whitespace() {
        let Ok(inspect) = engine
            .command()
            .current_dir(root)
            .args(["container", "inspect", id])
            .output()
        else {
            continue;
        };
        let inspected: serde_json::Value =
            serde_json::from_slice(&inspect.stdout).unwrap_or_default();
        for container in inspected.as_array().into_iter().flatten() {
            let name = container["Name"]
                .as_str()
                .unwrap_or_default()
                .trim_start_matches('/');
            if container["State"]["Running"].as_bool() == Some(true)
                && container["Config"]["Labels"]["com.docker.compose.project"].as_str()
                    == Some(project.as_str())
            {
                names.push(name.to_owned());
            }
        }
    }
    names
}

/// For reading only, where no engine is at hand to decide with: the recorded project, else the
/// name an earlier app's installation in this folder ran as. Never used to run Compose.
pub fn recorded_project(root: &Path) -> String {
    saved_project(root).unwrap_or_else(|| project_name(root))
}

/**
The published ports in a `compose ps` listing.

Pure, because the format is the contract and a regex over engine output is exactly the thing that
should be pinned by a test. A row reads `127.0.0.1:4206->4206/tcp, [::1]:4206->4206/tcp`, and it is
the number BEFORE the arrow that is taken: the one after it is the port inside the container, which
nothing on this machine binds.
*/
pub fn published_in(listing: &str) -> std::collections::HashSet<u16> {
    let mut ports = std::collections::HashSet::new();
    for mapping in listing.lines().flat_map(|row| row.split(',')) {
        let Some((host, _)) = mapping.split_once("->") else {
            continue;
        };
        let Some((_, port)) = host.trim().rsplit_once(':') else {
            continue;
        };
        if let Ok(port) = port.trim().parse::<u16>() {
            ports.insert(port);
        }
    }
    ports
}

/**
Wait for ports we just released to actually be free.

A KILL IS NOT INSTANT AND THE CHECK IS. Reclaiming this deployment's own host processes and then
immediately asking whether their ports are held is a race, and it loses: the socket is still closing
while the check reads it as somebody else's. Measured as "something is already listening on port
3010" naming a process that no longer existed by the time anybody looked.

Bounded, and only worth calling when something was actually stopped. A port a stranger holds stays
held, so this costs the wait once and then reports it.
*/
pub fn wait_for_ports_to_clear(ports: &[u16], patience: std::time::Duration) {
    let deadline = std::time::Instant::now() + patience;
    while std::time::Instant::now() < deadline {
        if ports.iter().all(|port| !something_answers(*port)) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

/// Whether anything accepts a connection on a loopback port right now.
fn something_answers(port: u16) -> bool {
    // A listener on either loopback can conflict, just as either can satisfy readiness below.
    [
        std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::net::SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)),
    ]
    .iter()
    .any(|address| {
        std::net::TcpStream::connect_timeout(address, std::time::Duration::from_millis(300)).is_ok()
    })
}

/// Refuse to start if something already holds a port this deployment needs.
///
/// Found the hard way: another deployment was listening on 3001, so the readiness check below was
/// satisfied by a server this shell had never started. Everything looked green and none of it was
/// ours. Checked before anything is spawned, because afterwards the two are indistinguishable from
/// outside.
pub fn port_already_taken(ports: &[(&'static str, u16)]) -> Option<String> {
    port_already_taken_except(ports, &std::collections::HashSet::new())
}

/// The same check, with the ports this deployment already publishes treated as its own.
pub fn port_already_taken_except(
    ports: &[(&'static str, u16)],
    ours: &std::collections::HashSet<u16>,
) -> Option<String> {
    for (name, port) in ports {
        if ours.contains(port) {
            continue;
        }
        if something_answers(*port) {
            return Some(format!(
                "Port {port} for the {name} became unavailable. Try Start again so OpenBot can choose another local port."
            ));
        }
    }
    None
}

/// The two addresses that have to answer before anybody is told the stack is up.
///
/// The API alone is not enough. The window navigates to the app, so a person told "running" who
/// then gets a blank window has been told something that is not true. Both are the one `server`
/// container now, published on two host ports, and either mapping can be the one that is missing.
pub struct Ready {
    pub api: u16,
    pub app: u16,
}

/// Both loopbacks, in the order a person is most likely to type.
///
/// A process that binds one and not the other is normal rather than broken: Node resolves
/// `localhost` to `::1` and bun to `127.0.0.1`, so which one a service ends up on depends on what
/// started it. Asking both is how a check stays true either way.
const LOOPBACKS: [&str; 2] = ["127.0.0.1", "[::1]"];

/// Where a port is answering, or `None`.
///
/// Returns the address that worked rather than a boolean, so a caller that has to send somebody
/// there can use the one that answered instead of guessing again.
pub fn answering_at(port: u16, path: &str) -> Option<String> {
    answering_within(port, path, std::time::Duration::from_secs(3))
}

/// [`answering_at`], giving each loopback at most `patience`.
pub fn answering_within(port: u16, path: &str, patience: std::time::Duration) -> Option<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(patience)
        .build()
        .ok()?;
    LOOPBACKS.iter().find_map(|host| {
        let base = format!("http://{host}:{port}");
        client
            .get(format!("{base}{path}"))
            .send()
            .ok()
            .filter(|response| response.status().is_success())
            .map(|_| base)
    })
}

/// Where the app is answering, for the window to be pointed at.
pub fn app_url(port: u16) -> Option<String> {
    answering_at(port, "/")
}

/// Wait until the server container answers its health check on both host ports, or say which
/// one never did.
///
/// `compose up` returns once it has asked for the container, not once the server inside it is
/// listening, and a server still running its first start leaves the port unanswered for the same
/// length of time as one that is crash-looping under its restart policy. Only an answer settles it.
///
/// `keep_going` is asked between polls, so a Stop pressed during the wait ends it there rather than
/// after the full patience. What a stopped wait returns does not matter: the caller asks its own
/// ticket first, and the cancellation is what it reports.
pub fn wait_until_healthy(
    ready: &Ready,
    patience: std::time::Duration,
    keep_going: impl Fn() -> bool,
) -> Result<(), String> {
    wait_until_healthy_saying(ready, patience, keep_going, &mut |line| {
        log::info!("{line}")
    })
}

/// [`wait_until_healthy`], with what it waited on and why it stopped said to `say`: each poll's
/// answer as it changes (the URL, and its status or the error), and the reason it ended. A wait
/// that gave up after minutes had left no line at all (see `logging::WaitLog`).
pub fn wait_until_healthy_saying(
    ready: &Ready,
    patience: std::time::Duration,
    keep_going: impl Fn() -> bool,
    say: &mut dyn FnMut(String),
) -> Result<(), String> {
    let started = std::time::Instant::now();
    let deadline = started + patience;
    let mut waited = crate::logging::WaitLog::new(
        format!(
            "OpenBot's services, GET /health on port {} (API) and port {} (app)",
            ready.api, ready.app
        ),
        started,
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|error| format!("could not ask OpenBot's services: {error}"))?;
    let mut api_up = false;

    while std::time::Instant::now() < deadline && keep_going() {
        // An earlier API success is no longer sufficient when the app becomes ready later.
        let api = health_answer(&client, ready.api, "/health");
        api_up = api.is_ok();
        let app = api_up.then(|| health_answer(&client, ready.app, "/health"));
        let answer = format!(
            "API {}; app {}",
            answer_said(&api),
            app.as_ref()
                .map_or("not asked until the API answers".to_string(), answer_said)
        );
        if let Some(line) = waited.answered(std::time::Instant::now(), &answer) {
            say(line);
        }
        if app.is_some_and(|app| app.is_ok()) {
            say(waited.ended(std::time::Instant::now(), "both answered"));
            return Ok(());
        }

        std::thread::sleep(std::time::Duration::from_millis(750));
    }

    let failed = if api_up {
        format!(
            "the API is answering, but the app is not answering on port {}.",
            ready.app
        )
    } else {
        format!("the API is not answering on port {}.", ready.api)
    };
    let why = if keep_going() {
        format!("gave up: {failed}")
    } else {
        "stopped by Stop or Quit".to_string()
    };
    say(waited.ended(std::time::Instant::now(), &why));
    Err(failed)
}

/// What `port` answered at `path` on either loopback: the address that answered, or what each
/// one said instead (its HTTP status, or the error that kept it from answering).
fn health_answer(
    client: &reqwest::blocking::Client,
    port: u16,
    path: &str,
) -> Result<String, String> {
    let mut said = Vec::new();
    for host in LOOPBACKS {
        let url = format!("http://{host}:{port}{path}");
        match client.get(&url).send() {
            Ok(response) if response.status().is_success() => {
                return Ok(format!("http://{host}:{port}"))
            }
            Ok(response) => said.push(format!("{url} answered {}", response.status())),
            Err(error) => said.push(format!("{url}: {}", deepest_cause(&error))),
        }
    }
    Err(said.join(", "))
}

fn answer_said(answer: &Result<String, String>) -> String {
    match answer {
        Ok(base) => format!("answering on {base}"),
        Err(said) => format!("not answering ({said})"),
    }
}

/// The innermost reason: reqwest's own message is "error sending request for url", and what
/// support needs is underneath it ("Connection refused", "operation timed out").
fn deepest_cause(error: &dyn std::error::Error) -> String {
    let mut cause = error;
    while let Some(source) = cause.source() {
        cause = source;
    }
    cause.to_string()
}

/// Keep a short startup headline and useful local diagnostics, with credentials removed.
pub fn startup_problem(problem: Problem, secrets: &Secrets) -> Problem {
    let database_reset = problem.database_reset;
    let mut detail = problem.said;
    if let Some(cleanup) = problem.detail {
        detail.push('\n');
        detail.push_str(&cleanup);
    }
    let mut credentials: Vec<_> = secrets
        .iter()
        .filter(|(key, value)| {
            !value.is_empty()
                && (crate::vault::is_secret(key) || key.as_str() == "OPENBOT_DESKTOP_HOST_TOKEN")
        })
        .collect();
    credentials.sort_by_key(|(_, value)| std::cmp::Reverse(value.len()));
    for (key, value) in credentials {
        detail = detail.replace(value, &format!("<{key}>"));
    }
    let mut problem = Problem::with(
        "OpenBot could not finish starting. Try Start again, or share the details below for help.",
        detail,
    );
    problem.database_reset = database_reset;
    problem
}

/// What a directory has to contain before it can be raised.
///
/// Checked and named rather than discovered by failing: without this the first symptom is
/// `os error 2` from writing `.env`, which says nothing about a missing deployment, and the second
/// is Compose reporting no configuration file. Both are the same fact and neither says it. The
/// containers run from their images, so the Compose file is the one part of the release on disk
/// they need.
pub fn deployment_problem(root: &Path) -> Option<String> {
    if !root.exists() {
        return Some(format!(
            "{} does not exist yet. OpenBot needs a copy of the deployment there before it can \
             start one.",
            root.display()
        ));
    }
    if !root.join("docker-compose.yml").exists() {
        return Some(format!(
            "{} is not an OpenBot deployment: it has no docker-compose.yml.",
            root.display()
        ));
    }
    None
}

/// Where the shell keeps the deployment it manages.
pub fn default_root() -> PathBuf {
    dirs_home().join("OpenBot")
}

/// The deployment directory somebody typed, as a path.
///
/// Trimmed, the way the four settings entered beside it on the same screen already are. That screen
/// enables Start on `root.trim() !== ""` and then sends the untrimmed string, so a path pasted with
/// the space the selection picked up, or with the newline a copied line carries, arrives here whole
/// -- and this is the one of the five values that is not a credential but a place on disk.
///
/// A trailing space makes a second directory beside the one everything else means: the tray's Stop
/// and the next launch both ask `default_root`, which has no space in it, so a person is left with
/// a deployment nothing on screen can reach. A leading one is worse, because a path that begins
/// with a space does not begin with a separator: it stops being absolute, and the whole deployment
/// is laid out relative to wherever the window happens to be running from.
///
/// Only the ends. A space inside a path is part of a directory's name and stays where it is.
pub fn root_from(typed: &str) -> PathBuf {
    PathBuf::from(typed.trim())
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// Called after all owned application writers stop. Bring up only the existing project's
/// Postgres service, create a custom-format dump, and validate its table of contents. The caller
/// retains Compose ownership and stops this service before the upgrade continues.
pub fn backup_runtime_database(
    engine: &Address,
    root: &Path,
    secrets: &Secrets,
    destination: &Path,
) -> Result<(), String> {
    start_runtime_database(engine, root, secrets)?;
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    let dump = compose_command(engine, root, secrets)
        .args([
            "exec",
            "-T",
            "postgres",
            "sh",
            "-c",
            "exec pg_dump --format=custom --username=\"$POSTGRES_USER\" \"$POSTGRES_DB\"",
        ])
        .stdout(Stdio::from(file.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    if !dump.status.success() {
        return Err(format!("pg_dump failed: {}", command_said(&dump.stderr)));
    }
    let dump_file = std::fs::File::open(destination).map_err(|e| e.to_string())?;
    if dump_file.metadata().map_err(|e| e.to_string())?.len() < 5 {
        return Err("database backup is empty".into());
    }
    let checked = compose_command(engine, root, secrets)
        .args(["exec", "-T", "postgres", "pg_restore", "--list"])
        .stdin(Stdio::from(dump_file))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    if !checked.status.success() {
        return Err(format!(
            "database archive validation failed: {}",
            command_said(&checked.stderr)
        ));
    }
    Ok(())
}

/// Bring up only the selected project's Postgres, with no dependency, build or pull. Backup and
/// recovery both work on the database alone while every application writer stays stopped.
pub fn start_runtime_database(
    engine: &Address,
    root: &Path,
    secrets: &Secrets,
) -> Result<(), String> {
    let status = compose_start_command(engine, root, secrets, std::env::consts::OS)
        .map_err(|p| p.said)?
        .args([
            "up",
            "-d",
            "--no-deps",
            "--no-build",
            "--pull",
            "never",
            "--wait",
            "--wait-timeout",
            "60",
            "postgres",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !status.status.success() {
        return Err(format!(
            "Postgres did not start on its own: {}",
            command_said(&status.stderr)
        ));
    }
    Ok(())
}

/// Return the database to the dump taken before an update, whoever else is connected to it.
///
/// The database is published on the host's loopback, so anything on this computer can hold
/// sessions open to it and reconnect the moment they are cut: a developer's OpenBot server left
/// running on the host was found holding twelve. `pg_restore --clean --create` issues a plain
/// `DROP DATABASE`, which any one of those sessions refuses. So, the standard way, and with no
/// moment where a client could connect to half a database:
///
/// 1. Stop every container of this installation's Compose project but Postgres, whether or not
///    this session started it (`stop_all_but_the_database`).
/// 2. Restore the dump into a scratch database nobody connects to, in one transaction. A dump that
///    does not restore leaves the database as it was.
/// 3. Refuse new connections to the database, end the ones it has, drop it (`WITH (FORCE)`), and
///    rename the scratch database into its place.
pub fn restore_runtime_database(
    engine: &Address,
    root: &Path,
    secrets: &Secrets,
    dump: &Path,
) -> Result<(), String> {
    let file = std::fs::File::open(dump)
        .map_err(|e| format!("the database backup {} cannot be read: {e}", dump.display()))?;
    stop_all_but_the_database(engine, root)?;
    let restored = compose_command(engine, root, secrets)
        .args(["exec", "-T", "postgres", "sh", "-c", RESTORE_SCRIPT])
        .stdin(Stdio::from(file))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    if !restored.status.success() {
        return Err(format!(
            "the database backup could not be restored: {}",
            command_said(&restored.stderr)
        ));
    }
    Ok(())
}

/// Run inside the Postgres container, with the dump on its standard input. See
/// `restore_runtime_database`. `ALLOW_CONNECTIONS false` keeps a client that reconnects at once
/// from getting back in between the sessions ending and the drop.
const RESTORE_SCRIPT: &str = r#"set -e
db="$POSTGRES_DB"
scratch="${POSTGRES_DB}_restore"
sql() { psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname=postgres -c "$1"; }
sql "DROP DATABASE IF EXISTS \"$scratch\" WITH (FORCE)"
sql "CREATE DATABASE \"$scratch\" TEMPLATE template0 OWNER \"$POSTGRES_USER\""
pg_restore --exit-on-error --single-transaction --username="$POSTGRES_USER" --dbname="$scratch"
if [ "$(psql --no-psqlrc -tA --username="$POSTGRES_USER" --dbname=postgres -c "SELECT 1 FROM pg_database WHERE datname = '$db'")" = 1 ]; then
  sql "ALTER DATABASE \"$db\" ALLOW_CONNECTIONS false"
  sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid()"
  sql "DROP DATABASE \"$db\" WITH (FORCE)"
fi
sql "ALTER DATABASE \"$scratch\" RENAME TO \"$db\""
"#;

/// Stop every running container of this installation's Compose project except Postgres: by the
/// project's label, so a container this session did not start, or one a service of another version
/// of the Compose file made, is stopped too. Stopped, not removed.
pub fn stop_all_but_the_database(engine: &Address, root: &Path) -> Result<(), String> {
    let project = project(engine, root).map_err(|problem| problem.said)?;
    let listed = |filters: &[String]| -> Result<Vec<String>, String> {
        let mut command = engine.command();
        command.args(["ps", "--quiet"]);
        for filter in filters {
            command.args(["--filter", filter]);
        }
        let output = command
            .output()
            .map_err(|error| format!("could not list this installation's containers: {error}"))?;
        if !output.status.success() {
            return Err(command_said(&output.stderr));
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .map(str::to_string)
            .collect())
    };
    let in_project = format!("label=com.docker.compose.project={project}");
    let database = listed(&[
        in_project.clone(),
        "label=com.docker.compose.service=postgres".into(),
    ])?;
    let others: Vec<String> = listed(&[in_project])?
        .into_iter()
        .filter(|id| !database.contains(id))
        .collect();
    if others.is_empty() {
        return Ok(());
    }
    let stopped = engine
        .command()
        .arg("stop")
        .args(&others)
        .output()
        .map_err(|error| format!("could not stop this installation's containers: {error}"))?;
    if !stopped.status.success() {
        return Err(format!(
            "could not stop this installation's containers: {}",
            command_said(&stopped.stderr)
        ));
    }
    Ok(())
}

/// One person's computer from before the personal edition, carried into the shared computer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CarriedOver {
    pub person: String,
    pub workspace: Option<String>,
    pub profile: Option<String>,
}

/**
Bring each person's Bots' files and browser logins from the computer the supervisor made for them
into the one computer the personal edition shares, once.

WHY. Before the personal edition, OpenBot Desktop ran a supervisor that gave each person a computer of
their own, with two volumes: `<namespace>-workspace-person-<person>`, where each Bot's files are in
`computers/<bot>`, and `<namespace>-profile-person-<person>`, where each Bot's browser profile, its
logins, is `<bot>`. The personal edition runs no supervisor: every Bot is on the Compose
`agent-computer` service, whose volumes keep a Bot's files in `computers/<person>~<bot>` and its
profile in `<person>~<bot>` (agent-computer's `seatIdFor`). An installation that moved to it found
its Bots with no files and signed out of everything. Nothing was lost; it was in the old volumes.

WHAT. The supervisor's own carry-over (`supervisor/src/docker.ts`, `carryOverProfile`) is the rule:
copied, never moved, and the old volumes are left exactly as they are; a profile the shared computer
already has for that Bot wins, whole, because two Chromium profiles cannot be merged; and the copy is
done by a short-lived container that mounts the volumes, Docker's own way to copy between volumes,
from an image already on the machine (`image`, the computer's), with no network and only the
capabilities that keep owners and modes. Files are merged into a Bot's folder rather than refused
when it exists, because a Bot that already ran on the shared computer has a folder there, and its
old files are no less its own: nothing that is there is replaced.

ONCE. Recorded in each destination volume (`.openbot-carried-over/<old volume>`), which outlives
this app and any reinstall, as the supervisor records its own. A run that fails records nothing, so
the next Start tries again.

Only volumes the supervisor made for a person, in this installation's namespace, by their labels:
nothing is read out of a volume this installation does not own. Run after the Compose `up`, so the
shared computer's volumes are the ones Compose made.
*/
pub fn carry_over_person_computers(
    engine: &Address,
    root: &Path,
    image: &str,
) -> Result<Vec<CarriedOver>, String> {
    let Some(namespace) = computer_namespace(engine, root)? else {
        return Ok(Vec::new());
    };
    let listed = engine
        .command()
        .args([
            "volume",
            "ls",
            "--quiet",
            "--filter",
            SUPERVISOR_FILTER,
            "--filter",
            &format!("label=openbot.namespace={namespace}"),
            "--filter",
            "label=openbot.computer-kind=person",
        ])
        .output()
        .map_err(|error| format!("could not list the computers from before: {error}"))?;
    if !listed.status.success() {
        return Err(command_said(&listed.stderr));
    }
    let volumes: Vec<String> = String::from_utf8_lossy(&listed.stdout)
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let mut people = std::collections::BTreeMap::<String, (Option<String>, Option<String>)>::new();
    for volume in volumes {
        for (prefix, profile) in [
            (format!("{namespace}-workspace-person-"), false),
            (format!("{namespace}-profile-person-"), true),
        ] {
            let Some(person) = volume.strip_prefix(&prefix) else {
                continue;
            };
            // A plain id only, as the supervisor made it: it becomes a path.
            if !plain_id(person) {
                continue;
            }
            let entry = people.entry(person.to_string()).or_default();
            if profile {
                entry.1 = Some(volume.clone());
            } else {
                entry.0 = Some(volume.clone());
            }
        }
    }
    if people.is_empty() {
        return Ok(Vec::new());
    }
    let (workspace, profiles) = shared_computer_volumes(engine, root)?;
    // A person's computer from before still running is stopped first, as the supervisor does, so
    // Chromium has flushed its profile and nothing writes to the volumes while they are read. The
    // personal edition never starts one again.
    let running = engine
        .command()
        .args([
            "ps",
            "--quiet",
            "--filter",
            SUPERVISOR_FILTER,
            "--filter",
            &format!("label=openbot.namespace={namespace}"),
            "--filter",
            "label=openbot.computer-kind=person",
        ])
        .output()
        .map_err(|error| format!("could not list the computers from before: {error}"))?;
    let running: Vec<String> = String::from_utf8_lossy(&running.stdout)
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if !running.is_empty() {
        let stopped = engine
            .command()
            .args(["stop", "--time", "30"])
            .args(&running)
            .output()
            .map_err(|error| format!("could not stop the computers from before: {error}"))?;
        if !stopped.status.success() {
            return Err(format!(
                "could not stop the computers from before: {}",
                command_said(&stopped.stderr)
            ));
        }
    }
    let mut carried = Vec::new();
    for (person, (old_workspace, old_profile)) in people {
        let mut command = engine.command();
        command.args([
            "run",
            "--rm",
            "--network",
            "none",
            "--security-opt",
            "no-new-privileges:true",
            "--cap-drop",
            "ALL",
            "--cap-add",
            "CHOWN",
            "--cap-add",
            "DAC_OVERRIDE",
            "--cap-add",
            "FOWNER",
            "--label",
            "openbot.carry-over=person",
            "--entrypoint",
            "sh",
            "--env",
            &format!("PERSON={person}"),
            "--volume",
            &format!("{workspace}:/workspace"),
            "--volume",
            &format!("{profiles}:/profiles"),
        ]);
        if let Some(volume) = &old_workspace {
            command
                .args(["--volume", &format!("{volume}:/from-workspace:ro")])
                .args(["--env", &format!("FROM_WORKSPACE={volume}")]);
        }
        if let Some(volume) = &old_profile {
            command
                .args(["--volume", &format!("{volume}:/from-profiles:ro")])
                .args(["--env", &format!("FROM_PROFILES={volume}")]);
        }
        let output = command
            .args([image, "-c", CARRY_OVER_SCRIPT])
            .output()
            .map_err(|error| format!("could not run the copy for {person}: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "copying {person}'s computer from before failed: {}",
                command_said(&output.stderr)
            ));
        }
        let said = String::from_utf8_lossy(&output.stdout);
        let outcome = |what: &str| {
            said.lines()
                .find_map(|line| line.strip_prefix(&format!("{what}=")))
                .map(str::to_string)
        };
        carried.push(CarriedOver {
            person,
            workspace: outcome("workspace"),
            profile: outcome("profiles"),
        });
    }
    Ok(carried)
}

/// The volumes the shared computer (the Compose `agent-computer` service) keeps `/workspace` and
/// `/profiles` on, read from its container, so whatever named them (an override file, a project
/// name) is answered for.
fn shared_computer_volumes(engine: &Address, root: &Path) -> Result<(String, String), String> {
    let listed = compose_command(engine, root, &Secrets::new())
        .args(["ps", "--all", "--quiet", "agent-computer"])
        .output()
        .map_err(|error| format!("could not find the shared computer: {error}"))?;
    if !listed.status.success() {
        return Err(command_said(&listed.stderr));
    }
    let id = String::from_utf8_lossy(&listed.stdout)
        .split_whitespace()
        .next()
        .map(str::to_string)
        .ok_or("the shared computer has not been created")?;
    let inspected = engine
        .command()
        .args(["inspect", "--format", "{{json .Mounts}}", &id])
        .output()
        .map_err(|error| format!("could not read the shared computer's volumes: {error}"))?;
    if !inspected.status.success() {
        return Err(command_said(&inspected.stderr));
    }
    let mounts: Vec<serde_json::Value> =
        serde_json::from_slice(&inspected.stdout).map_err(|error| error.to_string())?;
    let volume = |destination: &str| {
        mounts
            .iter()
            .find(|mount| mount["Destination"] == destination && mount["Type"] == "volume")
            .and_then(|mount| mount["Name"].as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("the shared computer keeps {destination} on no volume"))
    };
    Ok((volume("/workspace")?, volume("/profiles")?))
}

/// What the supervisor allowed a person or Bot id to be, which is what keeps it one path segment.
fn plain_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.starts_with(|c: char| c.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Run by `carry_over_person_computers` in its helper container. `tar` carries owners, modes and
/// times (`-p`, and as root, owners), and `--skip-old-files` never replaces a file that is there.
/// A profile is staged under a dot-name, which is not a seat, and moved into place whole. Prints
/// `workspace=` and `profiles=` with what it did: `copied`, `done` (an earlier run did it) or nothing
/// for a volume the person did not have.
const CARRY_OVER_SCRIPT: &str = r#"set -eu
plain() { case "$1" in ""|.*|*[!A-Za-z0-9_-]*) return 1 ;; *) return 0 ;; esac; }
copy() {
  if [ -e "$2" ]; then tar -C "$1" -cf - . | tar -C "$2" -xpf - --skip-old-files
  else mkdir -p "$2" && tar -C "$1" -cf - . | tar -C "$2" -xpf -; fi
}
if [ -n "${FROM_WORKSPACE:-}" ]; then
  mark="/workspace/.openbot-carried-over/$FROM_WORKSPACE"
  if [ -e "$mark" ]; then echo workspace=done; else
    if [ -d /from-workspace/computers ]; then
      for dir in /from-workspace/computers/*; do
        bot=$(basename "$dir")
        [ -d "$dir" ] && plain "$bot" || continue
        copy "$dir" "/workspace/computers/$PERSON~$bot"
      done
    fi
    mkdir -p /workspace/.openbot-carried-over && touch "$mark"
    echo workspace=copied
  fi
fi
if [ -n "${FROM_PROFILES:-}" ]; then
  mark="/profiles/.openbot-carried-over/$FROM_PROFILES"
  if [ -e "$mark" ]; then echo profiles=done; else
    for dir in /from-profiles/*; do
      bot=$(basename "$dir")
      [ -d "$dir" ] && plain "$bot" || continue
      dest="/profiles/$PERSON~$bot"
      [ -e "$dest" ] && continue
      staging="/profiles/.openbot-carrying-$PERSON~$bot"
      rm -rf "$staging"
      copy "$dir" "$staging"
      mv "$staging" "$dest"
    done
    mkdir -p /profiles/.openbot-carried-over && touch "$mark"
    echo profiles=copied
  fi
fi
"#;

#[cfg(test)]
mod tests {
    use super::*;

    use crate::test_support::temp_root;

    #[test]
    fn startup_problem_keeps_build_and_cleanup_details_but_removes_credentials() {
        let secrets = Secrets::from([
            ("OPENAI_API_KEY".into(), "synthetic+key.long".into()),
            (
                "OPENBOT_DESKTOP_HOST_TOKEN".into(),
                "synthetic-host-token".into(),
            ),
            ("APP_PORT".into(), "4567".into()),
        ]);
        let mut original = Problem::with(
            "app stopped: Could not resolve imported module; key=synthetic+key.long",
            "cleanup failed: port 4567 token=synthetic-host-token",
        );
        original.database_reset = Some("openbot_postgres-data".into());
        let problem = startup_problem(original, &secrets);
        assert_eq!(
            problem.database_reset.as_deref(),
            Some("openbot_postgres-data")
        );
        assert!(problem.said.len() < 120);
        assert!(!problem.said.contains("Could not resolve"));
        let detail = problem.detail.unwrap();
        assert!(detail.contains("Could not resolve imported module"));
        assert!(detail.contains("cleanup failed: port 4567"));
        assert!(detail.contains("<OPENAI_API_KEY>"));
        assert!(detail.contains("<OPENBOT_DESKTOP_HOST_TOKEN>"));
        assert!(!detail.contains("synthetic+key.long"));
        assert!(!detail.contains("synthetic-host-token"));
    }

    fn postgres_config_fixture(name: &str) -> serde_json::Value {
        serde_json::json!({
            "services": {"postgres": {"volumes": [{
                "type": "volume", "source": "postgres-data", "target": "/var/lib/postgresql/data"
            }]}},
            "volumes": {"postgres-data": {"name": name}}
        })
    }

    #[test]
    fn postgres_volume_uses_resolved_names_and_the_mount_containing_pgdata() {
        for name in ["openbot_postgres-data", "explicit-external-database"] {
            let mut config = postgres_config_fixture(name);
            config["services"]["postgres"]["environment"] =
                serde_json::json!({"PGDATA": "/var/lib/postgresql/data/pgdata"});
            assert_eq!(
                postgres_volume_name(config.to_string().as_bytes()).unwrap(),
                name
            );
        }
        let mut config = postgres_config_fixture("outer-volume");
        config["services"]["postgres"]["environment"] =
            serde_json::json!({"PGDATA": "/var/lib/postgresql/data/nested"});
        config["services"]["postgres"]["volumes"].as_array_mut().unwrap().push(
            serde_json::json!({"type":"volume", "source":"inner", "target":"/var/lib/postgresql/data/nested"})
        );
        config["volumes"]["inner"] = serde_json::json!({"name":"actual-data-volume"});
        assert_eq!(
            postgres_volume_name(config.to_string().as_bytes()).unwrap(),
            "actual-data-volume"
        );
    }

    #[test]
    fn postgres_volume_refuses_unresolved_or_non_volume_storage_without_disclosing_config() {
        let mut config = postgres_config_fixture("selected-volume");
        config["services"]["postgres"]["environment"] =
            serde_json::json!({"SECRET": "synthetic-secret-must-not-appear-in-diagnostics"});
        config["services"]["postgres"]["volumes"][0]["type"] = "bind".into();
        let mut missing_name = postgres_config_fixture("selected-volume");
        missing_name["volumes"] = serde_json::json!({});
        for content in [
            config.to_string(),
            missing_name.to_string(),
            "{}".into(),
            "invalid-json-secret".into(),
        ] {
            let error = postgres_volume_name(content.as_bytes()).unwrap_err();
            assert!(
                error.said.contains("so it changed nothing"),
                "{}",
                error.said
            );
            assert!(!format!("{error:?}").contains("secret"));
        }
    }

    #[test]
    fn postgres_volume_inventory_uses_selected_engine_exact_names_and_fails_closed() {
        if crate::test_support::isolated_process(
            "stack::tests::postgres_volume_inventory_uses_selected_engine_exact_names_and_fails_closed",
        ) { return; }
        let path = PathFixture::with_fake_engine("postgres-volume");
        for address in computer_stop_addresses(&path) {
            let root = path
                .bin
                .join(format!("{}-deployment", address.engine.binary()));
            std::fs::create_dir(&root).unwrap();
            project_decided(&root);
            let record = root.join("commands.log");
            std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
            std::fs::write(
                root.join(".fixture-config"),
                postgres_config_fixture("selected-db").to_string(),
            )
            .unwrap();
            std::fs::write(
                root.join(".fixture-volumes"),
                "other-db\nselected-db-backup\n",
            )
            .unwrap();
            assert!(!postgres_volume_exists(&address, &root, &Secrets::new()).unwrap());
            std::fs::write(root.join(".fixture-volumes"), "other-db\nselected-db\n").unwrap();
            assert!(postgres_volume_exists(&address, &root, &Secrets::new()).unwrap());
            for failure in [".fixture-volume-failure", ".fixture-config-failure"] {
                std::fs::write(root.join(failure), "").unwrap();
                let error = postgres_volume_exists(&address, &root, &Secrets::new()).unwrap_err();
                assert!(
                    error.said.contains("so it changed nothing"),
                    "{}",
                    error.said
                );
                assert!(!format!("{error:?}").contains("synthetic-secret"));
                std::fs::remove_file(root.join(failure)).unwrap();
            }
            let log = std::fs::read_to_string(record).unwrap();
            for line in log.lines() {
                let (cwd, command) = line.split_once('\t').unwrap();
                assert_eq!(
                    Path::new(cwd).canonicalize().unwrap(),
                    root.canonicalize().unwrap()
                );
                let command = if address.engine == crate::engine::Engine::Podman {
                    command
                        .strip_prefix("--connection fixture-machine ")
                        .expect("retain selected Podman connection")
                } else {
                    command
                };
                assert!(matches!(
                    command,
                    "compose config --format json" | "volume ls --format {{.Name}}"
                ));
            }
        }
    }

    fn leftover_database_fixture(root: &Path) -> serde_json::Value {
        let mut config = postgres_config_fixture("openbot_postgres-data");
        config["name"] = "openbot".into();
        std::fs::write(root.join(".fixture-config"), config.to_string()).unwrap();
        std::fs::write(
            root.join(".fixture-volumes"),
            "unrelated\nopenbot_postgres-data\n",
        )
        .unwrap();
        std::fs::write(root.join(".fixture-inspect"), serde_json::json!([{
            "Name": "openbot_postgres-data", "Driver": "local", "Options": {},
            "Labels": {"com.docker.compose.project":"openbot", "com.docker.compose.volume":"postgres-data"}
        }]).to_string()).unwrap();
        config
    }

    #[test]
    fn leftover_database_reset_uses_only_confirmed_compose_owned_volume() {
        if crate::test_support::isolated_process(
            "stack::tests::leftover_database_reset_uses_only_confirmed_compose_owned_volume",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("postgres-volume");
        for address in computer_stop_addresses(&path) {
            let root = path.bin.join(format!("{}-reset", address.engine.binary()));
            std::fs::create_dir(&root).unwrap();
            let record = root.join("commands.log");
            std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
            leftover_database_fixture(&root);
            assert_eq!(
                leftover_database_volume(&address, &root, &Secrets::new()).unwrap(),
                Some("openbot_postgres-data".into())
            );
            assert!(reset_leftover_volumes(
                &address,
                &root,
                &Secrets::new(),
                &["unrelated".into()],
                &[]
            )
            .is_err());
            assert!(!std::fs::read_to_string(&record)
                .unwrap()
                .contains("volume rm"));
            reset_leftover_volumes(
                &address,
                &root,
                &Secrets::new(),
                &["openbot_postgres-data".into()],
                &[],
            )
            .unwrap();
            assert_eq!(
                std::fs::read_to_string(root.join(".fixture-volumes")).unwrap(),
                "unrelated\n"
            );
            let log = std::fs::read_to_string(&record).unwrap();
            let removals: Vec<_> = log
                .lines()
                .filter(|line| line.contains("volume rm"))
                .collect();
            assert_eq!(removals.len(), 1);
            assert!(removals[0].ends_with("volume rm openbot_postgres-data"));
            assert!(!log.contains("--force") && !log.contains("prune") && !log.contains("down"));
            if address.engine == crate::engine::Engine::Podman {
                assert!(log.lines().all(|line| line
                    .split_once('\t')
                    .unwrap()
                    .1
                    .starts_with("--connection fixture-machine ")));
            }
        }
    }

    #[test]
    fn leftover_database_reset_refuses_shared_unowned_changed_or_attached_volumes() {
        if crate::test_support::isolated_process(
            "stack::tests::leftover_database_reset_refuses_shared_unowned_changed_or_attached_volumes",
        ) { return; }
        let path = PathFixture::with_fake_engine("postgres-volume");
        let address = computer_stop_addresses(&path)[1].clone();
        let root = path.bin.join("reset-refusals");
        std::fs::create_dir(&root).unwrap();
        let record = root.join("commands.log");
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        for scenario in [
            "external",
            "custom-name",
            "driver",
            "driver-options",
            "shared-service",
            "shared-alias",
            "foreign-label",
            "missing-label",
            "prefix-inspect",
            "missing",
            "config-failure",
            "inventory-failure",
            "inspect-failure",
            "attached",
        ] {
            let mut config = leftover_database_fixture(&root);
            std::fs::write(&record, "").unwrap();
            let marker = match scenario {
                "external" => {
                    config["volumes"]["postgres-data"]["external"] = true.into();
                    None
                }
                "custom-name" => {
                    config["volumes"]["postgres-data"]["name"] = "shared-database".into();
                    None
                }
                "driver" => {
                    config["volumes"]["postgres-data"]["driver"] = "nfs".into();
                    None
                }
                "driver-options" => {
                    config["volumes"]["postgres-data"]["driver_opts"] =
                        serde_json::json!({"device":"/shared"});
                    None
                }
                "shared-service" => {
                    config["services"]["other"] = config["services"]["postgres"].clone();
                    None
                }
                "shared-alias" => {
                    config["services"]["other"] = config["services"]["postgres"].clone();
                    config["services"]["other"]["volumes"][0]["source"] = "backup-alias".into();
                    config["volumes"]["backup-alias"] =
                        serde_json::json!({"name": "openbot_postgres-data"});
                    None
                }
                "foreign-label" | "missing-label" | "prefix-inspect" => {
                    let mut inspect: serde_json::Value = serde_json::from_str(
                        &std::fs::read_to_string(root.join(".fixture-inspect")).unwrap(),
                    )
                    .unwrap();
                    if scenario == "foreign-label" {
                        inspect[0]["Labels"]["com.docker.compose.project"] =
                            "another-project".into();
                    }
                    if scenario == "missing-label" {
                        inspect[0]["Labels"] = serde_json::json!({});
                    }
                    if scenario == "prefix-inspect" {
                        inspect[0]["Name"] = "openbot_postgres-data-backup".into();
                    }
                    std::fs::write(root.join(".fixture-inspect"), inspect.to_string()).unwrap();
                    None
                }
                "missing" => {
                    std::fs::write(root.join(".fixture-volumes"), "unrelated\n").unwrap();
                    None
                }
                "config-failure" => Some(".fixture-config-failure"),
                "inventory-failure" => Some(".fixture-volume-failure"),
                "inspect-failure" => Some(".fixture-inspect-failure"),
                "attached" => Some(".fixture-attached"),
                _ => unreachable!(),
            };
            std::fs::write(root.join(".fixture-config"), config.to_string()).unwrap();
            if let Some(marker) = marker {
                std::fs::write(root.join(marker), "").unwrap();
            }
            let error = reset_leftover_volumes(
                &address,
                &root,
                &Secrets::new(),
                &["openbot_postgres-data".into()],
                &[],
            )
            .expect_err(scenario);
            assert!(
                !format!("{error:?}").contains("synthetic-secret"),
                "{scenario}"
            );
            let log = std::fs::read_to_string(&record).unwrap();
            assert_eq!(
                log.contains("volume rm"),
                scenario == "attached",
                "{scenario}: {log}"
            );
            assert!(!log.contains("--force"));
            assert!(std::fs::read_to_string(root.join(".fixture-volumes"))
                .unwrap()
                .contains("unrelated"));
            if scenario == "attached" {
                assert!(std::fs::read_to_string(root.join(".fixture-volumes"))
                    .unwrap()
                    .contains("openbot_postgres-data"));
            }
            if let Some(marker) = marker {
                std::fs::remove_file(root.join(marker)).unwrap();
            }
        }
    }

    /// A reinstall's Compose project and supervisor volumes, beside look-alikes it does not own.
    fn leftover_volumes_fixture(root: &Path, namespace: &str) {
        let config = serde_json::json!({
            "name": "openbot",
            "services": {
                "postgres": {"volumes": [{
                    "type": "volume", "source": "postgres-data", "target": "/var/lib/postgresql/data"
                }]},
                "supervisor": {"environment": {"COMPUTER_NAMESPACE": namespace}},
                "agent-computer": {"volumes": [
                    {"type": "volume", "source": "agent-profiles", "target": "/profiles"},
                    {"type": "volume", "source": "agent-workspace", "target": "/workspace"}
                ]}
            },
            "volumes": {
                "postgres-data": {"name": "openbot_postgres-data"},
                "agent-profiles": {"name": "openbot_agent-profiles"},
                "agent-workspace": {"name": "openbot_agent-workspace"},
                "spire-server-data": {"name": "openbot_spire-server-data"},
                "unlabeled": {"name": "openbot_unlabeled"},
                "foreign": {"name": "openbot_foreign"},
                "shared-cache": {"name": "shared-cache", "external": true},
                "explicit": {"name": "explicitly-named"},
                "remote": {"name": "openbot_remote", "driver_opts": {"device": "/shared"}}
            }
        });
        std::fs::write(root.join(".fixture-config"), config.to_string()).unwrap();
        std::fs::write(
            root.join(".fixture-volumes"),
            [
                "unrelated",
                "openbot_agent-profiles",
                "openbot_agent-workspace",
                "openbot_unlabeled",
                "openbot_foreign",
                "shared-cache",
                "explicitly-named",
                "openbot_remote",
                "openbot-profile-general-assistant",
                "openbot-workspace-general-assistant",
                "openbot-profile-unlabeled",
                "openbot-workspace-elsewhere",
                "openbot-profile-legacy",
                "other-profile-knowledge",
            ]
            .map(|name| format!("{name}\n"))
            .concat(),
        )
        .unwrap();
        let inspect = |name: &str, labels: serde_json::Value| {
            std::fs::write(
                root.join(format!(".fixture-inspect-{name}")),
                serde_json::json!([{
                    "Name": name, "Driver": "local", "Options": {}, "Labels": labels
                }])
                .to_string(),
            )
            .unwrap();
        };
        let compose = |project: &str, source: &str| {
            serde_json::json!({
                "com.docker.compose.project": project, "com.docker.compose.volume": source
            })
        };
        let supervisor = |bot: &str, namespace: &str| {
            serde_json::json!({
                "openbot.supervisor": "true", "openbot.bot-id": bot, "openbot.namespace": namespace
            })
        };
        inspect(
            "openbot_agent-profiles",
            compose("openbot", "agent-profiles"),
        );
        inspect(
            "openbot_agent-workspace",
            compose("openbot", "agent-workspace"),
        );
        inspect("openbot_unlabeled", serde_json::json!({}));
        inspect("openbot_foreign", compose("another-project", "foreign"));
        inspect(
            "openbot-profile-general-assistant",
            supervisor("general-assistant", "openbot"),
        );
        inspect(
            "openbot-workspace-general-assistant",
            supervisor("general-assistant", "openbot"),
        );
        inspect("openbot-profile-unlabeled", serde_json::json!({}));
        inspect(
            "openbot-workspace-elsewhere",
            supervisor("elsewhere", "other"),
        );
        inspect(
            "openbot-profile-legacy",
            serde_json::json!({"openbot.supervisor": "true", "openbot.bot-id": "legacy"}),
        );
        inspect("other-profile-knowledge", supervisor("knowledge", "other"));
    }

    const OWNED_LEFTOVERS: [&str; 4] = [
        "openbot-profile-general-assistant",
        "openbot-workspace-general-assistant",
        "openbot_agent-profiles",
        "openbot_agent-workspace",
    ];

    #[test]
    fn leftover_volumes_are_only_volumes_this_project_or_namespace_provably_owns() {
        if crate::test_support::isolated_process(
            "stack::tests::leftover_volumes_are_only_volumes_this_project_or_namespace_provably_owns",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("postgres-volume");
        let address = computer_stop_addresses(&path)[0].clone();
        let root = path.bin.join("leftover-volumes");
        std::fs::create_dir(&root).unwrap();
        let record = root.join("commands.log");
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);

        leftover_volumes_fixture(&root, "openbot");
        let found = leftover_volumes(&address, &root, &Secrets::new()).unwrap();
        assert_eq!(found.volumes, OWNED_LEFTOVERS.map(String::from));
        assert_eq!(found.database, None);
        assert!(!found.database_exists);
        assert!(found.resettable());
        let log = std::fs::read_to_string(&record).unwrap();
        for never_inspected in ["shared-cache", "explicitly-named", "openbot_remote"] {
            assert!(
                !log.contains(&format!("volume inspect {never_inspected}")),
                "{never_inspected}: {log}"
            );
        }
        assert!(!log.contains("volume rm"));

        // Another deployment's namespace selects only that namespace's Bots.
        leftover_volumes_fixture(&root, "other");
        assert_eq!(
            leftover_volumes(&address, &root, &Secrets::new())
                .unwrap()
                .volumes,
            [
                "openbot_agent-profiles",
                "openbot_agent-workspace",
                "other-profile-knowledge"
            ]
        );

        // The database joins the set when it is verified, and blocks the offer when it is not.
        leftover_volumes_fixture(&root, "openbot");
        let mut inventory = std::fs::read_to_string(root.join(".fixture-volumes")).unwrap();
        inventory.push_str("openbot_postgres-data\n");
        std::fs::write(root.join(".fixture-volumes"), inventory).unwrap();
        let database = serde_json::json!([{
            "Name": "openbot_postgres-data", "Driver": "local", "Options": {},
            "Labels": {"com.docker.compose.project":"openbot", "com.docker.compose.volume":"postgres-data"}
        }]);
        std::fs::write(root.join(".fixture-inspect"), database.to_string()).unwrap();
        let found = leftover_volumes(&address, &root, &Secrets::new()).unwrap();
        assert_eq!(found.database.as_deref(), Some("openbot_postgres-data"));
        assert!(found.database_exists && found.resettable());
        let mut expected = OWNED_LEFTOVERS.map(String::from).to_vec();
        expected.push("openbot_postgres-data".into());
        expected.sort();
        assert_eq!(found.volumes, expected);

        let mut foreign = database.clone();
        foreign[0]["Labels"]["com.docker.compose.project"] = "another-project".into();
        std::fs::write(root.join(".fixture-inspect"), foreign.to_string()).unwrap();
        let found = leftover_volumes(&address, &root, &Secrets::new()).unwrap();
        assert_eq!(found.database, None);
        assert!(found.database_exists);
        assert_eq!(found.volumes, OWNED_LEFTOVERS.map(String::from));
        assert!(
            !found.resettable(),
            "an unverified database must not be left behind by a reset"
        );
        std::fs::write(record, "").unwrap();
        assert!(reset_leftover_volumes(
            &address,
            &root,
            &Secrets::new(),
            &OWNED_LEFTOVERS.map(String::from),
            &[]
        )
        .is_err());
        assert!(!std::fs::read_to_string(root.join("commands.log"))
            .unwrap()
            .contains("volume rm"));
    }

    #[test]
    fn leftover_volume_reset_removes_exactly_the_confirmed_owned_set() {
        if crate::test_support::isolated_process(
            "stack::tests::leftover_volume_reset_removes_exactly_the_confirmed_owned_set",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("postgres-volume");
        for address in computer_stop_addresses(&path) {
            let root = path
                .bin
                .join(format!("{}-leftover-reset", address.engine.binary()));
            std::fs::create_dir(&root).unwrap();
            let record = root.join("commands.log");
            std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
            leftover_volumes_fixture(&root, "openbot");
            let owned = OWNED_LEFTOVERS.map(String::from).to_vec();
            let mut duplicated = owned.clone();
            duplicated.push(owned[0].clone());
            let mut superset = owned.clone();
            superset.push("other-profile-knowledge".into());
            for stale in [
                owned[..3].to_vec(),
                superset,
                duplicated,
                vec!["unrelated".into()],
                Vec::new(),
            ] {
                let error = reset_leftover_volumes(&address, &root, &Secrets::new(), &stale, &[])
                    .expect_err("a changed set must not be removed");
                assert!(
                    error.said.to_lowercase().contains("nothing was removed"),
                    "{}",
                    error.said
                );
                assert!(!std::fs::read_to_string(&record)
                    .unwrap_or_default()
                    .contains("volume rm"));
            }

            // The engine refuses a volume a container still uses; nothing is forced.
            std::fs::write(
                root.join(".fixture-attached-openbot-profile-general-assistant"),
                "",
            )
            .unwrap();
            let error = reset_leftover_volumes(&address, &root, &Secrets::new(), &owned, &[])
                .expect_err("an attached volume is refused");
            assert!(
                error.said.contains("openbot-profile-general-assistant"),
                "{}",
                error.said
            );
            assert!(
                error.said.to_lowercase().contains("nothing was removed"),
                "{}",
                error.said
            );
            assert!(!format!("{error:?}").contains("synthetic-secret"));
            std::fs::remove_file(root.join(".fixture-attached-openbot-profile-general-assistant"))
                .unwrap();

            let mut reordered = owned.clone();
            reordered.reverse();
            reset_leftover_volumes(&address, &root, &Secrets::new(), &reordered, &[]).unwrap();
            let remaining = std::fs::read_to_string(root.join(".fixture-volumes")).unwrap();
            for name in &owned {
                assert!(!remaining.lines().any(|line| line == name), "{name}");
            }
            for kept in [
                "unrelated",
                "openbot_unlabeled",
                "openbot_foreign",
                "shared-cache",
                "explicitly-named",
                "openbot_remote",
                "openbot-profile-unlabeled",
                "openbot-workspace-elsewhere",
                "openbot-profile-legacy",
                "other-profile-knowledge",
            ] {
                assert!(remaining.lines().any(|line| line == kept), "{kept}");
            }
            let log = std::fs::read_to_string(&record).unwrap();
            let removals: Vec<_> = log
                .lines()
                .filter_map(|line| line.split_once("volume rm "))
                .map(|(_, name)| name)
                .collect();
            // One refused attempt, then each confirmed volume once.
            assert_eq!(removals[0], "openbot-profile-general-assistant");
            assert_eq!(removals[1..], OWNED_LEFTOVERS);
            assert!(!log.contains("--force") && !log.contains("prune") && !log.contains("down"));
            if address.engine == crate::engine::Engine::Podman {
                assert!(log.lines().all(|line| line
                    .split_once('\t')
                    .unwrap()
                    .1
                    .starts_with("--connection fixture-machine ")));
            }
        }
    }

    /// The previous installation's stopped computers and Compose containers, beside ones it
    /// does not own. Each still mounts the volumes it used, as a real engine reports it.
    fn leftover_containers_fixture(root: &Path, computer_status: &str) {
        let supervisor = |bot: &str, namespace: &str| {
            format!("openbot.supervisor=true,openbot.bot-id={bot},openbot.namespace={namespace}")
        };
        let lines = [
            format!(
                "c-computer\topenbot-computer-general-assistant\t{computer_status}\t{}\topenbot-profile-general-assistant,openbot-workspace-general-assistant",
                supervisor("general-assistant", "openbot")
            ),
            "c-compose\topenbot-agent-computer-1\texited\tcom.docker.compose.project=openbot,com.docker.compose.service=agent-computer\topenbot_agent-profiles,openbot_agent-workspace".into(),
            format!("c-other-namespace\tother-computer-knowledge\texited\t{}\tother-profile-knowledge", supervisor("knowledge", "other")),
            "c-unlabeled\topenbot-computer-unlabeled\texited\t\topenbot-profile-unlabeled".into(),
            "c-other-project\tanother-project-postgres-1\texited\tcom.docker.compose.project=another-project\t".into(),
            format!("c-renamed\topenbot-computer-not-this-bot\texited\t{}\t", supervisor("general-assistant", "openbot")),
            "c-legacy\topenbot-computer-legacy\texited\topenbot.supervisor=true,openbot.bot-id=legacy\topenbot-profile-legacy".into(),
        ];
        std::fs::write(
            root.join(".fixture-containers"),
            lines.map(|line| format!("{line}\n")).concat(),
        )
        .unwrap();
    }

    const OWNED_CONTAINERS: [&str; 2] = [
        "openbot-agent-computer-1",
        "openbot-computer-general-assistant",
    ];

    #[test]
    fn leftover_reset_removes_stopped_owned_containers_before_their_volumes() {
        if crate::test_support::isolated_process(
            "stack::tests::leftover_reset_removes_stopped_owned_containers_before_their_volumes",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("postgres-volume");
        for address in computer_stop_addresses(&path) {
            let root = path
                .bin
                .join(format!("{}-leftover-containers", address.engine.binary()));
            std::fs::create_dir(&root).unwrap();
            let record = root.join("commands.log");
            std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
            leftover_volumes_fixture(&root, "openbot");
            leftover_containers_fixture(&root, "exited");

            let found = leftover_volumes(&address, &root, &Secrets::new()).unwrap();
            assert_eq!(found.volumes, OWNED_LEFTOVERS.map(String::from));
            assert_eq!(
                found
                    .containers
                    .iter()
                    .map(|container| container.name.as_str())
                    .collect::<Vec<_>>(),
                OWNED_CONTAINERS
            );
            assert!(found.running.is_empty() && found.resettable());

            let volumes = OWNED_LEFTOVERS.map(String::from).to_vec();
            let containers = OWNED_CONTAINERS.map(String::from).to_vec();
            for (stale_volumes, stale_containers) in [
                (volumes.clone(), Vec::new()),
                (volumes.clone(), containers[..1].to_vec()),
                (
                    volumes.clone(),
                    [containers.clone(), vec!["other-computer-knowledge".into()]].concat(),
                ),
                (Vec::new(), containers.clone()),
            ] {
                let error = reset_leftover_volumes(
                    &address,
                    &root,
                    &Secrets::new(),
                    &stale_volumes,
                    &stale_containers,
                )
                .expect_err("a changed set must not be removed");
                assert!(
                    error.said.to_lowercase().contains("nothing was removed"),
                    "{}",
                    error.said
                );
                assert!(!std::fs::read_to_string(&record).unwrap().contains(" rm "));
            }

            reset_leftover_volumes(&address, &root, &Secrets::new(), &volumes, &containers)
                .unwrap();
            let log = std::fs::read_to_string(&record).unwrap();
            let removals: Vec<_> = log
                .lines()
                .filter_map(|line| line.split_once('\t'))
                .map(|(_, command)| {
                    command
                        .strip_prefix("--connection fixture-machine ")
                        .unwrap_or(command)
                })
                .filter(|command| command.contains(" rm "))
                .collect();
            assert_eq!(
                removals,
                [
                    "container rm c-compose",
                    "container rm c-computer",
                    "volume rm openbot-profile-general-assistant",
                    "volume rm openbot-workspace-general-assistant",
                    "volume rm openbot_agent-profiles",
                    "volume rm openbot_agent-workspace",
                ]
            );
            assert!(!log.contains("--force") && !log.contains("prune") && !log.contains("down"));
            let kept = std::fs::read_to_string(root.join(".fixture-containers")).unwrap();
            let kept: Vec<_> = kept
                .lines()
                .map(|line| line.split('\t').next().unwrap())
                .collect();
            assert_eq!(
                kept,
                [
                    "c-other-namespace",
                    "c-unlabeled",
                    "c-other-project",
                    "c-renamed",
                    "c-legacy"
                ]
            );
        }
    }

    #[test]
    fn a_running_owned_container_blocks_the_reset_and_removes_nothing() {
        if crate::test_support::isolated_process(
            "stack::tests::a_running_owned_container_blocks_the_reset_and_removes_nothing",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("postgres-volume");
        let address = computer_stop_addresses(&path)[0].clone();
        let root = path.bin.join("leftover-running");
        std::fs::create_dir(&root).unwrap();
        let record = root.join("commands.log");
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        leftover_volumes_fixture(&root, "openbot");
        for status in ["running", "paused", "restarting"] {
            leftover_containers_fixture(&root, status);
            let found = leftover_volumes(&address, &root, &Secrets::new()).unwrap();
            assert_eq!(found.running, ["openbot-computer-general-assistant"]);
            assert!(!found.resettable(), "{status}");
            let error = reset_leftover_volumes(
                &address,
                &root,
                &Secrets::new(),
                &OWNED_LEFTOVERS.map(String::from),
                &OWNED_CONTAINERS.map(String::from),
            )
            .expect_err("a running container blocks the reset");
            assert!(
                error.said.contains("openbot-computer-general-assistant")
                    && error.said.contains("still running")
                    && error.said.contains("Nothing was removed"),
                "{}",
                error.said
            );
            assert!(!format!("{error:?}").contains("synthetic-secret"));
            assert!(!std::fs::read_to_string(&record).unwrap().contains(" rm "));
        }
        // A container listing that fails is not proof that nothing is running.
        leftover_containers_fixture(&root, "exited");
        std::fs::write(root.join(".fixture-ps-failure"), "").unwrap();
        let error = leftover_volumes(&address, &root, &Secrets::new()).unwrap_err();
        assert!(!format!("{error:?}").contains("synthetic-secret"));
    }

    #[cfg(unix)]
    fn unix_fixture(pid: u32, parent: u32) -> UnixProcess {
        UnixProcess {
            pid,
            parent,
            start: format!("instance-{pid}"),
        }
    }

    #[cfg(unix)]
    fn unix_record(pid: u32) -> UnixHostProcess {
        UnixHostProcess {
            name: "app".into(),
            deployment: PathBuf::from("/owned"),
            pid,
            start: format!("instance-{pid}"),
        }
    }

    #[cfg(unix)]
    struct UnixDescendantFixture {
        root: PathBuf,
        parent: std::process::Child,
        leaf: UnixProcess,
        port: u16,
    }

    #[cfg(unix)]
    impl UnixDescendantFixture {
        fn new(ignore_term: bool) -> Self {
            let root = temp_root("unix-descendant-cleanup");
            std::fs::create_dir_all(&root).unwrap();
            let source = root.join("listener.rs");
            std::fs::write(
                &source,
                format!(
                    "const TERM: i32 = {}; const IGNORE: usize = {};\n{{}}",
                    libc::SIGTERM,
                    libc::SIG_IGN
                )
                .replace(
                    "{}",
                    r#"
use std::io::Write;
extern "C" { fn signal(sig: i32, handler: usize) -> usize; }
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args[1] == "parent" {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["leaf", &args[2]]).spawn().unwrap();
        let status = child.wait().unwrap();
        std::fs::write("descendant-exit", status.to_string()).unwrap();
        return;
    }
    if args[2] == "ignore" { unsafe { signal(TERM, IGNORE); } }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    println!("{} {}", std::process::id(), listener.local_addr().unwrap().port());
    std::io::stdout().flush().unwrap();
    for stream in listener.incoming() { drop(stream.unwrap()); }
}
"#,
                ),
            )
            .unwrap();
            let binary = root.join("listener");
            crate::test_support::compile_fixture(&source, &binary);
            let mut parent = Command::new(binary)
                .args(["parent", if ignore_term { "ignore" } else { "graceful" }])
                .current_dir(&root)
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let mut line = String::new();
            std::io::BufRead::read_line(
                &mut std::io::BufReader::new(parent.stdout.take().unwrap()),
                &mut line,
            )
            .unwrap();
            let (pid, port) = line.trim().split_once(' ').unwrap();
            let leaf = unix_process(pid.parse().unwrap()).unwrap().unwrap();
            assert_eq!(leaf.parent, parent.id());
            record_host_processes(&root, &[("app", parent.id())]).unwrap();
            Self {
                root,
                parent,
                leaf,
                port: port.parse().unwrap(),
            }
        }
    }

    #[cfg(unix)]
    impl Drop for UnixDescendantFixture {
        fn drop(&mut self) {
            // Old-code regressions must also clean up the exact fixture instance after it orphans.
            if unix_process(self.leaf.pid)
                .unwrap()
                .is_some_and(|now| now.start == self.leaf.start)
            {
                unsafe {
                    libc::kill(self.leaf.pid as i32, libc::SIGKILL);
                }
            }
            let _ = self.parent.kill();
            let _ = self.parent.wait();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while something_answers(self.port) && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert!(
                !something_answers(self.port),
                "fixture listener was not cleaned"
            );
            assert!(unix_process(self.parent.id()).unwrap().is_none());
            assert!(unix_process(self.leaf.pid).unwrap().is_none());
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_descendant_cleanup_stops_ignoring_and_graceful_listeners_before_parent() {
        for ignore_term in [true, false] {
            let mut fixture = UnixDescendantFixture::new(ignore_term);
            let result = stop_processes_under(&fixture.root);
            let parent = fixture.parent.try_wait().unwrap();
            let leaf = unix_process(fixture.leaf.pid).unwrap();
            let listening = something_answers(fixture.port);
            let retry = stop_processes_under(&fixture.root);
            eprintln!(
                "{}",
                serde_json::json!({
                    "ignoreTerm": ignore_term, "stop": result.as_ref().ok(),
                    "parentExited": parent.is_some(), "leafAlive": leaf.is_some(),
                    "listenerOpen": listening, "retry": retry.as_ref().ok(),
                    "parentPid": fixture.parent.id(), "leafPid": fixture.leaf.pid, "port": fixture.port,
                })
            );
            drop(fixture);
            assert!(result.is_ok(), "{result:?}");
            assert!(
                !listening,
                "cleanup reported success while the descendant kept its listener"
            );
            assert!(leaf.is_none(), "cleanup left the descendant alive");
            assert_eq!(retry.unwrap(), 0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_descendant_failure_retains_real_parent_and_durable_retry_record() {
        let mut fixture = UnixDescendantFixture::new(true);
        let original = std::fs::read(host_pids_path(&fixture.root)).unwrap();
        let records = unix_host_records(&fixture.root, &[("app", fixture.parent.id())]).unwrap();
        let mut attempts = Vec::new();
        let result = stop_unix_records_with(
            &std::fs::canonicalize(&fixture.root).unwrap(),
            &records,
            &unix_inventory().unwrap(),
            unix_process,
            quiesce_unix_process,
            unix_inventory,
            |pid, _| {
                attempts.push(pid);
                Err(unix_ownership_problem(
                    "synthetic descendant signal refusal",
                ))
            },
        );
        assert!(result.is_err());
        assert_eq!(attempts, [fixture.leaf.pid as i32]);
        assert!(
            fixture.parent.try_wait().unwrap().is_none(),
            "retry ancestor must stay alive"
        );
        assert!(unix_process_state(fixture.leaf.pid).unwrap().unwrap().1);
        assert_eq!(
            std::fs::read(host_pids_path(&fixture.root)).unwrap(),
            original
        );
        assert_eq!(
            unix_process(fixture.leaf.pid).unwrap(),
            Some(fixture.leaf.clone())
        );
        // Retrying the durable record also handles ancestors left stopped by the failed attempt.
        assert!(stop_processes_under(&fixture.root).is_ok());
        assert!(!something_answers(fixture.port));
        assert!(unix_process(fixture.leaf.pid).unwrap().is_none());
        assert_eq!(stop_processes_under(&fixture.root).unwrap(), 0);
        // Drop independently checks the retained instances and port before removing the fixture.
    }

    #[cfg(unix)]
    #[test]
    fn unix_descendant_removal_refuses_changed_identity_and_retains_ancestor_on_failure() {
        for failure in [
            "reused",
            "reparented",
            "ancestor-reused",
            "stuck",
            "signal-denied",
        ] {
            let signaled = std::cell::Cell::new(false);
            let mut attempts = Vec::new();
            let result = stop_unix_records_with(
                Path::new("/owned"),
                &[unix_record(101)],
                &[(101, 100), (102, 101)],
                |pid| {
                    let mut live = unix_fixture(pid, if pid == 102 { 101 } else { 100 });
                    if signaled.get() {
                        if (failure == "reused" && pid == 102)
                            || (failure == "ancestor-reused" && pid == 101)
                        {
                            live.start = "foreign-instance".into();
                        }
                        if failure == "reparented" && pid == 102 {
                            live.parent = 201;
                        }
                    }
                    Ok(Some(live))
                },
                |_, _| Ok(()),
                || Ok([(101, 100), (102, 101)].to_vec()),
                |pid, still_owned| {
                    terminate_unix_process_with(
                        pid,
                        still_owned,
                        |pid, signal| {
                            attempts.push((pid, signal));
                            signaled.set(true);
                            if failure == "signal-denied" {
                                Err(unix_ownership_problem("synthetic signal refusal"))
                            } else {
                                Ok(true)
                            }
                        },
                        std::time::Duration::ZERO,
                    )
                },
            );
            assert!(result.is_err(), "{failure} must remain a cleanup failure");
            let expected = vec![(102, libc::SIGKILL)];
            assert_eq!(
                attempts, expected,
                "{failure}: ancestor or changed instance must never be signaled"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_ownership_selects_only_recorded_instance_and_verified_descendants() {
        let live = [
            unix_fixture(101, 100),
            unix_fixture(102, 101),
            unix_fixture(103, 102),
            unix_fixture(201, 100),
            unix_fixture(202, 201),
        ];
        // The other root may have the same cwd/command: neither is an ownership input.
        let rows: Vec<_> = live.iter().map(|p| (p.pid, p.parent)).collect();
        let mut attempted = Vec::new();
        let count = stop_unix_records_with(
            Path::new("/owned"),
            &[unix_record(101)],
            &rows,
            |pid| Ok(live.iter().find(|p| p.pid == pid).cloned()),
            |_, _| Ok(()),
            || Ok(rows.clone()),
            |pid, _| {
                attempted.push(pid);
                Ok(true)
            },
        )
        .unwrap();
        assert_eq!(count, 3);
        assert_eq!(attempted, [103, 102, 101]);
        for root in ["/other", "/owned-sibling"] {
            assert!(stop_unix_records_with(
                Path::new(root),
                &[unix_record(101)],
                &rows,
                |_| panic!("a different deployment is not inspected"),
                |_, _| Ok(()),
                || Ok(rows.clone()),
                |_, _| panic!("a different deployment is not signaled")
            )
            .is_err());
        }
        assert_eq!(
            stop_unix_records_with(
                Path::new("/owned"),
                &[],
                &rows,
                |_| panic!("an unrecorded process is not inspected"),
                |_, _| Ok(()),
                || Ok(rows.clone()),
                |_, _| panic!("an unrecorded process is not signaled")
            )
            .unwrap(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_reused_pids_and_changed_ancestry_never_authorize_a_signal() {
        let changed = UnixProcess {
            start: "reused".into(),
            ..unix_fixture(101, 100)
        };
        assert_eq!(
            stop_unix_records_with(
                Path::new("/owned"),
                &[unix_record(101)],
                &[(101, 100)],
                |_| Ok(Some(changed.clone())),
                |_, _| Ok(()),
                || Ok([(101, 100)].to_vec()),
                |_, _| panic!("reused PID")
            )
            .unwrap(),
            0
        );
        let mut reads = 0;
        assert!(stop_unix_records_with(
            Path::new("/owned"),
            &[unix_record(101)],
            &[(101, 100), (102, 101)],
            |pid| {
                reads += 1;
                Ok(Some(if reads > 2 {
                    UnixProcess {
                        start: "changed-after-inventory".into(),
                        ..unix_fixture(pid, 100)
                    }
                } else {
                    unix_fixture(pid, if pid == 102 { 101 } else { 100 })
                }))
            },
            |_, _| Ok(()),
            || Ok([(101, 100), (102, 101)].to_vec()),
            |_, _| panic!("changed instance must be revalidated")
        )
        .is_err());
        assert!(stop_unix_records_with(
            Path::new("/owned"),
            &[unix_record(101)],
            &[(101, 100), (102, 101)],
            |pid| Ok(Some(unix_fixture(pid, 100))),
            |_, _| Ok(()),
            || Ok([(101, 100), (102, 101)].to_vec()),
            |_, _| panic!("changed parent")
        )
        .is_err());
        for pid in [
            0,
            1,
            std::process::id(),
            unsafe { libc::getppid() } as u32,
            u32::MAX,
        ] {
            assert!(stop_unix_records_with(
                Path::new("/owned"),
                &[unix_record(pid)],
                &[],
                |_| panic!("unsafe PID"),
                |_, _| Ok(()),
                || Ok([].to_vec()),
                |_, _| panic!("unsafe PID")
            )
            .is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_cleanup_reports_failure_keeps_parent_and_attempts_other_owned_roots() {
        let live = [
            unix_fixture(101, 100),
            unix_fixture(102, 101),
            unix_fixture(201, 100),
        ];
        let mut attempted = Vec::new();
        let problem = stop_unix_records_with(
            Path::new("/owned"),
            &[unix_record(101), unix_record(201)],
            &[(101, 100), (102, 101), (201, 100)],
            |pid| Ok(live.iter().find(|p| p.pid == pid).cloned()),
            |_, _| Ok(()),
            || Ok([(101, 100), (102, 101), (201, 100)].to_vec()),
            |pid, _| {
                attempted.push(pid);
                if pid == 102 {
                    Err(unix_ownership_problem(
                        "synthetic signal refusal for pid 102",
                    ))
                } else {
                    Ok(true)
                }
            },
        )
        .unwrap_err();
        assert_eq!(attempted, [102, 201]);
        assert!(problem.detail.unwrap().contains("synthetic signal refusal"));
        assert_eq!(
            stop_unix_records_with(
                Path::new("/owned"),
                &[unix_record(101)],
                &[(101, 100)],
                |_| Ok(Some(unix_fixture(101, 100))),
                |_, _| Ok(()),
                || Ok([(101, 100)].to_vec()),
                |_, _| Ok(false)
            )
            .unwrap(),
            0
        );
        assert!(stop_unix_records_with(
            Path::new("/owned"),
            &[unix_record(101)],
            &[],
            |_| Err(unix_ownership_problem("inventory denied")),
            |_, _| Ok(()),
            || Ok([].to_vec()),
            |_, _| panic!("lost inventory")
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn unix_cleanup_inventories_children_only_after_verified_quiescence() {
        use std::cell::RefCell;
        // 103 is born under 102 after the initial snapshot. 201 is a foreign neighbor.
        let live = [
            unix_fixture(101, 100),
            unix_fixture(102, 101),
            unix_fixture(103, 102),
            unix_fixture(201, 100),
        ];
        let frozen = RefCell::new(Vec::new());
        let mut killed = Vec::new();
        let count = stop_unix_records_with(
            Path::new("/owned"),
            &[unix_record(101)],
            &[(101, 100), (102, 101), (201, 100)],
            |pid| Ok(live.iter().find(|p| p.pid == pid).cloned()),
            |pid, still_owned| {
                assert!(still_owned()?);
                frozen.borrow_mut().push(pid);
                Ok(())
            },
            || {
                assert!(
                    !frozen.borrow().is_empty(),
                    "inventory ran before its parent stopped"
                );
                Ok(live.iter().map(|p| (p.pid, p.parent)).collect())
            },
            |pid, still_owned| {
                assert_eq!(*frozen.borrow(), [101, 102, 103]);
                assert!(still_owned()?);
                killed.push(pid);
                Ok(true)
            },
        )
        .unwrap();
        assert_eq!(count, 3);
        assert_eq!(killed, [103, 102, 101]);
    }

    #[cfg(unix)]
    #[test]
    fn unix_quiescence_failure_preserves_anchors_and_attempts_other_roots() {
        use std::cell::RefCell;
        for failure in ["stop-denied", "inventory-denied"] {
            let live = [
                unix_fixture(101, 100),
                unix_fixture(102, 101),
                unix_fixture(201, 100),
            ];
            let frozen = RefCell::new(Vec::new());
            let mut killed = Vec::new();
            let result = stop_unix_records_with(
                Path::new("/owned"),
                &[unix_record(101), unix_record(201)],
                &[(101, 100), (102, 101), (201, 100)],
                |pid| Ok(live.iter().find(|p| p.pid == pid).cloned()),
                |pid, still_owned| {
                    assert!(still_owned()?);
                    if failure == "stop-denied" && pid == 102 {
                        return Err(unix_ownership_problem("synthetic stop denied"));
                    }
                    frozen.borrow_mut().push(pid);
                    Ok(())
                },
                || {
                    if failure == "inventory-denied" && frozen.borrow().last() == Some(&102) {
                        return Err(unix_ownership_problem("synthetic inventory denied"));
                    }
                    Ok(live.iter().map(|p| (p.pid, p.parent)).collect())
                },
                |pid, _| {
                    killed.push(pid);
                    Ok(true)
                },
            );
            assert!(result.is_err(), "{failure} must remain an error");
            assert_eq!(
                killed,
                [201],
                "{failure}: unresolved tree must retain its anchors"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_quiescence_requires_confirmed_stop_and_revalidates_identity() {
        for failure in [
            "unconfirmed",
            "missing",
            "changed",
            "status-denied",
            "signal-denied",
        ] {
            let status_read = std::cell::Cell::new(false);
            let mut signals = Vec::new();
            let result = quiesce_unix_process_with(
                101,
                &mut || {
                    if status_read.get() {
                        if failure == "missing" {
                            return Ok(false);
                        }
                        if failure == "changed" {
                            return Err(unix_ownership_problem("changed instance"));
                        }
                    }
                    Ok(true)
                },
                |pid, signal| {
                    signals.push((pid, signal));
                    if failure == "signal-denied" {
                        return Err(unix_ownership_problem("signal denied"));
                    }
                    Ok(true)
                },
                |_| {
                    status_read.set(true);
                    if failure == "status-denied" {
                        return Err(unix_ownership_problem("status denied"));
                    }
                    Ok(failure != "unconfirmed")
                },
                std::time::Duration::ZERO,
            );
            assert!(result.is_err(), "{failure}");
            assert_eq!(signals, [(101, libc::SIGSTOP)]);
        }
    }

    #[cfg(unix)]
    #[test]
    fn linux_stop_state_is_separate_from_process_instance_identity() {
        let stat = |state| format!("101 (owned) {state} 100 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 42");
        let running = parse_linux_process_state(101, &stat("S"), "boot")
            .unwrap()
            .unwrap();
        let stopped = parse_linux_process_state(101, &stat("T"), "boot")
            .unwrap()
            .unwrap();
        assert_eq!(running.0, stopped.0);
        assert!(!running.1);
        assert!(stopped.1);
        // A ptrace stop is not proof of our SIGSTOP quiescence.
        assert!(
            !parse_linux_process_state(101, &stat("t"), "boot")
                .unwrap()
                .unwrap()
                .1
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_inventory_command_failures_and_malformed_output_are_errors() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_root("unix-inventory");
        std::fs::create_dir_all(&root).unwrap();
        let ps = root.join("ps");
        assert!(unix_inventory_with(&ps)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("could not run"));
        for body in [
            "echo synthetic-ps-failure >&2; exit 9",
            "echo malformed",
            "exit 0",
            "printf '101 100\\n101 100\\n'",
        ] {
            std::fs::write(&ps, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&ps, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert!(unix_inventory_with(&ps).is_err(), "{body}");
        }
        std::fs::write(&ps, "#!/bin/sh\nprintf '101 100\\n102 101\\n'\n").unwrap();
        assert_eq!(unix_inventory_with(&ps).unwrap(), [(101, 100), (102, 101)]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unix_missing_legacy_corrupt_and_versioned_records_fail_closed() {
        let root = temp_root("unix-records");
        assert_eq!(stop_processes_under(&root).unwrap(), 0);
        record_host_pids(&root, &[42]).unwrap();
        assert!(stop_processes_under(&root)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("legacy"));
        assert_eq!(std::fs::read(host_pids_path(&root)).unwrap(), b"[42]");
        for raw in [
            "broken",
            "{\"version\":2,\"unix_processes\":[{\"pid\":42}]}",
            "{\"version\":3,\"unix_processes\":[]}",
        ] {
            std::fs::write(host_pids_path(&root), raw).unwrap();
            assert!(stop_processes_under(&root).is_err());
            assert_eq!(std::fs::read_to_string(host_pids_path(&root)).unwrap(), raw);
        }
        write_host_pid_file(
            &root,
            &serde_json::json!({"version":2,"unix_processes":[unix_record(101)]}),
        )
        .unwrap();
        assert_eq!(recorded_host_pids(&root).unwrap(), [101]);
        assert!(
            recorded_host_processes(&root).unwrap().is_empty(),
            "Windows v1 reader must not treat Unix records as Windows evidence"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn linux_identity_parser_uses_boot_and_start_ticks_and_rejects_malformed_inventory() {
        let raw = "101 (command with ) spaces) S 100 101 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 999 0";
        let first = parse_linux_process(101, raw, "boot-one").unwrap().unwrap();
        assert_eq!(first.parent, 100);
        assert_eq!(first.start, "linux:boot-one:999");
        assert_ne!(
            first.start,
            parse_linux_process(101, raw, "boot-two")
                .unwrap()
                .unwrap()
                .start
        );
        for bad in [
            "",
            "101 malformed",
            "101 (name) S 100",
            "102 (wrong-pid) S 100",
        ] {
            assert!(parse_linux_process(101, bad, "boot-one").is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_restart_refreshes_identity_and_retains_new_handle_on_persistence_failure() {
        let root = temp_root("unix-restart");
        std::fs::create_dir_all(&root).unwrap();
        let first = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let mut children = Vec::new();
        replace_host_process(&root, &mut children, "app", first).unwrap();
        let prior = std::fs::read(host_pids_path(&root)).unwrap();
        children[0].1.kill().unwrap();
        children[0].1.wait().unwrap();
        let replacement = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let replacement_pid = replacement.id();
        replace_host_process(&root, &mut children, "app", replacement).unwrap();
        assert_eq!(recorded_host_pids(&root).unwrap(), [replacement_pid]);
        assert_ne!(std::fs::read(host_pids_path(&root)).unwrap(), prior);
        children[0].1.kill().unwrap();
        children[0].1.wait().unwrap();
        std::fs::remove_file(host_pids_path(&root)).unwrap();
        std::fs::create_dir(host_pids_path(&root)).unwrap();
        let replacement = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let replacement_pid = replacement.id();
        let result = replace_host_process(&root, &mut children, "app", replacement);
        assert_eq!(children[0].1.id(), replacement_pid);
        let still_alive = children[0].1.try_wait().unwrap().is_none();
        children[0].1.kill().unwrap();
        children[0].1.wait().unwrap();
        assert!(still_alive);
        assert!(result
            .unwrap_err()
            .detail
            .unwrap()
            .contains("replace pidfile"));
        assert_eq!(std::fs::read_dir(root.join(".logs")).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_initial_inventory_does_not_own_a_direct_sibling_replacement() {
        let original = recorded_process("server", 9000, "/Date(1000)/");
        let rows = [
            live_process(9000, 7000, "/Date(1000)/"),
            live_process(9001, 7000, "/Date(2000)/"),
            live_process(9002, 8000, "/Date(3000)/"),
        ];
        let listing = "TCP 127.0.0.1:3001 0.0.0.0:0 LISTENING 9001\nTCP 127.0.0.1:3010 0.0.0.0:0 LISTENING 9002\n";
        assert_eq!(
            verified_openbot_root_pids(std::slice::from_ref(&original), &rows),
            [9000]
        );
        assert!(verified_openbot_pids_listening_on(
            listing,
            &[3001, 3010],
            std::slice::from_ref(&original),
            &rows
        )
        .is_empty());
        let replacement = recorded_process("server", 9001, "/Date(2000)/");
        assert_eq!(
            verified_openbot_pids_listening_on(
                listing,
                &[3001, 3010],
                &[original, replacement],
                &rows
            ),
            [9001]
        );
    }

    struct WindowsReplacementFixture {
        root: PathBuf,
        commands: CleanupCommandFixture,
        children: Vec<(&'static str, std::process::Child)>,
        binary: PathBuf,
    }

    impl WindowsReplacementFixture {
        fn new() -> Self {
            let root = temp_root("windows-replacement-records");
            std::fs::create_dir_all(&root).unwrap();
            let commands = CleanupCommandFixture::new(&root);
            commands.scenario("ownership-inventory");
            let source = root.join("held.rs");
            std::fs::write(&source, "fn main() { let mut line = String::new(); std::io::stdin().read_line(&mut line).unwrap(); }").unwrap();
            let binary = root.join(if cfg!(windows) { "held.exe" } else { "held" });
            crate::test_support::compile_fixture(&source, &binary);
            Self {
                root,
                commands,
                children: Vec::new(),
                binary,
            }
        }

        fn spawn(&self) -> std::process::Child {
            Command::new(&self.binary)
                .stdin(Stdio::piped())
                .spawn()
                .unwrap()
        }

        fn inventory(&self, rows: &[WindowsProcess]) {
            let rows: Vec<_> = rows
                .iter()
                .map(|row| {
                    serde_json::json!({
                        "ProcessId": row.process_id, "ParentProcessId": row.parent_process_id,
                        "ExecutablePath": row.executable_path, "CommandLine": row.command_line,
                        "CreationDate": row.creation_date,
                    })
                })
                .collect();
            std::fs::write(
                self.root.join("synthetic-inventory.json"),
                serde_json::to_vec(&rows).unwrap(),
            )
            .unwrap();
        }

        fn owns(&self, name: &str, pid: u32) -> bool {
            std::fs::write(
                self.root.join("synthetic-netstat.txt"),
                format!("TCP 127.0.0.1:45123 0.0.0.0:0 LISTENING {pid}\n"),
            )
            .unwrap();
            recorded_process_owns_port_windows_with(
                &self.root,
                name,
                45123,
                &self.commands.command("powershell"),
                &self.commands.command("netstat"),
            )
            .unwrap()
        }
    }

    impl Drop for WindowsReplacementFixture {
        fn drop(&mut self) {
            for (_, child) in &mut self.children {
                if child.try_wait().unwrap().is_none() {
                    child.kill().unwrap();
                }
                child.wait().unwrap();
            }
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }

    fn windows_restart_records_case<F>(both_dead: bool, mut publish: F)
    where
        F: FnMut(
            &Path,
            &mut Vec<(&'static str, std::process::Child)>,
            &'static str,
            std::process::Child,
            &Path,
        ) -> Result<(), Problem>,
    {
        let mut fixture = WindowsReplacementFixture::new();
        let old_server = fixture.spawn();
        let old_app = fixture.spawn();
        let old = vec![
            recorded_process("server", old_server.id(), "/Date(1000)/"),
            recorded_process("app", old_app.id(), "/Date(1001)/"),
        ];
        fixture.children = vec![("server", old_server), ("app", old_app)];
        write_host_pid_file(
            &fixture.root,
            &serde_json::json!({"version":1,"processes":old}),
        )
        .unwrap();
        fixture.children[0].1.kill().unwrap();
        fixture.children[0].1.wait().unwrap();
        if both_dead {
            fixture.children[1].1.kill().unwrap();
            fixture.children[1].1.wait().unwrap();
        }
        let replacement = fixture.spawn();
        let pid = replacement.id();
        // The predecessor PID is now foreign; the other role can be live or absent.
        let mut rows = vec![
            live_process(old[0].pid, 0, "/Date(1500)/"),
            live_process(pid, std::process::id(), "/Date(2000)/"),
        ];
        if !both_dead {
            rows.push(live_host_process(
                "app",
                old[1].pid,
                std::process::id(),
                "/Date(1001)/",
            ));
        }
        fixture.inventory(&rows);
        assert!(!fixture.owns("server", pid));
        publish(
            &fixture.root,
            &mut fixture.children,
            "server",
            replacement,
            &fixture.commands.command("powershell"),
        )
        .unwrap();
        assert!(
            fixture.owns("server", pid),
            "published replacement must own its listener"
        );
        assert!(
            !fixture.owns("server", old[0].pid),
            "a reused predecessor PID must remain foreign"
        );
        let records = recorded_host_processes(&fixture.root).unwrap();
        assert!(
            old.iter().all(|record| records.contains(record)),
            "retain earlier cleanup evidence"
        );
        assert_eq!(records.len(), 3);
        assert!(!fixture
            .children
            .iter()
            .any(|(_, child)| child.id() == old[0].pid));
        if both_dead {
            let app = fixture.spawn();
            let app_pid = app.id();
            rows.push(live_host_process(
                "app",
                app_pid,
                std::process::id(),
                "/Date(2001)/",
            ));
            fixture.inventory(&rows);
            publish(
                &fixture.root,
                &mut fixture.children,
                "app",
                app,
                &fixture.commands.command("powershell"),
            )
            .unwrap();
            assert!(fixture.owns("app", app_pid));
            assert!(fixture.owns("server", pid));
            assert_eq!(fixture.children.len(), 2);
            assert_eq!(recorded_host_processes(&fixture.root).unwrap().len(), 4);
        } else {
            assert!(fixture.owns("app", old[1].pid));
        }
        assert!(!fixture.commands.log().contains("taskkill\t"));
    }

    #[test]
    fn windows_replacement_records_new_owner_and_preserves_other_role() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_replacement_records_new_owner_and_preserves_other_role",
        ) {
            return;
        }
        windows_restart_records_case(false, replace_windows_host_process_with);
    }

    #[test]
    fn windows_replacement_records_two_dead_roles_sequentially() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_replacement_records_two_dead_roles_sequentially",
        ) {
            return;
        }
        windows_restart_records_case(true, replace_windows_host_process_with);
    }

    #[test]
    fn windows_replacement_recording_failure_retains_handles_and_prior_records() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_replacement_recording_failure_retains_handles_and_prior_records",
        ) {
            return;
        }
        for failure in [
            "missing",
            "wrong-parent",
            "incomplete",
            "malformed-time",
            "duplicate",
            "exited",
            "read",
        ] {
            let mut fixture = WindowsReplacementFixture::new();
            let prior = serde_json::to_vec(&serde_json::json!({"version":1,"processes":[recorded_process("app", 9000, "/Date(1001)/")]})).unwrap();
            std::fs::create_dir_all(fixture.root.join(".logs")).unwrap();
            let prior = if failure == "read" {
                b"unreadable-records".to_vec()
            } else {
                prior
            };
            std::fs::write(host_pids_path(&fixture.root), &prior).unwrap();
            // Even a live predecessor must not be dropped on a failed publication.
            fixture.children.push(("server", fixture.spawn()));
            let mut replacement = fixture.spawn();
            let pid = replacement.id();
            let mut live = live_process(pid, std::process::id(), "/Date(2000)/");
            if failure == "wrong-parent" {
                live.parent_process_id = 0;
            }
            if failure == "incomplete" {
                live.creation_date = None;
            }
            if failure == "malformed-time" {
                live.creation_date = Some("not-a-date".into());
            }
            let rows = match failure {
                "missing" => vec![],
                "duplicate" => vec![live.clone(), live],
                _ => vec![live],
            };
            fixture.inventory(&rows);
            if failure == "exited" {
                replacement.kill().unwrap();
                replacement.wait().unwrap();
            }
            let result = replace_windows_host_process_with(
                &fixture.root,
                &mut fixture.children,
                "server",
                replacement,
                &fixture.commands.command("powershell"),
            );
            assert!(result.is_err(), "{failure}");
            assert_eq!(
                std::fs::read(host_pids_path(&fixture.root)).unwrap(),
                prior,
                "{failure}"
            );
            assert_eq!(fixture.children.len(), 2, "{failure}");
            assert_eq!(fixture.children[1].1.id(), pid);
            assert_eq!(
                fixture.children[1].1.try_wait().unwrap().is_none(),
                failure != "exited"
            );
            assert!(!fixture.commands.log().contains("taskkill\t"));
        }
    }

    fn ipv6_loopback_listener() -> Option<std::net::TcpListener> {
        match std::net::TcpListener::bind("[::1]:0") {
            Ok(listener) => Some(listener),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::AddrNotAvailable | std::io::ErrorKind::Unsupported
                ) =>
            {
                eprintln!("IPv6 loopback unavailable; skipping IPv6 socket regression: {error}");
                None
            }
            Err(error) => panic!("could not bind the IPv6 regression listener: {error}"),
        }
    }

    fn host_command_line(name: &str) -> &'static str {
        match name {
            "worker" => r#"bun --env-file=../.env src/index.ts"#,
            _ => r#"bun --env-file=../.env src/production-entry.ts"#,
        }
    }

    fn recorded_process(name: &str, pid: u32, creation_date: &str) -> RecordedHostProcess {
        RecordedHostProcess {
            name: name.to_string(),
            pid,
            executable_path: r"C:\Users\person\.bun\bin\bun.exe".to_string(),
            command_line: host_command_line(name).to_string(),
            creation_date: creation_date.to_string(),
        }
    }

    fn live_host_process(name: &str, pid: u32, parent: u32, creation_date: &str) -> WindowsProcess {
        WindowsProcess {
            process_id: pid,
            parent_process_id: parent,
            executable_path: Some(r"C:\Users\person\.bun\bin\bun.exe".to_string()),
            command_line: Some(host_command_line(name).to_string()),
            creation_date: Some(creation_date.to_string()),
        }
    }

    fn live_process(pid: u32, parent: u32, creation_date: &str) -> WindowsProcess {
        live_host_process("server", pid, parent, creation_date)
    }

    struct PathFixture {
        previous: Option<std::ffi::OsString>,
        previous_record: Option<std::ffi::OsString>,
        previous_scenario: Option<std::ffi::OsString>,
        bin: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl PathFixture {
        fn with_fake_engine(scenario: &str) -> Self {
            Self::with_fake_engine_and_inherited_path(scenario, true)
        }

        fn with_broken_engine() -> Self {
            Self::with_fake_engine_and_inherited_path("spawn", false)
        }

        fn with_fake_engine_and_inherited_path(scenario: &str, inherit_path: bool) -> Self {
            static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let previous = std::env::var_os("PATH");
            let previous_record = std::env::var_os("OPENBOT_TEST_ENGINE_RECORD");
            let previous_scenario = std::env::var_os("OPENBOT_FAKE_ENGINE_SCENARIO");
            let bin = temp_root("openbot-stack-fake-engine-bin");
            std::fs::create_dir_all(&bin).unwrap();
            let docker = bin.join(if cfg!(windows) {
                "docker.exe"
            } else {
                "docker"
            });
            if scenario == "spawn" {
                std::fs::write(&docker, "not an executable").unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mut permissions = std::fs::metadata(&docker).unwrap().permissions();
                    permissions.set_mode(0o644);
                    std::fs::set_permissions(&docker, permissions).unwrap();
                }
            } else {
                let source = bin.join("fake_engine.rs");
                std::fs::write(&source, FAKE_ENGINE_SOURCE).unwrap();
                crate::test_support::compile_fixture(&source, &docker);
            }
            let mut path = std::ffi::OsString::from(&bin);
            if inherit_path {
                if let Some(previous) = previous.as_ref().filter(|previous| !previous.is_empty()) {
                    path.push(if cfg!(windows) { ";" } else { ":" });
                    path.push(previous);
                }
            }
            if !inherit_path && cfg!(windows) {
                path.push(if cfg!(windows) { ";" } else { ":" });
                path.push(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()));
            }
            std::env::set_var("PATH", path);
            std::env::set_var("OPENBOT_FAKE_ENGINE_SCENARIO", scenario);
            Self {
                previous,
                previous_record,
                previous_scenario,
                bin,
                _guard: guard,
            }
        }
    }

    impl Drop for PathFixture {
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
            if let Some(previous) = &self.previous_scenario {
                std::env::set_var("OPENBOT_FAKE_ENGINE_SCENARIO", previous);
            } else {
                std::env::remove_var("OPENBOT_FAKE_ENGINE_SCENARIO");
            }
            std::fs::remove_dir_all(&self.bin).ok();
        }
    }

    const FAKE_ENGINE_SOURCE: &str = r#"
use std::io::Write;

/// `.fixture-containers`: one container per line, `id<TAB>name<TAB>status<TAB>k=v,k=v<TAB>volume,volume`.
struct FixtureContainer { id: String, name: String, status: String, labels: Vec<(String, String)>, mounts: Vec<String> }

/// A JSON string, so a Windows path in a label stays valid JSON.
fn serde_json_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn fixture_containers() -> Vec<FixtureContainer> {
    let Ok(listing) = std::fs::read_to_string(".fixture-containers") else { return Vec::new() };
    listing.lines().filter(|line| !line.is_empty()).map(|line| {
        let fields: Vec<&str> = line.split('\t').collect();
        let list = |field: &str| field.split(',').filter(|item| !item.is_empty()).map(str::to_owned).collect::<Vec<_>>();
        FixtureContainer {
            id: fields[0].into(),
            name: fields[1].into(),
            status: fields[2].into(),
            labels: list(fields[3]).into_iter().map(|pair| { let (k, v) = pair.split_once('=').unwrap(); (k.to_owned(), v.to_owned()) }).collect(),
            mounts: list(fields.get(4).copied().unwrap_or("")),
        }
    }).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let joined = args.join(" ");
    if let Ok(path) = std::env::var("OPENBOT_TEST_ENGINE_RECORD") {
        let cwd = std::env::current_dir().unwrap();
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        writeln!(file, "{}\t{}", cwd.display(), joined).unwrap();
    }
    let scenario = std::env::var("OPENBOT_FAKE_ENGINE_SCENARIO").unwrap();
    if scenario == "postgres-volume" {
        let actual = if args.first().map(String::as_str) == Some("--connection") { &args[2..] } else { &args[..] };
        let (file, failure) = if actual == ["compose", "config", "--format", "json"] {
            (".fixture-config", ".fixture-config-failure")
        } else if actual == ["volume", "ls", "--format", "{{.Name}}"] {
            (".fixture-volumes", ".fixture-volume-failure")
        } else if actual == ["volume", "inspect", "openbot_postgres-data"] {
            (".fixture-inspect", ".fixture-inspect-failure")
        } else if actual.len() == 3 && actual[0] == "volume" && actual[1] == "inspect" {
            let file = format!(".fixture-inspect-{}", actual[2]);
            if !std::path::Path::new(&file).exists() {
                eprintln!("no such volume: {}", actual[2]);
                std::process::exit(1);
            }
            print!("{}", std::fs::read_to_string(file).unwrap());
            return;
        } else if actual.len() == 3 && actual[0] == "volume" && actual[1] == "rm" {
            let volume = actual[2].as_str();
            if (volume == "openbot_postgres-data" && std::path::Path::new(".fixture-attached").exists())
                || std::path::Path::new(&format!(".fixture-attached-{volume}")).exists()
                || fixture_containers().iter().any(|container| container.mounts.iter().any(|mount| mount == volume))
            {
                eprintln!("synthetic-secret attached container");
                std::process::exit(2);
            }
            let inventory = std::fs::read_to_string(".fixture-volumes").unwrap();
            let remaining: String = inventory.lines().filter(|name| *name != volume).map(|name| format!("{name}\n")).collect();
            std::fs::write(".fixture-volumes", remaining).unwrap();
            return;
        } else if actual.first().map(String::as_str) == Some("ps") {
            assert_eq!(actual[1..4], ["--all", "--quiet", "--no-trunc"], "{actual:?}");
            let wanted: Vec<(&str, &str)> = actual[4..].chunks(2).map(|pair| {
                assert_eq!(pair[0], "--filter");
                pair[1].strip_prefix("label=").unwrap().split_once('=').unwrap()
            }).collect();
            if std::path::Path::new(".fixture-ps-failure").exists() {
                eprintln!("synthetic-secret-must-not-appear-in-diagnostics");
                std::process::exit(17);
            }
            for container in fixture_containers() {
                if wanted.iter().all(|(key, value)| container.labels.iter().any(|(k, v)| k == key && v == value)) {
                    println!("{}", container.id);
                }
            }
            return;
        } else if actual.len() == 3 && actual[0] == "container" && actual[1] == "inspect" {
            let Some(container) = fixture_containers().into_iter().find(|container| container.id == actual[2]) else {
                eprintln!("no such container: {}", actual[2]);
                std::process::exit(1);
            };
            // Docker reports names with a leading slash; Podman does not.
            let slash = if args.first().map(String::as_str) == Some("--connection") { "" } else { "/" };
            let labels: Vec<String> = container.labels.iter().map(|(k, v)| format!("\"{k}\":{}", serde_json_string(v))).collect();
            let mounts: Vec<String> = container.mounts.iter().map(|m| format!("{{\"Type\":\"volume\",\"Name\":\"{m}\"}}")).collect();
            print!(
                "[{{\"Id\":\"{}\",\"Name\":\"{slash}{}\",\"State\":{{\"Status\":\"{}\",\"Running\":{}}},\"Config\":{{\"Labels\":{{{}}}}},\"Mounts\":[{}]}}]",
                container.id, container.name, container.status, container.status == "running", labels.join(","), mounts.join(",")
            );
            return;
        } else if actual.len() == 3 && actual[0] == "container" && actual[1] == "rm" {
            let containers = fixture_containers();
            let Some(container) = containers.iter().find(|container| container.id == actual[2]) else {
                eprintln!("no such container: {}", actual[2]);
                std::process::exit(1);
            };
            if container.status == "running" {
                eprintln!("synthetic-secret cannot remove a running container");
                std::process::exit(2);
            }
            let inventory = std::fs::read_to_string(".fixture-containers").unwrap();
            let remaining: String = inventory.lines().filter(|line| line.split('\t').next() != Some(actual[2].as_str())).map(|line| format!("{line}\n")).collect();
            std::fs::write(".fixture-containers", remaining).unwrap();
            return;
        } else { panic!("unexpected volume probe command: {actual:?}"); };
        if std::path::Path::new(failure).exists() {
            eprintln!("synthetic-secret-must-not-appear-in-diagnostics");
            std::process::exit(17);
        }
        print!("{}", std::fs::read_to_string(file).unwrap());
        return;
    }
    if scenario == "macos-podman-start" {
        let actual = if args.first().map(String::as_str) == Some("--connection") { &args[2..] } else { &args[..] };
        if actual == ["compose", "config", "--environment"] {
            if std::path::Path::new(".fixture-config-failure").exists() {
                eprintln!("synthetic invalid deployment override");
                std::process::exit(17);
            }
            print!("{}", std::fs::read_to_string(".fixture-compose-environment").unwrap_or_default());
            return;
        }
        if actual.iter().any(|arg| arg == "up" || arg == "run") {
            let files: Vec<_> = actual.windows(2).filter(|pair| pair[0] == "-f").map(|pair| &pair[1]).collect();
            if !files.iter().any(|file| file.ends_with(".openbot-macos-podman.yml")) {
                eprintln!("Error response from daemon: rootlessport conflict with ID 1");
                std::process::exit(126);
            }
            for file in files { assert!(std::path::Path::new(file).is_file(), "missing compose file {file}"); }
            return;
        }
        panic!("unexpected startup command: {actual:?}");
    }
    // Docker Desktop on a Mac, for a sign-in folder made just before `up`: `.fixture-refusals`
    // `up`s are refused as its daemon refused them, then `up` succeeds. `.fixture-other-error` is a
    // refusal that is not that one.
    if scenario == "folder-not-shared-yet" {
        assert_eq!(args.first().map(String::as_str), Some("compose"), "{args:?}");
        assert!(args.iter().any(|arg| arg == "up"), "unexpected startup command: {args:?}");
        let tries = std::fs::read_to_string(".fixture-up-tries").unwrap_or_default().len() + 1;
        std::fs::write(".fixture-up-tries", "x".repeat(tries)).unwrap();
        let home = std::env::var("HOME").unwrap_or_default();
        if let Ok(other) = std::fs::read_to_string(".fixture-other-error") {
            eprint!(" Container openbot-desktop-server-1 Creating \n Container openbot-desktop-server-1 {other} \n{other}\n");
            std::process::exit(1);
        }
        let refusals: usize = std::fs::read_to_string(".fixture-refusals").unwrap().trim().parse().unwrap();
        if tries <= refusals {
            let said = format!("Error response from daemon: invalid mount config for type \"bind\": stat /host_mnt{home}/OpenBot/.openbot: operation not permitted");
            eprint!(" Network openbot-desktop_default Creating \n Network openbot-desktop_default Created \n Container openbot-desktop-postgres-1 Created \n Container openbot-desktop-migrate-1 Created \n Container openbot-desktop-server-1 Creating \n Container openbot-desktop-server-1 {said} \n{said}\n");
            std::process::exit(1);
        }
        return;
    }
    if scenario == "computer-stop" {
        let root = std::path::PathBuf::from(std::env::var("OPENBOT_TEST_ENGINE_RECORD").unwrap()).with_extension("");
        let race = root.join(".fixture-race").exists();
        let actual = if args.first().map(String::as_str) == Some("--connection") { &args[2..] } else { &args[..] };
        let without_file;
        let actual = if actual.get(1).map(String::as_str) == Some("-f") {
            without_file = std::iter::once(actual[0].clone()).chain(actual[3..].iter().cloned()).collect::<Vec<_>>();
            &without_file[..]
        } else { actual };
        match actual.first().map(String::as_str) {
            Some("compose") if actual.get(1).map(String::as_str) == Some("config") => {
                if std::path::Path::new(".fixture-config-failure").exists() { std::process::exit(17); }
                print!("{}", std::fs::read_to_string(".fixture-config").unwrap());
            }
            Some("compose") if actual == ["compose", "stop", "supervisor"] => {
                if root.join(".fixture-supervisor-stop-failure").exists() {
                    eprintln!("fixture supervisor stop refused");
                    std::process::exit(17);
                }
                if race {
                    // An in-flight create/restart completes before the supervisor exits.
                    std::fs::write(root.join("late.running"), "").unwrap();
                    std::fs::write(root.join("restarted.running"), "").unwrap();
                    std::fs::write(root.join("supervisor.stopped"), "").unwrap();
                }
            }
            Some("ps") => {
                // Model the engine's AND-label filtering over owned, other-namespace, and
                // non-supervisor rows. The connected proof separately exercises the real daemon.
                let mut labels = vec![
                    ("current", "true", "fixture-selected"),
                    ("other", "true", "fixture-other"),
                    ("unowned", "false", "fixture-selected"),
                    ("default", "true", "openbot"),
                ];
                if race {
                    labels.extend([("late", "true", "fixture-selected"), ("restarted", "true", "fixture-selected")]);
                }
                for (id, supervisor, namespace) in labels {
                    let matches = actual.windows(2).filter(|pair| pair[0] == "--filter").all(|pair| {
                        pair[1] == format!("label=openbot.supervisor={supervisor}")
                            || pair[1] == format!("label=openbot.namespace={namespace}")
                    });
                    if matches && (!race || root.join(format!("{id}.running")).exists()) { println!("{id}"); }
                }
                if race && !root.join("supervisor.stopped").exists() {
                    // The list is already fixed when the active supervisor creates these.
                    std::fs::write(root.join("late.running"), "").unwrap();
                    std::fs::write(root.join("restarted.running"), "").unwrap();
                }
            }
            Some("stop") => {
                if race {
                    for id in &actual[1..] {
                        std::fs::remove_file(root.join(format!("{id}.running"))).unwrap();
                    }
                    if !root.join("supervisor.stopped").exists() {
                        // A still-active supervisor can also restart an existing computer.
                        std::fs::write(root.join("current.running"), "").unwrap();
                    }
                }
            }
            Some("compose")
                if actual == ["compose", "--profile", "harness", "--profile", "openbot", "down"] => {
                if race {
                    std::fs::write(root.join("supervisor.stopped"), "").unwrap();
                    std::fs::write(root.join("stack.down"), "").unwrap();
                }
            }
            _ => std::process::exit(2),
        }
        return;
    }
    match (scenario.as_str(), joined.as_str()) {
        ("exit17", args) if args.starts_with("compose ps ") => {
            print!("agent-computer\tUp\n");
            eprint!("compose ps refused\n");
            std::process::exit(17);
        }
        ("empty", args) if args.starts_with("compose ps ") => {}
        ("blank-lines", args) if args.starts_with("compose ps ") => {
            print!("\n  \n\t\n");
        }
        ("empty-service", args) if args.starts_with("compose ps ") => {
            print!("\tExited\n");
        }
        ("empty-state", args) if args.starts_with("compose ps ") => {
            print!("agent-computer\t \n");
        }
        ("mixed", args) if args.starts_with("compose ps ") => {
            print!("agent-computer\tUp\nmigrate\tExited\nserver\tExited\n");
        }
        ("mixed", args) if args == "compose logs --tail 3 server" => {
            print!("line one\nlast reason\n");
        }
        _ => {
            eprintln!("unexpected: {joined}");
            std::process::exit(2);
        }
    }
}
"#;

    struct CleanupCommandFixture {
        previous_scenario: Option<std::ffi::OsString>,
        previous_root: Option<std::ffi::OsString>,
        previous_log: Option<std::ffi::OsString>,
        bin: PathBuf,
        log: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl CleanupCommandFixture {
        fn new(root: &Path) -> Self {
            static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let previous_scenario = std::env::var_os("DTA028_CLEANUP_SCENARIO");
            let previous_root = std::env::var_os("DTA028_CLEANUP_ROOT");
            let previous_log = std::env::var_os("DTA028_CLEANUP_LOG");
            let bin = temp_root("openbot-cleanup-command-bin");
            std::fs::create_dir_all(&bin).unwrap();
            let source = bin.join("cleanup_command.rs");
            std::fs::write(&source, CLEANUP_COMMAND_SOURCE).unwrap();
            let compiled = bin.join(if cfg!(windows) {
                "cleanup-command.exe"
            } else {
                "cleanup-command"
            });
            crate::test_support::compile_fixture(&source, &compiled);
            for name in ["lsof", "netstat", "taskkill", "powershell"] {
                std::fs::copy(
                    &compiled,
                    bin.join(if cfg!(windows) {
                        format!("{name}.exe")
                    } else {
                        name.to_string()
                    }),
                )
                .unwrap();
            }
            let log = bin.join("commands.log");
            std::env::set_var("DTA028_CLEANUP_ROOT", root);
            std::env::set_var("DTA028_CLEANUP_LOG", &log);
            Self {
                previous_scenario,
                previous_root,
                previous_log,
                bin,
                log,
                _guard: guard,
            }
        }

        fn command(&self, name: &str) -> PathBuf {
            self.bin.join(if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.to_string()
            })
        }

        fn scenario(&self, scenario: &str) {
            std::env::set_var("DTA028_CLEANUP_SCENARIO", scenario);
            let _ = std::fs::remove_file(&self.log);
        }

        fn log(&self) -> String {
            std::fs::read_to_string(&self.log).unwrap_or_default()
        }
    }

    impl Drop for CleanupCommandFixture {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous_scenario {
                std::env::set_var("DTA028_CLEANUP_SCENARIO", previous);
            } else {
                std::env::remove_var("DTA028_CLEANUP_SCENARIO");
            }
            if let Some(previous) = &self.previous_root {
                std::env::set_var("DTA028_CLEANUP_ROOT", previous);
            } else {
                std::env::remove_var("DTA028_CLEANUP_ROOT");
            }
            if let Some(previous) = &self.previous_log {
                std::env::set_var("DTA028_CLEANUP_LOG", previous);
            } else {
                std::env::remove_var("DTA028_CLEANUP_LOG");
            }
            std::fs::remove_dir_all(&self.bin).ok();
        }
    }

    const CLEANUP_COMMAND_SOURCE: &str = r#"
use std::io::Write;

fn log(program: &str, args: &[String]) {
    if let Ok(path) = std::env::var("DTA028_CLEANUP_LOG") {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        writeln!(file, "{program}\t{}", args.join(" ")).unwrap();
    }
}

fn main() {
    let exe = std::env::current_exe().unwrap();
    let program = exe.file_stem().unwrap().to_string_lossy().into_owned();
    let args: Vec<String> = std::env::args().skip(1).collect();
    log(&program, &args);
    let scenario = std::env::var("DTA028_CLEANUP_SCENARIO").unwrap();
    let root = std::env::var("DTA028_CLEANUP_ROOT").unwrap_or_default();
    match (program.as_str(), scenario.as_str()) {
        ("powershell", "legacy-evidence" | "legacy-evidence-v1") => {
            assert_eq!(args.len(), 4);
            assert_eq!(&args[..3], ["-NoProfile", "-NonInteractive", "-Command"]);
            assert!(args[3].contains("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate"));
            print!("{}", std::fs::read_to_string(std::path::Path::new(&root).join("synthetic-inventory.json")).unwrap());
        }
        ("taskkill", "legacy-evidence") => panic!("legacy PID evidence must never authorize taskkill"),
        ("taskkill", "legacy-evidence-v1") => assert_eq!(args, ["/PID", "9000", "/T", "/F"]),
        ("taskkill", "snapshot-reuse") => {
            if args.get(1).map(String::as_str) == Some("9001") {
                std::fs::write(std::path::Path::new(&root).join("foreign-replacement"), "9000").unwrap();
            }
        }
        ("netstat", "snapshot-reuse") => {
            assert!(std::path::Path::new(&root).join("foreign-replacement").exists());
            println!("TCP 127.0.0.1:3010 0.0.0.0:0 LISTENING 9000");
        }
        ("powershell", "held-refusal") => print!("{}", std::fs::read_to_string(std::path::Path::new(&root).join("synthetic-inventory.json")).unwrap()),
        ("netstat", "held-refusal") => {},
        ("powershell", "already-running" | "ownership-inventory" | "ownership-netstat-fail") => print!("{}", std::fs::read_to_string(std::path::Path::new(&root).join("synthetic-inventory.json")).unwrap()),
        ("netstat", "ownership-inventory" | "ownership-netstat-fail") => {
            // Model netstat's protocol filter at the command boundary: `-p tcp` excludes
            // IPv6 even though both address families use TCP in the output's Proto column.
            let protocol = if args == ["-ano"] {
                None
            } else if args == ["-ano", "-p", "tcp"] {
                Some(false)
            } else if args == ["-ano", "-p", "tcpv6"] {
                Some(true)
            } else {
                panic!("unexpected netstat arguments: {args:?}");
            };
            let listing = std::fs::read_to_string(std::path::Path::new(&root).join("synthetic-netstat.txt")).unwrap();
            for line in listing.lines() {
                let mut fields = line.split_whitespace();
                let proto = fields.next().unwrap_or_default();
                let local = fields.next().unwrap_or_default();
                if protocol.map_or(true, |ipv6| proto == "TCP" && local.starts_with('[') == ipv6) {
                    println!("{line}");
                }
            }
            if scenario == "ownership-netstat-fail" {
                eprintln!("synthetic netstat status failure after partial listing");
                std::process::exit(19);
            }
        },
        ("netstat", "already-running") => {
            println!("  Proto  Local Address          Foreign Address        State           PID");
            println!("  TCP    127.0.0.1:45123        0.0.0.0:0              LISTENING       9000");
            println!("  TCP    127.0.0.1:45124        0.0.0.0:0              LISTENING       9002");
        },
        ("taskkill", "held-refusal") => { eprintln!("synthetic held cleanup refused"); std::process::exit(5); },
        ("powershell", "inventory-fail") => {
            print!("synthetic partial inventory that must not be trusted");
            std::process::exit(17);
        }
        ("powershell", "inventory-empty") => print!("[]"),
        ("powershell", "inventory-malformed") => print!("[{{"),
        ("powershell", "inventory-blank") => {},
        ("netstat", "inventory-empty")
        | ("netstat", "pidfile-mixed")
        | ("netstat", "pidfile-ok") => {},
        ("taskkill", "pidfile-mixed") => {
            if args.iter().any(|arg| arg == "9000") {
                eprintln!("synthetic taskkill status failure");
                std::process::exit(17);
            }
        }
        ("taskkill", "pidfile-ok") => {},
        ("lsof", "lsof-ok") => {
            println!("p101\nn{root}/server\np202\nn{root}\np303\nn{root}/worker");
        }
        ("lsof", "lsof-empty") => {}
        ("lsof", "lsof-fail") => {
            eprintln!("synthetic lsof status failure");
            std::process::exit(17);
        }
        ("netstat", "windows-ok") | ("netstat", "windows-taskkill-fail") => {
            println!("  Proto  Local Address          Foreign Address        State           PID");
            println!("  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       9000");
            println!("  TCP    127.0.0.1:3010         0.0.0.0:0              LISTENING       9001");
        }
        ("netstat", "windows-netstat-fail") => {
            eprintln!("synthetic netstat status failure");
            std::process::exit(19);
        }
        ("taskkill", "windows-ok") => {}
        ("taskkill", "windows-taskkill-fail") => {
            if args.iter().any(|arg| arg == "9000") {
                eprintln!("synthetic taskkill status failure");
                std::process::exit(5);
            }
        }
        _ => {
            eprintln!("unexpected cleanup command scenario: {program} {scenario}");
            std::process::exit(44);
        }
    }
}
"#;

    #[test]
    fn service_inspection_spawn_failure_is_a_problem() {
        if crate::test_support::isolated_process(
            "stack::tests::service_inspection_spawn_failure_is_a_problem",
        ) {
            return;
        }
        let _fixture = PathFixture::with_broken_engine();
        let root = temp_root("openbot-service-inspection-spawn");
        std::fs::create_dir_all(&root).unwrap();

        let problem =
            services_that_exited(&Address::new(crate::engine::Engine::Docker, None), &root)
                .expect_err("a failed inspection command must stop startup");

        assert_eq!(
            problem.said,
            "OpenBot couldn't check on its own services. Try again."
        );
        assert!(
            problem
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("could not run docker compose ps -a")),
            "{problem:?}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn service_inspection_nonzero_status_is_a_problem() {
        if crate::test_support::isolated_process(
            "stack::tests::service_inspection_nonzero_status_is_a_problem",
        ) {
            return;
        }
        let _fixture = PathFixture::with_fake_engine("exit17");
        let root = temp_root("openbot-service-inspection-status");
        std::fs::create_dir_all(&root).unwrap();

        let problem =
            services_that_exited(&Address::new(crate::engine::Engine::Docker, None), &root)
                .expect_err("a nonzero inspection status must stop startup");

        assert_eq!(
            problem.said,
            "OpenBot couldn't check on its own services. Try again."
        );
        let detail = problem.detail.as_deref().unwrap_or_default();
        assert!(
            detail.contains("docker compose ps -a exited with status"),
            "{detail}"
        );
        assert!(detail.contains("compose ps refused"), "{detail}");
        assert!(detail.contains("agent-computer\tUp"), "{detail}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn service_inspection_empty_success_is_healthy() {
        if crate::test_support::isolated_process(
            "stack::tests::service_inspection_empty_success_is_healthy",
        ) {
            return;
        }
        let _fixture = PathFixture::with_fake_engine("empty");
        let root = temp_root("openbot-service-inspection-empty");
        std::fs::create_dir_all(&root).unwrap();

        let dead = services_that_exited(&Address::new(crate::engine::Engine::Docker, None), &root)
            .expect("a successful empty listing is healthy");

        assert!(dead.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn service_inspection_blank_lines_are_healthy_empty_output() {
        if crate::test_support::isolated_process(
            "stack::tests::service_inspection_blank_lines_are_healthy_empty_output",
        ) {
            return;
        }
        let _fixture = PathFixture::with_fake_engine("blank-lines");
        let root = temp_root("openbot-service-inspection-blank-lines");
        std::fs::create_dir_all(&root).unwrap();

        let dead = services_that_exited(&Address::new(crate::engine::Engine::Docker, None), &root)
            .expect("blank service inspection output is empty health evidence");

        assert!(dead.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_service_inspection_rows_are_a_problem() {
        if crate::test_support::isolated_process(
            "stack::tests::malformed_service_inspection_rows_are_a_problem",
        ) {
            return;
        }
        let root = temp_root("openbot-service-inspection-malformed");
        std::fs::create_dir_all(&root).unwrap();

        for scenario in ["empty-service", "empty-state"] {
            let _fixture = PathFixture::with_fake_engine(scenario);
            let problem =
                services_that_exited(&Address::new(crate::engine::Engine::Docker, None), &root)
                    .expect_err("a malformed nonempty row cannot prove health");

            assert_eq!(
                problem.said,
                "OpenBot couldn't check on its own services. Try again."
            );
            assert!(
                problem
                    .detail
                    .as_deref()
                    .is_some_and(|detail| detail.contains("unusable docker compose ps -a row")),
                "{problem:?}"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn service_inspection_reports_only_unexpected_exited_services() {
        if crate::test_support::isolated_process(
            "stack::tests::service_inspection_reports_only_unexpected_exited_services",
        ) {
            return;
        }
        let _fixture = PathFixture::with_fake_engine("mixed");
        let root = temp_root("openbot-service-inspection-rows");
        std::fs::create_dir_all(&root).unwrap();

        let dead = services_that_exited(&Address::new(crate::engine::Engine::Docker, None), &root)
            .expect("service inspection should succeed");

        assert_eq!(
            dead,
            vec![("server".to_string(), "last reason".to_string())]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(test)]
    #[test]
    fn windows_cleanup_returns_taskkill_failures_after_attempting_later_targets() {
        let recorded = [
            recorded_process("app", 9000, "/Date(1000)/"),
            recorded_process("worker", 9001, "/Date(2000)/"),
        ];
        let processes = [
            live_host_process("app", 9000, 7000, "/Date(1000)/"),
            live_host_process("worker", 9001, 7000, "/Date(2000)/"),
        ];
        let mut attempted = Vec::new();

        let problem = stop_verified_windows_roots_with(&recorded, &processes, |pid| {
            attempted.push(pid);
            if pid == 9000 {
                Err(Problem::with(
                    "OpenBot could not inspect or stop its host processes.",
                    format!("taskkill /PID {pid} /T /F exited with status 5"),
                ))
            } else {
                Ok(true)
            }
        })
        .expect_err("taskkill failure must be reported");

        assert_eq!(attempted, vec![9000, 9001]);
        assert_eq!(
            problem.said,
            "OpenBot could not inspect or stop its host processes."
        );
        assert!(
            problem
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("taskkill /PID 9000")),
            "{problem:?}"
        );
    }

    #[test]
    fn windows_cleanup_does_not_reuse_identity_after_terminating_the_root() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_cleanup_does_not_reuse_identity_after_terminating_the_root",
        ) {
            return;
        }
        let root = temp_root("windows-no-post-termination-sweep");
        std::fs::create_dir_all(&root).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("snapshot-reuse");
        let recorded = [recorded_process("app", 9001, "/Date(1000)/")];
        let snapshot = [
            live_host_process("app", 9001, 0, "/Date(1000)/"),
            live_host_process("app", 9000, 9001, "/Date(2000)/"),
        ];
        write_host_pid_file(
            &root,
            &serde_json::json!({"version":1,"processes":recorded}),
        )
        .unwrap();
        let result = stop_windows_processes_under_with(
            &root,
            &recorded,
            &snapshot,
            &fixture.command("taskkill"),
        );
        let log = fixture.log();
        let replacement_created = root.join("foreign-replacement").exists();
        std::fs::remove_dir_all(&root).unwrap();
        assert!(
            replacement_created,
            "fixture must replace the child after the owned root is stopped"
        );
        assert_eq!(result.unwrap(), 1);
        assert_eq!(
            log, "taskkill\t/PID 9001 /T /F\n",
            "a stopped process tree cannot authorize another taskkill"
        );
    }

    #[test]
    fn source_bound_windows_command_failures_use_disposable_commands() {
        if crate::test_support::isolated_process(
            "stack::tests::source_bound_windows_command_failures_use_disposable_commands",
        ) {
            return;
        }
        let root = temp_root("openbot-source-bound-windows-cleanup");
        std::fs::create_dir_all(&root).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        let taskkill = fixture.command("taskkill");
        let recorded = [
            recorded_process("app", 9000, "/Date(1000)/"),
            recorded_process("worker", 9001, "/Date(2000)/"),
        ];
        let processes = [
            live_host_process("app", 9000, 7000, "/Date(1000)/"),
            live_host_process("worker", 9001, 7000, "/Date(2000)/"),
            live_process(9002, 9000, "/Date(3000)/"),
        ];

        fixture.scenario("windows-taskkill-fail");
        let problem = stop_windows_processes_under_with(&root, &recorded, &processes, &taskkill)
            .expect_err("taskkill status failure must cross the production helper");
        let log = fixture.log();
        assert!(
            !log.contains("netstat\t"),
            "cleanup must not retarget terminated PIDs: {log}"
        );
        assert!(log.contains("taskkill\t/PID 9000 /T /F"), "{log}");
        assert!(
            log.contains("taskkill\t/PID 9001 /T /F"),
            "later owned target was not attempted: {log}"
        );
        assert!(
            problem
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("synthetic taskkill status failure")),
            "{problem:?}"
        );

        fixture.scenario("windows-ok");
        let stopped = stop_windows_processes_under_with(&root, &recorded, &processes, &taskkill)
            .expect("all synthetic Windows cleanup commands should succeed");
        assert_eq!(stopped, 2);
        let _ = std::fs::remove_dir_all(root);
    }

    fn windows_cleanup_evidence_fixture() -> (PathBuf, CleanupCommandFixture) {
        let root = temp_root("windows-cleanup-evidence");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("legacy-evidence");
        std::fs::write(
            root.join("synthetic-inventory.json"),
            serde_json::to_vec(&serde_json::json!([
                {"ProcessId":9000,"ParentProcessId":7000,"ExecutablePath":r"C:\Users\person\.bun\bin\bun.exe","CommandLine":host_command_line("server"),"CreationDate":"/Date(1000)/"}
            ]))
            .unwrap(),
        )
        .unwrap();
        (root, fixture)
    }

    #[test]
    fn windows_cleanup_retains_nonempty_legacy_pid_evidence_as_unresolved() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_cleanup_retains_nonempty_legacy_pid_evidence_as_unresolved",
        ) {
            return;
        }
        let (root, fixture) = windows_cleanup_evidence_fixture();
        let path = host_pids_path(&root);
        let original = b" \r\n[9000]\r\n";
        std::fs::write(&path, original).unwrap();
        let result = stop_windows_processes_with_inventory(
            &root,
            &fixture.command("powershell"),
            &fixture.command("taskkill"),
        );
        let retained = std::fs::read(&path).ok();
        let log = fixture.log();
        std::fs::remove_dir_all(&root).unwrap();
        assert!(!log.contains("taskkill\t"), "{log}");
        assert!(
            result.is_err(),
            "legacy cleanup returned {result:?}; evidence retained: {}; commands: {log}",
            retained.is_some()
        );
        let detail = result.unwrap_err().detail.unwrap();
        assert!(detail.contains("legacy"), "{detail}");
        assert!(detail.contains("unresolved"), "{detail}");
        assert!(detail.contains("retained"), "{detail}");
        assert!(detail.contains(&path.display().to_string()), "{detail}");
        assert_eq!(retained.as_deref(), Some(original.as_slice()));
    }

    #[test]
    fn windows_cleanup_missing_and_empty_legacy_evidence_are_safe_noops() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_cleanup_missing_and_empty_legacy_evidence_are_safe_noops",
        ) {
            return;
        }
        let (root, fixture) = windows_cleanup_evidence_fixture();
        let path = host_pids_path(&root);
        for original in [None, Some(" []\r\n")] {
            fixture.scenario("legacy-evidence");
            if let Some(original) = original {
                std::fs::write(&path, original).unwrap();
            }
            assert_eq!(
                stop_windows_processes_with_inventory(
                    &root,
                    &fixture.command("powershell"),
                    &fixture.command("taskkill"),
                )
                .unwrap(),
                0
            );
            assert!(!path.exists());
            let log = fixture.log();
            assert!(log.contains("powershell\t"), "{log}");
            assert!(!log.contains("taskkill\t"), "{log}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_cleanup_evidence_errors_preserve_files_without_commands() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_cleanup_evidence_errors_preserve_files_without_commands",
        ) {
            return;
        }
        let (root, fixture) = windows_cleanup_evidence_fixture();
        let path = host_pids_path(&root);
        for (original, reason) in [
            ("not json", "decode pidfile JSON"),
            (
                r#"{"version":9,"processes":[]}"#,
                "unsupported pidfile version 9",
            ),
        ] {
            std::fs::write(&path, original).unwrap();
            let problem = stop_windows_processes_with_inventory(
                &root,
                &fixture.command("powershell"),
                &fixture.command("taskkill"),
            )
            .unwrap_err();
            assert!(problem.detail.unwrap().contains(reason));
            assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
            assert!(fixture.log().is_empty());
        }
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        let problem = stop_windows_processes_with_inventory(
            &root,
            &fixture.command("powershell"),
            &fixture.command("taskkill"),
        )
        .unwrap_err();
        assert!(problem.detail.unwrap().contains("could not read pidfile"));
        assert!(path.is_dir());
        assert!(fixture.log().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_cleanup_versioned_evidence_still_requires_live_identity() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_cleanup_versioned_evidence_still_requires_live_identity",
        ) {
            return;
        }
        let (root, fixture) = windows_cleanup_evidence_fixture();
        let record = recorded_process("server", 9000, "/Date(1000)/");
        let original =
            serde_json::to_vec(&serde_json::json!({"version":1,"processes":[record]})).unwrap();
        let path = host_pids_path(&root);
        std::fs::write(&path, &original).unwrap();
        fixture.scenario("legacy-evidence-v1");
        assert_eq!(
            stop_windows_processes_with_inventory(
                &root,
                &fixture.command("powershell"),
                &fixture.command("taskkill"),
            )
            .unwrap(),
            1
        );
        assert!(!path.exists());
        assert!(fixture.log().contains("taskkill\t/PID 9000 /T /F"));

        std::fs::write(&path, &original).unwrap();
        std::fs::write(
            root.join("synthetic-inventory.json"),
            r#"[{"ProcessId":9000,"ParentProcessId":7000}]"#,
        )
        .unwrap();
        fixture.scenario("legacy-evidence");
        let problem = stop_windows_processes_with_inventory(
            &root,
            &fixture.command("powershell"),
            &fixture.command("taskkill"),
        )
        .unwrap_err();
        assert!(problem
            .detail
            .unwrap()
            .contains("lacks usable identity metadata"));
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert!(!fixture.log().contains("taskkill\t"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_pidfile_preserves_all_records_on_partial_failure_and_retries() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_pidfile_preserves_all_records_on_partial_failure_and_retries",
        ) {
            return;
        }
        let root = temp_root("windows-pidfile-retry");
        let recorded = [
            recorded_process("server", 9000, "/Date(1000)/"),
            recorded_process("worker", 9001, "/Date(2000)/"),
        ];
        let processes = [
            live_host_process("server", 9000, 0, "/Date(1000)/"),
            live_host_process("worker", 9001, 0, "/Date(2000)/"),
        ];
        write_host_pid_file(
            &root,
            &serde_json::json!({"version": 1, "processes": recorded}),
        )
        .unwrap();
        let path = host_pids_path(&root);
        let before = std::fs::read(&path).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("pidfile-mixed");
        let problem = stop_windows_processes_under_with(
            &root,
            &recorded,
            &processes,
            &fixture.command("taskkill"),
        )
        .expect_err("a failed root must retain ownership evidence for retry");
        assert!(problem.detail.unwrap().contains("17"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let log = fixture.log();
        assert!(log.contains("taskkill\t/PID 9000 /T /F"), "{log}");
        assert!(log.contains("taskkill\t/PID 9001 /T /F"), "{log}");

        fixture.scenario("pidfile-ok");
        let retry_records = recorded_host_processes(&root).unwrap();
        assert_eq!(
            stop_windows_processes_under_with(
                &root,
                &retry_records,
                &processes[..1],
                &fixture.command("taskkill")
            )
            .unwrap(),
            1
        );
        assert!(!path.exists());
        assert!(!fixture.log().contains("/PID 9001"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_pidfile_unknown_identity_is_preserved_without_killing_any_process() {
        if crate::test_support::isolated_process("stack::tests::windows_pidfile_unknown_identity_is_preserved_without_killing_any_process") { return; }
        let root = temp_root("windows-pidfile-unknown-identity");
        let recorded = [recorded_process("server", 9000, "/Date(1000)/")];
        write_host_pid_file(
            &root,
            &serde_json::json!({"version": 1, "processes": recorded}),
        )
        .unwrap();
        let path = host_pids_path(&root);
        let before = std::fs::read(&path).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        let mut cases: Vec<_> = [None, Some(String::new())]
            .into_iter()
            .flat_map(|missing| (0..3).map(move |field| (field, missing.clone())))
            .collect();
        cases.extend([
            (2, Some("invalid-date".to_string())),
            (2, Some("20260931010101.000000+000".to_string())),
        ]);
        for (field, missing) in cases {
            let mut live = live_process(9000, 0, "/Date(1000)/");
            match field {
                0 => live.executable_path = missing.clone(),
                1 => live.command_line = missing.clone(),
                _ => live.creation_date = missing.clone(),
            }
            fixture.scenario("pidfile-ok");
            let problem = stop_windows_processes_under_with(
                &root,
                &recorded,
                &[live],
                &fixture.command("taskkill"),
            )
            .expect_err("an unresolved identity field does not prove PID reuse or exit");
            let detail = problem.detail.unwrap();
            assert!(detail.contains("9000"), "{detail}");
            assert!(detail.contains(&path.display().to_string()), "{detail}");
            assert_eq!(std::fs::read(&path).unwrap(), before);
            assert_eq!(fixture.log(), "");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_pidfile_removal_requires_successful_cleanup_and_reports_remove_errors() {
        if crate::test_support::isolated_process("stack::tests::windows_pidfile_removal_requires_successful_cleanup_and_reports_remove_errors") { return; }
        let root = temp_root("windows-pidfile-remove");
        let recorded = [recorded_process("server", 9000, "/Date(1000)/")];
        let fixture = CleanupCommandFixture::new(&root);
        let path = host_pids_path(&root);
        for processes in [vec![], vec![live_process(9000, 0, "/Date(2000)/")]] {
            write_host_pid_file(
                &root,
                &serde_json::json!({"version": 1, "processes": recorded}),
            )
            .unwrap();
            fixture.scenario("pidfile-ok");
            assert_eq!(
                stop_windows_processes_under_with(
                    &root,
                    &recorded,
                    &processes,
                    &fixture.command("taskkill")
                )
                .unwrap(),
                0
            );
            assert!(!path.exists());
            assert!(!fixture.log().contains("taskkill\t"));
        }
        std::fs::create_dir(&path).unwrap();
        let problem =
            stop_windows_processes_under_with(&root, &[], &[], &fixture.command("taskkill"))
                .expect_err("a required pidfile removal failure must be reported");
        let detail = problem.detail.unwrap();
        assert!(detail.contains("could not remove pidfile"), "{detail}");
        assert!(detail.contains(&path.display().to_string()), "{detail}");
        assert!(path.is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(test)]
    #[test]
    fn windows_cleanup_success_counts_verified_root_trees() {
        let recorded = [recorded_process("app", 8636, "20260909010101.000000-420")];
        let processes = [
            live_process(8636, 7000, "20260909010101.000000-420"),
            live_process(9000, 8636, "20260909010102.000000-420"),
        ];
        let mut attempted = Vec::new();

        let stopped = stop_verified_windows_roots_with(&recorded, &processes, |pid| {
            attempted.push(pid);
            Ok(true)
        })
        .expect("verified child cleanup should succeed");

        assert_eq!(stopped, 1);
        assert_eq!(attempted, vec![8636]);
    }

    /// Real `netstat -ano` output, because the column layout is what went wrong.
    ///
    /// Stop reported success and left the server and the app serving, because this was read as four
    /// columns: the foreign address was taken for the state, the state for the pid, and nothing
    /// ever matched.
    #[test]
    #[cfg(not(unix))]
    fn the_processes_holding_our_ports_are_found_in_netstat_output() {
        let listing = "\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044\r\n  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       8748\r\n  TCP    127.0.0.1:3010         0.0.0.0:0              LISTENING       8636\r\n  TCP    127.0.0.1:3010         127.0.0.1:51888        ESTABLISHED     8636\r\n  TCP    [::1]:3010             [::]:0                 LISTENING       8636\r\n  TCP    127.0.0.1:5432         0.0.0.0:0              LISTENING       9999\r\n";
        let found = super::pids_listening_on(listing, &[3010, 3001]);
        // Both host processes, each once, and nothing else: not the established connection, not
        // Postgres on a published container port, not RPC on 135.
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found.contains(&8748), "{found:?}");
        assert!(found.contains(&8636), "{found:?}");
        assert!(
            !found.contains(&9999),
            "a container's port is not ours to kill: {found:?}"
        );
        assert!(!found.contains(&1044), "{found:?}");
    }

    #[test]
    fn only_recorded_openbot_pids_are_selected_from_netstat_output() {
        let listing = "\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       424242\r\n  TCP    127.0.0.1:3010         0.0.0.0:0              LISTENING       8636\r\n  TCP    [::1]:3010             [::]:0                 LISTENING       8636\r\n";
        let recorded = [recorded_process(
            "server",
            8636,
            "20260909010101.000000-420",
        )];
        let processes = [live_process(8636, 7000, "20260909010101.000000-420")];

        let found = super::verified_openbot_pids_listening_on(
            listing,
            &[3010, 3001],
            &recorded,
            &processes,
        );

        assert_eq!(found, vec![8636]);
    }

    #[cfg(unix)]
    fn spawn_owned_listener(label: &str) -> (std::process::Child, u16, PathBuf) {
        let dir = temp_root(label);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("listener.rs");
        std::fs::write(
            &source,
            r#"
use std::io::Write;
use std::net::TcpListener;
fn main() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    println!("{}", listener.local_addr().unwrap().port());
    std::io::stdout().flush().unwrap();
    std::thread::sleep(std::time::Duration::from_secs(60));
}
"#,
        )
        .unwrap();
        let binary = dir.join("listener");
        crate::test_support::compile_fixture(&source, &binary);
        let mut child = Command::new(&binary)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut port = String::new();
        use std::io::BufRead;
        std::io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut port)
            .unwrap();
        let port = port.trim().parse().unwrap();
        (child, port, dir)
    }

    #[cfg(unix)]
    #[test]
    fn unix_lsof_pid_parser_keeps_only_pid_fields_once() {
        let listing = "p111\nf3\nnTCP 127.0.0.1:3010 (LISTEN)\np222\nf4\np111\nnot-a-pid\npbad\n";
        assert_eq!(parse_lsof_pid_fields(listing), vec![111, 222]);
    }

    #[cfg(unix)]
    #[test]
    fn unix_recorded_server_ownership_requires_the_recorded_process_to_own_the_port() {
        let root_a = temp_root("unix-already-running-root-a");
        let root_b = temp_root("unix-already-running-root-b");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();
        let mut inert = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let (mut listener, port, listener_dir) =
            spawn_owned_listener("unix-already-running-listener-b");
        record_host_processes(&root_a, &[("server", inert.id())]).unwrap();
        record_host_processes(&root_b, &[("server", listener.id())]).unwrap();

        assert!(
            !recorded_server_owns_port(&root_a, port).unwrap(),
            "root A recorded a live server PID, but a different process owns the answering port"
        );
        assert!(
            recorded_server_owns_port(&root_b, port).unwrap(),
            "root B recorded the process that owns the answering port"
        );

        let _ = inert.kill();
        let _ = inert.wait();
        let _ = listener.kill();
        listener.wait().expect("reap owned listener");
        std::fs::remove_dir_all(listener_dir).expect("remove owned listener fixture");
        std::fs::remove_dir_all(root_a).unwrap();
        std::fs::remove_dir_all(root_b).unwrap();
    }

    #[test]
    fn recorded_server_ownership_requires_matching_identity_on_listening_port() {
        if crate::test_support::isolated_process(
            "stack::tests::recorded_server_ownership_requires_matching_identity_on_listening_port",
        ) {
            return;
        }
        let root = temp_root("openbot-already-running-windows-owner");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("already-running");
        let recorded = recorded_process("server", 9000, "20260909010101.000000-420");
        write_host_pid_file(
            &root,
            &serde_json::json!({"version":1,"processes":[recorded]}),
        )
        .unwrap();
        std::fs::write(
            root.join("synthetic-inventory.json"),
            serde_json::to_vec(&serde_json::json!([
                {"ProcessId":9000,"ParentProcessId":7000,"ExecutablePath":r"C:\Users\person\.bun\bin\bun.exe","CommandLine":host_command_line("server"),"CreationDate":"20260909010101.000000-420"},
                {"ProcessId":9002,"ParentProcessId":7000,"ExecutablePath":r"C:\Users\person\.bun\bin\bun.exe","CommandLine":host_command_line("server"),"CreationDate":"20260909020202.000000-420"}
            ]))
            .unwrap(),
        )
        .unwrap();

        assert!(recorded_process_owns_port_windows_with(
            &root,
            "server",
            45123,
            &fixture.command("powershell"),
            &fixture.command("netstat")
        )
        .unwrap());
        assert!(!recorded_process_owns_port_windows_with(
            &root,
            "server",
            45124,
            &fixture.command("powershell"),
            &fixture.command("netstat")
        )
        .unwrap());
        let log = fixture.log();
        assert!(log.contains("powershell\t"), "{log}");
        assert!(log.contains("netstat\t-ano\n"), "{log}");
        assert!(!log.contains("taskkill\t"), "{log}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recorded_server_ownership_is_false_without_current_records() {
        if crate::test_support::isolated_process(
            "stack::tests::recorded_server_ownership_is_false_without_current_records",
        ) {
            return;
        }
        let root = temp_root("openbot-already-running-no-owner");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("already-running");
        assert!(!recorded_process_owns_port_windows_with(
            &root,
            "server",
            45123,
            &fixture.command("powershell"),
            &fixture.command("netstat")
        )
        .unwrap());
        assert!(fixture.log().is_empty(), "{}", fixture.log());
        std::fs::remove_dir_all(root).unwrap();
    }

    fn probe_windows_port_ownership_fixture(
        listing: &str,
        scenario: &str,
    ) -> Result<bool, Problem> {
        let root = temp_root("windows-port-ownership");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario(scenario);
        let app = recorded_process("app", 9001, "20260909010101.000000-420");
        write_host_pid_file(&root, &serde_json::json!({"version":1,"processes":[app]})).unwrap();
        std::fs::write(
            root.join("synthetic-inventory.json"),
            serde_json::to_vec(&serde_json::json!([
                {"ProcessId":9001,"ParentProcessId":7000,"ExecutablePath":r"C:\Users\person\.bun\bin\bun.exe","CommandLine":host_command_line("app"),"CreationDate":"20260909010101.000000-420"},
                {"ProcessId":9000,"ParentProcessId":9001,"ExecutablePath":"synthetic-child.exe","CommandLine":"synthetic child","CreationDate":"20260909010102.000000-420"},
                {"ProcessId":9002,"ParentProcessId":7000,"ExecutablePath":"foreign.exe","CommandLine":"foreign app","CreationDate":"20260909010102.000000-420"}
            ]))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(root.join("synthetic-netstat.txt"), listing).unwrap();
        let result = recorded_process_owns_port_windows_with(
            &root,
            "app",
            45123,
            &fixture.command("powershell"),
            &fixture.command("netstat"),
        );
        let log = fixture.log();
        std::fs::remove_dir_all(root).unwrap();
        assert!(log.contains("powershell\t"), "{log}");
        assert!(log.contains("netstat\t"), "{log}");
        assert!(!log.contains("taskkill\t"), "{log}");
        result
    }

    #[test]
    fn windows_port_ownership_accepts_owned_ipv6_listener() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_port_ownership_accepts_owned_ipv6_listener",
        ) {
            return;
        }
        assert!(probe_windows_port_ownership_fixture(
            "TCP [::1]:45123 [::]:0 LISTENING 9000\n",
            "ownership-inventory",
        )
        .unwrap());
    }

    #[test]
    fn windows_port_ownership_rejects_foreign_ipv6_beside_owned_ipv4() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_port_ownership_rejects_foreign_ipv6_beside_owned_ipv4",
        ) {
            return;
        }
        assert!(!probe_windows_port_ownership_fixture(
            "TCP 127.0.0.1:45123 0.0.0.0:0 LISTENING 9000\n\
             TCP [::1]:45123 [::]:0 LISTENING 9002\n",
            "ownership-inventory",
        )
        .unwrap());
    }

    #[test]
    fn windows_port_ownership_accepts_owned_dual_stack_ignoring_udp_and_connections() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_port_ownership_accepts_owned_dual_stack_ignoring_udp_and_connections",
        ) {
            return;
        }
        assert!(probe_windows_port_ownership_fixture(
            "TCP 127.0.0.1:45123 0.0.0.0:0 LISTENING 9000\n\
             TCP [::1]:45123 [::]:0 LISTENING 9000\n\
             TCP [::1]:45123 [::1]:51999 ESTABLISHED 9002\n\
             UDP 127.0.0.1:45123 *:* 9002\n\
             UDP [::1]:45123 *:* 9002\n",
            "ownership-inventory",
        )
        .unwrap());
    }

    #[test]
    fn windows_port_ownership_reports_failed_netstat_with_partial_listing() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_port_ownership_reports_failed_netstat_with_partial_listing",
        ) {
            return;
        }
        let problem = probe_windows_port_ownership_fixture(
            "TCP 127.0.0.1:45123 0.0.0.0:0 LISTENING 9000\n",
            "ownership-netstat-fail",
        )
        .expect_err("partial command output cannot prove ownership");
        let detail = problem.detail.unwrap();
        assert!(detail.contains("netstat"), "{detail}");
        assert!(detail.contains("19"), "{detail}");
        assert!(
            detail.contains("synthetic netstat status failure after partial listing"),
            "{detail}"
        );
    }

    #[test]
    fn a_reused_recorded_pid_is_not_selected_without_matching_identity() {
        let listing = "\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       424242\r\n";
        let recorded = [recorded_process(
            "server",
            424242,
            "20260909010101.000000-420",
        )];
        let processes = [live_process(424242, 7000, "20260909020202.000000-420")];

        let found =
            super::verified_openbot_pids_listening_on(listing, &[3001], &recorded, &processes);

        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn a_verified_recorded_host_keeps_its_listening_child_eligible_for_cleanup() {
        let listing = "\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    127.0.0.1:3010         0.0.0.0:0              LISTENING       9000\r\n";
        let recorded = [recorded_process("app", 8636, "20260909010101.000000-420")];
        let processes = [
            live_process(8636, 7000, "20260909010101.000000-420"),
            live_process(9000, 8636, "20260909010102.000000-420"),
        ];

        let roots = super::verified_openbot_root_pids(&recorded, &processes);
        let found =
            super::verified_openbot_pids_listening_on(listing, &[3010], &recorded, &processes);

        assert_eq!(roots, vec![8636]);
        assert_eq!(found, vec![9000]);
    }

    struct UnserializablePidfile;

    impl Serialize for UnserializablePidfile {
        fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("synthetic serializer refusal"))
        }
    }

    #[test]
    fn pidfile_serialization_failure_preserves_prior_evidence() {
        let root = temp_root("pidfile-serialization");
        let path = host_pids_path(&root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"[42]").unwrap();
        let problem = write_host_pid_file(&root, &UnserializablePidfile).unwrap_err();
        let detail = problem.detail.unwrap();
        assert!(
            detail.contains("serialize pidfile") && detail.contains("synthetic serializer refusal")
        );
        assert!(detail.contains(&path.display().to_string()));
        assert_eq!(std::fs::read(&path).unwrap(), b"[42]");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pidfile_writes_report_filesystem_obstructions_without_partial_files() {
        let root = temp_root("pidfile-obstruction");
        std::fs::create_dir_all(&root).unwrap();
        let path = host_pids_path(&root);
        let logs = root.join(".logs");
        std::fs::write(&logs, b"prior obstruction").unwrap();
        let problem = record_host_pids(&root, &[42]).unwrap_err();
        let detail = problem.detail.unwrap();
        assert!(detail.contains(&path.display().to_string()));
        assert!(detail.contains("parent directory"));
        assert_eq!(std::fs::read(&logs).unwrap(), b"prior obstruction");
        std::fs::remove_file(&logs).unwrap();
        std::fs::create_dir_all(&path).unwrap();
        let problem = record_host_pids(&root, &[42]).unwrap_err();
        let detail = problem.detail.unwrap();
        assert!(detail.contains(&path.display().to_string()));
        assert!(detail.contains("replace pidfile"));
        assert!(path.is_dir());
        assert_eq!(std::fs::read_dir(&logs).unwrap().count(), 1);
        std::fs::remove_dir(&path).unwrap();
        record_host_pids(&root, &[42]).unwrap();
        record_host_pids(&root, &[43, 44]).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"[43,44]");
        assert_eq!(recorded_host_pids(&root).unwrap(), [43, 44]);
        assert_eq!(std::fs::read_dir(&logs).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn pidfile_denied_replacement_preserves_previous_record_and_removes_temporary() {
        let root = temp_root("pidfile-denied-replacement");
        record_host_pids(&root, &[42]).unwrap();
        let path = host_pids_path(&root);
        assert!(Command::new("/usr/bin/chflags")
            .arg("uchg")
            .arg(&path)
            .status()
            .unwrap()
            .success());
        let result = record_host_pids(&root, &[43]);
        // Release the fixture's immutable flag before assertions, including on a writer failure.
        assert!(Command::new("/usr/bin/chflags")
            .arg("nouchg")
            .arg(&path)
            .status()
            .unwrap()
            .success());
        let detail = result.unwrap_err().detail.unwrap();
        assert!(detail.contains("replace pidfile"), "{detail}");
        assert!(detail.contains(&path.display().to_string()));
        assert_eq!(std::fs::read(&path).unwrap(), b"[42]");
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The pids survive the window that started them, which is the whole point of writing them.
    #[test]
    fn recorded_pids_are_read_back_and_a_missing_file_is_not_an_error() {
        let dir = temp_root("pids");
        std::fs::create_dir_all(&dir).unwrap();

        // Nothing recorded is an empty list, not a panic: a deployment somebody started by hand
        // has no pidfile at all.
        assert!(recorded_host_pids(&dir).unwrap().is_empty());

        record_host_pids(&dir, &[4242, 4243, 4244]).unwrap();
        assert_eq!(recorded_host_pids(&dir).unwrap(), vec![4242, 4243, 4244]);

        // Corrupt evidence must stop cleanup before any process is selected.
        std::fs::write(host_pids_path(&dir), "not json").unwrap();
        assert!(recorded_host_pids(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pidfile_readers_distinguish_missing_legacy_records_and_untrusted_evidence() {
        let root = temp_root("pidfile-evidence");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let path = host_pids_path(&root);
        assert!(recorded_host_pids(&root).unwrap().is_empty());
        assert!(recorded_host_processes(&root).unwrap().is_empty());
        record_host_pids(&root, &[42]).unwrap();
        assert_eq!(recorded_host_pids(&root).unwrap(), [42]);
        let legacy = recorded_host_processes(&root).unwrap();
        assert!(verified_openbot_root_pids(&legacy, &[live_process(42, 0, "created")]).is_empty());
        let recorded = recorded_process("server", 42, "created");
        write_host_pid_file(
            &root,
            &serde_json::json!({"version": 1, "processes": [recorded]}),
        )
        .unwrap();
        assert_eq!(recorded_host_pids(&root).unwrap(), [42]);
        assert_eq!(recorded_host_processes(&root).unwrap(), [recorded]);
        for bytes in [
            b"not json".as_slice(),
            b"\xff",
            br#"{"version":2,"processes":[]}"#,
            br#"{"version":1,"processes":[{}]}"#,
        ] {
            std::fs::write(&path, bytes).unwrap();
            for problem in [
                recorded_host_pids(&root).unwrap_err(),
                recorded_host_processes(&root).unwrap_err(),
            ] {
                assert!(problem
                    .detail
                    .unwrap()
                    .contains(&path.display().to_string()));
            }
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(recorded_host_pids(&root)
            .unwrap_err()
            .detail
            .unwrap()
            .contains(&path.display().to_string()));
        assert!(recorded_host_processes(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_inventory_requires_a_complete_typed_json_result() {
        assert!(windows_processes_in("[]").unwrap().is_empty());
        let one = r#"{"ProcessId":42,"ParentProcessId":0,"ExecutablePath":"bun.exe","CommandLine":"bun serve","CreationDate":"created"}"#;
        assert_eq!(windows_processes_in(one).unwrap().len(), 1);
        assert_eq!(
            windows_processes_in(&format!("[{one},{one}]"))
                .unwrap()
                .len(),
            2
        );
        for text in [
            "",
            "  ",
            "null",
            "{}",
            "[{}]",
            "[",
            "[42]",
            r#"{"ProcessId":"42","ParentProcessId":0}"#,
        ] {
            assert!(windows_processes_in(text).is_err(), "{text}");
        }
        assert!(windows_processes_in(&format!("[{one},{{}}]")).is_err());
        for text in ["[]", one] {
            let expected = windows_processes_in(text).unwrap();
            let utf16: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
            assert_eq!(windows_process_output(&utf16).unwrap(), expected);
            assert_eq!(
                windows_process_output(&[&[0xff, 0xfe], utf16.as_slice()].concat()).unwrap(),
                expected
            );
            assert_eq!(
                windows_process_output(&[&[0xef, 0xbb, 0xbf], text.as_bytes()].concat()).unwrap(),
                expected
            );
        }
        for bytes in [b"\xff".as_slice(), b"\xff\xfe[", b"\xff\xfe\x00\xd8"] {
            assert!(windows_process_output(bytes).is_err());
        }
        let recorded = recorded_process("server", 42, "created");
        for live in [
            WindowsProcess {
                process_id: 43,
                ..live_process(42, 0, "created")
            },
            WindowsProcess {
                executable_path: Some("other.exe".into()),
                ..live_process(42, 0, "created")
            },
            WindowsProcess {
                command_line: Some("other args".into()),
                ..live_process(42, 0, "created")
            },
            live_process(42, 0, "reused"),
        ] {
            assert!(
                verified_openbot_root_pids(std::slice::from_ref(&recorded), &[live]).is_empty()
            );
        }
    }

    #[test]
    fn windows_recording_refuses_partial_inventory_without_replacing_pidfile() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_recording_refuses_partial_inventory_without_replacing_pidfile",
        ) {
            return;
        }
        let root = temp_root("windows-record-partial-inventory");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("held-refusal");
        let path = host_pids_path(&root);
        let prior = br#"{"version":1,"processes":[{"name":"server","pid":7000,"executable_path":"prior.exe","command_line":"prior","creation_date":"prior-created"}]}"#;
        std::fs::write(&path, prior).unwrap();
        std::fs::write(
            root.join("synthetic-inventory.json"),
            serde_json::to_vec(&serde_json::json!([
                {"ProcessId":42,"ParentProcessId":0,"ExecutablePath":"bun.exe","CommandLine":"bun src/index.ts","CreationDate":"created-server"},
                {"ProcessId":44,"ParentProcessId":0,"ExecutablePath":"bun.exe","CommandLine":"bun src/index.ts","CreationDate":"created-worker"},
                {"ProcessId":999,"ParentProcessId":0,"ExecutablePath":"other.exe","CommandLine":"other","CreationDate":"created-other"}
            ])).unwrap(),
        )
        .unwrap();

        let problem = record_windows_host_processes_with(
            &root,
            &[("server", 42), ("app", 43), ("worker", 44)],
            &fixture.command("powershell"),
        )
        .expect_err("a missing requested live pid must not produce partial ownership evidence");

        let detail = problem.detail.as_deref().unwrap_or_default();
        assert!(detail.contains("app") && detail.contains("43"), "{detail}");
        assert_eq!(std::fs::read(&path).unwrap(), prior);
        let log = fixture.log();
        assert!(
            log.contains("powershell\t-NoProfile -NonInteractive -Command"),
            "{log}"
        );
        assert!(
            !log.contains("taskkill\t") && !log.contains("netstat\t"),
            "{log}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_recording_refuses_incomplete_identity_without_replacing_pidfile() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_recording_refuses_incomplete_identity_without_replacing_pidfile",
        ) {
            return;
        }
        for (field, value) in [
            ("ExecutablePath", serde_json::Value::Null),
            ("CommandLine", serde_json::Value::Null),
            ("CreationDate", serde_json::Value::String(String::new())),
        ] {
            let root = temp_root("windows-record-incomplete-identity");
            std::fs::create_dir_all(root.join(".logs")).unwrap();
            let fixture = CleanupCommandFixture::new(&root);
            fixture.scenario("held-refusal");
            let path = host_pids_path(&root);
            let prior = b"[]";
            std::fs::write(&path, prior).unwrap();
            let mut row = serde_json::json!({
                "ProcessId":42,
                "ParentProcessId":0,
                "ExecutablePath":"bun.exe",
                "CommandLine":"bun src/index.ts",
                "CreationDate":"created-server"
            });
            row.as_object_mut()
                .unwrap()
                .insert(field.to_string(), value);
            std::fs::write(
                root.join("synthetic-inventory.json"),
                serde_json::to_vec(&serde_json::json!([row])).unwrap(),
            )
            .unwrap();

            let problem = record_windows_host_processes_with(
                &root,
                &[("server", 42)],
                &fixture.command("powershell"),
            )
            .expect_err("a requested pid with incomplete identity must not be omitted");

            let detail = problem.detail.as_deref().unwrap_or_default();
            assert!(
                detail.contains("server") && detail.contains("42"),
                "{detail}"
            );
            assert!(detail.contains("identity"), "{detail}");
            assert_eq!(std::fs::read(&path).unwrap(), prior);
            assert!(!fixture.log().contains("taskkill\t"));
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn windows_recording_refuses_duplicate_inventory_rows_without_replacing_pidfile() {
        if crate::test_support::isolated_process("stack::tests::windows_recording_refuses_duplicate_inventory_rows_without_replacing_pidfile") { return; }
        let root = temp_root("windows-record-duplicate-inventory");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("held-refusal");
        let path = host_pids_path(&root);
        let prior = b"[]";
        std::fs::write(&path, prior).unwrap();
        std::fs::write(
            root.join("synthetic-inventory.json"),
            serde_json::to_vec(&serde_json::json!([
                {"ProcessId":42,"ParentProcessId":0,"ExecutablePath":"first.exe","CommandLine":"first","CreationDate":"created-first"},
                {"ProcessId":42,"ParentProcessId":0,"ExecutablePath":"second.exe","CommandLine":"second","CreationDate":"created-second"}
            ]))
            .unwrap(),
        )
        .unwrap();

        let problem = record_windows_host_processes_with(
            &root,
            &[("server", 42)],
            &fixture.command("powershell"),
        )
        .expect_err("duplicate inventory rows for one pid cannot identify one process instance");

        let detail = problem.detail.as_deref().unwrap_or_default();
        assert!(
            detail.contains("more than once") && detail.contains("42"),
            "{detail}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), prior);
        let log = fixture.log();
        assert!(
            log.contains("powershell\t-NoProfile -NonInteractive -Command"),
            "{log}"
        );
        assert!(
            !log.contains("taskkill\t") && !log.contains("netstat\t"),
            "{log}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_recording_refuses_duplicate_requested_hosts_without_inventory_or_replacement() {
        if crate::test_support::isolated_process("stack::tests::windows_recording_refuses_duplicate_requested_hosts_without_inventory_or_replacement") { return; }
        let root = temp_root("windows-record-duplicate-request");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("held-refusal");
        let path = host_pids_path(&root);
        let prior = b"[]";
        std::fs::write(&path, prior).unwrap();

        let problem = record_windows_host_processes_with(
            &root,
            &[("server", 42), ("server", 43)],
            &fixture.command("powershell"),
        )
        .expect_err("duplicate requested host names must not replace ownership evidence");

        let detail = problem.detail.as_deref().unwrap_or_default();
        assert!(
            detail.contains("duplicate") && detail.contains("server"),
            "{detail}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), prior);
        assert_eq!(fixture.log(), "");

        let problem = record_windows_host_processes_with(
            &root,
            &[("server", 42), ("app", 42)],
            &fixture.command("powershell"),
        )
        .expect_err("duplicate requested pids must not replace ownership evidence");
        let detail = problem.detail.as_deref().unwrap_or_default();
        assert!(
            detail.contains("duplicate") && detail.contains("42"),
            "{detail}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), prior);
        assert_eq!(fixture.log(), "");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_recording_writes_all_requested_records_and_ignores_extra_rows() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_recording_writes_all_requested_records_and_ignores_extra_rows",
        ) {
            return;
        }
        let root = temp_root("windows-record-complete-inventory");
        std::fs::create_dir_all(&root).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("held-refusal");
        std::fs::write(
            root.join("synthetic-inventory.json"),
            serde_json::to_vec(&serde_json::json!([
                {"ProcessId":42,"ParentProcessId":0,"ExecutablePath":"server.exe","CommandLine":"server args","CreationDate":"created-server"},
                {"ProcessId":43,"ParentProcessId":0,"ExecutablePath":"app.exe","CommandLine":"app args","CreationDate":"created-app"},
                {"ProcessId":44,"ParentProcessId":0,"ExecutablePath":"worker.exe","CommandLine":"worker args","CreationDate":"created-worker"},
                {"ProcessId":999,"ParentProcessId":0,"ExecutablePath":"other.exe","CommandLine":"other args","CreationDate":"created-other"}
            ])).unwrap(),
        )
        .unwrap();

        record_windows_host_processes_with(
            &root,
            &[("server", 42), ("app", 43), ("worker", 44)],
            &fixture.command("powershell"),
        )
        .unwrap();

        let records = recorded_host_processes(&root).unwrap();
        assert_eq!(records.len(), 3);
        assert_eq!(
            records[0],
            RecordedHostProcess {
                name: "server".to_string(),
                pid: 42,
                executable_path: "server.exe".to_string(),
                command_line: "server args".to_string(),
                creation_date: "created-server".to_string(),
            }
        );
        assert_eq!(
            records[1],
            RecordedHostProcess {
                name: "app".to_string(),
                pid: 43,
                executable_path: "app.exe".to_string(),
                command_line: "app args".to_string(),
                creation_date: "created-app".to_string(),
            }
        );
        assert_eq!(
            records[2],
            RecordedHostProcess {
                name: "worker".to_string(),
                pid: 44,
                executable_path: "worker.exe".to_string(),
                command_line: "worker args".to_string(),
                creation_date: "created-worker".to_string(),
            }
        );
        assert!(!records.iter().any(|record| record.pid == 999));
        let log = fixture.log();
        assert!(
            log.contains("powershell\t-NoProfile -NonInteractive -Command"),
            "{log}"
        );
        assert!(
            !log.contains("taskkill\t") && !log.contains("netstat\t"),
            "{log}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_inventory_command_errors_preserve_pidfiles_and_select_no_processes() {
        if crate::test_support::isolated_process("stack::tests::windows_inventory_command_errors_preserve_pidfiles_and_select_no_processes") { return; }
        let root = temp_root("inventory-command-evidence");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        let powershell = fixture.command("powershell");
        let taskkill = fixture.command("taskkill");
        let path = host_pids_path(&root);
        for scenario in ["inventory-fail", "inventory-malformed", "inventory-blank"] {
            fixture.scenario(scenario);
            std::fs::write(&path, "[]").unwrap();
            assert!(windows_processes_with(&powershell).is_err());
            assert!(stop_windows_processes_with_inventory(&root, &powershell, &taskkill).is_err());
            assert!(
                record_windows_host_processes_with(&root, &[("server", 42)], &powershell).is_err()
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "[]");
            let log = fixture.log();
            assert!(
                log.contains("powershell\t-NoProfile -NonInteractive -Command"),
                "{log}"
            );
            assert!(log.contains("$ErrorActionPreference = 'Stop'"), "{log}");
            assert!(log.contains("-InputObject @("), "{log}");
            assert!(
                !log.contains("taskkill\t") && !log.contains("netstat\t"),
                "{log}"
            );
        }
        let missing = root.join("no-powershell");
        assert!(windows_processes_with(&missing).is_err());
        assert!(stop_windows_processes_with_inventory(&root, &missing, &taskkill).is_err());
        assert!(record_windows_host_processes_with(&root, &[("server", 42)], &missing).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[]");
        fixture.scenario("inventory-empty");
        std::fs::write(&path, "invalid").unwrap();
        assert!(stop_windows_processes_with_inventory(&root, &powershell, &taskkill).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "invalid");
        assert_eq!(fixture.log(), "");
        std::fs::write(&path, "[]").unwrap();
        assert_eq!(
            stop_windows_processes_with_inventory(&root, &powershell, &taskkill).unwrap(),
            0
        );
        assert!(!fixture.log().contains("taskkill\t"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_root_is_named_rather_than_left_to_errno() {
        let missing = std::env::temp_dir().join("openbot-not-here-at-all");
        let problem = deployment_problem(&missing).expect("a missing root is a problem");
        assert!(problem.contains("does not exist"), "{problem}");
        assert!(!problem.contains("os error"), "leaked an errno: {problem}");
    }

    #[test]
    fn a_directory_that_is_not_a_deployment_says_which_part_is_missing() {
        let dir = temp_root("empty");
        std::fs::create_dir_all(&dir).unwrap();

        let problem = deployment_problem(&dir).expect("an empty directory is not a deployment");
        assert!(problem.contains("docker-compose.yml"), "{problem}");

        std::fs::write(dir.join("docker-compose.yml"), "services: {}\n").unwrap();
        assert_eq!(
            deployment_problem(&dir),
            None,
            "the containers run from their images: no server, app or worker folder is needed"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_deployment_directory_pasted_with_a_stray_space_is_the_one_it_names() {
        // The fifth value on the setup screen that trimming missed. The screen enables Start on
        // `root.trim() !== ""` and then sends the untrimmed string, which is exactly what the API
        // URL, the gateway URL, the intelligence key and the model key were rescued from.
        //
        // A trailing space is a second directory beside the one everything else means: the tray's
        // Stop and the next launch both ask `default_root`, which has no space in it. A leading one
        // is worse, because a path that begins with a space does not begin with a separator: the
        // whole deployment stops being absolute and lands under wherever the window is running
        // from.
        assert_eq!(
            root_from("  /home/me/OpenBot  "),
            PathBuf::from("/home/me/OpenBot")
        );
        assert_eq!(
            root_from("/home/me/OpenBot\n"),
            PathBuf::from("/home/me/OpenBot")
        );
        assert!(
            root_from(" /home/me/OpenBot").has_root(),
            "a leading space turned an absolute path into a relative one"
        );
    }

    #[test]
    fn a_space_inside_the_path_is_part_of_the_path() {
        // Only the ends. "Documents and Settings" is a directory, and a person whose home has a
        // space in it must still be able to say where OpenBot lives.
        assert_eq!(
            root_from("/home/me/My Files/OpenBot"),
            PathBuf::from("/home/me/My Files/OpenBot")
        );
        assert_eq!(
            root_from(r"C:\Users\me\Open Bot"),
            PathBuf::from(r"C:\Users\me\Open Bot")
        );
        // And an ordinary path is handed back exactly as it was.
        assert_eq!(
            root_from("/home/me/OpenBot"),
            PathBuf::from("/home/me/OpenBot")
        );
    }

    #[test]
    fn a_port_nobody_holds_is_not_reported_as_taken() {
        let _ports = crate::test_support::hold_ports();
        // 0 is never listening; this asserts the check does not invent a problem.
        assert!(port_already_taken(&[("nothing", 1)]).is_none());
    }

    /// The published side of a mapping, which is the only side anything on this machine binds.
    /// The personal edition: one computer, no supervisor, and no bundled Bot, whatever the model.
    #[test]
    fn the_personal_edition_raises_one_computer_and_no_bundled_bot() {
        for service in ["supervisor", "agent-bot", "agent-langgraph"] {
            assert!(!SERVICES.contains(&service), "{service} is started");
            assert!(
                !selected_services(true).contains(&service),
                "{service} is started"
            );
        }
        assert!(SERVICES.contains(&"agent-computer"));
        assert!(!selected_services(false).contains(&"agent-harness"));
        assert!(selected_services(true).contains(&"agent-harness"));
    }

    /// Stop has to name both profiles, or what sits behind them keeps running: the one Bot the
    /// person picked, and OpenBot's own server and worker.
    #[test]
    fn stopping_names_the_harness_and_openbot_profiles() {
        let source = include_str!("stack.rs");
        let down = &source[source.find("pub fn down(").unwrap()..];
        let down = &down[..down.find("\n}\n").unwrap()];
        assert_eq!(
            down.matches(r#""--profile","#).count(),
            2,
            "compose down without a profile leaves that profile's services running"
        );
        assert!(
            down.contains(r#""harness","#),
            "agent-harness keeps running"
        );
        assert!(
            down.contains("OPENBOT_PROFILE,"),
            "server and worker keep running"
        );
        assert_eq!(OPENBOT_PROFILE, "openbot");
    }

    #[test]
    fn the_published_ports_are_read_off_a_real_listing() {
        // Verbatim from `compose ps --format '{{.Ports}}'` against a running deployment.
        let listing = "127.0.0.1:4200->4200/tcp, [::1]:4200->4200/tcp\n\
                       127.0.0.1:4206->4206/tcp, [::1]:4206->4206/tcp\n\
                       127.0.0.1:5544->5432/tcp, [::1]:5544->5432/tcp\n";
        let found = published_in(listing);
        assert!(found.contains(&4200) && found.contains(&4206));
        // The published port, not the one inside the container: nothing on this machine binds 5432.
        assert!(found.contains(&5544), "the published side was missed");
        assert!(
            !found.contains(&5432),
            "the container's own port was taken as published"
        );
        assert_eq!(found, std::collections::HashSet::from([4200, 4206, 5544]));
    }

    #[test]
    fn published_ports_include_every_ipv4_only_row() {
        let listing = "127.0.0.1:4200->3000/tcp\r\n\
                       \r\n\
                       127.0.0.1:4206->3001/tcp\r\n\
                       127.0.0.1:5544->5432/tcp\r\n";
        assert_eq!(
            published_in(listing),
            std::collections::HashSet::from([4200, 4206, 5544])
        );
    }

    #[test]
    fn multiline_published_ports_exempt_owned_listeners_but_reject_foreign_listener() {
        let _ports = crate::test_support::hold_ports();
        let listeners = [(); 4].map(|()| std::net::TcpListener::bind("127.0.0.1:0").unwrap());
        let [first, second, third, foreign] = listeners
            .each_ref()
            .map(|listener| listener.local_addr().unwrap().port());
        let listing = format!(
            "127.0.0.1:{first}->{foreign}/tcp\n\
             127.0.0.1:{second}->{foreign}/tcp\n\
             127.0.0.1:{third}->{foreign}/tcp\n"
        );
        let ours = published_in(&listing);
        let owned_ports = [("API server", first), ("Bot", second), ("Database", third)];

        assert!(port_already_taken(&owned_ports).is_some());
        assert_eq!(
            port_already_taken_except(&owned_ports, &ours),
            None,
            "every published host port must be exempted across all Compose rows"
        );
        let problem = port_already_taken_except(&[("Foreign server", foreign)], &ours)
            .expect("a container-side port must not exempt an unrelated host listener");
        assert!(problem.contains(&foreign.to_string()), "{problem}");
        assert!(problem.contains("Foreign server"), "{problem}");
    }

    /// A service with no published ports says nothing rather than confusing the parser.
    #[test]
    fn a_listing_with_nothing_published_yields_nothing() {
        assert!(published_in("").is_empty());
        assert!(published_in("4206/tcp").is_empty());
    }

    /**
    A port this deployment already publishes is not a stranger on the port.

    The measured failure: a start that fell over after `compose up` left the harness container
    running, and the next attempt refused because of it, naming a port the person never chose.
    */
    #[test]
    fn our_own_published_port_is_not_a_conflict() {
        let _ports = crate::test_support::hold_ports();
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = held.local_addr().unwrap().port();
        assert!(port_already_taken(&[("Bot you picked", port)]).is_some());
        let ours = std::collections::HashSet::from([port]);
        assert_eq!(
            port_already_taken_except(&[("Bot you picked", port)], &ours),
            None,
            "a container this deployment started was treated as somebody else"
        );
    }

    #[test]
    fn a_held_port_is_named_along_with_what_uses_it() {
        let _ports = crate::test_support::hold_ports();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let problem =
            port_already_taken(&[("API server", port)]).expect("a held port is a problem");
        assert!(problem.contains(&port.to_string()), "{problem}");
        assert!(
            problem.contains("API server"),
            "must say what it is for: {problem}"
        );
    }

    #[test]
    fn an_ipv6_only_port_is_named_unless_this_deployment_already_publishes_it() {
        let _ports = crate::test_support::hold_ports();
        let Some(listener) = ipv6_loopback_listener() else {
            return;
        };
        let port = listener.local_addr().unwrap().port();
        let ports = [("API server", port)];

        let problem = port_already_taken(&ports).expect("an IPv6-only listener is a conflict");
        assert!(problem.contains(&port.to_string()), "{problem}");
        assert!(problem.contains("API server"), "{problem}");
        assert_eq!(
            port_already_taken_except(&ports, &std::collections::HashSet::from([port])),
            None
        );

        drop(listener);
        wait_for_ports_to_clear(&[port], std::time::Duration::from_secs(3));
        assert_eq!(port_already_taken(&ports), None);
    }

    #[test]
    fn an_ipv6_only_port_is_not_clear_while_its_listener_is_held() {
        let _ports = crate::test_support::hold_ports();
        let Some(listener) = ipv6_loopback_listener() else {
            return;
        };
        let port = listener.local_addr().unwrap().port();
        let patience = std::time::Duration::from_millis(250);
        let started = std::time::Instant::now();

        wait_for_ports_to_clear(&[port], patience);

        assert!(
            started.elapsed() >= patience,
            "the wait returned while the IPv6 listener still held the port"
        );
        drop(listener);
        let started = std::time::Instant::now();
        let patience = std::time::Duration::from_secs(3);
        wait_for_ports_to_clear(&[port], patience);
        assert!(started.elapsed() < patience, "a released port kept waiting");
    }

    #[test]
    fn telemetry_overlay_requires_native_identity_and_the_personal_edition() {
        let root = temp_root("telemetry-edition-policy");
        std::fs::create_dir_all(&root).unwrap();
        let desktop = Secrets::from([("OPENBOT_DISTRIBUTION".into(), "desktop".into())]);
        let opted_out = Secrets::from([("COPILOTKIT_TELEMETRY_DISABLED".into(), "1".into())]);
        for edition in ["", "OPENBOT_EDITION=team\n", "OPENBOT_EDITION=enterprise\n"] {
            std::fs::write(root.join(".env"), edition).unwrap();
            assert!(!uses_desktop_telemetry(&root, &desktop));
            assert!(!uses_desktop_telemetry(&root, &opted_out));
        }
        std::fs::write(root.join(".env"), "OPENBOT_EDITION=personal\n").unwrap();
        assert!(!uses_desktop_telemetry(&root, &Secrets::new()));
        assert!(uses_desktop_telemetry(&root, &desktop));
        assert!(uses_desktop_telemetry(&root, &opted_out));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn desktop_telemetry_is_selected_only_by_personal_native_startup() {
        if crate::test_support::isolated_process(
            "stack::tests::desktop_telemetry_is_selected_only_by_personal_native_startup",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("macos-podman-start");
        let (root, _) = computer_stop_root(&path, "telemetry-start", "{}");
        std::fs::write(root.join("docker-compose.override.yml"), "services: {}\n").unwrap();
        let settings = "OPENBOT_EDITION=personal\n";
        std::fs::write(root.join(".env"), settings).unwrap();
        for secrets in [
            Secrets::from([
                ("OPENBOT_DISTRIBUTION".into(), "desktop".into()),
                (
                    "CPK_TELEMETRY_ID".into(),
                    "12345678-1234-4123-8123-123456789012".into(),
                ),
            ]),
            Secrets::from([("COPILOTKIT_TELEMETRY_DISABLED".into(), "1".into())]),
        ] {
            for os in ["macos", "windows", "linux"] {
                let command = compose_start_command(
                    &Address::new(crate::engine::Engine::Docker, None),
                    &root,
                    &secrets,
                    os,
                )
                .unwrap();
                let args: Vec<_> = command
                    .get_args()
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .collect();
                let mut expected = vec![
                    "compose",
                    "-f",
                    "docker-compose.yml",
                    "-f",
                    DESKTOP_TELEMETRY_FILE,
                    "-f",
                    "docker-compose.override.yml",
                ];
                if desktop_telemetry_disabled(&secrets) {
                    expected.extend(["-f", DESKTOP_TELEMETRY_DISABLED_FILE]);
                }
                assert_eq!(args, expected);
                assert_eq!(
                    std::fs::read_to_string(root.join(DESKTOP_TELEMETRY_FILE)).unwrap(),
                    DESKTOP_TELEMETRY
                );
                assert_eq!(
                    std::fs::read_to_string(root.join(".env")).unwrap(),
                    settings
                );
            }
        }
        // Optional telemetry cannot block startup when its generated file cannot be written.
        std::fs::remove_file(root.join(DESKTOP_TELEMETRY_FILE)).unwrap();
        std::fs::create_dir(root.join(DESKTOP_TELEMETRY_FILE)).unwrap();
        let command = compose_start_command(
            &Address::new(crate::engine::Engine::Docker, None),
            &root,
            &Secrets::from([("OPENBOT_DISTRIBUTION".into(), "desktop".into())]),
            "linux",
        )
        .unwrap();
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "compose",
                "-f",
                "docker-compose.yml",
                "-f",
                "docker-compose.override.yml"
            ]
        );
        std::fs::remove_dir(root.join(DESKTOP_TELEMETRY_FILE)).unwrap();
        // An older provider lacking the optional probe must not block ordinary startup.
        std::fs::write(root.join(".fixture-config-failure"), "unsupported probe").unwrap();
        let command = compose_start_command(
            &Address::new(crate::engine::Engine::Docker, None),
            &root,
            &Secrets::from([("OPENBOT_DISTRIBUTION".into(), "desktop".into())]),
            "linux",
        )
        .unwrap();
        assert_eq!(command.get_args().collect::<Vec<_>>(), ["compose"]);
        // An opted-out person is never kept from starting by an optional probe either: OpenBot
        // starts as Compose finds it, with no desktop identity handed to the server.
        let command = compose_start_command(
            &Address::new(crate::engine::Engine::Docker, None),
            &root,
            &Secrets::from([("COPILOTKIT_TELEMETRY_DISABLED".into(), "1".into())]),
            "linux",
        )
        .expect("an opted-out Start must not fail on the optional Compose probe");
        assert_eq!(command.get_args().collect::<Vec<_>>(), ["compose"]);
        std::fs::remove_file(root.join(".fixture-config-failure")).unwrap();
        // Nor by an override file that cannot be written: the opt-out override is still applied.
        std::fs::remove_file(root.join(DESKTOP_TELEMETRY_FILE)).ok();
        std::fs::create_dir(root.join(DESKTOP_TELEMETRY_FILE)).unwrap();
        let command = compose_start_command(
            &Address::new(crate::engine::Engine::Docker, None),
            &root,
            &Secrets::from([("COPILOTKIT_TELEMETRY_DISABLED".into(), "1".into())]),
            "linux",
        )
        .expect("an opted-out Start must not fail on an unwritable telemetry override");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "compose",
                "-f",
                "docker-compose.yml",
                "-f",
                "docker-compose.override.yml",
                "-f",
                DESKTOP_TELEMETRY_DISABLED_FILE
            ]
        );
        std::fs::remove_dir(root.join(DESKTOP_TELEMETRY_FILE)).unwrap();
        // And when the opt-out override itself cannot be written, OpenBot still starts.
        std::fs::remove_file(root.join(DESKTOP_TELEMETRY_DISABLED_FILE)).ok();
        std::fs::create_dir(root.join(DESKTOP_TELEMETRY_DISABLED_FILE)).unwrap();
        assert!(compose_start_command(
            &Address::new(crate::engine::Engine::Docker, None),
            &root,
            &Secrets::from([("COPILOTKIT_TELEMETRY_DISABLED".into(), "1".into())]),
            "linux",
        )
        .is_ok());
        std::fs::remove_dir(root.join(DESKTOP_TELEMETRY_DISABLED_FILE)).unwrap();
        // A file left from a personal launch is never auto-selected for the team edition.
        std::fs::write(root.join(".env"), "OPENBOT_EDITION=team\n").unwrap();
        let command = compose_start_command(
            &Address::new(crate::engine::Engine::Docker, None),
            &root,
            &Secrets::from([("OPENBOT_DISTRIBUTION".into(), "desktop".into())]),
            "linux",
        )
        .unwrap();
        assert_eq!(command.get_args().collect::<Vec<_>>(), ["compose"]);
    }

    #[test]
    fn compose_port_overlay_is_limited_to_macos_podman() {
        let root = temp_root("compose-platform-policy");
        let secrets = Secrets::from([("SYNTHETIC_SETTING".into(), "preserved".into())]);
        for (engine, os) in [
            (crate::engine::Engine::Docker, "macos"),
            (crate::engine::Engine::Docker, "linux"),
            (crate::engine::Engine::Docker, "windows"),
            (crate::engine::Engine::Podman, "linux"),
            (crate::engine::Engine::Podman, "windows"),
        ] {
            let command =
                compose_start_command(&Address::new(engine, None), &root, &secrets, os).unwrap();
            assert_eq!(command.get_args().collect::<Vec<_>>(), ["compose"]);
            assert_eq!(command.get_current_dir(), Some(root.as_path()));
            assert!(command
                .get_envs()
                .any(|(key, value)| key == "SYNTHETIC_SETTING"
                    && value == Some(std::ffi::OsStr::new("preserved"))));
            assert!(
                !root.exists(),
                "{engine:?} on {os} must not write a Mac Podman overlay"
            );
        }
    }

    #[test]
    fn compose_port_overlay_preserves_discovery_and_explicit_file_selection() {
        let root = temp_root("compose-file-selection");
        std::fs::create_dir_all(&root).unwrap();
        for file in ["docker-compose.yml", "docker-compose.override.yml"] {
            std::fs::write(root.join(file), "services: {}\n").unwrap();
        }
        assert_eq!(
            compose_files(&root, "").unwrap(),
            ["docker-compose.yml", "docker-compose.override.yml"]
        );
        std::fs::write(root.join("compose.yaml"), "services: {}\n").unwrap();
        std::fs::write(root.join("compose.override.yml"), "services: {}\n").unwrap();
        assert_eq!(
            compose_files(&root, "").unwrap(),
            ["compose.yaml", "compose.override.yml"]
        );
        assert_eq!(
            compose_files(
                &root,
                "COMPOSE_FILE=first.yml:folder/custom file.yml\nCOMPOSE_PATH_SEPARATOR=:\n"
            )
            .unwrap(),
            ["first.yml", "folder/custom file.yml"]
        );
        assert_eq!(
            compose_files(
                &root,
                "COMPOSE_FILE=first.yml|custom.yml\nCOMPOSE_PATH_SEPARATOR=|\n"
            )
            .unwrap(),
            ["first.yml", "custom.yml"]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn dynamic_harness_overlay_keeps_container_port_and_loopback_policy() {
        let root = temp_root("dynamic-harness-port");
        std::fs::create_dir_all(&root).unwrap();
        assert!(harness_port_overlay(&root, false).unwrap().is_none());
        std::fs::write(
            root.join(".env"),
            "PICKED_HARNESS_PORT=4206\nPICKED_HARNESS_HOST_PORT=52106\n",
        )
        .unwrap();
        let dual = harness_port_overlay(&root, false).unwrap().unwrap();
        assert!(dual.contains("ports: !override"));
        assert!(dual.contains("127.0.0.1:52106:4206"));
        assert!(dual.contains("[::1]:52106:4206"));
        let mac_podman = harness_port_overlay(&root, true).unwrap().unwrap();
        assert!(mac_podman.contains("127.0.0.1:52106:4206"));
        assert!(!mac_podman.contains("[::1]"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "requires Docker Compose; configuration only, no running engine needed"]
    fn dynamic_harness_port_is_applied_by_real_compose_without_changing_container_ports() {
        let root = temp_root("dynamic-harness-compose");
        std::fs::create_dir_all(&root).unwrap();
        let source = include_str!("../../../docker-compose.yml");
        std::fs::write(root.join("docker-compose.yml"), source).unwrap();
        std::fs::write(
            root.join("docker-compose.override.yml"),
            "services:\n  agent-harness:\n    labels:\n      regression: preserved\n",
        )
        .unwrap();
        std::fs::write(root.join(".env"), "PICKED_HARNESS_IMAGE=synthetic:local\nPICKED_HARNESS_PORT=4206\nPICKED_HARNESS_HOST_PORT=52106\nPOSTGRES_PORT=55432\n").unwrap();
        let command = compose_start_command(
            &Address::new(crate::engine::Engine::Docker, None),
            &root,
            &Secrets::new(),
            "windows",
        )
        .unwrap();
        let output = {
            let mut command = command;
            command
                .args(["--profile", "*", "config", "--format", "json"])
                .output()
                .unwrap()
        };
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let config: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let harness = &config["services"]["agent-harness"];
        assert_eq!(harness["labels"]["regression"], "preserved");
        let ports = harness["ports"].as_array().unwrap();
        assert_eq!(ports.len(), 2);
        for port in ports {
            assert_eq!(port["published"], "52106");
            assert_eq!(port["target"], 4206);
            assert!(matches!(
                port["host_ip"].as_str(),
                Some("127.0.0.1" | "::1")
            ));
        }
        for port in config["services"]["postgres"]["ports"].as_array().unwrap() {
            assert_eq!(port["published"], "55432");
            assert_eq!(port["target"], 5432);
        }
        assert_eq!(
            std::fs::read_to_string(root.join("docker-compose.yml")).unwrap(),
            source
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Real Compose merging is the important assertion: without !override, IPv6 ports survive.
    /// This only reads configuration; it never contacts a container engine or registry.
    #[test]
    #[ignore = "requires Docker Compose; only reads configuration, no running engine needed"]
    fn macos_podman_port_overlay_replaces_all_six_ports_and_preserves_other_settings() {
        let root = temp_root("compose-ports-merge");
        std::fs::create_dir_all(&root).unwrap();
        let source = include_str!("../../../docker-compose.yml");
        std::fs::write(root.join("docker-compose.yml"), source).unwrap();
        std::fs::write(root.join(MACOS_PODMAN_PORTS_FILE), MACOS_PODMAN_PORTS).unwrap();
        std::fs::write(root.join("docker-compose.override.yml"), "services:\n  supervisor:\n    environment:\n      COMPUTER_NAMESPACE: regression-kept\n    labels:\n      regression: kept\n").unwrap();
        let docker =
            std::env::var_os("OPENBOT_TEST_COMPOSE_DOCKER").unwrap_or_else(|| "docker".into());
        let config = |overlay: bool| {
            let mut command = Command::new(&docker);
            command
                .current_dir(&root)
                .env_clear()
                .env("PATH", env!("OPENBOT_TEST_TOOL_PATH"));
            command.arg("compose");
            if overlay {
                command.args([
                    "-f",
                    "docker-compose.yml",
                    "-f",
                    "docker-compose.override.yml",
                    "-f",
                    MACOS_PODMAN_PORTS_FILE,
                ]);
            }
            let output = command
                .args(["--profile", "*", "config", "--format", "json"])
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
        };
        for settings in [
            "PICKED_HARNESS_IMAGE=synthetic-harness:local\n".to_string(),
            "PICKED_HARNESS_IMAGE=synthetic-harness:local\nPOSTGRES_PORT=15432\nSUPERVISOR_PORT=14500\nCOMPUTER_PORT=14100\nBOT_PORT=14200\nLANGGRAPH_PORT=14201\nPICKED_HARNESS_PORT=14206\n".to_string(),
        ] {
            std::fs::write(root.join(".env"), &settings).unwrap();
            let mut before = config(false);
            let after = config(true);
            let mut published = 0;
            for (_, service) in before["services"].as_object_mut().unwrap() {
                if let Some(ports) = service.get_mut("ports").and_then(serde_json::Value::as_array_mut) {
                    assert_eq!(ports.len(), 2, "the released port pattern must exercise dual loopback");
                    ports.retain(|port| port["host_ip"] == "127.0.0.1");
                    assert_eq!(ports.len(), 1);
                    published += 1;
                }
            }
            assert_eq!(published, 6, "all published services must be covered");
            assert_eq!(after, before, "only the duplicate IPv6 loopback mappings may change");
            assert_eq!(std::fs::read_to_string(root.join(".env")).unwrap(), settings);
            assert_eq!(std::fs::read_to_string(root.join("docker-compose.yml")).unwrap(), source);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_podman_up_keeps_deployment_overrides_without_duplicate_ports() {
        if crate::test_support::isolated_process(
            "stack::tests::macos_podman_up_keeps_deployment_overrides_without_duplicate_ports",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("macos-podman-start");
        let [_, podman] = computer_stop_addresses(&path);
        let (root, record) = computer_stop_root(&path, "podman-start", "{}");
        let original = "services: {}\n";
        let settings = "POSTGRES_PORT=5544\nPICKED_HARNESS_PORT=4206\n";
        std::fs::write(root.join(".env"), settings).unwrap();
        std::fs::write(root.join("docker-compose.override.yml"), "services: {}\n").unwrap();
        let services = up(&podman, &root, true, &Secrets::new()).unwrap();
        assert_eq!(
            services,
            [
                "postgres",
                "agent-computer",
                "server",
                "worker",
                "agent-harness"
            ]
        );
        let log = std::fs::read_to_string(&record).unwrap();
        let line = log
            .lines()
            .find(|line| line.contains("--profile harness up -d --no-build --pull never"))
            .unwrap();
        let base = line.find("-f docker-compose.yml").unwrap();
        let existing = line.find("-f docker-compose.override.yml").unwrap();
        let desktop = line.find(".openbot-macos-podman.yml").unwrap();
        assert!(base < existing && existing < desktop, "{line}");
        assert_eq!(
            std::fs::read_to_string(root.join("docker-compose.yml")).unwrap(),
            original
        );
        assert_eq!(
            std::fs::read_to_string(root.join(".env")).unwrap(),
            settings
        );

        std::fs::write(root.join("custom override.yml"), "services: {}\n").unwrap();
        std::fs::write(
            root.join(".fixture-compose-environment"),
            "COMPOSE_FILE=docker-compose.yml;custom override.yml\nCOMPOSE_PATH_SEPARATOR=;\n",
        )
        .unwrap();
        std::fs::remove_file(&record).unwrap();
        up(&podman, &root, true, &Secrets::new()).unwrap();
        let log = std::fs::read_to_string(&record).unwrap();
        assert!(
            log.contains("-f docker-compose.yml -f custom override.yml"),
            "{log}"
        );
        assert!(!log.contains("docker-compose.override.yml"), "{log}");

        std::fs::write(root.join(".fixture-config-failure"), "").unwrap();
        std::fs::remove_file(&record).unwrap();
        assert!(up(&podman, &root, true, &Secrets::new())
            .unwrap_err()
            .detail
            .unwrap()
            .contains("synthetic invalid deployment override"));
        assert!(!std::fs::read_to_string(record).unwrap().contains(" up "));
    }

    /**
    OpenBot Desktop 1.0.0's first Start on a Mac with Docker Desktop: `up` was refused with
    `invalid mount config for type "bind": stat /host_mnt/Users/<name>/OpenBot/.openbot: operation
    not permitted` for the sign-in folder made a moment before, and the person was told "Something
    went wrong". Seconds later the same mount worked. Start now waits and tries again on exactly
    that refusal, and on nothing else.
    */
    #[test]
    fn up_tries_again_while_docker_desktop_cannot_see_a_new_folder_and_only_then() {
        if crate::test_support::isolated_process(
            "stack::tests::up_tries_again_while_docker_desktop_cannot_see_a_new_folder_and_only_then",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("folder-not-shared-yet");
        let [docker, _] = computer_stop_addresses(&path);
        let (root, _) = computer_stop_root(&path, "folder-not-shared-yet", "{}");
        let tries = || {
            std::fs::read_to_string(root.join(".fixture-up-tries"))
                .unwrap_or_default()
                .len()
        };

        // Refused twice, then mounted: Start goes on, after the first two waits.
        std::fs::write(root.join(".fixture-refusals"), "2").unwrap();
        let began = std::time::Instant::now();
        let services = up(&docker, &root, false, &Secrets::new()).unwrap();
        assert_eq!(services, selected_services(false));
        assert_eq!(tries(), 3);
        assert!(began.elapsed() >= std::time::Duration::from_secs(3));

        // Refused every time: the daemon's own words come back once the waits run out.
        std::fs::remove_file(root.join(".fixture-up-tries")).unwrap();
        std::fs::write(root.join(".fixture-refusals"), "99").unwrap();
        let problem = up_retrying(
            &docker,
            &root,
            false,
            &Secrets::new(),
            &[std::time::Duration::ZERO; 4],
        )
        .unwrap_err();
        assert_eq!(tries(), 5);
        assert!(
            problem
                .detail
                .as_deref()
                .unwrap()
                .contains("/OpenBot/.openbot: operation not permitted"),
            "{problem:?}"
        );

        // Any other refusal fails at once, as before.
        std::fs::remove_file(root.join(".fixture-up-tries")).unwrap();
        std::fs::write(
            root.join(".fixture-other-error"),
            "Error response from daemon: Conflict. The container name \"/openbot-desktop-server-1\" is already in use",
        )
        .unwrap();
        let problem = up(&docker, &root, false, &Secrets::new()).unwrap_err();
        assert_eq!(tries(), 1);
        assert!(problem.detail.unwrap().contains("is already in use"));
    }

    #[test]
    fn migrate_is_not_raised_as_a_service() {
        // Raised alongside the others it exits immediately, and Compose reports a service that will
        // not stay up. It is run to completion instead, by `migrate`.
        assert!(!SERVICES.contains(&"migrate"));
    }

    #[test]
    fn the_bots_computers_are_found_by_label_rather_than_by_a_name_that_starts_with_openbot() {
        // A name filter would also match a kind cluster's nodes, which are called
        // openbot-control-plane and openbot-worker and belong to somebody else.
        assert!(
            SUPERVISOR_FILTER.starts_with("label="),
            "without this the engine answers `invalid filter`: {SUPERVISOR_FILTER}"
        );
        assert!(SUPERVISOR_FILTER.contains("openbot.supervisor=true"));
        assert!(!SUPERVISOR_FILTER.contains("name="));
    }

    fn computer_stop_root(path: &PathFixture, label: &str, config: &str) -> (PathBuf, PathBuf) {
        let root = path.bin.join(label);
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("docker-compose.yml"), "services: {}\n").unwrap();
        std::fs::write(root.join(".fixture-config"), config).unwrap();
        project_decided(&root);
        let record = path.bin.join(format!("{label}.log"));
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        (root, record)
    }

    /// An installation whose Compose project is already recorded, so the command traces below are
    /// only the commands under test. Choosing one is `project`'s, tested on its own.
    fn project_decided(root: &Path) {
        crate::preparation::write_checkpoint(
            root,
            PROJECT_FILE,
            &SavedProject {
                project: DESKTOP_PROJECT.into(),
            },
        )
        .unwrap();
    }

    fn resolved_namespace_fixture(namespace: &str) -> String {
        serde_json::json!({"services":{"supervisor":{"environment":{"COMPUTER_NAMESPACE":namespace}}}}).to_string()
    }

    fn computer_stop_addresses(path: &PathFixture) -> [Address; 2] {
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        std::fs::copy(
            path.bin.join(format!("docker{suffix}")),
            path.bin.join(format!("podman{suffix}")),
        )
        .unwrap();
        [
            Address::new(crate::engine::Engine::Docker, None),
            Address::new(
                crate::engine::Engine::Podman,
                Some("fixture-machine".into()),
            ),
        ]
    }

    fn computer_shutdown_race_root(path: &PathFixture, label: &str) -> (PathBuf, PathBuf) {
        let (root, record) =
            computer_stop_root(path, label, &resolved_namespace_fixture("fixture-selected"));
        std::fs::write(root.join(".fixture-race"), "").unwrap();
        for id in ["current", "other", "unowned"] {
            std::fs::write(root.join(format!("{id}.running")), "").unwrap();
        }
        for id in ["current", "late", "restarted", "other", "unowned"] {
            std::fs::write(root.join(format!("{id}.volume")), id).unwrap();
        }
        (root, record)
    }

    fn assert_computer_shutdown_preserves_foreign_and_volumes(root: &Path) {
        let surviving: Vec<_> = ["current", "late", "restarted"]
            .into_iter()
            .filter(|id| root.join(format!("{id}.running")).exists())
            .collect();
        assert!(
            surviving.is_empty(),
            "computers survived shutdown: {surviving:?}"
        );
        for id in ["other", "unowned"] {
            assert!(
                root.join(format!("{id}.running")).exists(),
                "{id} was stopped"
            );
        }
        for id in ["current", "late", "restarted", "other", "unowned"] {
            assert_eq!(
                std::fs::read_to_string(root.join(format!("{id}.volume"))).unwrap(),
                id
            );
        }
        assert!(root.join("supervisor.stopped").exists());
        assert!(root.join("stack.down").exists());
    }

    #[test]
    fn computer_stop_quiesces_supervisor_before_final_snapshot_and_preserves_other_computers() {
        if crate::test_support::isolated_process("stack::tests::computer_stop_quiesces_supervisor_before_final_snapshot_and_preserves_other_computers") { return; }
        let path = PathFixture::with_fake_engine("computer-stop");
        for address in computer_stop_addresses(&path) {
            let (root, record) =
                computer_shutdown_race_root(&path, &format!("root-{}", address.engine.binary()));
            down(&address, &root).unwrap();
            let log = std::fs::read_to_string(record).unwrap();
            println!("{} shutdown trace:\n{log}", address.engine.binary());
            assert_computer_shutdown_preserves_foreign_and_volumes(&root);
            let config = log.find("config --format json").unwrap();
            let supervisor = log
                .find("compose -f docker-compose.yml stop supervisor")
                .unwrap();
            let snapshot = log.find("ps --quiet").unwrap();
            let computers = log.find("stop current late restarted").unwrap();
            let teardown = log
                .find("--profile harness --profile openbot down")
                .unwrap();
            assert!(
                config < supervisor
                    && supervisor < snapshot
                    && snapshot < computers
                    && computers < teardown,
                "{log}"
            );
        }
    }

    #[test]
    fn computer_stop_supervisor_failure_prevents_snapshot_and_is_retryable() {
        if crate::test_support::isolated_process(
            "stack::tests::computer_stop_supervisor_failure_prevents_snapshot_and_is_retryable",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("computer-stop");
        for address in computer_stop_addresses(&path) {
            let (root, record) =
                computer_shutdown_race_root(&path, &format!("root-{}", address.engine.binary()));
            let failure = root.join(".fixture-supervisor-stop-failure");
            std::fs::write(&failure, "").unwrap();
            let error = down(&address, &root).unwrap_err();
            assert!(
                error.contains("supervisor") && error.contains("fixture supervisor stop refused"),
                "{error}"
            );
            let log = std::fs::read_to_string(&record).unwrap();
            assert_eq!(log.lines().count(), 2, "{log}");
            assert!(
                !log.contains("ps --quiet") && !log.contains("harness down"),
                "{log}"
            );
            assert!(root.join("current.running").exists());
            assert!(!root.join("supervisor.stopped").exists());
            assert!(!root.join("stack.down").exists());
            std::fs::remove_file(failure).unwrap();
            down(&address, &root).unwrap();
            assert_computer_shutdown_preserves_foreign_and_volumes(&root);
        }
    }

    #[test]
    fn computer_stop_filters_both_ownership_and_selected_namespace_for_each_engine() {
        if crate::test_support::isolated_process("stack::tests::computer_stop_filters_both_ownership_and_selected_namespace_for_each_engine") { return; }
        let path = PathFixture::with_fake_engine("computer-stop");
        for address in computer_stop_addresses(&path) {
            let prefix = if address.connection.is_some() {
                "--connection fixture-machine "
            } else {
                ""
            };
            let (root, record) = computer_stop_root(
                &path,
                &format!("root-{}", address.engine.binary()),
                &resolved_namespace_fixture("fixture-selected"),
            );
            down(&address, &root).unwrap();
            let log = std::fs::read_to_string(record).unwrap();
            assert!(
                log.contains(&format!(
                    "{prefix}compose -f docker-compose.yml config --format json"
                )),
                "{log}"
            );
            assert!(log.contains(&format!("{prefix}ps --quiet --filter label=openbot.supervisor=true --filter label=openbot.namespace=fixture-selected")), "{log}");
            assert!(
                log.lines()
                    .any(|line| line.ends_with(&format!("\t{prefix}stop current"))),
                "{log}"
            );
            assert!(
                !log.contains("stop current other") && !log.contains("stop unowned"),
                "{log}"
            );
            assert!(
                log.contains(&format!(
                    "{prefix}compose -f docker-compose.yml --profile harness --profile openbot down"
                )),
                "{log}"
            );
        }
    }

    #[test]
    fn computer_stop_preserves_supervisor_default_and_trim_rules() {
        if crate::test_support::isolated_process(
            "stack::tests::computer_stop_preserves_supervisor_default_and_trim_rules",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("computer-stop");
        for (index, namespace) in ["openbot", "", "  ", " fixture-selected "]
            .iter()
            .enumerate()
        {
            let (root, record) = computer_stop_root(
                &path,
                &format!("case-{index}"),
                &resolved_namespace_fixture(namespace),
            );
            down(&Address::new(crate::engine::Engine::Docker, None), &root).unwrap();
            let expected = if index == 3 { "current" } else { "default" };
            assert!(std::fs::read_to_string(record)
                .unwrap()
                .lines()
                .any(|line| line.ends_with(&format!("\tstop {expected}"))));
        }
        for (index, namespace) in ["9Mixed_Case-namespace".to_string(), "a".repeat(64)]
            .iter()
            .enumerate()
        {
            let (root, record) = computer_stop_root(
                &path,
                &format!("valid-{index}"),
                &resolved_namespace_fixture(namespace),
            );
            down(&Address::new(crate::engine::Engine::Docker, None), &root).unwrap();
            let log = std::fs::read_to_string(record).unwrap();
            assert!(
                log.contains(&format!("label=openbot.namespace={namespace}")),
                "{log}"
            );
            assert!(!log.contains("\tstop "), "{log}");
        }
    }

    #[test]
    fn computer_stop_refuses_unresolved_namespace_before_listing_or_stopping() {
        if crate::test_support::isolated_process(
            "stack::tests::computer_stop_refuses_unresolved_namespace_before_listing_or_stopping",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("computer-stop");
        let configs = [
            "not json".to_string(),
            "{\"services\":{}}".to_string(),
            "{\"services\":{\"supervisor\":{\"environment\":{\"COMPUTER_NAMESPACE\":12}}}}"
                .to_string(),
            resolved_namespace_fixture("_invalid"),
            resolved_namespace_fixture("bad/value"),
            resolved_namespace_fixture(&"a".repeat(65)),
        ];
        for (index, config) in configs.iter().enumerate() {
            let (root, record) = computer_stop_root(&path, &format!("invalid-{index}"), config);
            let error =
                down(&Address::new(crate::engine::Engine::Docker, None), &root).unwrap_err();
            assert!(error.contains("namespace"), "{error}");
            let log = std::fs::read_to_string(record).unwrap();
            assert!(log.lines().count() == 1, "{log}");
        }
        let (root, record) = computer_stop_root(&path, "provider-failure", "{}");
        std::fs::write(root.join(".fixture-config-failure"), "").unwrap();
        assert!(down(&Address::new(crate::engine::Engine::Docker, None), &root).is_err());
        assert!(!std::fs::read_to_string(record).unwrap().contains("\tps "));
    }

    #[test]
    fn computer_stop_without_installed_config_never_searches_parent_or_lists_globally() {
        if crate::test_support::isolated_process("stack::tests::computer_stop_without_installed_config_never_searches_parent_or_lists_globally") { return; }
        let path = PathFixture::with_fake_engine("computer-stop");
        let record = path.bin.join("no-stack.log");
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        let absent = path.bin.join("absent");
        let empty = path.bin.join("empty");
        std::fs::create_dir(&empty).unwrap();
        for root in [&absent, &empty] {
            down(&Address::new(crate::engine::Engine::Docker, None), root).unwrap();
            assert!(!record.exists());
        }
        crate::deployment::record(&empty, "fixture", false).unwrap();
        assert!(down(&Address::new(crate::engine::Engine::Docker, None), &empty).is_err());
        assert!(!record.exists());
    }

    struct ReadinessFixture {
        root: PathBuf,
        children: Vec<(&'static str, std::process::Child)>,
        ready: Ready,
    }

    impl ReadinessFixture {
        fn new(api: &str, app: &str) -> Self {
            let root = temp_root("current-api-readiness");
            std::fs::create_dir_all(&root).unwrap();
            let mut fixture = Self {
                root,
                children: Vec::new(),
                ready: Ready { api: 0, app: 0 },
            };
            let source = fixture.root.join("readiness.rs");
            std::fs::write(
                &source,
                r#"
use std::io::{Read, Write};
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let name = &args[1];
    let mode = &args[2];
    let statuses: Vec<&str> = mode.split(',').collect();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut listeners = vec![listener];
    // An unbound IPv6 fallback takes about two seconds to refuse on Windows. Serve the
    // same status on both loopbacks so the regression tests HTTP state, not that delay.
    match std::net::TcpListener::bind(("::1", port)) {
        Ok(listener) => listeners.push(listener),
        Err(error) if matches!(error.kind(), std::io::ErrorKind::AddrNotAvailable | std::io::ErrorKind::Unsupported) => {}
        Err(error) => panic!("could not bind fixture IPv6 loopback: {}", error),
    }
    for listener in &listeners { listener.set_nonblocking(true).unwrap(); }
    let mut requests = std::fs::File::create(format!("{name}.requests")).unwrap();
    std::fs::write(format!("{name}.port"), port.to_string()).unwrap();
    let mut ipv4_requests = 0_usize;
    loop {
        for listener in &listeners {
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
                Err(error) => panic!("could not accept fixture request: {}", error),
            };
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                if stream.read(&mut byte).unwrap() == 0 { break; }
                request.push(byte[0]);
            }
            // answering_at tries IPv4 first. Its IPv6 fallback belongs to that same poll,
            // and must not advance the scripted response to the next service state.
            let index = if listener.local_addr().unwrap().is_ipv4() {
                let index = ipv4_requests;
                ipv4_requests += 1;
                index
            } else { ipv4_requests.saturating_sub(1) };
            let status = if mode == "exit" { "503" } else { statuses[index.min(statuses.len() - 1)] };
            writeln!(requests, "{status} {}", String::from_utf8_lossy(&request).lines().next().unwrap()).unwrap();
            write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            if mode == "exit" { std::process::exit(17); }
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}
"#,
            )
            .unwrap();
            let binary = fixture
                .root
                .join(format!("readiness{}", std::env::consts::EXE_SUFFIX));
            crate::test_support::compile_fixture(&source, &binary);
            for (name, mode) in [("server", api), ("app", app)] {
                std::fs::write(
                    fixture.root.join(format!("{name}.log")),
                    format!("synthetic {name} diagnostic"),
                )
                .unwrap();
                fixture.children.push((
                    name,
                    Command::new(&binary)
                        .args([name, mode])
                        .current_dir(&fixture.root)
                        .spawn()
                        .unwrap(),
                ));
                let port_file = fixture.root.join(format!("{name}.port"));
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                let port = loop {
                    if let Ok(port) = std::fs::read_to_string(&port_file) {
                        if let Ok(port) = port.parse() {
                            break port;
                        }
                    }
                    assert!(fixture
                        .children
                        .last_mut()
                        .unwrap()
                        .1
                        .try_wait()
                        .unwrap()
                        .is_none());
                    assert!(std::time::Instant::now() < deadline, "fixture did not bind");
                    std::thread::sleep(std::time::Duration::from_millis(10));
                };
                if name == "server" {
                    fixture.ready.api = port;
                } else {
                    fixture.ready.app = port;
                }
            }
            fixture
        }

        fn wait(&mut self, patience: std::time::Duration) -> Result<(), String> {
            wait_until_healthy(&self.ready, patience, || true)
        }

        fn requests(&self, name: &str) -> String {
            std::fs::read_to_string(self.root.join(format!("{name}.requests"))).unwrap()
        }
    }

    impl Drop for ReadinessFixture {
        fn drop(&mut self) {
            for (_, child) in &mut self.children {
                let _ = child.kill();
                child.wait().expect("owned HTTP fixture must be reaped");
            }
            for port in [self.ready.api, self.ready.app] {
                assert!(!something_answers(port), "owned HTTP listener must close");
            }
            eprintln!(
                "readiness fixture cleaned: pids={:?}; ports={:?}",
                self.children
                    .iter()
                    .map(|(_, child)| child.id())
                    .collect::<Vec<_>>(),
                [self.ready.api, self.ready.app]
            );
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn readiness_rechecks_api_after_an_earlier_success() {
        let mut fixture = ReadinessFixture::new("200,503", "503,200");
        let result = fixture.wait(std::time::Duration::from_secs(2));
        let api_requests = fixture.requests("server");
        let live = fixture
            .children
            .iter_mut()
            .all(|(_, child)| child.try_wait().unwrap().is_none());
        let api_now = answering_at(fixture.ready.api, "/health");
        let app_now = answering_at(fixture.ready.app, "/health");
        eprintln!("current API readiness: result={result:?}; children_alive={live}; api_requests={api_requests:?}; api_now={api_now:?}; app_now={app_now:?}");
        drop(fixture);
        assert!(live && api_now.is_none() && app_now.is_some());
        let error = result.expect_err("a historical API success cannot satisfy readiness");
        assert!(api_requests.lines().count() >= 2, "{api_requests}");
        assert!(error.contains("the API is not answering"), "{error}");
    }

    #[test]
    fn readiness_asks_the_server_health_check_on_both_ports() {
        let mut fixture = ReadinessFixture::new("200", "200");
        let result = fixture.wait(std::time::Duration::from_secs(2));
        let api_requests = fixture.requests("server");
        let app_requests = fixture.requests("app");
        drop(fixture);
        assert!(result.is_ok(), "{result:?}");
        assert!(api_requests.contains("200 GET /health HTTP/1.1"));
        assert!(app_requests.contains("200 GET /health HTTP/1.1"));
    }

    #[test]
    fn readiness_timeout_names_the_currently_unavailable_port() {
        for (api, app, missing) in [("503", "200", "server"), ("200", "503", "app")] {
            let mut fixture = ReadinessFixture::new(api, app);
            let result = fixture.wait(std::time::Duration::from_millis(100));
            let port = if missing == "server" {
                fixture.ready.api
            } else {
                fixture.ready.app
            };
            drop(fixture);
            let error = result.unwrap_err();
            let service = if missing == "server" { "API" } else { "app" };
            assert!(
                error.contains(&format!("the {service} is not answering on port {port}")),
                "{error}"
            );
        }
    }

    /// A readiness wait that runs out writes what it asked, what each answer was, and why it gave
    /// up: here a real server that answers its health check with 503, as one still migrating does.
    #[test]
    fn a_readiness_timeout_writes_its_waits_and_its_reason_to_the_log() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(
                    b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });
        let ready = Ready {
            api: port,
            app: port,
        };
        let mut lines = Vec::new();
        let result = wait_until_healthy_saying(
            &ready,
            std::time::Duration::from_secs(2),
            || true,
            &mut |line| lines.push(line),
        );
        assert_eq!(
            result.unwrap_err(),
            format!("the API is not answering on port {port}.")
        );
        let what = format!("[wait] OpenBot's services, GET /health on port {port} (API)");
        let first = &lines[0];
        assert!(first.starts_with(&what), "{lines:#?}");
        assert!(
            first.contains(&format!(
                "http://127.0.0.1:{port}/health answered 503 Service Unavailable"
            )),
            "{lines:#?}"
        );
        assert!(first.contains("check 1)"), "{lines:#?}");
        let last = lines.last().unwrap();
        assert!(
            last.contains(&format!(
                "gave up: the API is not answering on port {port}. after "
            )),
            "{lines:#?}"
        );
        assert!(last.contains("checks; last answer: API not answering (http://127.0.0.1"));
        assert!(last.contains("503 Service Unavailable"), "{lines:#?}");
        // The same answer each poll is said once, not once a poll.
        assert_eq!(lines.len(), 2, "{lines:#?}");
    }

    #[test]
    fn readiness_ends_at_once_when_the_start_is_stopped() {
        // Port 1 needs privilege to bind, so nothing here will ever answer it.
        let ready = Ready { api: 1, app: 1 };
        let started = std::time::Instant::now();
        let mut lines = Vec::new();
        let result = wait_until_healthy_saying(
            &ready,
            std::time::Duration::from_secs(30),
            || false,
            &mut |line| lines.push(line),
        );
        assert!(result.is_err());
        assert!(
            lines
                .last()
                .unwrap()
                .contains("stopped by Stop or Quit after"),
            "{lines:#?}"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "a stopped Start sat out the readiness wait"
        );
    }

    /// The folder-derived name is now only the name an earlier app's installation ran as, which
    /// is why it is still worked out exactly as Compose would: a legacy installation is recognised
    /// by it. It is never the name a new installation runs as.
    #[test]
    fn legacy_project_name_is_the_folder_name_as_compose_normalises_it() {
        assert_eq!(project_name(Path::new("/Users/someone/OpenBot")), "openbot");
        assert_eq!(
            project_name(Path::new("/home/someone/My OpenBot!")),
            "myopenbot"
        );
        assert_eq!(project_name(Path::new("/srv/_x")), "x");
        assert_eq!(project_name(Path::new("/srv/-_open.bot_2-")), "openbot_2-");
        assert_eq!(
            project_name(Path::new("C:/Users/someone/ÖpenBot")),
            "penbot"
        );
    }

    /// A folder named the way the default one is, so its legacy (folder-derived) project is
    /// `openbot`: the name a developer's source checkout called `openbot` also runs as.
    fn project_choice_root(path: &PathFixture, label: &str) -> (PathBuf, PathBuf) {
        let root = path.bin.join(label).join("OpenBot");
        std::fs::create_dir_all(&root).unwrap();
        let record = path.bin.join(format!("{label}.log"));
        std::fs::write(&record, "").unwrap();
        std::env::set_var("OPENBOT_TEST_ENGINE_RECORD", &record);
        (root, record)
    }

    /// One `.fixture-containers` row for a Compose container of `project` run from `working_dir`.
    fn compose_container_row(id: &str, service: &str, project: &str, working_dir: &Path) -> String {
        format!(
            "{id}\t{project}-{service}-1\trunning\tcom.docker.compose.project={project},com.docker.compose.project.working_dir={}\t\n",
            working_dir.display()
        )
    }

    /// The project and computer namespace every Compose command for `root` is given.
    fn compose_names(engine: &Address, root: &Path) -> (Option<String>, Option<String>) {
        let command = compose_command(engine, root, &Secrets::new());
        let named = |wanted: &str| {
            command
                .get_envs()
                .find(|(key, _)| *key == wanted)
                .and_then(|(_, value)| value)
                .map(|value| value.to_string_lossy().into_owned())
        };
        (named("COMPOSE_PROJECT_NAME"), named("COMPUTER_NAMESPACE"))
    }

    #[test]
    fn a_new_folder_records_and_runs_as_its_own_project() {
        if crate::test_support::isolated_process(
            "stack::tests::a_new_folder_records_and_runs_as_its_own_project",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("postgres-volume");
        let docker = Address::new(crate::engine::Engine::Docker, None);
        let (root, _) = project_choice_root(&path, "fresh");
        assert_eq!(saved_project(&root), None, "nothing recorded yet");
        assert_eq!(project(&docker, &root).unwrap(), DESKTOP_PROJECT);
        assert_eq!(saved_project(&root).as_deref(), Some(DESKTOP_PROJECT));
        assert!(root.join(PROJECT_FILE).is_file());
        // Its Bots' computers and volumes are named under it too, not under `openbot`.
        assert_eq!(
            compose_names(&docker, &root),
            (
                Some(DESKTOP_PROJECT.to_owned()),
                Some(DESKTOP_PROJECT.to_owned())
            )
        );
    }

    #[test]
    fn a_recorded_project_is_reused_without_asking_the_engine() {
        if crate::test_support::isolated_process(
            "stack::tests::a_recorded_project_is_reused_without_asking_the_engine",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("postgres-volume");
        let docker = Address::new(crate::engine::Engine::Docker, None);
        for (label, recorded) in [
            ("kept-legacy", "openbot"),
            ("kept-desktop", DESKTOP_PROJECT),
        ] {
            let (root, record) = project_choice_root(&path, label);
            crate::preparation::write_checkpoint(
                &root,
                PROJECT_FILE,
                &serde_json::json!({ "project": recorded }),
            )
            .unwrap();
            // What the engine holds says the opposite of the record, and is never consulted.
            let elsewhere = path.bin.join(label).join("elsewhere");
            let working_dir = if recorded == DESKTOP_PROJECT {
                &root
            } else {
                &elsewhere
            };
            std::fs::write(
                root.join(".fixture-containers"),
                compose_container_row("c1", "postgres", "openbot", working_dir),
            )
            .unwrap();
            assert_eq!(project(&docker, &root).unwrap(), recorded, "{label}");
            assert_eq!(
                compose_names(&docker, &root).0.as_deref(),
                Some(recorded),
                "{label}"
            );
            assert_eq!(
                std::fs::read_to_string(&record).unwrap(),
                "",
                "{label}: a recorded project is decided already"
            );
        }
    }

    #[test]
    fn a_legacy_folder_whose_own_containers_run_as_openbot_keeps_openbot() {
        if crate::test_support::isolated_process(
            "stack::tests::a_legacy_folder_whose_own_containers_run_as_openbot_keeps_openbot",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("postgres-volume");
        let docker = Address::new(crate::engine::Engine::Docker, None);
        let (root, record) = project_choice_root(&path, "legacy-own");
        // Made by an earlier app: a stamp, and no project record.
        crate::deployment::record(&root, "v0.2.0", false).unwrap();
        // Compose labels the folder as given, which need not be its canonical spelling.
        let spelled = root.join("..").join("OpenBot");
        std::fs::write(
            root.join(".fixture-containers"),
            compose_container_row("c1", "postgres", "openbot", &spelled),
        )
        .unwrap();
        assert_eq!(project(&docker, &root).unwrap(), "openbot");
        assert_eq!(saved_project(&root).as_deref(), Some("openbot"));
        // The namespace its Bots' computers were made under stays what it was.
        assert_eq!(
            compose_names(&docker, &root),
            (Some("openbot".into()), None)
        );
        let log = std::fs::read_to_string(&record).unwrap();
        assert!(
            log.contains(
                "ps --all --quiet --no-trunc --filter label=com.docker.compose.project=openbot"
            ),
            "{log}"
        );
    }

    /// An earlier app's installation in `root`: finished installing, its database volume left on
    /// the engine by a Stop or Quit that took every container down.
    fn earlier_installation(root: &Path) {
        crate::deployment::record(root, "v0.2.0", false).unwrap();
        std::fs::write(root.join(crate::preparation::FILE), "{}").unwrap();
        std::fs::write(root.join(".fixture-volumes"), "openbot_postgres-data\n").unwrap();
        std::fs::write(
            root.join(".fixture-inspect"),
            r#"[{"Name":"openbot_postgres-data","Labels":{"com.docker.compose.project":"openbot","com.docker.compose.volume":"postgres-data"}}]"#,
        )
        .unwrap();
    }

    /// The upgrade every person makes: they quit the earlier app (which takes its containers
    /// down), install this one, and open it. Their database is still on the engine and has to be
    /// the one OpenBot runs on, not a new empty one beside it.
    #[test]
    fn an_upgraded_install_keeps_its_data_after_its_containers_were_taken_down() {
        if crate::test_support::isolated_process(
            "stack::tests::an_upgraded_install_keeps_its_data_after_its_containers_were_taken_down",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("postgres-volume");
        let docker = Address::new(crate::engine::Engine::Docker, None);
        let (root, record) = project_choice_root(&path, "upgrade-after-quit");
        earlier_installation(&root);
        assert_eq!(project(&docker, &root).unwrap(), "openbot");
        assert_eq!(saved_project(&root).as_deref(), Some("openbot"));
        // The database, and the Bots' computers under the namespace they were made in.
        assert_eq!(
            compose_names(&docker, &root),
            (Some("openbot".to_owned()), None)
        );
        let log = std::fs::read_to_string(&record).unwrap();
        for line in log.lines() {
            let command = line.split_once('\t').unwrap().1;
            assert!(
                command.starts_with("ps --all --quiet --no-trunc ")
                    || command == "volume ls --format {{.Name}}"
                    || command == "volume inspect openbot_postgres-data",
                "an upgrade only looks at the engine: {command}"
            );
        }
    }

    /// The earlier installation's data is there, and a source checkout called `openbot` runs that
    /// project right now. Whose data the volume holds cannot be told, so Install says so and
    /// decides nothing, rather than starting empty beside it.
    #[test]
    fn an_upgraded_install_whose_project_another_folder_runs_says_so_and_records_nothing() {
        if crate::test_support::isolated_process(
            "stack::tests::an_upgraded_install_whose_project_another_folder_runs_says_so_and_records_nothing",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("postgres-volume");
        let docker = Address::new(crate::engine::Engine::Docker, None);
        let (root, _) = project_choice_root(&path, "upgrade-in-use");
        earlier_installation(&root);
        let checkout = path.bin.join("src").join("openbot");
        std::fs::create_dir_all(&checkout).unwrap();
        std::fs::write(
            root.join(".fixture-containers"),
            compose_container_row("dev0", "postgres", "openbot", &checkout),
        )
        .unwrap();
        let problem = project(&docker, &root).unwrap_err();
        assert!(
            problem
                .said
                .contains("another copy of OpenBot on this computer is using it"),
            "{}",
            problem.said
        );
        assert!(
            problem.said.contains("Nothing was changed or deleted"),
            "{}",
            problem.said
        );
        // The other copy's folder as a person reads it, never Windows' `\\?\C:\...` form.
        let checkout = crate::paths::plain(std::fs::canonicalize(&checkout).unwrap());
        assert!(
            problem
                .said
                .contains(&format!("from {}.", checkout.display()))
                && !problem.said.contains(r"\\?\"),
            "{}",
            problem.said
        );
        assert_eq!(
            saved_project(&root),
            None,
            "nothing is decided while it is in use"
        );
    }

    /// A folder no app ever finished installing in does not take an `openbot` database it finds:
    /// it may be a developer's.
    #[test]
    fn a_folder_no_app_installed_in_never_adopts_a_leftover_openbot_database() {
        if crate::test_support::isolated_process(
            "stack::tests::a_folder_no_app_installed_in_never_adopts_a_leftover_openbot_database",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("postgres-volume");
        let docker = Address::new(crate::engine::Engine::Docker, None);
        let (root, _) = project_choice_root(&path, "fresh-beside-leftover");
        earlier_installation(&root);
        std::fs::remove_file(root.join(crate::preparation::FILE)).unwrap();
        assert_eq!(project(&docker, &root).unwrap(), DESKTOP_PROJECT);
    }

    /// The Status listing after an upgrade: the installation runs as `openbot`, and another
    /// Compose project on the engine is called `openbot-kite-demo`. Its containers were listed as
    /// the installation's, memory and all, because their names start with `openbot-`.
    #[test]
    fn status_lists_only_the_installations_own_containers() {
        if crate::test_support::isolated_process(
            "stack::tests::status_lists_only_the_installations_own_containers",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("postgres-volume");
        let docker = Address::new(crate::engine::Engine::Docker, None);
        let (root, _) = project_choice_root(&path, "status-names");
        std::fs::write(root.join(PROJECT_FILE), r#"{"project":"openbot"}"#).unwrap();
        let elsewhere = path.bin.join("src").join("demo");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let rows = [
            compose_container_row("own1", "postgres", "openbot", &root),
            compose_container_row("own2", "server", "openbot", &root),
            compose_container_row("dem1", "postgres", "openbot-kite-demo", &elsewhere),
            compose_container_row("dem2", "supervisor", "openbot-kite-demo", &elsewhere),
        ]
        .concat()
        // The rows name containers `<project>-<service>-1`; the computer is the supervisor's.
        .replace("own2\topenbot-server-1", "own2\topenbot-computer-person-me");
        std::fs::write(root.join(".fixture-containers"), rows).unwrap();
        assert_eq!(
            running_containers_of(&docker, &root),
            ["openbot-postgres-1", "openbot-computer-person-me"]
        );
    }

    #[test]
    fn a_legacy_folder_never_adopts_a_source_checkouts_openbot_containers() {
        if crate::test_support::isolated_process(
            "stack::tests::a_legacy_folder_never_adopts_a_source_checkouts_openbot_containers",
        ) {
            return;
        }
        let path = PathFixture::with_fake_engine("postgres-volume");
        let docker = Address::new(crate::engine::Engine::Docker, None);
        let (root, record) = project_choice_root(&path, "legacy-collision");
        crate::deployment::record(&root, "v0.2.0", false).unwrap();
        // A developer's source checkout called `openbot`, running as Compose project `openbot`.
        let checkout = path.bin.join("src").join("openbot");
        std::fs::create_dir_all(&checkout).unwrap();
        let containers: String = ["postgres", "supervisor", "agent-bot"]
            .iter()
            .enumerate()
            .map(|(n, service)| {
                compose_container_row(&format!("dev{n}"), service, "openbot", &checkout)
            })
            .collect();
        std::fs::write(root.join(".fixture-containers"), &containers).unwrap();
        assert_eq!(project(&docker, &root).unwrap(), DESKTOP_PROJECT);
        assert_eq!(saved_project(&root).as_deref(), Some(DESKTOP_PROJECT));
        assert_eq!(
            compose_names(&docker, &root),
            (
                Some(DESKTOP_PROJECT.to_owned()),
                Some(DESKTOP_PROJECT.to_owned())
            )
        );
        // Only looked at: listed and inspected, never stopped, removed or taken down.
        let log = std::fs::read_to_string(&record).unwrap();
        for line in log.lines() {
            let command = line.split_once('\t').unwrap().1;
            assert!(
                command.starts_with("ps --all --quiet --no-trunc ")
                    || command.starts_with("container inspect dev"),
                "unexpected engine command for another project's containers: {command}"
            );
        }
        assert_eq!(
            std::fs::read_to_string(root.join(".fixture-containers")).unwrap(),
            containers
        );
    }

    #[test]
    fn only_the_server_row_can_own_the_app_and_api_ports() {
        let listing = "postgres\t127.0.0.1:5432->5432/tcp\n\
            server\t127.0.0.1:3010->3001/tcp, [::1]:3010->3001/tcp, 127.0.0.1:3001->3001/tcp, [::1]:3001->3001/tcp\n\
            worker\t\n";
        assert!(server_publishes_in(listing, &[3001, 3010]));
        assert!(server_publishes_in(listing, &[3001]));
        // Published by the project, but not by the server: still not the app.
        assert!(!server_publishes_in(listing, &[3001, 5432]));
        assert!(!server_publishes_in(listing, &[3002]));
        assert!(!server_publishes_in("", &[3001]));
        assert!(
            !server_publishes_in(listing, &[]),
            "nothing asked is nothing proven"
        );
    }

    /// What `docker container inspect --format '{{json .Config.Env}}'` printed for a Compose
    /// `server` service given the token, and given none (`${OPENBOT_DESKTOP_HOST_TOKEN:-}`).
    #[test]
    fn the_host_token_is_read_from_the_server_containers_environment() {
        let given = br#"["OTHER=value","OPENBOT_DESKTOP_HOST_TOKEN=probe-token-abc","PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]
"#;
        assert_eq!(host_token_in(given), Ok(Some("probe-token-abc".into())));
        let empty = br#"["OPENBOT_DESKTOP_HOST_TOKEN=","PATH=/usr/bin"]"#;
        assert_eq!(host_token_in(empty), Ok(None));
        assert_eq!(host_token_in(br#"["PATH=/usr/bin"]"#), Ok(None));
        // A value that merely contains the name is not it.
        let other = br#"["NOT_OPENBOT_DESKTOP_HOST_TOKEN=x"]"#;
        assert_eq!(host_token_in(other), Ok(None));
        assert!(host_token_in(b"no such container").is_err());
    }

    #[test]
    fn readiness_asks_both_loopbacks_because_a_runtime_picks_one() {
        assert!(LOOPBACKS.contains(&"127.0.0.1"));
        assert!(
            LOOPBACKS.contains(&"[::1]"),
            "an IPv6-only bind still counts as answering"
        );
    }

    #[test]
    fn nothing_is_answering_on_a_port_nothing_is_listening_on() {
        // Port 1 needs privilege to bind, so this asks about a port that cannot quietly be
        // somebody else's server.
        assert_eq!(answering_at(1, "/"), None);
    }

    #[test]
    fn the_host_processes_are_the_ones_earlier_versions_ran() {
        assert_eq!(HOST_PROCESSES, ["server", "app", "worker", "browser"]);
    }

    #[cfg(unix)]
    #[test]
    fn unix_app_listener_requires_stable_recorded_ancestry() {
        let live = [
            unix_fixture(401, 400),
            unix_fixture(402, 401),
            unix_fixture(403, 402),
        ];
        let inspect = |pid| Ok(live.iter().find(|row| row.pid == pid).cloned());
        assert!(unix_listener_belongs_to_record(403, &unix_record(401), inspect).unwrap());
        assert!(!unix_listener_belongs_to_record(403, &unix_record(501), inspect).unwrap());
        let mut reused = unix_record(401);
        reused.start = "earlier-instance".into();
        assert!(!unix_listener_belongs_to_record(403, &reused, inspect).unwrap());
        let mut seen = std::collections::HashMap::new();
        assert!(
            !unix_listener_belongs_to_record(403, &unix_record(401), |pid| {
                let count = seen.entry(pid).or_insert(0);
                *count += 1;
                let mut row = live.iter().find(|row| row.pid == pid).cloned();
                if pid == 402 && *count > 1 {
                    row.as_mut().unwrap().parent = 999;
                }
                Ok(row)
            })
            .unwrap()
        );
        assert!(
            !unix_listener_belongs_to_record(403, &unix_record(401), |pid| {
                Ok(Some(unix_fixture(pid, if pid == 403 { 402 } else { 403 })))
            })
            .unwrap()
        );
    }

    fn ancestry_listeners(pids: &[u32]) -> String {
        pids.iter()
            .map(|pid| format!("TCP 127.0.0.1:3010 0.0.0.0:0 LISTENING {pid}\n"))
            .collect()
    }

    fn assert_windows_ancestry_selection(
        recorded: &[RecordedHostProcess],
        processes: &[WindowsProcess],
        listeners: &[u32],
        expected: &[u32],
    ) {
        let listing = ancestry_listeners(listeners);
        assert_eq!(
            verified_openbot_pids_listening_on(&listing, &[3010], recorded, processes),
            expected,
            "listener ownership: {processes:?}"
        );
    }

    #[test]
    fn windows_ancestry_rejects_a_reused_newer_parent_pid() {
        let recorded = [recorded_process("app", 9001, "20260910010101.000000-420")];
        let processes = [
            live_host_process("app", 9001, 7000, "20260910010101.000000-420"),
            live_host_process("app", 9000, 9001, "20260909010101.000000-420"),
        ];
        assert_windows_ancestry_selection(&recorded, &processes, &[9000], &[]);
    }

    #[test]
    fn windows_ancestry_checks_intermediate_parent_instances() {
        let recorded = [recorded_process("app", 9001, "/Date(1000)/")];
        let processes = [
            live_host_process("app", 9001, 7000, "/Date(1000)/"),
            live_host_process("app", 9002, 9001, "/Date(3000)/"),
            live_host_process("app", 9003, 9002, "/Date(2000)/"),
        ];
        assert_windows_ancestry_selection(
            &recorded,
            &processes,
            &[9001, 9002, 9003],
            &[9001, 9002],
        );
    }

    #[test]
    fn windows_ancestry_compares_instants_and_preserves_direct_and_descendant_ownership() {
        for (parent, child, owned) in [
            (
                "20260910010101.000000-420",
                "20260910010101.000001-420",
                true,
            ),
            (
                "20260910010101.000001-420",
                "20260910010101.000000-420",
                false,
            ),
            (
                "20260910010101.000000-420",
                "20260910010101.000000-420",
                true,
            ),
            // Local date order reverses at a timezone boundary; compare UTC instants.
            (
                "20260910003000.000000+060",
                "20260909234500.000000+000",
                true,
            ),
            (
                "20260909234500.000000+000",
                "20260910003000.000000+060",
                false,
            ),
            ("/Date(1000)/", "/Date(1001)/", true),
            ("/Date(1001)/", "/Date(1000)/", false),
            ("/Date(1000+0700)/", "/Date(1001-0800)/", true),
            ("/Date(-1)/", "/Date(0)/", true),
            ("19700101010000.000000+060", "/Date(0)/", true),
            ("19700101000000.000001+000", "/Date(0)/", false),
        ] {
            let recorded = [recorded_process("app", 9001, parent)];
            let processes = [
                live_host_process("app", 9001, 7000, parent),
                live_host_process("app", 9002, 9001, child),
            ];
            let expected: &[u32] = if owned { &[9001, 9002] } else { &[9001] };
            assert_windows_ancestry_selection(&recorded, &processes, &[9001, 9002], expected);
        }
    }

    #[test]
    fn windows_ancestry_refuses_missing_or_invalid_times_at_every_link() {
        for invalid in [
            None,
            Some(""),
            Some("unknown"),
            Some("20260910010101.000000+***"),
            Some("20260931010101.000000+000"),
            Some("20260229010101.000000+000"),
            Some("20260910240101.000000+000"),
            Some("20260910010160.000000+000"),
            Some("20260910010101.00000x+000"),
            Some("/Date()/"),
            Some("/Date(9223372036854775807)/"),
            Some("/Date(0+2400)/"),
            Some("/Date(0+0060)/"),
            Some("/Date(0+000)/"),
            Some("/Date(0)"),
        ] {
            for index in 0..3 {
                let mut recorded = [recorded_process("app", 9001, "/Date(1000)/")];
                let mut processes = [
                    live_host_process("app", 9001, 7000, "/Date(1000)/"),
                    live_host_process("app", 9002, 9001, "/Date(2000)/"),
                    live_host_process("app", 9003, 9002, "/Date(3000)/"),
                ];
                processes[index].creation_date = invalid.map(str::to_string);
                if index == 0 {
                    recorded[0].creation_date = invalid.unwrap_or("").to_string();
                }
                assert_windows_ancestry_selection(&recorded, &processes, &[9003], &[]);
                if index == 0 {
                    assert_windows_ancestry_selection(&recorded, &processes, &[9001], &[]);
                }
            }
        }
    }

    #[test]
    fn windows_app_port_requires_the_app_role_and_its_verified_descendant() {
        if crate::test_support::isolated_process(
            "stack::tests::windows_app_port_requires_the_app_role_and_its_verified_descendant",
        ) {
            return;
        }
        let root = temp_root("windows-app-role-port");
        std::fs::create_dir_all(root.join(".logs")).unwrap();
        let fixture = CleanupCommandFixture::new(&root);
        fixture.scenario("already-running");
        let app = recorded_process("app", 9001, "20260909010101.000000-420");
        let server = recorded_process("server", 9002, "20260909010101.000000-420");
        write_host_pid_file(
            &root,
            &serde_json::json!({"version":1,"processes":[app,server]}),
        )
        .unwrap();
        std::fs::write(root.join("synthetic-inventory.json"), serde_json::to_vec(&serde_json::json!([
            {"ProcessId":9001,"ParentProcessId":7000,"ExecutablePath":r"C:\Users\person\.bun\bin\bun.exe","CommandLine":host_command_line("app"),"CreationDate":"20260909010101.000000-420"},
            {"ProcessId":9000,"ParentProcessId":9001,"ExecutablePath":"synthetic-child.exe","CommandLine":"synthetic child","CreationDate":"20260909010102.000000-420"},
            {"ProcessId":9002,"ParentProcessId":7000,"ExecutablePath":r"C:\Users\person\.bun\bin\bun.exe","CommandLine":host_command_line("server"),"CreationDate":"20260909010101.000000-420"}
        ])).unwrap()).unwrap();
        let owns = |name, port| {
            recorded_process_owns_port_windows_with(
                &root,
                name,
                port,
                &fixture.command("powershell"),
                &fixture.command("netstat"),
            )
            .unwrap()
        };
        assert!(owns("app", 45123));
        assert!(!owns("server", 45123));
        assert!(!owns("app", 45124));
        assert!(owns("server", 45124));
        assert!(!owns("worker", 45123));
        let log = fixture.log();
        assert!(!log.contains("taskkill"), "{log}");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// An installation that ran the team edition, with a computer the supervisor made for its person,
    /// moves to the personal edition's one shared computer. Its Bot's files and its browser profile
    /// were in the person's old volumes and nowhere the shared computer looks; Start brings them in,
    /// under the names the shared computer uses, once, without replacing anything already there.
    /// Against a real engine, with its own Compose project, namespace and volumes.
    ///
    /// ```sh
    /// OPENBOT_TEST_COMPUTER_IMAGE=<agent-computer image> \
    /// cargo test --locked --lib carried_into_the_shared -- --ignored
    /// ```
    #[test]
    #[ignore = "creates an isolated Compose project and volumes on the selected engine"]
    fn the_computers_from_before_the_personal_edition_are_carried_into_the_shared_one_once() {
        const IMAGE: &str = "pgvector/pgvector:pg17";
        // The image the copy runs in: the computer's own where one is named, as Start uses it.
        let computer =
            std::env::var("OPENBOT_TEST_COMPUTER_IMAGE").unwrap_or_else(|_| IMAGE.into());
        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let project = format!("openbot-carry-fixture-{unique}");
        let namespace = format!("carry{unique}");
        let person = "dev-local-user";
        let root = temp_root("carry-over");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(PROJECT_FILE),
            serde_json::json!({ "project": project }).to_string(),
        )
        .unwrap();
        std::fs::write(
            root.join("docker-compose.yml"),
            format!(
                "services:\n  agent-computer:\n    image: {IMAGE}\n    command: [\"sleep\", \"infinity\"]\n    volumes:\n      - agent-workspace:/workspace\n      - agent-profiles:/profiles\n  supervisor:\n    image: {IMAGE}\n    command: [\"sleep\", \"infinity\"]\n    environment:\n      COMPUTER_NAMESPACE: ${{COMPUTER_NAMESPACE:-{namespace}}}\nvolumes:\n  agent-workspace: {{}}\n  agent-profiles: {{}}\n"
            ),
        )
        .unwrap();
        let address = Address::new(crate::engine::Engine::Docker, None)
            .pin()
            .expect("the test engine answers");
        let old_workspace = format!("{namespace}-workspace-person-{person}");
        let old_profiles = format!("{namespace}-profile-person-{person}");
        // Another installation's person computer: never read.
        let elsewhere = format!("other{unique}-workspace-person-{person}");
        let new_workspace = format!("{project}_agent-workspace");
        let new_profiles = format!("{project}_agent-profiles");

        let engine = |args: &[&str]| -> String {
            let output = address.command().args(args).output().unwrap();
            assert!(
                output.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        // A shell in a throwaway container with these volumes, as root.
        let shell = |volumes: &[(&str, &str)], script: &str| -> String {
            let mut args = vec!["run".to_string(), "--rm".to_string()];
            for (volume, at) in volumes {
                args.push("--volume".into());
                args.push(format!("{volume}:{at}"));
            }
            args.extend([
                "--entrypoint".into(),
                "sh".into(),
                IMAGE.into(),
                "-c".into(),
                script.into(),
            ]);
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            engine(&args)
        };

        let workflow = std::panic::catch_unwind(|| {
            let up = compose_command(&address, &root, &Secrets::new())
                .args(["up", "-d", "agent-computer"])
                .output()
                .unwrap();
            assert!(
                up.status.success(),
                "{}",
                String::from_utf8_lossy(&up.stderr)
            );
            for (volume, space) in [
                (&old_workspace, namespace.as_str()),
                (&old_profiles, namespace.as_str()),
                (&elsewhere, &format!("other{unique}")[..]),
            ] {
                engine(&[
                    "volume",
                    "create",
                    "--label",
                    "openbot.supervisor=true",
                    "--label",
                    &format!("openbot.namespace={space}"),
                    "--label",
                    "openbot.computer-kind=person",
                    "--label",
                    &format!("openbot.person-id={person}"),
                    volume,
                ]);
            }
            // The person's computer from before: a Bot's files under `computers/<bot>`, its profile
            // under `<bot>`, owned by somebody other than root, and the computer's own `.control`.
            shell(
                &[(&old_workspace, "/w"), (&old_profiles, "/p"), (&elsewhere, "/e")],
                "set -e
                 mkdir -p /w/computers/picked-harness /w/computers/other-bot /p/picked-harness/Default /p/other-bot /p/.control
                 echo old-marker > /w/computers/picked-harness/final-marker.txt
                 chown 1234:1234 /w/computers/picked-harness/final-marker.txt
                 chmod 640 /w/computers/picked-harness/final-marker.txt
                 echo older-note > /w/computers/picked-harness/note.txt
                 echo b > /w/computers/other-bot/b.txt
                 echo cookies > /p/picked-harness/Default/Cookies
                 chown -R 1234:1234 /p/picked-harness
                 echo old-profile > /p/other-bot/Preferences
                 echo control > /p/.control/state
                 mkdir -p /e/computers/stranger && echo not-ours > /e/computers/stranger/x",
            );
            // The person's computer from before, still running on those volumes.
            engine(&[
                "run",
                "--detach",
                "--name",
                &format!("{project}-old-person"),
                "--label",
                "openbot.supervisor=true",
                "--label",
                &format!("openbot.namespace={namespace}"),
                "--label",
                "openbot.computer-kind=person",
                "--volume",
                &format!("{old_workspace}:/workspace"),
                "--volume",
                &format!("{old_profiles}:/profiles"),
                IMAGE,
                "sleep",
                "infinity",
            ]);
            // What the shared computer already has: a newer note for that Bot, and a profile of its
            // own for the other one.
            shell(
                &[(&new_workspace, "/workspace"), (&new_profiles, "/profiles")],
                &format!(
                    "set -e
                     mkdir -p '/workspace/computers/{person}~picked-harness' '/profiles/{person}~other-bot'
                     echo newer-note > '/workspace/computers/{person}~picked-harness/note.txt'
                     echo new-profile > '/profiles/{person}~other-bot/Preferences'"
                ),
            );

            let carried = carry_over_person_computers(&address, &root, &computer).unwrap();
            assert_eq!(
                carried,
                vec![CarriedOver {
                    person: person.into(),
                    workspace: Some("copied".into()),
                    profile: Some("copied".into()),
                }]
            );
            let seen = shell(
                &[(&new_workspace, "/workspace"), (&new_profiles, "/profiles")],
                &format!(
                    "cd '/workspace/computers/{person}~picked-harness'
                     echo marker=$(cat final-marker.txt) $(stat -c '%u:%g:%a' final-marker.txt)
                     echo note=$(cat note.txt)
                     echo other=$(cat '/workspace/computers/{person}~other-bot/b.txt')
                     echo cookies=$(cat '/profiles/{person}~picked-harness/Default/Cookies') $(stat -c '%u:%g' '/profiles/{person}~picked-harness/Default/Cookies')
                     echo kept=$(cat '/profiles/{person}~other-bot/Preferences')
                     echo control=$(ls -A /profiles | grep -c '^\\.control$' || true)
                     echo stranger=$(ls /workspace/computers | grep -c stranger || true)
                     echo staging=$(ls -A /profiles | grep -c '^\\.openbot-carrying' || true)"
                ),
            );
            assert_eq!(
                seen.lines().collect::<Vec<_>>(),
                [
                    "marker=old-marker 1234:1234:640",
                    "note=newer-note",
                    "other=b",
                    "cookies=cookies 1234:1234",
                    "kept=new-profile",
                    "control=0",
                    "stranger=0",
                    "staging=0",
                ],
                "the files come with their owners and modes, and nothing there is replaced"
            );
            // Stopped before its volumes were read, and kept.
            assert_eq!(
                engine(&[
                    "inspect",
                    "--format",
                    "{{.State.Running}}",
                    &format!("{project}-old-person"),
                ]),
                "false"
            );
            // The old volumes are as they were.
            assert_eq!(
                shell(
                    &[(&old_workspace, "/w")],
                    "cat /w/computers/picked-harness/final-marker.txt"
                ),
                "old-marker"
            );

            // Once: a file the old computer gains later is not brought in by the next Start.
            shell(
                &[(&old_workspace, "/w")],
                "echo later > /w/computers/picked-harness/later.txt",
            );
            assert_eq!(
                carry_over_person_computers(&address, &root, &computer).unwrap(),
                vec![CarriedOver {
                    person: person.into(),
                    workspace: Some("done".into()),
                    profile: Some("done".into()),
                }]
            );
            assert_eq!(
                shell(
                    &[(&new_workspace, "/workspace")],
                    &format!(
                        "ls '/workspace/computers/{person}~picked-harness' | grep -c later || true"
                    ),
                ),
                "0"
            );
        });

        let _ = address
            .command()
            .args(["rm", "--force", &format!("{project}-old-person")])
            .output();
        let _ = compose_command(&address, &root, &Secrets::new())
            .args(["down", "--volumes", "--remove-orphans"])
            .output();
        for volume in [&old_workspace, &old_profiles, &elsewhere] {
            let _ = address
                .command()
                .args(["volume", "rm", "--force", volume])
                .output();
        }
        let _ = std::fs::remove_dir_all(&root);
        if let Err(panic) = workflow {
            std::panic::resume_unwind(panic);
        }
    }
}
