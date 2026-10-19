import { describe, expect, test } from "bun:test";
import {
  type CapturedEvent,
  REDACTED,
  scrubTranscript,
} from "@openbot/shared/recorder-masking";
import {
  FLUSH_MS,
  startVoice,
  type VoiceDeps,
  voiceSentence,
} from "../src/offscreen/voice";
import type { VoiceCapture } from "../src/protocol/messages";
import {
  type FakeTrack,
  fakeMicrophone,
  fakeSpeech,
} from "./support/fake-speech";

const START = 1_800_000_000_000;

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
  } = {},
) {
  const clock = virtualClock();
  const speech = fakeSpeech();
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
      mask: (text) => scrubTranscript(text, { digests: options.digests }),
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
    // The browser's own recognition with its defaults: nothing is forced onto the device.
    expect(recognition.processLocally).toBeUndefined();
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
    await s.clock.advance(2_000);
    recognition.say([["I am opening the order page", true]]);
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

  test("a microphone Chrome has not allowed says so in a plain sentence, and nothing listens", async () => {
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
        "Chrome has not let the Recorder use the microphone. Recording goes on without your voice.",
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
