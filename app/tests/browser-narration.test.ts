import { describe, expect, test } from "bun:test";
import { installOnDeviceSpeech } from "@openbot/shared/on-device-speech";
import {
  DOWNLOAD_POLL_MS,
  FLUSH_MS,
  type NarrationStatus,
  type Phrase,
  PhraseClock,
  type Recognition,
  type RecognitionResultEvent,
  speechRecognition,
  startNarration,
} from "@/lib/browser/narration";
import {
  type ChromeEvent,
  isResult,
  STOPPED_MID_PHRASE,
  speechEvent,
  TWO_PHRASES,
} from "./browser-narration.fixture";
import {
  everyLanguage,
  type OnDeviceModel,
  onDeviceModel,
  withOnDevice,
} from "./on-device-speech.fixture";

/**
 * Narration on hosted OpenBot: the page transcribes the person with the browser's own speech recognition and stamps
 * each final phrase with when they started and stopped saying it. The rule is pinned against what Chrome 156 really
 * sent in a recorded run (browser-narration.fixture.ts), not against events written by hand.
 */

/** When the page started listening in each replay: an epoch millisecond, as Date.now() gives. */
const START = 1_792_000_000_000;

describe("when a phrase was said", () => {
  test("each phrase runs from its first words coming back to the moment it came back final", async () => {
    const clock = new PhraseClock();
    const phrases = TWO_PHRASES.filter(isResult).flatMap((event) =>
      clock.heard(speechEvent(event), START + event.at),
    );
    expect(phrases).toEqual([
      {
        text: "I am opening the expenses page",
        startedAt: START + 1_161,
        endedAt: START + 3_177,
      },
      {
        // Chrome's final text leads with a space; the phrase is what was said.
        text: "now I add the receipt from the taxi ride",
        startedAt: START + 5_379,
        endedAt: START + 7_919,
      },
    ]);
  });

  test("the second phrase starts at its own first words, not when the first phrase's changing tail used its slot", async () => {
    // In the real run Chrome showed the first sentence's tail at index 1 from 1690 ms, folded it back in at 3177 ms,
    // and only at 5379 ms put the second sentence's first word ("now") there. Keeping index 1's first sighting would
    // start the second phrase 3.7 s before it was said; holding it to the end of the first would still start it 2.2 s
    // early, in the pause, where the person's clicks would read as said during it.
    const clock = new PhraseClock();
    const second = TWO_PHRASES.filter(isResult)
      .flatMap((event) => clock.heard(speechEvent(event), START + event.at))
      .at(1);
    expect(second?.startedAt).toBe(START + 5_379);
    expect(second?.startedAt).not.toBe(START + 1_690);
    expect(second?.startedAt).not.toBe(START + 3_177);
  });

  test("a final phrase Chrome repeats in every later event is sent once", async () => {
    const clock = new PhraseClock();
    const results = TWO_PHRASES.filter(isResult);
    const sent = results.flatMap((event) =>
      clock.heard(speechEvent(event), START + event.at),
    );
    // Every event after 3177 ms repeats the first sentence as final.
    expect(
      results.filter(
        (event) =>
          event.results[0]?.[1] === true &&
          event.at > 3_177 &&
          event.at < 7_919,
      ).length,
    ).toBeGreaterThan(10);
    expect(
      sent.filter((phrase) => phrase.text.startsWith("I am opening")),
    ).toHaveLength(1);
  });

  test("a phrase is never stamped as starting before the one ahead of it ended", async () => {
    const clock = new PhraseClock();
    // A second result shows up while the first is still being finished, then both come back final.
    clock.heard(speechEvent(result(0, [["I am opening", false]])), START + 100);
    clock.heard(
      speechEvent(
        result(0, [
          ["I am opening the page", false],
          [" and", false],
        ]),
      ),
      START + 200,
    );
    const phrases = clock.heard(
      speechEvent(
        result(0, [
          ["I am opening the page", true],
          [" and then the form", true],
        ]),
      ),
      START + 900,
    );
    expect(phrases).toEqual([
      {
        text: "I am opening the page",
        startedAt: START + 100,
        endedAt: START + 900,
      },
      {
        text: "and then the form",
        startedAt: START + 900,
        endedAt: START + 900,
      },
    ]);
  });

  test("a new recognition numbers its results from 0 again and its phrases are timed afresh", async () => {
    const clock = new PhraseClock();
    clock.heard(speechEvent(result(0, [["first", false]])), START + 100);
    clock.heard(speechEvent(result(0, [["first", true]])), START + 500);
    clock.restart();
    clock.heard(speechEvent(result(0, [["second", false]])), START + 4_000);
    expect(
      clock.heard(speechEvent(result(0, [["second", true]])), START + 4_600),
    ).toEqual([
      { text: "second", startedAt: START + 4_000, endedAt: START + 4_600 },
    ]);
  });
});

describe("when a phrase is being said", () => {
  test("is the phrase's start as its first words come back, and nothing once it came back final, in a real run", async () => {
    const s = await setup();
    s.replay(TWO_PHRASES);
    // The Recorder holds the person's steps from the moment each phrase began until the phrase arrives: the moment it is
    // told is the start the phrase is stamped with, so a click made as they began to speak waits for the phrase.
    expect(s.told).toEqual([
      { speaking: START + 1_161 },
      { phrase: "I am opening the expenses page" },
      { speaking: null },
      { speaking: START + 5_379 },
      { phrase: "now I add the receipt from the taxi ride" },
      { speaking: null },
    ]);
    expect(s.phrases.map((phrase) => phrase.startedAt)).toEqual([
      START + 1_161,
      START + 5_379,
    ]);
  });

  test("is told the moment the first words come back, long before the phrase is final", async () => {
    const s = await setup();
    const first = TWO_PHRASES.filter(isResult)[0];
    if (!first) throw new Error("The fixture has no result.");
    s.replay(TWO_PHRASES.filter((event) => event.at <= first.at));
    expect(s.told).toEqual([{ speaking: START + first.at }]);
    expect(s.phrases).toEqual([]);
  });

  test("Stop hands over the phrase being said, then says nothing more is", async () => {
    const s = await setup();
    const stopAt =
      STOPPED_MID_PHRASE.find((event) => event.type === "stop")?.at ?? 0;
    s.replay(STOPPED_MID_PHRASE.filter((event) => event.at < stopAt));
    expect(s.told).toEqual([{ speaking: START + 1_089 }]);
    const stopping = s.narration.stop();
    s.replay(
      STOPPED_MID_PHRASE.filter(
        (event) => event.type !== "stop" && event.at > stopAt,
      ),
    );
    await stopping;
    expect(s.told).toEqual([
      { speaking: START + 1_089 },
      { phrase: "I am opening the expenses page" },
      { speaking: null },
    ]);
  });

  test("ends with no phrase when Chrome returns no words for it, ends listening, or the person mutes", async () => {
    const s = await setup();
    s.at(1_000);
    s.current().onresult?.(speechEvent(result(0, [["", false]])));
    s.at(1_400);
    s.current().onresult?.(speechEvent(result(0, [["", true]])));
    expect(s.told).toEqual([{ speaking: START + 1_000 }, { speaking: null }]);

    // Chrome ends the recognition with a phrase still unfinished: it never comes.
    s.at(2_000);
    s.current().onresult?.(
      speechEvent(
        result(1, [
          ["", true],
          ["um", false],
        ]),
      ),
    );
    s.current().onend?.();
    expect(s.told.slice(2)).toEqual([
      { speaking: START + 2_000 },
      { speaking: null },
    ]);

    // Muted mid-phrase: the phrase is handed over if it comes, and nothing is being said after.
    s.advance(0);
    s.at(70_000);
    s.current().onresult?.(speechEvent(result(0, [["and then", false]])));
    s.narration.mute(true);
    expect(s.told.at(-1)).toEqual({ speaking: START + 70_000 });
    s.current().onend?.();
    expect(s.told.slice(4)).toEqual([
      { speaking: START + 70_000 },
      { speaking: null },
    ]);
    expect(s.phrases).toEqual([]);
  });
});

describe("the browser's speech recognition", () => {
  test("is the standard one, else the webkit one Chrome and Safari answer to, else none (Firefox)", async () => {
    class Standard {}
    class Webkit {}
    expect(speechRecognition({ SpeechRecognition: Standard })).toBe(
      Standard as never,
    );
    expect(speechRecognition({ webkitSpeechRecognition: Webkit })).toBe(
      Webkit as never,
    );
    expect(speechRecognition({})).toBeNull();
  });
});

describe("listening while a recording runs", () => {
  test("listens continuously with interim results, and sends every final phrase of a real run with its timing", async () => {
    const s = await setup();
    const recognition = s.recognitions[0];
    expect(recognition).toMatchObject({
      lang: "en-GB",
      continuous: true,
      interimResults: true,
      // On the person's computer or not at all: without it Chrome streams the audio to its speech service.
      processLocally: true,
      started: true,
    });
    s.replay(TWO_PHRASES);
    expect(s.phrases).toEqual([
      {
        text: "I am opening the expenses page",
        startedAt: START + 1_161,
        endedAt: START + 3_177,
      },
      {
        text: "now I add the receipt from the taxi ride",
        startedAt: START + 5_379,
        endedAt: START + 7_919,
      },
    ]);
    expect(s.statuses).toEqual([{ state: "starting" }, { state: "listening" }]);
  });

  test("Stop hands over the phrase being said before listening ends", async () => {
    const s = await setup();
    const recognition = s.current();
    const beforeStop = STOPPED_MID_PHRASE.filter(
      (event) =>
        event.at <
        (STOPPED_MID_PHRASE.find((each) => each.type === "stop")?.at ?? 0),
    );
    s.replay(beforeStop);
    expect(s.phrases).toEqual([]);
    let stopped = false;
    const stopping = s.narration.stop().then(() => {
      stopped = true;
    });
    expect(recognition.stops).toBe(1);
    expect(recognition.aborts).toBe(0);
    // What Chrome sent after stop() in the real run: the phrase, final, then the end.
    s.replay(
      STOPPED_MID_PHRASE.filter(
        (event) => event.type !== "stop" && !beforeStop.includes(event),
      ),
    );
    await stopping;
    expect(stopped).toBe(true);
    expect(s.phrases).toEqual([
      {
        text: "I am opening the expenses page",
        startedAt: START + 1_089,
        endedAt: START + 2_779,
      },
    ]);
    // Nothing is sent or restarted after it.
    expect(s.recognitions).toHaveLength(1);
  });

  test("Stop does not wait for ever on a speech service that never answers", async () => {
    const s = await setup();
    const stopping = s.narration.stop();
    s.advance(FLUSH_MS);
    await stopping;
    expect(s.current().aborts).toBe(1);
  });

  test("a recognition Chrome ends on its own is replaced, sooner or later depending on how long it lasted", async () => {
    const s = await setup();
    // It ran for a minute and Chrome ended it, as it does after a silence: listening again at once.
    s.at(60_000);
    s.current().onend?.();
    s.advance(0);
    expect(s.recognitions).toHaveLength(2);
    // One that ends at once is not restarted in a tight loop.
    s.current().onend?.();
    s.advance(0);
    expect(s.recognitions).toHaveLength(2);
    s.advance(500);
    expect(s.recognitions).toHaveLength(3);
  });

  test("a refused microphone stops narration, says why, and turning it on again tries again", async () => {
    const s = await setup();
    s.current().onerror?.({ error: "not-allowed" });
    s.current().onend?.();
    s.advance(60_000);
    expect(s.recognitions).toHaveLength(1);
    expect(s.statuses.at(-1)).toEqual({
      state: "failed",
      problem: "not-allowed",
    });
    s.narration.mute(false);
    await s.settle();
    expect(s.recognitions).toHaveLength(2);
    expect(s.current().started).toBe(true);
  });

  test("an unreachable speech service is retried by itself with a growing delay", async () => {
    const s = await setup();
    s.current().onerror?.({ error: "network" });
    s.current().onend?.();
    expect(s.statuses.at(-1)).toEqual({ state: "failed", problem: "network" });
    s.advance(1_999);
    expect(s.recognitions).toHaveLength(1);
    s.advance(1);
    expect(s.recognitions).toHaveLength(2);
  });

  test("muting ends listening after the phrase being said; unmuting listens again", async () => {
    const s = await setup();
    const first = s.current();
    s.narration.mute(true);
    expect(first.stops).toBe(1);
    expect(s.statuses.at(-1)).toEqual({ state: "muted" });
    first.onresult?.(speechEvent(result(0, [["the last words", true]])));
    first.onend?.();
    s.advance(60_000);
    expect(s.phrases.map((phrase) => phrase.text)).toEqual(["the last words"]);
    expect(s.recognitions).toHaveLength(1);
    s.narration.mute(false);
    await s.settle();
    expect(s.recognitions).toHaveLength(2);
  });

  test("a browser that cannot keep speech on the computer never listens, and says why", async () => {
    const s = await setup({ onDevice: null });
    expect(s.recognitions).toHaveLength(0);
    expect(s.statuses.at(-1)).toEqual({
      state: "failed",
      problem: "on-device",
    });
  });

  test("a language the computer cannot recognise on the device never listens", async () => {
    const s = await setup({
      language: "cy-GB",
      onDevice: onDeviceModel({ "en-GB": "installed" }, { unmasked: true }),
    });
    expect(s.recognitions).toHaveLength(0);
    expect(s.statuses.at(-1)).toEqual({ state: "failed", problem: "language" });
  });

  test("a language to be downloaded waits for the person's click, then for the download, then listens", async () => {
    // Chrome answers downloadable for a language the page has not asked for, even when it is on the computer.
    const s = await setup({
      onDevice: onDeviceModel({ "en-GB": "downloadable" }),
    });
    expect(s.recognitions).toHaveLength(0);
    expect(s.statuses.at(-1)).toEqual({
      state: "failed",
      problem: "speech-pack",
    });
    // The person turns narration on: their click asks the browser for it (use-narration.ts), and narration waits for
    // the download.
    const model = s.onDevice as OnDeviceModel;
    model.activation = true;
    void installOnDeviceSpeech(s.Recognition, "en-GB");
    expect(model.installs).toEqual(["en-GB"]);
    s.narration.mute(false);
    await s.settle();
    expect(s.statuses.at(-1)).toEqual({ state: "downloading" });
    expect(s.recognitions).toHaveLength(0);
    s.advance(DOWNLOAD_POLL_MS);
    await s.settle();
    expect(s.recognitions).toHaveLength(0);
    model.finishDownloads();
    s.advance(DOWNLOAD_POLL_MS);
    await s.settle();
    expect(s.recognitions).toHaveLength(1);
    expect(s.current().processLocally).toBe(true);
  });

  test("a browser with no speech recognition says so and never listens", async () => {
    const statuses: NarrationStatus[] = [];
    startNarration(
      {
        language: "en-GB",
        muted: false,
        phrase: () => undefined,
        status: (status) => statuses.push(status),
      },
      { Recognition: null, now: () => START, timers: fakeTimers().timers },
    );
    expect(statuses.at(-1)).toEqual({
      state: "failed",
      problem: "unsupported",
    });
  });
});

function result(
  resultIndex: number,
  results: [string, boolean][],
): Extract<ChromeEvent, { type: "result" }> {
  return {
    type: "result",
    at: 0,
    resultIndex,
    results: results.map(([text, final]) => [text, final, 0.9]),
  };
}

/** setTimeout and clearTimeout on a clock the test moves. */
function fakeTimers() {
  let now = START;
  let next = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setNow: (at: number) => {
      now = at;
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = until;
    },
    timers: {
      set(run: () => void, ms: number) {
        const id = ++next;
        pending.set(id, { at: now + ms, run });
        return id;
      },
      clear(handle: unknown) {
        pending.delete(handle as number);
      },
    },
  };
}

/** Lets the browser's answers to `available()`, which come on later turns, arrive. */
const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
};

/** A SpeechRecognition double: what the page set on it, and Chrome's own calls back, driven by the test. */
class FakeRecognition implements Recognition {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  processLocally?: boolean;
  onstart: (() => void) | null = null;
  onresult: ((event: RecognitionResultEvent) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  stops = 0;
  aborts = 0;
  start() {
    this.started = true;
  }
  stop() {
    this.stops++;
  }
  abort() {
    this.aborts++;
  }
}

/** The page listening as a recording starts, once the browser said it can keep the language on the computer (an
 * answer it gives on a later turn): `onDevice` is what it can, every language by default; null for a browser with no
 * on-device recognition at all. */
async function setup(
  options: { onDevice?: OnDeviceModel | null; language?: string } = {},
) {
  const time = fakeTimers();
  const recognitions: FakeRecognition[] = [];
  const phrases: Phrase[] = [];
  const statuses: NarrationStatus[] = [];
  /** What the Recorder is told, in order: each phrase, and each change in when the phrase being said began. */
  const told: ({ phrase: string } | { speaking: number | null })[] = [];
  const Chrome = class extends FakeRecognition {
    constructor() {
      super();
      recognitions.push(this);
    }
  };
  const onDevice =
    options.onDevice === undefined ? everyLanguage() : options.onDevice;
  const narration = startNarration(
    {
      language: options.language ?? "en-GB",
      muted: false,
      phrase: (phrase) => {
        phrases.push(phrase);
        told.push({ phrase: phrase.text });
      },
      speaking: (since) => told.push({ speaking: since }),
      status: (status) => statuses.push(status),
    },
    {
      Recognition: onDevice ? withOnDevice(Chrome, onDevice) : Chrome,
      now: time.now,
      timers: time.timers,
    },
  );
  await settle();
  const current = () => {
    const recognition = recognitions.at(-1);
    if (!recognition) throw new Error("Nothing is listening.");
    return recognition;
  };
  return {
    narration,
    onDevice,
    settle,
    Recognition: onDevice ? Chrome : null,
    recognitions,
    phrases,
    statuses,
    told,
    current,
    at: (ms: number) => time.setNow(START + ms),
    advance: time.advance,
    /** Plays recorded events into the current recognition at the moments Chrome sent them. */
    replay(events: ChromeEvent[]) {
      for (const event of events) {
        time.setNow(START + event.at);
        const recognition = current();
        if (isResult(event)) recognition.onresult?.(speechEvent(event));
        else if (event.type === "start") recognition.onstart?.();
        else if (event.type === "end") recognition.onend?.();
      }
    },
  };
}
