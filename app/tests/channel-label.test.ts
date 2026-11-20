import { describe, expect, test } from "bun:test";
import { conversationLabel } from "../src/lib/channels/label";

/**
 * A lone surrogate is half of an astral character, which is what a caption, a sidebar and a font all
 * draw as a replacement character.
 */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text);
}

describe("a conversation label", () => {
  test("keeps a short title whole", () => {
    expect(
      conversationLabel({ name: "General", summary: "What is in the PRD?" }),
    ).toBe("General: What is in the PRD?");
  });

  test("cuts a long title to the limit", () => {
    expect(
      conversationLabel({ name: "General", summary: "a".repeat(80) }),
    ).toBe(`General: ${"a".repeat(60)}`);
  });

  test("does not leave half a character when the cut lands on one", () => {
    /*
     * 59 ASCII characters and then an emoji: the emoji is two code units, so the 60th is its high
     * surrogate and the cut lands between the halves. The label is what the sidebar and the picker
     * draw, so it showed a replacement character where the emoji should have been.
     */
    const label = conversationLabel({
      name: "General",
      summary: `${"a".repeat(59)}\u{1F600}tail`,
    });

    expect(hasLoneSurrogate(label)).toBe(false);
    expect(label).toBe(`General: ${"a".repeat(59)}`);
  });

  test("falls back to the name when there is no title", () => {
    expect(conversationLabel({ name: "General" })).toBe("General");
    expect(conversationLabel({ name: "General", summary: "   " })).toBe(
      "General",
    );
  });
});
