import { describe, expect, test } from "bun:test";
import {
  isPlainBotId,
  isUsableSeatId,
  profileDirectoryFor,
  seatIdFor,
  seatParts,
} from "../src/bot-id";

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

/**
 * A seat is a Bot's place on a computer: its own profile, folder and session.
 *
 * On a computer many people share, the server names the person as well as the Bot, and the seat is
 * the pair. The regression it closes: a public Bot had one profile on the shared computer, so
 * whoever signed it into a site signed it in for everybody using it.
 */
describe("seats", () => {
  test("a Bot with no person named is its own seat, exactly as before", () => {
    expect(seatIdFor("sales")).toBe("sales");
    expect(profileDirectoryFor("/profiles", seatIdFor("sales"))).toBe(
      "/profiles/sales",
    );
  });

  test("two people on one Bot get two seats, and two directories", () => {
    const ada = seatIdFor("sales", "ada");
    const bo = seatIdFor("sales", "bo");
    expect(ada).not.toBe(bo);
    expect(profileDirectoryFor("/profiles", ada)).toBe("/profiles/ada~sales");
    expect(profileDirectoryFor("/profiles", bo)).toBe("/profiles/bo~sales");
    // And neither is the Bot's old shared profile, which nobody's seat reaches any more.
    expect(profileDirectoryFor("/profiles", ada)).not.toBe("/profiles/sales");
  });

  test("one person's two Bots get two seats", () => {
    expect(seatIdFor("sales", "ada")).not.toBe(seatIdFor("support", "ada"));
  });

  test("a seat reads back as the person and the Bot it was made from", () => {
    expect(seatParts(seatIdFor("agent_1f-2", "u-9"))).toEqual({
      personId: "u-9",
      botId: "agent_1f-2",
    });
    expect(seatParts("sales")).toEqual({ botId: "sales" });
  });

  test.each([
    ["../etc", "sales", "a hostile person"],
    ["ada", "../etc", "a hostile Bot"],
    [
      "ada~bo",
      "sales",
      "a person carrying the separator, to forge another seat",
    ],
    ["", "sales", "an empty person"],
    ["ada", "", "an empty Bot"],
  ])("refuses person %s with Bot %s (%s)", (person, bot) => {
    expect(() => seatIdFor(bot, person)).toThrow();
  });

  test.each([
    ["ada~sales", true],
    ["sales", true],
    ["ada~bo~sales", false],
    ["~sales", false],
    ["ada~", false],
    ["../x~sales", false],
    ["ada~../x", false],
  ])("%s is a usable seat: %s", (seat, usable) => {
    expect(isUsableSeatId(seat)).toBe(usable);
  });

  test("a seat stays a single directory inside the root", () => {
    const directory = profileDirectoryFor(
      "/profiles",
      seatIdFor("sales", "ada"),
    );
    expect(directory.startsWith("/profiles/")).toBe(true);
    expect(directory.slice("/profiles/".length)).not.toContain("/");
  });
});
