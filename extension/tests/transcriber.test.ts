import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createTranscriber,
  type VoiceSlice,
} from "../src/offscreen/transcriber";

type Seen = {
  auth: string | null;
  dictation: string | null;
  cookie: string | null;
  fieldName: string;
  fileName: string;
  fileType: string;
  bytes: number;
};
let seen: Seen | null = null;
let server: ReturnType<typeof Bun.serve>;
let openbotUrl = "";
let answer: () => Response = () => Response.json({ text: "hello" });

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const form = await request.formData();
      const entry = [...form.entries()][0];
      const file = entry?.[1] as unknown as (Blob & { name: string }) | string;
      if (entry && typeof file !== "string") {
        seen = {
          auth: request.headers.get("authorization"),
          dictation: request.headers.get("x-openbot-dictation"),
          cookie: request.headers.get("cookie"),
          fieldName: entry[0],
          fileName: file.name,
          // Bun's multipart parser infers the container from the filename.
          fileType: file.type.replace("video/webm", "audio/webm"),
          bytes: file.size,
        };
      }
      return answer();
    },
  });
  openbotUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

const slice = (index = 3): VoiceSlice => ({
  demonstrationId: "demo",
  index,
  startedAt: 1000,
  endedAt: 61_000,
  blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }),
});

function transcribe(index?: number) {
  return createTranscriber({ openbotUrl, token: "tok" }).transcribe(
    slice(index),
  );
}

test("sends field file named slice-<index>.webm with the bearer and the dictation header", async () => {
  answer = () => Response.json({ text: "hello" });
  expect(await transcribe(3)).toEqual({ text: "hello" });
  expect(seen).toEqual({
    auth: "Bearer tok",
    dictation: "1",
    cookie: null,
    fieldName: "file",
    fileName: "slice-3.webm",
    fileType: "audio/webm",
    bytes: 4,
  });
});

test("scrubs sensitive text out of a transcript", async () => {
  answer = () => Response.json({ text: "write to ada@example.com now" });
  const result = await transcribe();
  expect(result).toHaveProperty("text");
  expect((result as { text: string }).text).not.toContain("ada@example.com");
});

test("maps 422 to skipped, 503 to unavailable and 401 RECORDER_SIGNED_OUT to signedOut", async () => {
  answer = () => Response.json({ error: "No speech." }, { status: 422 });
  expect(await transcribe()).toEqual({ skipped: "no-speech" });

  answer = () =>
    Response.json({ error: "Dictation is not configured." }, { status: 503 });
  expect(await transcribe()).toEqual({
    unavailable: "Dictation is not configured.",
  });

  answer = () =>
    Response.json(
      { error: "Sign in again.", code: "RECORDER_SIGNED_OUT" },
      { status: 401 },
    );
  expect(await transcribe()).toEqual({ signedOut: true });
});

test("maps every other answer and a network failure to failed", async () => {
  answer = () => Response.json({ error: "Too many." }, { status: 429 });
  expect(await transcribe()).toEqual({ failed: "Too many." });

  answer = () => new Response("nope", { status: 401 });
  const plain = await transcribe();
  expect(plain).toHaveProperty("failed");

  answer = () => Response.json({ nothing: true });
  expect(await transcribe()).toHaveProperty("failed");

  const down = await createTranscriber({
    openbotUrl: "http://127.0.0.1:1",
    token: "tok",
  }).transcribe(slice());
  expect(down).toHaveProperty("failed");
});
