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
    build_identity();
    bundled_cli();
    pin_deployment();
    // The one way the OpenBot app's own page reaches the shell: an inline plugin whose commands get
    // permissions of their own, granted at runtime to the exact owned app origin. App commands stay
    // out of a remote page's reach.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .plugin(
                "openbot-intelligence",
                tauri_build::InlinedPlugin::new().commands(&["watch", "open"]),
            )
            // Settings → This computer: the Status window's facts and actions, from the app. And
            // the update banner, which reads what the shell found in its update feed.
            .plugin(
                "openbot-desktop",
                tauri_build::InlinedPlugin::new().commands(&[
                    "appearance",
                    "status",
                    "restart",
                    "stop",
                    "intelligence",
                    "update_offer",
                    "check_update",
                    "dismiss_update",
                    "install_update",
                    // Dictation's and narration's speech recognition, on this computer. See `src/speech.rs`.
                    "speech_available",
                    "speech_start",
                    "speech_stop",
                    "speech_abort",
                    // Open log folder: the shell's own log folder. See `src/logging.rs`.
                    "open_logs",
                    // A Bot's notification, opening OpenBot at a page when clicked. See `src/notice.rs`.
                    "notify",
                    // Settings' AI model row, and its Change. See `src/ai_connection.rs`.
                    "ai_connection",
                    "change_ai_connection",
                    // Settings' Share usage data. See `src/usage_data.rs`.
                    "usage_data",
                    "set_usage_data",
                    // Ctrl+Q in the window on Windows. See `src/quit-shortcut.js`.
                    "quit",
                    // The zoom keys no menu carries. See `src/zoom-shortcut.js`.
                    "zoom",
                ]),
            ),
    )
    .expect("the Tauri build failed")
}

/**
What "About OpenBot" says about this build: the commit, whether the tree had uncommitted changes,
the branch, and when it was built.

Several worktrees build this app on one machine, and the window looks the same from all of them,
so which one is running is otherwise a guess. Rerun on every source change, or the time and the
dirty mark would be those of whenever this script last happened to run.
*/
fn build_identity() {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    };
    let commit = git(&["rev-parse", "--short", "HEAD"])
        .filter(|commit| !commit.is_empty())
        .unwrap_or_else(|| "unknown".into());
    let dirty = git(&["status", "--porcelain", "--untracked-files=no"])
        .is_some_and(|changes| !changes.is_empty());
    let branch = git(&["branch", "--show-current"]).unwrap_or_default();
    let built = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or_default();
    println!(
        "cargo:rustc-env=OPENBOT_BUILD_COMMIT={commit}{}",
        if dirty { "-dirty" } else { "" }
    );
    println!("cargo:rustc-env=OPENBOT_BUILD_BRANCH={branch}");
    println!("cargo:rustc-env=OPENBOT_BUILD_TIME={built}");
    // A commit moves the branch's ref; staging changes the index. Both are under the git dir, which
    // for a worktree is not `.git` in the checkout.
    for path in ["HEAD", "index"] {
        if let Some(path) = git(&["rev-parse", "--git-path", path]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    if let Some(reference) = git(&["symbolic-ref", "-q", "HEAD"]) {
        if let Some(path) = git(&["rev-parse", "--git-path", &reference]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=../src");
}

// `cli_release::pinned_release_in`, the one reading of which Intelligence a CLI build installs.
include!("src/cli_release.rs");

/**
The Intelligence CLI a build carries inside the app, pinned to the bytes it was built with.

Only with `OPENBOT_BUNDLED_CLI=1`, from `cli-bundle/` beside this file: `runtime/node` and
`cli/index.js` (and the CLI's `node_modules`), which `tauri.bundled-cli.conf.json` copies into the
app's resources. Their digests are compiled in, so the app runs exactly these files and nothing put
there afterwards. Every other build has no bundled CLI. See `local_eval::bundled_cli`.
*/
fn bundled_cli() {
    println!("cargo:rerun-if-env-changed=OPENBOT_BUNDLED_CLI");
    if std::env::var("OPENBOT_BUNDLED_CLI").as_deref() != Ok("1") {
        return;
    }
    let root = std::path::Path::new("cli-bundle");
    // The target's, not `cfg!(windows)`: a build script is compiled for the machine building, so
    // a Windows app built on a Mac would otherwise pin a `node` that is not there.
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let node = format!("node{}", if windows { ".exe" } else { "" });
    for (variable, path) in [
        (
            "OPENBOT_BUNDLED_CLI_PROGRAM_SHA256",
            root.join("runtime").join(node),
        ),
        (
            "OPENBOT_BUNDLED_CLI_ENTRY_SHA256",
            root.join("cli").join("index.js"),
        ),
    ] {
        use sha2::Digest;
        let mut file = std::fs::File::open(&path).unwrap_or_else(|error| {
            panic!("OPENBOT_BUNDLED_CLI=1 needs {}: {error}", path.display())
        });
        let mut hasher = sha2::Sha256::new();
        std::io::copy(&mut file, &mut hasher).expect("the bundled CLI could not be read");
        println!("cargo:rustc-env={variable}={:x}", hasher.finalize());
        println!("cargo:rerun-if-changed={}", path.display());
    }
    // The Intelligence release the bundled CLI installs, so the app can tell a local Intelligence
    // that an older app installed is behind it (`local_eval::update_due`). A CLI built without a
    // pin names none, and then nothing is updated.
    let entry = std::fs::read(root.join("cli").join("index.js"))
        .expect("the bundled CLI could not be read");
    match pinned_release_in(&String::from_utf8_lossy(&entry)) {
        Some(release) => println!("cargo:rustc-env=OPENBOT_BUNDLED_CLI_INTELLIGENCE={release}"),
        None => println!(
            "cargo:warning=the bundled CLI is not pinned to an Intelligence release, so a local \
             Intelligence an older app installed is not updated"
        ),
    }
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
