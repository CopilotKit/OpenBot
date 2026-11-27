import { describe, expect, test } from "bun:test";
import {
  GEMINI_UNSIGNED_CALL,
  isGeminiModel,
  signedBody,
  signingFetch,
} from "./gemini-signatures";

const COMPAT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const chat = (model = "gemini-3.8-flash", extra?: unknown) =>
  JSON.stringify({
    model,
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "f", arguments: "{}" },
            ...(extra ? { extra_content: extra } : {}),
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "{}" },
    ],
  });

const contents = (signature?: string) =>
  JSON.stringify({
    contents: [
      { role: "user", parts: [{ text: "hi" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "f", args: {} },
            ...(signature ? { thoughtSignature: signature } : {}),
          },
          { functionCall: { name: "g", args: {} } },
        ],
      },
    ],
  });

const chatSignatures = (body: string | undefined) =>
  JSON.parse(body ?? "{}").messages.flatMap(
    (m: {
      tool_calls?: {
        extra_content?: { google?: { thought_signature?: string } };
      }[];
    }) =>
      (m.tool_calls ?? []).map(
        (c) => c.extra_content?.google?.thought_signature,
      ),
  );

describe("which requests a handed-back Gemini call is signed in", () => {
  test("Gemini models, by name", () => {
    for (const model of [
      "gemini-4-hydrogen",
      "models/gemini-4-neon",
      "google/gemini-4-carbon",
    ])
      expect(isGeminiModel(model)).toBe(true);
    for (const model of [
      "gpt-5.5",
      "claude-sonnet-5-5",
      "gemma-4-31b-it",
      "",
      undefined,
    ])
      expect(isGeminiModel(model)).toBe(false);
  });

  test("Gemini's own API, on any host, keeping a signature already there", () => {
    for (const base of [
      "https://generativelanguage.googleapis.com/v1beta",
      "http://127.0.0.1:9/v1beta",
    ]) {
      const body = signedBody(
        "POST",
        `${base}/models/gemini-4-hydrogen:streamGenerateContent?alt=sse`,
        contents("real"),
      );
      const parts = JSON.parse(body ?? "{}").contents[1].parts;
      expect(
        parts.map((p: { thoughtSignature?: string }) => p.thoughtSignature),
      ).toEqual(["real", GEMINI_UNSIGNED_CALL]);
    }
    expect(
      signedBody(
        "POST",
        "http://x/v1beta/models/gemma-4-31b-it:generateContent",
        contents(),
      ),
    ).toBeUndefined();
  });

  test("Google's compatible endpoint and OpenBot's gateway, for a Gemini model only", () => {
    expect(chatSignatures(signedBody("POST", COMPAT, chat()))).toEqual([
      GEMINI_UNSIGNED_CALL,
    ]);
    const gateway =
      "http://openbot:3010/api/model-provider/v1/chat/completions";
    expect(chatSignatures(signedBody("POST", gateway, chat()))).toEqual([
      GEMINI_UNSIGNED_CALL,
    ]);
    expect(signedBody("POST", gateway, chat("gpt-5.5"))).toBeUndefined();
    expect(
      signedBody(
        "POST",
        COMPAT,
        chat("gemini-3.8-flash", { google: { thought_signature: "real" } }),
      ),
    ).toBeUndefined();
  });

  test("never another provider, even for a Gemini name", () => {
    for (const url of [
      "https://api.openai.com/v1/chat/completions",
      "https://openrouter.ai/api/v1/chat/completions",
    ])
      expect(signedBody("POST", url, chat())).toBeUndefined();
    expect(signedBody("GET", COMPAT, chat())).toBeUndefined();
    expect(signedBody("POST", COMPAT, "not json")).toBeUndefined();
  });

  test("the wrapped fetch sends the signed body, a Request included", async () => {
    const sent: string[] = [];
    const inner = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      sent.push(
        input instanceof Request ? await input.text() : String(init?.body),
      );
      return new Response("{}");
    }) as typeof fetch;
    const signed = signingFetch(inner);
    await signed(COMPAT, { method: "POST", body: chat() });
    await signed(new Request(COMPAT, { method: "POST", body: chat() }));
    await signed("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: chat(),
    });
    expect(sent.map(chatSignatures)).toEqual([
      [GEMINI_UNSIGNED_CALL],
      [GEMINI_UNSIGNED_CALL],
      [undefined],
    ]);
  });
});
