//! Local installation checkpoints. These contain no credentials and never grant runtime ownership.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{deployment, engine::Address, harness::HarnessChoice, problem::Problem, stack};

pub const REQUIRED: &str = "Finish installing OpenBot's local software before signing in or starting. Return to Install and try again.";
pub const FILE: &str = ".openbot-prepared.json";
const DEPENDENCIES: &str = ".openbot-dependencies.json";
const LAUNCH: &str = ".openbot-launched.json";
const PACKAGES: [&str; 4] = ["", "server", "app", "worker"];

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

fn dependency_fingerprint(root: &Path) -> Result<String, Problem> {
    hash_files(
        root,
        std::iter::once(PathBuf::from("bun.lock"))
            .chain(PACKAGES.map(|path| Path::new(path).join("package.json"))),
    )
}

fn fingerprint(root: &Path) -> Result<String, Problem> {
    hash_files(
        root,
        [
            PathBuf::from(".openbot-deployment"),
            PathBuf::from("container-images.json"),
            PathBuf::from("docker-compose.yml"),
            PathBuf::from(DEPENDENCIES),
        ],
    )
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
    for package in PACKAGES {
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
        println!("{}", std::fs::read_to_string(version).unwrap_or_else(|_| "1.3.14".into()));
        return;
    }
    assert_eq!(args, ["install", "--frozen-lockfile", "--ignore-scripts"]);
    let previous = std::fs::read_to_string("installs").unwrap_or_default();
    writeln!(std::fs::OpenOptions::new().create(true).append(true).open("installs").unwrap(), "install").unwrap();
    std::fs::create_dir_all("node_modules/synthetic-package").unwrap();
    if previous.is_empty() { std::process::exit(71); }
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
}
