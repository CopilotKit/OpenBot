import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HARNESS_OWN_TOOLS } from "./harness-own-tools";

const adapter = readFileSync(
  new URL("../agent-claude-sdk/src/adapter.py", import.meta.url),
  "utf8",
);

/** The value of a Python string constant in the adapter. */
function constant(name: string): string | undefined {
  return new RegExp(`^${name} = "([^"]+)"$`, "m").exec(adapter)?.[1];
}

test("names exactly the Claude Code tools the Claude Agent SDK harness keeps for itself", () => {
  const kept = /options\.tools = \[([^\]]*)\]\n/.exec(adapter)?.[1];
  expect(kept).toBeDefined();
  const names = (kept ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => constant(name));
  expect(names.every((name) => name !== undefined)).toBe(true);
  expect(new Set(names)).toEqual(new Set(HARNESS_OWN_TOOLS));
});
