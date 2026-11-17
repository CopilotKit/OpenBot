import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_ENGINES,
  emptyPairs,
  MODEL_LOCK,
  type ModelLock,
} from "../shared/model-lock";
import {
  brokenVerified,
  buildLock,
  describeLockChange,
  inconclusive,
  PYTHON_CLIENTS,
  pinnedClients,
  providerIdOf,
  type Result,
  type Results,
  staleClients,
} from "./model-compat";

const ROOT = join(import.meta.dir, "..");

/*
 * THE LOCK MATCHES WHAT THIS COMMIT SHIPS. Written on a commit whose Claude Agent SDK harness
 * pinned claude-agent-sdk 0.2.152 (Claude Code 2.1.259), the lock refused Opus 5.5 and Fable 5.2;
 * main then bumped the pin to a Claude Code that runs both, and the lock kept hiding them. A lock
 * proven on other clients than the ones pinned here is stale, and fails here until it is written
 * again from a run of this commit.
 */
test("the lock was proven on the model clients each harness pins in this commit", () => {
  expect(staleClients(MODEL_LOCK, ROOT)).toEqual([]);
});

/*
 * A DEFAULT ENGINE ALWAYS HAS SOMETHING TO OFFER. The LangGraph (TypeScript) engine was first
 * locked with its pairs empty, so nothing would be offered on it before a run proved a model: had
 * that reached main before a run, every new Bot on it would have had no model at all.
 */
test("every engine new Bots run on by default verifies a model on each provider it is locked for", () => {
  for (const engine of DEFAULT_ENGINES) {
    expect(MODEL_LOCK.engines[engine], engine).toBeDefined();
    expect(emptyPairs(MODEL_LOCK, engine), engine).toEqual([]);
  }
});

test("every exact pin in a harness's requirements is a client the check records", () => {
  const harnesses = readdirSync(ROOT).filter((name) =>
    name.startsWith("agent-"),
  );
  for (const harness of harnesses) {
    let text = "";
    try {
      text = readFileSync(join(ROOT, harness, "requirements.txt"), "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(
      /^\s*([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*==/gm,
    ))
      expect(PYTHON_CLIENTS, `${harness}: ${match[1]}`).toContain(
        (match[1] ?? "").toLowerCase().replace(/_/g, "-"),
      );
  }
});

test("a pin that moved past the lock is caught", () => {
  const claude = pinnedClients(ROOT, "agent-claude-sdk");
  expect(Object.keys(claude)).toContain("claude-agent-sdk");
  const old: ModelLock = {
    checkedAt: "2026-11-17",
    engines: {
      "agent-claude-sdk": {
        clients: { ...claude, "claude-agent-sdk": "0.2.152" },
        providers: {},
      },
    },
  };
  expect(staleClients(old, ROOT)).toEqual([
    {
      harness: "agent-claude-sdk",
      client: "claude-agent-sdk",
      pinned: claude["claude-agent-sdk"] ?? "",
      locked: "0.2.152",
    },
  ]);
  // The Codex version the LangGraph harness sends a ChatGPT plan, and Mastra's resolved clients.
  expect(Object.keys(pinnedClients(ROOT, "agent-langgraph-agui"))).toContain(
    "codex-client",
  );
  expect(Object.keys(pinnedClients(ROOT, "agent-mastra"))).toContain(
    "@mastra/core",
  );
});

/*
 * Writing the model lock from the model check's results, and holding a client bump to it. The
 * rows are what the check reported on 2026-11-17, in its own words.
 */

const OPUS_REFUSED =
  "API Error: 400 Claude Code 2.1.259 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";

const row = (
  model: string,
  status: Result["status"],
  detail = "OK",
  extra: Partial<Result> = {},
): Result => ({
  harness: "agent-claude-sdk",
  tag: "source",
  provider: "Anthropic (key or Claude plan)",
  providerId: "anthropic",
  model,
  status,
  detail,
  ...extra,
});

const run: Results = {
  results: [
    row("claude-sonnet-5-5", "pass"),
    row("claude-haiku-5-5", "pass"),
    row("claude-opus-5-5", "fail", OPUS_REFUSED),
    // `latest` is what people run today; the lock is what the next release ships.
    row("claude-sonnet-5-5", "fail", OPUS_REFUSED, { tag: "latest" }),
  ],
  clients: {
    "agent-claude-sdk": {
      source: { "claude-agent-sdk": "0.2.152", "claude-code": "2.1.259" },
      latest: { "claude-agent-sdk": "0.2.150" },
    },
  },
};

test("what answered on the source image is verified, what was refused is kept in the provider's words", () => {
  const lock = buildLock(undefined, [run], "2026-11-17");
  expect(lock).toEqual({
    checkedAt: "2026-11-17",
    engines: {
      "agent-claude-sdk": {
        clients: { "claude-agent-sdk": "0.2.152", "claude-code": "2.1.259" },
        providers: {
          anthropic: {
            verified: ["claude-haiku-5-5", "claude-sonnet-5-5"],
            refused: { "claude-opus-5-5": OPUS_REFUSED },
          },
        },
      },
    },
  });
});

test("a bad day for the runner takes nothing away", () => {
  const before = buildLock(undefined, [run], "2026-11-17");
  const flaky: Results = {
    results: [
      row(
        "claude-sonnet-5-5",
        "fail",
        "no answer: TimeoutError: The operation timed out.",
      ),
      row(
        "claude-haiku-5-5",
        "fail",
        "the harness never became healthy: exit 1",
      ),
      // What Antigravity said for gemma-4-31b-it on 2026-11-17, while it answered on `latest`.
      row(
        "claude-opus-5-5",
        "fail",
        'AntigravityExecutionError: Agent execution terminated due to error. ("agent executor error: Error 429, Message: Resource has been exhausted")',
      ),
    ],
  };
  const after = buildLock(before, [flaky], "2026-11-18");
  expect(after).toEqual(before);
  // Nothing changed, so neither did the date, and the daily check opens no pull request.
  expect(after.checkedAt).toBe("2026-11-17");
});

test("a model that starts answering after a client bump is verified, and the clients move with it", () => {
  const before = buildLock(undefined, [run], "2026-11-17");
  const bumped: Results = {
    results: [
      row("claude-sonnet-5-5", "pass"),
      row("claude-haiku-5-5", "pass"),
      row("claude-opus-5-5", "pass"),
      row("claude-fable-5-2", "pass"),
    ],
    clients: {
      "agent-claude-sdk": {
        source: { "claude-agent-sdk": "0.2.170", "claude-code": "2.1.291" },
      },
    },
  };
  const after = buildLock(before, [bumped], "2026-11-18");
  expect(after.checkedAt).toBe("2026-11-18");
  expect(after.engines["agent-claude-sdk"]).toEqual({
    clients: { "claude-agent-sdk": "0.2.170", "claude-code": "2.1.291" },
    providers: {
      anthropic: {
        verified: [
          "claude-fable-5-2",
          "claude-haiku-5-5",
          "claude-opus-5-5",
          "claude-sonnet-5-5",
        ],
        refused: {},
      },
    },
  });
});

test("a provider with no key and a harness that did not run keep what was known", () => {
  const before: ModelLock = {
    checkedAt: "2026-11-10",
    engines: {
      "agent-agno": {
        clients: { agno: "2.0.0" },
        providers: {
          xai: { verified: ["grok-4.7"], refused: {} },
          openai: { verified: ["gpt-6.1-terra"], refused: {} },
        },
      },
      "agent-adk": {
        clients: { "google-adk": "1.0.0" },
        providers: { openai: { verified: ["gpt-5.5"], refused: {} } },
      },
    },
  };
  const today: Results = {
    results: [
      {
        harness: "agent-agno",
        tag: "latest, source",
        provider: "xAI",
        providerId: "xai",
        model: "(all)",
        status: "skipped",
        detail: "skipped: no key (XAI_API_KEY)",
      },
      {
        harness: "agent-agno",
        tag: "source",
        provider: "OpenAI",
        providerId: "openai",
        model: "gpt-6.1-terra",
        status: "pass",
        detail: "OK",
      },
    ],
  };
  const after = buildLock(before, [today], "2026-11-17");
  expect(after.engines["agent-agno"]?.providers.xai).toEqual({
    verified: ["grok-4.7"],
    refused: {},
  });
  expect(after.engines["agent-adk"]).toEqual(before.engines["agent-adk"]!);
  // No clients in the results: the ones recorded before stand.
  expect(after.engines["agent-agno"]?.clients).toEqual({ agno: "2.0.0" });
});

test("the refresh pull request says which models started and stopped answering", () => {
  const before = buildLock(undefined, [run], "2026-11-17");
  const after = buildLock(
    before,
    [
      {
        results: [
          row(
            "claude-sonnet-5-5",
            "fail",
            "API Error: 400 invalid_request_error",
          ),
          row("claude-haiku-5-5", "pass"),
          row("claude-opus-5-5", "pass"),
        ],
        clients: {
          "agent-claude-sdk": {
            source: { "claude-agent-sdk": "0.2.170", "claude-code": "2.1.291" },
          },
        },
      },
    ],
    "2026-11-18",
  );
  const said = describeLockChange(before, after);
  expect(said).toContain("now answers `claude-opus-5-5`");
  expect(said).toContain("**stopped answering** `claude-sonnet-5-5`");
  expect(said).toContain("claude-code 2.1.259 to 2.1.291");
  expect(describeLockChange(before, before)).toBe("No model changed.");
});

test("a run of the published images alone does not move the lock", () => {
  const before = buildLock(undefined, [run], "2026-11-17");
  const latestOnly: Results = {
    results: [row("claude-opus-5-5", "pass", "OK", { tag: "latest" })],
  };
  expect(buildLock(before, [latestOnly], "2026-11-18")).toEqual(before);
});

test("results written before rows named their provider are read by its label", () => {
  expect(providerIdOf({ provider: "Anthropic (key or Claude plan)" })).toBe(
    "anthropic",
  );
  expect(providerIdOf({ provider: "ChatGPT plan" })).toBe("chatgpt");
  expect(providerIdOf({ provider: "Google" })).toBe("google");
});

test("a client bump that breaks a verified model is caught, and one the lock already refuses is not", () => {
  const lock = buildLock(undefined, [run], "2026-11-17");
  const afterBump: Result[] = [
    row("claude-sonnet-5-5", "fail", "API Error: 400 invalid_request_error"),
    row("claude-haiku-5-5", "pass"),
    row("claude-opus-5-5", "fail", OPUS_REFUSED),
  ];
  expect(brokenVerified(lock, afterBump).map((broken) => broken.model)).toEqual(
    ["claude-sonnet-5-5"],
  );
});

test("a model the check's key can't use is the key's, not the client's", () => {
  const google = (model: string, status: Result["status"], detail = "OK") =>
    row(model, status, detail, {
      harness: "agent-langgraph-agui",
      provider: "Google",
      providerId: "google",
    });
  // One Gemini key's run on 2026-11-17; another key, through the same image, disagreed on both.
  const lock = buildLock(
    undefined,
    [
      {
        results: [
          google("gemini-2.5-flash-lite", "pass"),
          google(
            "gemini-2.5-pro",
            "fail",
            "Error code: 404 - [{'error': {'code': 404, 'message': 'This model models/gemini-2.5-pro is no longer available to new users.'}}]",
          ),
          google(
            "gemini-omni-1.1-flash",
            "fail",
            "Error code: 400 - [{'error': {'code': 400, 'message': 'This model only supports Interactions API.'}}]",
          ),
        ],
      },
    ],
    "2026-11-17",
  );
  const pair = lock.engines["agent-langgraph-agui"]?.providers.google;
  expect(pair?.verified).toEqual(["gemini-2.5-flash-lite"]);
  // Not refused: another key may run it, and a later run with one proves it.
  expect(Object.keys(pair?.refused ?? {})).toEqual(["gemini-omni-1.1-flash"]);
  expect(
    brokenVerified(lock, [
      google("gemini-2.5-flash-lite", "fail", "Error code: 404"),
    ]),
  ).toEqual([]);
  // CrewAI hides the provider's words; the published image failing too, with the same key in the
  // same run, says it isn't the change.
  const hidden = () =>
    google(
      "gemini-2.5-flash-lite",
      "fail",
      "CrewAI flow failed; see server logs",
    );
  expect(
    brokenVerified(lock, [hidden(), { ...hidden(), tag: "latest" }]),
  ).toEqual([]);
  expect(
    brokenVerified(lock, [
      hidden(),
      { ...google("gemini-2.5-flash-lite", "pass"), tag: "latest" },
    ]).map((broken) => broken.model),
  ).toEqual(["gemini-2.5-flash-lite"]);
  // A 404 that names the client's endpoint is the client's.
  expect(
    inconclusive(
      "NotFoundError('Error code: 404 - This model is only supported in v1/responses and not in v1/chat/completions.')",
    ),
  ).toBe(false);
});
