import { describe, expect, test } from "bun:test";
import {
  apiKeyOrPlaceholder,
  keyIsRequired,
  modelIsUnusable,
  modelName,
} from "../src/model-key";

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

describe("which model this Bot was told to use", () => {
  test("an unset or empty choice falls back", () => {
    expect(modelName(undefined)).toBe("gpt-5.5");
    expect(modelName("")).toBe("gpt-5.5");
    expect(modelName("   ")).toBe("gpt-5.5");
  });

  test("a padded name is the name", () => {
    expect(modelName(" gpt-5.5 ")).toBe("gpt-5.5");
  });

  test("the models this Bot cannot drive are refused", () => {
    expect(modelIsUnusable("gpt-5.6-terra")).toBe(true);
    expect(modelIsUnusable("gpt-6")).toBe(true);
    expect(modelIsUnusable("gpt-5.5")).toBe(false);
  });

  test("padding does not get one past the guard", () => {
    expect(modelIsUnusable(modelName(" gpt-5.6-terra"))).toBe(true);
    expect(modelIsUnusable(modelName("\tgpt-6 "))).toBe(true);
  });
});
