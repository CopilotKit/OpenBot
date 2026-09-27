import { describe, expect, test } from "bun:test";
import {
  MODEL_PROVIDERS,
  apiKeyOrPlaceholder,
  baseUrlVariableFor,
  configuredModel,
  defaultModelFor,
  keyIsRequired,
  keyVariableFor,
  providerSpec,
  requiresResponsesApi,
} from "./model-providers";

/**
 * The table is the contract, so its rows are written down.
 *
 * Every one of these values is read out of a `process.env` name or sent to a provider as a model
 * name; changing one silently retargets a running Bot. They are pinned here because they were the
 * thing that drifted — five files, five default OpenAI models — and a registry that can drift the
 * same way inside its own file has only moved the bug.
 */
describe("the provider registry", () => {
  test("each provider names the variable its key arrives in", () => {
    expect(MODEL_PROVIDERS.openai.keyVariable).toBe("OPENAI_API_KEY");
    expect(MODEL_PROVIDERS.anthropic.keyVariable).toBe("ANTHROPIC_API_KEY");
    expect(MODEL_PROVIDERS.google.keyVariable).toBe("GOOGLE_API_KEY");
  });

  test("each provider names the variable its endpoint override arrives in", () => {
    expect(MODEL_PROVIDERS.openai.baseUrlVariable).toBe("OPENAI_BASE_URL");
    expect(MODEL_PROVIDERS.anthropic.baseUrlVariable).toBe(
      "ANTHROPIC_BASE_URL",
    );
    expect(MODEL_PROVIDERS.google.baseUrlVariable).toBe(
      "GOOGLE_GENERATIVE_AI_BASE_URL",
    );
  });

  test("each provider has a model to run when none was configured", () => {
    expect(MODEL_PROVIDERS.openai.defaultModel).toBe("gpt-5.5");
    expect(MODEL_PROVIDERS.anthropic.defaultModel).toBe("claude-sonnet-4-5");
    expect(MODEL_PROVIDERS.google.defaultModel).toBe("gemini-2.5-flash");
  });

  test("each provider has a name to be refused by", () => {
    expect(MODEL_PROVIDERS.openai.label).toBe("OpenAI");
    expect(MODEL_PROVIDERS.anthropic.label).toBe("Anthropic");
    expect(MODEL_PROVIDERS.google.label).toBe("Google");
  });
});

/** Which provider was meant, and whether a name nobody has heard of is said out loud. */
describe("which provider was configured", () => {
  test("the three names the Bots accept resolve", () => {
    expect(providerSpec("openai")?.id).toBe("openai");
    expect(providerSpec("anthropic")?.id).toBe("anthropic");
    expect(providerSpec("google")?.id).toBe("google");
  });

  /**
   * Blank means OpenAI everywhere else that reads `BOT_PROVIDER`: the desktop writes an empty
   * provider when switching back to OpenAI, the server reads empty as OpenAI.
   */
  test("no provider named means OpenAI", () => {
    expect(providerSpec(undefined)?.id).toBe("openai");
    expect(providerSpec("")?.id).toBe("openai");
    expect(providerSpec("   ")?.id).toBe("openai");
  });

  /** Padded and differently-cased names are the same provider, the way `BOT_MODEL` is trimmed. */
  test("casing and padding are not a different provider", () => {
    expect(providerSpec(" OpenAI ")?.id).toBe("openai");
    expect(providerSpec("ANTHROPIC")?.id).toBe("anthropic");
    expect(providerSpec("Google")?.id).toBe("google");
  });

  /**
   * Answering "openai" for a name nobody has heard of is how a Bot silently falls into the OpenAI
   * branch; an unknown provider has to stay unknown so the Bot can name what went wrong.
   */
  test("a provider nobody has heard of does not become OpenAI", () => {
    expect(providerSpec("mistral")).toBeUndefined();
    expect(providerSpec("open-ai")).toBeUndefined();
    expect(keyVariableFor("mistral")).toBeUndefined();
    expect(baseUrlVariableFor("mistral")).toBeUndefined();
  });

  test("the key and endpoint variables come from the row", () => {
    expect(keyVariableFor("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(baseUrlVariableFor("google")).toBe("GOOGLE_GENERATIVE_AI_BASE_URL");
    expect(keyVariableFor(undefined)).toBe("OPENAI_API_KEY");
  });
});

/**
 * A named endpoint is a model, and its key belongs to it.
 *
 * The failure this pins: the setup window's "any OpenAI-compatible endpoint" row takes an address
 * with no key, because Ollama and vLLM have none. The Bots then refused to start, saying
 * OPENAI_API_KEY was not set, so the whole keyless half of that feature produced a dead container
 * and a red line on the last screen about a key the person's own server does not have.
 */
describe("whether a model key is required", () => {
  test("plain OpenAI still needs its key", () => {
    expect(keyIsRequired("openai", undefined)).toBe(true);
    expect(keyIsRequired("openai", "")).toBe(true);
    expect(keyIsRequired("openai", "   ")).toBe(true);
    expect(keyIsRequired(undefined, undefined)).toBe(true);
    expect(keyIsRequired("", "")).toBe(true);
  });

  test("an endpoint named instead of OpenAI answers without one", () => {
    expect(keyIsRequired("openai", "http://127.0.0.1:11434/v1")).toBe(false);
    expect(keyIsRequired(undefined, "http://127.0.0.1:11434/v1")).toBe(false);
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

/**
 * Which model a Bot runs: what was configured, or its provider's default when it was not.
 *
 * Blank is not configured — a compose file passing `BOT_MODEL: ${BOT_MODEL:-}` hands an empty
 * string, and sending that on would ask a provider for a model named "".
 */
describe("which model this Bot was told to use", () => {
  test("an unset or empty choice falls back to the provider's default", () => {
    expect(configuredModel("openai", undefined)).toBe("gpt-5.5");
    expect(configuredModel("openai", "")).toBe("gpt-5.5");
    expect(configuredModel("openai", "   ")).toBe("gpt-5.5");
    expect(configuredModel("anthropic", undefined)).toBe("claude-sonnet-4-5");
    expect(configuredModel("google", "")).toBe("gemini-2.5-flash");
  });

  /** An unknown provider has no default of its own; the Bot refuses it on its own a line later. */
  test("an unknown provider still has a model to be refused with", () => {
    expect(defaultModelFor("mistral")).toBe("gpt-5.5");
    expect(configuredModel("mistral", undefined)).toBe("gpt-5.5");
  });

  test("a padded name is the name", () => {
    expect(configuredModel("openai", " gpt-5.5 ")).toBe("gpt-5.5");
    expect(configuredModel("anthropic", "claude-sonnet-4-5")).toBe(
      "claude-sonnet-4-5",
    );
  });

  /** A configured model wins over the provider's default; that is the whole point of configuring. */
  test("a configured model is run, whatever the default says", () => {
    expect(configuredModel("openai", "gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(configuredModel("anthropic", "claude-3-5-haiku")).toBe(
      "claude-3-5-haiku",
    );
  });
});

/**
 * The models that cannot be driven through chat completions, and the ones that can.
 *
 * `gpt-5.6-*` rejects function tools on `/v1/chat/completions`; which question a Bot asks of
 * this predicate — refuse the model, or turn on the Responses API — belongs to the Bot.
 */
describe("whether a model has to be driven through the Responses API", () => {
  test("the models that reject tools on chat completions are flagged", () => {
    expect(requiresResponsesApi("gpt-5.6-terra")).toBe(true);
    expect(requiresResponsesApi("gpt-6")).toBe(true);
    expect(requiresResponsesApi("gpt-5.5")).toBe(false);
  });

  test("padding does not get one past the guard", () => {
    expect(
      requiresResponsesApi(configuredModel("openai", " gpt-5.6-terra")),
    ).toBe(true);
    expect(requiresResponsesApi(configuredModel("openai", "\tgpt-6 "))).toBe(
      true,
    );
  });

  test("other providers' models are not OpenAI's problem", () => {
    expect(requiresResponsesApi("claude-sonnet-4-5")).toBe(false);
    expect(requiresResponsesApi("gemini-2.5-flash")).toBe(false);
  });
});
