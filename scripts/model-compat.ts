/**
 * Does every model the picker offers still answer through the clients OpenBot ships?
 *
 * A harness image carries its own model client at a fixed version: the Claude Agent SDK harness
 * bundles a Claude Code CLI, the LangGraph harness sends the ChatGPT plan's Codex backend a fixed
 * client version, and every other harness carries the provider SDKs (LiteLLM, LangChain, the AI
 * SDK, ...) it was built with. A provider can start refusing a model to an older client ("Claude
 * Code 2.1.259 does not support this model; version 2.1.290 or newer is required") while the picker,
 * which lists models live, keeps offering it. Nothing else calls today's models through the
 * published images, so this does, once per model:
 *
 *   1. Lists each provider's models from the same source, with the same filter, as the picker
 *      (docs/configuration.md, "The model list").
 *   2. Starts each harness image on that provider, as the Desktop's settings would, and sends it
 *      one AG-UI run per model. The harness's own client makes the call, at the version that image
 *      ships. `latest` is the published image people run (ghcr.io/copilotkit/openbot-<harness>);
 *      `source` is the image built from this checkout, which shows whether a bumped pin fixed it.
 *   3. Checks the ChatGPT plan's Codex client version in each image against the minimum each
 *      listed Codex model needs, from openai/codex's published model catalogue. A plan sign-in
 *      cannot run here, and the plan's version gate is a fact about the client version.
 *
 * A Claude plan runs through the same bundled CLI as an Anthropic key, so the key's rows cover it.
 *
 * Keys come from the environment (or --env-file), one per provider: ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY. A provider with no key is reported as skipped,
 * not failed. Keys are never printed: every detail is scrubbed of them.
 *
 * What passed on the `source` image becomes the model lock (shared/model-lock.ts): the models
 * the picker may offer for each harness. `lock` writes it from the results; `guard` fails when a
 * model the lock verifies no longer answers, for a pull request that changes a harness's client.
 *
 *   bun scripts/model-compat.ts [--env-file .env] [--harness agent-claude-sdk,...]
 *     [--provider anthropic,...] [--model <regex>] [--tags latest,source] [--concurrency 6]
 *     [--out results.json] [--exit-zero]
 *   bun scripts/model-compat.ts report --summary <file> [--issue <file>] results/*.json
 *   bun scripts/model-compat.ts lock [--lock shared/model-lock.json] [--date YYYY-MM-DD] results/*.json
 *   bun scripts/model-compat.ts guard [--lock shared/model-lock.json] [--summary <file>] results/*.json
 *   bun scripts/model-compat.ts harnesses
 *
 * The harnesses it runs are the published ones and every engine the lock names, published or not
 * yet (`harnesses` prints them, for the workflows' matrix). An engine is put in the lock with its
 * providers' pairs empty before its first release, so nothing is offered on it until it has
 * passed here: the LangGraph (TypeScript) engine, agent-langgraph-ts, starts that way.
 *
 * Needs Docker. Exits 1 when anything failed (unless --exit-zero); `report` merges the results of
 * several runs, writes the Markdown summary, and exits 1 when any of them failed. `lock` exits 0,
 * and says whether the lock changed. `guard` exits 1 when a verified model failed.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  LockedEngine,
  LockProvider,
  ModelLock,
} from "../shared/model-lock";

const ROOT = join(import.meta.dir, "..");
const REGISTRY = "ghcr.io/copilotkit/openbot-";
const SOURCE = "source";
const MODELS_DEV = "https://models.dev/api.json";
const CODEX_CATALOGUE =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
const PROMPT = "Reply with the single word OK.";
/** One tool the prompt has no use for, so the request takes the client's tool path. */
const PROBE_TOOL = {
  name: "look_up_order",
  description: "Look up the status of an order by its number.",
  parameters: {
    type: "object",
    properties: { order: { type: "string", description: "The order number." } },
    required: ["order"],
  },
};
const RUN_TIMEOUT_MS = 300_000;
const START_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------------------------
// The picker's list. These rules are the ones the server's model catalogue applies, so this offers
// what a person can pick: the provider's own listing, minus what no Bot can chat on.
// ---------------------------------------------------------------------------------------------

export type Source = "openai" | "anthropic" | "google" | "xai" | "gateway";

/** Models no chat can run on, by any provider or gateway's naming. */
const NEVER_CHAT =
  /(embed|tts|whisper|transcribe|dall-e|image|moderation|realtime|audio|sora|translate|video|lyria|imagen|veo-|(^|[-/])live([-.]|$))/i;
/** Chat models in OpenAI's listing a Bot is still not put on. */
const OPENAI_NOT_FOR_BOTS =
  /(search|deep-research|computer-use|chat-latest|codex|instruct|^gpt-live|^gpt-(3\.5|4)(-|$)|^o1(-|$)|^(babbage|davinci))/i;
/** The same, for the other providers a deployment names directly. */
const VENDOR_NOT_FOR_BOTS =
  /(deep-research|computer-use|robotics|antigravity|nano-banana|multi-agent|(^|-)aqa$)/i;
/** OpenAI's dated snapshots, which repeat a model already listed under its own name. */
const DATED_SNAPSHOT = /-(\d{4}-\d{2}-\d{2}|\d{4})$/;

const VENDOR_FAMILIES: readonly [RegExp, string][] = [
  [/^(gpt-|o\d|chatgpt-)/i, "openai"],
  [/^claude/i, "anthropic"],
  [/^(gemini|gemma)/i, "google"],
  [/^grok/i, "xai"],
];

function modelVendor(id: string): string | undefined {
  const slash = id.indexOf("/");
  if (slash > 0) return id.slice(0, slash).toLowerCase().replace(/^~/, "");
  return VENDOR_FAMILIES.find(([family]) => family.test(id))?.[1];
}

function chatModel(id: string, officialOpenAI: boolean): boolean {
  if (NEVER_CHAT.test(id)) return false;
  if (!officialOpenAI) return true;
  return (
    /^(gpt-|o\d)/i.test(id) &&
    !OPENAI_NOT_FOR_BOTS.test(id) &&
    !DATED_SNAPSHOT.test(id)
  );
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

/** What models.dev says a model can do, by `vendor/id`. */
export type Capabilities = Map<
  string,
  { tools?: boolean; text?: boolean; released?: number }
>;

export function parseCapabilities(body: unknown): Capabilities {
  const found: Capabilities = new Map();
  if (!body || typeof body !== "object") return found;
  for (const vendor of ["openai", "anthropic", "google", "xai"]) {
    const models = (body as Record<string, { models?: unknown }>)[vendor]
      ?.models;
    if (!models || typeof models !== "object") continue;
    for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const model = raw as Record<string, unknown>;
      const outputs = (model.modalities as { output?: unknown } | undefined)
        ?.output;
      found.set(`${vendor}/${id}`, {
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

/** The models the picker offers from one listing, newest first. */
export function usableModels(
  source: Source,
  body: unknown,
  capabilities: Capabilities,
  now: number,
): string[] {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  const vendorOfSource = source === "gateway" ? undefined : source;
  const usable: { id: string; created: number }[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const named =
      typeof item.id === "string"
        ? item.id
        : typeof item.name === "string"
          ? item.name
          : "";
    const id = named.replace(/^models\//, "");
    if (!id) continue;
    const outputs = item.output_modalities;
    const methods = item.supportedGenerationMethods;
    const notChat =
      (Array.isArray(outputs) && !outputs.includes("text")) ||
      (Array.isArray(methods) && !methods.includes("generateContent"));
    const retired =
      pastDate(item.shutdown_date, now) ||
      pastDate(item.retires_at, now) ||
      item.lifecycle === "retired";
    const bare = id.split("/").at(-1) ?? id;
    const vendor = vendorOfSource ?? modelVendor(id);
    const known = vendor ? capabilities.get(`${vendor}/${bare}`) : undefined;
    const chat = !notChat && known?.tools !== false && known?.text !== false;
    const offered =
      !retired &&
      chat &&
      (source === "openai"
        ? chatModel(id, true)
        : source === "gateway"
          ? chatModel(id, false)
          : !NEVER_CHAT.test(id) && !VENDOR_NOT_FOR_BOTS.test(id));
    if (offered)
      usable.push({
        id,
        created:
          seconds(item.created ?? item.created_at) || known?.released || 0,
      });
  }
  return usable
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
    .map((entry) => entry.id);
}

// ---------------------------------------------------------------------------------------------
// Providers and harnesses.
// ---------------------------------------------------------------------------------------------

/** A row of shared/harnesses.json, the fields this reads. */
export type Harness = {
  image: string | null;
  credential: string;
  port: number | null;
  runPath: string;
};

export type ProviderId = "openai" | "anthropic" | "google" | "xai";

export type Provider = {
  id: ProviderId;
  label: string;
  /** The repository secret, and the environment variable, that holds this provider's key. */
  secret: string;
  source: Source;
  /** The OpenAI-compatible address the Desktop writes as OPENAI_BASE_URL for this provider. */
  baseUrl?: string;
  listing: (key: string) => { url: string; headers: Record<string, string> };
  /** The environment a harness is started with on this provider, as the Desktop writes it. */
  harnessEnv: (key: string, harness: Harness) => Record<string, string>;
};

function compatible(baseUrl: string): Pick<Provider, "baseUrl" | "harnessEnv"> {
  return {
    baseUrl,
    harnessEnv: (key) => ({
      OPENAI_API_KEY: key,
      OPENAI_BASE_URL: baseUrl,
      BOT_PROVIDER: "openai",
    }),
  };
}

function listedAt(url: string) {
  return (key: string) => ({
    url,
    headers: { authorization: `Bearer ${key}` },
  });
}

export const PROVIDERS: readonly Provider[] = [
  {
    id: "openai",
    label: "OpenAI",
    secret: "OPENAI_API_KEY",
    source: "openai",
    listing: listedAt("https://api.openai.com/v1/models"),
    harnessEnv: (key) => ({ OPENAI_API_KEY: key, BOT_PROVIDER: "openai" }),
  },
  {
    id: "anthropic",
    label: "Anthropic",
    secret: "ANTHROPIC_API_KEY",
    source: "anthropic",
    listing: (key) => ({
      url: "https://api.anthropic.com/v1/models?limit=1000",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    }),
    harnessEnv: (key) => ({
      ANTHROPIC_API_KEY: key,
      BOT_PROVIDER: "anthropic",
    }),
  },
  {
    id: "google",
    label: "Google",
    secret: "GEMINI_API_KEY",
    source: "google",
    listing: listedAt(
      "https://generativelanguage.googleapis.com/v1beta/openai/models",
    ),
    ...compatible("https://generativelanguage.googleapis.com/v1beta/openai/"),
    // Antigravity is pinned to Gemini's own API and reads the key under Google's name.
    harnessEnv: (key, harness) =>
      harness.credential === "google"
        ? { GOOGLE_API_KEY: key }
        : compatible(
            "https://generativelanguage.googleapis.com/v1beta/openai/",
          ).harnessEnv(key, harness),
  },
  {
    id: "xai",
    label: "xAI",
    secret: "XAI_API_KEY",
    source: "xai",
    listing: listedAt("https://api.x.ai/v1/language-models"),
    ...compatible("https://api.x.ai/v1"),
  },
];

/**
 * Providers the Desktop offers by address that this check leaves out on purpose, with why. A
 * gateway serves its own aliases, not a provider's models, so the lock has nothing to say about
 * it and leaves its models open.
 */
export const NOT_CHECKED: readonly { baseUrl: string; why: string }[] = [
  {
    baseUrl: "https://api.unbiased.ai/v1",
    why: "Unbiased AI is a gateway serving its own `pareto` model, not a provider's listing",
  },
  {
    baseUrl: "https://api.trustedrouter.com/v1",
    why: "TrustedRouter is a gateway in front of many providers, not a provider's own listing",
  },
];

function provider(id: string): Provider {
  const found = PROVIDERS.find((row) => row.id === id);
  if (!found) throw new Error(`No provider ${id}`);
  return found;
}

/** The providers a harness can run on, by the credential shared/harnesses.json gives it. */
export function providersFor(harness: Harness): ProviderId[] {
  if (!harness.image || !harness.port) return [];
  switch (harness.credential) {
    case "anthropic":
      return ["anthropic"];
    case "google":
      return ["google"];
    case "any-provider":
      return PROVIDERS.map((row) => row.id);
    default:
      return [];
  }
}

/**
 * The harnesses the check runs: every published harness, and every engine the model lock names
 * whether it is published yet or not. An engine the lock names offers a model only once it has
 * passed here, so it is checked from before its first release (its `source` image, built from this
 * checkout; a `latest` that isn't published yet is an inconclusive row). A lock entry with no row
 * in shared/harnesses.json has nothing to start, so it is not run. `only` narrows to the named
 * image directories.
 */
export function probedHarnesses(
  known: readonly Harness[],
  published: readonly string[],
  lock: ModelLock | undefined,
  only?: readonly string[],
): Harness[] {
  const locked = Object.keys(lock?.engines ?? {});
  return known.filter(
    (row) =>
      !!row.image &&
      (published.includes(row.image) || locked.includes(row.image)) &&
      (!only || only.includes(row.image)),
  );
}

function readProbed(only?: readonly string[]): Harness[] {
  const published: string[] = JSON.parse(
    readFileSync(join(ROOT, ".github/published-images.json"), "utf8"),
  );
  const { harnesses } = JSON.parse(
    readFileSync(join(ROOT, "shared/harnesses.json"), "utf8"),
  ) as { harnesses: Harness[] };
  const lockPath = join(ROOT, "shared/model-lock.json");
  const lock = existsSync(lockPath)
    ? (JSON.parse(readFileSync(lockPath, "utf8")) as ModelLock)
    : undefined;
  return probedHarnesses(harnesses, published, lock, only);
}

export type Listing = { models: string[] } | { error: string };

export type MatrixRow =
  | {
      kind: "run";
      harness: Harness;
      tag: string;
      provider: ProviderId;
      model: string;
    }
  | { kind: "no-key"; harness: Harness; provider: ProviderId }
  | {
      kind: "listing-failed";
      harness: Harness;
      provider: ProviderId;
      detail: string;
    };

/**
 * One run per harness, image tag and listed model. A provider with no key is one skipped row per
 * harness, and a listing that failed one failed row, since there are no models to name.
 */
export function buildMatrix(options: {
  harnesses: readonly Harness[];
  tags: readonly string[];
  listings: ReadonlyMap<string, Listing>;
}): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const harness of options.harnesses) {
    for (const id of providersFor(harness)) {
      const listing = options.listings.get(id);
      if (!listing) rows.push({ kind: "no-key", harness, provider: id });
      else if ("error" in listing)
        rows.push({
          kind: "listing-failed",
          harness,
          provider: id,
          detail: listing.error,
        });
      else
        for (const tag of options.tags)
          for (const model of listing.models)
            rows.push({ kind: "run", harness, tag, provider: id, model });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Reading a run.
// ---------------------------------------------------------------------------------------------

export type Outcome = { status: "pass" | "fail"; detail: string };

function oneLine(text: string, limit = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

function errorText(event: Record<string, unknown>): string {
  if (typeof event.message === "string" && event.message) return event.message;
  const raw = event.rawEvent as Record<string, unknown> | undefined;
  for (const field of ["content", "error", "message"]) {
    const value = raw?.[field];
    if (typeof value === "string" && value) return value;
  }
  return JSON.stringify(event);
}

/** Pass when the harness streamed a reply that says OK; otherwise fail, in the provider's words. */
export function classifyRun(response: {
  status: number;
  body: string;
}): Outcome {
  if (response.status !== 200)
    return {
      status: "fail",
      detail: `HTTP ${response.status}: ${oneLine(response.body)}`,
    };
  let streamed = "";
  // Some bridges (CrewAI's) send the reply only as the conversation's new state.
  let snapshot = "";
  let finished = false;
  let calledTool = false;
  for (const line of response.body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    if (event.type === "RUN_ERROR")
      return { status: "fail", detail: oneLine(errorText(event)) };
    if (
      (event.type === "TEXT_MESSAGE_CONTENT" ||
        event.type === "TEXT_MESSAGE_CHUNK") &&
      typeof event.delta === "string"
    )
      streamed += event.delta;
    if (event.type === "MESSAGES_SNAPSHOT" && Array.isArray(event.messages)) {
      const last = event.messages.at(-1) as
        | { role?: unknown; content?: unknown }
        | undefined;
      snapshot =
        last?.role === "assistant" && typeof last.content === "string"
          ? last.content
          : "";
    }
    if (event.type === "TOOL_CALL_START") calledTool = true;
    if (event.type === "RUN_FINISHED") finished = true;
  }
  return judgeReply(
    streamed || snapshot,
    calledTool
      ? "the model called the probe's tool instead of replying"
      : finished
        ? "the run finished without a reply"
        : "the stream ended without finishing the run",
  );
}

/**
 * A model's own reasoning left in its reply, which a person would read as the Bot's answer: the
 * Gemma 4 models, through the LangGraph (TypeScript) engine, answered "<thought>…</thought>OK".
 */
const REASONING_IN_REPLY = /<\/?(thought|think|thinking|reasoning)>/i;

export function judgeReply(text: string, silence: string): Outcome {
  if (REASONING_IN_REPLY.test(text))
    return {
      status: "fail",
      detail: `answered with its reasoning in the reply text: ${oneLine(text, 160)}`,
    };
  if (/\bok(ay)?\b/i.test(text))
    return { status: "pass", detail: oneLine(text, 80) };
  if (text)
    return { status: "fail", detail: `answered without OK: ${oneLine(text)}` };
  return { status: "fail", detail: silence };
}

/**
 * Mastra serves no AG-UI route: OpenBot reaches it through Mastra's own agent API, so its run is a
 * `generate` call on that API, answered with the reply's `text` or an `error`.
 */
export function classifyMastra(response: {
  status: number;
  body: string;
}): Outcome {
  let parsed: { text?: unknown; error?: unknown; message?: unknown } = {};
  try {
    parsed = JSON.parse(response.body);
  } catch {
    // Not JSON: reported as it is, below.
  }
  if (response.status !== 200) {
    const said = [parsed.error, parsed.message].find(
      (value): value is string => typeof value === "string" && !!value,
    );
    return {
      status: "fail",
      detail: `HTTP ${response.status}: ${oneLine(said ?? response.body)}`,
    };
  }
  return judgeReply(
    typeof parsed.text === "string" ? parsed.text : "",
    "the agent answered without text",
  );
}

// ---------------------------------------------------------------------------------------------
// The ChatGPT plan's version gate.
// ---------------------------------------------------------------------------------------------

function versionParts(version: string): number[] {
  return version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** Each model the Codex picker lists, against the client version the harness sends the plan. */
export function codexGate(
  clientVersion: string,
  catalogue: unknown,
): { model: string; status: "pass" | "fail"; detail: string }[] {
  const models = (catalogue as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  return models
    .filter(
      (row): row is { slug: string; minimal_client_version?: string } =>
        !!row && row.visibility === "list" && typeof row.slug === "string",
    )
    .map((row) => {
      const needs = row.minimal_client_version ?? "0.0.0";
      return {
        model: row.slug,
        status: compareVersions(clientVersion, needs) >= 0 ? "pass" : "fail",
        detail: `needs Codex ${needs}, harness sends ${clientVersion}`,
      };
    });
}

// ---------------------------------------------------------------------------------------------
// Results.
// ---------------------------------------------------------------------------------------------

export type Result = {
  harness: string;
  tag: string;
  /** What a person reads: "Anthropic (key or Claude plan)", "ChatGPT plan". */
  provider: string;
  /** What the lock files it under. */
  providerId: LockProvider;
  model: string;
  status: "pass" | "fail" | "skipped";
  detail: string;
};

/** One results file: the rows, and the model clients each image carried. */
export type Results = {
  results: Result[];
  /** By harness, then image tag: package name to version. */
  clients?: Record<string, Record<string, Record<string, string>>>;
};

function cell(text: string): string {
  return oneLine(text).replace(/\|/g, "\\|");
}

export function renderTable(results: readonly Result[]): string {
  const lines = [
    "| Harness | Image | Provider | Model | Result | Provider's answer |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of results)
    lines.push(
      `| ${cell(row.harness)} | ${cell(row.tag)} | ${cell(row.provider)} | ${cell(row.model)} | ${row.status} | ${cell(row.detail)} |`,
    );
  return lines.join("\n");
}

const ORDER = { fail: 0, skipped: 1, pass: 2 } as const;

/**
 * The summary: what failed first, then what was skipped for want of a key, then what passed. The
 * issue's copy leaves out what passed and keeps at most `maxFailed` failures, since an issue body
 * holds 65,536 characters and the run's own summary has the rest.
 */
export function renderSummary(
  results: readonly Result[],
  options: { passed?: boolean; maxFailed?: number } = {},
): string {
  const { passed: showPassed = true, maxFailed = Number.POSITIVE_INFINITY } =
    options;
  const sorted = [...results].sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      a.harness.localeCompare(b.harness) ||
      a.provider.localeCompare(b.provider) ||
      a.tag.localeCompare(b.tag) ||
      a.model.localeCompare(b.model),
  );
  const count = (status: Result["status"]) =>
    results.filter((row) => row.status === status).length;
  const failed = sorted.filter((row) => row.status === "fail");
  const skipped = sorted.filter((row) => row.status === "skipped");
  const passed = sorted.filter((row) => row.status === "pass");
  const missing = [
    ...new Set(
      skipped.map(
        (row) =>
          PROVIDERS.find((p) => p.label === row.provider)?.secret ??
          row.provider,
      ),
    ),
  ];
  const parts = [
    "## Model compatibility",
    "",
    `${count("fail")} failed, ${count("pass")} passed, ${count("skipped")} skipped.`,
    "",
  ];
  if (missing.length)
    parts.push(
      `Skipped for want of a key, not failed: add the repository secret${missing.length > 1 ? "s" : ""} ${missing.map((name) => `\`${name}\``).join(", ")} to check ${missing.length > 1 ? "those providers" : "that provider"}.`,
      "",
    );
  if (failed.length) {
    parts.push("### Failed", "", renderTable(failed.slice(0, maxFailed)), "");
    if (failed.length > maxFailed)
      parts.push(
        `And ${failed.length - maxFailed} more failures, in the run's summary.`,
        "",
      );
  }
  if (skipped.length) parts.push("### Skipped", "", renderTable(skipped), "");
  if (passed.length && showPassed)
    parts.push(
      "<details><summary>Passed</summary>",
      "",
      renderTable(passed),
      "",
      "</details>",
      "",
    );
  return parts.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Running it.
// ---------------------------------------------------------------------------------------------

type Options = {
  envFile?: string;
  harnesses?: string[];
  providers?: string[];
  model?: RegExp;
  tags: string[];
  concurrency: number;
  out?: string;
  exitZero: boolean;
};

function parseOptions(argv: string[]): Options {
  const options: Options = {
    tags: ["latest", SOURCE],
    concurrency: 6,
    exitZero: false,
  };
  const list = (value: string | undefined) =>
    (value ?? "")
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--env-file") options.envFile = value();
    else if (flag === "--harness") options.harnesses = list(value());
    else if (flag === "--provider") options.providers = list(value());
    else if (flag === "--model") options.model = new RegExp(value());
    else if (flag === "--tags") options.tags = list(value());
    else if (flag === "--concurrency")
      options.concurrency = Math.max(1, Number(value()) || 1);
    else if (flag === "--out") options.out = value();
    else if (flag === "--exit-zero") options.exitZero = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  return options;
}

/** The provider keys, from the environment, or from an env file for the names it lacks. */
function readKeys(envFile: string | undefined): Map<ProviderId, string> {
  const fromFile = new Map<string, string>();
  if (envFile)
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, name = "", raw = ""] = match;
      fromFile.set(name, raw.trim().replace(/^(['"])(.*)\1$/, "$2"));
    }
  const keys = new Map<ProviderId, string>();
  for (const row of PROVIDERS) {
    const value = (
      process.env[row.secret] ||
      fromFile.get(row.secret) ||
      ""
    ).trim();
    if (value) keys.set(row.id, value);
  }
  return keys;
}

function scrubber(keys: Map<ProviderId, string>) {
  const secrets = [...keys.values()].filter((value) => value.length >= 8);
  return (text: string) =>
    secrets.reduce(
      (scrubbed, secret) => scrubbed.split(secret).join("[key]"),
      text,
    );
}

async function fetchJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok)
      return { ok: false, error: `HTTP ${response.status}: ${oneLine(text)}` };
    return { ok: true, body: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function exec(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(args, {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * `source` is the image built from this checkout, which is what the next release ships, so a pin
 * bumped here is checked before it is released. Any other tag is the published image: `latest` is
 * what people run today.
 */
function imageOf(harness: Harness, tag: string): string {
  return tag === SOURCE
    ? `model-compat/${harness.image}:source`
    : `${REGISTRY}${harness.image}:${tag}`;
}

async function prepare(harness: Harness, tag: string) {
  return tag === SOURCE
    ? exec([
        "docker",
        "build",
        "--quiet",
        "-f",
        join(ROOT, harness.image ?? "", "Dockerfile"),
        "-t",
        imageOf(harness, tag),
        ROOT,
      ])
    : exec(["docker", "pull", "--quiet", imageOf(harness, tag)]);
}

/**
 * The model-client packages whose versions decide what a provider accepts, by the names each
 * ecosystem installs them under. Whichever an image has are recorded in the lock beside the
 * models they were proven with, so a lock entry says what it was true for.
 */
export const PYTHON_CLIENTS = [
  "claude-agent-sdk",
  "ag-ui-claude-sdk",
  "openai",
  "anthropic",
  "litellm",
  "google-genai",
  "google-adk",
  "ag2",
  "agno",
  "crewai",
  "langgraph",
  "ag-ui-langgraph",
  "langchain-core",
  "langchain-openai",
  "langchain-anthropic",
  "langchain-google-genai",
  "langroid",
  "llama-index-core",
  "llama-index-llms-openai",
  "llama-index-llms-anthropic",
  "llama-index-llms-google-genai",
  "pydantic-ai-slim",
  "strands-agents",
  "agent-framework",
  "agent-framework-core",
];
export const NODE_CLIENTS = [
  "@mastra/core",
  "ai",
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
  "@ai-sdk/google",
  // The LangGraph (TypeScript) engine: its graph, the LangChain chat models that call each
  // provider, and the AG-UI packages it speaks through.
  "@langchain/langgraph",
  "@langchain/core",
  "@langchain/anthropic",
  "@langchain/openai",
  "@langchain/google",
  "@langchain/google-genai",
  "@ag-ui/core",
  "@ag-ui/client",
  "@ag-ui/encoder",
  "@ag-ui/langgraph",
];

const PYTHON_VERSIONS = `
import json, importlib.metadata as m
found = {}
for name in ${JSON.stringify(PYTHON_CLIENTS)}:
    try:
        found[name] = m.version(name)
    except Exception:
        pass
try:
    import claude_agent_sdk, pathlib, subprocess
    for cli in pathlib.Path(claude_agent_sdk.__file__).parent.glob("_bundled/claude*"):
        said = subprocess.run([str(cli), "--version"], capture_output=True, text=True, timeout=30).stdout.split()
        if said:
            found["claude-code"] = said[0]
            break
except Exception:
    pass
print(json.dumps(found))
`;
/**
 * Read under `bun -e` or plain `node -e` (a Node image may have no Bun), from the image's working
 * directory up, the way Node resolves a package. The manifest is read as a file rather than
 * required, since a package whose `exports` map leaves out `./package.json` refuses the require.
 */
export const NODE_VERSIONS = `
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const found = {};
for (const name of ${JSON.stringify(NODE_CLIENTS)}) {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    try {
      found[name] = JSON.parse(readFileSync(join(dir, "node_modules", name, "package.json"), "utf8")).version;
      break;
    } catch {}
    if (dirname(dir) === dir) break;
  }
}
console.log(JSON.stringify(found));
`;

/** The model clients an image carries, or an empty record when it says nothing. */
async function clientsIn(image: string): Promise<Record<string, string>> {
  for (const args of [
    ["python", "-c", PYTHON_VERSIONS],
    ["bun", "-e", NODE_VERSIONS],
    ["node", "-e", NODE_VERSIONS],
  ] as const) {
    const ran = await exec([
      "docker",
      "run",
      "--rm",
      "--entrypoint",
      args[0],
      image,
      args[1],
      args[2],
    ]);
    if (ran.code !== 0) continue;
    try {
      const found = JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "");
      if (found && typeof found === "object" && Object.keys(found).length)
        return found as Record<string, string>;
    } catch {
      // Not this runtime's answer: try the next.
    }
  }
  return {};
}

let serial = 0;

/** Starts the harness on one provider and model, sends one run, and stops it. */
async function runOne(
  row: Extract<MatrixRow, { kind: "run" }>,
  key: string,
  scrub: (text: string) => string,
): Promise<Outcome> {
  const harness = row.harness;
  const name = `model-compat-${process.pid}-${++serial}`;
  const env = {
    ...provider(row.provider).harnessEnv(key, harness),
    BOT_MODEL: row.model,
  };
  const token = randomBytes(12).toString("hex");
  // Each value goes to Docker through the environment and is named here, so no key is in argv.
  const started = await exec(
    [
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-p",
      `127.0.0.1::${harness.port}`,
      "-e",
      "MANAGED_AGENT_TOKEN",
      ...Object.keys(env).flatMap((variable) => ["-e", variable]),
      imageOf(harness, row.tag),
    ],
    { ...env, MANAGED_AGENT_TOKEN: token },
  );
  if (started.code !== 0)
    return {
      status: "fail",
      detail: scrub(`the harness did not start: ${oneLine(started.stderr)}`),
    };
  try {
    const port = await exec(["docker", "port", name, `${harness.port}/tcp`]);
    const address = port.stdout.trim().split("\n")[0]?.trim();
    if (!address)
      return { status: "fail", detail: "the harness published no port" };
    const base = `http://${address}`;
    const deadline = Date.now() + START_TIMEOUT_MS;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const health = await fetch(`${base}/health`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (health.ok) {
          healthy = true;
          break;
        }
      } catch {
        // Not listening yet.
      }
      const state = await exec([
        "docker",
        "inspect",
        "-f",
        "{{.State.Running}}",
        name,
      ]);
      if (state.stdout.trim() !== "true") break;
      await Bun.sleep(1_000);
    }
    if (!healthy) {
      const logs = await exec(["docker", "logs", "--tail", "5", name]);
      return {
        status: "fail",
        detail: scrub(
          `the harness never became healthy: ${oneLine(logs.stdout + logs.stderr)}`,
        ),
      };
    }
    const id = randomBytes(6).toString("hex");
    const mastra = harness.image === "agent-mastra";
    let response: { status: number; body: string };
    try {
      const reply = await fetch(
        mastra
          ? `${base}/api/agents/openbot/generate`
          : `${base}${harness.runPath || "/"}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: mastra ? "application/json" : "text/event-stream",
            "x-openbot-agent-token": token,
          },
          body: JSON.stringify(
            mastra
              ? { messages: [{ role: "user", content: PROMPT }] }
              : {
                  threadId: `model-compat-${id}`,
                  runId: `run-${id}`,
                  state: {},
                  messages: [
                    { id: `message-${id}`, role: "user", content: PROMPT },
                  ],
                  // A Bot's run always carries tools, and a client's tool path is where models
                  // part ways (Responses-only models, parallel tool calls), so this one does too.
                  tools: [PROBE_TOOL],
                  context: [],
                  // What the server tells the LangGraph and Claude Agent SDK harnesses; the others
                  // read BOT_MODEL, set above.
                  forwardedProps: { openbotModel: { model: row.model } },
                },
          ),
          signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
        },
      );
      response = { status: reply.status, body: await reply.text() };
    } catch (error) {
      return {
        status: "fail",
        detail: scrub(`no answer: ${oneLine(String(error))}`),
      };
    }
    const outcome = mastra ? classifyMastra(response) : classifyRun(response);
    if (outcome.status === "fail" && !response.body.includes("RUN_ERROR")) {
      // A harness that swallowed the error still logged it.
      const logs = await exec(["docker", "logs", "--tail", "40", name]);
      const said = (logs.stdout + logs.stderr)
        .split("\n")
        .filter((line) => /error|exception/i.test(line))
        .at(-1);
      if (said)
        outcome.detail = `${outcome.detail}; logged: ${oneLine(said, 300)}`;
    }
    return { status: outcome.status, detail: scrub(outcome.detail) };
  } finally {
    await exec(["docker", "rm", "-f", name]);
  }
}

async function pool<T>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      for (let item = items[next++]; item !== undefined; item = items[next++])
        await work(item);
    }),
  );
}

async function check(argv: string[]): Promise<number> {
  const options = parseOptions(argv);
  const keys = readKeys(options.envFile);
  const scrub = scrubber(keys);

  const harnesses = readProbed(options.harnesses);
  if (!harnesses.length)
    throw new Error(
      "No harness matches --harness: it must be published, or named in shared/model-lock.json, and have a row in shared/harnesses.json.",
    );

  const wanted = new Set(
    harnesses
      .flatMap(providersFor)
      .filter((id) => !options.providers || options.providers.includes(id)),
  );
  const capabilities = await fetchJson(MODELS_DEV);
  const known = capabilities.ok
    ? parseCapabilities(capabilities.body)
    : new Map();
  const listings = new Map<string, Listing>();
  for (const id of wanted) {
    const key = keys.get(id);
    if (!key) continue;
    const row = provider(id);
    const request = row.listing(key);
    const listed = await fetchJson(request.url, request.headers);
    listings.set(
      id,
      listed.ok
        ? {
            models: usableModels(
              row.source,
              listed.body,
              known,
              Date.now(),
            ).filter((model) => !options.model || options.model.test(model)),
          }
        : { error: scrub(`the model listing failed: ${listed.error}`) },
    );
  }
  const matrix = buildMatrix({
    harnesses,
    tags: options.tags,
    listings,
  }).filter(
    (row) => !options.providers || options.providers.includes(row.provider),
  );

  const results: Result[] = [];
  const label = (id: string) => provider(id).label;
  for (const row of matrix) {
    if (row.kind === "no-key")
      results.push({
        harness: row.harness.image ?? "",
        tag: options.tags.join(", "),
        provider: label(row.provider),
        providerId: row.provider,
        model: "(all)",
        status: "skipped",
        detail: `skipped: no key (${provider(row.provider).secret})`,
      });
    if (row.kind === "listing-failed")
      results.push({
        harness: row.harness.image ?? "",
        tag: options.tags.join(", "),
        provider: label(row.provider),
        providerId: row.provider,
        model: "(all)",
        status: "fail",
        detail: row.detail,
      });
  }

  // Every image once, before any run, so a pull or build is never counted against a run's time.
  const images = harnesses.flatMap((harness) =>
    options.tags.map((tag) => ({ harness, tag })),
  );
  const unpulled = new Map<string, string>();
  await pool(images, 3, async ({ harness, tag }) => {
    const began = Date.now();
    const ready = await prepare(harness, tag);
    console.error(
      `${tag === SOURCE ? "built" : "pulled"} ${imageOf(harness, tag)} in ${Math.round((Date.now() - began) / 1000)}s${ready.code ? " (failed)" : ""}`,
    );
    if (ready.code !== 0)
      unpulled.set(
        imageOf(harness, tag),
        oneLine(ready.stderr.split("\n").slice(-5).join(" ")),
      );
  });

  // The model clients each image carries, which the lock records beside what passed.
  const clients: NonNullable<Results["clients"]> = {};
  for (const { harness, tag } of images) {
    const image = imageOf(harness, tag);
    if (unpulled.has(image) || !harness.image) continue;
    const found = await clientsIn(image);
    clients[harness.image] = { ...clients[harness.image], [tag]: found };
  }

  // The ChatGPT plan's Codex client version, in whichever images carry the plan.
  const codex = await fetchJson(CODEX_CATALOGUE);
  if (!options.providers || options.providers.includes("openai"))
    for (const harness of harnesses)
      for (const tag of options.tags) {
        const image = imageOf(harness, tag);
        if (unpulled.has(image)) continue;
        const version = await exec([
          "docker",
          "run",
          "--rm",
          "--entrypoint",
          "python",
          image,
          "-c",
          "from src.chatgpt_models import client_version; print(client_version())",
        ]);
        if (version.code !== 0) continue;
        const sends = version.stdout.trim();
        // What the plan's backend is told, recorded with the image's other clients.
        if (harness.image)
          clients[harness.image] = {
            ...clients[harness.image],
            [tag]: { ...clients[harness.image]?.[tag], "codex-client": sends },
          };
        if (!codex.ok) {
          results.push({
            harness: harness.image ?? "",
            tag,
            provider: "ChatGPT plan",
            providerId: "chatgpt",
            model: "(all)",
            status: "fail",
            detail: `could not read Codex's model catalogue: ${codex.error}`,
          });
          continue;
        }
        for (const gate of codexGate(sends, codex.body))
          results.push({
            harness: harness.image ?? "",
            tag,
            provider: "ChatGPT plan",
            providerId: "chatgpt",
            ...gate,
          });
      }

  const runs = matrix.filter(
    (row): row is Extract<MatrixRow, { kind: "run" }> => row.kind === "run",
  );
  let done = 0;
  await pool(runs, options.concurrency, async (row) => {
    const image = imageOf(row.harness, row.tag);
    const ask = () => runOne(row, keys.get(row.provider) ?? "", scrub);
    /*
     * A failure is asked once more before it counts. A provider's refusal says the same thing
     * twice; a run that timed out once does not (gemini-4-carbon through Antigravity's source
     * image on 2026-11-18, which answered through the published image in the same run and through
     * every other engine), and must not fail a pull request or leave the lock.
     */
    let outcome: Outcome = unpulled.has(image)
      ? {
          status: "fail" as const,
          detail: `could not get ${image}: ${unpulled.get(image)}`,
        }
      : await ask();
    if (outcome.status === "fail" && !unpulled.has(image))
      outcome = await ask();
    results.push({
      harness: row.harness.image ?? "",
      tag: row.tag,
      provider:
        row.provider === "anthropic" && row.harness.credential === "anthropic"
          ? "Anthropic (key or Claude plan)"
          : label(row.provider),
      providerId: row.provider,
      model: row.model,
      ...outcome,
    });
    done++;
    console.error(
      `[${done}/${runs.length}] ${row.harness.image}:${row.tag} ${row.provider} ${row.model}: ${outcome.status}`,
    );
  });

  if (options.out)
    writeFileSync(
      options.out,
      `${JSON.stringify({ results, clients } satisfies Results, null, 2)}\n`,
    );
  console.log(renderSummary(results));
  return results.some((row) => row.status === "fail") && !options.exitZero
    ? 1
    : 0;
}

// ---------------------------------------------------------------------------------------------
// The model lock.
// ---------------------------------------------------------------------------------------------

const PROVIDER_IDS_BY_LABEL: Record<string, LockProvider> = {
  OpenAI: "openai",
  Anthropic: "anthropic",
  "Anthropic (key or Claude plan)": "anthropic",
  Google: "google",
  xAI: "xai",
  "ChatGPT plan": "chatgpt",
};

/** The lock's name for a row's provider. Results written before rows carried it are read by label. */
export function providerIdOf(row: {
  provider: string;
  providerId?: string;
}): LockProvider | undefined {
  if (row.providerId) return row.providerId as LockProvider;
  return PROVIDER_IDS_BY_LABEL[row.provider];
}

/**
 * A failure that says nothing about the model: the harness never started, the image could not be
 * had, or the run timed out with no word from the provider. The lock keeps what it knew before
 * for such a model rather than take it away on a bad day for the runner.
 */
const INCONCLUSIVE =
  /^(no answer:|the harness did not start|the harness never became healthy|the harness published no port|could not get |the stream ended without finishing the run)/;

/** A provider limiting how fast the check's key may call it: about the key's day, not the model. */
const RATE_LIMITED =
  /\b429\b|rate.?limit|RESOURCE_EXHAUSTED|too many requests/i;

/**
 * A model this key's account can't see, which another account may: a bare 404, or one that names
 * no reason. About the key, not the client. A 404 that names the client's endpoint ("only supported
 * in v1/responses") is the client's, and stays a refusal.
 */
const UNAVAILABLE_TO_KEY =
  /is not found for API version|does not exist or you do not have access|do not have access to (?:the )?model|^(?:NotFoundError\(')?Error code: 404'?\)?$|^Not Found$/i;

/**
 * A provider retiring a model: Google's "no longer available to new users, use …". The check
 * working as designed: the lock refuses it, so a person set to it is told and moved to the default
 * instead of meeting the provider's 404. Not a client's fault, so it never fails a pull request.
 */
const RETIRED =
  /no longer available to new users|has been (?:deprecated|retired|shut down)|(?:was|is) (?:deprecated|retired) and (?:is )?no longer/i;

export function retiredByProvider(detail: string): boolean {
  return RETIRED.test(detail);
}

/** A failure about the check's key, not the harness's client: a rate limit, or a model it can't see. */
export function aboutTheKey(detail: string): boolean {
  return RATE_LIMITED.test(detail) || UNAVAILABLE_TO_KEY.test(detail);
}

export function inconclusive(detail: string): boolean {
  return INCONCLUSIVE.test(detail) || aboutTheKey(detail);
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * The tag a harness's lock is read from: `source`, the image built from this commit, which is what
 * the next release ships. A run of the published images alone says nothing about this commit.
 */
function lockTag(rows: readonly Result[]): string | undefined {
  return rows.some((row) => row.tag === SOURCE) ? SOURCE : undefined;
}

/**
 * The model lock from a run's results, over the lock before it.
 *
 * For each harness, the `source` image's rows: what passed is verified, what the provider refused
 * is refused, in its words. What the run could not decide (an inconclusive failure), a provider
 * it had no key for or could not list, and a harness it did not run, keep what the lock said
 * before. A model the provider no longer lists drops out. The date moves only when the lock does,
 * so a day with nothing new changes nothing.
 */
export function buildLock(
  previous: ModelLock | undefined,
  runs: readonly Results[],
  date: string,
): ModelLock {
  const results = runs.flatMap((run) => run.results);
  const clients = Object.assign({}, ...runs.map((run) => run.clients ?? {}));
  const engines: Record<string, LockedEngine> = {
    ...(previous?.engines ?? {}),
  };
  const harnesses = [...new Set(results.map((row) => row.harness))];
  for (const harness of harnesses) {
    const rows = results.filter((row) => row.harness === harness);
    const tag = lockTag(rows);
    const before = previous?.engines[harness];
    const providers: LockedEngine["providers"] = {
      ...(before?.providers ?? {}),
    };
    const ran = rows.filter((row) => row.tag === tag && row.model !== "(all)");
    for (const id of new Set(ran.map(providerIdOf))) {
      if (!id) continue;
      const earlier = before?.providers[id];
      const verified = new Set<string>();
      const refused: Record<string, string> = {};
      for (const row of ran.filter((row) => providerIdOf(row) === id)) {
        if (row.status === "pass") verified.add(row.model);
        else if (row.status !== "fail") continue;
        else if (!inconclusive(row.detail)) refused[row.model] = row.detail;
        else if (earlier?.verified.includes(row.model)) verified.add(row.model);
        else if (earlier?.refused[row.model] !== undefined)
          refused[row.model] = earlier.refused[row.model] ?? "";
      }
      providers[id] = {
        verified: [...verified].sort(),
        refused: sortedRecord(refused),
      };
    }
    if (!Object.keys(providers).length) continue;
    const found = tag ? clients[harness]?.[tag] : undefined;
    engines[harness] = {
      clients: sortedRecord(
        found && Object.keys(found).length ? found : (before?.clients ?? {}),
      ),
      providers: sortedRecord(providers),
    };
  }
  const next = sortedRecord(engines);
  const same =
    previous !== undefined &&
    JSON.stringify(previous.engines) === JSON.stringify(next);
  return { checkedAt: same ? previous.checkedAt : date, engines: next };
}

/**
 * What changed between two locks, as a pull request says it: models that newly answer, models
 * that stopped, models that dropped out of a provider's listing, and clients that moved.
 */
export function describeLockChange(
  before: ModelLock | undefined,
  after: ModelLock,
): string {
  const lines: string[] = [];
  for (const [engine, entry] of Object.entries(after.engines)) {
    const earlier = before?.engines[engine];
    const changes: string[] = [];
    for (const [provider, now] of Object.entries(entry.providers)) {
      if (!now) continue;
      const was = earlier?.providers[provider as LockProvider];
      const known = new Set([
        ...(was?.verified ?? []),
        ...Object.keys(was?.refused ?? {}),
      ]);
      const passes = now.verified.filter(
        (model) => !was?.verified.includes(model),
      );
      const stopped = Object.keys(now.refused).filter((model) =>
        was?.verified.includes(model),
      );
      const newlyRefused = Object.keys(now.refused).filter(
        (model) => !known.has(model),
      );
      const gone = [...known].filter(
        (model) => !now.verified.includes(model) && !(model in now.refused),
      );
      if (passes.length)
        changes.push(
          `${provider}: now answers ${passes.map((m) => `\`${m}\``).join(", ")}`,
        );
      if (stopped.length)
        changes.push(
          `${provider}: **stopped answering** ${stopped.map((m) => `\`${m}\` (${cell(now.refused[m] ?? "")})`).join(", ")}`,
        );
      if (newlyRefused.length)
        changes.push(
          `${provider}: refused ${newlyRefused.map((m) => `\`${m}\` (${cell(now.refused[m] ?? "")})`).join(", ")}`,
        );
      if (gone.length)
        changes.push(
          `${provider}: no longer listed ${gone.map((m) => `\`${m}\``).join(", ")}`,
        );
    }
    const moved = Object.entries(entry.clients)
      .filter(([name, version]) => earlier?.clients[name] !== version)
      .map(([name, version]) =>
        earlier?.clients[name]
          ? `${name} ${earlier.clients[name]} to ${version}`
          : `${name} ${version}`,
      );
    if (moved.length) changes.push(`clients: ${moved.join(", ")}`);
    if (changes.length)
      lines.push(
        `- **${engine}**`,
        ...changes.map((change) => `  - ${change}`),
      );
  }
  return lines.length ? lines.join("\n") : "No model changed.";
}

/**
 * The model-client versions a harness pins in this repository, by the names the lock records
 * them under: exact `name==version` lines in its `requirements.txt`, the versions its `bun.lock`
 * resolves for the Node clients, and the Codex client version the LangGraph harness sends a
 * ChatGPT plan. Unpinned packages are left out: only what the repository fixes can disagree.
 */
export function pinnedClients(
  root: string,
  harness: string,
): Record<string, string> {
  const pinned: Record<string, string> = {};
  const read = (file: string) => {
    const path = join(root, harness, file);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  for (const line of read("requirements.txt").split("\n")) {
    const match = /^\s*([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*==\s*([^\s;#]+)/.exec(
      line,
    );
    if (match?.[1] && match[2])
      pinned[match[1].toLowerCase().replace(/_/g, "-")] = match[2];
  }
  const lockfile = read("bun.lock");
  for (const name of NODE_CLIENTS) {
    const escaped = name.replace(/[/.]/g, "\\$&");
    const found = new RegExp(`"${escaped}": \\["${escaped}@([^"]+)"`).exec(
      lockfile,
    )?.[1];
    if (found) pinned[name] = found;
  }
  // npm's lockfile, for a harness installed with `npm ci` (the LangGraph (TypeScript) engine).
  const npmLock = read("package-lock.json");
  if (npmLock) {
    const packages =
      (
        JSON.parse(npmLock) as {
          packages?: Record<string, { version?: string }>;
        }
      ).packages ?? {};
    for (const name of NODE_CLIENTS) {
      const version = packages[`node_modules/${name}`]?.version;
      if (version) pinned[name] = version;
    }
  }
  const codex = /^DEFAULT_CLIENT_VERSION\s*=\s*"([^"]+)"/m.exec(
    read("src/chatgpt_models.py"),
  )?.[1];
  if (codex) pinned["codex-client"] = codex;
  return pinned;
}

/**
 * Where the lock and the repository disagree about a harness's clients: each pinned client the
 * lock recorded at another version, or didn't record. A lock that disagrees was proven on other
 * clients than the ones this commit ships, so it may hide models that now work, or offer ones that
 * no longer do. Regenerate it (`lock`) from a run of this commit.
 */
export function staleClients(
  lock: ModelLock,
  root: string,
): { harness: string; client: string; pinned: string; locked?: string }[] {
  const stale: {
    harness: string;
    client: string;
    pinned: string;
    locked?: string;
  }[] = [];
  for (const [harness, entry] of Object.entries(lock.engines)) {
    for (const [client, pinned] of Object.entries(
      pinnedClients(root, harness),
    )) {
      const locked = entry.clients[client];
      if (locked !== pinned)
        stale.push({ harness, client, pinned, ...(locked ? { locked } : {}) });
    }
  }
  return stale;
}

/** Every model the lock verifies that now fails: what a client bump must not break. */
export function brokenVerified(
  lock: ModelLock,
  results: readonly Result[],
): Result[] {
  /*
   * What the published image did with the same key in the same run, when the run checked it too: a
   * model that fails there as well is the provider's or the key's today, not this change's.
   */
  const failsOnPublished = (row: Result) =>
    results.some(
      (other) =>
        other.tag !== SOURCE &&
        other.status === "fail" &&
        other.harness === row.harness &&
        other.model === row.model &&
        providerIdOf(other) === providerIdOf(row),
    );
  return results.filter((row) => {
    if (row.status !== "fail" || row.model === "(all)") return false;
    if (row.tag !== SOURCE) return false;
    // The key's account, not the change's client: says nothing about the change.
    if (
      aboutTheKey(row.detail) ||
      retiredByProvider(row.detail) ||
      failsOnPublished(row)
    )
      return false;
    const id = providerIdOf(row);
    return (
      !!id &&
      (lock.engines[row.harness]?.providers[id]?.verified.includes(row.model) ??
        false)
    );
  });
}

function readResults(files: readonly string[]): Results[] {
  return files.map((file) => JSON.parse(readFileSync(file, "utf8")) as Results);
}

function lockCommand(argv: string[]): number {
  let path = join(ROOT, "shared/model-lock.json");
  let date = new Date().toISOString().slice(0, 10);
  let changes: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--lock") path = argv[++i] ?? path;
    else if (arg === "--date") date = argv[++i] ?? date;
    else if (arg === "--changes") changes = argv[++i];
    else if (arg) files.push(arg);
  }
  const previous = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as ModelLock)
    : undefined;
  const next = buildLock(previous, readResults(files), date);
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const changed = !existsSync(path) || readFileSync(path, "utf8") !== text;
  if (changed) writeFileSync(path, text);
  if (changes)
    writeFileSync(changes, `${describeLockChange(previous, next)}\n`);
  console.log(
    changed
      ? `The model lock changed: ${path}`
      : "The model lock is unchanged.",
  );
  return 0;
}

function guardCommand(argv: string[]): number {
  let path = join(ROOT, "shared/model-lock.json");
  let summary: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--lock") path = argv[++i] ?? path;
    else if (arg === "--summary") summary = argv[++i];
    else if (arg) files.push(arg);
  }
  const lock = JSON.parse(readFileSync(path, "utf8")) as ModelLock;
  const results = readResults(files).flatMap((run) => run.results);
  const broken = brokenVerified(lock, results);
  const markdown = [
    "## Model lock",
    "",
    broken.length
      ? `${broken.length} model${broken.length === 1 ? "" : "s"} the lock verifies no longer answer${broken.length === 1 ? "s" : ""} through this change's client. A person set to one would get the provider's refusal on every message. Fix the client, or, if the model really can't run on this harness any more, say so in the pull request: the next daily check takes it out of the lock.`
      : "Every model the lock verifies for the harnesses this change touches still answers.",
    "",
    ...(broken.length ? [renderTable(broken), ""] : []),
    renderSummary(results),
  ].join("\n");
  if (summary) writeFileSync(summary, `${markdown}\n`);
  else console.log(markdown);
  return broken.length ? 1 : 0;
}

function report(argv: string[]): number {
  let summary: string | undefined;
  let issue: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--summary") summary = argv[++i];
    else if (arg === "--issue") issue = argv[++i];
    else if (arg) files.push(arg);
  }
  const results = files.flatMap(
    (file) =>
      (JSON.parse(readFileSync(file, "utf8")) as { results: Result[] }).results,
  );
  const markdown = renderSummary(results);
  if (summary) writeFileSync(summary, `${markdown}\n`);
  else console.log(markdown);
  if (issue)
    writeFileSync(
      issue,
      `${renderSummary(results, { passed: false, maxFailed: 150 })}\n`,
    );
  if (!results.length) {
    console.error(
      "No results were found: every harness job failed before it wrote any.",
    );
    return 1;
  }
  return results.some((row) => row.status === "fail") ? 1 : 0;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "harnesses") {
    // The workflows' matrix: one job per harness this check runs, as compact JSON.
    console.log(
      JSON.stringify(readProbed().map((harness) => harness.image ?? "")),
    );
    process.exit(0);
  }
  const code =
    argv[0] === "report"
      ? report(argv.slice(1))
      : argv[0] === "lock"
        ? lockCommand(argv.slice(1))
        : argv[0] === "guard"
          ? guardCommand(argv.slice(1))
          : await check(argv);
  process.exit(code);
}
