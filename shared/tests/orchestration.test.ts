import { describe, expect, test } from "bun:test";
import { delegatingGuidance } from "../bot-prompt";
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

  test("asks the work not to write out what a component already shows", () => {
    // A task drew httpbin's seven fields as a component and wrote the same seven rows as a table.
    const framed = frameBrief("Place the test order on httpbin.");
    expect(framed).toContain("Never write out what a component already shows");
  });

  test("a thread opened under the frame before still reads as the Bot's brief", () => {
    const before =
      "This is a task from your conversation with the person, handed into a thread of its own so that conversation stays short. Do the work here with your tools, as you would there, and finish it.\nAnswer the way you always do: when the answer has structure (figures, a comparison, a list of items, a plan, a record), draw it with a component rather than writing it out, and say in words what it shows and what stands out.\nLead with the result and say plainly anything you could not confirm. Your answer and any components you draw are posted back in that conversation as they are; what you say while you work stays in this thread.\nThe task:\n\nChart six months of revenue.";
    expect(readBrief(before)).toBe("Chart six months of revenue.");
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

/**
 * What every Bot that holds `delegate` is told, whatever runs it. On a live run a LangGraph Bot,
 * told only by the tool's description, charted and summed up revenue itself, filled in a web shop's
 * order itself, and wrote 👍 as a reply beside its 👍 reaction.
 */
describe("how a Bot that holds delegate is told to work", () => {
  test("names the work that goes to a task, so it is handed off without being asked", () => {
    expect(DELEGATING_GUIDANCE).toContain("without waiting to be asked");
    expect(DELEGATING_GUIDANCE).toContain("a chart with a summary");
    expect(DELEGATING_GUIDANCE).toContain("an order, a purchase");
    // The line the person reads first is written first.
    expect(DELEGATING_GUIDANCE).toContain(
      "First write one short line saying what you will do",
    );
  });

  test("a reaction is the whole answer, with no words, not even the emoji", () => {
    expect(DELEGATING_GUIDANCE).toContain("not even the emoji");
    // The LangGraph Bot reacted 👀 to an ask it then handed to a task.
    expect(DELEGATING_GUIDANCE).toContain("exactly one of these three things");
    expect(DELEGATING_GUIDANCE).toContain(
      "Never react to a message you answer or hand to a task",
    );
  });

  test("a started task ends the reply, and a thread's link is only for when the person asks", () => {
    // It then looked up the thread it had just started and wrote a second line under the card.
    expect(DELEGATING_GUIDANCE).toContain(
      "your reply is finished: the task's card already shows it",
    );
    expect(DELEGATING_GUIDANCE).toContain(
      "Only when the person asks for the link",
    );
  });

  test("is a section of the prompt for a run that holds delegate, and of no other", () => {
    expect(
      delegatingGuidance([{ name: "search_web" }, { name: "delegate" }]),
    ).toEqual([`<delegating>\n${DELEGATING_GUIDANCE}\n</delegating>`]);
    expect(delegatingGuidance([{ name: "search_web" }])).toEqual([]);
  });
});
