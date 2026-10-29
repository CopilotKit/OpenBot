/*
 * NARRATION FROM THE PAGE. On hosted OpenBot the person's browser runs on a computer with no microphone, so this page
 * listens to them instead, in their own browser, with the Web Speech API, and hands each final phrase to the Recorder
 * with when they started and stopped saying it. It also says when a phrase began, as soon as its first words come
 * back, so the Recorder holds the steps taken while it is said until it arrives. On OpenBot Desktop none of this runs:
 * the Recorder hears the microphone itself.
 *
 * It is the browser's own speech recognition (`SpeechRecognition`, or the `webkitSpeechRecognition` Chrome and Safari
 * still answer to), continuous and with interim results, which is what lets a phrase be timed from its first words
 * rather than from when it was finished. It runs on the person's own computer or not at all: Chrome sends the audio to
 * its speech service unless a recognition sets `processLocally`, so every recognition here sets it, and the browser is
 * asked first whether it can recognise the language on the device (@openbot/shared/on-device-speech). Where it cannot
 * (Firefox, Safari, an older Chrome, a language it has no model for), narration is off and the page says why; where the
 * language is still to be downloaded, turning narration on downloads it (a click is the only thing that may), and
 * narration waits for it. Nothing here keeps any audio, and only the words of each final phrase, and when a phrase
 * began, leave the page.
 */
import {
  keepOnDevice,
  type OnDeviceSpeech,
  onDeviceSpeech,
} from "@openbot/shared/on-device-speech";

type RecognitionAlternative = { readonly transcript: string };
type RecognitionResult = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternative | undefined;
};
/** A `SpeechRecognitionEvent`: every result of this recognition so far, and the lowest one that changed. */
export type RecognitionResultEvent = {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: RecognitionResult | undefined;
  };
};

/** The parts of `SpeechRecognition` used here. */
export type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
export type RecognitionConstructor = new () => Recognition;

/** The browser's speech recognition, prefixed or not, or `null` where it has none (Firefox). */
export function speechRecognition(
  scope: object = globalThis,
): RecognitionConstructor | null {
  const speech = scope as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return speech.SpeechRecognition ?? speech.webkitSpeechRecognition ?? null;
}

/** One final phrase, with when the person started and stopped saying it (epoch ms). */
export type Phrase = { text: string; startedAt: number; endedAt: number };

/**
 * WHEN A PHRASE WAS SAID, from the results a recognition hands back.
 *
 * A phrase starts when its first words came back and ends when it came back final. Each result in the list is one
 * phrase, so "first heard" is kept per index, from the first event that showed anything there.
 *
 * TWO THINGS CHROME DOES MAKE THAT HARDER, both seen in a real run (app/tests/fixtures):
 * - While a phrase is being said Chrome splits it in two, a settled head and a changing tail at the next index, and
 *   folds the tail back in when the phrase is final, so the list gets shorter. That next index is reused by the next
 *   phrase seconds later. An index the list no longer holds is therefore forgotten, or the next phrase would start
 *   when the previous one's tail was first shown (in the real run, 3.7 seconds before its first word).
 * - Every event repeats the final results before it. A phrase is sent once, the first time it is final.
 *
 * A phrase never starts before the one ahead of it ended, which holds the order if Chrome shows a phrase's first words
 * while the one before is still being finished. The Recorder times the phrases it hears on OpenBot Desktop by the same
 * rule (extension/src/offscreen/voice.ts), so a recording's narration lines up with its steps the same way either way.
 */
export class PhraseClock {
  #firstHeard = new Map<number, number>();
  #sent = new Set<number>();
  #lastEndedAt = 0;

  /** The phrases this event finished, in order. `at` is when it arrived. */
  heard(event: RecognitionResultEvent, at: number): Phrase[] {
    for (const index of this.#firstHeard.keys())
      if (index >= event.results.length && !this.#sent.has(index))
        this.#firstHeard.delete(index);
    const phrases: Phrase[] = [];
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const result = event.results[index];
      if (!result) continue;
      if (!this.#firstHeard.has(index)) this.#firstHeard.set(index, at);
      if (!result.isFinal || this.#sent.has(index)) continue;
      this.#sent.add(index);
      const text = (result[0]?.transcript ?? "").trim();
      // A final result with no words is nothing said: it ends nothing either.
      if (!text) continue;
      const startedAt = Math.max(
        this.#firstHeard.get(index) ?? at,
        this.#lastEndedAt,
      );
      this.#lastEndedAt = at;
      phrases.push({ text, startedAt, endedAt: at });
    }
    return phrases;
  }

  /**
   * When the phrase being said began, stamped as it will be once it is final, or null when none is: the earliest result
   * heard and not yet sent. A final result with no words ends its phrase too, and a result the list no longer holds is
   * forgotten by the next event, as `heard` forgets it.
   */
  speakingSince(): number | null {
    let since: number | null = null;
    for (const [index, heardAt] of this.#firstHeard) {
      if (this.#sent.has(index)) continue;
      const start = Math.max(heardAt, this.#lastEndedAt);
      since = since === null ? start : Math.min(since, start);
    }
    return since;
  }

  /** A new recognition numbers its results from 0 again; the last phrase's end still holds. */
  restart(): void {
    this.#firstHeard.clear();
    this.#sent.clear();
  }
}

export type NarrationProblem =
  /** No speech recognition in this browser. */
  | "unsupported"
  /** Speech recognition, but none that stays on the person's computer. */
  | "on-device"
  /** The language has to be downloaded to the computer first, which only the person's click may start. */
  | "speech-pack"
  /** The person, or the browser, refused the microphone. */
  | "not-allowed"
  | "no-microphone"
  /** The browser's speech service is off or refused this page. */
  | "service"
  | "language"
  /** The speech service could not be reached; narration tries again by itself. */
  | "network";

export type NarrationStatus =
  | { state: "starting" }
  /** The browser is downloading the language to the computer: narration starts once it is there. */
  | { state: "downloading" }
  | { state: "listening" }
  | { state: "muted" }
  | { state: "failed"; problem: NarrationProblem };

type Timers = {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type NarrationDeps = {
  Recognition: RecognitionConstructor | null;
  now(): number;
  timers: Timers;
};

export type NarrationOptions = {
  /** BCP 47, the language the recording was started in. */
  language: string;
  muted: boolean;
  phrase(phrase: Phrase): void;
  /**
   * When the phrase being said began (its first words came back), stamped as the phrase will be, or null once none
   * is: called on each change, after the phrase when one comes back final. A recognition that ends, a mute or a Stop
   * sends no more phrases, so it says null then. The Recorder holds the steps the person takes from that moment until
   * the phrase arrives, as it does for the phrases it hears itself (extension/src/offscreen/voice.ts, `speaking`).
   */
  speaking?(since: number | null): void;
  status(status: NarrationStatus): void;
};

export type Narration = {
  /** Muting ends listening after the phrase in progress; unmuting listens again, which is also how to try again
   * after a failure. */
  mute(muted: boolean): void;
  /** The recording is ending: the phrase in progress is handed over, then listening ends. Nothing comes after it
   * resolves. */
  stop(): Promise<void>;
};

/** How long a stop waits for the speech service to hand over the phrase in progress (it took 53 ms in a real run). */
export const FLUSH_MS = 1_500;
/** How often a language being downloaded for on-device recognition is asked about again. */
export const DOWNLOAD_POLL_MS = 3_000;
/** Chrome ends a recognition by itself after a silence or its own time limit; one that ends sooner than this is
 * restarted with a growing delay, never in a tight loop. */
const QUICK_END_MS = 2_000;
const RESTART_FIRST_MS = 500;
const RESTART_MAX_MS = 30_000;
const NETWORK_FIRST_MS = 2_000;
const NETWORK_MAX_MS = 60_000;

/** Listens until stopped, restarting each recognition Chrome ends, and hands over every final phrase. */
export function startNarration(
  options: NarrationOptions,
  deps: NarrationDeps,
): Narration {
  let muted = options.muted;
  let failed = false;
  let closed = false;
  let current: Recognition | null = null;
  let currentStartedAt = 0;
  let quickEnds = 0;
  let networkFailures = 0;
  let restartTimer: unknown = null;
  /** A stop or mute waiting for the phrase in progress: called when the recognition ends. */
  let ending: (() => void) | null = null;
  const clock = new PhraseClock();
  /** When the phrase being said began, as last told (`speaking`). */
  let speakingSince: number | null = null;

  /** Tells when the phrase being said began, when that changed. Only the recognition listening now can still send one;
   * one that ended, or was let go, never will. Told after a Stop too, so the last phrase's hold is let go. */
  function reportSpeaking() {
    const since = current ? clock.speakingSince() : null;
    if (since === speakingSince) return;
    speakingSince = since;
    options.speaking?.(since);
  }

  const status = (next: NarrationStatus) => {
    if (!closed) options.status(next);
  };

  function cancelRestart() {
    if (restartTimer !== null) deps.timers.clear(restartTimer);
    restartTimer = null;
  }

  function fail(problem: NarrationProblem) {
    failed = true;
    cancelRestart();
    const recognition = current;
    current = null;
    recognition?.abort();
    reportSpeaking();
    status({ state: "failed", problem });
  }

  /** Why narration cannot start from what the browser said of on-device recognition, or null when it can (or will). */
  const onDeviceProblem = (local: OnDeviceSpeech): NarrationProblem | null =>
    local === "unsupported"
      ? "on-device"
      : local === "unavailable"
        ? "language"
        : local === "downloadable"
          ? "speech-pack"
          : null;

  /** Listening that is wanted from now: once the browser says it can keep the language on this computer, after waiting
   * out a download under way. A mute, a stop or a failure meanwhile ends the wait (`opening`). */
  let opening = 0;
  async function begin() {
    const attempt = ++opening;
    const wanted = () => attempt === opening && !closed && !muted && !failed;
    if (!deps.Recognition) {
      fail("unsupported");
      return;
    }
    for (;;) {
      const local = await onDeviceSpeech(deps.Recognition, options.language);
      if (!wanted()) return;
      const problem = onDeviceProblem(local);
      if (problem) {
        fail(problem);
        return;
      }
      if (local === "available") break;
      status({ state: "downloading" });
      await new Promise<void>((resolve) => {
        restartTimer = deps.timers.set(resolve, DOWNLOAD_POLL_MS);
      });
      restartTimer = null;
      if (!wanted()) return;
    }
    listen();
  }

  function listen() {
    restartTimer = null;
    if (closed || muted || failed) return;
    const Recognition = deps.Recognition;
    if (!Recognition) {
      fail("unsupported");
      return;
    }
    let recognition: Recognition;
    try {
      recognition = new Recognition();
    } catch {
      fail("unsupported");
      return;
    }
    recognition.lang = options.language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    // On this computer or not at all: without it, Chrome streams the audio to its speech service.
    keepOnDevice(recognition);
    let networkError = false;
    recognition.onstart = () => {
      if (recognition === current && !muted) status({ state: "listening" });
    };
    recognition.onresult = (event) => {
      if (recognition !== current) return;
      for (const phrase of clock.heard(event, deps.now())) {
        quickEnds = 0;
        networkFailures = 0;
        options.phrase(phrase);
      }
      reportSpeaking();
    };
    recognition.onerror = (event) => {
      if (recognition !== current || ending) return;
      switch (event.error) {
        // The end that follows restarts it.
        case "no-speech":
        case "aborted":
          return;
        case "network":
          networkError = true;
          status({ state: "failed", problem: "network" });
          return;
        case "not-allowed":
          fail("not-allowed");
          return;
        case "audio-capture":
          fail("no-microphone");
          return;
        case "language-not-supported":
          fail("language");
          return;
        default:
          fail("service");
      }
    };
    recognition.onend = () => {
      if (recognition !== current) return;
      current = null;
      reportSpeaking();
      const waiting = ending;
      ending = null;
      if (waiting) {
        waiting();
        return;
      }
      if (closed || muted || failed) return;
      let delay = 0;
      if (networkError) {
        networkFailures += 1;
        delay = Math.min(
          NETWORK_MAX_MS,
          NETWORK_FIRST_MS * 2 ** (networkFailures - 1),
        );
      } else if (deps.now() - currentStartedAt < QUICK_END_MS) {
        quickEnds += 1;
        delay = Math.min(
          RESTART_MAX_MS,
          RESTART_FIRST_MS * 2 ** (quickEnds - 1),
        );
      } else quickEnds = 0;
      restartTimer = deps.timers.set(listen, delay);
    };
    current = recognition;
    currentStartedAt = deps.now();
    clock.restart();
    try {
      recognition.start();
    } catch {
      current = null;
      fail("service");
    }
  }

  /** Ends the current recognition after the phrase in progress, waiting at most FLUSH_MS for it. */
  function finish(): Promise<void> {
    cancelRestart();
    const recognition = current;
    if (!recognition) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = deps.timers.set(() => {
        if (ending !== done) return;
        ending = null;
        if (current === recognition) current = null;
        recognition.abort();
        reportSpeaking();
        resolve();
      }, FLUSH_MS);
      const done = () => {
        deps.timers.clear(timer);
        resolve();
      };
      ending = done;
      try {
        recognition.stop();
      } catch {
        ending = null;
        current = null;
        deps.timers.clear(timer);
        reportSpeaking();
        resolve();
      }
    });
  }

  if (muted) status({ state: "muted" });
  else {
    status({ state: "starting" });
    void begin();
  }

  return {
    mute(next) {
      if (closed) return;
      if (next) {
        if (muted) return;
        muted = true;
        // A wait for a download ends with the mute.
        opening += 1;
        void finish();
        status({ state: "muted" });
        return;
      }
      if (!muted && !failed) return;
      muted = false;
      failed = false;
      cancelRestart();
      status({ state: "starting" });
      // A recognition still handing over its last phrase is let go first, so two never listen at once.
      if (current) {
        const recognition = current;
        current = null;
        ending = null;
        recognition.abort();
        reportSpeaking();
      }
      void begin();
    },
    async stop() {
      if (closed) return;
      closed = true;
      await finish();
    },
  };
}

/** The browser's own recognition and clock. */
export function browserNarrationDeps(): NarrationDeps {
  return {
    Recognition: speechRecognition(),
    now: () => Date.now(),
    timers: {
      set: (run, ms) => setTimeout(run, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  };
}
