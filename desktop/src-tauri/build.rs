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
    tauri_build::build()
}
