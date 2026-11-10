import { describe, expect, test } from "bun:test";
import { openParts, routineParts } from "./routine-checklist";

/**
 * A routine's checklist, read from instructions the way people write them, and closed by answers
 * the way models write them.
 */

describe("the parts of a routine", () => {
  test("are the outer items of a numbered list", () => {
    expect(
      routineParts(
        [
          "Every Monday, plan the cycle:",
          "1. Pull the current cycle's issues from Linear",
          "   - only the ENG team",
          "2. Match them against the Candidates page in Notion",
          "3) Rank what is left by priority",
        ].join("\n"),
      ),
    ).toEqual([
      "Pull the current cycle's issues from Linear",
      "Match them against the Candidates page in Notion",
      "Rank what is left by priority",
    ]);
  });

  test("are bullets as well as numbers", () => {
    expect(
      routineParts(
        "- Check my calendar\n- Summarise unread email\n• Post it here",
      ),
    ).toEqual(["Check my calendar", "Summarise unread email", "Post it here"]);
  });

  test.each([
    ["one sentence", "Post the standup summary."],
    ["one item", "Do this:\n- Post the standup summary"],
    [
      "a list of things to work through rather than parts",
      Array.from({ length: 20 }, (_, n) => `- ENG-${n + 1}`).join("\n"),
    ],
  ])("are none for %s", (_name, instruction) => {
    expect(routineParts(instruction)).toEqual([]);
  });
});

describe("the parts an answer leaves open", () => {
  const parts = [
    "Pull the current cycle's issues from Linear",
    "Match them against the Candidates page in Notion",
    "Rank what is left by priority",
  ];

  test("are none when every part is closed by its number", () => {
    expect(
      openParts(
        parts,
        "1. Done: 14 issues\n**2. Blocked**: the page is private\n| 3 | Skipped | nothing left |",
      ),
    ).toEqual([]);
  });

  test("count a part named by its own words", () => {
    expect(
      openParts(
        parts,
        "✅ Pull the current cycle's issues from Linear: done\n2. Done\n3. Done",
      ),
    ).toEqual([]);
  });

  test("are the parts with no status", () => {
    expect(
      openParts(
        parts,
        "1. Done: pulled 14 issues.\n2 issues are done already.",
      ),
    ).toEqual([
      { number: 2, text: parts[1] as string },
      { number: 3, text: parts[2] as string },
    ]);
  });
});
