/*
 * DICTATION THAT TYPES AS YOU SPEAK, WHEN OPENBOT HAS NO TRANSCRIPTION PROVIDER.
 *
 * With a provider configured the composer records and sends the audio to the server
 * (`recording.ts`, `session.ts`), and that path still wins. Without one, the words come from speech
 * recognition the person's own computer or browser already has, and they stream into the message
 * box while the person talks:
 *
 * - In the OpenBot Desktop window: the desktop app's recognizer, on the device
 *   (desktop/src-tauri/src/speech.rs: Apple's Speech framework with on-device recognition required on
 *   macOS, the in-process SAPI recognizer on Windows), through the same bridge narration uses
 *   (@/lib/desktop/speech). The window's own Web Speech API is not used: WKWebView exposes it but it
 *   is unreliable there (WebKit bug 239816), and WebView2 does not run it.
 * - In a browser: its Web Speech API (`SpeechRecognition`, or `webkitSpeechRecognition`), where it
 *   has one. Where it has none (Firefox), there is no microphone button.
 *
 * Both are driven the same way, as a continuous recognition with interim results. Every result event
 * carries the whole list of phrases so far, so the transcript is rebuilt from the list each time:
 * Chrome folds a phrase's changing tail back into its head when it is final, and the desktop app
 * numbers each phrase as its own result, and rebuilding covers both.
 *
 * The person stops with the Stop button or Enter. The recognizer is asked to hand over its last words,
 * which keep landing in the box until it ends (a short wait at most), and nothing is sent. Typing in the
 * box while listening also stops it, at once, and keeps everything on screen as it is.
 */
import {
  type Recognition,
  type RecognitionConstructor,
  type RecognitionResultEvent,
  speechRecognition,
} from "@/lib/browser/narration";
import { desktopShell } from "@/lib/desktop/shell";
import { desktopRecognition } from "@/lib/desktop/speech";

/** Where the words come from, which decides what to say when something is refused. */
export type LivePlatform = "mac" | "windows" | "browser";

export type LiveSource = {
  Recognition: RecognitionConstructor;
  platform: LivePlatform;
};

/**
 * The recognizer live dictation uses here, or null where there is none and the microphone is hidden.
 * The desktop app recognises speech on macOS and Windows only.
 */
export function liveDictationSource(
  scope: object = globalThis,
): LiveSource | null {
  const shell = desktopShell();
  if (shell) {
    const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
    const platform = /Mac/.test(agent)
      ? "mac"
      : /Windows/.test(agent)
        ? "windows"
        : null;
    return platform
      ? { Recognition: desktopRecognition(shell), platform }
      : null;
  }
  const Recognition = speechRecognition(scope);
  return Recognition ? { Recognition, platform: "browser" } : null;
}

export type LiveState =
  | { phase: "idle" }
  /** The system is asking the person for the microphone and speech recognition. */
  | { phase: "preparing" }
  | { phase: "listening" }
  /** Stop was asked for; the recognizer's last words may still arrive. */
  | { phase: "stopping" }
  | { phase: "error"; error: string };

/** How long Stop waits for the recognizer's last words before letting it go. */
export const STOP_GRACE_MS = 2_000;
/** How often, and for how long, to ask again while the person answers the system's questions. */
const PERMISSION_POLL_MS = 500;
const PERMISSION_WAIT_MS = 120_000;

/** The transcript so far: every phrase in order, final or not, joined by single spaces. */
export function transcriptOf(event: RecognitionResultEvent): string {
  const words: string[] = [];
  for (let index = 0; index < event.results.length; index++) {
    const phrase = event.results[index]?.[0]?.transcript.trim();
    if (phrase) words.push(phrase);
  }
  return words.join(" ");
}

/** What to tell the person when recognition fails, or null when the failure is not one (no speech, aborted). */
export function liveProblem(
  error: string,
  platform: LivePlatform,
): string | null {
  switch (error) {
    case "no-speech":
    case "aborted":
      return null;
    case "not-allowed":
      return platform === "mac"
        ? "OpenBot can't use the microphone or speech recognition. Turn both on for OpenBot in System Settings, under Privacy & Security, then try again."
        : platform === "windows"
          ? "OpenBot can't use the microphone. Turn on microphone access for apps in Windows Settings, under Privacy & security, then try again."
          : "Microphone access is blocked. Allow it for this site in your browser, then try again.";
    case "audio-capture":
      return "OpenBot couldn't find a microphone. Connect one, then try again.";
    case "network":
      return "Dictation in this browser needs an internet connection. Check your connection, then try again.";
    case "language-not-supported":
      return platform === "browser"
        ? "This browser can't take dictation in your language."
        : "This computer can't take dictation in your language.";
    case "service-not-allowed":
      return platform === "browser"
        ? "This browser won't run speech recognition for OpenBot. Try Chrome or Edge."
        : "Speech recognition isn't available on this computer right now. Try again in a moment.";
    default:
      return "Dictation stopped unexpectedly. Try again.";
  }
}

type Availability = (options: {
  langs: string[];
  processLocally: true;
}) => Promise<unknown>;

const idle: LiveState = { phase: "idle" };

/** One live dictation at a time: its recognizer, its state, and where its words go. */
export class LiveDictation {
  private state: LiveState = idle;
  private listeners = new Set<() => void>();
  private generation = 0;
  private recognition?: Recognition;
  private grace?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly deps: {
      source: () => LiveSource | null;
      language: () => string;
      /** Listening is about to begin: the box as it is now is what the words are added to. */
      onStart: () => void;
      /** The whole transcript so far, each time it changes. */
      onText: (text: string) => void;
      wait?: (ms: number) => Promise<void>;
    },
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(state: LiveState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  /** Listening, or about to, or finishing: Enter stops it and does not send. */
  get active(): boolean {
    return (
      this.state.phase === "preparing" ||
      this.state.phase === "listening" ||
      this.state.phase === "stopping"
    );
  }

  start = async () => {
    if (this.active) return;
    const source = this.deps.source();
    if (!source) return;
    this.release();
    const generation = this.generation;
    const language = this.deps.language();
    if (source.platform !== "browser") {
      const ready = await this.permission(source, language, generation);
      if (!ready || generation !== this.generation) return;
    }
    const recognition = new source.Recognition();
    recognition.lang = language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    let problem: string | null = null;
    recognition.onresult = (event) => {
      if (generation !== this.generation) return;
      this.deps.onText(transcriptOf(event));
    };
    recognition.onerror = ({ error }) => {
      if (generation !== this.generation) return;
      problem = liveProblem(error, source.platform) ?? problem;
    };
    recognition.onend = () => {
      if (generation !== this.generation) return;
      this.finish(problem ? { phase: "error", error: problem } : idle);
    };
    this.recognition = recognition;
    this.deps.onStart();
    this.update({ phase: "listening" });
    try {
      recognition.start();
    } catch {
      this.finish({
        phase: "error",
        error: "Dictation couldn't start. Try again.",
      });
    }
  };

  /** Stop listening and keep the words, including the last ones still on their way. */
  stop = () => {
    if (this.state.phase === "preparing") {
      this.release();
      return;
    }
    if (this.state.phase !== "listening" || !this.recognition) return;
    this.update({ phase: "stopping" });
    const generation = this.generation;
    this.recognition.stop();
    this.grace = setTimeout(() => {
      if (generation === this.generation) this.release();
    }, STOP_GRACE_MS);
  };

  /** Stop at once and take no more words. What is in the box stays. */
  release = () => {
    this.generation++;
    clearTimeout(this.grace);
    const recognition = this.recognition;
    this.recognition = undefined;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.abort();
    }
    if (this.state.phase !== "idle") this.update(idle);
  };

  private finish(state: LiveState) {
    this.generation++;
    clearTimeout(this.grace);
    this.recognition = undefined;
    this.update(state);
  }

  /**
   * The desktop app's answer for the language. The first time, it puts the system's microphone and
   * speech recognition questions to the person and answers `downloading` until they have answered.
   */
  private async permission(
    source: LiveSource,
    language: string,
    generation: number,
  ): Promise<boolean> {
    const available = (
      source.Recognition as unknown as { available?: Availability }
    ).available;
    if (typeof available !== "function") return true;
    const wait =
      this.deps.wait ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const asked = Date.now();
    for (;;) {
      let answer: unknown;
      try {
        answer = await available({ langs: [language], processLocally: true });
      } catch {
        answer = "unsupported";
      }
      if (generation !== this.generation) return false;
      if (answer === "available") return true;
      if (answer !== "downloading") {
        this.update({
          phase: "error",
          error:
            answer === "unavailable"
              ? "This computer can't take dictation in your language."
              : "Dictation isn't available on this computer.",
        });
        return false;
      }
      if (Date.now() - asked > PERMISSION_WAIT_MS) {
        this.update({
          phase: "error",
          error:
            "OpenBot is still waiting for permission. Answer the system's question, then try again.",
        });
        return false;
      }
      if (this.state.phase !== "preparing") this.update({ phase: "preparing" });
      await wait(PERMISSION_POLL_MS);
      if (generation !== this.generation) return false;
    }
  }
}
