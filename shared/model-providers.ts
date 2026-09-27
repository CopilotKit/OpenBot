/**
 * The facts every Bot shares about the model providers it may be pointed at.
 *
 * One entry per provider, rather than the same default model, key variable and base URL variable
 * written out in each Bot. They were written out in each Bot, and they drifted: five files, five
 * different default OpenAI models, the first time somebody changed one of them in one place only.
 * A provider is added here; the Bots that speak its SDK take their names from this table.
 *
 * Facts only. Which provider a Bot can DRIVE is that Bot's own decision, beside the code that
 * loads its SDK: this module knows Google exists and what its key is called, and `agent-mastra`
 * still refuses it because it loads no Google module. Keeping the two apart is what lets a new
 * provider be registered here without pretending every harness can answer for it.
 *
 * Its own module for the reason `model-key.ts` had to be one: `agent-bot` and `agent-langgraph`
 * call `serve()` at module scope, so importing a pure function from an entry point binds a port.
 */

/** The providers this deployment knows the names of. Adding one is adding one entry below. */
export type ModelProviderId = "openai" | "anthropic" | "google";

export type ProviderSpec = {
  readonly id: ModelProviderId;
  /** How the provider is named in an error message. */
  readonly label: string;
  /** The environment variable its API key arrives in. */
  readonly keyVariable: string;
  /** The environment variable an endpoint override for it arrives in. */
  readonly baseUrlVariable: string;
  /** What a Bot uses when it is told a provider and no model. */
  readonly defaultModel: string;
};

export const MODEL_PROVIDERS: Record<ModelProviderId, ProviderSpec> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    keyVariable: "OPENAI_API_KEY",
    baseUrlVariable: "OPENAI_BASE_URL",
    defaultModel: "gpt-5.5",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    keyVariable: "ANTHROPIC_API_KEY",
    baseUrlVariable: "ANTHROPIC_BASE_URL",
    defaultModel: "claude-sonnet-4-5",
  },
  google: {
    id: "google",
    label: "Google",
    keyVariable: "GOOGLE_API_KEY",
    baseUrlVariable: "GOOGLE_GENERATIVE_AI_BASE_URL",
    defaultModel: "gemini-2.5-flash",
  },
};

/**
 * The provider somebody configured, or nothing if they named one nobody has heard of.
 *
 * Blank means OpenAI, because that is what every other reader of `BOT_PROVIDER` already decided:
 * the desktop writes an empty provider when switching back to OpenAI, the server reads empty as
 * OpenAI, and a compose file passing `${BOT_PROVIDER:-}` hands the variable an empty string rather
 * than no variable at all. A Bot that refused that would disagree with the screen that configured
 * it.
 *
 * Padded and differently-cased names are the same provider, for the same reason `BOT_MODEL` is
 * trimmed before it is used: a value somebody typed into a setup window arrives with a space on
 * it more often than not. A Bot that has to report which provider was named gets `undefined` here
 * and shows the raw value in its own message.
 */
export function providerSpec(
  provider: string | undefined,
): ProviderSpec | undefined {
  const normalized = provider?.trim().toLowerCase() || "openai";
  return MODEL_PROVIDERS[normalized as ModelProviderId];
}

/** The environment variable this provider's key arrives in, or nothing for a provider unknown. */
export function keyVariableFor(
  provider: string | undefined,
): string | undefined {
  return providerSpec(provider)?.keyVariable;
}

/** The environment variable an endpoint override for this provider arrives in. */
export function baseUrlVariableFor(
  provider: string | undefined,
): string | undefined {
  return providerSpec(provider)?.baseUrlVariable;
}

/**
 * What this Bot runs when it was told a provider and no usable model.
 *
 * An unknown provider falls back to the OpenAI default rather than refusing here, because the
 * Bots validate the provider themselves and their error message is the one that should name what
 * went wrong. This function is asked before that check runs.
 */
export function defaultModelFor(provider: string | undefined): string {
  return (
    providerSpec(provider)?.defaultModel ?? MODEL_PROVIDERS.openai.defaultModel
  );
}

/**
 * The model this Bot runs: what was configured, or the provider's default when it was not.
 *
 * Blank is not configured. A compose file passing `BOT_MODEL: ${BOT_MODEL:-}` hands this an empty
 * string, and a Bot that sent it on would ask its provider for a model named "" and die with
 * "you must provide a model parameter", which reads as a broken Bot rather than as missing
 * configuration.
 */
export function configuredModel(
  provider: string | undefined,
  configured: string | undefined,
): string {
  return configured?.trim() || defaultModelFor(provider);
}

/**
 * Whether this model has to be driven through the Responses API.
 *
 * `gpt-5.6-*` rejects function tools on `/v1/chat/completions` — "To use function tools, use
 * /v1/responses or set reasoning_effort to 'none'" — so a Bot that speaks chat completions by hand
 * cannot use it, and a Bot whose integration offers the Responses API has to turn it on. The same
 * predicate answers both questions; which question is asked belongs to the Bot.
 *
 * Named for the fact rather than for either consequence, because `agent-bot` uses it to refuse a
 * model and `agent-langgraph` uses it to select a flag, and neither name fits both.
 */
export function requiresResponsesApi(model: string): boolean {
  return /^gpt-5\.[6-9]|^gpt-[6-9]/.test(model);
}

/**
 * Whether this Bot must hold this provider's key before it can start.
 *
 * Not when an endpoint was named to answer instead. `OPENAI_BASE_URL` set means any endpoint
 * speaking that API, and Ollama, vLLM, LM Studio and llama.cpp all serve it with no key. The
 * setup window offers exactly those by name and accepts a blank key for them, so requiring one
 * refused the whole keyless half of that feature: somebody filled in an address, the app raised
 * the Bot, and it exited on startup complaining about a key their endpoint does not have.
 *
 * Only OpenAI has a base URL that means "somebody else's server"; Anthropic and Google are asked
 * with their own variable so the rule can grow without a second signature.
 */
export function keyIsRequired(
  provider: string | undefined,
  baseUrl: string | undefined,
): boolean {
  const named =
    providerSpec(provider)?.id === "openai" && Boolean(baseUrl?.trim());
  return !named;
}

/**
 * What to hand an SDK that insists on a string even when the endpoint ignores it.
 *
 * A placeholder rather than an empty string: empty is a client that cannot be constructed, and
 * the value is never sent anywhere that reads it when the endpoint needs no key.
 */
export function apiKeyOrPlaceholder(apiKey: string | undefined): string {
  return apiKey?.trim() || "no-key-needed";
}
