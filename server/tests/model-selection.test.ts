import { describe, expect, test } from "bun:test";
import {
  directModelConnection,
  modelOptions,
  resolveChoice,
} from "../src/agents/model-selection";

const base = { provider: "openai" as const, defaultModel: "gpt-5.5" };
describe("conversation model rules", () => {
  test("deduplicates and preserves configured default", () => {
    expect(
      modelOptions(base).filter((m) => m.id === base.defaultModel),
    ).toHaveLength(1);
    expect(
      modelOptions({ ...base, defaultModel: "custom" }).some(
        (m) => m.id === "custom",
      ),
    ).toBe(true);
  });
  test("intersects policy and isolates providers", () => {
    expect(modelOptions(base, ["openai/gpt-6-luna"]).map((m) => m.id)).toEqual([
      "gpt-6-luna",
    ]);
    expect(
      modelOptions({
        provider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      }).every((m) => !m.id.startsWith("gpt")),
    ).toBe(true);
  });
  test("snapshots overrides without mutating defaults and rejects stale choices", () => {
    const saved = {
      agentId: "bot",
      provider: "openai" as const,
      model: "gpt-6-luna",
    };
    expect(resolveChoice(base, null, [])).toBe(base);
    expect(resolveChoice(base, saved, [saved.model]).defaultModel).toBe(
      saved.model,
    );
    expect(base.defaultModel).toBe("gpt-5.5");
    expect(() => resolveChoice(base, saved, [])).toThrow();
    expect(() =>
      resolveChoice(
        { provider: "anthropic", defaultModel: "claude-sonnet-4-6" },
        saved,
        [saved.model],
      ),
    ).toThrow();
  });
  test("custom endpoints and missing credentials cannot select", () => {
    expect(directModelConnection(base, "test", {})).toBe(true);
    expect(directModelConnection(base, null, {})).toBe(false);
    expect(
      directModelConnection(base, "test", {
        OPENAI_BASE_URL: "https://example.com/v1",
      }),
    ).toBe(false);
  });
});
