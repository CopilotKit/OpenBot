/*!
What listening did, one line each, in a file a person can send: on macOS
`~/Library/Logs/OpenBot/speech.log`, on Windows `%LOCALAPPDATA%\OpenBot\Logs\speech.log`.

A packaged app's stderr goes nowhere, and without this a narration that reached nobody could not be
told from a microphone that heard nothing, a recognizer that refused, or a page that stopped
listening. Never a word of what was said: phrase numbers, how many characters a phrase had,
permission states, the microphone's format and loudness, and the recognizer's error codes.
*/

use std::path::PathBuf;
use std::sync::Mutex;

/// The log grows to this, then starts again with the previous one kept beside it (`speech.log.1`).
pub const MAX_BYTES: u64 = 512 * 1024;

/// Where the diagnostics go, or None where there is no home to put them in. Tests write to a file
/// of their own, never the person's.
pub fn path() -> Option<PathBuf> {
    if cfg!(test) {
        return Some(
            std::env::temp_dir().join(format!("openbot-speech-test-{}.log", std::process::id())),
        );
    }
    let directory = if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Logs/OpenBot"))
    } else if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(|local| PathBuf::from(local).join("OpenBot").join("Logs"))
    } else {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state/openbot"))
    };
    directory.map(|directory| directory.join("speech.log"))
}

thread_local! {
    /// The session this thread listens for, so each line says which.
    static SESSION: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Lines from this thread belong to session `id` from now on.
pub fn for_session(id: u64) {
    SESSION.with(|session| session.set(id));
}

static WRITING: Mutex<()> = Mutex::new(());

/// One line: milliseconds since the epoch, the session, and `line`. Never pass anything said.
pub fn note(line: impl std::fmt::Display) {
    let Some(path) = path() else { return };
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or_default();
    let session = SESSION.with(|session| session.get());
    let _writing = WRITING.lock();
    if let Some(directory) = path.parent() {
        let _ = std::fs::create_dir_all(directory);
    }
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > MAX_BYTES) {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let _ = writeln!(file, "{at} session={session} {line}");
    }
}

/// The loudest sample in a stretch of the microphone, in dBFS, as a log line shows it: -60 or
/// quieter reads as silence, speech near the microphone is usually louder than -35.
pub fn dbfs(peak: f32) -> i32 {
    if peak <= 0.0 || !peak.is_finite() {
        return -120;
    }
    (20.0 * peak.min(1.0).log10()).round().max(-120.0) as i32
}
