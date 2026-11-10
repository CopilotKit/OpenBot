/**
 * The models a person may pick for a Bot's run, read from whatever serves this deployment's model,
 * with how hard each one can think.
 *
 * ONE SOURCE, WHATEVER IS IN FRONT. The listing is asked of the endpoint the Bots already call: the
 * provider's own API (OpenAI, Anthropic, Google, xAI), the OpenAI-compatible endpoint in
 * `OPENAI_BASE_URL`, or, for a signed-in plan, the plan's own listing. A gateway or router in front
 * (switchback, OpenRouter, a company proxy) answers `GET /v1/models` with the models it routes, under
 * its own names, so putting one in front later changes what this lists without changing how. The ids
 * it returns are exactly what a run sends upstream.
 *
 * NOTHING HERE IS A TABLE OF MODELS. Which models exist comes from the provider's listing. How hard
 * each can think comes from the provider's own listing where it says (Anthropic, xAI and the ChatGPT
 * plan do), and otherwise from models.dev, the open catalogue opencode and others maintain, read at
 * runtime. Which one is the default comes from the same data: the middle of the provider's current
 * line by price. A model released tomorrow shows up at the next refresh; one with no capability data
 * yet is still listed, on its own default effort. Without models.dev (offline, or turned off) the
 * provider's own data still applies, and the default falls back to the deployment's configured model.
 *
 * REFRESHED IN THE BACKGROUND, NEVER PER MESSAGE. The listing and the capability data are read at
 * boot and then every few hours (`REFRESH_MS`), because providers ship and retire models on a scale of
 * weeks and announce retirements months ahead. A run reads the last good answer from memory. A
 * refresh that fails keeps the last good answer. A provider refusing a model as unknown or
 * unsupported triggers an early refresh (`reportModelRejected`), so a retired model drops out
 * without waiting for the schedule.
 *
 * Never throws: a listing that cannot be read leaves the deployment's own model and nothing to pick.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { type AppVariables, requireAdmin } from "./auth/guards";
import type { RuntimeModel } from "./copilot";
import { onModelRejected } from "./model-rejection";

export {
  isModelUnavailableMessage,
  onModelRejected,
  reportModelRejected,
} from "./model-rejection";

export type ModelOption = {
  id: string;
  label: string;
  /**
   * Who makes the model, as a brand id (`openai`, `anthropic`, `google`…), so the picker can show
   * its mark. Absent where the name does not say: a gateway's own alias, such as `fast`.
   */
  vendor?: string;
  /**
   * How hard this model can be asked to think, weakest first, in the wire spelling every provider
   * shares (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Absent when the model takes
   * no effort, or nothing says which it takes: then none is ever sent and it thinks on its own
   * default.
   */
  efforts?: string[];
  /** The effort the model uses when none is sent, when its provider says. Absent: unknown. */
  defaultEffort?: string;
};

/**
 * What serves the models, as far as listing and thinking go. `provider` on the catalogue stays the
 * wire provider (`openai` or `anthropic`), because that is the prefix the allowlist and the usage
 * view already share; this says who is actually behind it.
 */
export type ModelSource =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "gateway"
  | "chatgpt"
  | "claude";

/**
 * Who decides which models people may pick. `all`: one person on their own machine, who picks from
 * everything the credential lists. `allowed`: a team, where an admin allows models in Admin,
 * Providers, and people pick among those.
 */
export type ModelExposure = "all" | "allowed";

export type ModelCatalogue = {
  provider: RuntimeModel["provider"];
  source: ModelSource;
  exposure: ModelExposure;
  /**
   * What a run uses when nobody picked anything: the operator's model when they named one the
   * credential lists, otherwise the middle of the provider's current line.
   */
  default: string;
  /** Newest first. Always holds the default. */
  models: ModelOption[];
  /**
   * Whether there is anything to pick: false until an admin allows a model in a team, or when the
   * listing could not be read.
   */
  choosable: boolean;
};

/** What an admin picks the model allowlist from: the whole listing, before the allowlist. */
export type AvailableModels = {
  provider: RuntimeModel["provider"];
  source: ModelSource;
  exposure: ModelExposure;
  default: string;
  /** Newest first. Always holds the default. */
  models: ModelOption[];
  /** False when the listing could not be read, so only the default is known. */
  listed: boolean;
};

/** What one run answers on: the model, and the effort to send, if any. */
export type RunChoice = {
  model: string;
  /**
   * The model's name as the composer's model picker shows it ("GPT-6.1 Terra"), read from the same
   * catalogue entry, so the Bot names its model the way the person sees it named. `choose` always
   * says it; absent, the Bot is told no model name.
   */
  label?: string;
  /** Only ever one the model takes. Absent: send none, so the model thinks on its own default. */
  effort?: string;
  /** Whether the model came from a listing that was read, rather than the configured fallback. */
  listed: boolean;
};

/** One model as the listing and the capability data together describe it. */
type Entry = {
  id: string;
  label?: string;
  /** Seconds since the epoch. 0 when nothing says. */
  created: number;
  /** The provider's line or family (`claude-sonnet`, `gpt-terra`), for finding the middle. */
  family?: string;
  /** Dollars per million input tokens, for ordering a line. */
  price?: number;
  efforts?: string[];
  defaultEffort?: string;
  /** False when the provider or the catalogue says this model cannot chat with tools. */
  chat?: boolean;
  /** True when the provider says it is past its shutdown date. */
  retired?: boolean;
};

type Allowlist = { enabled: boolean; models: readonly string[] };

/** Every effort spelling the providers use, weakest first. Unknown ones sort last, kept as given. */
export const EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const OPENAI_API = "https://api.openai.com";
const ANTHROPIC_API = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
/** What a Claude plan's OAuth token is accepted under, as Claude Code itself sends it. */
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
const MODELS_DEV = "https://models.dev/api.json";

/**
 * Six hours. Providers ship models weeks apart and publish shutdown dates months ahead (OpenAI's
 * listing carries `shutdown_date`, Anthropic's `retires_at`), and models.dev is edited a few times a
 * day, so a new model shows up the same day without the listing being asked more than four times
 * a day. A model a provider refuses is refreshed early instead (`reportModelRejected`).
 */
export const REFRESH_MS = 6 * 60 * 60_000;
/** A refresh that failed is tried again sooner, while the last good answer keeps serving. */
const RETRY_MS = 5 * 60_000;
/** At most one early refresh a minute, however many runs a retired model fails at once. */
const EARLY_REFRESH_MS = 60_000;

/**
 * How far behind the provider's newest model a line's newest may be and still count as current.
 * A line nobody has updated in four months is an older generation the provider still serves for
 * compatibility (GPT-5.5 next to GPT-6.1), and is never the middle of anything.
 */
const CURRENT_LINE_SECONDS = 120 * 24 * 60 * 60;

/** Models no chat can run on, by any provider or gateway's naming. */
const NEVER_CHAT =
  /(embed|tts|whisper|transcribe|dall-e|image|moderation|realtime|audio|sora|translate|video|lyria|imagen|veo-|(^|[-/])live([-.]|$))/i;

/**
 * Chat models in OpenAI's own listing that a Bot should still not be put on: search and research
 * models that take no tools, ChatGPT's aliases, coding-harness models, the computer-use preview,
 * live voice, and the generations before tools worked well.
 */
const OPENAI_NOT_FOR_BOTS =
  /(search|deep-research|computer-use|chat-latest|codex|instruct|^gpt-live|^gpt-(3\.5|4)(-|$)|^o1(-|$)|^(babbage|davinci))/i;

/** The same, for the other providers a deployment names directly: agents, research and robots. */
const VENDOR_NOT_FOR_BOTS =
  /(deep-research|computer-use|robotics|antigravity|nano-banana|multi-agent|(^|-)aqa$)/i;

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
    // OpenRouter marks a moving alias with a tilde: `~openai/gpt-sol-latest` is still OpenAI.
    const prefix = id.slice(0, slash).toLowerCase().replace(/^~/, "");
    return VENDOR_ALIASES[prefix] ?? prefix;
  }
  return VENDOR_FAMILIES.find(([family]) => family.test(id))?.[1];
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

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Who is behind the endpoint the Bots call. A plan is its own source; otherwise the base URL's host
 * says, and OpenBot's own sign-in proxy (Google or xAI, signed in to on the desktop) is told apart by
 * the model it was set up with, which is the only thing the environment says about it.
 */
export function modelSourceFor(
  model: Pick<RuntimeModel, "provider" | "plan">,
  environment: Record<string, string | undefined>,
): ModelSource {
  if (model.plan)
    return model.plan.provider === "claude" ? "claude" : "chatgpt";
  if (model.provider === "anthropic") return "anthropic";
  const configured = environment.OPENAI_BASE_URL?.trim();
  if (!configured) return "openai";
  const host = hostOf(configured);
  if (host === hostOf(OPENAI_API)) return "openai";
  if (host === "generativelanguage.googleapis.com") return "google";
  if (host === "api.x.ai") return "xai";
  if (signedInThroughProxy(environment)) {
    const vendor = modelVendor(environment.BOT_MODEL?.trim() ?? "");
    if (vendor === "google" || vendor === "xai") return vendor;
  }
  return "gateway";
}

/** The vendor whose models a source lists, for reading their capabilities. */
function sourceVendor(source: ModelSource): string | undefined {
  switch (source) {
    case "openai":
    case "chatgpt":
      return "openai";
    case "anthropic":
    case "claude":
      return "anthropic";
    case "google":
      return "google";
    case "xai":
      return "xai";
    default:
      return undefined;
  }
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
  const versioned = /\/v\d+(beta)?(\/openai)?$/.test(root)
    ? root
    : `${root}/v1`;
  return provider === "anthropic"
    ? `${versioned}/models?limit=1000`
    : `${versioned}/models`;
}

/**
 * Where a source's listing is read, and how. xAI is asked for `/language-models`, its own richer
 * listing, which carries each model's efforts, default effort, modalities and price; everything else
 * answers on `/models`. A ChatGPT plan is asked of the harness that holds its credential; a Claude
 * plan's harness has no listing, so Anthropic is asked with the plan's own OAuth token.
 */
function listingRequest(
  model: RuntimeModel,
  source: ModelSource,
  environment: Record<string, string | undefined>,
  key: string | null,
): { url: string; headers: Record<string, string> } | null {
  if (source === "chatgpt") {
    const plan = model.plan;
    if (!plan) return null;
    return {
      url: `${plan.endpoint.href.replace(/\/+$/, "")}/models`,
      headers: { "x-openbot-agent-token": plan.token },
    };
  }
  if (source === "claude") {
    /*
     * The plan's own OAuth token, the one `claude setup-token` minted and the harness runs on. Not
     * `plan.token`: that is MANAGED_AGENT_TOKEN, which proves the server to its harness, and sent
     * here Anthropic answered 401, nothing was listed, and no Claude plan had a model picker.
     */
    const oauth = environment.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (!model.plan || !oauth) return null;
    return {
      url: modelsUrl("anthropic", environment),
      headers: {
        authorization: `Bearer ${oauth}`,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ANTHROPIC_OAUTH_BETA,
      },
    };
  }
  if (source === "anthropic")
    return {
      url: modelsUrl("anthropic", environment),
      headers: {
        ...(key ? { "x-api-key": key } : {}),
        "anthropic-version": ANTHROPIC_VERSION,
      },
    };
  const url = modelsUrl("openai", environment);
  return {
    url:
      source === "xai" && hostOf(url) === "api.x.ai"
        ? url.replace(/\/models$/, "/language-models")
        : url,
    headers: key ? { authorization: `Bearer ${key}` } : {},
  };
}

/** OpenBot's own sign-in proxy for Google and xAI, which the Desktop points `OPENAI_BASE_URL` at. */
function signedInThroughProxy(
  environment: Record<string, string | undefined>,
): boolean {
  return /\/api\/model-provider\/v1\/?$/.test(
    environment.OPENAI_BASE_URL?.trim() ?? "",
  );
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * THE MODELS A SIGN-IN CAN USE WHEN NOTHING WILL LIST THEM. A sign-in whose credential may not be
 * allowed to read the provider's listing still runs on the provider's models, and the person still
 * picks among them. Without these, a listing that could not be read left one model and no picker.
 *
 * A Claude plan: Claude Code's own `/model` picker is a set of built-in rows, not a listing (Opus,
 * Sonnet, Haiku, and Fable billed to usage credits; code.claude.com/docs/en/model-config), and
 * Anthropic documents `/v1/models` with an API key: with a plan's OAuth token it is asked, and may
 * refuse. The three every plan includes are offered, as Anthropic's own listing names and describes
 * them. Fable is left out: it is never a
 * plan's default, and on many plans it draws on usage credits rather than the plan.
 *
 * xAI through OpenBot's sign-in: xAI documents `/v1/language-models` for API keys, not for the
 * Grok sign-in's token. The Desktop's own model for that sign-in, and the model third-party Grok
 * sign-ins default to.
 *
 * Used only while nothing better has been read: the first listing that answers replaces them, and a
 * refresh that fails afterwards keeps that listing. The deployment's own model of the same vendor is
 * always among them, so the model somebody named stays theirs.
 */
function signInFallback(
  source: ModelSource,
  environment: Record<string, string | undefined>,
): Entry[] | undefined {
  if (source === "claude")
    return [
      {
        id: "claude-haiku-5-5",
        label: "Claude Haiku 5.5",
        created: seconds("2026-10-07T18:00:00Z"),
        family: "claude-haiku",
        price: 0.1,
        efforts: CLAUDE_EFFORTS,
      },
      {
        id: "claude-sonnet-5-5",
        label: "Claude Sonnet 5.5",
        created: seconds("2026-09-28T00:00:00Z"),
        family: "claude-sonnet",
        price: 2,
        efforts: CLAUDE_EFFORTS,
      },
      {
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        created: seconds("2026-09-21T16:24:00Z"),
        family: "claude-opus",
        price: 4,
        efforts: CLAUDE_EFFORTS,
      },
    ];
  if (source === "xai" && signedInThroughProxy(environment)) {
    const entries: Entry[] = [
      {
        id: "grok-4.7",
        label: "Grok 4.7",
        created: seconds("2026-09-21T00:00:00Z"),
        family: "grok",
        price: 2,
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "high",
      },
      {
        id: "grok-4.3",
        label: "Grok 4.3",
        created: seconds("2026-04-17T00:00:00Z"),
        family: "grok",
        price: 1.25,
        efforts: ["none", "low", "medium", "high", "xhigh"],
        defaultEffort: "low",
      },
    ];
    const named = environment.BOT_MODEL?.trim();
    if (
      named &&
      modelVendor(named) === "xai" &&
      !entries.some((entry) => entry.id === named)
    )
      entries.unshift({ id: named, created: 0, family: "grok" });
    return entries;
  }
  return undefined;
}

/**
 * Whether a listing request would carry OpenBot's own harness token anywhere but the plan's harness.
 * `MANAGED_AGENT_TOKEN` (a plan's `token`) is what the server proves itself to the harness it
 * started with, and no provider, gateway or catalogue is ever sent it, whatever a listing asks for.
 */
function sendsHarnessTokenAway(
  model: RuntimeModel,
  environment: Record<string, string | undefined>,
  asked: { url: string; headers: Record<string, string> },
): boolean {
  const tokens = [model.plan?.token, environment.MANAGED_AGENT_TOKEN]
    .map((token) => token?.trim())
    .filter((token): token is string => !!token);
  const carried = Object.values(asked.headers).some((value) =>
    tokens.some((token) => value.includes(token)),
  );
  if (!carried) return false;
  return (
    !model.plan || new URL(asked.url).origin !== model.plan.endpoint.origin
  );
}

/** Where an effort sits in {@link EFFORT_ORDER}; -1 for none or one nothing says, the weakest. */
function effortRank(effort: string | undefined): number {
  return effort ? (EFFORT_ORDER as readonly string[]).indexOf(effort) : -1;
}

/** Efforts in the order every provider documents them, duplicates and blanks dropped. */
export function orderEfforts(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const value of values)
    if (typeof value === "string" && value.trim())
      seen.add(value.trim().toLowerCase());
  const rank = (effort: string) => {
    const at = (EFFORT_ORDER as readonly string[]).indexOf(effort);
    return at === -1 ? EFFORT_ORDER.length : at;
  };
  return [...seen].sort((a, b) => rank(a) - rank(b));
}

function seconds(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed / 1000 : 0;
  }
  return 0;
}

function pastDate(value: unknown, now: number): boolean {
  if (typeof value !== "string" || !value) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now;
}

/** Anthropic's `capabilities.effort`: an object of levels, each `{ supported }`. */
function anthropicEfforts(capabilities: unknown): string[] | undefined {
  if (!capabilities || typeof capabilities !== "object") return undefined;
  const effort = (capabilities as Record<string, unknown>).effort;
  if (!effort || typeof effort !== "object") return undefined;
  const levels = effort as Record<string, unknown>;
  if (levels.supported === false) return [];
  return orderEfforts(
    Object.entries(levels)
      .filter(
        ([name, level]) =>
          name !== "supported" &&
          !!level &&
          typeof level === "object" &&
          (level as { supported?: unknown }).supported === true,
      )
      .map(([name]) => name),
  );
}

/**
 * Reads a listing in any of the shapes the sources answer with: `data[]` (OpenAI, Anthropic, any
 * gateway, the ChatGPT plan's harness) or `models[]` (xAI's language models, Google's native list),
 * keeping whatever each says about thinking, price and retirement. Skips anything without an id.
 */
export function parseListing(body: unknown, now: number): Entry[] {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  const entries: Entry[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const named =
      typeof item.id === "string"
        ? item.id
        : typeof item.name === "string"
          ? item.name
          : "";
    // Google names its models `models/gemini-…` in both its listings and takes the bare name.
    const id = named.replace(/^models\//, "");
    if (!id) continue;
    const label = [item.display_name, item.displayName, item.label].find(
      (value): value is string => typeof value === "string" && !!value,
    );
    const capabilities = item.capabilities as
      | Record<string, unknown>
      | undefined;
    const efforts = Array.isArray(item.efforts)
      ? orderEfforts(item.efforts)
      : Array.isArray(capabilities?.reasoning_effort)
        ? orderEfforts(capabilities.reasoning_effort as unknown[])
        : anthropicEfforts(capabilities);
    const defaultEffort = [
      item.default_effort,
      capabilities?.default_reasoning_effort,
    ].find((value): value is string => typeof value === "string" && !!value);
    const outputs = item.output_modalities;
    const methods = item.supportedGenerationMethods;
    const price =
      typeof item.prompt_text_token_price === "number"
        ? // xAI prices in ten-thousandths of a dollar per million tokens.
          item.prompt_text_token_price / 10_000
        : undefined;
    entries.push({
      id,
      ...(label ? { label } : {}),
      created: seconds(item.created ?? item.created_at),
      // Anthropic's own name for a line (`sonnet`), spelt as models.dev spells the family.
      ...(typeof item.line === "string" && item.line
        ? { family: `claude-${item.line}` }
        : {}),
      ...(price !== undefined ? { price } : {}),
      ...(efforts ? { efforts } : {}),
      ...(defaultEffort && efforts?.includes(defaultEffort.toLowerCase())
        ? { defaultEffort: defaultEffort.toLowerCase() }
        : {}),
      ...((Array.isArray(outputs) && !outputs.includes("text")) ||
      (Array.isArray(methods) && !methods.includes("generateContent"))
        ? { chat: false }
        : {}),
      ...(pastDate(item.shutdown_date, now) ||
      pastDate(item.retires_at, now) ||
      item.lifecycle === "retired"
        ? { retired: true }
        : {}),
    });
  }
  return entries;
}

/** What models.dev says about one model: only the fields this file reads. */
export type Capability = {
  name?: string;
  family?: string;
  price?: number;
  efforts?: string[];
  tools?: boolean;
  text?: boolean;
  released?: number;
};

/** models.dev's catalogue, by `vendor/id`, for the four vendors a deployment can name directly. */
export type Capabilities = Map<string, Capability>;

const CAPABILITY_VENDORS = ["openai", "anthropic", "google", "xai"];

/** Reads models.dev's `api.json`. Anything malformed is skipped, never thrown. */
export function parseCapabilities(body: unknown): Capabilities {
  const found: Capabilities = new Map();
  if (!body || typeof body !== "object") return found;
  for (const vendor of CAPABILITY_VENDORS) {
    const models = (body as Record<string, { models?: unknown }>)[vendor]
      ?.models;
    if (!models || typeof models !== "object") continue;
    for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const model = raw as Record<string, unknown>;
      const options = Array.isArray(model.reasoning_options)
        ? (model.reasoning_options as Record<string, unknown>[])
        : [];
      const effort = options.find((option) => option?.type === "effort");
      const outputs = (model.modalities as { output?: unknown } | undefined)
        ?.output;
      const cost = model.cost as { input?: unknown } | undefined;
      found.set(`${vendor}/${id}`, {
        ...(typeof model.name === "string" ? { name: model.name } : {}),
        ...(typeof model.family === "string" ? { family: model.family } : {}),
        ...(typeof cost?.input === "number" ? { price: cost.input } : {}),
        ...(effort && Array.isArray(effort.values)
          ? { efforts: orderEfforts(effort.values) }
          : model.reasoning === false
            ? { efforts: [] }
            : {}),
        ...(typeof model.tool_call === "boolean"
          ? { tools: model.tool_call }
          : {}),
        ...(Array.isArray(outputs) ? { text: outputs.includes("text") } : {}),
        ...(typeof model.release_date === "string"
          ? { released: seconds(model.release_date) }
          : {}),
      });
    }
  }
  return found;
}

/**
 * The middle of a provider's current line: the newest model of each line (family) that is still
 * current, ordered by price, and the one in the middle, the lower of the two when there are even.
 * GPT-6.1 Terra between Luna and Sol, Sonnet between Haiku and Opus, Flash between Flash-Lite and
 * Pro. Undefined when nothing carries a family and a price, which is when the caller falls back to
 * the configured model.
 */
export function middleModel(
  entries: readonly Pick<Entry, "id" | "created" | "family" | "price">[],
): string | undefined {
  const heads = new Map<string, (typeof entries)[number]>();
  const alias = (id: string) => /(-latest|preview)/i.test(id);
  for (const entry of entries) {
    if (!entry.family || entry.price === undefined) continue;
    const head = heads.get(entry.family);
    // A dated or numbered model over a moving alias or a preview of the same line.
    const better =
      !head ||
      (alias(head.id) && !alias(entry.id)) ||
      (alias(head.id) === alias(entry.id) &&
        (entry.created > head.created ||
          (entry.created === head.created && entry.id < head.id)));
    if (better) heads.set(entry.family, entry);
  }
  if (heads.size === 0) return undefined;
  const newest = Math.max(...[...heads.values()].map((head) => head.created));
  const current = [...heads.values()]
    .filter((head) => newest - head.created <= CURRENT_LINE_SECONDS)
    .sort(
      (a, b) =>
        (a.price ?? 0) - (b.price ?? 0) ||
        b.created - a.created ||
        a.id.localeCompare(b.id),
    );
  return current[Math.floor((current.length - 1) / 2)]?.id;
}

type Snapshot = {
  entries: Entry[];
  /** When the listing was read, in ms. */
  at: number;
};

export function createModelCatalogue(options: {
  model: RuntimeModel;
  /** The deployment's model key, resolved per read so a rotated credential is used next time. */
  apiKey: () => Promise<string | null>;
  /**
   * The models an admin allowed people to pick, read on every call so a change applies at once.
   * Given for a team: people pick among these, and until there are any they get the default only.
   * Absent for one person on their own machine, who picks from everything the credential lists.
   */
  allowlist?: () => Allowlist | undefined;
  environment?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  now?: () => number;
  /** How often the listing and capability data are read again. See {@link REFRESH_MS}. */
  refreshMs?: number;
  timeoutMs?: number;
  /**
   * Where capability data is read: models.dev unless `OPENBOT_MODEL_CAPABILITIES_URL` says
   * otherwise. `off` (or null here) reads none, which leaves each provider's own data.
   */
  capabilitiesUrl?: string | null;
}) {
  const environment = options.environment ?? process.env;
  const request = options.fetch ?? fetch;
  const log = options.log ?? ((line: string) => console.warn(line));
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? REFRESH_MS;
  const { provider, defaultModel } = options.model;
  const source = modelSourceFor(options.model, environment);
  const vendor = sourceVendor(source);
  const fallback = signInFallback(source, environment);
  const capabilitiesUrl = (() => {
    const configured =
      options.capabilitiesUrl === undefined
        ? environment.OPENBOT_MODEL_CAPABILITIES_URL?.trim() || MODELS_DEV
        : options.capabilitiesUrl;
    return !configured || configured === "off" ? null : configured;
  })();

  let snapshot: Snapshot | undefined;
  let attemptedAt: number | undefined;
  let capabilities: { data: Capabilities; at: number } | undefined;
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function readListing(): Promise<Entry[] | null> {
    try {
      const key =
        source === "chatgpt" || source === "claude"
          ? null
          : await options.apiKey();
      const asked = listingRequest(options.model, source, environment, key);
      if (!asked) return null;
      if (sendsHarnessTokenAway(options.model, environment, asked)) {
        log(
          JSON.stringify({
            type: "model-list-unreadable",
            source,
            reason: "harness-token-elsewhere",
          }),
        );
        return null;
      }
      const response = await request(asked.url, {
        headers: asked.headers,
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        log(
          JSON.stringify({
            type: "model-list-unreadable",
            source,
            status: response.status,
          }),
        );
        return null;
      }
      return parseListing(await response.json(), now());
    } catch (error) {
      log(
        JSON.stringify({
          type: "model-list-unreadable",
          source,
          // The name only: a fetch error can carry the URL, and an SDK error can carry headers.
          reason: error instanceof Error ? error.name : "unknown",
        }),
      );
      return null;
    }
  }

  async function readCapabilities(): Promise<void> {
    if (!capabilitiesUrl) return;
    if (capabilities && now() - capabilities.at < refreshMs) return;
    try {
      const response = await request(capabilitiesUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(options.timeoutMs ?? 0, 20_000)),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      const data = parseCapabilities(await response.json());
      // An answer that names none of the four vendors is a broken mirror, not news.
      if (data.size === 0) throw new Error("empty");
      capabilities = { data, at: now() };
    } catch (error) {
      // The last good copy keeps serving; without one, each provider's own data still applies.
      log(
        JSON.stringify({
          type: "model-capabilities-unreadable",
          reason: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  }

  /** Read both again. Single flight; a failure keeps the last good answer. */
  function refresh(): Promise<void> {
    inFlight ??= (async () => {
      attemptedAt = now();
      const [entries] = await Promise.all([readListing(), readCapabilities()]);
      if (entries) snapshot = { entries, at: now() };
      else if (!snapshot && fallback) {
        // Nothing listed yet, and this sign-in may never be allowed to: its own models stand in,
        // and the listing is asked again on the schedule.
        snapshot = { entries: fallback, at: now() };
        log(JSON.stringify({ type: "model-list-fallback", source }));
      }
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  /**
   * The last good listing, read once at the start and otherwise only behind the schedule. A run or a
   * picker opening never waits on a provider, except the very first read after boot.
   */
  async function current(): Promise<Snapshot | undefined> {
    if (!snapshot) {
      // The first read is under way (the one `start` begins at boot): wait for it rather than
      // answer with nothing, which hid the picker and ran the configured model.
      if (inFlight) await inFlight;
      // Never read, or every read so far failed: ask again, but not on every message.
      else if (attemptedAt === undefined || now() - attemptedAt >= RETRY_MS)
        await refresh();
      return snapshot;
    }
    // Without the timer (a test, or a timer the process never started), stale still refreshes in
    // the background while the stale answer is served.
    if (
      now() - snapshot.at >= refreshMs &&
      !inFlight &&
      (attemptedAt === undefined || now() - attemptedAt >= RETRY_MS)
    )
      void refresh();
    return snapshot;
  }

  /** One entry with what the capability catalogue adds, and whether a Bot can chat on it. */
  function enrich(entry: Entry): Entry & { usable: boolean } {
    const bare = entry.id.split("/").at(-1) ?? entry.id;
    const namedVendor = vendor ?? modelVendor(entry.id);
    const known = namedVendor
      ? capabilities?.data.get(`${namedVendor}/${bare}`)
      : undefined;
    // A gateway's names are its operator's, shown as they are; a provider named directly is named
    // as the catalogue names it where the provider's own listing does not.
    const label =
      entry.label ??
      (source === "gateway" || /^gpt-/i.test(bare)
        ? modelLabel(entry.id)
        : (known?.name ?? undefined));
    const efforts = entry.efforts ?? known?.efforts;
    const created = entry.created || known?.released || 0;
    const chat =
      entry.chat !== false && known?.tools !== false && known?.text !== false;
    const usable =
      !entry.retired &&
      chat &&
      (source === "openai"
        ? chatModelIds([entry.id], { officialOpenAI: true }).length === 1
        : source === "gateway"
          ? chatModelIds([entry.id], { officialOpenAI: false }).length === 1
          : !NEVER_CHAT.test(entry.id) && !VENDOR_NOT_FOR_BOTS.test(entry.id));
    return {
      ...entry,
      ...(label ? { label } : {}),
      created,
      ...((entry.family ?? known?.family)
        ? { family: entry.family ?? known?.family }
        : {}),
      ...((entry.price ?? known?.price) !== undefined
        ? { price: entry.price ?? known?.price }
        : {}),
      ...(efforts && efforts.length > 0 ? { efforts } : { efforts: undefined }),
      usable,
    };
  }

  function option(
    entry: Pick<Entry, "id" | "label" | "efforts" | "defaultEffort">,
  ): ModelOption {
    const madeBy = modelVendor(entry.id) ?? vendor;
    return {
      id: entry.id,
      label: entry.label ?? modelLabel(entry.id),
      ...(madeBy ? { vendor: madeBy } : {}),
      ...(entry.efforts && entry.efforts.length > 0
        ? { efforts: entry.efforts }
        : {}),
      ...(entry.defaultEffort && entry.efforts?.includes(entry.defaultEffort)
        ? { defaultEffort: entry.defaultEffort }
        : {}),
    };
  }

  /** The configured model, as an option, with whatever the capability data knows about it. */
  function configured(): ModelOption {
    return option(enrich({ id: defaultModel, created: 0 }));
  }

  const exposure: ModelExposure = options.allowlist ? "allowed" : "all";

  /**
   * The listing, newest first, and its default. In a team, narrowed to the models an admin allowed
   * unless `everything`, which is what the admin allows them from. The default is the same either
   * way and always offered. Null when nothing was ever read.
   */
  async function offered(
    everything: boolean,
  ): Promise<{ models: ModelOption[]; default: string } | null> {
    const found = await current();
    if (!found) return null;

    const usable = found.entries
      .map(enrich)
      .filter((entry) => entry.usable)
      .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
    let models = usable.map(option);
    const listed = models.some((model) => model.id === defaultModel);
    /*
     * THE OPERATOR'S MODEL WINS. A model somebody named (`BOT_MODEL`, the Desktop setup screen) is
     * the default while the credential lists it; so is a gateway's, whose list mixes every vendor
     * it routes, where one vendor's middle means nothing. Only a model nobody named, or one the
     * credential does not list (a ChatGPT plan given gpt-5.5), gives way to the middle of the
     * provider's current line.
     */
    const kept = listed && (options.model.pinned || source === "gateway");
    const middle = kept ? undefined : middleModel(usable);
    let chosen = middle ?? (listed ? defaultModel : undefined);
    if (!chosen) {
      // Nothing says where the middle is and the configured model is not listed. For a plan or a
      // provider named directly, the configured model is the stale one this exists to replace, so
      // the newest listed model stands in; a gateway's operator named theirs on purpose.
      const newest = models[0];
      if (newest && source !== "gateway") chosen = newest.id;
      else {
        models = [configured(), ...models];
        chosen = defaultModel;
      }
    }
    /*
     * A team picks among what an admin allowed, and the default. A model the provider no longer
     * lists drops out of what is offered on its own, whatever the allowed list still says, and a
     * pick saved on it runs on the default.
     */
    if (!everything && options.allowlist) {
      const allowed = new Set(options.allowlist()?.models ?? []);
      const kept = chosen;
      models = models.filter(
        (model) => model.id === kept || allowed.has(`${provider}/${model.id}`),
      );
    }
    return { models, default: chosen };
  }

  async function read(): Promise<ModelCatalogue> {
    const found = await offered(false);
    if (!found)
      return {
        provider,
        source,
        exposure,
        default: defaultModel,
        models: [configured()],
        choosable: false,
      };
    return {
      provider,
      source,
      exposure,
      default: found.default,
      models: found.models,
      choosable: found.models.length > 1,
    };
  }

  /**
   * Every model the listing offers, whatever an admin allowed, for an admin to allow them from. Only the deployment's own model when the listing cannot be read.
   */
  async function available(): Promise<AvailableModels> {
    const found = await offered(true);
    return {
      provider,
      source,
      exposure,
      default: found?.default ?? defaultModel,
      models: found?.models ?? [configured()],
      listed: found !== null,
    };
  }

  /**
   * What a run answers on, given what the person saved: their model when it is still offered,
   * otherwise the default, and their effort only when that model takes it. Never a model the
   * catalogue does not offer, never an effort the model does not take.
   */
  async function choose(
    saved: { model?: string | null; effort?: string | null } | null | undefined,
    /**
     * The effort to use when the person picked none: sent only when the model takes it and thinks
     * less than that on its own default. A routine runs at `high`, because nobody is watching it
     * and models stop early more often at `low` and `medium`.
     */
    atLeast?: (typeof EFFORT_ORDER)[number],
  ): Promise<RunChoice> {
    const catalogue = await read();
    const listed = snapshot !== undefined;
    const pick = saved?.model
      ? catalogue.models.find((model) => model.id === saved.model)
      : undefined;
    const model =
      pick ?? catalogue.models.find((entry) => entry.id === catalogue.default);
    const id = model?.id ?? catalogue.default;
    const effort =
      saved?.effort && model?.efforts?.includes(saved.effort)
        ? saved.effort
        : atLeast &&
            model?.efforts?.includes(atLeast) &&
            effortRank(model.defaultEffort) < effortRank(atLeast)
          ? atLeast
          : undefined;
    return {
      model: id,
      label: model?.label ?? modelLabel(id),
      ...(effort ? { effort } : {}),
      listed,
    };
  }

  let lastEarly = Number.NEGATIVE_INFINITY;
  const unsubscribe = onModelRejected(() => {
    if (now() - lastEarly < EARLY_REFRESH_MS) return;
    lastEarly = now();
    log(JSON.stringify({ type: "model-list-refresh-early", source }));
    void refresh();
  });

  return {
    source,
    read,
    available,
    choose,
    /** Read the listing and capability data again now. Resolves once both have been tried. */
    refresh,
    /** Whether a run may use this model: only ever one this catalogue would offer. */
    async allows(id: string): Promise<boolean> {
      const catalogue = await read();
      return catalogue.models.some((model) => model.id === id);
    },
    /** The efforts one offered model takes, or none. */
    async effortsFor(id: string): Promise<string[]> {
      const catalogue = await read();
      return catalogue.models.find((model) => model.id === id)?.efforts ?? [];
    },
    /**
     * Read at once, then every `refreshMs`, in the background. The timer never holds the process
     * open. Returns a stop for tests and shutdown.
     */
    start(): () => void {
      void refresh();
      timer ??= setInterval(() => void refresh(), refreshMs);
      timer.unref?.();
      return () => {
        if (timer) clearInterval(timer);
        timer = undefined;
        unsubscribe();
      };
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
