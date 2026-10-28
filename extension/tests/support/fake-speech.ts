import type { RecognitionLike } from "../../src/offscreen/voice";

export type FakeTrack = {
  readyState: "live" | "ended";
  onended: (() => void) | null;
  stop(): void;
};

type SpeechOptions = { langs: string[]; processLocally?: boolean };

/**
 * On-device recognition as Chrome implements it (the Web Speech API's `available()`, `install()` and `processLocally`:
 * https://webaudio.github.io/web-speech-api/), for one origin:
 * - `available()` with `processLocally` answers `unavailable` for a language the computer cannot recognise, and
 *   `downloadable` for any other until this origin has asked for it with `install()` (the specification's download
 *   masking), then `available`, `downloading` or `downloadable` as the language really is.
 * - `install()` that would start a download is refused (`NotAllowedError`) without the person's click (`activation`);
 *   otherwise it unmasks the language and resolves true once it is on the computer (at once when it already was, else
 *   when the test calls `finishDownloads`).
 * - A recognition started with `processLocally` in a language that is not available fails with
 *   `language-not-supported` and, as Chromium 151 does, never ends.
 */
export type OnDeviceModel = {
  /** Each language this computer can recognise on the device, and whether it is downloaded. */
  languages: Map<string, "installed" | "downloadable" | "downloading">;
  /** Languages this origin asked for with install(), so their real state shows. */
  unmasked: Set<string>;
  /** Whether a call now carries the person's click. */
  activation: boolean;
  /** Every install() asked, in order. */
  installs: string[];
  finishDownloads(): void;
};

export function onDeviceModel(
  languages: Record<string, "installed" | "downloadable" | "downloading"> = {},
  options: { unmasked?: boolean } = {},
): OnDeviceModel {
  const model: OnDeviceModel = {
    languages: new Map(Object.entries(languages)),
    unmasked: new Set(options.unmasked ? Object.keys(languages) : []),
    activation: false,
    installs: [],
    finishDownloads() {
      for (const [language, state] of model.languages)
        if (state === "downloading") model.languages.set(language, "installed");
    },
  };
  return model;
}

/** The status `available()` answers for one language, by the model. A model with a `*` language has every language in
 * that state. */
function availability(model: OnDeviceModel, language: string) {
  const state = model.languages.get(language) ?? model.languages.get("*");
  if (state === undefined) return "unavailable";
  if (!model.unmasked.has(language) && !model.unmasked.has("*"))
    return "downloadable";
  return state === "installed" ? "available" : state;
}

/** A fresh SpeechRecognition double per test: every instance it made, and what Chrome would do to them. Without an
 * on-device model it is a browser with no on-device recognition at all (no `available`, `install` or `processLocally`). */
export function fakeSpeech(
  /** By default, a person who downloaded every language they narrate in (the setup page asks once). */
  onDevice: OnDeviceModel | null = onDeviceModel(
    { "*": "installed" },
    { unmasked: true },
  ),
) {
  const instances: FakeRecognition[] = [];
  const downloads: (() => void)[] = [];
  class FakeRecognition implements RecognitionLike {
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 0;
    processLocally?: boolean;
    onstart: (() => void) | null = null;
    onresult: RecognitionLike["onresult"] = null;
    onerror: RecognitionLike["onerror"] = null;
    onend: (() => void) | null = null;
    onspeechstart: (() => void) | null = null;
    onsoundstart: (() => void) | null = null;
    track: MediaStreamTrack | undefined;
    started = false;
    stops = 0;
    aborts = 0;
    constructor() {
      instances.push(this);
    }
    start(track?: MediaStreamTrack) {
      this.track = track;
      this.started = true;
      if (
        onDevice &&
        this.processLocally === true &&
        availability(onDevice, this.lang) !== "available"
      )
        queueMicrotask(() =>
          this.onerror?.({ error: "language-not-supported" }),
        );
    }
    stop() {
      this.stops++;
    }
    abort() {
      this.aborts++;
    }
    // What Chrome does:
    begin() {
      this.onstart?.();
    }
    hearSpeech() {
      this.onsoundstart?.();
      this.onspeechstart?.();
    }
    say(results: [string, boolean][], resultIndex = 0) {
      this.onresult?.({
        resultIndex,
        results: results.map(([transcript, isFinal]) => ({
          isFinal,
          length: 1,
          0: { transcript },
        })),
      });
    }
    error(error: string) {
      this.onerror?.({ error });
    }
    end() {
      this.onend?.();
    }
  }
  if (onDevice) {
    Object.defineProperty(FakeRecognition.prototype, "processLocally", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    Object.assign(FakeRecognition, {
      async available(options: SpeechOptions) {
        if (options.processLocally !== true)
          return options.langs.length > 0 ? "available" : "unavailable";
        if (options.langs.length === 0) return "unavailable";
        const each = options.langs.map((lang) => availability(onDevice, lang));
        for (const status of [
          "unavailable",
          "downloadable",
          "downloading",
        ] as const)
          if (each.includes(status)) return status;
        return "available";
      },
      async install(options: SpeechOptions) {
        onDevice.installs.push(...options.langs);
        const wouldDownload = options.langs.some(
          (lang) => availability(onDevice, lang) === "downloadable",
        );
        if (wouldDownload && !onDevice.activation)
          throw Object.assign(new Error("Requires a user gesture."), {
            name: "NotAllowedError",
          });
        // The click is used up by the call.
        onDevice.activation = false;
        if (
          options.langs.some(
            (lang) => availability(onDevice, lang) === "unavailable",
          )
        )
          return false;
        for (const lang of options.langs) {
          onDevice.unmasked.add(lang);
          const state =
            onDevice.languages.get(lang) ?? onDevice.languages.get("*");
          if (state === "downloadable")
            onDevice.languages.set(lang, "downloading");
        }
        if (
          options.langs.every(
            (lang) => availability(onDevice, lang) === "available",
          )
        )
          return true;
        return new Promise<boolean>((resolve) => {
          downloads.push(() => resolve(true));
        });
      },
    });
    const finish = onDevice.finishDownloads;
    onDevice.finishDownloads = () => {
      finish();
      for (const done of downloads.splice(0)) done();
    };
  }
  return { Recognition: FakeRecognition, instances };
}

/** A microphone getUserMedia double: every stream it opened, as one live track each. */
export function fakeMicrophone(
  before?: (constraints: MediaStreamConstraints) => Promise<void>,
) {
  const tracks: FakeTrack[] = [];
  const constraints: MediaStreamConstraints[] = [];
  return {
    tracks,
    constraints,
    getUserMedia: async (asked: MediaStreamConstraints) => {
      constraints.push(asked);
      await before?.(asked);
      const track: FakeTrack = {
        readyState: "live",
        onended: null,
        stop() {
          this.readyState = "ended";
        },
      };
      tracks.push(track);
      return {
        getTracks: () => [track],
        getAudioTracks: () => [track],
      } as unknown as MediaStream;
    },
  };
}
