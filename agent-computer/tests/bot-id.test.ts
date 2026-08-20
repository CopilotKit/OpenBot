import { describe, expect, test } from "bun:test";
import { isPlainBotId, profileDirectoryFor } from "../src/bot-id";

/**
 * The Bot id arrives as a request header and becomes a filesystem path, so it is the same kind of
 * input the workspace already treats as hostile. These are the cases that must never reach `join`.
 */
describe("isPlainBotId", () => {
  test.each([
    ["sales", "an ordinary id"],
    ["support-1", "a hyphen"],
    ["risk_analyst", "an underscore"],
    ["shared", "the default this process falls back to"],
    ["7f3c1a2e9b4d4f0e8a1c2d3e4f5a6b7c", "a uuid-shaped id"],
    ["a", "a single character"],
  ])("accepts %s (%s)", (id) => {
    expect(isPlainBotId(id)).toBe(true);
  });

  test.each([
    ["..", "the parent directory"],
    ["../workspace", "one step out, onto the durable volume"],
    ["../../etc", "two steps out"],
    ["sales/../../etc", "traversal after a plausible prefix"],
    ["/etc", "an absolute path"],
    ["a/b", "a separator"],
    ["a\\b", "a backslash"],
    ["profile.d", "a dot, which invites .. reasoning"],
    [".hidden", "a leading dot"],
    ["-lead", "a leading hyphen"],
    ["", "empty"],
    ["  ", "whitespace"],
    ["sales support", "an inner space"],
    ["sales\n", "a trailing newline"],
    ["a".repeat(65), "longer than a uuid-shaped id"],
  ])("refuses %s (%s)", (id) => {
    expect(isPlainBotId(id)).toBe(false);
  });
});

describe("profileDirectoryFor", () => {
  test("puts an ordinary Bot in its own directory under the root", () => {
    expect(profileDirectoryFor("/profiles", "sales")).toBe("/profiles/sales");
  });

  // The regression. Each of these resolved outside the profiles root, and `reset` runs
  // rm -rf on whatever comes back, as root.
  test.each([
    ["../workspace", "/workspace"],
    ["../etc", "/etc"],
    ["../../above", "two levels up"],
    ["sales/../../etc", "/etc"],
  ])("refuses %s, which used to resolve to %s", (id) => {
    expect(() => profileDirectoryFor("/profiles", id)).toThrow();
  });

  // Belt and braces: whatever the allow-list lets through must still land inside the root.
  test("everything it accepts stays inside the root", () => {
    for (const id of ["sales", "support-1", "risk_analyst", "a"]) {
      const directory = profileDirectoryFor("/profiles", id);
      expect(directory.startsWith("/profiles/")).toBe(true);
    }
  });
});
