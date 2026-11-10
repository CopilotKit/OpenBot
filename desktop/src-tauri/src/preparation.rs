//! Local installation checkpoints. These contain no credentials and never grant runtime ownership.
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    deployment,
    engine::{Address, Engine},
    harness::HarnessChoice,
    paths,
    problem::Problem,
    stack,
};

pub const REQUIRED: &str = "Finish installing OpenBot's local software before signing in or starting. Return to Install and try again.";
pub const FILE: &str = ".openbot-prepared.json";
/// The launch a Start last made from this installation.
pub const LAUNCH: &str = ".openbot-launched.json";
/// The engine this installation was set up on. Never invalidated with the preparation record: a
/// new release is prepared again on the same engine, where its database already is.
pub const ENGINE: &str = ".openbot-engine.json";

#[derive(Serialize, Deserialize)]
struct Prepared {
    fingerprint: String,
    harness: Option<HarnessChoice>,
    images: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Launch {
    pub harness: Option<HarnessChoice>,
}

#[derive(Serialize, Deserialize)]
struct Launched {
    preparation: String,
    launch: Launch,
}

fn prepared_digest(root: &Path) -> Option<String> {
    std::fs::read(root.join(FILE))
        .ok()
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
}

pub fn record_launch(root: &Path, harness: Option<&HarnessChoice>) -> Result<(), Problem> {
    let preparation = prepared_digest(root)
        .ok_or_else(|| required("The completed installation record is unavailable."))?;
    write_record(
        root,
        LAUNCH,
        &Launched {
            preparation,
            launch: Launch {
                harness: harness.cloned(),
            },
        },
    )
}

/// Whether an app finished installing in `root`, or started OpenBot from it, at some point: its
/// completed-installation or launch record is there, valid or not. Proof that the folder is an
/// installation's own, which a source checkout never has (see `stack::project`).
pub fn installed_before(root: &Path) -> bool {
    root.join(FILE).is_file() || root.join(LAUNCH).is_file()
}

/// Passive resume intent. Runtime and credential validity are checked by the normal Start path.
pub fn launch(root: &Path) -> Option<Launch> {
    let record: Launched = serde_json::from_slice(&std::fs::read(root.join(LAUNCH)).ok()?).ok()?;
    (prepared_digest(root).as_deref() == Some(&record.preparation)).then_some(record.launch)
}

/// Completed installation is independent of sign-in and runtime state. This passive checkpoint
/// only selects the recovery screen; Start still verifies the assets and selected engine.
pub fn installation(root: &Path) -> Option<Launch> {
    let record: Prepared = serde_json::from_slice(&std::fs::read(root.join(FILE)).ok()?).ok()?;
    Some(Launch {
        harness: record.harness,
    })
}

/// The images the last finished install of `root` pulled, from its completed-installation record,
/// valid or not: the images this installation runs, for getting the next release's ready ahead of
/// an update (`update_ready`). None without a record.
pub fn installed_images(root: &Path) -> Option<Vec<String>> {
    let record: Prepared = serde_json::from_slice(&std::fs::read(root.join(FILE)).ok()?).ok()?;
    Some(record.images)
}

#[derive(Serialize, Deserialize)]
struct SavedEngine {
    engine: Engine,
}

/// The engine this installation was set up on, or `None` when it saved none (a new installation,
/// or one from before this record existed).
///
/// Every later install and start uses this engine and never the other one. The installation's
/// images and its database are in the engine it was set up on, so moving to the other one, say
/// because Docker happens to be answering, starts OpenBot with an empty database.
pub fn saved_engine(root: &Path) -> Option<Engine> {
    let record: SavedEngine =
        serde_json::from_slice(&std::fs::read(root.join(ENGINE)).ok()?).ok()?;
    Some(record.engine)
}

/// Save the engine this installation runs on. Called once, when it has none saved.
pub fn save_engine(root: &Path, engine: Engine) -> Result<(), Problem> {
    write_record(root, ENGINE, &SavedEngine { engine })
}

/// Saved resolved and in the form a person reads: on Windows `canonicalize` answers
/// `\\?\C:\Users\Ada\OpenBot`, and this record is where Settings, the setup window and every
/// later Start take the installation's folder from.
pub fn save_selected_root(config: &Path, root: &Path) -> Result<(), Problem> {
    let root = std::fs::canonicalize(root).map(paths::plain).map_err(|e| {
        Problem::with(
            "OpenBot could not remember this installation for next time.",
            e.to_string(),
        )
    })?;
    std::fs::create_dir_all(config).map_err(|e| {
        Problem::with(
            "OpenBot could not remember this installation for next time.",
            e.to_string(),
        )
    })?;
    write_record(config, "last-launched-root.json", &root)
}

/// Plain as well when an earlier app saved it as `\\?\C:\...`.
pub fn selected_root(config: &Path) -> Option<PathBuf> {
    let root: PathBuf =
        serde_json::from_slice(&std::fs::read(config.join("last-launched-root.json")).ok()?)
            .ok()?;
    let root = paths::plain(root);
    root.is_absolute().then_some(root)
}

pub fn required(detail: impl Into<String>) -> Problem {
    Problem::with(REQUIRED, detail).connection(crate::problem::Connection::Installation)
}

fn hash_files(root: &Path, files: impl IntoIterator<Item = PathBuf>) -> Result<String, Problem> {
    let mut hash = Sha256::new();
    hash.update(b"openbot-preparation-v1\0");
    hash.update(
        std::fs::canonicalize(root)
            .map_err(|e| required(e.to_string()))?
            .to_string_lossy()
            .as_bytes(),
    );
    for file in files {
        hash.update(file.to_string_lossy().as_bytes());
        let bytes = std::fs::read(root.join(&file))
            .map_err(|e| required(format!("{}: {e}", file.display())))?;
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn fingerprint(root: &Path) -> Result<String, Problem> {
    hash_files(
        root,
        [
            PathBuf::from(".openbot-deployment"),
            PathBuf::from("container-images.json"),
            PathBuf::from("docker-compose.yml"),
        ],
    )
}

fn write_record(root: &Path, name: &str, value: &impl Serialize) -> Result<(), Problem> {
    write_checkpoint(root, name, value).map_err(required)
}

/// Replace a checkpoint file through a temporary file. The error is the underlying cause, for the
/// caller to put beside its own sentence.
pub(crate) fn write_checkpoint(
    root: &Path,
    name: &str,
    value: &impl Serialize,
) -> Result<(), String> {
    let target = root.join(name);
    let temporary = root.join(format!("{name}.tmp"));
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    // Windows rename does not replace an existing file. A missing checkpoint is safe on interruption.
    match std::fs::remove_file(&target) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    std::fs::rename(temporary, target).map_err(|e| e.to_string())
}

pub fn invalidate(root: &Path) -> Result<(), Problem> {
    match std::fs::remove_file(root.join(FILE)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(required(e.to_string())),
    }
}

pub fn image_present(address: &Address, image: &str) -> Result<bool, Problem> {
    address
        .command()
        .args(["image", "inspect", image])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .map_err(|e| required(format!("Could not check an installed image: {e}")))
}

pub fn require_images(address: &Address, images: &[String]) -> Result<(), Problem> {
    for image in images {
        if !image_present(address, image)? {
            return Err(required(format!(
                "The selected container engine does not have {image}."
            )));
        }
    }
    Ok(())
}

/// Written only after dependencies and every image have finished successfully.
pub fn record(
    root: &Path,
    harness: Option<&HarnessChoice>,
    images: Vec<String>,
) -> Result<(), Problem> {
    write_record(
        root,
        FILE,
        &Prepared {
            fingerprint: fingerprint(root)?,
            harness: harness.cloned(),
            images,
        },
    )
}

pub fn complete(
    root: &Path,
    harness: Option<&HarnessChoice>,
    images: Vec<String>,
    address: &Address,
) -> Result<(), Problem> {
    complete_with(root, harness, images, |images| {
        require_images(address, images)
    })
}

fn complete_with(
    root: &Path,
    harness: Option<&HarnessChoice>,
    images: Vec<String>,
    verify: impl FnOnce(&[String]) -> Result<(), Problem>,
) -> Result<(), Problem> {
    verify(&images)?;
    record(root, harness, images)
}

/// `selection=None` is the auth check, which has no authority to change the Bot selection.
///
/// No runtime and no packages: everything OpenBot runs is a container now, so what Start needs from
/// the installation is the deployment it laid out and the images it downloaded.
pub fn require(
    root: &Path,
    selection: Option<&Option<HarnessChoice>>,
    address: &Address,
) -> Result<(), Problem> {
    require_with(root, selection, |images| require_images(address, images))
}

/// Whether a deployment is this app's own release is not asked here: Start upgrades one that is
/// not before it gets this far (see `upgrade`).
fn require_with(
    root: &Path,
    selection: Option<&Option<HarnessChoice>>,
    verify: impl FnOnce(&[String]) -> Result<(), Problem>,
) -> Result<(), Problem> {
    let record: Prepared = serde_json::from_slice(
        &std::fs::read(root.join(FILE)).map_err(|e| required(e.to_string()))?,
    )
    .map_err(|e| required(e.to_string()))?;
    if record.fingerprint != fingerprint(root)?
        || selection.is_some_and(|selection| selection != &record.harness)
    {
        return Err(required(
            "The deployment folder or Bot selection changed after installation.",
        ));
    }
    if let Some(problem) = stack::deployment_problem(root) {
        return Err(required(problem));
    }
    // Install moves this one to the latest release; Start cannot. See `deployment_release`.
    if deployment::predates_containers(root) {
        return Err(required(
            "The deployment is a release from before OpenBot ran its server in a container.",
        ));
    }
    // A deployment laid out by an app that copied less still matches its own fingerprint. Install
    // lays it out again; Start cannot.
    if deployment::installed(root)
        .is_some_and(|found| deployment::needs_fetch(root, &found.version))
    {
        return Err(required(
            "The deployment was laid out by an earlier OpenBot and is missing files this version runs.",
        ));
    }
    verify(&record.images)
}

/// Every image Install pulls for the release laid out in `release`, run as `root`'s project: the
/// Compose services desktop runs with the picked Bot, the migration, and the two sign-in images,
/// and never the agents this installation does not run or the all-in-one image desktop never runs.
pub fn installation_pull_set(
    address: &Address,
    root: &Path,
    release: &Path,
    harness: Option<&HarnessChoice>,
) -> Result<Vec<String>, Problem> {
    installation_pull_set_by(
        |settings| stack::compose_command_for(address, root, settings),
        root,
        release,
        harness,
    )
}

/// [`installation_pull_set`], with the Compose to ask made by `compose` from the image settings:
/// an engine's, or before there is one, OpenBot's own standalone Compose
/// (`stack::standalone_compose_command`).
pub fn installation_pull_set_by(
    compose: impl FnOnce(&stack::Secrets) -> std::process::Command,
    root: &Path,
    release: &Path,
    harness: Option<&HarnessChoice>,
) -> Result<Vec<String>, Problem> {
    let picked = crate::harness::picked(harness, release).map_err(Problem::from)?;
    let settings = image_settings(release, picked.as_ref())?;
    let installed = picked
        .as_ref()
        .and_then(|picked| picked.installed_port())
        .is_some();
    let mut images = stack::installation_images_by(compose(&settings), root, release, installed)?;
    for published in [
        crate::plan::SIGN_IN_IMAGE,
        crate::plan::CHATGPT_SIGN_IN_IMAGE,
    ] {
        images.push(deployment::reference(release, published)?);
    }
    images.sort();
    images.dedup();
    Ok(images)
}

/// Public Compose overrides suffice to identify and download software before authentication.
pub fn image_settings(
    root: &Path,
    picked: Option<&crate::env::PickedHarness>,
) -> Result<stack::Secrets, Problem> {
    let mut settings: stack::Secrets = deployment::image_variables(root)?.into_iter().collect();
    settings.insert("IMAGE_PULL_POLICY".into(), "missing".into());
    if let Some(crate::env::PickedHarness::Installed { image, port, .. }) = picked {
        settings.insert("PICKED_HARNESS_IMAGE".into(), image.clone());
        settings.insert("PICKED_HARNESS_PORT".into(), port.to_string());
    }
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The setup window recognises this refusal by its exact sentence (ProviderPicker's
    // INSTALL_REQUIRED) to send the person back to Install; rewording it here alone would
    // silently leave them stuck on the AI step again.
    #[test]
    fn the_setup_window_knows_the_required_sentence() {
        let picker = include_str!("../../src/ProviderPicker.tsx");
        assert!(
            picker.contains(&format!("\"{REQUIRED}\"")),
            "desktop/src/ProviderPicker.tsx INSTALL_REQUIRED must equal preparation::REQUIRED"
        );
    }

    /// A Compose file from a release that runs the server and worker as services.
    const COMPOSE: &str = "services:\n  server: {}\n  worker: {}\n";

    #[test]
    fn the_saved_engine_outlives_a_new_preparation() {
        let root = crate::test_support::temp_root("preparation-saved-engine");
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(saved_engine(&root), None, "nothing saved yet");
        save_engine(&root, Engine::Podman).unwrap();
        assert_eq!(saved_engine(&root), Some(Engine::Podman));
        // A new release is prepared again on the engine its database is in.
        invalidate(&root).unwrap();
        assert_eq!(saved_engine(&root), Some(Engine::Podman));
        save_engine(&root, Engine::Docker).unwrap();
        assert_eq!(saved_engine(&root), Some(Engine::Docker));
        std::fs::write(root.join(ENGINE), "not json").unwrap();
        assert_eq!(
            saved_engine(&root),
            None,
            "an unreadable record is no record"
        );
    }

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = crate::test_support::temp_root("preparation");
            std::fs::create_dir_all(&root).unwrap();
            let root = std::fs::canonicalize(root).unwrap();
            std::fs::write(root.join("docker-compose.yml"), COMPOSE).unwrap();
            std::fs::write(root.join("container-images.json"), "{}").unwrap();
            deployment::record(&root, "v-test", false).unwrap();
            Self { root }
        }

        fn prepared(&self, harness: Option<&HarnessChoice>) {
            complete_with(&self.root, harness, vec!["synthetic-image".into()], |_| {
                Ok(())
            })
            .unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }

    /// A v0.2.0 install prepared by an app that did not copy `agent-computer` still matched its
    /// fingerprint, so Start ran a server that could not load. Start now sends a deployment whose
    /// stamp names no layout back to Install, which lays the deployment out again.
    #[test]
    fn a_deployment_laid_out_by_an_earlier_app_requires_installation_before_start() {
        let f = Fixture::new();
        // Exactly what an earlier app wrote, in place before it prepared the installation.
        std::fs::write(deployment::stamp_path(&f.root), r#"{"version":"v-test"}"#).unwrap();
        f.prepared(None);
        let problem = require_with(&f.root, None, |_| Ok(()))
            .expect_err("a deployment missing folders this app copies cannot start");
        assert!(problem.said.contains("Finish installing"));
    }

    /// Installing is pulling images, so a clean machine completes it with nothing on the host but
    /// the Compose file: no runtime, no packages and no Recorder. And Start asks for nothing more.
    #[test]
    fn a_clean_machine_installs_and_starts_from_the_compose_file_and_the_images() {
        let f = Fixture::new();
        complete_with(&f.root, None, vec!["synthetic-image".into()], |_| Ok(())).unwrap();
        require_with(&f.root, Some(&None), |images| {
            assert_eq!(images, ["synthetic-image"]);
            Ok(())
        })
        .unwrap();
        let mut laid_out: Vec<String> = std::fs::read_dir(&f.root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        laid_out.sort();
        assert_eq!(
            laid_out,
            [
                ".openbot-deployment",
                ".openbot-prepared.json",
                "container-images.json",
                "docker-compose.yml"
            ]
        );
    }

    #[test]
    fn failed_image_preparation_cannot_publish_completion() {
        let f = Fixture::new();
        let result = complete_with(&f.root, None, vec!["missing-image".into()], |_| {
            Err(required("missing image"))
        });
        assert!(result.is_err());
        assert!(!f.root.join(FILE).exists());
        assert!(installation(&f.root).is_none());
        complete_with(&f.root, None, vec!["now-present".into()], |_| Ok(())).unwrap();
        assert!(f.root.join(FILE).is_file());
        assert!(installation(&f.root).is_some());
        assert!(
            launch(&f.root).is_none(),
            "installation does not authorize automatic Start"
        );
    }

    #[test]
    fn a_release_whose_server_ran_on_the_host_must_be_installed_again_before_start() {
        let f = Fixture::new();
        std::fs::write(
            f.root.join("docker-compose.yml"),
            "services:\n  postgres: {}\n  supervisor: {}\n",
        )
        .unwrap();
        f.prepared(None);
        let problem = require_with(&f.root, Some(&None), |_| Ok(())).unwrap_err();
        assert!(
            format!("{problem:?}").contains("before OpenBot ran its server in a container"),
            "{problem:?}"
        );
    }

    #[test]
    fn changed_bot_requires_installation() {
        let f = Fixture::new();
        let chosen = Some(HarnessChoice {
            id: "langgraph".into(),
            agent_url: None,
        });
        f.prepared(chosen.as_ref());
        require_with(&f.root, Some(&chosen), |_| Ok(())).unwrap();
        assert!(require_with(&f.root, Some(&None), |_| panic!(
            "wrong selection must stop first"
        ))
        .is_err());
        // The images are Start's business.
        assert!(require_with(&f.root, Some(&chosen), |_| Err(required("missing image"))).is_err());
        // And the deployment Compose runs.
        std::fs::write(
            f.root.join("docker-compose.yml"),
            format!("{COMPOSE}  x: {{}}\n"),
        )
        .unwrap();
        let refused = require_with(&f.root, Some(&chosen), |_| Ok(())).unwrap_err();
        // The window goes back to Install for it rather than stopping on the sentence.
        assert_eq!(
            refused.connection,
            Some(crate::problem::Connection::Installation)
        );
    }

    #[test]
    fn successful_launch_remembers_exact_root_and_bot_without_credentials() {
        let f = Fixture::new();
        let chosen = HarnessChoice {
            id: "byo-url".into(),
            agent_url: Some("https://agent.example/ag-ui".into()),
        };
        f.prepared(Some(&chosen));
        let config = f.root.join("app-config");
        assert!(launch(&f.root).is_none());
        record_launch(&f.root, Some(&chosen)).unwrap();
        save_selected_root(&config, &f.root).unwrap();
        // The fixture's root is canonical, so `\\?\C:\...` on Windows; the record keeps it plain.
        let remembered = paths::plain(f.root.clone());
        assert_eq!(selected_root(&config), Some(remembered.clone()));
        assert_eq!(launch(&f.root).unwrap().harness, Some(chosen));
        invalidate(&f.root).unwrap();
        assert!(launch(&f.root).is_none());
        assert_eq!(
            selected_root(&config),
            Some(remembered),
            "repair must not forget the last successful folder"
        );
    }

    /// Windows' `canonicalize` answers `\\?\C:\Users\Administrator\OpenBot`, and the saved folder
    /// is what Settings shows under Installed in. It is saved plain, and a record an earlier app
    /// saved with the prefix reads back plain.
    #[test]
    fn the_remembered_installation_folder_is_saved_and_read_without_the_windows_prefix() {
        let f = Fixture::new();
        let config = f.root.join("app-config");
        save_selected_root(&config, &f.root).unwrap();
        let saved: PathBuf =
            serde_json::from_slice(&std::fs::read(config.join("last-launched-root.json")).unwrap())
                .unwrap();
        for root in [saved, selected_root(&config).unwrap()] {
            assert!(
                !root.to_string_lossy().starts_with(r"\\?\"),
                "{}",
                root.display()
            );
            assert_eq!(
                std::fs::canonicalize(&root).unwrap(),
                f.root,
                "the same folder"
            );
        }

        #[cfg(windows)]
        {
            write_record(
                &config,
                "last-launched-root.json",
                &PathBuf::from(r"\\?\C:\Users\Administrator\OpenBot"),
            )
            .unwrap();
            assert_eq!(
                selected_root(&config),
                Some(PathBuf::from(r"C:\Users\Administrator\OpenBot"))
            );
        }
    }
}
