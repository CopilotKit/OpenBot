import { describe, expect, test } from "bun:test";
import { delegatingGuidance } from "../bot-prompt";
import {
  ANSWER_MAX,
  DELEGATING_GUIDANCE,
  frameBrief,
  readBrief,
  resultForConversation,
  taskStands,
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

  test("asks the answer to speak to the person, not about the brief or where a chart sits", () => {
    // A task wrote "not the 25.8% in the brief" and "the chart above" for a chart drawn below it.
    const framed = frameBrief("Chart six months of revenue.");
    expect(framed).toContain("never mention this brief");
    expect(framed).toContain("never say where a component sits");
  });

  test("asks for a report that is the result, standing on its own, without the working", () => {
    // Live: "I checked the full message thread", "I resolved the channel and selected Alex Clarke
    // because", 229 words for three facts; and "the substantive changes are clear", never stated.
    const framed = frameBrief("Find Dana's latest email and say what changed.");
    expect(framed).toContain("Your last message is your report");
    expect(framed).toContain("the report must stand on its own");
    expect(framed).toContain(
      "the facts, figures, dates and quotes they asked for",
    );
    expect(framed).toContain("Size it to the question");
    expect(framed).toContain("Leave out how you got there");
    expect(framed).toContain("stays in this thread");
    // The words that had a model write its summary and then the card's call as text beside it.
    expect(framed).not.toContain("your words first");
    expect(framed).toContain("call the component in a step of its own");
    expect(framed).toContain("never a component's data as text");
    // "`<@U0E2EALEX0> Test message`", quoted back as Slack stores it.
    expect(framed).toContain("never by an app's id or its markup for one");
  });

  test("a thread opened before the report was asked to be the result alone still reads as the Bot's brief", () => {
    const before =
      "This is a task from your conversation with the person, handed into a thread of its own so that conversation stays short. Do the work here with your tools, as you would there, and finish it.\nAnswer the way you always do: when the answer has structure (figures, a comparison, a list of items, a plan, a record), draw it with a component, and say in words what it shows and what stands out. Never write out what a component already shows: no Markdown table or list of the same rows beside it.\nLead with the result and say plainly anything you could not confirm. Your answer and any components you draw are posted back in that conversation as they are, your words first; what you say while you work stays in this thread. Write it to the person: never mention this brief, and never say where a component sits, such as 'the chart above'.\nThe task:\n\nFind Dana's latest email.";
    expect(readBrief(before)).toBe("Find Dana's latest email.");
  });

  test("a thread opened before the answer was told not to name the brief still reads as the Bot's brief", () => {
    const before =
      "This is a task from your conversation with the person, handed into a thread of its own so that conversation stays short. Do the work here with your tools, as you would there, and finish it.\nAnswer the way you always do: when the answer has structure (figures, a comparison, a list of items, a plan, a record), draw it with a component, and say in words what it shows and what stands out. Never write out what a component already shows: no Markdown table or list of the same rows beside it.\nLead with the result and say plainly anything you could not confirm. Your answer and any components you draw are posted back in that conversation as they are; what you say while you work stays in this thread.\nThe task:\n\nOrder the marigold seeds.";
    expect(readBrief(before)).toBe("Order the marigold seeds.");
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
    // On Claude Sonnet 5.5 a chart of four figures and a sheet with a total were done in the
    // conversation, three runs of three: "one quick read" left the size of an ask to the model.
    expect(DELEGATING_GUIDANCE).toContain(
      "(a chart, a table, a sheet, a report, a plan, a document)",
    );
    expect(DELEGATING_GUIDANCE).toContain(
      "even from figures they gave you and even when you could make it in one step",
    );
    expect(DELEGATING_GUIDANCE).toContain(
      "is a task's, however small it looks",
    );
    expect(DELEGATING_GUIDANCE).not.toContain("one quick read");
    expect(DELEGATING_GUIDANCE).toContain("an order, a purchase");
    // The line the person reads first is written first.
    expect(DELEGATING_GUIDANCE).toContain(
      "First write one short line saying what you will do",
    );
  });

  test("hands off only work the person asked for: a question about whether it can gets an answer", () => {
    // Live, 2 runs of 3: "are you able to build a sequence in Smartlead?" was answered yes, and a
    // task then read the person's campaigns.
    expect(DELEGATING_GUIDANCE).not.toContain("Hand everything else");
    expect(DELEGATING_GUIDANCE).toContain(
      "Hand the other work the person asked for to a task",
    );
    expect(DELEGATING_GUIDANCE).toContain(
      "A question about whether you can do something is a short ask",
    );
    expect(DELEGATING_GUIDANCE).toContain(
      "start no task and read none of their data",
    );
    expect(DELEGATING_GUIDANCE).toContain(
      "never start a task for work nobody asked for",
    );
  });

  test("a routine, a follow-up or a goal asked for in the conversation is set up in it, not by a task", () => {
    // Live: the routine a task made posted into the task's thread, and its follow-up was refused.
    expect(DELEGATING_GUIDANCE).toContain(
      "a routine, a follow-up or a reminder, or a goal is set up here with the tool for it",
    );
    expect(DELEGATING_GUIDANCE).toContain("never a task's");
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

  test("a finished task is said to be done, not waiting for review", () => {
    // Told `ready_for_review`, a Bot said a finished order "may be waiting on you".
    expect(taskStands("ready_for_review")).toStartWith("done");
    expect(taskStands("needs_input")).toBe(
      "waiting for the person in its thread",
    );
  });

  test("is a section of the prompt for a run that holds delegate, and of no other", () => {
    expect(
      delegatingGuidance([{ name: "search_web" }, { name: "delegate" }]),
    ).toEqual([`<delegating>\n${DELEGATING_GUIDANCE}\n</delegating>`]);
    expect(delegatingGuidance([{ name: "search_web" }])).toEqual([]);
  });
});
