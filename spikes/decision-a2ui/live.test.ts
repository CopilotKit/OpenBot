import assert from "node:assert/strict";
import test from "node:test";
import { MessageProcessor } from "@a2ui/web_core/v1_0";
import { DecisionSession } from "./decision.ts";
import { application, cases } from "./fixtures.ts";
import {
  configuredKey,
  decisionClient,
  errorSummary,
  geminiClient,
} from "./live.ts";
import { createProcessor, spikeCatalog } from "./sdk.ts";

const key = configuredKey();
test("Gemini Decision 1 makes and renders a live settings decision", {
  skip: key ? false : "Set GEMINI_API_KEY or GOOGLE_API_KEY to opt in",
  timeout: 35_000,
}, async () => {
  const catalog = spikeCatalog();
  const session = new DecisionSession(
    createProcessor(catalog),
    decisionClient(geminiClient(key!)),
  );
  const { messages, usage } = await session
    .show(cases[0].request, application)
    .catch((error: unknown) => {
      throw new Error(JSON.stringify(errorSummary(error)));
    });
  assert.equal(usage?.total_output_tokens, 0);
  const renderer = new MessageProcessor([catalog]);
  renderer.processMessages(messages);
  const surface = renderer.getSurface("spike");
  assert.equal(surface?.componentsModel.get("settings_group")?.type, "Column");
  assert.equal(surface?.dataModel.get("/name"), application.settings.name);
});
