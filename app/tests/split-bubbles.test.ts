import { describe, expect, test } from "bun:test";
import {
  holdsBlock,
  splitBubbles,
} from "../src/components/channels/split-bubbles";

/** A Bot's reply, cut into the separate thoughts the chat draws as separate bubbles. */
describe("splitting a reply into bubbles", () => {
  test("one bubble per paragraph", () => {
    expect(
      splitBubbles("Hello, I'm here.\n\nI'll check your mail. Be right back!"),
    ).toEqual(["Hello, I'm here.", "I'll check your mail. Be right back!"]);
  });

  test("one paragraph stays one bubble", () => {
    expect(splitBubbles("On it")).toEqual(["On it"]);
    expect(splitBubbles("")).toEqual([""]);
  });

  test("a list stays with the line that introduces it, blank lines between items or not", () => {
    expect(
      splitBubbles(
        "Here are three things I could start on:\n\n- Roundup outreach\n\n- SEO blog plan\n- Build-in-public thread\n\nWhich first?",
      ),
    ).toEqual([
      "Here are three things I could start on:\n\n- Roundup outreach\n\n- SEO blog plan\n- Build-in-public thread",
      "Which first?",
    ]);
    expect(splitBubbles("Two need you:\n\n1. Sam\n\n2. Ana")).toEqual([
      "Two need you:\n\n1. Sam\n\n2. Ana",
    ]);
  });

  test("a code block is never cut, even while it streams in", () => {
    expect(splitBubbles("Here:\n\n```\na\n\nb\n```\n\nDone.")).toEqual([
      "Here:",
      "```\na\n\nb\n```",
      "Done.",
    ]);
    expect(splitBubbles("Here:\n\n```\na\n\nb")).toEqual([
      "Here:",
      "```\na\n\nb",
    ]);
  });

  test("a table stays whole", () => {
    expect(splitBubbles("| a | b |\n|---|---|\n\n| 1 | 2 |")).toEqual([
      "| a | b |\n|---|---|\n\n| 1 | 2 |",
    ]);
  });
});

/** Which bubbles take the whole column on a wide screen. */
describe("a bubble that holds a block", () => {
  test("a code block or a table does, finished or still streaming", () => {
    expect(holdsBlock("```ts\nconst a = 1;\n```")).toBe(true);
    expect(holdsBlock("~~~\nplain\n~~~")).toBe(true);
    expect(holdsBlock("```\nhalf a block")).toBe(true);
    expect(holdsBlock("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(true);
  });

  test("prose and lists do not, even when they mention a pipe or backticks", () => {
    expect(holdsBlock("On it")).toBe(false);
    expect(holdsBlock("Three things:\n\n- one\n- two")).toBe(false);
    expect(holdsBlock("Run `bun test` and pipe it | less")).toBe(false);
  });
});
