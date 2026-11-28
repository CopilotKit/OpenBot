/**
 * Which OpenAI API the engine calls a model on is exactly what the shared rule says.
 *
 * shared/model-providers.ts `requiresResponsesApi` is the rule every Bot in the box decides by; the
 * engine imports it rather than keeping a copy. This drives the engine's real chat model for each id
 * against a provider that answers both APIs, reads which one it was asked on, and fails on any id
 * where that differs from the shared rule: a copy that drifted, or a library that picks the API
 * itself, both show up here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { requiresResponsesApi } from "../../shared/model-providers.ts";
import { chatModel } from "../src/models.ts";
import { always, fakeProvider } from "./fake-provider.ts";

/** OpenAI's catalogue and the names a gateway gives it, each family on both sides of the rule. */
const MODELS = [
  "gpt-4o-mini",
  "gpt-4.1-mini",
  "o3",
  "o3-pro",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-pro",
  "gpt-5-pro-2025-10-06",
  "gpt-5.1",
  "gpt-5.1-2025-11-13",
  "gpt-5.2",
  "gpt-5.2-2025-12-11",
  "gpt-5.2-pro",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-2026-03-05",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.5",
  "gpt-5.5-2026-04-23",
  "gpt-5.5-pro",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "openai/gpt-5.5",
  "openai/gpt-5.6-terra",
  "openai/gpt-oss-20b",
];

const TOOL = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Current weather for a city.",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  },
};

test("the engine calls every model on the API the shared rule names", async () => {
  const provider = await fakeProvider(always({ text: "ok" }));
  try {
    const env = {
      BOT_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: `${provider.base}/v1`,
    };
    const differ: string[] = [];
    for (const model of MODELS) {
      const before = provider.requests.length;
      const engine = chatModel({ model, effort: "low", sendOnce: true }, env);
      const bound = engine.bindTools?.([TOOL]);
      assert.ok(bound, `${model}: the engine's model takes tools`);
      // Streamed, as the engine always asks.
      for await (const _ of await bound.stream(
        "What is the weather in Paris?",
      )) {
        // Read to the end.
      }
      const path = provider.requests[before]?.path ?? "";
      const engineSays = path.endsWith("/responses");
      if (engineSays !== requiresResponsesApi(model))
        differ.push(
          `${model}: engine ${path}, shared rule ${requiresResponsesApi(model) ? "responses" : "chat"}`,
        );
    }
    assert.deepEqual(differ, []);
    assert.equal(provider.requests.length, MODELS.length);
  } finally {
    await provider.close();
  }
});
