import { describe, expect, test } from "bun:test";
import { SYSTEM_PROMPT } from "./bot-prompt";

describe("SYSTEM_PROMPT", () => {
  test("keeps paragraph breaks as blank lines instead of collapsing them into spaces", () => {
    expect(SYSTEM_PROMPT).toContain("\n\n");
    expect(SYSTEM_PROMPT).not.toContain("  ");
  });

  test("keeps each paragraph as one unbroken line of prose", () => {
    for (const paragraph of SYSTEM_PROMPT.split("\n\n")) {
      expect(paragraph).not.toContain("\n");
      expect(paragraph.length).toBeGreaterThan(0);
    }
  });

  test("still contains the full instruction text, unchanged in wording", () => {
    expect(SYSTEM_PROMPT).toContain(
      "You are a Bot with your own computer, a real web browser the person can watch you use.",
    );
    expect(SYSTEM_PROMPT).toContain(
      "Say what you found or did in plain language, briefly.",
    );
  });
});
