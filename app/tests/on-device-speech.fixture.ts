/**
 * ON-DEVICE SPEECH RECOGNITION AS CHROME IMPLEMENTS IT, for the page's speech recognition doubles: the Web Speech API's
 * `available()`, `install()` and `processLocally` (https://webaudio.github.io/web-speech-api/), for one origin, as the
 * specification has them and as Chromium 151 answered `available()` and `start()` when asked on 2026-10-27 (it never
 * answered an `install()` without a click, which the specification refuses):
 * - `available()` with `processLocally` answers `unavailable` for a language the computer cannot recognise, and
 *   `downloadable` for any other until this origin asked for it with `install()` (the specification's download
 *   masking), then `available`, `downloading` or `downloadable` as the language really is.
 * - `install()` that would start a download is refused (`NotAllowedError`) without the person's click (`activation`);
 *   otherwise it unmasks the language and resolves true once it is on the computer (at once when it already was, else
 *   when the test calls `finishDownloads`).
 * - A recognition started with `processLocally` in a language that is not available fails with `language-not-supported`
 *   and never ends.
 */

export type OnDeviceModel = {
  /** Each language this computer can recognise on the device and whether it is downloaded; `*` stands for any other. */
  languages: Map<string, "installed" | "downloadable" | "downloading">;
  /** Languages this origin asked for with install(), so their real state shows; `*` for every one. */
  unmasked: Set<string>;
  /** Whether a call now carries the person's click. */
  activation: boolean;
  /** Every install() asked, in order. */
  installs: string[];
  finishDownloads(): void;
};

export function onDeviceModel(
  languages: Record<string, "installed" | "downloadable" | "downloading">,
  options: { unmasked?: boolean } = {},
): OnDeviceModel {
  const downloads: (() => void)[] = [];
  const model: OnDeviceModel & { downloads: (() => void)[] } = {
    languages: new Map(Object.entries(languages)),
    unmasked: new Set(options.unmasked ? Object.keys(languages) : []),
    activation: false,
    installs: [],
    downloads,
    finishDownloads() {
      for (const [language, state] of model.languages)
        if (state === "downloading") model.languages.set(language, "installed");
      for (const done of downloads.splice(0)) done();
    },
  };
  return model;
}

/** A person who downloaded every language they narrate in. */
export const everyLanguage = () =>
  onDeviceModel({ "*": "installed" }, { unmasked: true });

function stateOf(model: OnDeviceModel, language: string) {
  return model.languages.get(language) ?? model.languages.get("*");
}

/** What `available()` answers for one language. */
export function availability(model: OnDeviceModel, language: string) {
  const state = stateOf(model, language);
  if (state === undefined) return "unavailable";
  if (!model.unmasked.has(language) && !model.unmasked.has("*"))
    return "downloadable";
  return state === "installed" ? "available" : state;
}

type Options = { langs: string[]; processLocally?: boolean };

/**
 * Gives a SpeechRecognition double Chrome's on-device side: the static `available()` and `install()`, and
 * `processLocally` on its instances, which a recognition `start()`ed in a language not on the computer fails.
 */
export function withOnDevice<
  T extends new (
    ...args: never[]
  ) => {
    lang: string;
    start(...args: never[]): void;
    onerror: ((event: { error: string }) => void) | null;
  },
>(Recognition: T, model: OnDeviceModel): T {
  const start = Recognition.prototype.start;
  Object.defineProperty(Recognition.prototype, "processLocally", {
    value: false,
    writable: true,
    configurable: true,
  });
  Recognition.prototype.start = function (
    this: InstanceType<T> & { processLocally?: boolean },
    ...args: never[]
  ) {
    start.apply(this, args);
    if (this.processLocally && availability(model, this.lang) !== "available")
      queueMicrotask(() => this.onerror?.({ error: "language-not-supported" }));
  };
  const downloads = (model as unknown as { downloads: (() => void)[] })
    .downloads;
  Object.assign(Recognition, {
    async available(options: Options) {
      if (options.processLocally !== true)
        return options.langs.length > 0 ? "available" : "unavailable";
      if (options.langs.length === 0) return "unavailable";
      const each = options.langs.map((lang) => availability(model, lang));
      for (const status of [
        "unavailable",
        "downloadable",
        "downloading",
      ] as const)
        if (each.includes(status)) return status;
      return "available";
    },
    async install(options: Options) {
      model.installs.push(...options.langs);
      const wouldDownload = options.langs.some(
        (lang) => availability(model, lang) === "downloadable",
      );
      if (wouldDownload && !model.activation)
        throw Object.assign(new Error("Requires a user gesture."), {
          name: "NotAllowedError",
        });
      // The click is used up by the call.
      model.activation = false;
      if (
        options.langs.some(
          (lang) => availability(model, lang) === "unavailable",
        )
      )
        return false;
      for (const lang of options.langs) {
        model.unmasked.add(lang);
        if (stateOf(model, lang) === "downloadable")
          model.languages.set(lang, "downloading");
      }
      if (
        options.langs.every((lang) => availability(model, lang) === "available")
      )
        return true;
      return new Promise<boolean>((resolve) => {
        downloads.push(() => resolve(true));
      });
    },
  });
  return Recognition;
}
