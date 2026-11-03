import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { withApprovalContext } from "../src/approvals/types";
import type { AuditInitiator } from "../src/audit";
import { titleFrom } from "../src/tasks/routes";
import {
  MARKED_DONE,
  nextStepOf,
  plainFailure,
  replyConclusion,
  replyEnding,
  replyTail,
  taskStatus,
} from "../src/tasks/state";
import {
  MAX_TASKS_PER_TURN,
  ON_IT,
  START_TASK_TOOL,
  type TaskStarter,
  taskTools,
} from "../src/tasks/tools";

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
  test("is the Bot's last sentence, never the person's own words", () => {
    expect(nextStepOf("I drafted it. Send it to Danny?", true)).toBe(
      "I drafted it. Send it to Danny?",
    );
    expect(nextStepOf("  Make it shorter ", false)).toBeNull();
    expect(nextStepOf("   ", true)).toBeNull();
    expect(nextStepOf(null, false)).toBeNull();
    expect(MARKED_DONE).toBe("Marked done by you");
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

  /*
   * A recording showed "Nothing is waiting on you." as a finished task's next line. That line only
   * talks about the reply, so the Bot's closing words before it are the next line.
   */
  test("sets aside a closing line that only says nothing waits on you", () => {
    expect(
      replyTail(
        "I put the three-day plan in your notes. Nothing is waiting on you.",
      ),
    ).toBe("I put the three-day plan in your notes.");
    expect(
      replyTail(
        "I booked the Alfama tour for Friday.\n\nThere's nothing else waiting on you right now.",
      ),
    ).toBe("I booked the Alfama tour for Friday.");
    expect(
      replyTail("Drafted the reply. No further action needed from you."),
    ).toBe("Drafted the reply.");
    // A finding about the person's apps is kept.
    expect(
      replyTail("I checked your inbox. Nothing in it needs a reply from you."),
    ).toBe("Nothing in it needs a reply from you.");
    expect(replyTail("Nothing is waiting on you.")).toBeNull();
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
      agentId: "bot",
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

/*
 * When start_task is offered, and what the Bot says once it has handed work off. It fired on
 * "anything bigger than a quick answer", so a single question went to Tasks and the person lost the
 * answer in place; and the Bot's "On it." never said where the work went.
 *
 * Whether a model follows a description cannot be unit-tested. What this pins is what the model is
 * told, in the description and in the tool's result.
 */
describe("start_task's description and result", () => {
  const tool = async (
    start: TaskStarter = async () => {
      throw new Error("not started here");
    },
  ) => {
    const [held] = await taskTools({
      actorId: "person",
      agentId: "bot",
      initiator: { kind: "person" },
      start,
      builtIn: async () => true,
    });
    if (held?.name !== START_TASK_TOOL)
      throw new Error(`${START_TASK_TOOL} is not held`);
    return held;
  };

  test("is for clearly multi-step or long-running work, and a short answer stays in the conversation", async () => {
    const { description } = await tool();
    expect(description).toContain(
      "only for clearly multi-step or long-running work",
    );
    expect(description).toContain("research across several sources");
    expect(description).toContain("drafting a document");
    expect(description).toContain("work across several sites");
    expect(description).toContain("more than a few replies");
    expect(description).toContain(
      "Answer a single question, or anything with a short answer, here in the conversation yourself",
    );
    expect(description).not.toContain("anything bigger than a quick answer");
  });

  test("has the Bot say it is on it and that the result will be in Tasks", async () => {
    expect(ON_IT).toBe("On it. I'll put the result in Tasks.");
    const held = await tool(async () => ({
      id: "task-1",
      channelId: "channel-1",
      title: "Plan the Lisbon trip",
    }));
    expect(held.description).toContain(`reply only "${ON_IT}"`);
    const result = JSON.parse(
      String(
        await held.execute({
          title: "Plan the Lisbon trip",
          instruction: "Plan a three-day trip to Lisbon.",
        }),
      ),
    ) as { note: string };
    expect(result.note).toContain(`Reply only "${ON_IT}"`);
  });
});

describe("a reply's conclusion", () => {
  test("is the last paragraph it writes to the person, past a preamble and a draft", () => {
    expect(
      replyConclusion(
        "Here's a thoughtful plan.\n\n- Day one: Alfama\n- Day two: Belém\n\nI put the plan in your notes and booked the Friday tour.",
      ),
    ).toBe("I put the plan in your notes and booked the Friday tour.");
    expect(
      replyConclusion(
        "I drafted it for you.\n\n**Draft:** Hi Rosa, Oat Satin works.",
      ),
    ).toBe("I drafted it for you.");
    expect(replyConclusion("   ")).toBeNull();
  });
});

/*
 * Who is offered start_task. A task's turn runs as the person, so a routine, a responsibility, a
 * wake-up or a hand-off acting on what it read must not start one; a Bot on another framework
 * composes its own turn elsewhere; and a task's own turn does the work rather than handing it on.
 */
describe("who is offered start_task", () => {
  const offered = async (input: {
    initiator?: AuditInitiator;
    builtIn?: boolean;
    inTask?: boolean;
  }) =>
    (
      await taskTools({
        actorId: "person",
        agentId: "bot",
        initiator: input.initiator ?? { kind: "person" },
        start: async () => ({ id: "t", channelId: "c", title: "T" }),
        builtIn: async () => input.builtIn ?? true,
        ...(input.inTask === undefined ? {} : { inTask: input.inTask }),
      })
    ).map((tool) => tool.name);

  test("only a built-in Bot, in a turn a person started, outside a task", async () => {
    expect(await offered({})).toEqual([START_TASK_TOOL]);
    expect(await offered({ builtIn: false })).toEqual([]);
    expect(await offered({ inTask: true })).toEqual([]);
    for (const initiator of [
      { kind: "routine", id: "r-1" },
      { kind: "responsibility", id: "s-1" },
      { kind: "handoff", id: "h-1", origin: { kind: "person" } },
    ] satisfies AuditInitiator[])
      expect(await offered({ initiator })).toEqual([]);
  });

  test("refuses a call made in a task's own conversation, whatever built the turn", async () => {
    const started: string[] = [];
    const [tool] = await taskTools({
      actorId: "person",
      agentId: "bot",
      initiator: { kind: "person" },
      start: async ({ task }) => {
        started.push(task.title);
        return { id: "t", channelId: "c", title: task.title };
      },
      builtIn: async () => true,
      isTaskThread: async (owner, thread) =>
        owner === "person" && thread === "task-thread",
    });
    if (!tool) throw new Error(`${START_TASK_TOOL} is not held`);
    const inThread = (threadId: string) =>
      withApprovalContext(
        {
          runId: "run",
          threadId,
          toolCallId: "call",
          toolName: START_TASK_TOOL,
          args: {},
          messages: [],
          state: {},
          context: [],
          forwardedProps: {},
        },
        async () =>
          String(await tool.execute({ title: "Again", instruction: "Do it." })),
      );
    expect(await inThread("task-thread")).toStartWith("Refused.");
    expect(started).toEqual([]);
    expect(await inThread("own-thread")).not.toStartWith("Refused.");
    expect(started).toEqual(["Again"]);
  });

  test("starts at most five tasks in one turn, counted before each start is awaited", async () => {
    const started: string[] = [];
    const [tool] = await taskTools({
      actorId: "person",
      agentId: "bot",
      initiator: { kind: "person" },
      start: async ({ task }) => {
        started.push(task.title);
        return { id: task.title, channelId: "c", title: task.title };
      },
      builtIn: async () => true,
    });
    if (!tool) throw new Error(`${START_TASK_TOOL} is not held`);
    const results = await Promise.all(
      Array.from({ length: MAX_TASKS_PER_TURN + 2 }, (_, index) =>
        tool.execute({ title: `Task ${index}`, instruction: "Do it." }),
      ),
    );
    expect(started).toHaveLength(MAX_TASKS_PER_TURN);
    expect(
      results.filter((result) => String(result).startsWith("Refused.")),
    ).toHaveLength(2);
  });
});
