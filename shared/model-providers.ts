/**
 * The facts every Bot shares about the model providers it may be pointed at.
 *
 * One entry per provider, rather than the same default model, key variable and base URL variable
 * written out in each Bot. They were written out in each Bot, and they drifted: five files, five
 * different default OpenAI models, the first time somebody changed one of them in one place only.
 * A provider is added here; the Bots that speak its SDK take their names from this table.
 *
 * THE VALUES LIVE IN `model-providers.json`, beside this file. That file is the contract every
 * language in the box reads — TypeScript and Python through the loaders beside it, any other
 * language straight as JSON — so a developer adding a Bot in Java adds one entry there and never
 * reads this module. What this module adds to the file is types and validation: a row missing a
 * field, or a `bots` entry naming a provider nobody has heard of, stops the process at startup
 * with the path of the offending key rather than at the first model call.
 *
 * ENVIRONMENT BEATS FILE. `BOT_PROVIDER` and `BOT_MODEL` still win, exactly as
 * `docs/configuration.md` has always described; the file supplies what they leave unset. API keys
 * never appear in the file — they arrive in the environment under the `key_variable` the provider
 * row names.
 *
 * Facts only. Which provider a Bot can DRIVE is that Bot's own decision, beside the code that
 * loads its SDK: this module knows Google exists and what its key is called, and `agent-mastra`
 * still refuses it because it loads no Google module. Keeping the two apart is what lets a new
 * provider be registered here without pretending every harness can answer for it. The `bots`
 * section records what a Bot runs by default, not what it is able to drive.
 *
 * Its own module for the reason `model-key.ts` had to be one: `agent-bot` and `agent-langgraph`
 * call `serve()` at module scope, so importing a pure function from an entry point binds a port.
 */

import specJson from "./model-providers.json";

/**
 * The providers this deployment knows the names of.
 *
 * Adding one is adding one entry to `PROVIDER_IDS` and one row to the JSON file; the loader below
 * refuses to start if the two disagree in either direction.
 */
export const PROVIDER_IDS = ["openai", "anthropic", "google"] as const;

export type ModelProviderId = (typeof PROVIDER_IDS)[number];

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

/** A row as `model-providers.json` writes it: snake_case, because every language reads it. */
type SpecProviderRow = {
  readonly label?: unknown;
  readonly key_variable?: unknown;
  readonly base_url_variable?: unknown;
  readonly default_model?: unknown;
};

/** What the file says a Bot runs when its environment names nothing. */
type SpecBotRow = {
  readonly provider?: unknown;
  readonly model?: unknown;
};

type SpecFile = {
  readonly providers?: Readonly<Record<string, SpecProviderRow | undefined>>;
  readonly bots?: Readonly<Record<string, SpecBotRow | undefined>>;
};

function fail(problem: string): never {
  throw new Error(`shared/model-providers.json: ${problem}`);
}

function requireText(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${where} must be a non-empty string.`);
  }
  return value;
}

/**
 * The file, checked. Every read below is of a row this function has already seen.
 *
 * Checked once, at module load, because the failure it reports is a mistake in the repository
 * rather than in a deployment: a hand editing the JSON wrong should stop every Bot at startup
 * with the key they got wrong, not send one Bot to a model named by a typo.
 */
function readSpec(): {
  providers: Record<ModelProviderId, ProviderSpec>;
  bots: Record<string, { provider: ModelProviderId; model: string }>;
} {
  const spec = specJson as SpecFile;

  const providers = {} as Record<ModelProviderId, ProviderSpec>;
  for (const id of PROVIDER_IDS) {
    const row = spec.providers?.[id];
    if (!row) fail(`providers is missing its ${id} row.`);
    providers[id] = {
      id,
      label: requireText(row.label, `providers.${id}.label`),
      keyVariable: requireText(
        row.key_variable,
        `providers.${id}.key_variable`,
      ),
      baseUrlVariable: requireText(
        row.base_url_variable,
        `providers.${id}.base_url_variable`,
      ),
      defaultModel: requireText(
        row.default_model,
        `providers.${id}.default_model`,
      ),
    };
  }
  for (const id of Object.keys(spec.providers ?? {})) {
    if (!(PROVIDER_IDS as readonly string[]).includes(id)) {
      fail(`providers has a ${id} row this module has never heard of.`);
    }
  }

  const bots: Record<string, { provider: ModelProviderId; model: string }> = {};
  for (const [botId, entry] of Object.entries(spec.bots ?? {})) {
    if (!entry) fail(`bots.${botId} must be an object.`);
    const provider = requireText(entry.provider, `bots.${botId}.provider`);
    if (!(PROVIDER_IDS as readonly string[]).includes(provider)) {
      fail(
        `bots.${botId}.provider is ${JSON.stringify(provider)}, not one of ${PROVIDER_IDS.join(", ")}.`,
      );
    }
    bots[botId] = {
      provider: provider as ModelProviderId,
      model: requireText(entry.model, `bots.${botId}.model`),
    };
  }

  return { providers, bots };
}

const { providers: SPEC_PROVIDERS, bots: BOT_ENTRIES } = readSpec();

export const MODEL_PROVIDERS: Record<ModelProviderId, ProviderSpec> =
  SPEC_PROVIDERS;

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

/** What one Bot was decided to run: its provider, and the model on it. */
export type BotSettings = {
  /** The provider this Bot answers on. */
  readonly provider: string;
  /** The model it runs. */
  readonly model: string;
};

/**
 * This Bot's provider and model: environment over spec file over provider default.
 *
 * The lookup order is the whole contract, and it is the order `docs/configuration.md` already
 * documents for `BOT_PROVIDER` and `BOT_MODEL` — the environment is how a deployment overrides
 * what the repository decided, so it wins. What is new is the middle: `model-providers.json`'s
 * `bots` entry, the default this Bot had before this function existed, written down in one file
 * every language in the box reads instead of repeated in each Bot's source. What is unchanged is
 * the last: the provider's own default row, for a provider whose Bot entry the file pairs with
 * somebody else.
 *
 * `pinnedProvider` is for a Bot that drives exactly one provider's API and answers to no other
 * name — `agent-bot` speaks chat completions by hand and has never read `BOT_PROVIDER`. Pinning
 * keeps that Bot's behavior what it was while its model still comes from the file.
 *
 * A provider nobody has heard of is kept as typed, not rewritten to OpenAI, so the Bot's own
 * refusal can put the name in its message. Its model falls back to the OpenAI default for the
 * same reason `defaultModelFor` does it: the refusal is one line below and belongs to the Bot.
 *
 * A missing `bots` entry throws rather than defaults. The file is in this repository; a Bot wired
 * to it without a row is a mistake made while editing it, made at development time, and the
 * developer should meet it at startup rather than wonder why every deployment answers on
 * gpt-5.5.
 */
export function botSettings(
  botId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  pinnedProvider?: string,
): BotSettings {
  const entry = BOT_ENTRIES[botId];
  if (!entry) {
    fail(
      `bots has no ${botId} entry. Add one before this Bot reads the spec file.`,
    );
  }

  const provider =
    pinnedProvider?.trim() ||
    (env.BOT_PROVIDER ?? "").trim().toLowerCase() ||
    entry.provider;

  // A model the environment names goes to whatever provider was resolved, because an endpoint
  // names its own catalogue. The file's model belongs to the file's provider, so a deployment
  // that moved this Bot to another provider gets that provider's default instead of a model
  // paired with the one it left.
  const model =
    env.BOT_MODEL?.trim() ||
    (provider === entry.provider ? entry.model : defaultModelFor(provider));

  return { provider, model };
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
