// Shared with `build.rs` (`include!`), which reads the bundled CLI with it when the app is built.

/// The Intelligence release a CopilotKit CLI build installs, read out of the CLI itself.
///
/// A CLI built for a release candidate is pinned to it: its `local setup` and `local update` take
/// that release, written into the bundle as `const pinnedVersion = false ? "" : "<release>"`
/// (Intelligence `apps/cli`, `resolveDefaultLocalRelease`). A CLI built without a pin takes the
/// newest stable release from Helm instead, and says no version here: `None`, and nothing is
/// compared against it. Read from the very bytes the app runs, so it cannot drift from them.
pub fn pinned_release_in(cli: &str) -> Option<String> {
    const MARK: &str = "const pinnedVersion = false ? \"\" : \"";
    let start = cli.find(MARK)? + MARK.len();
    let rest = &cli[start..];
    let version = &rest[..rest.find('"')?];
    let plain = !version.is_empty()
        && version.len() <= 64
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte));
    plain.then(|| version.to_owned())
}
