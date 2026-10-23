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
    // The one way the OpenBot app's own page reaches the shell: an inline plugin whose commands get
    // permissions of their own, granted at runtime to the exact owned app origin. App commands stay
    // out of a remote page's reach.
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "openbot-intelligence",
        tauri_build::InlinedPlugin::new().commands(&["watch", "open"]),
    ))
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
    let node = format!("node{}", if cfg!(windows) { ".exe" } else { "" });
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
}
