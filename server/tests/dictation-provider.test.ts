import { describe, expect, test } from "bun:test";
import { transcriptionConfig } from "../src/dictation/config";
import { createTranscriptionProvider } from "../src/dictation/provider";

const environment = {
  TRANSCRIPTION_PROVIDER: "openai-compatible",
  TRANSCRIPTION_BASE_URL: "https://speech.example/v1/",
  TRANSCRIPTION_MODEL: "speech-model",
};

describe("independent transcription configuration", () => {
  test("chat credentials and endpoints never enable dictation", () => {
    expect(
      transcriptionConfig({
        OPENAI_API_KEY: "chat-key",
        OPENAI_BASE_URL: "https://chat.example/v1",
      }),
    ).toBeUndefined();
  });
  test("requires an explicit provider, endpoint, and model", () => {
    expect(() => transcriptionConfig({ TRANSCRIPTION_API_KEY: "key" })).toThrow(
      "TRANSCRIPTION_PROVIDER",
    );
    expect(() =>
      transcriptionConfig({ TRANSCRIPTION_PROVIDER: "openai-compatible" }),
    ).toThrow("TRANSCRIPTION_BASE_URL");
    expect(() =>
      transcriptionConfig({
        ...environment,
        TRANSCRIPTION_BASE_URL: "https://user:password@speech.example/v1",
      }),
    ).toThrow("without credentials");
    expect(() =>
      transcriptionConfig({
        ...environment,
        TRANSCRIPTION_BASE_URL: "file:///tmp/audio",
      }),
    ).toThrow("HTTP(S)");
  });
  test("supports explicitly configured local services without a key", () => {
    expect(
      transcriptionConfig({
        ...environment,
        TRANSCRIPTION_BASE_URL: "http://localhost:8000/v1",
      }),
    ).toEqual({
      provider: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      model: "speech-model",
    });
  });
});

test("sends only audio and the configured model to the independent endpoint", async () => {
  const signal = new AbortController().signal;
  const provider = createTranscriptionProvider(
    {
      provider: "openai-compatible",
      baseUrl: "https://speech.example/v1",
      model: "speech-model",
      apiKey: "speech-key",
    },
    async (url, init) => {
      expect(url).toBe("https://speech.example/v1/audio/transcriptions");
      expect(init.signal).toBe(signal);
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer speech-key",
      );
      expect(init.body).toBeInstanceOf(FormData);
      if (!(init.body instanceof FormData))
        throw new Error("Expected multipart");
      expect(init.body.get("model")).toBe("speech-model");
      expect(init.body.get("file")).toBeInstanceOf(File);
      expect([...init.body.keys()].sort()).toEqual(["file", "model"]);
      return Response.json({ text: " Hola mundo. " });
    },
  );
  expect(
    await provider.transcribe(new File(["audio"], "recording.webm"), signal),
  ).toBe("Hola mundo.");
});

test("upstream errors do not leak provider response bodies", async () => {
  const provider = createTranscriptionProvider(
    {
      provider: "openai-compatible",
      baseUrl: "https://speech.example/v1",
      model: "speech-model",
    },
    async () => new Response("secret-key", { status: 401 }),
  );
  await expect(
    provider.transcribe(
      new File(["audio"], "audio.webm"),
      new AbortController().signal,
    ),
  ).rejects.toThrow("Retry or contact your administrator");
});

test("malformed success is a visible failure", async () => {
  const provider = createTranscriptionProvider(
    {
      provider: "openai-compatible",
      baseUrl: "https://speech.example/v1",
      model: "speech-model",
    },
    async () => Response.json({ message: "wrong shape" }),
  );
  await expect(
    provider.transcribe(
      new File(["audio"], "audio.webm"),
      new AbortController().signal,
    ),
  ).rejects.toThrow("invalid response");
});
