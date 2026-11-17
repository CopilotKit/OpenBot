import { expect, test } from "bun:test";
import anthropicListing from "./fixtures/model-listings/anthropic-models.json";
import openaiListing from "./fixtures/model-listings/openai-models.json";
import { lockAllows, lockVerdict, MODEL_LOCK } from "./model-lock";

/*
 * The lock's rule against real data: the model listings OpenAI and Anthropic answered on
 * 2026-11-17 (shared/fixtures/model-listings), and the lock the model check wrote that day. The
 * Claude plan's failure that day was the Claude Agent SDK harness offering Opus 5.5 and Fable
 * 5.2, which its pinned Claude Code was refused on every message.
 */

const anthropicIds = anthropicListing.data.map((model) => model.id);
const openaiIds = openaiListing.data.map((model) => model.id);

const offered = (
  engine: string | undefined,
  provider: "anthropic" | "openai",
  ids: string[],
) => ids.filter((id) => lockAllows(MODEL_LOCK, engine, provider, id));

test("the Claude Agent SDK harness is not offered the models its Claude Code is refused", () => {
  const claude = offered("agent-claude-sdk", "anthropic", anthropicIds);
  expect(anthropicIds).toContain("claude-opus-5-5");
  expect(anthropicIds).toContain("claude-fable-5-2");
  expect(claude).not.toContain("claude-opus-5-5");
  expect(claude).not.toContain("claude-fable-5-2");
  expect(claude).toContain("claude-sonnet-5-5");
  expect(claude).toContain("claude-haiku-5-5");
  // Everything else Anthropic listed that day answered.
  expect(claude).toHaveLength(anthropicIds.length - 2);
});

test("a refused model carries the provider's own words", () => {
  const verdict = lockVerdict(
    MODEL_LOCK,
    "agent-claude-sdk",
    "anthropic",
    "claude-opus-5-5",
  );
  expect(verdict.status).toBe("refused");
  expect(verdict.status === "refused" && verdict.said).toMatch(
    /does not support this model; version [\d.]+ or newer is required/,
  );
});

test("a harness whose client takes every model is offered every model", () => {
  expect(offered("agent-langgraph-agui", "anthropic", anthropicIds)).toEqual(
    anthropicIds,
  );
});

test("the Responses-only OpenAI models are not offered on a Chat Completions harness", () => {
  const ag2 = offered("agent-ag2", "openai", openaiIds);
  for (const model of ["gpt-5-pro", "o3-pro"])
    if (openaiIds.includes(model)) expect(ag2).not.toContain(model);
  expect(ag2.length).toBeGreaterThan(0);
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
  expect(offered(undefined, "anthropic", anthropicIds)).toEqual(anthropicIds);
  // No key for xAI in CI.
  expect(lockVerdict(MODEL_LOCK, "agent-agno", "xai", "grok-4.7")).toEqual({
    status: "open",
  });
  expect(
    lockAllows(MODEL_LOCK, "agent-unknown", "openai", "gpt-6.1-terra"),
  ).toBe(true);
});

test("every engine the lock names is a harness OpenBot publishes, with the clients it ran", async () => {
  const { harnesses } = (await import("./harnesses.json")).default as {
    harnesses: { image: string | null }[];
  };
  const images = harnesses.map((harness) => harness.image);
  for (const [engine, entry] of Object.entries(MODEL_LOCK.engines)) {
    expect(images, engine).toContain(engine);
    expect(Object.keys(entry.clients).length, engine).toBeGreaterThan(0);
  }
});
