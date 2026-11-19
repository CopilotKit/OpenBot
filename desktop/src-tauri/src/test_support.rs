use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_ROOT: AtomicU64 = AtomicU64::new(0);

/// Held by every test that binds or probes loopback ports, in every module. Tests run in
/// parallel, so one test's port could be taken by another between choosing it and using it.
/// A test that panics while holding it does not fail the others that wait for it.
///
/// It does not cover the other way a port given back stays taken: a process any test is starting
/// holds a copy of every open socket until it execs, so a listener just dropped can still be
/// bound, and even answer, for that moment. A test that needs a port again keeps its listener, or
/// runs alone (`isolated_process`).
#[allow(dead_code)] // The library's port tests use it; the binary shares this file.
static PORT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[allow(dead_code)]
pub(crate) fn hold_ports() -> std::sync::MutexGuard<'static, ()> {
    PORT_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn temp_root(label: &str) -> PathBuf {
    let next = NEXT_TEMP_ROOT.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("openbot-{label}-{}-{next}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    path
}

/// What every fixture is built with besides its own source: on macOS, a hook that runs before
/// `main` and ends the program at once when `FIXTURE_FIRST_LAUNCH` is set, so `compile_fixture`
/// can launch it without running any of the fixture.
const FIXTURE_FIRST_LAUNCH_HOOK: &str = r#"
#[cfg(target_os = "macos")]
#[used]
#[link_section = "__DATA,__mod_init_func"]
static OPENBOT_FIXTURE_FIRST_LAUNCH: extern "C" fn() = openbot_fixture_first_launch;
#[cfg(target_os = "macos")]
extern "C" fn openbot_fixture_first_launch() {
    if std::env::var_os("OPENBOT_TEST_FIXTURE_FIRST_LAUNCH").is_some() {
        std::process::exit(0);
    }
}
"#;
const FIXTURE_FIRST_LAUNCH: &str = "OPENBOT_TEST_FIXTURE_FIRST_LAUNCH";

/// Runtime PATH belongs to the scenario under test; the compiler and linker tools belong to
/// Cargo's build environment. Neither an inherited runtime RUSTC nor another test can replace it.
///
/// THE FIRST LAUNCH IS TAKEN HERE. macOS checks a program the first time it is launched, and on a
/// busy Mac that took more than ten seconds, with no CPU used, for a program that then ran in
/// milliseconds. A fixture launched first by the code under test spent that inside its limits
/// (an engine check, a readiness wait), and while a launch waits, the new process holds a copy of
/// every socket of the test process that started it, so a port another test gave back stayed
/// taken. Each fixture is launched once here, untimed, and ends before its `main`.
pub(crate) fn compile_fixture(source: &std::path::Path, binary: &std::path::Path) {
    let mut text =
        std::fs::read_to_string(source).expect("the fixture's source should be readable");
    text.push_str(FIXTURE_FIRST_LAUNCH_HOOK);
    let built_from = source.with_file_name(format!(
        "{}.first-launch.rs",
        source.file_name().unwrap().to_string_lossy()
    ));
    std::fs::write(&built_from, text).expect("the fixture's build source should be writable");
    let output = std::process::Command::new(env!("OPENBOT_TEST_RUSTC"))
        .env("PATH", env!("OPENBOT_TEST_TOOL_PATH"))
        // Source filenames can include executable suffixes, which are invalid crate names.
        .args(["--crate-name", "openbot_test_fixture"])
        .arg(&built_from)
        .arg("-o")
        .arg(binary)
        .output()
        .expect("Cargo's Rust compiler should run for the native fixture");
    let _ = std::fs::remove_file(&built_from);
    assert!(
        output.status.success(),
        "fixture did not compile: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    if cfg!(target_os = "macos") {
        let launched = std::process::Command::new(binary)
            .env(FIXTURE_FIRST_LAUNCH, "1")
            .stdin(std::process::Stdio::null())
            .output()
            .expect("the fixture should launch");
        assert!(
            launched.status.success() && launched.stdout.is_empty(),
            "the fixture ran past its first-launch hook: {launched:?}"
        );
    }
}

/// A command-line program that stands in for one the shell probes: `say` writes to both streams
/// and exits 3; `hang <marker>` sleeps for two seconds and then writes `marker`, so a marker that
/// never appears proves it was stopped rather than left to finish. Copied to a name of its own
/// (`powershell`, `wsl`), it is that program hanging whatever it is asked, and writes
/// `<name>-outlived` beside itself if it is not stopped.
#[allow(dead_code)] // The library's probe tests use it; the binary shares this file.
pub(crate) fn probe_cli(label: &str) -> PathBuf {
    let dir = temp_root(label);
    std::fs::create_dir_all(&dir).unwrap();
    let source = dir.join("probe_cli.rs");
    std::fs::write(
        &source,
        r#"
fn main() {
    let me = std::env::current_exe().unwrap();
    let name = me.file_stem().unwrap().to_string_lossy().into_owned();
    if name != "probe-cli" {
        std::thread::sleep(std::time::Duration::from_secs(2));
        std::fs::write(me.with_file_name(format!("{name}-outlived")), "outlived its limit").unwrap();
        return;
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("say") => {
            print!("said on stdout");
            eprint!("said on stderr");
            std::process::exit(3);
        }
        Some("hang") => {
            std::thread::sleep(std::time::Duration::from_secs(2));
            std::fs::write(&args[1], "outlived its limit").unwrap();
        }
        _ => std::process::exit(99),
    }
}
"#,
    )
    .unwrap();
    let binary = dir.join(format!("probe-cli{}", std::env::consts::EXE_SUFFIX));
    compile_fixture(&source, &binary);
    binary
}

/// Tests that replace the process environment run in their own exact-test child. The normal
/// parent suite stays parallel; unrelated HTTP, compiler, and ownership tests keep their PATH.
/// Return true in the parent after the child passes, so the caller can return immediately.
pub(crate) fn isolated_process(test: &str) -> bool {
    const MARKER: &str = "OPENBOT_ISOLATED_TEST";
    if std::env::var(MARKER).ok().as_deref() == Some(test) {
        return false;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env(MARKER, test)
        .output()
        .expect("isolated test process should start");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success() && stdout.contains("1 passed; 0 failed"),
        "isolated test {test} failed or did not execute:\n{stdout}\n{stderr}"
    );
    true
}

#[cfg(test)]
mod tests {
    /// A fixture is launched once as it is built, on macOS, and none of it runs then; launched
    /// afterwards it is itself.
    #[test]
    fn a_fixtures_first_launch_runs_none_of_it() {
        let root = super::temp_root("fixture-first-launch");
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("marks.rs");
        std::fs::write(
            &source,
            "fn main() { std::fs::write(std::env::args().nth(1).unwrap(), \"ran\").unwrap(); }\n",
        )
        .unwrap();
        let binary = root.join(format!("marks{}", std::env::consts::EXE_SUFFIX));
        super::compile_fixture(&source, &binary);
        let mark = root.join("mark");
        assert!(!mark.exists(), "the first launch ran the fixture");
        assert!(!root.join("marks.rs.first-launch.rs").exists());
        let ran = std::process::Command::new(&binary)
            .arg(&mark)
            .status()
            .unwrap();
        assert!(ran.success());
        assert_eq!(std::fs::read_to_string(&mark).unwrap(), "ran");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
