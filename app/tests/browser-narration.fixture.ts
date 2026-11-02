import type { Recognition } from "@/lib/browser/narration";
import {
  everyLanguage,
  type OnDeviceModel,
  withOnDevice,
} from "./on-device-speech.fixture";

/**
 * WHAT CHROME'S SPEECH RECOGNITION REALLY SENDS, recorded rather than imagined.
 *
 * Captured on 2026-10-21 from Google Chrome 156.0.8078.47 (headless, macOS) running `webkitSpeechRecognition` with
 * `continuous` and `interimResults` on, `lang` en-US, every event logged with its milliseconds since the page started
 * listening. The voice was macOS `say` reading "I am opening the expenses page. [2.5 s pause] Now I add the receipt
 * from the taxi ride.", played into the recognition as a MediaStreamTrack, so no microphone was involved. Each result
 * is [transcript, isFinal, confidence], as `results[i][0]` and `results[i].isFinal` gave them.
 *
 * TWO_PHRASES is the whole run. STOPPED_MID_PHRASE is the first sentence again with `stop()` called before Chrome had
 * finished it, which is what Stop does to a phrase in progress.
 */

export type ChromeEvent =
  | {
      type: "result";
      at: number;
      resultIndex: number;
      results: [transcript: string, isFinal: boolean, confidence: number][];
    }
  | { type: "error"; at: number; error: string }
  | { type: string; at: number };

export const TWO_PHRASES: ChromeEvent[] = [
  { type: "start", at: 210 },
  { type: "audiostart", at: 221 },
  { type: "soundstart", at: 861 },
  { type: "speechstart", at: 861 },
  {
    type: "result",
    at: 1161,
    resultIndex: 0,
    results: [["I am", false, 0.01]],
  },
  {
    type: "result",
    at: 1354,
    resultIndex: 0,
    results: [["I am open", false, 0.01]],
  },
  {
    type: "result",
    at: 1447,
    resultIndex: 0,
    results: [["I am opening", false, 0.01]],
  },
  {
    type: "result",
    at: 1567,
    resultIndex: 0,
    results: [["I am opening the", false, 0.01]],
  },
  {
    type: "result",
    at: 1690,
    resultIndex: 0,
    results: [
      ["I am", false, 0.9],
      [" opening the", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 1863,
    resultIndex: 0,
    results: [
      ["I am", false, 0.9],
      [" opening the EXP", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 2052,
    resultIndex: 0,
    results: [
      ["I am opening", false, 0.9],
      [" the EXP", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 2109,
    resultIndex: 0,
    results: [
      ["I am opening", false, 0.9],
      [" the expens", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 2198,
    resultIndex: 0,
    results: [
      ["I am opening the", false, 0.9],
      [" expens", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 2228,
    resultIndex: 0,
    results: [
      ["I am opening the", false, 0.9],
      [" expenses", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 2495,
    resultIndex: 0,
    results: [
      ["I am opening the", false, 0.9],
      [" expenses page", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 2812,
    resultIndex: 0,
    results: [
      ["I am opening the expenses", false, 0.9],
      [" page", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 3177,
    resultIndex: 0,
    results: [["I am opening the expenses page", true, 0.972]],
  },
  {
    type: "result",
    at: 5379,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 5677,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now I", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 5929,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now I add", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 6060,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now", false, 0.9],
      [" I add", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 6091,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now", false, 0.9],
      [" I add the", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 6278,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now", false, 0.9],
      [" I add the rece", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 6303,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now I", false, 0.9],
      [" add the receipt", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 6434,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now I", false, 0.9],
      [" add the receipt from", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 6488,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now I add", false, 0.9],
      [" the receipt from", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 6523,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now I add", false, 0.9],
      [" the receipt from the", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 6635,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now I add the", false, 0.9],
      [" receipt from the", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 6878,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now I add the receipt", false, 0.9],
      [" from the tax", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 6991,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now I add the receipt from", false, 0.9],
      [" the tax", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 7117,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now I add the receipt from the", false, 0.9],
      [" taxi", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 7265,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now I add the receipt from the", false, 0.9],
      [" taxi ride", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 7701,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now I add the receipt from the taxi", false, 0.9],
      [" ride", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 7919,
    resultIndex: 1,
    results: [
      ["I am opening the expenses page", true, 0.972],
      [" now I add the receipt from the taxi ride", true, 0.969],
    ],
  },
];

export const STOPPED_MID_PHRASE: ChromeEvent[] = [
  { type: "start", at: 212 },
  { type: "audiostart", at: 222 },
  { type: "soundstart", at: 862 },
  { type: "speechstart", at: 862 },
  {
    type: "result",
    at: 1089,
    resultIndex: 0,
    results: [["I am", false, 0.01]],
  },
  {
    type: "result",
    at: 1346,
    resultIndex: 0,
    results: [["I am open", false, 0.01]],
  },
  {
    type: "result",
    at: 1440,
    resultIndex: 0,
    results: [["I am opening", false, 0.01]],
  },
  {
    type: "result",
    at: 1554,
    resultIndex: 0,
    results: [["I am opening the", false, 0.01]],
  },
  {
    type: "result",
    at: 1683,
    resultIndex: 0,
    results: [
      ["I am", false, 0.9],
      [" opening the", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 1861,
    resultIndex: 0,
    results: [
      ["I am", false, 0.9],
      [" opening the EXP", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 2048,
    resultIndex: 0,
    results: [
      ["I am opening", false, 0.9],
      [" the EXP", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 2121,
    resultIndex: 0,
    results: [
      ["I am opening", false, 0.9],
      [" the expens", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 2174,
    resultIndex: 0,
    results: [
      ["I am opening the", false, 0.9],
      [" expens", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 2218,
    resultIndex: 0,
    results: [
      ["I am opening the", false, 0.9],
      [" expenses", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 2496,
    resultIndex: 0,
    results: [
      ["I am opening the", false, 0.9],
      [" expenses page", false, 0.01],
    ],
  },
  { type: "stop", at: 2726 },
  { type: "speechend", at: 2726 },
  { type: "soundend", at: 2727 },
  { type: "audioend", at: 2727 },
  {
    type: "result",
    at: 2764,
    resultIndex: 0,
    results: [
      ["I am opening the expenses", false, 0.9],
      [" page", false, 0.01],
    ],
  },
  {
    type: "result",
    at: 2779,
    resultIndex: 0,
    results: [["I am opening the expenses page", true, 0.972]],
  },
  { type: "end", at: 2779 },
];

/**
 * A recorded result as the `SpeechRecognitionEvent` Chrome dispatched: a result list that is not an array but answers
 * `length`, an index and `item()`, each result the same with its alternatives.
 */
export function speechEvent(
  event: Extract<ChromeEvent, { type: "result" }>,
): SpeechEventShape {
  const results = event.results.map(([transcript, isFinal, confidence]) => {
    const alternative = { transcript, confidence };
    return {
      isFinal,
      length: 1,
      0: alternative,
      item: (index: number) => (index === 0 ? alternative : null),
    };
  });
  return {
    resultIndex: event.resultIndex,
    results: Object.assign(
      {
        length: results.length,
        item: (index: number) => results[index] ?? null,
      },
      results,
    ),
  };
}

export type SpeechEventShape = {
  resultIndex: number;
  results: {
    length: number;
    item(index: number): unknown;
    [index: number]: {
      isFinal: boolean;
      length: number;
      0: { transcript: string; confidence: number };
    };
  };
};

export const isResult = (
  event: ChromeEvent,
): event is Extract<ChromeEvent, { type: "result" }> => event.type === "result";

/**
 * Chrome's speech recognition, as `SpeechRecognition` and `webkitSpeechRecognition`: once listening it sends what Chrome
 * sent in the recorded run up to the moment Stop was pressed, and on stop() what it sent after, the final phrase then
 * the end. One stopped before it heard anything (as strict mode's first, discarded effect is) just ends, as Chrome's
 * does. Shared by every page that narrates a recording: the Browser page and a Bot's screen.
 *
 * `onDevice` is what it can recognise on the computer (on-device-speech.fixture.ts): every language unless a test
 * says, or null for a Chrome with no on-device recognition at all.
 */
export function installChrome(
  onDevice: OnDeviceModel | null = everyLanguage(),
) {
  const recognitions: ChromeRecognition[] = [];
  const stopAt =
    STOPPED_MID_PHRASE.find((event) => event.type === "stop")?.at ?? 0;
  const before = STOPPED_MID_PHRASE.filter(isResult).filter(
    (event) => event.at < stopAt,
  );
  const after = STOPPED_MID_PHRASE.filter(isResult).filter(
    (event) => event.at > stopAt,
  );
  class ChromeRecognition implements Recognition {
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 0;
    onstart: Recognition["onstart"] = null;
    onresult: Recognition["onresult"] = null;
    onerror: Recognition["onerror"] = null;
    onend: Recognition["onend"] = null;
    processLocally?: boolean;
    started = false;
    heard = false;
    #listening: ReturnType<typeof setTimeout> | undefined;
    constructor() {
      recognitions.push(this);
    }
    start() {
      this.started = true;
      this.#listening = setTimeout(() => {
        this.onstart?.();
        for (const event of before) this.onresult?.(speechEvent(event));
        this.heard = true;
      }, 0);
    }
    stop() {
      clearTimeout(this.#listening);
      queueMicrotask(() => {
        if (this.heard)
          for (const event of after) this.onresult?.(speechEvent(event));
        this.onend?.();
      });
    }
    abort() {
      clearTimeout(this.#listening);
      queueMicrotask(() => this.onend?.());
    }
  }
  const speech = globalThis as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  // Chrome answers to both names, with the same recognition; its on-device side is on it (on-device-speech.fixture.ts).
  speech.SpeechRecognition = speech.webkitSpeechRecognition = onDevice
    ? withOnDevice(ChromeRecognition, onDevice)
    : ChromeRecognition;
  return recognitions;
}
