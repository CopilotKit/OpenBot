/**
 * The models a person may pick for a built-in Bot's run, read from whatever serves this deployment's
 * model.
 *
 * ONE SOURCE, WHATEVER IS IN FRONT. The listing is asked of the endpoint the Bots already call: the
 * provider's own API, or the OpenAI-compatible endpoint in `OPENAI_BASE_URL`. A gateway or router
 * in front (switchback, OpenRouter, a company proxy) answers `GET /v1/models` with the models it
 * routes, under its own names, so putting one in front later changes what this lists without
 * changing how. The ids it returns are exactly what a run sends upstream.
 *
 * OpenAI's own listing is every model the key can reach, image and audio and embeddings included,
 * so that one is filtered down to chat models. A gateway's listing is somebody's deliberate choice
 * and is only stripped of what can never chat.
 *
 * Read once and kept for a while, because it changes when a provider ships a model, not per message.
 * Never throws: a listing that cannot be read leaves the deployment's own model and nothing to pick.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { type AppVariables, requireAdmin } from "./auth/guards";
import type { RuntimeModel } from "./copilot";

export type ModelOption = {
  id: string;
  label: string;
  /**
   * Who makes the model, as a brand id (`openai`, `anthropic`, `google`…), so the picker can show
   * its mark. Absent where the name does not say: a gateway's own alias, such as `fast`.
   */
  vendor?: string;
};

export type ModelCatalogue = {
  provider: RuntimeModel["provider"];
  /** What a run uses when nobody picked anything: the deployment's configured model. */
  default: string;
  /** Newest first. Always holds the default. */
  models: ModelOption[];
  /**
   * Whether there is anything to pick: false while the admin has picking off, for a plan, or when
   * the listing could not be read.
   */
  choosable: boolean;
};

/** What an admin picks the model allowlist from: the whole listing, before the allowlist. */
export type AvailableModels = {
  provider: RuntimeModel["provider"];
  default: string;
  /** Newest first. Always holds the default. */
  models: ModelOption[];
  /** False when the listing could not be read, so only the default is known. */
  listed: boolean;
};

type Listed = { id: string; label?: string; created: number };

type Allowlist = { enabled: boolean; models: readonly string[] };

const OPENAI_API = "https://api.openai.com";
const ANTHROPIC_API = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

/** Ten minutes: long enough that a picker opening costs nothing, short enough to see a new model today. */
const DEFAULT_TTL_MS = 10 * 60_000;
/** A failed listing is asked again sooner, but not on every message while a provider is down. */
const FAILED_TTL_MS = 60_000;

/** Models no chat can run on, by any provider or gateway's naming. */
const NEVER_CHAT =
  /(embed|tts|whisper|transcribe|dall-e|image|moderation|realtime|audio|sora|translate)/i;

/**
 * Chat models in OpenAI's own listing that a Bot should still not be put on: search and research
 * models that take no tools, ChatGPT's aliases, coding-harness models, the computer-use preview,
 * live voice, and the generations before tools worked well.
 */
const OPENAI_NOT_FOR_BOTS =
  /(search|deep-research|computer-use|chat-latest|codex|instruct|^gpt-live|^gpt-(3\.5|4)(-|$)|^o1(-|$)|^(babbage|davinci))/i;

/** OpenAI's dated snapshots, which repeat a model already listed under its own name. */
const DATED_SNAPSHOT = /-(\d{4}-\d{2}-\d{2}|\d{4})$/;

/** The chat models in a listing, in the order given. */
export function chatModelIds(
  ids: readonly string[],
  options: { officialOpenAI: boolean },
): string[] {
  return ids.filter((id) => {
    if (NEVER_CHAT.test(id)) return false;
    if (!options.officialOpenAI) return true;
    return (
      /^(gpt-|o\d)/i.test(id) &&
      !OPENAI_NOT_FOR_BOTS.test(id) &&
      !DATED_SNAPSHOT.test(id)
    );
  });
}

/**
 * Who makes a model, read from its name. A gateway's namespaced name (`anthropic/claude-…`) says so
 * outright; a bare name is matched on the families each vendor publishes. A gateway alias that
 * names no family (`fast`, `smart`) has no vendor, and that is the honest answer.
 */
const VENDOR_FAMILIES: readonly [RegExp, string][] = [
  [/^(gpt-|o\d|chatgpt-)/i, "openai"],
  [/^claude/i, "anthropic"],
  [/^(gemini|gemma)/i, "google"],
  [/^grok/i, "xai"],
  [/^(llama|meta-llama)/i, "meta"],
  [/^(mistral|mixtral|codestral|magistral|ministral|devstral)/i, "mistral"],
  [/^deepseek/i, "deepseek"],
  [/^qwen/i, "qwen"],
];

/** Gateways' own spellings of a vendor in a namespaced name, mapped to the brand id. */
const VENDOR_ALIASES: Record<string, string> = {
  "x-ai": "xai",
  "meta-llama": "meta",
  mistralai: "mistral",
  "google-ai": "google",
};

export function modelVendor(id: string): string | undefined {
  const slash = id.indexOf("/");
  if (slash > 0) {
    const prefix = id.slice(0, slash).toLowerCase();
    return VENDOR_ALIASES[prefix] ?? prefix;
  }
  return VENDOR_FAMILIES.find(([family]) => family.test(id))?.[1];
}

function option(id: string, label?: string): ModelOption {
  const vendor = modelVendor(id);
  return {
    id,
    label: label ?? modelLabel(id),
    ...(vendor ? { vendor } : {}),
  };
}

/**
 * What a model is called where a person picks it. OpenAI publishes no display names, so its ids are
 * spelled out (`gpt-5.4-mini` is GPT-5.4 Mini); anything else, including a gateway's own namespaced
 * names, is shown as it is, because that is the name its operator chose.
 */
export function modelLabel(id: string): string {
  const match = /^gpt-([^-]+)((?:-[a-z0-9.]+)*)$/i.exec(id);
  if (!match) return id;
  const rest = (match[2] ?? "")
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return [`GPT-${match[1]}`, ...rest].join(" ");
}

function base(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).replace(/\/+$/, "");
}

/** The listing endpoint under the base URL the Bots call, which may or may not end in its version. */
export function modelsUrl(
  provider: RuntimeModel["provider"],
  environment: Record<string, string | undefined>,
): string {
  const root =
    provider === "anthropic"
      ? base(environment.ANTHROPIC_BASE_URL, ANTHROPIC_API)
      : base(environment.OPENAI_BASE_URL, OPENAI_API);
  const versioned = /\/v\d+$/.test(root) ? root : `${root}/v1`;
  return provider === "anthropic"
    ? `${versioned}/models?limit=1000`
    : `${versioned}/models`;
}

function isOfficialOpenAI(environment: Record<string, string | undefined>) {
  try {
    return (
      new URL(base(environment.OPENAI_BASE_URL, OPENAI_API)).host ===
      new URL(OPENAI_API).host
    );
  } catch {
    return false;
  }
}

/** Reads `data[]` from an OpenAI- or Anthropic-shaped listing, skipping anything without an id. */
function parseListing(body: unknown): Listed[] {
  const data =
    body && typeof body === "object" && "data" in body
      ? (body as { data: unknown }).data
      : undefined;
  if (!Array.isArray(data)) return [];
  const listed: Listed[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const { id, created, created_at, display_name } = entry as Record<
      string,
      unknown
    >;
    if (typeof id !== "string" || id.length === 0) continue;
    listed.push({
      id,
      ...(typeof display_name === "string" && display_name
        ? { label: display_name }
        : {}),
      created:
        typeof created === "number"
          ? created
          : typeof created_at === "string"
            ? Date.parse(created_at) / 1000 || 0
            : 0,
    });
  }
  return listed;
}

export function createModelCatalogue(options: {
  model: RuntimeModel;
  /** The deployment's model key, resolved per read so a rotated credential is used next time. */
  apiKey: () => Promise<string | null>;
  /** The admin's model allowlist, read on every call so a change applies at once. */
  allowlist?: () => Allowlist | undefined;
  /** Whether people may pick at all (the admin's switch). Absent is yes. Read on every call. */
  enabled?: () => boolean;
  environment?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}) {
  const environment = options.environment ?? process.env;
  const request = options.fetch ?? fetch;
  const log = options.log ?? ((line: string) => console.warn(line));
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const { provider, defaultModel } = options.model;

  let cached: { listed: Listed[] | null; until: number } | undefined;
  let inFlight: Promise<Listed[] | null> | undefined;

  async function list(): Promise<Listed[] | null> {
    try {
      const key = await options.apiKey();
      const headers: Record<string, string> =
        provider === "anthropic"
          ? {
              ...(key ? { "x-api-key": key } : {}),
              "anthropic-version": ANTHROPIC_VERSION,
            }
          : key
            ? { authorization: `Bearer ${key}` }
            : {};
      const response = await request(modelsUrl(provider, environment), {
        headers,
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
      if (!response.ok) {
        log(
          JSON.stringify({
            type: "model-list-unreadable",
            provider,
            status: response.status,
          }),
        );
        return null;
      }
      const listed = parseListing(await response.json());
      const keep = new Set(
        provider === "anthropic"
          ? listed.map((entry) => entry.id)
          : chatModelIds(
              listed.map((entry) => entry.id),
              { officialOpenAI: isOfficialOpenAI(environment) },
            ),
      );
      return listed.filter((entry) => keep.has(entry.id));
    } catch (error) {
      log(
        JSON.stringify({
          type: "model-list-unreadable",
          provider,
          // The name only: a fetch error can carry the URL, and an SDK error can carry headers.
          reason: error instanceof Error ? error.name : "unknown",
        }),
      );
      return null;
    }
  }

  async function listed(): Promise<Listed[] | null> {
    if (cached && now() < cached.until) return cached.listed;
    inFlight ??= list().then((result) => {
      cached = {
        listed: result,
        until: now() + (result ? ttl : Math.min(ttl, FAILED_TTL_MS)),
      };
      inFlight = undefined;
      return result;
    });
    return inFlight;
  }

  /**
   * The listing, newest first, with the default always in it. Narrowed to the admin's allowlist
   * unless `everything`, which is what an admin picks the allowlist from.
   */
  async function offered(everything: boolean): Promise<ModelOption[] | null> {
    // A plan's harness picks the model itself and is never sent one, so there is nothing to offer.
    if (options.model.plan) return null;
    const found = await listed();
    if (!found) return null;

    const allowlist = everything ? undefined : options.allowlist?.();
    const allowed = (id: string) =>
      id === defaultModel ||
      !allowlist?.enabled ||
      allowlist.models.includes(`${provider}/${id}`);

    const models = [...found]
      .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
      .filter((entry) => allowed(entry.id))
      .map((entry) => option(entry.id, entry.label));
    if (!models.some((model) => model.id === defaultModel))
      models.unshift(option(defaultModel));
    return models;
  }

  async function read(): Promise<ModelCatalogue> {
    const models = await offered(false);
    if (!models)
      return {
        provider,
        default: defaultModel,
        models: [option(defaultModel)],
        choosable: false,
      };
    return {
      provider,
      default: defaultModel,
      models,
      choosable: (options.enabled?.() ?? true) && models.length > 1,
    };
  }

  /**
   * Every model the listing offers, whatever the allowlist and the switch say, for an admin to pick
   * the allowlist from. Only the deployment's own model when the listing cannot be read.
   */
  async function available(): Promise<AvailableModels> {
    const models = await offered(true);
    return {
      provider,
      default: defaultModel,
      models: models ?? [option(defaultModel)],
      listed: models !== null,
    };
  }

  return {
    read,
    available,
    /** Whether a run may use this model: only ever one this catalogue would offer. */
    async allows(id: string): Promise<boolean> {
      const catalogue = await read();
      return catalogue.models.some((model) => model.id === id);
    },
  };
}

export type ModelCatalogueReader = ReturnType<typeof createModelCatalogue>;

/**
 * `GET /api/models`: what the composer's model picker offers. Signed in, like every other read of
 * this deployment's configuration. Never fails: the catalogue already falls back to the default.
 * `GET /api/models/available`: the whole listing for an admin choosing the model allowlist.
 */
export function createModelRoutes(
  catalogue: ModelCatalogueReader,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.get("/", async (context) => context.json(await catalogue.read()));
  // The whole listing, for the admin's model allowlist; `/` is already narrowed to it.
  routes.get("/available", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json(await catalogue.available());
  });
  return routes;
}
