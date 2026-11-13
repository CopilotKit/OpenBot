import { describe, expect, test } from "bun:test";
import {
  ANSWER_MAX,
  DELEGATING_GUIDANCE,
  frameBrief,
  readBrief,
  resultForConversation,
} from "../orchestration";

/**
 * What a task says in the conversation that asked for it, from answers a task gave on a live run.
 */
describe("a task's answer in the conversation that asked", () => {
  test("is the answer whole: a chart's summary comes back with it", () => {
    // A chart drawn from numbers the person gave, then what it shows.
    const answer =
      "Here's your quarterly revenue chart.\n\nQ4 was the strongest quarter at $200k, up a third on Q3, and Q3 was the weakest at $90k.\n\n| Quarter | Revenue |\n| --- | --- |\n| Q1 | $120k |\n| Q4 | $200k |";
    expect(resultForConversation(answer)).toBe(answer);
  });

  test("an answer far longer than an answer is cut at a paragraph and points at the thread", () => {
    const paragraph = `${"Seed prices vary by supplier and season. ".repeat(40)}`;
    const answer = Array.from({ length: 12 }, () => paragraph).join("\n\n");
    const said = resultForConversation(answer);
    expect(Array.from(said).length).toBeLessThanOrEqual(ANSWER_MAX + 40);
    expect(said.endsWith("The rest is in the task's thread.")).toBe(true);
    expect(said.startsWith(paragraph.trim())).toBe(true);
  });
});

describe("a delegated task's brief", () => {
  test("is read back without the words that frame it for the model", () => {
    const brief =
      "Order the French marigold seeds and report the order number.";
    expect(readBrief(frameBrief(brief))).toBe(brief);
    expect(readBrief(brief)).toBeNull();
  });

  test("a thread opened before the answer came back whole still reads as the Bot's brief", () => {
    const earlier =
      "This is a task from your conversation with the person, handed into a thread of its own so that conversation stays short. Do the work here with your tools, as you would there, and finish it.\nAnswer the way you always do: when the answer has structure (figures, a comparison, a list of items, a plan, a record), draw it with a component rather than writing it out.\nBegin your reply with one or two sentences that give the result and say plainly anything you could not confirm. Those sentences and any components you draw are posted back in that conversation; the rest stays in this thread.\nThe task:\n\nCompare three seed-packet prices.";
    expect(readBrief(earlier)).toBe("Compare three seed-packet prices.");
  });
});

describe("how a Bot answers a short ask itself", () => {
  test("a chart from numbers the person gave comes with what it shows, in words", () => {
    // A direct answer once came back as the chart alone, the summary the person asked for dropped.
    expect(DELEGATING_GUIDANCE).toContain(
      "say in a sentence or two what it shows and what stands out",
    );
    expect(DELEGATING_GUIDANCE).toContain("never in place of them");
  });
});
