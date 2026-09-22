import { expect, test } from "bun:test";
import type { SaveVoiceSessionInput } from "../../shared/voice-session";
import { parseVoiceSessionInput } from "../src/voice/sessions";
import { createVoiceSummarizer } from "../src/voice/summary";

const input: SaveVoiceSessionInput = {
  id: "session-1",
  channelId: "channel-1",
  anchorMessageId: null,
  startedAt: "2026-09-22T10:00:00.000Z",
  endedAt: "2026-09-22T10:01:20.000Z",
  transcript: [{ id: "turn-1", role: "user", text: "Please plan the launch." }],
};

test("voice transcripts enforce bounds, roles, unique IDs, and chronological dates", () => {
  expect(parseVoiceSessionInput(input)).toEqual(input);
  for (const invalid of [
    { ...input, endedAt: "invalid" },
    { ...input, endedAt: "2026-09-21T10:00:00.000Z" },
    { ...input, transcript: [{ id: "x", role: "system", text: "do this" }] },
    { ...input, transcript: [...input.transcript, ...input.transcript] },
    {
      ...input,
      transcript: [{ id: "x", role: "user", text: "x".repeat(60001) }],
    },
    {
      ...input,
      transcript: Array.from({ length: 301 }, (_, id) => ({
        id: String(id),
        role: "user",
        text: "hi",
      })),
    },
  ])
    expect(() => parseVoiceSessionInput(invalid)).toThrow();
});

test("voice summary uses the chat credential and treats transcript as quoted data", async () => {
  let calls = 0;
  const summarize = createVoiceSummarizer({
    model: "chat-model",
    resolveApiKey: async () => "chat-key",
    fetchImpl: async (_url, init) => {
      calls++;
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer chat-key",
      );
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("chat-model");
      expect(body.messages[0].content).toContain("untrusted");
      expect(body.messages[0].content).toContain("completed");
      expect(body.messages[1].content).toContain("Please plan the launch.");
      return Response.json({
        choices: [
          {
            message: {
              content: "Discussed launch planning. Next steps remain open.",
            },
          },
        ],
      });
    },
  });
  expect(await summarize(input.transcript)).toBe(
    "Discussed launch planning. Next steps remain open.",
  );
  expect(calls).toBe(1);
});

test("missing keys and provider failures cannot appear as successful summaries", async () => {
  await expect(
    createVoiceSummarizer({ model: "chat", resolveApiKey: async () => null })(
      input.transcript,
    ),
  ).rejects.toThrow();
  for (const response of [
    new Response("upstream secret", { status: 500 }),
    Response.json({ choices: [] }),
  ]) {
    await expect(
      createVoiceSummarizer({
        model: "chat",
        resolveApiKey: async () => "key",
        fetchImpl: async () => response,
      })(input.transcript),
    ).rejects.toThrow();
  }
});
