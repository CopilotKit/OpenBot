use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_ROOT: AtomicU64 = AtomicU64::new(0);

pub(crate) fn temp_root(label: &str) -> PathBuf {
    let next = NEXT_TEMP_ROOT.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("openbot-{label}-{}-{next}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    path
}

#[test]
fn temp_roots_with_the_same_label_do_not_collide() {
    assert_ne!(temp_root("same-label"), temp_root("same-label"));
}

/// Runtime PATH belongs to the scenario under test; the compiler and linker tools belong to
/// Cargo's build environment. Neither an inherited runtime RUSTC nor another test can replace it.
pub(crate) fn compile_fixture(source: &std::path::Path, binary: &std::path::Path) {
    let output = std::process::Command::new(env!("OPENBOT_TEST_RUSTC"))
        .env("PATH", env!("OPENBOT_TEST_TOOL_PATH"))
        .arg(source)
        .arg("-o")
        .arg(binary)
        .output()
        .expect("Cargo's Rust compiler should run for the native fixture");
    assert!(
        output.status.success(),
        "fixture did not compile: {}",
        String::from_utf8_lossy(&output.stderr)
    );
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
