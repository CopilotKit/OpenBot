//! Settings' Share usage data switch, kept for the next launch in the app's configuration folder.
//!
//! Off is the same opt-out as launching with `COPILOTKIT_TELEMETRY_DISABLED=1`: the desktop's own
//! emitter forgets its identity and queue (`telemetry::Telemetry::stop_sharing`), the bundled CLI
//! is given the variable on every call (`local_eval::cli_environment`), the server is started with
//! it (`stack.rs`'s suppression override), and `telemetry link` is never asked for. The variable in
//! the app's own environment still wins: Settings cannot turn sharing on over it.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// Where the choice is kept, beside `zoom.json`.
pub const FILE: &str = "usage-data.json";

/// Turned off in Settings, for this launch. Read by every CLI call.
static OFF: AtomicBool = AtomicBool::new(false);

/// Whether this installation shares usage data, as Settings last saved it. Sharing is the default,
/// and a record that cannot be read leaves it as it was saved last: on.
pub fn saved(directory: &Path) -> bool {
    std::fs::read_to_string(directory.join(FILE))
        .ok()
        .and_then(|record| serde_json::from_str::<serde_json::Value>(&record).ok())
        .and_then(|record| record.get("share")?.as_bool())
        .unwrap_or(true)
}

/// Keep the choice for the next launch. `set_off` applies it to this one.
pub fn save(directory: &Path, share: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)?;
    std::fs::write(
        directory.join(FILE),
        serde_json::json!({ "share": share }).to_string(),
    )
}

/// What this launch does, read once from the saved choice at startup and again on each change.
pub fn set_off(off: bool) {
    OFF.store(off, Ordering::SeqCst);
}

/// Turned off in Settings. The environment opt-outs are read separately, where they are inherited.
pub fn off() -> bool {
    OFF.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_choice_is_kept_for_the_next_launch_and_sharing_is_the_default() {
        let directory = crate::test_support::temp_root("usage-data-choice");
        assert!(saved(&directory), "nothing saved yet shares, as before");
        save(&directory, false).unwrap();
        assert!(!saved(&directory));
        save(&directory, true).unwrap();
        assert!(saved(&directory));
        std::fs::write(directory.join(FILE), "not json").unwrap();
        assert!(saved(&directory));
        let _ = std::fs::remove_dir_all(directory);
    }
}
