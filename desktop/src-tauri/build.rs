fn main() {
    // Cargo resolves RUSTC for build scripts, but does not promise it at test runtime. Tests
    // compile native command fixtures using this toolchain, independent of fake-engine PATHs.
    let compiler = std::env::var_os("RUSTC").expect("Cargo supplies RUSTC to build scripts");
    let tool_path = std::env::var_os("PATH").expect("Cargo build needs a tool PATH");
    let compiler = std::path::PathBuf::from(compiler);
    let compiler = if compiler.is_absolute() {
        compiler
    } else if compiler.components().count() > 1 {
        std::env::current_dir().unwrap().join(compiler)
    } else {
        std::env::split_paths(&tool_path)
            .flat_map(|directory| {
                [
                    directory.join(&compiler),
                    directory.join(format!(
                        "{}{}",
                        compiler.display(),
                        std::env::consts::EXE_SUFFIX
                    )),
                ]
            })
            .find(|candidate| candidate.is_file())
            .expect("Cargo's compiler must resolve on its build PATH")
    };
    println!("cargo:rustc-env=OPENBOT_TEST_RUSTC={}", compiler.display());
    println!(
        "cargo:rustc-env=OPENBOT_TEST_TOOL_PATH={}",
        tool_path.to_string_lossy()
    );
    println!("cargo:rerun-if-env-changed=RUSTC");
    println!("cargo:rerun-if-env-changed=PATH");
    pin_deployment();
    tauri_build::build()
}

/// Compile in the deployment named by `OPENBOT_PINNED_DEPLOYMENT`, when there is one.
///
/// A public release follows the newest published deployment. An internal or candidate installer
/// is built to try one exact deployment, which has no public release to fetch, so it carries that
/// deployment's image manifest inside the binary. The variable holds the path of that manifest. An
/// unset or empty variable is a public build, and nothing is written.
fn pin_deployment() {
    println!("cargo:rustc-check-cfg=cfg(openbot_pinned)");
    println!("cargo:rerun-if-env-changed=OPENBOT_PINNED_DEPLOYMENT");
    let Some(path) = std::env::var_os("OPENBOT_PINNED_DEPLOYMENT").filter(|path| !path.is_empty())
    else {
        return;
    };
    let path = std::path::PathBuf::from(path);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "OPENBOT_PINNED_DEPLOYMENT names {}, which could not be read: {error}",
            path.display()
        )
    });
    let manifest: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|error| {
        panic!(
            "OPENBOT_PINNED_DEPLOYMENT names {}, which is not JSON: {error}",
            path.display()
        )
    });
    if !manifest["version"].is_string() {
        panic!(
            "the pinned deployment manifest {} has no string `version`",
            path.display()
        );
    }
    let commit = manifest["commit"]
        .as_str()
        .filter(|commit| commit.len() == 40 && commit.chars().all(|c| c.is_ascii_hexdigit()))
        .unwrap_or_else(|| {
            panic!(
                "the pinned deployment manifest {} needs `commit` to be a full 40-character hex commit",
                path.display()
            )
        });
    let compiled = compiled_commit();
    if commit != compiled {
        panic!(
            "the pinned deployment manifest {} has `commit` {commit}, but this build compiles {compiled}; \
             a pinned installer must be built from the commit its release was cut from",
            path.display()
        );
    }
    let images = manifest["images"]
        .as_object()
        .filter(|images| !images.is_empty())
        .unwrap_or_else(|| {
            panic!(
                "the pinned deployment manifest {} needs `images` to be an object naming each image",
                path.display()
            )
        });
    for (name, image) in images {
        let reference = image["reference"].as_str().unwrap_or_default();
        if !pinned_by_digest(reference) {
            panic!(
                "the pinned deployment manifest {} has `images.{name}.reference` {reference:?}, \
                 which is not pinned by digest (`<image>@sha256:<64 hex>`)",
                path.display()
            );
        }
    }
    let out =
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo supplies OUT_DIR"));
    std::fs::copy(&path, out.join("pinned-images.json")).unwrap_or_else(|error| {
        panic!(
            "could not copy the pinned deployment manifest {} into the build: {error}",
            path.display()
        )
    });
    println!("cargo:rerun-if-changed={}", path.display());
    println!("cargo:rustc-env=OPENBOT_PINNED_COMMIT={commit}");
    println!("cargo:rustc-cfg=openbot_pinned");
}

/// Whether an image reference names its image by digest, as images.yml publishes it.
fn pinned_by_digest(reference: &str) -> bool {
    reference
        .split_once("@sha256:")
        .is_some_and(|(image, digest)| {
            !image.is_empty()
                && digest.len() == 64
                && digest
                    .chars()
                    .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        })
}

/// The full commit being compiled, asked of git. Only a pinned build needs it, so only a pinned
/// build fails without git.
fn compiled_commit() -> String {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
    };
    let commit = git(&["rev-parse", "HEAD"]).unwrap_or_else(|| {
        panic!(
            "OPENBOT_PINNED_DEPLOYMENT is set, and git could not say which commit is being built; \
             a pinned installer is built from a git checkout of the commit its release was cut from"
        )
    });
    // Check again when the checkout moves to another commit, not only when the manifest changes.
    for file in [
        git(&["rev-parse", "--git-path", "HEAD"]),
        git(&["symbolic-ref", "-q", "HEAD"])
            .and_then(|branch| git(&["rev-parse", "--git-path", &branch])),
    ]
    .into_iter()
    .flatten()
    {
        println!("cargo:rerun-if-changed={file}");
    }
    commit
}
