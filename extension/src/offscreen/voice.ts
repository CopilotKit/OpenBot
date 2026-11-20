// The person's narration, transcribed in this browser with the Web Speech API while they record. It runs in the offscreen
// document, which lasts the whole recording (the popup closes when it loses focus). Chrome lets an offscreen document use
// speech recognition and the microphone once the extension's own origin holds a lasting microphone grant, which the
// setup page asks for on a visible tab when the person turns narration on; without one, both fail at once as not allowed,
// since an offscreen document cannot show a prompt. The microphone is opened with getUserMedia and its track handed to the
// recognizer, so a missing grant or a missing device is told apart from a speech-service failure.
//
// Recognition runs on this computer or not at all. Chrome's speech recognition sends the audio to a speech service unless
// the recognition sets `processLocally`, so every recognition here sets it, and before the microphone opens the browser
// is asked whether it can recognise the narration's language on the device (@openbot/shared/on-device-speech): where it
// cannot, narration is off and the popup says why in one sentence; where the language is still to be downloaded, which
// takes the person's click (the popup's Download, the setup page, or the Record button), it says so; while it downloads,
// it waits for it. Only the words leave: each final phrase becomes one masked `transcript` event in the recording, and no
// audio is kept. Interim words only update the popup, masked the same way. A browser that hears speech but hands back no
// words (every phrase empty) says so in the popup after a while.
//
// Nothing here may use a chrome.* API: an offscreen document has only runtime messaging.
import {
  keepOnDevice,
  type OnDeviceSpeech,
  onDeviceSpeech,
} from "@openbot/shared/on-device-speech";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import type { VoiceCapture, VoiceProblem } from "../protocol/messages";

type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

type RecognitionResult = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string } | undefined;
};
type RecognitionResultEvent = {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: RecognitionResult | undefined;
  };
};

/** The parts of the Web Speech API's SpeechRecognition the Recorder uses. */
export type RecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  /** Sound, then speech, was heard: the browser is listening to someone. */
  onsoundstart?: (() => void) | null;
  onspeechstart?: (() => void) | null;
  /** Chrome takes the microphone track to listen to; a browser without that form ignores it and opens the default
   * microphone itself. */
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
};
export type RecognitionConstructor = new () => RecognitionLike;

export type VoiceDeps = {
  /** SpeechRecognition (or webkitSpeechRecognition); null when the browser has none. */
  Recognition: RecognitionConstructor | null;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  now(): number;
  timers: Timers;
};

export type VoiceOptions = {
  /** BCP 47, the page's language or the browser's. */
  language: string;
  muted: boolean;
  /** One `transcript` event per final phrase, already masked. */
  emit(event: CapturedEvent): void;
  /** When the phrase being spoken began, as its transcript will be stamped, or null once none is: called on each
   * change, after the phrase's transcript when one ends. What the person does from then on happened while they said it,
   * so it waits for that transcript (steps.ts). */
  speaking?(since: number | null): void;
  status(voice: VoiceCapture): void;
  /** The browser's own name for its speech service in the sentences the popup shows: Chrome, or Edge, as it is. */
  browser?: string;
  /** The Recorder's text masking for a transcript, with the recording's sensitive-value digests. `before` is the phrase
   * said just before (empty for the first): Chrome ends a phrase at a pause, so a number read out after "my card number
   * is" can come as a phrase of its own. */
  mask(text: string, before: string): string;
};

export type Voice = {
  /** Muting ends the recognition after the phrase in progress and lets go of the microphone; unmuting (also the way to
   * try again after a failure) opens it again. */
  mute(muted: boolean): void;
  /** The recording ends: the phrase in progress is emitted, then the microphone is let go. Nothing is emitted after
   * it resolves. */
  stop(): Promise<void>;
};

/** How long Stop waits for the speech service to hand over the phrase in progress. */
export const FLUSH_MS = 1_500;
/** Interim words reach the popup at most this often. */
const INTERIM_MS = 400;
/** A recognition that ends sooner than this after it started is restarted with a growing delay, never in a tight loop. */
const QUICK_END_MS = 2_000;
const RESTART_FIRST_MS = 500;
const RESTART_MAX_MS = 30_000;
const NETWORK_FIRST_MS = 2_000;
const NETWORK_MAX_MS = 60_000;
/** The popup shows the end of what was heard, not all of it. */
const HEARD_MAX = 160;
/** Speech heard for this long without a phrase coming back in words means the browser is not transcribing it. */
export const NO_WORDS_MS = 20_000;
export const NO_WORDS_SENTENCE =
  "This browser is not turning your speech into words. Recording carries on without narration.";
/** How often a language being downloaded for on-device recognition is asked about again. */
export const DOWNLOAD_POLL_MS = 3_000;

const GOES_ON = "Recording goes on without your voice.";

function languageName(language: string): string {
  try {
    return (
      new Intl.DisplayNames(["en"], { type: "language" }).of(language) ??
      language
    );
  } catch {
    return language;
  }
}

/** The plain sentence the popup shows for each failure, naming the browser the Recorder runs in (Chrome by default). */
export function voiceSentence(
  problem: VoiceProblem,
  language: string,
  browser = "Chrome",
): string {
  switch (problem) {
    case "microphone":
      return `The Recorder is not allowed to use the microphone. ${GOES_ON}`;
    case "no-microphone":
      return `No microphone was found, or another app is using it. ${GOES_ON}`;
    case "no-recognition":
      return `This browser cannot turn speech into text. ${GOES_ON}`;
    case "on-device":
      return `This version of ${browser} cannot turn speech into text on your computer, and the Recorder sends no voice anywhere else. ${GOES_ON}`;
    case "speech-pack":
      return `${browser} has to download its ${languageName(language)} speech recognition to your computer first. Choose Download, then voice turns on. ${GOES_ON}`;
    case "service":
      return `${browser}'s speech recognition is turned off or not available here. ${GOES_ON}`;
    case "network":
      return `${browser}'s speech service cannot be reached. Recording goes on, and voice tries again in a moment.`;
    case "language":
      return `${browser} cannot turn ${languageName(language)} speech into text on your computer. ${GOES_ON}`;
  }
}

/** What the Voice row says while the language downloads: voice starts by itself once it is there. */
export function downloadingSentence(
  language: string,
  browser = "Chrome",
): string {
  return `${browser} is downloading its ${languageName(language)} speech recognition to your computer. Voice starts when it is ready.`;
}

/** Why voice cannot start from what the browser said of on-device recognition, or null when it can (or soon will). */
function onDeviceProblem(local: OnDeviceSpeech): VoiceProblem | null {
  switch (local) {
    case "available":
    case "downloading":
      return null;
    case "downloadable":
      return "speech-pack";
    case "unavailable":
      return "language";
    case "unsupported":
      return "on-device";
  }
}

/** The name the person knows their browser by, from what it says it is: Chrome and Edge run this same build, and
 * Edge's own speech service is Microsoft's, not Google's. Any other Chromium browser goes by its own brand. */
export function browserName(
  navigator: {
    userAgent?: string;
    userAgentData?: { brands?: readonly { brand: string }[] };
  } = globalThis.navigator ?? {},
): string {
  const brands = (navigator.userAgentData?.brands ?? [])
    .map((entry) => entry.brand)
    .filter((brand) => !/chromium|not.?a.?brand/i.test(brand));
  const brand = brands[0];
  if (brand !== undefined)
    return brand.replace(/^Google /, "").replace(/^Microsoft /, "");
  const agent = navigator.userAgent ?? "";
  if (/\bEdg(?:e|A|iOS)?\//.test(agent)) return "Edge";
  if (/\bOPR\//.test(agent)) return "Opera";
  return "Chrome";
}

/** Why getUserMedia refused, as the Voice row says it. */
function microphoneProblem(error: unknown): VoiceProblem {
  const name = error instanceof Error ? error.name : "";
  return name === "NotAllowedError" || name === "SecurityError"
    ? "microphone"
    : "no-microphone";
}

/** The last words heard, shortened from the front at a word boundary. */
function tail(text: string): string {
  if (text.length <= HEARD_MAX) return text;
  const cut = text.slice(-HEARD_MAX);
  const space = cut.indexOf(" ");
  return `…${space > 0 ? cut.slice(space + 1) : cut}`;
}

/** One microphone opening: its stream and the recognitions that listen to it, restarted as Chrome ends them. */
type Listening = {
  stream: MediaStream;
  track: MediaStreamTrack;
  recognition: RecognitionLike | null;
  startedAt: number;
  /** Result indexes of the current recognition already emitted, when each was first heard, and when the last one
   * ended: Chrome can show a phrase's index while the one before is still being spoken, so a phrase starts no earlier
   * than the end of the one before it. An index the results no longer reach is forgotten (`results`). */
  emitted: Set<number>;
  firstHeard: Map<number, number>;
  lastFinalAt: number;
  ended: (() => void) | null;
};

export function startVoice(options: VoiceOptions, deps: VoiceDeps): Voice {
  const { language, emit, mask } = options;
  let muted = options.muted;
  let closed = false;
  /** The current opening of the microphone; replaced or cleared when it ends, so a late callback of an old one is ignored. */
  let current: Listening | null = null;
  /** Bumped by every begin, mute and stop: an opening still under way checks it is still wanted. */
  let generation = 0;
  let failed = false;
  let quickEnds = 0;
  let networkFailures = 0;
  let restartTimer: unknown = null;
  let interimTimer: unknown = null;
  let pendingHeard: string | null = null;
  let heard: string | undefined;
  let lastStatus: VoiceCapture | null = null;
  /** The last final phrase, unmasked, so the next one is masked knowing what came before it. */
  let lastPhrase = "";
  /** Runs from the first speech heard until a phrase comes back in words; when it fires, the popup says none do. */
  let noWordsTimer: unknown = null;
  let noWords = false;
  /** When the phrase being spoken began, as last reported (`speaking`). */
  let speakingSince: number | null = null;

  /** Reports when the earliest phrase heard and not yet sent began, stamped as its transcript will be (never before the
   * phrase ahead of it ended), or null when none is: a recognition that ended or was let go sends no more phrases. */
  function reportSpeaking(): void {
    const listening = current;
    let since: number | null = null;
    if (listening?.recognition && !closed)
      for (const [index, heardAt] of listening.firstHeard) {
        if (listening.emitted.has(index)) continue;
        const start = Math.max(heardAt, listening.lastFinalAt);
        since = since === null ? start : Math.min(since, start);
      }
    if (since === speakingSince) return;
    speakingSince = since;
    options.speaking?.(since);
  }

  const status = (voice: VoiceCapture) => {
    if (closed) return;
    lastStatus = voice;
    options.status(voice);
  };
  const listeningStatus = () =>
    status({
      state: "listening",
      ...(heard ? { heard } : {}),
      ...(noWords ? { reason: NO_WORDS_SENTENCE } : {}),
    });

  function clearTimers(): void {
    if (restartTimer !== null) deps.timers.clear(restartTimer);
    if (interimTimer !== null) deps.timers.clear(interimTimer);
    if (noWordsTimer !== null) deps.timers.clear(noWordsTimer);
    restartTimer = null;
    interimTimer = null;
    noWordsTimer = null;
    pendingHeard = null;
    noWords = false;
  }

  /** Speech was heard (a sound or speech began, or results came): unless a phrase comes back in words within
   * NO_WORDS_MS, the browser is not turning it into words, as Edge does when every final phrase it returns is empty. The
   * microphone stays open and recognition goes on, so the sentence goes as soon as words come. */
  function speechHeard(): void {
    if (noWords || noWordsTimer !== null || muted || failed || closed) return;
    noWordsTimer = deps.timers.set(() => {
      noWordsTimer = null;
      if (muted || failed || closed || !current) return;
      noWords = true;
      if (lastStatus?.state === "listening") listeningStatus();
    }, NO_WORDS_MS);
  }

  function wordsCame(): void {
    if (noWordsTimer !== null) deps.timers.clear(noWordsTimer);
    noWordsTimer = null;
    noWords = false;
  }

  function release(listening: Listening): void {
    listening.track.onended = null;
    for (const track of listening.stream.getTracks()) track.stop();
    if (current === listening) current = null;
    reportSpeaking();
  }

  /** Lets go of an opening at once: a Stop or mute waiting on its last phrase stops waiting. */
  function drop(listening: Listening): void {
    if (listening.ended) {
      listening.ended();
      return;
    }
    const recognition = listening.recognition;
    listening.recognition = null;
    recognition?.abort();
    release(listening);
  }

  function fail(problem: VoiceProblem, detail?: unknown): void {
    if (detail !== undefined)
      console.error(`Recorder: voice stopped (${problem})`, detail);
    failed = true;
    generation += 1;
    clearTimers();
    if (current) drop(current);
    heard = undefined;
    status({
      state: "failed",
      problem,
      reason: voiceSentence(problem, language, options.browser),
      // The popup's Download asks for this language.
      ...(problem === "speech-pack" ? { language } : {}),
    });
  }

  function showInterim(text: string): void {
    pendingHeard = text;
    if (interimTimer !== null) return;
    interimTimer = deps.timers.set(() => {
      interimTimer = null;
      const next = pendingHeard;
      pendingHeard = null;
      if (next === null || muted || !current || current.recognition === null)
        return;
      heard = next;
      listeningStatus();
    }, INTERIM_MS);
  }

  function results(listening: Listening, event: RecognitionResultEvent): void {
    const at = deps.now();
    speechHeard();
    // While a phrase is said Chrome splits it into a settled head and a changing tail at the next index, and folds the
    // tail back in when the phrase is final, so the results get shorter; the next phrase reuses that index seconds
    // later. An index the results no longer reach is forgotten, or the next phrase would start when the last one's
    // tail was first shown: 2.2 s early in a real Chrome 156 run (tests/fixtures/chrome-156-two-phrases.json). The
    // app's own recogniser times the phrases it passes in by the same rule (app/src/lib/browser/narration.ts).
    for (const index of listening.firstHeard.keys())
      if (index >= event.results.length && !listening.emitted.has(index))
        listening.firstHeard.delete(index);
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const result = event.results[index];
      if (!result) continue;
      const text = result[0]?.transcript ?? "";
      if (!listening.firstHeard.has(index)) listening.firstHeard.set(index, at);
      if (!result.isFinal) {
        interim += text;
        continue;
      }
      if (listening.emitted.has(index)) continue;
      listening.emitted.add(index);
      const phrase = text.trim();
      if (!phrase) continue;
      const masked = mask(phrase, lastPhrase);
      lastPhrase = phrase;
      wordsCame();
      const startedAt = Math.max(
        listening.firstHeard.get(index) ?? at,
        listening.lastFinalAt,
      );
      listening.lastFinalAt = at;
      emit({
        type: "CUSTOM",
        name: "transcript",
        timestamp: startedAt,
        value: {
          text: masked,
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(at).toISOString(),
          language,
        },
      });
      heard = tail(masked);
      networkFailures = 0;
      quickEnds = 0;
    }
    reportSpeaking();
    // While a mute or Stop waits for the last phrase, its words are still sent but the popup already says muted.
    if (muted) return;
    const said = interim.trim();
    if (said) showInterim(tail(mask(said, lastPhrase)));
    else if (listening.recognition !== null) {
      pendingHeard = null;
      listeningStatus();
    }
  }

  function schedule(ms: number, work: () => void): void {
    if (restartTimer !== null) deps.timers.clear(restartTimer);
    restartTimer = deps.timers.set(() => {
      restartTimer = null;
      work();
    }, ms);
  }

  /** Chrome ended a recognition (a long silence, its own time limit, a network error): another listens to the same
   * microphone while voice is wanted. */
  function ended(listening: Listening, networkError: boolean): void {
    const recognition = listening.recognition;
    listening.recognition = null;
    // Its phrases still unsent never will be.
    reportSpeaking();
    const waiter = listening.ended;
    listening.ended = null;
    if (waiter) {
      waiter();
      return;
    }
    if (recognition === null || current !== listening || closed) return;
    if (muted || failed) {
      release(listening);
      return;
    }
    if (listening.track.readyState !== "live") {
      fail("no-microphone");
      return;
    }
    let delay = 0;
    if (networkError) {
      networkFailures += 1;
      delay = Math.min(
        NETWORK_MAX_MS,
        NETWORK_FIRST_MS * 2 ** (networkFailures - 1),
      );
    } else if (deps.now() - listening.startedAt < QUICK_END_MS) {
      quickEnds += 1;
      delay = Math.min(RESTART_MAX_MS, RESTART_FIRST_MS * 2 ** (quickEnds - 1));
    } else quickEnds = 0;
    schedule(delay, () => {
      if (current === listening && !muted && !failed && !closed)
        listen(listening);
    });
  }

  function listen(listening: Listening): void {
    const Recognition = deps.Recognition;
    if (!Recognition) {
      fail("no-recognition");
      return;
    }
    let recognition: RecognitionLike;
    try {
      recognition = new Recognition();
    } catch (error) {
      fail("no-recognition", error);
      return;
    }
    recognition.lang = language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    // On this computer or not at all: without it, Chrome streams the audio to its speech service.
    keepOnDevice(recognition);
    let networkError = false;
    recognition.onstart = () => {
      if (listening.recognition !== recognition) return;
      listeningStatus();
    };
    const heardSound = () => {
      if (listening.recognition === recognition) speechHeard();
    };
    recognition.onsoundstart = heardSound;
    recognition.onspeechstart = heardSound;
    recognition.onresult = (event) => {
      if (listening.recognition !== recognition && !listening.ended) return;
      results(listening, event);
    };
    recognition.onerror = (event) => {
      if (listening.recognition !== recognition || listening.ended) return;
      switch (event.error) {
        case "no-speech":
        case "aborted":
          return; // the end that follows restarts it
        case "network":
          networkError = true;
          status({
            state: "failed",
            problem: "network",
            reason: voiceSentence("network", language, options.browser),
          });
          return;
        case "language-not-supported":
        case "service-not-allowed":
          fail(
            event.error === "language-not-supported" ? "language" : "service",
            event.error,
          );
          return;
        case "not-allowed":
          fail("microphone", event.error);
          return;
        case "audio-capture":
          fail("no-microphone", event.error);
          return;
        default:
          fail("service", `${event.error} ${event.message ?? ""}`.trim());
      }
    };
    recognition.onend = () => {
      if (listening.recognition !== recognition) return;
      ended(listening, networkError);
    };
    listening.recognition = recognition;
    listening.startedAt = deps.now();
    listening.emitted = new Set();
    listening.firstHeard = new Map();
    listening.lastFinalAt = 0;
    reportSpeaking();
    try {
      recognition.start(listening.track);
    } catch (error) {
      listening.recognition = null;
      fail("service", error);
    }
  }

  /** Whether the narration's language can be recognised on this computer: true once it can, after waiting out a download
   * under way; false when it cannot (voice failed, saying why) or the opening is no longer wanted. */
  async function onDevice(opening: number): Promise<boolean> {
    const wanted = () => opening === generation && !closed && !muted;
    let told = false;
    for (;;) {
      const local = await onDeviceSpeech(deps.Recognition, language);
      if (!wanted()) return false;
      const problem = onDeviceProblem(local);
      if (problem) {
        fail(problem);
        return false;
      }
      if (local === "available") return true;
      if (!told) {
        told = true;
        status({
          state: "starting",
          reason: downloadingSentence(language, options.browser),
        });
      }
      await new Promise<void>((resolve) =>
        deps.timers.set(resolve, DOWNLOAD_POLL_MS),
      );
      if (!wanted()) return false;
    }
  }

  async function begin(): Promise<void> {
    const opening = ++generation;
    failed = false;
    clearTimers();
    lastPhrase = "";
    if (current) drop(current);
    status({ state: "starting" });
    if (!deps.Recognition) {
      fail("no-recognition");
      return;
    }
    // Before the microphone opens: a browser that cannot keep the speech on this computer never hears it.
    if (!(await onDevice(opening))) return;
    let stream: MediaStream;
    try {
      stream = await deps.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      if (opening === generation && !closed)
        fail(microphoneProblem(error), error);
      return;
    }
    const stillWanted = () => opening === generation && !closed && !muted;
    if (!stillWanted()) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const [track] = stream.getAudioTracks();
    if (!track) {
      for (const each of stream.getTracks()) each.stop();
      fail("no-microphone");
      return;
    }
    const listening: Listening = {
      stream,
      track,
      recognition: null,
      startedAt: deps.now(),
      emitted: new Set(),
      firstHeard: new Map(),
      lastFinalAt: 0,
      ended: null,
    };
    current = listening;
    // The microphone went away (unplugged, or taken by the system): voice cannot go on until the person tries again.
    track.onended = () => {
      if (current === listening) fail("no-microphone");
    };
    listen(listening);
  }

  /** Ends the current opening after the phrase in progress, waiting at most FLUSH_MS for it. */
  function finish(): Promise<void> {
    generation += 1;
    clearTimers();
    const listening = current;
    if (!listening) return Promise.resolve();
    const recognition = listening.recognition;
    if (!recognition) {
      release(listening);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let timer: unknown = null;
      const done = () => {
        if (timer !== null) deps.timers.clear(timer);
        if (listening.ended === done) listening.ended = null;
        if (listening.recognition === recognition) {
          listening.recognition = null;
          recognition.abort();
        }
        release(listening);
        resolve();
      };
      timer = deps.timers.set(done, FLUSH_MS);
      listening.ended = done;
      try {
        recognition.stop();
      } catch {
        done();
      }
    });
  }

  if (muted) status({ state: "muted" });
  else void begin().catch((error) => fail("service", error));

  return {
    mute(next) {
      if (closed) return;
      if (next) {
        muted = true;
        failed = false;
        heard = undefined;
        void finish();
        status({ state: "muted" });
        return;
      }
      const wasMuted = muted;
      muted = false;
      // Already listening (or opening): unmuting changes nothing. After a mute or a failure (a speech service out of
      // reach included, which would otherwise wait for its own retry) it opens the microphone again now.
      if (!wasMuted && lastStatus?.state !== "failed") return;
      void begin().catch((error) => fail("service", error));
    },
    async stop() {
      if (closed) return;
      muted = true;
      await finish();
      closed = true;
    },
  };
}
