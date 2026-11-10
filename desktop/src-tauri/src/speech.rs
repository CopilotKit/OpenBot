/*!
Speech recognition on this computer, for OpenBot's own page in the Desktop window: dictation in the
message box (`app/src/lib/dictation/live.ts`, when OpenBot has no transcription provider) and narration.

The page narrates a recording with the browser's own speech recognition, and only ever on the
device (`app/src/lib/browser/narration.ts`, `shared/on-device-speech.ts`). The window that shows it
here is the system's web view (WKWebView on macOS, WebView2 on Windows), and neither recognises
speech on the device, so the page asks this shell instead (`app/src/lib/desktop/speech.ts`), with
the same promise: the person's voice never leaves the computer, or narration is off.

- macOS: the Speech framework with `requiresOnDeviceRecognition`, the microphone through
  `AVAudioEngine` (`speech/macos.rs`). Apple's own answer for live, on-device dictation that an
  Objective-C caller can reach; the newer `SpeechAnalyzer` is Swift only.
- Windows: the SAPI in-process recognizer with its dictation grammar (`speech/sapi.rs`), the
  recognizer Windows installs with a speech language and runs locally. Not
  `Windows.Media.SpeechRecognition`: its dictation grammar is a Microsoft web service.
- Anywhere else: unsupported, and narration is off.

What the page hears is shaped like the Web Speech API, so its narration runs unchanged: a start, a
result for each phrase (its index, its words so far, and whether they are final), an error named as
the Web Speech API names it, and an end. The audio stays in this process; only words leave it, to
the page that asked.
*/

use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub mod diagnostics;
#[cfg(target_os = "macos")]
mod macos;

use diagnostics::note;
#[cfg(windows)]
mod sapi;

/// Whether a language can be recognised on this computer, in the words `SpeechRecognition.available()`
/// answers with (`shared/on-device-speech.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Availability {
    Available,
    /// The person is still answering the system's question about the microphone or speech
    /// recognition: the page asks again until they have.
    Downloading,
    /// This computer cannot recognise the language on the device.
    Unavailable,
    /// This system has no on-device recognition this shell can use.
    Unsupported,
}

/// Why listening stopped, named as the Web Speech API names it, so the page's narration reads it
/// as it reads the browser's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Problem {
    /// The person, or the system, refused the microphone or speech recognition.
    NotAllowed,
    /// No microphone, or it could not be opened.
    AudioCapture,
    /// No recognizer for the language that runs on this computer.
    LanguageNotSupported,
    /// The recognizer refused to run.
    ServiceNotAllowed,
}

/// A step of opening Windows' SAPI recognizer that can fail (`sapi::listen`), in the order taken.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SapiStep {
    /// Making the in-process recognizer and its context.
    Recognizer,
    /// Finding a microphone: SAPI lists the audio inputs this computer has.
    Microphone,
    /// Choosing the default microphone as the input.
    Input,
    /// Loading the dictation grammar for the language.
    LoadDictation,
    /// Turning dictation on.
    ActivateDictation,
    /// Turning the recognizer on.
    ActivateRecognizer,
}

/// HRESULT `E_ACCESSDENIED`: the microphone is turned off for apps (Settings → Privacy → Microphone).
const E_ACCESSDENIED: i32 = 0x8007_0005_u32 as i32;

/// Why listening could not start, by the SAPI step that failed and the HRESULT it answered.
pub fn sapi_step_problem(step: SapiStep, code: i32) -> Problem {
    match step {
        SapiStep::Recognizer => Problem::ServiceNotAllowed,
        SapiStep::LoadDictation => Problem::LanguageNotSupported,
        // SAPI opens the microphone when a rule goes active, not when the input is chosen, so a
        // computer with none fails here (0x80070490, `ERROR_NOT_FOUND`).
        SapiStep::Microphone
        | SapiStep::Input
        | SapiStep::ActivateDictation
        | SapiStep::ActivateRecognizer => {
            if code == E_ACCESSDENIED {
                Problem::NotAllowed
            } else {
                Problem::AudioCapture
            }
        }
    }
}

/// One thing the page hears from a listening session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Event {
    Start,
    Result {
        index: u32,
        text: String,
        #[serde(rename = "final")]
        is_final: bool,
    },
    Error {
        error: Problem,
    },
    End,
}

/// The longest phrase sent, in characters: the narration route takes no more (`use-narration.ts`).
pub const PHRASE_MAX_CHARS: usize = 4000;
/// And in bytes, so a phrase always fits in one message Tauri evaluates in the page directly. A
/// larger one is fetched through a channel command this page has no permission for.
pub const PHRASE_MAX_BYTES: usize = 6000;

/// `text` cut to what a phrase may be, on a character boundary.
pub fn cap(text: &str) -> String {
    let mut end = 0;
    for (count, (at, character)) in text.char_indices().enumerate() {
        if count == PHRASE_MAX_CHARS || at + character.len_utf8() > PHRASE_MAX_BYTES {
            break;
        }
        end = at + character.len_utf8();
    }
    text[..end].to_owned()
}

/// `language` when it is a plausible BCP 47 tag ("en-US", "pt-BR", "zh-Hant-TW"), so nothing else
/// reaches the system's locale lookup.
pub fn language_tag(language: &str) -> Option<String> {
    let language = language.trim();
    let mut subtags = language.split(['-', '_']);
    let primary = subtags.next()?;
    let primary_ok =
        (2..=3).contains(&primary.len()) && primary.chars().all(|c| c.is_ascii_alphabetic());
    let rest_ok = subtags
        .all(|tag| (1..=8).contains(&tag.len()) && tag.chars().all(|c| c.is_ascii_alphanumeric()));
    (primary_ok && rest_ok && language.len() <= 35).then(|| language.replace('_', "-"))
}

/**
What a session tells the page, kept to the rules the page's narration relies on: each phrase is
final once, words go only to a phrase not yet final, nothing follows the end, and an end always
comes. A phrase a recognizer gave up on (it heard nothing more, or was stopped) is final with the
words it had, so nothing the person said is lost to a recognizer's error.
*/
pub struct Emitter {
    send: Box<dyn Fn(Event) -> bool + Send>,
    words: BTreeMap<u32, String>,
    finished: BTreeSet<u32>,
    started: bool,
    ended: bool,
    /// The page stopped hearing: its channel is gone.
    gone: bool,
}

impl Emitter {
    /// `send` delivers an event and says whether the page took it.
    pub fn new(send: impl Fn(Event) -> bool + Send + 'static) -> Self {
        Emitter {
            send: Box::new(send),
            words: BTreeMap::new(),
            finished: BTreeSet::new(),
            started: false,
            ended: false,
            gone: false,
        }
    }

    /// Sends `event`, and notes `line` in the diagnostics once the page took it.
    fn emit(&mut self, event: Event, line: Option<String>) {
        if self.gone || self.ended {
            return;
        }
        if !(self.send)(event) {
            self.gone = true;
            note("the page stopped hearing: its channel is gone");
        } else if let Some(line) = line {
            note(line);
        }
    }

    /// False once the page can no longer hear: listening should end.
    pub fn listening(&self) -> bool {
        !self.gone && !self.ended
    }

    /// Listening has begun.
    pub fn start(&mut self) {
        if self.started {
            return;
        }
        self.started = true;
        self.emit(Event::Start, Some("listening".into()));
    }

    /// The words of phrase `index` so far. Repeats and words for a finished phrase are dropped.
    pub fn words(&mut self, index: u32, text: &str) {
        if self.finished.contains(&index) {
            return;
        }
        let text = cap(text.trim());
        if self.words.get(&index) == Some(&text) {
            return;
        }
        let first = self.words.get(&index).is_none_or(String::is_empty) && !text.is_empty();
        self.words.insert(index, text.clone());
        self.emit(
            Event::Result {
                index,
                text,
                is_final: false,
            },
            first.then(|| format!("phrase {index}: first words")),
        );
    }

    /// The words phrase `index` had so far, or nothing.
    pub fn heard(&self, index: u32) -> &str {
        self.words.get(&index).map(String::as_str).unwrap_or("")
    }

    /// Phrase `index` is final: with `text`, or with the words it had when `None`. Once per phrase.
    pub fn finish(&mut self, index: u32, text: Option<&str>) {
        if !self.finished.insert(index) {
            return;
        }
        let text = match text {
            Some(text) => cap(text.trim()),
            None => self.words.get(&index).cloned().unwrap_or_default(),
        };
        self.words.remove(&index);
        let line = format!("phrase {index}: final, {} characters", text.chars().count());
        self.emit(
            Event::Result {
                index,
                text,
                is_final: true,
            },
            Some(line),
        );
    }

    /// Every phrase still open is final with the words it had.
    pub fn finish_all(&mut self) {
        let open: Vec<u32> = self.words.keys().copied().collect();
        for index in open {
            self.finish(index, None);
        }
    }

    /// Listening failed for `problem`. The end follows.
    pub fn fail(&mut self, problem: Problem) {
        self.emit(
            Event::Error { error: problem },
            Some(format!("failed: {problem:?}")),
        );
    }

    /// Listening is over. Said once; nothing after it.
    pub fn end(&mut self) {
        if self.ended {
            return;
        }
        self.emit(Event::End, Some("end".into()));
        self.ended = true;
    }
}

impl Drop for Emitter {
    /// A session that ends any way at all still tells the page so, or its Stop would wait out its
    /// whole flush time for nothing.
    fn drop(&mut self) {
        self.end();
    }
}

/// How long a phrase's words may stand still before it is taken as said and the next one begins.
/// Chrome's own recognition ends a phrase on about the same pause.
pub const PAUSE: Duration = Duration::from_millis(1_200);

/**
When the phrase being said is over, for a recognizer that does not split phrases itself (macOS's
runs one long transcription): its words have stood still for `PAUSE`.
*/
#[derive(Default)]
pub struct Pause {
    words: String,
    since: Option<Instant>,
}

impl Pause {
    /// The phrase's words, as of `now`.
    pub fn heard(&mut self, words: &str, now: Instant) {
        if words != self.words {
            self.words = words.to_owned();
            self.since = Some(now);
        }
    }

    /// Whether the phrase has words that have not changed for `PAUSE`.
    pub fn over(&self, now: Instant) -> bool {
        !self.words.trim().is_empty()
            && self
                .since
                .is_some_and(|since| now.duration_since(since) >= PAUSE)
    }

    /// A new phrase begins.
    pub fn reset(&mut self) {
        self.words.clear();
        self.since = None;
    }
}

/// What the page asks of a session after it starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Control {
    /// Hand over the phrase in progress, then end.
    Stop,
    /// End now.
    Abort,
}

/// How long a stop waits for the recognizer's last words. The page waits 1.5 s for the end.
pub const FLUSH: Duration = Duration::from_millis(1_000);

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
/// The one session listening, and how to reach it. A new one ends the one before.
static CURRENT: Mutex<Option<(u64, mpsc::Sender<Control>)>> = Mutex::new(None);

/// Whether `language` can be recognised here. May ask the person for the microphone and speech
/// recognition, which the page waits out ("downloading").
pub fn available(language: &str) -> Availability {
    let answer = availability(language);
    // Asked every few seconds while the person answers the system: noted when the answer changes.
    static LAST: Mutex<Option<(String, Availability)>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap();
    let now = (language.to_owned(), answer);
    if last.as_ref() != Some(&now) {
        diagnostics::for_session(0);
        let tag = language_tag(language).unwrap_or_else(|| "(not a language tag)".into());
        note(format_args!("available({tag}) = {answer:?}"));
        *last = Some(now);
    }
    answer
}

fn availability(language: &str) -> Availability {
    let Some(language) = language_tag(language) else {
        return Availability::Unavailable;
    };
    #[cfg(target_os = "macos")]
    return macos::available(&language);
    #[cfg(windows)]
    return sapi::available(&language);
    #[allow(unreachable_code)]
    {
        let _ = language;
        Availability::Unsupported
    }
}

/// Start listening in `language`, telling `send` what is heard. Ends any session listening now.
/// Returns the session's number, which `control` takes.
pub fn start(language: &str, send: impl Fn(Event) -> bool + Send + 'static) -> u64 {
    let id = NEXT_SESSION.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    if let Some((_, before)) = CURRENT.lock().unwrap().replace((id, tx)) {
        let _ = before.send(Control::Abort);
    }
    let mut emitter = Emitter::new(send);
    let language = language_tag(language);
    let spawned = std::thread::Builder::new()
        .name("openbot-speech".into())
        .spawn(move || {
            diagnostics::for_session(id);
            note(format_args!(
                "start, language {}",
                language.as_deref().unwrap_or("(not a language tag)")
            ));
            match language {
                Some(language) => listen(&language, &mut emitter, &rx),
                None => emitter.fail(Problem::LanguageNotSupported),
            }
            emitter.end();
            let mut current = CURRENT.lock().unwrap();
            if current.as_ref().is_some_and(|(session, _)| *session == id) {
                *current = None;
            }
        });
    if spawned.is_err() {
        CURRENT.lock().unwrap().take();
    }
    id
}

/// Ask session `id` to stop or abort. A session that already ended, or was replaced, is left be.
pub fn control(id: u64, what: Control) {
    let current = CURRENT.lock().unwrap();
    if let Some((session, tx)) = current.as_ref() {
        if *session == id {
            diagnostics::for_session(id);
            note(format_args!("the page asked to {what:?}"));
            let _ = tx.send(what);
        }
    }
}

#[allow(unused_variables)]
fn listen(language: &str, out: &mut Emitter, control: &mpsc::Receiver<Control>) {
    #[cfg(target_os = "macos")]
    return macos::listen(language, out, control);
    #[cfg(windows)]
    return sapi::listen(language, out, control);
    #[allow(unreachable_code)]
    out.fail(Problem::LanguageNotSupported);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn recorder() -> (Emitter, Arc<Mutex<Vec<Event>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let emitter = Emitter::new(move |event| {
            sink.lock().unwrap().push(event);
            true
        });
        (emitter, events)
    }

    fn result(index: u32, text: &str, is_final: bool) -> Event {
        Event::Result {
            index,
            text: text.into(),
            is_final,
        }
    }

    /// The page's narration parses these exact shapes (`app/src/lib/desktop/speech.ts`).
    #[test]
    fn events_are_shaped_as_the_page_reads_them() {
        let json = |event: Event| serde_json::to_value(event).unwrap();
        assert_eq!(json(Event::Start), serde_json::json!({ "type": "start" }));
        assert_eq!(
            json(result(2, "open the settings", true)),
            serde_json::json!({ "type": "result", "index": 2, "text": "open the settings", "final": true })
        );
        assert_eq!(
            json(Event::Error {
                error: Problem::NotAllowed
            }),
            serde_json::json!({ "type": "error", "error": "not-allowed" })
        );
        assert_eq!(
            json(Event::Error {
                error: Problem::LanguageNotSupported
            }),
            serde_json::json!({ "type": "error", "error": "language-not-supported" })
        );
        assert_eq!(json(Event::End), serde_json::json!({ "type": "end" }));
        assert_eq!(
            serde_json::to_value(Availability::Downloading).unwrap(),
            serde_json::json!("downloading")
        );
    }

    #[test]
    fn a_phrase_is_final_once_and_takes_no_words_after() {
        let (mut out, events) = recorder();
        out.start();
        out.words(0, "click");
        out.words(0, "click");
        out.words(0, "click the button");
        out.finish(0, Some("Click the button."));
        out.words(0, "late words");
        out.finish(0, Some("again"));
        out.end();
        out.words(1, "after the end");
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                Event::Start,
                result(0, "click", false),
                result(0, "click the button", false),
                result(0, "Click the button.", true),
                Event::End,
            ]
        );
    }

    /// A recognizer that errors, or is cut off at Stop, still hands over what it had heard.
    #[test]
    fn a_phrase_cut_short_is_final_with_the_words_it_had() {
        let (mut out, events) = recorder();
        out.words(0, "type the address");
        out.finish(0, None);
        out.finish(1, None);
        out.words(2, "then press");
        out.words(3, "enter");
        out.finish_all();
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                result(0, "type the address", false),
                result(0, "type the address", true),
                result(1, "", true),
                result(2, "then press", false),
                result(3, "enter", false),
                result(2, "then press", true),
                result(3, "enter", true),
            ]
        );
    }

    #[test]
    fn an_end_always_comes_and_only_once() {
        let (out, events) = recorder();
        drop(out);
        assert_eq!(*events.lock().unwrap(), vec![Event::End]);

        let (mut out, events) = recorder();
        out.fail(Problem::AudioCapture);
        out.end();
        drop(out);
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                Event::Error {
                    error: Problem::AudioCapture
                },
                Event::End
            ]
        );
    }

    #[test]
    fn a_page_that_stopped_hearing_ends_listening() {
        let mut out = Emitter::new(|_| false);
        assert!(out.listening());
        out.start();
        assert!(!out.listening());
    }

    #[test]
    fn a_phrase_fits_the_route_and_one_message() {
        assert_eq!(cap("short"), "short");
        let long = "a".repeat(5000);
        assert_eq!(cap(&long).chars().count(), PHRASE_MAX_CHARS);
        // Four bytes a character: the byte limit cuts first, on a character boundary.
        let wide = "😀".repeat(3000);
        let capped = cap(&wide);
        assert!(capped.len() <= PHRASE_MAX_BYTES);
        assert_eq!(capped.len() % 4, 0);
        assert_eq!(capped.chars().count(), PHRASE_MAX_BYTES / 4);
    }

    #[test]
    fn only_a_language_tag_reaches_the_system() {
        for (given, tag) in [
            ("en-US", "en-US"),
            ("en_GB", "en-GB"),
            ("zh-Hant-TW", "zh-Hant-TW"),
            ("de", "de"),
            (" fr-FR ", "fr-FR"),
        ] {
            assert_eq!(language_tag(given).as_deref(), Some(tag), "{given}");
        }
        for refused in [
            "",
            "e",
            "english",
            "en-US;rm -rf",
            "en--US",
            "../en",
            "en-US-toolongsubtag",
        ] {
            assert_eq!(language_tag(refused), None, "{refused}");
        }
    }

    #[test]
    fn a_phrase_is_over_when_its_words_stand_still() {
        let at = Instant::now();
        let mut pause = Pause::default();
        assert!(!pause.over(at + PAUSE * 3), "no words, no phrase");
        pause.heard("open", at);
        assert!(!pause.over(at + PAUSE / 2));
        pause.heard("open the menu", at + PAUSE / 2);
        assert!(!pause.over(at + PAUSE), "new words keep it open");
        assert!(pause.over(at + PAUSE / 2 + PAUSE));
        pause.reset();
        assert!(!pause.over(at + PAUSE * 10));
        pause.heard("   ", at);
        assert!(!pause.over(at + PAUSE * 10), "silence is not a phrase");
    }

    /// The first live test on a packaged Mac could not be read: its stderr goes nowhere, so whether
    /// the microphone heard anything, the recognizer answered or the page took the phrases was a
    /// guess. Each session now leaves lines in a file, and never a word of what was said.
    #[test]
    fn a_session_leaves_diagnostics_and_never_the_words() {
        let path = diagnostics::path().unwrap();
        let (mut out, _) = recorder();
        diagnostics::for_session(4242);
        out.start();
        out.words(0, "my secret passphrase");
        out.words(0, "my secret passphrase is");
        out.finish(0, Some("my secret passphrase is swordfish"));
        out.fail(Problem::AudioCapture);
        out.end();
        let log = std::fs::read_to_string(&path).unwrap();
        let mine: Vec<&str> = log
            .lines()
            .filter(|line| line.contains(" session=4242 "))
            .map(|line| line.split(" session=4242 ").nth(1).unwrap_or_default())
            .collect();
        assert_eq!(
            mine,
            [
                "listening",
                "phrase 0: first words",
                "phrase 0: final, 33 characters",
                "failed: AudioCapture",
                "end"
            ]
        );
        assert!(!log.contains("secret") && !log.contains("swordfish"));

        // A page that stopped hearing says so, once.
        let mut gone = Emitter::new(|_| false);
        diagnostics::for_session(4343);
        gone.start();
        gone.words(0, "anything");
        let log = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            log.lines()
                .filter(|line| line.contains(" session=4343 "))
                .count(),
            1
        );
        assert!(log.contains("session=4343 the page stopped hearing"));
    }

    #[test]
    fn loudness_reads_in_dbfs() {
        assert_eq!(diagnostics::dbfs(1.0), 0);
        assert_eq!(diagnostics::dbfs(0.1), -20);
        assert_eq!(diagnostics::dbfs(0.001), -60);
        assert_eq!(diagnostics::dbfs(0.0), -120);
        assert_eq!(diagnostics::dbfs(f32::NAN), -120);
    }

    /// A language the system is never asked about ends at once, as the page expects: an error,
    /// then the end.
    /// A computer with no microphone (an EC2 Windows box: SAPI lists no audio input) has the
    /// recognizer for its language, so `available` answers yes. Starting failed when dictation went
    /// active, which is when SAPI opens the microphone, with 0x80070490 (`ERROR_NOT_FOUND`), and was
    /// reported as "language-not-supported": a language the same computer had just said it had.
    #[test]
    fn a_missing_microphone_is_an_audio_problem_and_never_the_language() {
        const ERROR_NOT_FOUND: i32 = 0x8007_0490_u32 as i32;
        const SPERR_NOT_FOUND: i32 = 0x8004_503A_u32 as i32;
        for code in [ERROR_NOT_FOUND, SPERR_NOT_FOUND] {
            for step in [
                SapiStep::Microphone,
                SapiStep::Input,
                SapiStep::ActivateDictation,
                SapiStep::ActivateRecognizer,
            ] {
                assert_eq!(
                    sapi_step_problem(step, code),
                    Problem::AudioCapture,
                    "{step:?} {code:#x}"
                );
            }
        }
        // A microphone the person turned off for apps is theirs to turn on.
        assert_eq!(
            sapi_step_problem(SapiStep::ActivateDictation, E_ACCESSDENIED),
            Problem::NotAllowed
        );
        // Only a dictation grammar that will not load says the language is missing.
        assert_eq!(
            sapi_step_problem(SapiStep::LoadDictation, ERROR_NOT_FOUND),
            Problem::LanguageNotSupported
        );
        assert_eq!(
            sapi_step_problem(SapiStep::Recognizer, ERROR_NOT_FOUND),
            Problem::ServiceNotAllowed
        );
    }

    #[test]
    fn a_session_in_no_language_fails_and_ends() {
        let (tx, rx) = mpsc::channel();
        let id = start("not a language", move |event| tx.send(event).is_ok());
        assert!(id > 0);
        let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let second = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            first,
            Event::Error {
                error: Problem::LanguageNotSupported
            }
        );
        assert_eq!(second, Event::End);
        assert_eq!(available("not a language"), Availability::Unavailable);
    }
}
