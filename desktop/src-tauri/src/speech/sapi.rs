/*!
On-device dictation on Windows: the SAPI in-process recognizer with its dictation grammar, reading
the default microphone.

Windows has two recognizers an app can call. `Windows.Media.SpeechRecognition` is the newer, but
its dictation grammar is not on the computer: "speech recognition is performed by a remote web
service and the results are returned to the device"
(https://learn.microsoft.com/windows/apps/design/input/speech-recognition), so it is never used
here. The SAPI recognizer runs in this process, with the recognizer Windows installs for a speech
language (Settings → Time & language → Speech); without one for the person's language, narration is
off. Microsoft has stopped developing it (voice access is its successor for people, with no API),
so this is the on-device recognizer Windows offers apps today.

SAPI splits phrases itself: a hypothesis while a phrase is said, then its recognition. Each
recognition is one phrase, numbered as the Web Speech API numbers its results.
*/

use super::diagnostics::note;
use super::{sapi_step_problem, Availability, Control, Emitter, Problem, SapiStep, FLUSH};
use std::ffi::c_void;
use std::sync::mpsc;
use std::time::Instant;
use windows::core::{IUnknown, Interface, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Globalization::LocaleNameToLCID;
use windows::Win32::Media::Speech::{
    IEnumSpObjectTokens, ISpObjectToken, ISpObjectTokenCategory, ISpRecoContext, ISpRecoResult,
    ISpRecognizer, SpInprocRecognizer, SpMMAudioIn, SpObjectTokenCategory, SPCAT_AUDIOIN,
    SPCAT_RECOGNIZERS, SPEI_FALSE_RECOGNITION, SPEI_HYPOTHESIS, SPEI_RECOGNITION,
    SPET_LPARAM_IS_OBJECT, SPET_LPARAM_IS_POINTER, SPET_LPARAM_IS_STRING, SPEVENT, SPLO_STATIC,
    SPRST_ACTIVE, SPRST_INACTIVE, SPRST_INACTIVE_WITH_PURGE, SPRS_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};

/// COM for the calling thread, for as long as this lives.
struct Com(bool);

impl Com {
    fn new() -> Self {
        Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

/// SAPI's own "the whole phrase" (`SP_GETWHOLEPHRASE`, -1 as a ULONG).
const WHOLE_PHRASE: u32 = u32::MAX;

/// Which events the context reports: `SPFEI(id)`, each with SAPI's two check bits
/// (`SPFEI_FLAGCHECK`, reserved events 30 and 33).
fn interest() -> u64 {
    let check = (1u64 << 30) | (1u64 << 33);
    [SPEI_RECOGNITION, SPEI_HYPOTHESIS, SPEI_FALSE_RECOGNITION]
        .iter()
        .fold(check, |mask, event| mask | (1u64 << event.0))
}

/// The installed recognizer for `language`, matched as SAPI matches its `Language` attribute: the
/// language's LCID in hex.
fn recognizer_for(language: &str) -> Option<ISpObjectToken> {
    let lcid = unsafe { LocaleNameToLCID(&HSTRING::from(language), 0) };
    if lcid == 0 {
        return None;
    }
    let category: ISpObjectTokenCategory =
        unsafe { CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL) }.ok()?;
    unsafe { category.SetId(SPCAT_RECOGNIZERS, false) }.ok()?;
    let wanted = HSTRING::from(format!("Language={lcid:x}"));
    let tokens: IEnumSpObjectTokens =
        unsafe { category.EnumTokens(&wanted, PCWSTR::null()) }.ok()?;
    let mut token: Option<ISpObjectToken> = None;
    let mut fetched = 0u32;
    unsafe { tokens.Next(1, &mut token, Some(&mut fetched)) }.ok()?;
    (fetched == 1).then_some(token).flatten()
}

pub fn available(language: &str) -> Availability {
    let _com = Com::new();
    if recognizer_for(language).is_some() {
        Availability::Available
    } else {
        Availability::Unavailable
    }
}

/// How many microphones SAPI can listen to on this computer.
fn microphones() -> windows::core::Result<u32> {
    let category: ISpObjectTokenCategory =
        unsafe { CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL) }?;
    unsafe { category.SetId(SPCAT_AUDIOIN, false) }?;
    let tokens: IEnumSpObjectTokens =
        unsafe { category.EnumTokens(PCWSTR::null(), PCWSTR::null()) }?;
    let mut count = 0u32;
    unsafe { tokens.GetCount(&mut count) }?;
    Ok(count)
}

/// Why `step` failed, as the page reads it. See `sapi_step_problem`.
fn failed(step: SapiStep, error: &windows::core::Error) -> Problem {
    sapi_step_problem(step, error.code().0)
}

/// What the recognizer heard in `result`, or nothing.
fn words(result: &ISpRecoResult) -> Option<String> {
    let mut text = PWSTR::null();
    unsafe { result.GetText(WHOLE_PHRASE, WHOLE_PHRASE, true, &mut text, None) }.ok()?;
    if text.is_null() {
        return None;
    }
    let words = unsafe { text.to_string() }.ok();
    unsafe { CoTaskMemFree(Some(text.0 as *const c_void)) };
    words
}

/// An event's words, if it carried a result, and what it owned released (`SpClearEvent`).
fn take(event: &SPEVENT) -> Option<String> {
    let kind = (event._bitfield >> 16) & 0xffff;
    let pointer = event.lParam.0 as *mut c_void;
    if pointer.is_null() {
        return None;
    }
    if kind == SPET_LPARAM_IS_OBJECT.0 {
        // The event holds a reference; this takes it, and dropping it releases it.
        let object = unsafe { IUnknown::from_raw(pointer) };
        return object.cast::<ISpRecoResult>().ok().as_ref().and_then(words);
    }
    if kind == SPET_LPARAM_IS_POINTER.0 || kind == SPET_LPARAM_IS_STRING.0 {
        unsafe { CoTaskMemFree(Some(pointer as *const c_void)) };
    }
    None
}

pub fn listen(language: &str, out: &mut Emitter, control: &mpsc::Receiver<Control>) {
    let _com = Com::new();
    let Some(token) = recognizer_for(language) else {
        note(format_args!("no SAPI recognizer installed for {language}"));
        out.fail(Problem::LanguageNotSupported);
        return;
    };
    let opened = (|| -> windows::core::Result<(ISpRecognizer, ISpRecoContext)> {
        let recognizer: ISpRecognizer =
            unsafe { CoCreateInstance(&SpInprocRecognizer, None, CLSCTX_ALL) }?;
        unsafe { recognizer.SetRecognizer(&token) }?;
        let context = unsafe { recognizer.CreateRecoContext() }?;
        unsafe { context.SetNotifyWin32Event() }?;
        unsafe { context.SetInterest(interest(), interest()) }?;
        Ok((recognizer, context))
    })();
    let (recognizer, context) = match opened {
        Ok(opened) => opened,
        Err(error) => {
            note(format_args!(
                "the recognizer would not open: {:?}",
                error.code()
            ));
            out.fail(failed(SapiStep::Recognizer, &error));
            return;
        }
    };
    // A computer with no microphone has the recognizer all the same; said as what it is.
    match microphones() {
        Ok(0) => {
            note(format_args!("no microphone: SAPI lists no audio input"));
            out.fail(Problem::AudioCapture);
            return;
        }
        Ok(_) => {}
        Err(error) => note(format_args!(
            "the audio inputs could not be listed: {:?}",
            error.code()
        )),
    }
    // The default microphone.
    let microphone = (|| -> windows::core::Result<()> {
        let audio: IUnknown = unsafe { CoCreateInstance(&SpMMAudioIn, None, CLSCTX_ALL) }?;
        unsafe { recognizer.SetInput(&audio, true) }
    })();
    if let Err(error) = microphone {
        note(format_args!(
            "the microphone would not open: {:?}",
            error.code()
        ));
        out.fail(failed(SapiStep::Input, &error));
        return;
    }
    let grammar = (|| -> windows::core::Result<_> {
        let grammar = unsafe { context.CreateGrammar(0) }?;
        unsafe { grammar.LoadDictation(PCWSTR::null(), SPLO_STATIC) }?;
        Ok(grammar)
    })();
    let grammar = match grammar {
        Ok(grammar) => grammar,
        Err(error) => {
            note(format_args!("dictation would not load: {:?}", error.code()));
            out.fail(failed(SapiStep::LoadDictation, &error));
            return;
        }
    };
    // Where SAPI opens the microphone: a missing or refused one fails here, not the language.
    if let Err(error) = unsafe { grammar.SetDictationState(SPRS_ACTIVE) } {
        note(format_args!(
            "dictation would not turn on: {:?}",
            error.code()
        ));
        out.fail(failed(SapiStep::ActivateDictation, &error));
        return;
    }
    if let Err(error) = unsafe { recognizer.SetRecoState(SPRST_ACTIVE) } {
        note(format_args!(
            "listening would not start: {:?}",
            error.code()
        ));
        out.fail(failed(SapiStep::ActivateRecognizer, &error));
        return;
    }

    out.start();
    let mut current = 0u32;
    let mut stopping: Option<Instant> = None;
    loop {
        match control.try_recv() {
            Ok(Control::Abort) | Err(mpsc::TryRecvError::Disconnected) => {
                let _ = unsafe { recognizer.SetRecoState(SPRST_INACTIVE_WITH_PURGE) };
                break;
            }
            Ok(Control::Stop) if stopping.is_none() => {
                // The microphone closes; the recognizer finishes the audio it already has.
                stopping = Some(Instant::now());
                note(format_args!("stop: handing over phrase {current}"));
                let _ = unsafe { recognizer.SetRecoState(SPRST_INACTIVE) };
            }
            _ => {}
        }
        let _ = unsafe { context.WaitForNotifyEvent(100) };
        loop {
            let mut event = SPEVENT::default();
            let mut fetched = 0u32;
            if unsafe { context.GetEvents(1, &mut event, &mut fetched) }.is_err() || fetched == 0 {
                break;
            }
            let id = event._bitfield & 0xffff;
            let heard = take(&event);
            if id == SPEI_HYPOTHESIS.0 {
                if let Some(words) = heard {
                    out.words(current, &words);
                }
            } else if id == SPEI_RECOGNITION.0 {
                out.finish(current, heard.as_deref());
                current += 1;
            } else if id == SPEI_FALSE_RECOGNITION.0 && !out.heard(current).is_empty() {
                // Too unsure to recognise, but the words shown while it was said are kept.
                out.finish(current, None);
                current += 1;
            }
        }
        // Done once the last phrase is in, or nothing was being said, or the wait is over.
        let flushed = stopping.is_some_and(|at| {
            at.elapsed() >= FLUSH || (out.heard(current).is_empty() && at.elapsed() >= FLUSH / 3)
        });
        if flushed || !out.listening() {
            break;
        }
    }
    out.finish_all();
    drop(grammar);
}
