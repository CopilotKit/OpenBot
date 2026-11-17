import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import anthropicListing from "../shared/fixtures/model-listings/anthropic-models.json";
import openaiListing from "../shared/fixtures/model-listings/openai-models.json";
import { lockAllows, MODEL_LOCK, type ModelLock } from "../shared/model-lock";
import {
  buildLock,
  buildMatrix,
  type Harness,
  NODE_VERSIONS,
  probedHarnesses,
  providersFor,
  type Result,
  type Results,
  usableModels,
} from "./model-compat";

/*
 * The LangGraph (TypeScript) engine, `agent-langgraph-ts`, is locked before its first release:
 * it becomes the engine new Bots run on, so a model is offered on it only once the model check has
 * sent that model a real request through the engine's own client and it answered. Until then,
 * nothing is offered on it, for any provider, even one CI has no key for.
 */

const ENGINE = "agent-langgraph-ts";
const ROOT = join(import.meta.dir, "..");
const NOW = Date.parse("2026-11-17T00:00:00Z");

/** Its row in shared/harnesses.json, as the shared contract names it. */
const LANGGRAPH_TS: Harness & { id: string } = {
  id: "langgraph-ts",
  image: ENGINE,
  port: 4215,
  runPath: "",
  credential: "any-provider",
};

const anthropicIds = usableModels(
  "anthropic",
  anthropicListing,
  new Map(),
  NOW,
);
const openaiIds = usableModels("openai", openaiListing, new Map(), NOW);
const geminiIds = ["gemini-3.8-flash", "gemini-4-argon", "gemini-3.5-pro"];

const UNRUN: ModelLock = {
  checkedAt: "2026-11-16",
  engines: {
    [ENGINE]: {
      clients: {},
      providers: {
        anthropic: { verified: [], refused: {} },
        openai: { verified: [], refused: {} },
        google: { verified: [], refused: {} },
      },
    },
  },
};

test("before its first run, nothing is offered on langgraph-ts, on any provider", () => {
  expect(anthropicIds.length).toBeGreaterThan(0);
  expect(openaiIds.length).toBeGreaterThan(0);
  for (const [provider, ids] of [
    ["anthropic", anthropicIds],
    ["openai", openaiIds],
    ["google", geminiIds],
  ] as const)
    for (const model of ids)
      expect(
        lockAllows(UNRUN, ENGINE, provider, model),
        `${provider} ${model}`,
      ).toBe(false);
});

const row = (
  providerId: "anthropic" | "openai" | "google",
  model: string,
  status: Result["status"],
  detail = "OK",
  tag = "source",
): Result => ({
  harness: ENGINE,
  tag,
  provider: { anthropic: "Anthropic", openai: "OpenAI", google: "Google" }[
    providerId
  ],
  providerId,
  model,
  status,
  detail,
});

test("after a run, exactly the models that answered are offered on langgraph-ts", () => {
  const run: Results = {
    results: [
      row("anthropic", "claude-sonnet-5-5", "pass"),
      row("anthropic", "claude-opus-5-5", "pass"),
      row(
        "anthropic",
        "claude-fable-5-2",
        "fail",
        "400 invalid_request_error: model: claude-fable-5-2",
      ),
      // The runner's bad day: says nothing about the model, and verifies nothing.
      row(
        "anthropic",
        "claude-sonnet-4-5-20250929",
        "fail",
        "no answer: TimeoutError: The operation timed out.",
      ),
      row("openai", "gpt-6.1-terra", "pass"),
      row(
        "openai",
        "gpt-5.5",
        "fail",
        "the stream ended without finishing the run",
      ),
      // The published image is what people ran before; the lock follows `source` alone.
      row("openai", "gpt-6.2-sol", "pass", "OK", "latest"),
      {
        harness: ENGINE,
        tag: "latest, source",
        provider: "Google",
        providerId: "google",
        model: "(all)",
        status: "skipped",
        detail: "skipped: no key (GEMINI_API_KEY)",
      },
    ],
    clients: {
      [ENGINE]: {
        source: {
          "@langchain/langgraph": "1.7.5",
          "@langchain/anthropic": "1.3.1",
        },
      },
    },
  };
  const lock = buildLock(UNRUN, [run], "2026-11-17");
  const allowed = (
    provider: "anthropic" | "openai" | "google",
    ids: string[],
  ) => ids.filter((model) => lockAllows(lock, ENGINE, provider, model));

  expect(allowed("anthropic", anthropicIds).sort()).toEqual([
    "claude-opus-5-5",
    "claude-sonnet-5-5",
  ]);
  expect(openaiIds).toContain("gpt-6.1-terra");
  expect(allowed("openai", openaiIds)).toEqual(["gpt-6.1-terra"]);
  // No key for Gemini today: the pair stays locked, and nothing is offered on it.
  expect(allowed("google", geminiIds)).toEqual([]);
  expect(lock.engines[ENGINE]?.providers.google).toEqual({
    verified: [],
    refused: {},
  });
  expect(lock.engines[ENGINE]?.providers.anthropic?.refused).toEqual({
    "claude-fable-5-2": "400 invalid_request_error: model: claude-fable-5-2",
  });
  expect(lock.engines[ENGINE]?.clients).toEqual({
    "@langchain/anthropic": "1.3.1",
    "@langchain/langgraph": "1.7.5",
  });
});

test("an inconclusive failure never verifies a model langgraph-ts has not answered", () => {
  const before: ModelLock = {
    checkedAt: "2026-11-16",
    engines: {
      [ENGINE]: {
        clients: { "@langchain/langgraph": "1.7.5" },
        providers: {
          anthropic: { verified: ["claude-sonnet-5-5"], refused: {} },
          openai: { verified: [], refused: {} },
          google: { verified: [], refused: {} },
        },
      },
    },
  };
  const inconclusive = [
    "no answer: TimeoutError: The operation timed out.",
    "the harness did not start: port is already allocated",
    "the harness never became healthy: Error: Cannot find module",
    `could not get ghcr.io/copilotkit/openbot-${ENGINE}:latest: manifest unknown`,
    "the stream ended without finishing the run",
  ];
  const run: Results = {
    results: inconclusive.flatMap((detail, index) => [
      row("anthropic", `claude-model-${index}`, "fail", detail),
      row("openai", `gpt-model-${index}`, "fail", detail),
      // One it had answered before keeps its place: a bad day takes nothing away.
      row("anthropic", "claude-sonnet-5-5", "fail", detail),
    ]),
  };
  const lock = buildLock(before, [run], "2026-11-17");
  expect(lock.engines[ENGINE]?.providers.anthropic?.verified).toEqual([
    "claude-sonnet-5-5",
  ]);
  expect(lock.engines[ENGINE]?.providers.openai?.verified).toEqual([]);
  for (let index = 0; index < inconclusive.length; index++) {
    expect(lockAllows(lock, ENGINE, "anthropic", `claude-model-${index}`)).toBe(
      false,
    );
    expect(lockAllows(lock, ENGINE, "openai", `gpt-model-${index}`)).toBe(
      false,
    );
  }
});

test("the lock names langgraph-ts, with every provider a key reaches locked", () => {
  const entry = MODEL_LOCK.engines[ENGINE];
  expect(entry).toBeDefined();
  for (const provider of ["anthropic", "openai", "google"] as const)
    expect(entry?.providers[provider], provider).toBeDefined();
});

test("an engine the lock names is checked before it is published", () => {
  const published = ["agent-claude-sdk", "agent-langgraph-agui"];
  const known: Harness[] = [
    {
      image: "agent-claude-sdk",
      credential: "anthropic",
      port: 4212,
      runPath: "",
    },
    {
      image: "agent-langgraph-agui",
      credential: "any-provider",
      port: 4201,
      runPath: "",
    },
    LANGGRAPH_TS,
    {
      image: "agent-unlisted",
      credential: "any-provider",
      port: 4299,
      runPath: "",
    },
  ];
  const lock: ModelLock = {
    checkedAt: "2026-11-17",
    engines: {
      [ENGINE]: { clients: {}, providers: {} },
      // A lock entry with no harness row has nothing to start, so it is not run.
      "agent-gone": { clients: {}, providers: {} },
    },
  };
  expect(
    probedHarnesses(known, published, lock).map((harness) => harness.image),
  ).toEqual(["agent-claude-sdk", "agent-langgraph-agui", ENGINE]);
  expect(
    probedHarnesses(known, published, lock, [ENGINE]).map(
      (harness) => harness.image,
    ),
  ).toEqual([ENGINE]);
});

test("langgraph-ts is run on Anthropic, OpenAI and Gemini, one row per listed model", () => {
  expect(providersFor(LANGGRAPH_TS)).toEqual(
    expect.arrayContaining(["anthropic", "openai", "google"]),
  );
  const rows = buildMatrix({
    harnesses: [LANGGRAPH_TS],
    tags: ["source"],
    listings: new Map([
      ["anthropic", { models: anthropicIds }],
      ["openai", { models: openaiIds }],
      ["google", { models: geminiIds }],
    ]),
  });
  const runs = rows.filter((matrixRow) => matrixRow.kind === "run");
  expect(runs.length).toBe(
    anthropicIds.length + openaiIds.length + geminiIds.length,
  );
  for (const [provider, ids] of [
    ["anthropic", anthropicIds],
    ["openai", openaiIds],
    ["google", geminiIds],
  ] as const)
    for (const model of ids)
      expect(
        runs.some(
          (run) =>
            run.kind === "run" &&
            run.provider === provider &&
            run.model === model,
        ),
        `${provider} ${model}`,
      ).toBe(true);
});

test("the probe reads an engine's LangChain and AG-UI clients under plain Node", async () => {
  // A Node 22 image's working directory, with its packages installed beside it (and one hoisted
  // to the directory above, as a workspace install leaves it).
  const image = mkdtempSync(join(tmpdir(), "model-compat-node-"));
  const app = join(image, "app");
  const installed: Record<string, string> = {
    "@langchain/langgraph": "1.7.5",
    "@langchain/core": "1.2.0",
    "@langchain/anthropic": "1.3.1",
    "@langchain/openai": "1.4.0",
    "@langchain/google-genai": "2.1.0",
    // The engine's Gemini client, the one its package.json names.
    "@langchain/google": "0.2.15",
    "@ag-ui/client": "0.0.46",
  };
  for (const [name, version] of Object.entries(installed)) {
    const dir = join(app, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    // An `exports` map without `./package.json`, as some packages ship: a plain require of the
    // package's manifest is refused, so the probe reads the file.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name, version, exports: { ".": "./index.js" } }),
    );
  }
  const hoisted = join(image, "node_modules", "@ag-ui", "core");
  mkdirSync(hoisted, { recursive: true });
  writeFileSync(
    join(hoisted, "package.json"),
    JSON.stringify({ name: "@ag-ui/core", version: "0.0.46" }),
  );

  const child = Bun.spawn(["node", "-e", NODE_VERSIONS], {
    cwd: app,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  expect(JSON.parse(stdout.trim())).toEqual({
    ...installed,
    "@ag-ui/core": "0.0.46",
  });
});

test("both workflows check every engine the lock names, not only the published ones", () => {
  for (const workflow of ["model-compat.yml", "model-lock.yml"]) {
    const text = readFileSync(
      join(ROOT, ".github/workflows", workflow),
      "utf8",
    );
    expect(text, workflow).toContain("bun scripts/model-compat.ts harnesses");
  }
});
