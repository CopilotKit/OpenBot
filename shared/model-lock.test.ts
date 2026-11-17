import { expect, test } from "bun:test";
import anthropicListing from "./fixtures/model-listings/anthropic-models.json";
import openaiListing from "./fixtures/model-listings/openai-models.json";
import before from "./fixtures/model-lock-before-claude-code-bump.json";
import {
  lockAllows,
  lockVerdict,
  MODEL_LOCK,
  type ModelLock,
} from "./model-lock";

/*
 * The lock's rule against real data: the model listings OpenAI and Anthropic answered on
 * 2026-11-17 (shared/fixtures/model-listings), and two locks written that day. `before` is the
 * Claude Agent SDK harness's entry from a run of claude-agent-sdk 0.2.152 (Claude Code 2.1.259),
 * which Anthropic refused Opus 5.5 and Fable 5.2: every message a Claude plan sent them failed.
 * `MODEL_LOCK` is the lock this commit ships, written from a run of its own pins.
 */

const BEFORE = before as ModelLock;
const anthropicIds = anthropicListing.data.map((model) => model.id);
const openaiIds = openaiListing.data.map((model) => model.id);

const offered = (
  lock: ModelLock,
  engine: string | undefined,
  provider: "anthropic" | "openai",
  ids: string[],
) => ids.filter((id) => lockAllows(lock, engine, provider, id));

test("a harness is not offered the models its client is refused", () => {
  const claude = offered(BEFORE, "agent-claude-sdk", "anthropic", anthropicIds);
  expect(anthropicIds).toContain("claude-opus-5-5");
  expect(anthropicIds).toContain("claude-fable-5-2");
  expect(claude).not.toContain("claude-opus-5-5");
  expect(claude).not.toContain("claude-fable-5-2");
  expect(claude).toContain("claude-sonnet-5-5");
  expect(claude).toHaveLength(anthropicIds.length - 2);
});

test("a refused model carries the provider's own words", () => {
  const verdict = lockVerdict(
    BEFORE,
    "agent-claude-sdk",
    "anthropic",
    "claude-opus-5-5",
  );
  expect(verdict.status).toBe("refused");
  expect(verdict.status === "refused" && verdict.said).toMatch(
    /does not support this model; version [\d.]+ or newer is required/,
  );
});

test("once the pinned client runs them, the shipped lock offers them", () => {
  // The Claude Code bump this commit pins.
  expect(
    MODEL_LOCK.engines["agent-claude-sdk"]?.clients["claude-code"],
  ).not.toBe("2.1.259");
  const claude = offered(
    MODEL_LOCK,
    "agent-claude-sdk",
    "anthropic",
    anthropicIds,
  );
  expect(claude).toContain("claude-opus-5-5");
  expect(claude).toContain("claude-fable-5-2");
});

test("the shipped lock still holds back what a provider really refuses", () => {
  // Google takes gemini-omni-1.x-flash only through its Interactions API, so no client here runs it.
  const verdict = lockVerdict(
    MODEL_LOCK,
    "agent-langgraph-agui",
    "google",
    "gemini-omni-1.1-flash",
  );
  expect(verdict.status).toBe("refused");
  expect(
    lockAllows(
      MODEL_LOCK,
      "agent-langgraph-agui",
      "google",
      "gemini-omni-1.1-flash",
    ),
  ).toBe(false);
  expect(
    lockAllows(
      MODEL_LOCK,
      "agent-langgraph-agui",
      "google",
      "gemini-3.8-flash",
    ),
  ).toBe(true);
});

test("a harness that takes OpenAI's newest models through the Responses API is offered them", () => {
  const ag2 = offered(MODEL_LOCK, "agent-ag2", "openai", openaiIds);
  for (const model of ["gpt-6.1-terra", "gpt-5-pro"])
    if (openaiIds.includes(model)) expect(ag2).toContain(model);
});

test("a model released after the last check waits for it", () => {
  expect(
    lockVerdict(MODEL_LOCK, "agent-claude-sdk", "anthropic", "claude-opus-6"),
  ).toEqual({ status: "unchecked" });
  expect(
    lockAllows(MODEL_LOCK, "agent-claude-sdk", "anthropic", "claude-opus-6"),
  ).toBe(false);
});

test("what the check never ran is open, so nobody loses their models to missing data", () => {
  // No engine named, or one the lock has no entry for.
  expect(offered(MODEL_LOCK, undefined, "anthropic", anthropicIds)).toEqual(
    anthropicIds,
  );
  // No key for xAI in CI.
  expect(lockVerdict(MODEL_LOCK, "agent-agno", "xai", "grok-4.7")).toEqual({
    status: "open",
  });
  expect(
    lockAllows(MODEL_LOCK, "agent-unknown", "openai", "gpt-6.1-terra"),
  ).toBe(true);
});

// Also why the lock can't reach main before an engine it names: agent-langgraph-ts needs its row in
// shared/harnesses.json first.
test("every engine the lock names is a harness OpenBot knows, with the clients it ran", async () => {
  const { harnesses } = (await import("./harnesses.json")).default as {
    harnesses: { image: string | null }[];
  };
  const images = harnesses.map((harness) => harness.image);
  for (const [engine, entry] of Object.entries(MODEL_LOCK.engines)) {
    expect(images, engine).toContain(engine);
    // An engine locked before its first run (agent-langgraph-ts) has run no client yet, and
    // offers nothing until it has.
    const ran = Object.values(entry.providers).some(
      (pair) =>
        !!pair &&
        (pair.verified.length > 0 || Object.keys(pair.refused).length > 0),
    );
    if (ran)
      expect(Object.keys(entry.clients).length, engine).toBeGreaterThan(0);
  }
});
