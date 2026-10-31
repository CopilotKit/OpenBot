//! Local installation checkpoints. These contain no credentials and never grant runtime ownership.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    deployment,
    engine::{Address, Engine},
    harness::HarnessChoice,
    local_browser,
    problem::Problem,
    stack,
};

pub const REQUIRED: &str = "Finish installing OpenBot's local software before signing in or starting. Return to Install and try again.";
pub const FILE: &str = ".openbot-prepared.json";
const DEPENDENCIES: &str = ".openbot-dependencies.json";
const LAUNCH: &str = ".openbot-launched.json";
/// The engine this installation was set up on. Never invalidated with the preparation record: a
/// new release is prepared again on the same engine, where its database already is.
pub const ENGINE: &str = ".openbot-engine.json";
const PACKAGES: [&str; 7] = [
    "",
    "server",
    "app",
    "worker",
    "shared",
    "toolkit",
    "extension",
];
/// Packages a release has only since #784 (`shared` as a package, `toolkit`) and #858 (`extension`).
/// v0.2.0, still the latest release when this desktop was built, has `shared` as plain source and no
/// `toolkit` or `extension`; requiring their manifests failed every new install with
/// "shared/package.json: No such file or directory".
const LATER_PACKAGES: [&str; 3] = ["shared", "toolkit", "extension"];

/// The packages this release actually has: every one in `PACKAGES`, less a later one it predates.
fn packages(root: &Path) -> impl Iterator<Item = &'static str> + '_ {
    PACKAGES.into_iter().filter(move |package| {
        !LATER_PACKAGES.contains(package) || root.join(package).join("package.json").is_file()
    })
}

#[derive(Serialize, Deserialize)]
struct Dependencies {
    fingerprint: String,
    bun: PathBuf,
    package_files: Vec<PathBuf>,
}

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

pub fn save_selected_root(config: &Path, root: &Path) -> Result<(), Problem> {
    let root = std::fs::canonicalize(root).map_err(|e| {
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

pub fn selected_root(config: &Path) -> Option<PathBuf> {
    let root: PathBuf =
        serde_json::from_slice(&std::fs::read(config.join("last-launched-root.json")).ok()?)
            .ok()?;
    root.is_absolute().then_some(root)
}

pub fn required(detail: impl Into<String>) -> Problem {
    Problem::with(REQUIRED, detail)
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

/// Packages installed apart from the root workspace, each from its own lockfile.
fn separate_packages(root: &Path) -> Vec<&'static str> {
    stack::dependency_directories(root)
        .into_iter()
        .filter(|directory| !directory.is_empty())
        .collect()
}

fn dependency_fingerprint(root: &Path) -> Result<String, Problem> {
    hash_files(
        root,
        std::iter::once(PathBuf::from("bun.lock"))
            .chain(packages(root).map(|path| Path::new(path).join("package.json")))
            .chain(separate_packages(root).into_iter().flat_map(|package| {
                [
                    Path::new(package).join("bun.lock"),
                    Path::new(package).join("package.json"),
                ]
            })),
    )
}

/// The built Recorder's manifest, in a release whose person's browser loads it.
fn recorder_manifest() -> PathBuf {
    Path::new(local_browser::RECORDER_DIST).join("manifest.json")
}

fn fingerprint(root: &Path) -> Result<String, Problem> {
    let mut files = vec![
        PathBuf::from(".openbot-deployment"),
        PathBuf::from("container-images.json"),
        PathBuf::from("docker-compose.yml"),
        PathBuf::from(DEPENDENCIES),
    ];
    // A release with the person's browser is installed only with its Recorder in place, so one that
    // has gone missing sends Start back to Installation rather than starting a browser with no
    // Recorder to load.
    if local_browser::in_release(root) {
        files.push(recorder_manifest());
    }
    hash_files(root, files)
}

fn write_record(root: &Path, name: &str, value: &impl Serialize) -> Result<(), Problem> {
    let target = root.join(name);
    let temporary = root.join(format!("{name}.tmp"));
    let bytes = serde_json::to_vec(value).map_err(|e| required(e.to_string()))?;
    std::fs::write(&temporary, bytes).map_err(|e| required(e.to_string()))?;
    // Windows rename does not replace an existing file. A missing checkpoint is safe on interruption.
    match std::fs::remove_file(&target) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(required(e.to_string())),
    }
    std::fs::rename(temporary, target).map_err(|e| required(e.to_string()))
}

pub fn invalidate(root: &Path) -> Result<(), Problem> {
    match std::fs::remove_file(root.join(FILE)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(required(e.to_string())),
    }
}

/// Record resolved package manifests, not just the existence of a partial node_modules directory.
fn package_files(root: &Path) -> Result<Vec<PathBuf>, Problem> {
    let mut files = BTreeSet::new();
    for package in packages(root).chain(separate_packages(root)) {
        let directory = root.join(package);
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.join("package.json")).map_err(|e| required(e.to_string()))?,
        )
        .map_err(|e| required(e.to_string()))?;
        for group in ["dependencies", "devDependencies"] {
            for name in manifest
                .get(group)
                .and_then(serde_json::Value::as_object)
                .into_iter()
                .flat_map(|entries| entries.keys())
            {
                let relative = Path::new("node_modules").join(name).join("package.json");
                let file = [directory.join(&relative), root.join(&relative)]
                    .into_iter()
                    .find(|path| path.is_file())
                    .ok_or_else(|| {
                        required(format!(
                            "The installed package {name} is missing from {package}."
                        ))
                    })?;
                files.insert(std::fs::canonicalize(file).map_err(|e| required(e.to_string()))?);
            }
        }
    }
    Ok(files.into_iter().collect())
}

pub fn record_dependencies(root: &Path, bun: &Path) -> Result<(), Problem> {
    let record = Dependencies {
        fingerprint: dependency_fingerprint(root)?,
        bun: bun.to_path_buf(),
        package_files: package_files(root)?,
    };
    write_record(root, DEPENDENCIES, &record)
}

pub fn install_dependencies_if_needed(
    root: &Path,
    acquire_runtime: impl FnOnce() -> Result<PathBuf, Problem>,
) -> Result<PathBuf, Problem> {
    if let Ok(bun) = dependencies_ready(root) {
        return Ok(bun);
    }
    let bun = acquire_runtime()?;
    stack::install_dependencies(root, &bun)?;
    record_dependencies(root, &bun)?;
    Ok(bun)
}

/// The published image the Recorder is copied out of: the computer's, which carries the built
/// Recorder at [`IMAGE_RECORDER`] for every person's browser it opens (`agent-computer/Dockerfile`).
pub const RECORDER_IMAGE: &str = "agent-computer";

/// Where the computer image keeps the built Recorder.
pub const IMAGE_RECORDER: &str = "/recorder";

/// Put the Recorder into the deployment, for the person's browser to load.
///
/// PREBUILT, NEVER BUILT HERE. The release's own computer image carries the Recorder its CI built
/// from the same tag (`agent-computer/Dockerfile` builds it and keeps only `extension/dist`), and
/// installation has just pulled that image, digest-pinned from the release's manifest. So the
/// Recorder is copied out of it: what every hosted person's browser loads, byte for byte, and
/// nothing is compiled on the person's machine. It used to be three Vite builds run here with the
/// installation's Bun: a build tool run on every person's machine at install, and a Recorder that
/// could differ from the hosted one.
///
/// Copied out of a container that is created and never started (`create --pull=never`, so a
/// missing image is an error rather than a download nobody asked for), into a folder beside the
/// old copy, which replaces it only once the new one is whole. Every installation copies it again,
/// since an upgrade lays new source over the old one.
pub fn place_recorder(root: &Path, address: &Address) -> Result<(), Problem> {
    if !local_browser::in_release(root) {
        return Ok(());
    }
    let image = deployment::reference(root, RECORDER_IMAGE).map_err(|detail| {
        Problem::with(
            "OpenBot could not set up the Recorder for its browser. Try again.",
            detail,
        )
    })?;
    place_recorder_with(root, &image, &mut |args| {
        address.command().args(args).output()
    })
}

/// [`place_recorder`], with the engine command it runs given, so a test can stand in for it.
pub fn place_recorder_with(
    root: &Path,
    image: &str,
    engine: &mut dyn FnMut(&[&str]) -> std::io::Result<std::process::Output>,
) -> Result<(), Problem> {
    let failed = |detail: String| {
        Problem::with(
            "OpenBot could not set up the Recorder for its browser. Try again.",
            detail,
        )
    };
    let run = |engine: &mut dyn FnMut(&[&str]) -> std::io::Result<std::process::Output>,
               args: &[&str]|
     -> Result<String, Problem> {
        let output = engine(args)
            .map_err(|error| failed(format!("could not run the engine's {}: {error}", args[0])))?;
        if !output.status.success() {
            return Err(failed(format!(
                "the engine's {} failed: {}",
                args[0],
                crate::quiet::said(&output.stderr)
            )));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    };
    let target = root.join(local_browser::RECORDER_DIST);
    let fresh = target.with_extension("new");
    let _ = std::fs::remove_dir_all(&fresh);
    std::fs::create_dir_all(&fresh)
        .map_err(|error| failed(format!("{}: {error}", fresh.display())))?;
    let container = run(engine, &["create", "--pull=never", image])?;
    let copied = run(
        engine,
        &[
            "cp",
            &format!("{container}:{IMAGE_RECORDER}/."),
            &fresh.to_string_lossy(),
        ],
    );
    // Never left behind, whatever the copy did. It never ran, so there is nothing to stop.
    let removed = run(engine, &["rm", "--force", &container]);
    copied?;
    removed?;
    if !fresh.join("manifest.json").is_file() {
        let _ = std::fs::remove_dir_all(&fresh);
        return Err(failed(format!(
            "{image} has no Recorder at {IMAGE_RECORDER}"
        )));
    }
    match std::fs::remove_dir_all(&target) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(failed(format!("{}: {error}", target.display()))),
    }
    std::fs::rename(&fresh, &target)
        .map_err(|error| failed(format!("{}: {error}", target.display())))
}

pub fn dependencies_ready(root: &Path) -> Result<PathBuf, Problem> {
    let bytes = std::fs::read(root.join(DEPENDENCIES)).map_err(|e| required(e.to_string()))?;
    let record: Dependencies =
        serde_json::from_slice(&bytes).map_err(|e| required(e.to_string()))?;
    if record.fingerprint != dependency_fingerprint(root)?
        || record.package_files.iter().any(|file| !file.is_file())
    {
        return Err(required(
            "The installed dependencies are incomplete or the lockfile changed.",
        ));
    }
    // This executes only the installed runtime's version probe; it cannot install packages.
    crate::install::verify_bun(&record.bun)
        .map_err(|problem| required(problem.detail.unwrap_or(problem.said)))?;
    Ok(record.bun)
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
    dependencies_ready(root)?;
    verify(&images)?;
    record(root, harness, images)
}

/// `selection=None` is the auth check, which has no authority to change the Bot selection.
pub fn require(
    root: &Path,
    selection: Option<&Option<HarnessChoice>>,
    address: &Address,
) -> Result<PathBuf, Problem> {
    require_with(root, selection, |images| require_images(address, images))
}

fn require_with(
    root: &Path,
    selection: Option<&Option<HarnessChoice>>,
    verify: impl FnOnce(&[String]) -> Result<(), Problem>,
) -> Result<PathBuf, Problem> {
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
    // A deployment laid out by an app that copied less still matches its own fingerprint. Install
    // lays it out again; Start cannot.
    if deployment::installed(root)
        .is_some_and(|found| deployment::needs_fetch(root, &found.version))
    {
        return Err(required(
            "The deployment was laid out by an earlier OpenBot and is missing files this version runs.",
        ));
    }
    let bun = dependencies_ready(root)?;
    verify(&record.images)?;
    Ok(bun)
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

    #[test]
    fn a_release_from_before_the_toolkit_needs_no_shared_or_toolkit_manifest() {
        let root = crate::test_support::temp_root("preparation-v020-layout");
        for package in ["", "server", "app", "worker"] {
            std::fs::create_dir_all(root.join(package)).unwrap();
            std::fs::write(root.join(package).join("package.json"), "{}").unwrap();
        }
        // v0.2.0: `shared` is source with no manifest, and there is no `toolkit` or `extension`.
        std::fs::create_dir_all(root.join("shared")).unwrap();
        assert_eq!(
            packages(&root).collect::<Vec<_>>(),
            ["", "server", "app", "worker"]
        );
        std::fs::write(root.join("bun.lock"), "lock").unwrap();
        assert!(dependency_fingerprint(&root).is_ok());
        assert!(package_files(&root).is_ok());
        // A release that has them is held to them.
        for package in LATER_PACKAGES {
            std::fs::create_dir_all(root.join(package)).unwrap();
            std::fs::write(root.join(package).join("package.json"), "{}").unwrap();
        }
        assert_eq!(packages(&root).count(), PACKAGES.len());
        // The packages every release has stay required.
        std::fs::remove_file(root.join("server").join("package.json")).unwrap();
        assert!(dependency_fingerprint(&root).is_err());
    }

    struct Fixture {
        root: PathBuf,
        bun: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = crate::test_support::temp_root("preparation");
            for package in PACKAGES {
                std::fs::create_dir_all(root.join(package)).unwrap();
                std::fs::write(
                    root.join(package).join("package.json"),
                    r#"{"scripts":{"serve":"bun serve.ts"}}"#,
                )
                .unwrap();
            }
            let root = std::fs::canonicalize(root).unwrap();
            std::fs::write(
                root.join("package.json"),
                r#"{"dependencies":{"synthetic-package":"1"}}"#,
            )
            .unwrap();
            std::fs::write(root.join("bun.lock"), "synthetic-lock").unwrap();
            std::fs::write(root.join("docker-compose.yml"), "services: {}\n").unwrap();
            std::fs::write(root.join("container-images.json"), "{}").unwrap();
            deployment::record(&root, "v-test").unwrap();
            let source = root.join("runtime.rs");
            std::fs::write(&source, r#"
use std::io::Write;
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        let version = std::env::current_exe().unwrap().parent().unwrap().join("runtime-version");
        println!("{}", std::fs::read_to_string(version).unwrap_or_else(|_| "1.4.3".into()));
        return;
    }
    assert_eq!(args, ["install", "--frozen-lockfile", "--ignore-scripts"]);
    let previous = std::fs::read_to_string("installs").unwrap_or_default();
    writeln!(std::fs::OpenOptions::new().create(true).append(true).open("installs").unwrap(), "install").unwrap();
    std::fs::create_dir_all("node_modules/synthetic-package").unwrap();
    let separate = std::env::current_dir().unwrap().ends_with("agent-computer");
    if previous.is_empty() && !separate { std::process::exit(71); }
    std::fs::write("node_modules/synthetic-package/package.json", "{}").unwrap();
}
"#).unwrap();
            let bun = root.join(format!("runtime{}", std::env::consts::EXE_SUFFIX));
            crate::test_support::compile_fixture(&source, &bun);
            Self { root, bun }
        }

        fn dependencies(&self) {
            std::fs::create_dir_all(self.root.join("node_modules/synthetic-package")).unwrap();
            std::fs::write(
                self.root
                    .join("node_modules/synthetic-package/package.json"),
                "{}",
            )
            .unwrap();
            record_dependencies(&self.root, &self.bun).unwrap();
        }

        fn prepared(&self, harness: Option<&HarnessChoice>) {
            self.dependencies();
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

    #[test]
    fn failed_dependencies_retry_then_auth_reuses_success_without_installing() {
        let f = Fixture::new();
        std::fs::write(f.root.join(".env"), "KEEP_THIS_PUBLIC_SETTING=yes\n").unwrap();
        let install = || install_dependencies_if_needed(&f.root, || Ok(f.bun.clone()));
        assert!(install().is_err());
        assert!(!f.root.join(DEPENDENCIES).exists());
        assert!(f.root.join("node_modules").is_dir());
        install().unwrap();
        install_dependencies_if_needed(&f.root, || panic!("cached runtime must be reused"))
            .unwrap();
        f.prepared(None);
        for _ in 0..2 {
            require_with(&f.root, None, |images| {
                assert_eq!(images, ["synthetic-image"]);
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(
            std::fs::read_to_string(f.root.join("installs")).unwrap(),
            "install\ninstall\n"
        );
        assert_eq!(
            std::fs::read_to_string(f.root.join(".env")).unwrap(),
            "KEEP_THIS_PUBLIC_SETTING=yes\n"
        );
    }

    /// A v0.2.0 install prepared by an app that did not copy `agent-computer` still matched its
    /// fingerprint, so Start ran a server that could not load. Start now sends it back to Install,
    /// which lays the deployment out again.
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

    #[test]
    fn cached_dependencies_with_unsupported_runtime_require_installation_before_start() {
        let f = Fixture::new();
        f.dependencies();
        std::fs::write(f.root.join("runtime-version"), "1.2.15").unwrap();
        let problem = dependencies_ready(&f.root).expect_err("a cached older runtime is not ready");
        assert!(problem.said.contains("Finish installing"));
        assert!(problem
            .detail
            .unwrap_or_default()
            .contains(crate::install::BUN));
    }

    #[test]
    fn failed_image_preparation_cannot_publish_completion() {
        let f = Fixture::new();
        f.dependencies();
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
    fn changed_bot_lockfile_or_deleted_package_requires_installation() {
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
        std::fs::remove_file(f.root.join("node_modules/synthetic-package/package.json")).unwrap();
        assert!(require_with(&f.root, Some(&chosen), |_| Ok(())).is_err());
        f.dependencies();
        f.prepared(chosen.as_ref());
        std::fs::write(f.root.join("bun.lock"), "changed-lock").unwrap();
        assert!(require_with(&f.root, Some(&chosen), |_| Ok(())).is_err());
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
        assert_eq!(selected_root(&config), Some(f.root.clone()));
        assert_eq!(launch(&f.root).unwrap().harness, Some(chosen));
        std::fs::remove_file(f.root.join("node_modules/synthetic-package/package.json")).unwrap();
        assert!(
            launch(&f.root).is_some(),
            "resume intent survives missing assets for explicit install recovery"
        );
        invalidate(&f.root).unwrap();
        assert!(launch(&f.root).is_none());
        assert_eq!(
            selected_root(&config),
            Some(f.root.clone()),
            "repair must not forget the last successful folder"
        );
    }

    /// A release with the person's browser: its computer's packages are installed from their own
    /// lockfile, and it is not installed until its Recorder is in place. One that goes missing
    /// afterwards sends Start back to Installation, which puts it there again.
    #[test]
    fn a_release_with_the_browser_is_installed_only_with_its_recorder_in_place() {
        let f = Fixture::new();
        std::fs::create_dir_all(f.root.join("shared")).unwrap();
        std::fs::write(f.root.join(local_browser::CONTRACT), "export {};\n").unwrap();
        std::fs::create_dir_all(f.root.join("agent-computer")).unwrap();
        std::fs::write(
            f.root.join("agent-computer/package.json"),
            r#"{"dependencies":{"synthetic-package":"1"}}"#,
        )
        .unwrap();
        std::fs::write(f.root.join("agent-computer/bun.lock"), "synthetic-lock").unwrap();

        let install = || install_dependencies_if_needed(&f.root, || Ok(f.bun.clone()));
        assert!(install().is_err(), "the fixture's first root install fails");
        install().unwrap();
        assert!(f
            .root
            .join("agent-computer/node_modules/synthetic-package/package.json")
            .is_file());

        let images = || vec!["synthetic-image".to_string()];
        let unbuilt = complete_with(&f.root, None, images(), |_| Ok(()))
            .expect_err("no Recorder, no installation");
        assert!(unbuilt.said.contains("Finish installing"), "{unbuilt:?}");

        let image = ComputerImage::with_recorder();
        place_recorder_with(&f.root, COMPUTER, &mut image.engine()).unwrap();
        complete_with(&f.root, None, images(), |_| Ok(())).unwrap();
        require_with(&f.root, None, |_| Ok(())).unwrap();

        std::fs::remove_dir_all(f.root.join(local_browser::RECORDER_DIST)).unwrap();
        let gone = require_with(&f.root, None, |_| Ok(()))
            .expect_err("Start must not run a browser with no Recorder to load");
        assert!(gone.said.contains("Finish installing"), "{gone:?}");

        // A changed lockfile for the computer is a changed installation, as the root's is.
        place_recorder_with(&f.root, COMPUTER, &mut image.engine()).unwrap();
        complete_with(&f.root, None, images(), |_| Ok(())).unwrap();
        std::fs::write(f.root.join("agent-computer/bun.lock"), "changed-lock").unwrap();
        assert!(require_with(&f.root, None, |_| Ok(())).is_err());
    }

    /// Releases before the browser have no Recorder to put in place and no computer to install for.
    #[test]
    fn an_older_release_places_nothing_and_installs_only_its_workspace() {
        let f = Fixture::new();
        // `place_recorder` asks nothing of the engine or the manifest for a release without the browser.
        let address = Address::new(crate::engine::Engine::Docker, None);
        place_recorder(&f.root, &address).unwrap();
        assert!(!f.root.join(local_browser::RECORDER_DIST).exists());
        assert_eq!(stack::dependency_directories(&f.root), [""]);
    }

    /// The release's computer image, digest-pinned, as the manifest names it.
    const COMPUTER: &str = "ghcr.io/copilotkit/openbot-agent-computer@sha256:0123";

    /// A process's result, as the engine's command line leaves it.
    fn exited(code: i32, stdout: &str, stderr: &str) -> std::process::Output {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        #[cfg(unix)]
        let status = std::process::ExitStatus::from_raw(code << 8);
        #[cfg(windows)]
        let status = std::process::ExitStatus::from_raw(code as u32);
        std::process::Output {
            status,
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    /// The engine with the release's computer image pulled, answering `create`, `cp` and `rm` as
    /// Docker's and Podman's command lines do: `create` prints the new container's id, `cp` of
    /// `<id>:/recorder/.` copies the folder's contents into the destination, and `rm` of a
    /// container that does not exist fails. Every command is written down.
    struct ComputerImage {
        recorder: Option<PathBuf>,
        fail_copy: bool,
        ran: std::rc::Rc<std::cell::RefCell<Vec<Vec<String>>>>,
    }

    impl ComputerImage {
        fn with_recorder() -> Self {
            let recorder = crate::test_support::temp_root("image-recorder");
            std::fs::create_dir_all(recorder.join("background")).unwrap();
            std::fs::write(
                recorder.join("manifest.json"),
                r#"{"name":"OpenBot Recorder"}"#,
            )
            .unwrap();
            std::fs::write(recorder.join("background/index.js"), "prebuilt();").unwrap();
            Self {
                recorder: Some(recorder),
                fail_copy: false,
                ran: Default::default(),
            }
        }

        fn failing_copy(mut self) -> Self {
            self.fail_copy = true;
            self
        }

        fn engine(&self) -> impl FnMut(&[&str]) -> std::io::Result<std::process::Output> + '_ {
            let mut created: Option<String> = None;
            move |args: &[&str]| {
                self.ran
                    .borrow_mut()
                    .push(args.iter().map(|arg| arg.to_string()).collect());
                Ok(match args {
                    ["create", "--pull=never", image] if *image == COMPUTER => {
                        created = Some("c0ffee".into());
                        exited(0, "c0ffee\n", "")
                    }
                    ["create", ..] => exited(125, "", "Error: No such image"),
                    ["cp", from, to]
                        if Some(format!("{}:/recorder/.", "c0ffee")) == Some(from.to_string())
                            && created.is_some() =>
                    {
                        if self.fail_copy {
                            return Ok(exited(1, "", "Error: copy failed"));
                        }
                        match &self.recorder {
                            Some(recorder) => copy_tree(recorder, Path::new(to)),
                            None => {
                                return Ok(exited(
                                    1,
                                    "",
                                    "Error: Could not find the file /recorder in container c0ffee",
                                ))
                            }
                        }
                        exited(0, "", "")
                    }
                    ["rm", "--force", id] if created.as_deref() == Some(*id) => {
                        created = None;
                        exited(0, "c0ffee\n", "")
                    }
                    _ => exited(1, "", "unexpected engine command"),
                })
            }
        }
    }

    impl Drop for ComputerImage {
        fn drop(&mut self) {
            if let Some(recorder) = &self.recorder {
                let _ = std::fs::remove_dir_all(recorder);
            }
        }
    }

    fn copy_tree(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_tree(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    /// The Recorder used to be built with `bun run build` on the person's machine during
    /// installation. It is copied out of the release's computer image instead, prebuilt,
    /// replacing whatever an earlier installation left, and the container it came out of is gone.
    #[test]
    fn the_recorder_comes_prebuilt_out_of_the_releases_computer_image() {
        let f = Fixture::new();
        let dist = f.root.join(local_browser::RECORDER_DIST);
        // An earlier installation's copy, with a file the new one no longer has.
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("stale.js"), "old").unwrap();
        let image = ComputerImage::with_recorder();
        place_recorder_with(&f.root, COMPUTER, &mut image.engine()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dist.join("background/index.js")).unwrap(),
            "prebuilt();"
        );
        assert!(dist.join("manifest.json").is_file());
        assert!(!dist.join("stale.js").exists());
        assert!(!dist.with_extension("new").exists());
        let fresh = dist.with_extension("new").to_string_lossy().into_owned();
        assert_eq!(
            *image.ran.borrow(),
            [
                vec!["create", "--pull=never", COMPUTER],
                vec!["cp", "c0ffee:/recorder/.", fresh.as_str()],
                vec!["rm", "--force", "c0ffee"],
            ]
        );
    }

    /// The copy through the real engine's command line, out of a real image that keeps a Recorder
    /// at `/recorder` as the computer image does, and the container it made gone afterwards.
    ///
    /// ```sh
    /// OPENBOT_LIVE_RECORDER_IMAGE=<image> cargo test --lib live_the_recorder -- --ignored
    /// ```
    #[test]
    #[ignore = "creates a container from an image on this machine's Docker engine"]
    fn live_the_recorder_is_copied_out_of_a_real_image() {
        let image = std::env::var("OPENBOT_LIVE_RECORDER_IMAGE").unwrap();
        let f = Fixture::new();
        let address = Address::new(crate::engine::Engine::Docker, None);
        let before = address
            .command()
            .args(["ps", "--all", "--quiet"])
            .output()
            .unwrap()
            .stdout;
        place_recorder_with(&f.root, &image, &mut |args| {
            address.command().args(args).output()
        })
        .unwrap();
        assert!(f
            .root
            .join(local_browser::RECORDER_DIST)
            .join("manifest.json")
            .is_file());
        let after = address
            .command()
            .args(["ps", "--all", "--quiet"])
            .output()
            .unwrap()
            .stdout;
        assert_eq!(before, after, "the container it copied from is gone");
    }

    /// An image with no Recorder in it, or a copy that fails, leaves the earlier copy as it was and
    /// no container behind, and says so.
    #[test]
    fn an_image_without_the_recorder_leaves_the_last_one_and_no_container() {
        let f = Fixture::new();
        let dist = f.root.join(local_browser::RECORDER_DIST);
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("manifest.json"), "earlier").unwrap();
        for image in [
            ComputerImage {
                recorder: None,
                fail_copy: false,
                ran: Default::default(),
            },
            ComputerImage::with_recorder().failing_copy(),
        ] {
            let problem = place_recorder_with(&f.root, COMPUTER, &mut image.engine())
                .expect_err("no Recorder, no installation");
            assert!(problem.said.contains("Recorder"), "{problem:?}");
            assert_eq!(
                image.ran.borrow().last().unwrap(),
                &vec!["rm", "--force", "c0ffee"]
            );
            assert_eq!(
                std::fs::read_to_string(dist.join("manifest.json")).unwrap(),
                "earlier"
            );
        }
        // A missing image is never pulled: it is an error.
        let image = ComputerImage::with_recorder();
        let problem = place_recorder_with(&f.root, "some-other-image", &mut image.engine())
            .expect_err("only the release's image");
        assert!(problem.detail.unwrap().contains("No such image"));
    }

    #[test]
    fn every_root_workspace_is_fingerprinted() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../package.json")).unwrap();
        for workspace in manifest["workspaces"].as_array().unwrap() {
            let workspace = workspace.as_str().unwrap();
            assert!(
                PACKAGES.contains(&workspace),
                "{workspace} is a root workspace whose dependencies are not fingerprinted"
            );
        }
    }
}
