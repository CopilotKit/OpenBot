import { describe, expect, test } from "bun:test";
import { type VoiceConfig, voiceConfig } from "../src/voice/config";
import { createVoiceProvider } from "../src/voice/provider";

const config: VoiceConfig = {
  provider: "openai-realtime",
  model: "voice-model",
  apiKey: "voice-secret",
  voice: "marin",
};
const offer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const input = {
  sdp: offer,
  agentName: "Research assistant",
  agentTitle: "Researcher",
  agentRole: "Explain research clearly.",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("independent live voice configuration", () => {
  test("chat and dictation keys do not enable live voice", () => {
    expect(
      voiceConfig({
        OPENAI_API_KEY: "chat-secret",
        TRANSCRIPTION_API_KEY: "dictation-secret",
      }),
    ).toBeUndefined();
    expect(() =>
      voiceConfig({
        VOICE_PROVIDER: "openai-realtime",
        VOICE_MODEL: "model",
        OPENAI_API_KEY: "chat-secret",
      }),
    ).toThrow("VOICE_API_KEY");
  });
  test("requires complete configuration and defaults the voice only", () => {
    expect(() => voiceConfig({ VOICE_NAME: "marin" })).toThrow(
      "VOICE_PROVIDER",
    );
    expect(() =>
      voiceConfig({ VOICE_PROVIDER: "other", VOICE_API_KEY: "secret" }),
    ).toThrow("VOICE_PROVIDER");
    expect(() =>
      voiceConfig({
        VOICE_PROVIDER: "openai-realtime",
        VOICE_API_KEY: "secret",
      }),
    ).toThrow("VOICE_MODEL");
    expect(
      voiceConfig({
        VOICE_PROVIDER: "openai-realtime",
        VOICE_MODEL: "voice-model",
        VOICE_API_KEY: "voice-secret",
      }),
    ).toEqual(config);
    expect(
      voiceConfig({
        VOICE_PROVIDER: "openai-realtime",
        VOICE_MODEL: "voice-model",
        VOICE_API_KEY: "voice-secret",
        VOICE_NAME: "cedar",
      })?.voice,
    ).toBe("cedar");
  });
});

test("creates an audio session with agent delegation and interruption using only the voice key", async () => {
  const provider = createVoiceProvider(config, async (url, init) => {
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBe(input.signal);
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer voice-secret",
    );
    if (!(init.body instanceof FormData)) throw new Error("Expected multipart");
    expect([...init.body.keys()].sort()).toEqual(["sdp", "session"]);
    expect(init.body.get("sdp")).toBe(offer);
    const session = init.body.get("session");
    if (typeof session !== "string") throw new Error("Expected session JSON");
    expect(session).not.toContain("voice-secret");
    const parsed = JSON.parse(session);
    expect(parsed).toMatchObject({
      type: "realtime",
      model: "voice-model",
      output_modalities: ["audio"],
      audio: {
        input: {
          transcription: { model: "gpt-4o-mini-transcribe" },
          turn_detection: {
            type: "semantic_vad",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { voice: "marin" },
      },
      tools: [
        {
          type: "function",
          name: "ask_agent",
          parameters: {
            type: "object",
            properties: { request: { type: "string", maxLength: 4000 } },
            required: ["request"],
            additionalProperties: false,
          },
        },
      ],
    });
    expect(parsed.instructions).toContain("Research assistant");
    expect(parsed.instructions).toContain("Explain research clearly.");
    expect(parsed.instructions).toContain("brainstorm directly");
    expect(parsed.instructions).not.toContain("Delegate every substantive");
    expect(parsed.instructions).toContain("CRITICAL:");
    expect(parsed.instructions).toContain("ask_agent");
    return new Response(offer, {
      headers: { "content-type": "application/sdp" },
    });
  });
  expect(await provider.connect(input)).toEqual({
    transport: "webrtc",
    sdp: offer,
  });
});

test("provider failures and malformed successes are safe and bounded", async () => {
  for (const response of [
    new Response("voice-secret", { status: 401 }),
    new Response("voice-secret", { status: 429 }),
    new Response('{"key":"voice-secret"}'),
    new Response(`${offer}${"x".repeat(128 * 1024)}`),
  ]) {
    const provider = createVoiceProvider(config, async () => response);
    try {
      await provider.connect(input);
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("voice-secret");
      expect(String(error)).toContain("voice service");
    }
  }
  const provider = createVoiceProvider(config, async () => {
    throw new Error("voice-secret");
  });
  await expect(provider.connect(input)).rejects.toThrow("voice service");
});

test("aborted requests never start an upstream call", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const provider = createVoiceProvider(config, async () => {
    calls++;
    return new Response(offer);
  });
  await expect(
    provider.connect({ ...input, signal: controller.signal }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("Grok uses an independent voice default and only returns an ephemeral browser credential", async () => {
  const xaiConfig = voiceConfig({
    VOICE_PROVIDER: "xai-realtime",
    VOICE_MODEL: "grok-voice-latest",
    VOICE_API_KEY: "xai-server-secret",
  });
  expect(xaiConfig?.voice).toBe("ara");
  if (!xaiConfig) throw new Error("Expected config");
  const provider = createVoiceProvider(xaiConfig, async (url, init) => {
    expect(url).toBe("https://api.x.ai/v1/realtime/client_secrets");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer xai-server-secret",
    );
    expect(init.redirect).toBe("error");
    expect(init.signal).toBe(input.signal);
    expect(init.body).toBe(JSON.stringify({ expires_after: { seconds: 300 } }));
    return Response.json({
      value: "ephemeral-token",
      expires_at: Math.floor(Date.now() / 1000) + 300,
      extra: "xai-server-secret",
    });
  });
  expect(provider.transport).toBe("websocket");
  const connection = await provider.connect({ ...input, sdp: undefined });
  expect(connection).toMatchObject({
    transport: "websocket",
    clientSecret: "ephemeral-token",
    url: "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
    session: {
      voice: "ara",
      turn_detection: { type: "server_vad" },
      audio: {
        input: { format: { type: "audio/pcm", rate: 24000 } },
        output: { format: { type: "audio/pcm", rate: 24000 } },
      },
      tools: [{ type: "function", name: "ask_agent" }],
    },
  });
  expect(JSON.stringify(connection)).not.toContain("xai-server-secret");
});

test("Grok rejects malformed, expired, or reflected permanent credentials", async () => {
  const expires_at = Math.floor(Date.now() / 1000) + 300;
  for (const body of [
    {},
    { value: "token" },
    { value: "token", expires_at: 0 },
    { value: "voice-secret", expires_at },
    { value: "token with spaces", expires_at },
  ]) {
    const provider = createVoiceProvider(
      { ...config, provider: "xai-realtime" },
      async () => Response.json(body),
    );
    await expect(provider.connect(input)).rejects.toThrow("voice service");
  }
});

test("Learning-enabled voice sends substantive work through the selected channel agent", async () => {
  const provider = createVoiceProvider(config, async (_url, init) => {
    if (!(init.body instanceof FormData)) throw new Error("Expected multipart");
    const value = init.body.get("session");
    if (typeof value !== "string") throw new Error("Expected session JSON");
    const session = JSON.parse(value);
    expect(session.instructions).toContain("Delegate every substantive");
    expect(session.instructions).toContain("published Skills");
    expect(session.instructions).not.toContain("brainstorm directly");
    expect(session.instructions).toContain("acknowledgments");
    expect(session.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "ask_agent",
    ]);
    return new Response(offer, {
      headers: { "content-type": "application/sdp" },
    });
  });
  await provider.connect({ ...input, learningEnabled: true });
});
