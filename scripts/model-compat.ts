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
 *   bun scripts/model-compat.ts [--env-file .env] [--harness agent-claude-sdk,...]
 *     [--provider anthropic,...] [--model <regex>] [--tags latest,source] [--concurrency 6]
 *     [--out results.json] [--exit-zero]
 *   bun scripts/model-compat.ts report --summary <file> [--issue <file>] results/*.json
 *
 * Needs Docker. Exits 1 when anything failed (unless --exit-zero); `report` merges the results of
 * several runs, writes the Markdown summary, and exits 1 when any of them failed.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
 * gateway serves its own aliases, not a provider's models.
 */
export const NOT_CHECKED: readonly { baseUrl: string; why: string }[] = [
  {
    baseUrl: "https://api.unbiased.ai/v1",
    why: "Unbiased AI is a gateway serving its own `pareto` model, not a provider's listing",
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

function judgeReply(text: string, silence: string): Outcome {
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
  provider: string;
  model: string;
  status: "pass" | "fail" | "skipped";
  detail: string;
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

  const published: string[] = JSON.parse(
    readFileSync(join(ROOT, ".github/published-images.json"), "utf8"),
  );
  const harnesses = (
    JSON.parse(readFileSync(join(ROOT, "shared/harnesses.json"), "utf8")) as {
      harnesses: Harness[];
    }
  ).harnesses.filter(
    (row) =>
      row.image &&
      published.includes(row.image) &&
      (!options.harnesses || options.harnesses.includes(row.image)),
  );
  if (!harnesses.length)
    throw new Error("No published harness matches --harness.");

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
        model: "(all)",
        status: "skipped",
        detail: `skipped: no key (${provider(row.provider).secret})`,
      });
    if (row.kind === "listing-failed")
      results.push({
        harness: row.harness.image ?? "",
        tag: options.tags.join(", "),
        provider: label(row.provider),
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
        if (!codex.ok) {
          results.push({
            harness: harness.image ?? "",
            tag,
            provider: "ChatGPT plan",
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
            ...gate,
          });
      }

  const runs = matrix.filter(
    (row): row is Extract<MatrixRow, { kind: "run" }> => row.kind === "run",
  );
  let done = 0;
  await pool(runs, options.concurrency, async (row) => {
    const image = imageOf(row.harness, row.tag);
    const outcome = unpulled.has(image)
      ? {
          status: "fail" as const,
          detail: `could not get ${image}: ${unpulled.get(image)}`,
        }
      : await runOne(row, keys.get(row.provider) ?? "", scrub);
    results.push({
      harness: row.harness.image ?? "",
      tag: row.tag,
      provider:
        row.provider === "anthropic" && row.harness.credential === "anthropic"
          ? "Anthropic (key or Claude plan)"
          : label(row.provider),
      model: row.model,
      ...outcome,
    });
    done++;
    console.error(
      `[${done}/${runs.length}] ${row.harness.image}:${row.tag} ${row.provider} ${row.model}: ${outcome.status}`,
    );
  });

  if (options.out)
    writeFileSync(options.out, `${JSON.stringify({ results }, null, 2)}\n`);
  console.log(renderSummary(results));
  return results.some((row) => row.status === "fail") && !options.exitZero
    ? 1
    : 0;
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
  const code = argv[0] === "report" ? report(argv.slice(1)) : await check(argv);
  process.exit(code);
}
