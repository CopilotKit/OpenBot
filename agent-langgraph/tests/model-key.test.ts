import { describe, expect, test } from "bun:test";
import { apiKeyOrPlaceholder, keyIsRequired } from "../src/model-key";

/**
 * A named endpoint is a model, and its key belongs to it.
 *
 * The failure this pins: the setup window's "any OpenAI-compatible endpoint" row takes an address
 * with no key, because Ollama and vLLM have none. This Bot then refused to start, saying
 * OPENAI_API_KEY was not set, so the whole keyless half of that feature produced a dead container.
 */
describe("whether a model key is required", () => {
  test("plain OpenAI still needs its key", () => {
    expect(keyIsRequired("openai", undefined)).toBe(true);
    expect(keyIsRequired("openai", "")).toBe(true);
    expect(keyIsRequired("openai", "   ")).toBe(true);
  });

  test("an endpoint named instead of OpenAI answers without one", () => {
    expect(keyIsRequired("openai", "http://127.0.0.1:11434/v1")).toBe(false);
  });

  /** Neither of the other providers has a base URL to be named by, so neither changes. */
  test("anthropic and google are unchanged", () => {
    expect(keyIsRequired("anthropic", "http://127.0.0.1:11434/v1")).toBe(true);
    expect(keyIsRequired("google", "http://127.0.0.1:11434/v1")).toBe(true);
  });

  /** The SDK cannot be constructed with an empty string, so there is always something to pass. */
  test("the SDK is always handed a string", () => {
    expect(apiKeyOrPlaceholder(undefined)).toBe("no-key-needed");
    expect(apiKeyOrPlaceholder("  ")).toBe("no-key-needed");
    expect(apiKeyOrPlaceholder("sk-real")).toBe("sk-real");
  });
});
