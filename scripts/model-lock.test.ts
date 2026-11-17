import { expect, test } from "bun:test";
import type { ModelLock } from "../shared/model-lock";
import {
  brokenVerified,
  buildLock,
  describeLockChange,
  providerIdOf,
  type Result,
  type Results,
} from "./model-compat";

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
