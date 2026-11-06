/*!
On-device dictation on macOS: the Speech framework, with every request set to
`requiresOnDeviceRecognition`, fed from the microphone through `AVAudioEngine`. That is Apple's
documented way to transcribe live audio ("Recognizing speech in live audio"), and the flag is what
keeps it on the Mac: "If true, the system doesn't send the audio over the network"
(https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/requiresondevicerecognition).
A recognizer whose `supportsOnDeviceRecognition` is false for the language is never used.

Two permissions, each the system's own question: speech recognition (`NSSpeechRecognitionUsageDescription`)
and the microphone (`NSMicrophoneUsageDescription`). Asked once, when narration first wants to
listen; the page waits for the answers.

The framework runs one transcription for as long as audio comes, so phrases are cut here: when a
phrase's words have stood still for `PAUSE`, its audio ends (the recognizer finishes it) and the
next phrase's request takes the microphone from then on. Each request is one phrase, numbered as
the Web Speech API numbers its results.
*/

use super::diagnostics::{dbfs, note};
use super::{Availability, Control, Emitter, Pause, Problem, FLUSH};
use block2::RcBlock;
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::Bool;
use objc2::AnyThread;
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
use objc2_avf_audio::{AVAudioEngine, AVAudioPCMBuffer, AVAudioTime};
use objc2_foundation::{NSError, NSLocale, NSOperationQueue, NSString};
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask,
    SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
};
use std::collections::BTreeMap;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Permission {
    Granted,
    Unasked,
    Refused,
}

fn speech_permission() -> Permission {
    match unsafe { SFSpeechRecognizer::authorizationStatus() } {
        SFSpeechRecognizerAuthorizationStatus::Authorized => Permission::Granted,
        SFSpeechRecognizerAuthorizationStatus::NotDetermined => Permission::Unasked,
        _ => Permission::Refused,
    }
}

fn microphone_permission() -> Permission {
    let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
        return Permission::Refused;
    };
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) } {
        AVAuthorizationStatus::Authorized => Permission::Granted,
        AVAuthorizationStatus::NotDetermined => Permission::Unasked,
        _ => Permission::Refused,
    }
}

/// Both permissions together: refused if either is, unasked if either still is.
fn permission() -> Permission {
    match (speech_permission(), microphone_permission()) {
        (Permission::Granted, Permission::Granted) => Permission::Granted,
        (Permission::Refused, _) | (_, Permission::Refused) => Permission::Refused,
        _ => Permission::Unasked,
    }
}

/// The system's questions are being asked now.
static ASKING: AtomicBool = AtomicBool::new(false);

/// Ask whichever of the two is unanswered, one after the other so the two dialogs never overlap.
fn ask() {
    if ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    fn ask_microphone() {
        let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
            ASKING.store(false, Ordering::SeqCst);
            return;
        };
        if microphone_permission() != Permission::Unasked {
            ASKING.store(false, Ordering::SeqCst);
            return;
        }
        let answered = RcBlock::new(|_granted: Bool| ASKING.store(false, Ordering::SeqCst));
        unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &answered) };
    }
    if speech_permission() == Permission::Unasked {
        let answered =
            RcBlock::new(|_status: SFSpeechRecognizerAuthorizationStatus| ask_microphone());
        unsafe { SFSpeechRecognizer::requestAuthorization(&answered) };
    } else {
        ask_microphone();
    }
}

/// A recognizer for `language` that runs on this Mac, or None.
fn on_device_recognizer(language: &str) -> Option<Retained<SFSpeechRecognizer>> {
    let locale = NSLocale::localeWithLocaleIdentifier(&NSString::from_str(language));
    let recognizer =
        unsafe { SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale) }?;
    unsafe { recognizer.supportsOnDeviceRecognition() }.then_some(recognizer)
}

pub fn available(language: &str) -> Availability {
    autoreleasepool(|_| {
        if on_device_recognizer(language).is_none() {
            return Availability::Unavailable;
        }
        match permission() {
            Permission::Granted => Availability::Available,
            // Listening says so, as the browser's recognition says `not-allowed`.
            Permission::Refused => Availability::Available,
            Permission::Unasked => {
                ask();
                Availability::Downloading
            }
        }
    })
}

/// What a request's result handler hands back to the session, from the recognizer's queue.
struct Heard {
    index: u32,
    words: Option<String>,
    is_final: bool,
    /// The recognizer's error, as its domain and code, when the phrase ended in one.
    failed: Option<(String, isize)>,
}

/// The request the microphone feeds now, shared with the tap on the audio thread. The framework
/// documents appending from the tap block, which is another thread, as its own sample does.
struct Feed(Option<Retained<SFSpeechAudioBufferRecognitionRequest>>);
unsafe impl Send for Feed {}

/// One phrase: its request, its task, and when it was asked to finish.
struct Phrase {
    request: Retained<SFSpeechAudioBufferRecognitionRequest>,
    task: Retained<SFSpeechRecognitionTask>,
    began: Instant,
    ending: Option<Instant>,
}

/// How long a phrase asked to finish may take before its words so far are final anyway.
const FINISH_WAIT: Duration = Duration::from_secs(3);
/// Phrases that end in an error with nothing heard, in a row, before listening gives up.
const FAILURES_MAX: u32 = 5;
const TICK: Duration = Duration::from_millis(100);
/// A phrase that fails sooner than this, with nothing heard, counts towards `FAILURES_MAX`.
const QUICK_FAILURE: Duration = Duration::from_secs(2);

/// How often the diagnostics say how loud the microphone was.
const LEVEL_EVERY: Duration = Duration::from_secs(5);

pub fn listen(language: &str, out: &mut Emitter, control: &mpsc::Receiver<Control>) {
    note(format_args!(
        "permissions: speech recognition {:?}, microphone {:?}",
        speech_permission(),
        microphone_permission()
    ));
    // Narration only listens after asking `available`, but the answers may still be coming.
    if permission() == Permission::Unasked {
        ask();
        let asked = Instant::now();
        while permission() == Permission::Unasked && asked.elapsed() < Duration::from_secs(120) {
            if control.recv_timeout(Duration::from_millis(250)).is_ok() {
                return;
            }
        }
    }
    if permission() != Permission::Granted {
        note(format_args!(
            "not allowed: speech recognition {:?}, microphone {:?}",
            speech_permission(),
            microphone_permission()
        ));
        out.fail(Problem::NotAllowed);
        return;
    }
    autoreleasepool(|_| run(language, out, control));
}

fn run(language: &str, out: &mut Emitter, control: &mpsc::Receiver<Control>) {
    let Some(recognizer) = on_device_recognizer(language) else {
        note(format_args!("no on-device recognizer for {language}"));
        out.fail(Problem::LanguageNotSupported);
        return;
    };
    // Results on a queue of their own: the main thread is the window's.
    let queue = NSOperationQueue::new();
    queue.setMaxConcurrentOperationCount(1);
    unsafe { recognizer.setQueue(&queue) };

    let feed = Arc::new(Mutex::new(Feed(None)));
    let engine = unsafe { AVAudioEngine::new() };
    let input = unsafe { engine.inputNode() };
    let format = unsafe { input.outputFormatForBus(0) };
    note(format_args!(
        "microphone: {} Hz, {} channels",
        unsafe { format.sampleRate() },
        unsafe { format.channelCount() }
    ));
    if unsafe { format.sampleRate() } <= 0.0 || unsafe { format.channelCount() } == 0 {
        out.fail(Problem::AudioCapture);
        return;
    }
    // How loud the microphone was, and how much of it came, for the diagnostics: never the audio.
    let level = Arc::new((AtomicU32::new(0), AtomicU64::new(0)));
    let tap_level = level.clone();
    let tap_feed = feed.clone();
    let tap = RcBlock::new(
        move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
            let pcm = unsafe { buffer.as_ref() };
            let samples = unsafe { pcm.floatChannelData() };
            if !samples.is_null() {
                let first = unsafe { (*samples).as_ptr() };
                let frames = unsafe { pcm.frameLength() } as usize;
                let stride = unsafe { pcm.stride() }.max(1);
                let mut peak = 0f32;
                for frame in 0..frames {
                    peak = peak.max(unsafe { *first.add(frame * stride) }.abs());
                }
                let (loudest, buffers) = &*tap_level;
                loudest.fetch_max(peak.to_bits(), Ordering::Relaxed);
                buffers.fetch_add(1, Ordering::Relaxed);
            }
            if let Ok(feed) = tap_feed.lock() {
                if let Some(request) = feed.0.as_ref() {
                    unsafe { request.appendAudioPCMBuffer(buffer.as_ref()) };
                }
            }
        },
    );
    unsafe {
        input.installTapOnBus_bufferSize_format_block(0, 1024, Some(&format), RcBlock::as_ptr(&tap))
    };
    let torn = std::cell::Cell::new(false);
    let teardown = || {
        if !torn.replace(true) {
            unsafe {
                input.removeTapOnBus(0);
                engine.stop();
            }
        }
    };
    unsafe { engine.prepare() };
    if let Err(error) = unsafe { engine.startAndReturnError() } {
        note(format_args!(
            "the microphone would not start: {} {}",
            error.domain(),
            error.code()
        ));
        teardown();
        out.fail(Problem::AudioCapture);
        return;
    }

    let (heard_tx, heard) = mpsc::channel::<Heard>();
    let begin = |index: u32| -> Phrase {
        let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
        unsafe {
            request.setShouldReportPartialResults(true);
            // The promise: on this Mac, or not at all.
            request.setRequiresOnDeviceRecognition(true);
        }
        let tx = heard_tx.clone();
        let handler = RcBlock::new(
            move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
                let (words, is_final) = match unsafe { result.as_ref() } {
                    Some(result) => unsafe {
                        (
                            Some(result.bestTranscription().formattedString().to_string()),
                            result.isFinal(),
                        )
                    },
                    None => (None, false),
                };
                let failed = unsafe { error.as_ref() }
                    .map(|error| (error.domain().to_string(), error.code()));
                let _ = tx.send(Heard {
                    index,
                    words,
                    is_final,
                    failed,
                });
            },
        );
        let task =
            unsafe { recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler) };
        note(format_args!("phrase {index}: listening"));
        feed.lock().unwrap().0 = Some(request.clone());
        Phrase {
            request,
            task,
            began: Instant::now(),
            ending: None,
        }
    };

    out.start();
    let mut phrases: BTreeMap<u32, Phrase> = BTreeMap::new();
    let mut current = 0u32;
    phrases.insert(current, begin(current));
    let mut pause = Pause::default();
    let mut failures = 0u32;
    let mut stopping: Option<Instant> = None;
    let mut resume_at: Option<Instant> = None;
    let mut level_at = Instant::now();

    loop {
        autoreleasepool(|_| {
            let now = Instant::now();
            match control.try_recv() {
                Ok(Control::Abort) | Err(mpsc::TryRecvError::Disconnected) => {
                    stopping = Some(now - FLUSH);
                }
                Ok(Control::Stop) if stopping.is_none() => {
                    // The phrase in progress is handed over: its audio ends, and the recognizer finishes it.
                    stopping = Some(now);
                    note(format_args!("stop: handing over phrase {current}"));
                    feed.lock().unwrap().0 = None;
                    teardown();
                    if let Some(phrase) = phrases.get_mut(&current) {
                        unsafe { phrase.request.endAudio() };
                        phrase.ending.get_or_insert(now);
                    }
                }
                _ => {}
            }

            if let Ok(message) = heard.recv_timeout(TICK) {
                let index = message.index;
                if let Some(words) = message.words.as_deref() {
                    if message.is_final {
                        out.finish(index, Some(words));
                    } else {
                        out.words(index, words);
                    }
                    if !words.trim().is_empty() {
                        failures = 0;
                    }
                    if index == current {
                        pause.heard(words, now);
                    }
                }
                if let Some((domain, code)) = message.failed.as_ref() {
                    // Silence ends a phrase in an error too ("no speech detected"), seconds in. One
                    // that fails at once, with nothing heard, is the recognizer refusing.
                    let lasted = phrases.get(&index).map(|phrase| now - phrase.began);
                    let quick = lasted.is_some_and(|lasted| lasted < QUICK_FAILURE);
                    note(format_args!(
                        "phrase {index}: recognizer error {domain} {code} after {} ms",
                        lasted.unwrap_or_default().as_millis()
                    ));
                    if index == current {
                        if quick && out.heard(index).trim().is_empty() {
                            failures += 1;
                        } else {
                            failures = 0;
                        }
                    }
                    out.finish(index, None);
                }
                if message.is_final || message.failed.is_some() {
                    phrases.remove(&index);
                    // The recognizer ended the phrase being said by itself: the next one listens.
                    if index == current && stopping.is_none() {
                        current += 1;
                        pause.reset();
                        note(format_args!(
                            "phrase {index}: the recognizer ended it by itself"
                        ));
                        if failures >= FAILURES_MAX {
                            note("the recognizer refused every phrase: listening ends");
                            out.fail(Problem::ServiceNotAllowed);
                            stopping = Some(now - FLUSH);
                        } else if failures > 0 {
                            // Never a tight loop of requests the recognizer refuses.
                            feed.lock().unwrap().0 = None;
                            resume_at =
                                Some(now + Duration::from_millis(250 * u64::from(failures)));
                        } else {
                            phrases.insert(current, begin(current));
                        }
                    }
                }
            }

            let now = Instant::now();
            if stopping.is_none() {
                if resume_at.is_some_and(|at| now >= at) {
                    resume_at = None;
                    phrases.insert(current, begin(current));
                }
                // The person paused: this phrase is said, and the next one has the microphone.
                if pause.over(now) && phrases.contains_key(&current) {
                    note(format_args!("phrase {current}: a pause ends it"));
                    if let Some(phrase) = phrases.get_mut(&current) {
                        unsafe { phrase.request.endAudio() };
                        phrase.ending = Some(now);
                    }
                    current += 1;
                    pause.reset();
                    phrases.insert(current, begin(current));
                }
                // A phrase whose recognizer never finished it is final with what it had.
                let late: Vec<u32> = phrases
                    .iter()
                    .filter(|(_, phrase)| phrase.ending.is_some_and(|at| now - at > FINISH_WAIT))
                    .map(|(index, _)| *index)
                    .collect();
                for index in late {
                    note(format_args!(
                        "phrase {index}: the recognizer never finished it, final with its words"
                    ));
                    if let Some(phrase) = phrases.remove(&index) {
                        unsafe { phrase.task.cancel() };
                    }
                    out.finish(index, None);
                }
                if level_at.elapsed() >= LEVEL_EVERY {
                    level_at = Instant::now();
                    let (loudest, buffers) = &*level;
                    let peak = f32::from_bits(loudest.swap(0, Ordering::Relaxed));
                    note(format_args!(
                        "microphone: {} buffers, loudest {} dBFS",
                        buffers.swap(0, Ordering::Relaxed),
                        dbfs(peak)
                    ));
                }
            }
        });

        let flushed = stopping.is_some_and(|at| phrases.is_empty() || at.elapsed() >= FLUSH);
        if flushed || !out.listening() {
            break;
        }
    }

    feed.lock().unwrap().0 = None;
    teardown();
    if !phrases.is_empty() {
        note(format_args!(
            "{} phrases unfinished at the end, final with their words",
            phrases.len()
        ));
    }
    for (index, phrase) in std::mem::take(&mut phrases) {
        unsafe { phrase.task.cancel() };
        out.finish(index, None);
    }
    drop(tap);
}
