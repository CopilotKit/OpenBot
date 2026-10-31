import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { replyEnding, replyTail } from "../src/tasks/reply-ending";
import { titleFrom } from "../src/tasks/routes";
import { nextStepOf, plainFailure, taskStatus } from "../src/tasks/store";
import { START_TASK_TOOL, taskTools } from "../src/tasks/tools";

describe("plainFailure", () => {
  test("says why a run couldn't finish without the error itself", () => {
    expect(plainFailure("The routine's turn was stopped after 300s.")).toBe(
      "the run took longer than 5 minutes",
    );
    expect(plainFailure("The turn finished without saying anything.")).toBe(
      "the run ended without a reply",
    );
    // Never the Bot in the third person: each reads after "I couldn't finish this:" too.
    expect(
      plainFailure("This Bot or its channel is no longer available to you."),
    ).toBe("this conversation is gone");
    expect(plainFailure("This Bot is paused.")).toBe("work is paused");
    expect(
      plainFailure(
        "This Bot uses gpt-x, which isn't an allowed model. Ask an admin to allow it.",
      ),
    ).toBe("the model isn't allowed here");
    expect(
      plainFailure("This turn failed before it could be tried again."),
    ).toBe("it failed before it could be tried again");
    expect(plainFailure("fetch failed")).toBe("a service didn't answer");
    // The conversation's lock refused, by the platform or as the turn first asked for it.
    expect(plainFailure("Thread lock denied")).toBe(
      "the conversation was busy with another reply",
    );
    expect(plainFailure("The conversation is busy with another turn.")).toBe(
      "the conversation was busy with another reply",
    );
    expect(plainFailure("invalid x-api-key")).toBe(
      "the model provider turned the request away",
    );
    expect(plainFailure('429 {"error":{"type":"rate_limit"}} at line 3')).toBe(
      "something went wrong during the run",
    );
    // A run cut off by a crash leaves no error of its own.
    expect(plainFailure(null)).toBe("the run was cut off partway through");
  });
});

describe("taskStatus", () => {
  const at = (needsInput: boolean, working: boolean, resolved: boolean) =>
    taskStatus({ needsInput, working, resolved });

  test("puts what waits on the person first, then work under way, then the person's done", () => {
    expect(at(false, false, false)).toBe("ready_for_review");
    expect(
      taskStatus({
        needsInput: false,
        working: false,
        resolved: false,
        failed: true,
      }),
    ).toBe("failed");
    // Marked done beats failed; a retry under way beats both.
    expect(
      taskStatus({
        needsInput: false,
        working: false,
        resolved: true,
        failed: true,
      }),
    ).toBe("resolved");
    expect(
      taskStatus({
        needsInput: false,
        working: true,
        resolved: false,
        failed: true,
      }),
    ).toBe("working");
    expect(at(false, false, true)).toBe("resolved");
    expect(at(false, true, false)).toBe("working");
    expect(at(false, true, true)).toBe("working");
    expect(at(true, true, false)).toBe("needs_input");
    expect(at(true, false, true)).toBe("needs_input");
  });
});

describe("a task's next step", () => {
  test("is the Bot's last sentence, or the person's own words quoted", () => {
    expect(nextStepOf("I drafted it. Send it to Danny?", true)).toBe(
      "I drafted it. Send it to Danny?",
    );
    expect(nextStepOf("  Make it shorter ", false)).toBe("“Make it shorter”");
    const long = nextStepOf("a".repeat(500), false);
    expect(Array.from(long ?? "")).toHaveLength(122);
    expect(long?.endsWith("…”")).toBe(true);
    expect(nextStepOf("   ", true)).toBeNull();
    expect(nextStepOf(null, false)).toBeNull();
  });

  test("keeps a reply's last sentence, without its Markdown", () => {
    expect(
      replyTail(
        "I drafted the reply.\n\n- **Rosa:** she needs a yes.\n\nShould I send it now?",
      ),
    ).toBe("Should I send it now?");
    expect(
      replyTail("Sent. It's in her thread. Tell me if Rosa answers by Friday."),
    ).toBe("Tell me if Rosa answers by Friday.");
    // A short closing question is kept with what it asks about.
    expect(
      replyTail("I can draft a note to Shopify support.\n\nDo you want me to?"),
    ).toBe("I can draft a note to Shopify support. Do you want me to?");
    expect(replyTail("1. Check the `order` page.")).toBe(
      "Check the order page.",
    );
    expect(replyTail("   \n\n")).toBeNull();
    expect(replyTail(undefined)).toBeNull();
    expect(replyTail("x".repeat(500))?.length).toBe(240);
  });
});

describe("how a reply ends", () => {
  test("on its last question even before a remark, past lists and drafts, through emoji and quotes", () => {
    expect(
      replyEnding(
        "I read it. Should Sam have Friday off? If so, someone else has to finish packing. I haven't replied to Sam.",
      ),
    ).toEqual({ tail: "Should Sam have Friday off?", asks: true });
    expect(
      replyEnding("Here are the options:\n\n- Send draft A\n- Send draft B"),
    ).toEqual({ tail: "Here are the options:", asks: false });
    expect(
      replyEnding(
        "I drafted it. Want me to send it?\n\n**Draft:** Hi Leah, thanks!",
      ),
    ).toEqual({ tail: "I drafted it. Want me to send it?", asks: true });
    expect(replyEnding("Done. Shall I?")).toEqual({
      tail: "Done. Shall I?",
      asks: true,
    });
    expect(replyEnding("Should I send it (to Rosa)?)").asks).toBe(true);
    expect(replyEnding("Is this ok? 🙂")).toEqual({
      tail: "Is this ok?",
      asks: true,
    });
    expect(replyEnding('Which one: "A" or "B?"').asks).toBe(true);
    expect(
      replyEnding(
        "Paste the key terms here and I'll go through them with you.",
      ),
    ).toEqual({
      tail: "Paste the key terms here and I'll go through them with you.",
      asks: false,
    });
  });

  test("asks for input only from a spoken final paragraph, past draft quotes and list items", () => {
    for (const text of [
      "Which one should I use? 🙂",
      "Ready. Shall I send it? Let me know.",
      "Which date works?\n\n- Friday\n- Monday",
      "Which version?\n\n> Would you like a quote?",
    ])
      expect(replyEnding(text).asks).toBe(true);
    for (const text of [
      "- Is Friday okay?",
      "> Is Friday okay?",
      "“Can we book Friday?”",
      "Done.\n\n- Why not Friday?",
      "I found the date.\n\n**Draft:** Can we book Friday?",
    ])
      expect(replyEnding(text).asks).toBe(false);
  });
});

describe("titleFrom", () => {
  test("is the first sentence of the ask's first line, without its full stop", () => {
    expect(
      titleFrom("\n  Find a time for coffee with Sam.  \nHe prefers mornings."),
    ).toBe("Find a time for coffee with Sam");
    expect(
      titleFrom("Find a time for coffee with Sam. He prefers mornings."),
    ).toBe("Find a time for coffee with Sam");
    expect(titleFrom("Can you chase Rosa? She owes us a quote.")).toBe(
      "Can you chase Rosa?",
    );
    expect(titleFrom("Wait for it... then send")).toBe(
      "Wait for it... then send",
    );
    expect(titleFrom("Pay invoice no. 5521 today")).toBe(
      "Pay invoice no. 5521 today",
    );
    expect(titleFrom("Reply to   Rosa")).toBe("Reply to Rosa");
  });

  test("cuts a long line at a word, with an ellipsis", () => {
    const title = titleFrom(
      "Draft a reply to Rosa saying we will take Oat Satin instead of the discontinued gloss glaze for the spring order",
    );
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith("…")).toBe(true);
    expect(title).toBe(
      "Draft a reply to Rosa saying we will take Oat Satin instead of the discontinued…",
    );
  });
});

/*
 * What start_task's optional fields are described as, in the JSON schema the model is given. A
 * recording showed a task's report giving the Bot's own reason for making a task as its why: "This
 * is a multi-step planning request that benefits from a dedicated task and a polished itinerary."
 *
 * Whether a model follows a description cannot be unit-tested. What this pins is that the
 * descriptions say it: why is the person's reason or deadline in their words and is left out when
 * they gave none, and none of the three is a place for the Bot's own reasoning.
 */
describe("start_task's optional fields", () => {
  test("hold what the person said or where the work came from, never the Bot's own reasoning", async () => {
    const [tool] = await taskTools({
      actorId: "person",
      botId: "bot",
      initiator: { kind: "person" },
      start: async () => {
        throw new Error("not started here");
      },
      builtIn: async () => true,
    });
    if (tool?.name !== START_TASK_TOOL)
      throw new Error(`${START_TASK_TOOL} is not held`);
    const { properties } = z.toJSONSchema(tool.parameters) as {
      properties: Record<string, { description?: string }>;
    };
    const why = properties.why?.description ?? "";
    expect(why).toContain("only as they said it and in their words");
    expect(why).toContain("leave it out when they said neither");
    expect(why).toContain("Never your own reason for making this a task");
    expect(properties.source?.description).toContain(
      "never what kind of request it is or why it is a task",
    );
    expect(properties.link?.description).toContain("never one you made up");
  });
});
