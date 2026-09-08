import { describe, expect, test } from "bun:test";
import { apiKeyOrPlaceholder, keyIsRequired } from "../src/model-key";

/**
 * A named endpoint is a model, and its key belongs to it.
 *
 * The failure this pins: the setup window's "any OpenAI-compatible endpoint" row takes an address
 * with no key, because Ollama and vLLM have none. This Bot then refused to start, saying
 * OPENAI_API_KEY was not set, so the keyless half of that feature produced a dead container and a
 * red line on the last screen about a key the person's own server does not have.
 */
describe("whether a model key is required", () => {
  test("plain OpenAI still needs its key", () => {
    expect(keyIsRequired(undefined)).toBe(true);
    expect(keyIsRequired("")).toBe(true);
    expect(keyIsRequired("   ")).toBe(true);
  });

  test("an endpoint named instead of OpenAI answers without one", () => {
    expect(keyIsRequired("http://127.0.0.1:11434/v1")).toBe(false);
  });

  test("the SDK is always handed a string", () => {
    expect(apiKeyOrPlaceholder(undefined)).toBe("no-key-needed");
    expect(apiKeyOrPlaceholder("  ")).toBe("no-key-needed");
    expect(apiKeyOrPlaceholder("sk-real")).toBe("sk-real");
  });
});
