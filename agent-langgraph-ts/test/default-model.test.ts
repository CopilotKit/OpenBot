/**
 * A Gemini key with no model named answers on a model Google still serves.
 *
 * FOUND ON OPENBOT CLOUD on 2026-11-27: a run nobody chose a model for was sent the Google default
 * in shared/model-providers.json, `gemini-2.5-flash`, and Google answered 404, "This model
 * models/gemini-2.5-flash is no longer available to new users". The fake Gemini refuses the models
 * Google has retired for new keys the same way.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { fakeProvider } from "./fake-provider.ts";
import { conversation, run, withEngine } from "./helpers.ts";

test("A Gemini key with no model named answers on the Google default, which Google still serves", async () => {
  const gemini = await fakeProvider(() => ({ text: "Pineapple." }));
  try {
    const env = {
      BOT_PROVIDER: "google",
      BOT_MODEL: "",
      GOOGLE_API_KEY: "AIza-test",
      GOOGLE_GENERATIVE_AI_BASE_URL: `${gemini.base}/v1beta`,
    };
    await withEngine({ env }, async (base) => {
      const result = await run(base, conversation());
      assert.equal(
        result.events.at(-1)?.type,
        "RUN_FINISHED",
        inspect(result.events.at(-1)),
      );
    });
    assert.equal(gemini.requests.length, 1);
    assert.equal(gemini.requests[0]!.refused, undefined);
    assert.match(
      gemini.requests[0]!.path,
      /^\/v1beta\/models\/gemini-[^/:]+:streamGenerateContent/,
    );
  } finally {
    await gemini.close();
  }
});
