import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CapturedEvent,
  REDACTED,
  scrubTranscript,
} from "@openbot/shared/recorder-masking";
import {
  browserName,
  DOWNLOAD_POLL_MS,
  downloadingSentence,
  FLUSH_MS,
  NO_WORDS_MS,
  NO_WORDS_SENTENCE,
  startVoice,
  type VoiceDeps,
  voiceSentence,
} from "../src/offscreen/voice";
import type { VoiceCapture } from "../src/protocol/messages";
import {
  type FakeTrack,
  fakeMicrophone,
  fakeSpeech,
  type OnDeviceModel,
  onDeviceModel,
} from "./support/fake-speech";

const START = 1_800_000_000_000;

/** What Chrome 156's speech recognition really sent for two phrases with a pause between (the file says how). */
const chromeTwoPhrases = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures", "chrome-156-two-phrases.json"),
    "utf8",
  ),
) as {
  events: {
    type: string;
    at: number;
    resultIndex?: number;
    results?: [transcript: string, isFinal: boolean, confidence: number][];
  }[];
};

/** Timers that run only when the test advances the clock. */
function virtualClock() {
  let time = START;
  let next = 1;
  const pending = new Map<number, { fn: () => void; at: number }>();
  return {
    now: () => time,
    timers: {
      set(fn: () => void, ms: number) {
        const handle = next++;
        pending.set(handle, { fn, at: time + Math.max(0, ms) });
        return handle;
      },
      clear(handle: unknown) {
        pending.delete(handle as number);
      },
    },
    async advance(ms: number) {
      const target = time + ms;
      for (;;) {
        await flush();
        let due: [number, { fn: () => void; at: number }] | undefined;
        for (const entry of pending)
          if (entry[1].at <= target && (!due || entry[1].at < due[1].at))
            due = entry;
        if (!due) break;
        pending.delete(due[0]);
        time = Math.max(time, due[1].at);
        due[1].fn();
      }
      time = target;
      await flush();
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

type Setup = {
  clock: ReturnType<typeof virtualClock>;
  events: CapturedEvent[];
  statuses: VoiceCapture[];
  tracks: FakeTrack[];
  constraints: MediaStreamConstraints[];
  speech: ReturnType<typeof fakeSpeech>;
  last(): VoiceCapture | undefined;
  recognition(
    index?: number,
  ): InstanceType<ReturnType<typeof fakeSpeech>["Recognition"]>;
};

function setup(
  options: {
    muted?: boolean;
    language?: string;
    noRecognition?: boolean;
    microphone?: () => Promise<void>;
    digests?: Set<string>;
    browser?: string;
    /** What the browser can recognise on the computer (the fake's default: every language, downloaded); null for a
     * browser with no on-device recognition at all. */
    onDevice?: OnDeviceModel | null;
  } = {},
) {
  const clock = virtualClock();
  const speech = fakeSpeech(options.onDevice);
  const microphone = fakeMicrophone(options.microphone);
  const s: Setup = {
    clock,
    events: [],
    statuses: [],
    tracks: microphone.tracks,
    constraints: microphone.constraints,
    speech,
    last: () => s.statuses.at(-1),
    recognition(index = -1) {
      const found = speech.instances.at(index);
      if (!found) throw new Error("no recognition was made");
      return found;
    },
  };
  const deps: VoiceDeps = {
    Recognition: options.noRecognition ? null : speech.Recognition,
    getUserMedia: microphone.getUserMedia,
    now: clock.now,
    timers: clock.timers,
  };
  const voice = startVoice(
    {
      language: options.language ?? "en-US",
      muted: options.muted ?? false,
      emit: (event) => s.events.push(event),
      status: (voice) => s.statuses.push(voice),
      mask: (text, before) =>
        scrubTranscript(text, { digests: options.digests, before }),
      ...(options.browser ? { browser: options.browser } : {}),
    },
    deps,
  );
  return { ...s, voice };
}

const domError = (name: string) =>
  Object.assign(new Error(name), { name }) as Error;

describe("voice", () => {
  test("opens the microphone and listens to its track in the recording's language, continuously, with interim words", async () => {
    const s = setup({ language: "de-DE" });
    await s.clock.advance(0);
    expect(s.statuses[0]).toEqual({ state: "starting" });
    expect(s.constraints).toHaveLength(1);
    const recognition = s.recognition();
    expect(recognition.started).toBe(true);
    expect(recognition.track as unknown).toBe(s.tracks[0]);
    expect(recognition.lang).toBe("de-DE");
    expect(recognition.continuous).toBe(true);
    expect(recognition.interimResults).toBe(true);
    // On this computer or not at all: without it Chrome streams the audio to its speech service.
    expect(recognition.processLocally).toBe(true);
    recognition.begin();
    expect(s.last()).toEqual({ state: "listening" });
  });

  test("interim words only update what the popup shows; each final phrase is one transcript event with its times", async () => {
    const s = setup();
    await s.clock.advance(0);
    const recognition = s.recognition();
    recognition.begin();
    await s.clock.advance(1_000);
    recognition.say([["I am opening", false]]);
    await s.clock.advance(100);
    recognition.say([["I am opening the order", false]]);
    expect(s.events).toHaveLength(0);
    await s.clock.advance(400);
    expect(s.last()).toEqual({
      state: "listening",
      heard: "I am opening the order",
    });
    await s.clock.advance(1_500);
    recognition.say([["I am opening the order page", true]]);
    expect(s.events).toEqual([
      {
        type: "CUSTOM",
        name: "transcript",
        timestamp: START + 1_000,
        value: {
          text: "I am opening the order page",
          startedAt: new Date(START + 1_000).toISOString(),
          endedAt: new Date(START + 3_000).toISOString(),
          language: "en-US",
        },
      },
    ]);
    expect(s.last()?.heard).toBe("I am opening the order page");
    // Chrome repeats a final result in later events; it is sent once.
    recognition.say(
      [
        ["I am opening the order page", true],
        [" to refund", false],
      ],
      0,
    );
    recognition.say(
      [
        ["I am opening the order page", true],
        [" to refund it", true],
      ],
      1,
    );
    expect(
      s.events.map((event) => (event.value as { text: string }).text),
    ).toEqual(["I am opening the order page", "to refund it"]);
  });

  test("a phrase Chrome showed while the one before was still being spoken starts when that one ended", async () => {
    const s = setup();
    await s.clock.advance(0);
    const recognition = s.recognition();
    recognition.begin();
    await s.clock.advance(1_000);
    recognition.say([
      ["I am opening", false],
      [" the", false],
    ]);
    // The first phrase is final while the next one's words already show at the index after it, which stays.
    await s.clock.advance(2_000);
    recognition.say([
      ["I am opening the order page", true],
      ["the customer", false],
    ]);
    await s.clock.advance(3_000);
    recognition.say(
      [
        ["I am opening the order page", true],
        ["the customer was charged twice", true],
      ],
      1,
    );
    expect(s.events.map((event) => event.timestamp)).toEqual([
      START + 1_000,
      START + 3_000,
    ]);
    expect(s.events[1]?.value).toMatchObject({
      startedAt: new Date(START + 3_000).toISOString(),
      endedAt: new Date(START + 6_000).toISOString(),
    });
  });

  test("Chrome 156's own events: the second phrase starts at its first word, not when the first phrase's folded tail was shown", async () => {
    // Recorded from real Chrome (fixtures/chrome-156-two-phrases.json): while a phrase is said Chrome splits it into a
    // settled head and a changing tail at the next index, folds the tail back in when the phrase is final (the list
    // gets shorter), and the next phrase reuses that index 2.2 s later.
    const s = setup();
    await s.clock.advance(0);
    const recognition = s.recognition();
    for (const event of chromeTwoPhrases.events) {
      await s.clock.advance(START + event.at - s.clock.now());
      if (event.type === "start") recognition.begin();
      if (event.type === "soundstart") recognition.hearSpeech();
      if (event.type === "result" && event.results)
        recognition.say(
          event.results.map(([transcript, isFinal]) => [transcript, isFinal]),
          event.resultIndex,
        );
    }
    expect(
      s.events.map((event) => ({
        text: (event.value as { text: string }).text,
        startedAt: event.timestamp - START,
        endedAt:
          Date.parse((event.value as { endedAt: string }).endedAt) - START,
      })),
    ).toEqual([
      {
        text: "I am opening the expenses page",
        startedAt: 1161,
        endedAt: 3177,
      },
      {
        text: "now I add the receipt from the taxi ride",
        startedAt: 5379,
        endedAt: 7919,
      },
    ]);
  });

  test("a spoken card number or typed secret is masked in the event and in the words the popup shows", async () => {
    const s = setup({
      digests: new Set([
        new Bun.CryptoHasher("sha256").update("hunter2").digest("hex"),
      ]),
    });
    await s.clock.advance(0);
    const recognition = s.recognition();
    recognition.begin();
    recognition.say([["my card number is $4,2424,2424,2424,242", false]]);
    await s.clock.advance(500);
    expect(s.last()?.heard).toBe(`my card number is $${REDACTED}`);
    recognition.say([["my card number is 4242 4242 4242 4242", true]]);
    recognition.say(
      [
        ["my card number is 4242 4242 4242 4242", true],
        [" and my password is hunter2", true],
      ],
      1,
    );
    expect(
      s.events.map((event) => (event.value as { text: string }).text),
    ).toEqual([
      `my card number is ${REDACTED}`,
      `and my password is ${REDACTED}`,
    ]);
    expect(JSON.stringify(s.statuses)).not.toContain("4242");
    expect(JSON.stringify(s.statuses)).not.toContain("hunter2");
  });

  test("a card number cut short is masked in the words the popup shows while it is still being said", async () => {
    const s = setup();
    await s.clock.advance(0);
    const recognition = s.recognition();
    recognition.begin();
    // What Chrome showed in a real run while the number was being read out.
    recognition.say([["my card number is 4012-8", false]]);
    await s.clock.advance(500);
    expect(s.last()?.heard).toBe(`my card number is ${REDACTED}`);
    expect(JSON.stringify(s.statuses)).not.toContain("4012");
  });

  test("a number read out after a pause is masked as following the phrase that named the card", async () => {
    const s = setup();
    await s.clock.advance(0);
    const recognition = s.recognition();
    recognition.begin();
    recognition.say([["my card number is", true]]);
    recognition.say(
      [
        ["my card number is", true],
        ["4012", false],
      ],
      1,
    );
    await s.clock.advance(500);
    expect(s.last()?.heard).toBe(REDACTED);
    recognition.say(
      [
        ["my card number is", true],
        ["4012 8", true],
      ],
      1,
    );
    expect(
      s.events.map((event) => (event.value as { text: string }).text),
    ).toEqual(["my card number is", REDACTED]);
    expect(JSON.stringify([s.events, s.statuses])).not.toContain("4012");
  });

  test("speech that never comes back as words says so after a while, keeps listening, and clears once words arrive", async () => {
    const s = setup();
    await s.clock.advance(0);
    const recognition = s.recognition();
    recognition.begin();
    // As Edge did in a real run: it hears speech and raises no error, but every final phrase is empty.
    recognition.hearSpeech();
    const empties: [string, boolean][] = [];
    for (let phrase = 0; phrase < 6; phrase++) {
      await s.clock.advance(3_000);
      empties.push(["", true]);
      recognition.say(empties);
    }
    expect(s.last()?.reason).toBeUndefined();
    await s.clock.advance(NO_WORDS_MS - 18_000);
    expect(s.last()).toEqual({ state: "listening", reason: NO_WORDS_SENTENCE });
    expect(NO_WORDS_SENTENCE).toBe(
      "This browser is not turning your speech into words. Recording carries on without narration.",
    );
    expect(s.events).toHaveLength(0);
    expect(recognition.aborts).toBe(0);
    expect(recognition.stops).toBe(0);
    expect(s.tracks[0]?.readyState).toBe("live");
    // Chrome ends the recognition and another listens: the sentence stays.
    recognition.end();
    await s.clock.advance(0);
    const next = s.recognition();
    expect(next).not.toBe(recognition);
    next.begin();
    expect(s.last()).toEqual({ state: "listening", reason: NO_WORDS_SENTENCE });
    next.say([["", true]]);
    expect(s.last()?.reason).toBe(NO_WORDS_SENTENCE);
    // A real phrase: it is sent and the sentence goes.
    next.say(
      [
        ["", true],
        ["I am opening the order page", true],
      ],
      1,
    );
    expect(s.events).toHaveLength(1);
    expect(s.last()).toEqual({
      state: "listening",
      heard: "I am opening the order page",
    });
  });

  test("silence never says the browser is not turning speech into words, and a mute forgets that it did", async () => {
    const quiet = setup();
    await quiet.clock.advance(0);
    quiet.recognition().begin();
    await quiet.clock.advance(5 * NO_WORDS_MS);
    expect(quiet.statuses.some((status) => status.reason)).toBe(false);

    const s = setup();
    await s.clock.advance(0);
    s.recognition().begin();
    s.recognition().hearSpeech();
    await s.clock.advance(NO_WORDS_MS);
    expect(s.last()?.reason).toBe(NO_WORDS_SENTENCE);
    s.voice.mute(true);
    s.recognition().end();
    expect(s.last()).toEqual({ state: "muted" });
    s.voice.mute(false);
    await s.clock.advance(0);
    s.recognition().begin();
    expect(s.last()).toEqual({ state: "listening" });
    await s.clock.advance(NO_WORDS_MS);
    expect(s.last()).toEqual({ state: "listening" });
  });

  test("a recognition Chrome ends is restarted on the same microphone, with a growing delay when it keeps ending at once", async () => {
    const s = setup();
    await s.clock.advance(0);
    s.recognition().begin();
    await s.clock.advance(10_000);
    s.recognition().error("no-speech");
    s.recognition().end();
    await s.clock.advance(0);
    expect(s.speech.instances).toHaveLength(2);
    expect(s.constraints).toHaveLength(1);
    // Ending within a moment of starting, again and again: 500 ms, then 1 s.
    s.recognition().end();
    await s.clock.advance(499);
    expect(s.speech.instances).toHaveLength(2);
    await s.clock.advance(1);
    expect(s.speech.instances).toHaveLength(3);
    s.recognition().end();
    await s.clock.advance(999);
    expect(s.speech.instances).toHaveLength(3);
    await s.clock.advance(1);
    expect(s.speech.instances).toHaveLength(4);
  });

  test("a microphone the browser has not allowed says so in a plain sentence, and nothing listens", async () => {
    const s = setup({
      microphone: async () => {
        throw domError("NotAllowedError");
      },
    });
    await s.clock.advance(0);
    expect(s.last()).toEqual({
      state: "failed",
      problem: "microphone",
      reason:
        "The Recorder is not allowed to use the microphone. Recording goes on without your voice.",
    });
    expect(s.speech.instances).toHaveLength(0);
  });

  test("no microphone, no speech recognition, a blocked service and an unsupported language each say so and let go of the microphone", async () => {
    const missing = setup({
      microphone: async () => {
        throw domError("NotFoundError");
      },
    });
    await missing.clock.advance(0);
    expect(missing.last()?.problem).toBe("no-microphone");

    const none = setup({ noRecognition: true });
    await none.clock.advance(0);
    expect(none.last()).toEqual({
      state: "failed",
      problem: "no-recognition",
      reason:
        "This browser cannot turn speech into text. Recording goes on without your voice.",
    });
    expect(none.constraints).toHaveLength(0);

    const blocked = setup();
    await blocked.clock.advance(0);
    blocked.recognition().error("service-not-allowed");
    expect(blocked.last()?.problem).toBe("service");
    expect(blocked.tracks[0]?.readyState).toBe("ended");
    expect(blocked.recognition().aborts).toBe(1);

    const revoked = setup();
    await revoked.clock.advance(0);
    revoked.recognition().error("not-allowed");
    expect(revoked.last()?.problem).toBe("microphone");
    expect(revoked.tracks[0]?.readyState).toBe("ended");

    const welsh = setup({ language: "cy-GB" });
    await welsh.clock.advance(0);
    welsh.recognition().error("language-not-supported");
    welsh.recognition().end();
    await welsh.clock.advance(5_000);
    expect(welsh.tracks[0]?.readyState).toBe("ended");
    expect(welsh.last()).toEqual({
      state: "failed",
      problem: "language",
      reason: voiceSentence("language", "cy-GB"),
    });
    expect(welsh.last()?.reason).toContain("Welsh");
    expect(welsh.speech.instances).toHaveLength(1);

    const unplugged = setup();
    await unplugged.clock.advance(0);
    unplugged.tracks[0]?.onended?.();
    expect(unplugged.last()?.problem).toBe("no-microphone");
  });

  test("a browser that cannot recognise speech on the computer never opens the microphone, and says why", async () => {
    // An older Chrome, or a Chromium without on-device recognition: it would send the audio to a speech service.
    const s = setup({ onDevice: null });
    await s.clock.advance(0);
    expect(s.last()).toEqual({
      state: "failed",
      problem: "on-device",
      reason:
        "This version of Chrome cannot turn speech into text on your computer, and the Recorder sends no voice anywhere else. Recording goes on without your voice.",
    });
    expect(s.constraints).toHaveLength(0);
    expect(s.speech.instances).toHaveLength(0);
  });

  test("a language the computer cannot recognise on the device turns voice off before the microphone opens", async () => {
    const s = setup({
      language: "cy-GB",
      onDevice: onDeviceModel({ "en-US": "installed" }, { unmasked: true }),
    });
    await s.clock.advance(0);
    expect(s.last()).toEqual({
      state: "failed",
      problem: "language",
      // The language's English name, as this runtime's ICU data spells it ("Welsh (UK)" in one, "Welsh (United
      // Kingdom)" in another): the sentence is what is pinned, not one ICU's name for the region.
      reason: `Chrome cannot turn ${new Intl.DisplayNames(["en"], { type: "language" }).of("cy-GB")} speech into text on your computer. Recording goes on without your voice.`,
    });
    expect(s.constraints).toHaveLength(0);
  });

  test("a language still to be downloaded asks for the person's Download, and listens once it is on the computer", async () => {
    // As Chrome answers for any language this origin has not installed yet: downloadable, even when it is there.
    const model = onDeviceModel({ "en-US": "downloadable" });
    const s = setup({ onDevice: model });
    await s.clock.advance(0);
    expect(s.last()).toEqual({
      state: "failed",
      problem: "speech-pack",
      reason:
        "Chrome has to download its American English speech recognition to your computer first. Choose Download, then voice turns on. Recording goes on without your voice.",
      language: "en-US",
    });
    expect(s.constraints).toHaveLength(0);

    // The popup's Download, on the person's click, then voice on again: it waits for the download, saying so.
    model.activation = true;
    const installed = s.speech.Recognition as unknown as {
      install(options: object): Promise<boolean>;
    };
    const done = installed.install({
      langs: ["en-US"],
      processLocally: true,
    });
    s.voice.mute(false);
    await s.clock.advance(0);
    expect(s.last()).toEqual({
      state: "starting",
      reason: downloadingSentence("en-US"),
    });
    expect(s.constraints).toHaveLength(0);
    await s.clock.advance(DOWNLOAD_POLL_MS);
    expect(s.constraints).toHaveLength(0);

    model.finishDownloads();
    expect(await done).toBe(true);
    await s.clock.advance(DOWNLOAD_POLL_MS);
    expect(s.constraints).toHaveLength(1);
    const recognition = s.recognition();
    expect(recognition.processLocally).toBe(true);
    recognition.begin();
    expect(s.last()).toEqual({ state: "listening" });
  });

  test("the browser refuses a download nobody clicked for", async () => {
    const model = onDeviceModel({ "en-US": "downloadable" });
    const speech = fakeSpeech(model);
    const install = (
      speech.Recognition as unknown as {
        install(options: object): Promise<boolean>;
      }
    ).install({ langs: ["en-US"], processLocally: true });
    await expect(install).rejects.toThrow("Requires a user gesture.");
  });

  test("a speech service out of reach says so and tries again with a growing delay", async () => {
    const s = setup();
    await s.clock.advance(0);
    s.recognition().begin();
    s.recognition().error("network");
    s.recognition().end();
    expect(s.last()).toEqual({
      state: "failed",
      problem: "network",
      reason: voiceSentence("network", "en-US"),
    });
    await s.clock.advance(1_999);
    expect(s.speech.instances).toHaveLength(1);
    await s.clock.advance(1);
    expect(s.speech.instances).toHaveLength(2);
    s.recognition().begin();
    expect(s.last()?.state).toBe("listening");
  });

  test("in Edge the speech service the popup names is Edge's, never Chrome's", async () => {
    // Edge run 1: the popup said "Chrome's speech service cannot be reached" in Edge. What Edge 155 and Chrome 156 on
    // macOS say they are, with their client hints and without them.
    const edge = {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0",
      userAgentData: {
        brands: [
          { brand: "Microsoft Edge", version: "155" },
          { brand: "Not.A/Brand", version: "99" },
          { brand: "Chromium", version: "155" },
        ],
      },
    };
    const chrome = {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
      userAgentData: {
        brands: [
          { brand: "Chromium", version: "156" },
          { brand: "Google Chrome", version: "156" },
          { brand: "Not_A Brand", version: "24" },
        ],
      },
    };
    expect(browserName(edge)).toBe("Edge");
    expect(browserName({ userAgent: edge.userAgent })).toBe("Edge");
    expect(browserName(chrome)).toBe("Chrome");
    expect(browserName({ userAgent: chrome.userAgent })).toBe("Chrome");

    const s = setup({ browser: browserName(edge) });
    await s.clock.advance(0);
    s.recognition().begin();
    s.recognition().error("network");
    expect(s.last()?.reason).toBe(
      "Edge's speech service cannot be reached. Recording goes on, and voice tries again in a moment.",
    );
    s.recognition().end();
    await s.clock.advance(2_000);
    s.recognition().begin();
    s.recognition().error("service-not-allowed");
    expect(s.last()?.reason).toBe(
      "Edge's speech recognition is turned off or not available here. Recording goes on without your voice.",
    );
    expect(JSON.stringify(s.statuses)).not.toContain("Chrome");
  });

  test("mute keeps the phrase in progress, lets go of the microphone, and unmute opens it again", async () => {
    const s = setup();
    await s.clock.advance(0);
    const first = s.recognition();
    first.begin();
    first.say([["before the mute", false]]);
    s.voice.mute(true);
    expect(s.last()).toEqual({ state: "muted" });
    expect(first.stops).toBe(1);
    first.say([["before the mute I said", true]]);
    first.end();
    await s.clock.advance(0);
    expect(s.events).toHaveLength(1);
    expect(s.last()).toEqual({ state: "muted" });
    expect(s.tracks[0]?.readyState).toBe("ended");
    await s.clock.advance(60_000);
    expect(s.speech.instances).toHaveLength(1);

    s.voice.mute(false);
    await s.clock.advance(0);
    expect(s.constraints).toHaveLength(2);
    expect(s.speech.instances).toHaveLength(2);
    s.recognition().begin();
    expect(s.last()?.state).toBe("listening");
  });

  test("a recording that starts muted opens no microphone until it is unmuted", async () => {
    const s = setup({ muted: true });
    await s.clock.advance(0);
    expect(s.constraints).toHaveLength(0);
    expect(s.statuses).toEqual([{ state: "muted" }]);
    s.voice.mute(false);
    await s.clock.advance(0);
    expect(s.constraints).toHaveLength(1);
  });

  test("unmuting after a failure tries again", async () => {
    let refuse = true;
    const s = setup({
      microphone: async () => {
        if (refuse) throw domError("NotAllowedError");
      },
    });
    await s.clock.advance(0);
    expect(s.last()?.problem).toBe("microphone");
    refuse = false;
    s.voice.mute(false);
    await s.clock.advance(0);
    expect(s.speech.instances).toHaveLength(1);
  });

  test("stop sends the phrase in progress, then lets go of the microphone, and sends nothing after", async () => {
    const s = setup();
    await s.clock.advance(0);
    const recognition = s.recognition();
    recognition.begin();
    recognition.say([["and now I press", false]]);
    let stopped = false;
    const stopping = s.voice.stop().then(() => {
      stopped = true;
    });
    await s.clock.advance(0);
    expect(recognition.stops).toBe(1);
    expect(stopped).toBe(false);
    recognition.say([["and now I press send", true]]);
    recognition.end();
    await stopping;
    expect(
      s.events.map((event) => (event.value as { text: string }).text),
    ).toEqual(["and now I press send"]);
    expect(s.tracks[0]?.readyState).toBe("ended");
    recognition.say([["too late", true]], 1);
    s.voice.mute(false);
    await s.clock.advance(60_000);
    expect(s.events).toHaveLength(1);
    expect(s.speech.instances).toHaveLength(1);
  });

  test("stop gives up waiting for a speech service that never ends", async () => {
    const s = setup();
    await s.clock.advance(0);
    const recognition = s.recognition();
    recognition.begin();
    let stopped = false;
    void s.voice.stop().then(() => {
      stopped = true;
    });
    await s.clock.advance(FLUSH_MS - 1);
    expect(stopped).toBe(false);
    await s.clock.advance(1);
    expect(stopped).toBe(true);
    expect(recognition.aborts).toBe(1);
    expect(s.tracks[0]?.readyState).toBe("ended");
  });

  test("a stop while the microphone is still opening lets go of it as soon as it opens", async () => {
    let open: () => void = () => {};
    const s = setup({
      microphone: () =>
        new Promise<void>((resolve) => {
          open = resolve;
        }),
    });
    await s.clock.advance(0);
    const stopping = s.voice.stop();
    open();
    await stopping;
    await s.clock.advance(0);
    expect(s.tracks[0]?.readyState).toBe("ended");
    expect(s.speech.instances).toHaveLength(0);
  });
});
