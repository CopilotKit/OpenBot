import { expect, test } from "bun:test";
import { DictationSession } from "@/lib/dictation/session";
import type { Recording } from "@/lib/dictation/recording";

const audio = new Blob(["recorded audio"], { type: "audio/webm" });

test("late microphone permission is cleaned up after cancel", async () => {
  const permission = Promise.withResolvers<Recording>();
  let cancelled = 0;
  const session = new DictationSession({
    record: () => permission.promise,
    transcribe: async () => "unused",
    onTranscript: () => {
      throw new Error("Must not insert");
    },
  });
  const starting = session.start();
  expect(session.getSnapshot().phase).toBe("requesting");
  session.cancel();
  permission.resolve({
    finish: async () => audio,
    cancel: () => {
      cancelled++;
    },
  });
  await starting;
  expect(cancelled).toBe(1);
  expect(session.getSnapshot().phase).toBe("idle");
});

test("late transcription never inserts into a cancelled conversation", async () => {
  const result = Promise.withResolvers<string>();
  const called = Promise.withResolvers<void>();
  let requestSignal: AbortSignal | undefined;
  const inserted: string[] = [];
  const session = new DictationSession({
    record: async () => ({ finish: async () => audio, cancel() {} }),
    transcribe: (_audio, signal) => {
      requestSignal = signal;
      called.resolve();
      return result.promise;
    },
    onTranscript: (text) => inserted.push(text),
  });
  await session.start();
  const finishing = session.finish();
  await called.promise;
  session.cancel();
  result.resolve("do not insert");
  await finishing;
  expect(requestSignal?.aborted).toBe(true);
  expect(inserted).toEqual([]);
});

test("retry uses the same recording and never opens a new microphone", async () => {
  let recordings = 0;
  let attempts = 0;
  const inserted: string[] = [];
  const session = new DictationSession({
    record: async () => {
      recordings++;
      return { finish: async () => audio, cancel() {} };
    },
    transcribe: async (blob) => {
      expect(blob).toBe(audio);
      if (++attempts === 1) throw new Error("Service unavailable");
      return "Hola mundo";
    },
    onTranscript: (text) => inserted.push(text),
  });
  await session.start();
  await session.finish();
  expect(session.getSnapshot()).toMatchObject({
    phase: "error",
    canRetry: true,
    error: "Service unavailable",
  });
  await session.retry();
  expect(recordings).toBe(1);
  expect(inserted).toEqual(["Hola mundo"]);
  expect(session.getSnapshot().phase).toBe("idle");
});

test("double Done does not transcribe twice", async () => {
  let calls = 0;
  const recording = Promise.withResolvers<Blob>();
  const session = new DictationSession({
    record: async () => ({ finish: () => recording.promise, cancel() {} }),
    transcribe: async () => {
      calls++;
      return "hello";
    },
    onTranscript() {},
  });
  await session.start();
  const first = session.finish();
  await session.finish();
  recording.resolve(audio);
  await first;
  expect(calls).toBe(1);
});

test("permission errors have an actionable recovery", async () => {
  const session = new DictationSession({
    record: async () => {
      throw new DOMException("denied", "NotAllowedError");
    },
    transcribe: async () => "unused",
    onTranscript() {},
  });
  await session.start();
  expect(session.getSnapshot()).toMatchObject({
    phase: "error",
    canRetry: false,
    error:
      "Microphone access was denied. Allow it in your browser and try again.",
  });
});
