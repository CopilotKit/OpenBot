/*
 * SPEECH RECOGNITION ON THE PERSON'S OWN COMPUTER, OR NONE. Chrome's Web Speech API sends the microphone's audio to a
 * speech service by default; a recognition only stays on the device when it sets `processLocally`, which makes on-device
 * recognition a requirement rather than a preference: https://developer.mozilla.org/docs/Web/API/SpeechRecognition/processLocally
 * Narration, in the Recorder (extension/src/offscreen/voice.ts) and in OpenBot's own page (app/src/lib/browser/narration.ts),
 * always sets it, and asks first whether this browser can do it for the narration's language:
 *
 * - `SpeechRecognition.available({ langs, processLocally: true })` answers `available`, `downloading`, `downloadable`
 *   or `unavailable` (https://developer.mozilla.org/docs/Web/API/SpeechRecognition/available_static). Until the page's
 *   own origin has asked for a language with `install()`, the browser answers `downloadable` even when the language is on
 *   the computer, and a recognition that starts anyway is refused; the specification masks it so no site can tell what
 *   another installed (https://webaudio.github.io/web-speech-api/#on-device-model-privacy-availability-masking).
 * - `SpeechRecognition.install({ langs, processLocally: true })` downloads a language, or unmasks one already there. It
 *   needs the person's click when it would start a download (it is refused without one), so it is only ever called from
 *   a click: https://developer.mozilla.org/docs/Web/API/SpeechRecognition/install_static
 *
 * A browser without these (an older Chrome, a Chromium without on-device recognition, Firefox) cannot keep speech on the
 * device, so narration is off there, and the page says why.
 *
 * No `quality` is asked for (https://webaudio.github.io/web-speech-api/#enumdef-speechrecognitionquality): Chromium 151
 * answered `unavailable` for `dictation` where its default, `command`, was `downloadable` (asked on 2026-10-27), so
 * asking for dictation would turn narration off where the device can transcribe it. `available()` and `install()` are
 * asked with the same options, because the browser unmasks a language for exactly the options it was installed with.
 */

export type OnDeviceSpeech =
  /** Recognition of the language runs on this computer. */
  | "available"
  /** The language is being downloaded to this computer. */
  | "downloading"
  /** The language can run on this computer once it is downloaded (or unmasked), which takes the person's click. */
  | "downloadable"
  /** This computer cannot recognise the language on the device. */
  | "unavailable"
  /** This browser cannot keep recognition on the device at all. */
  | "unsupported";

type SpeechOptions = {
  langs: string[];
  processLocally: true;
};

/** The static side of `SpeechRecognition` that on-device recognition adds. */
type OnDeviceStatics = {
  available?: (options: SpeechOptions) => Promise<unknown>;
  install?: (options: SpeechOptions) => Promise<unknown>;
  prototype?: unknown;
};

const STATUSES = new Set<string>([
  "available",
  "downloading",
  "downloadable",
  "unavailable",
]);

const optionsFor = (language: string): SpeechOptions => ({
  langs: [language],
  processLocally: true,
});

/** Whether `Recognition` can be made to keep speech on the device: it has `available()`, `install()` and
 * `processLocally`. */
export function canRecogniseOnDevice(Recognition: unknown): boolean {
  if (typeof Recognition !== "function") return false;
  const statics = Recognition as OnDeviceStatics;
  const prototype = statics.prototype;
  return (
    typeof statics.available === "function" &&
    typeof statics.install === "function" &&
    typeof prototype === "object" &&
    prototype !== null &&
    "processLocally" in prototype
  );
}

/** Whether `language` can be recognised on this computer, as the browser answers `available()`. A refusal to answer (a
 * malformed language, a policy that blocks the feature) is `unavailable`. */
export async function onDeviceSpeech(
  Recognition: unknown,
  language: string,
): Promise<OnDeviceSpeech> {
  if (!canRecogniseOnDevice(Recognition)) return "unsupported";
  try {
    const status = await (Recognition as OnDeviceStatics).available?.(
      optionsFor(language),
    );
    return typeof status === "string" && STATUSES.has(status)
      ? (status as OnDeviceSpeech)
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * Downloads `language` for on-device recognition, or unmasks it when it is already on the computer. Call it only from the
 * person's click, synchronously in the handler or close after it: the browser refuses a download started without one.
 * Resolves whether the language is ready; never rejects. The download can take a while, so a caller that has more to do
 * does not wait for it: narration asks `available()` again until it is done.
 */
export async function installOnDeviceSpeech(
  Recognition: unknown,
  language: string,
): Promise<boolean> {
  if (!canRecogniseOnDevice(Recognition)) return false;
  try {
    return (
      (await (Recognition as OnDeviceStatics).install?.(
        optionsFor(language),
      )) === true
    );
  } catch {
    return false;
  }
}

/** Sets a recognition to keep speech on the device. */
export function keepOnDevice(recognition: object): void {
  (recognition as { processLocally?: boolean }).processLocally = true;
}
