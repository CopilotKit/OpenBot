import { describe, expect, test } from "bun:test";
import { frameTaskBrief, frameTaskReply } from "@openbot/shared/task-brief";
import { Hono } from "hono";
import {
  buildTaskReport,
  firstSentence,
  type ReportApproval,
  type ReportInput,
  type ReportMessage,
  type TaskReportReader,
} from "../src/tasks/report";
import { createTaskRoutes } from "../src/tasks/routes";
import type { TaskStore } from "../src/tasks/store";
import { type TaskRecord, TaskNotFoundError } from "../src/tasks/types";

/**
 * A task's report, worked out from its conversation: the decisions the person made in it, and the
 * Bot's updates and the person's replies in the order they happened. Built from plain values here;
 * the route is drawn with a store and a reader in memory.
 */

/** A connector's answer as the transcript carries it. */
const connector = (value: unknown) => JSON.stringify(value);

const ANA = {
  id: "4d48cd4aab6ee190",
  threadId: "4d48cd4aab6ee190",
  from: "Ana Pereira <ana@example.test>",
  subject: "Could we do 200?",
  date: "2026-10-23T01:04:04.000Z",
  body: "If you can do 200 mugs instead of 120 for the same Friday date, we'll confirm today.",
};

const brief: ReportMessage = {
  id: "task-1",
  role: "user",
  content: frameTaskBrief("Reply to Ana that the order ships Friday."),
};
const call = (id: string, name: string, args: unknown = {}) => ({
  id,
  name,
  args: JSON.stringify(args),
});
const SEND = "mcp__google-workspace__gmail_send_reply";
const READ = "mcp__google-workspace__gmail_read_message";

const send: ReportApproval = {
  id: "approval-send",
  toolCallId: "call-send",
  status: "completed",
  decision: "allow_once",
  createdAt: new Date("2026-10-23T09:41:10Z"),
  decidedAt: new Date("2026-10-23T09:42:00Z"),
  completedAt: new Date("2026-10-23T09:42:05Z"),
  action: {
    toolRef: "openbot/share_private_information",
    effect: "share_private",
    scope: "external:ana@example.test",
    args: {
      audience: "google-workspace: ana@example.test",
      preview: "Hi Ana, the order ships Friday.",
    },
    target: { kind: "external", id: "ana@example.test" },
  },
};

/** The conversation a send-a-reply task leaves: read, ask, allowed, sent, said so. */
const sendConversation: ReportMessage[] = [
  brief,
  {
    id: "a1",
    role: "assistant",
    content: "I read Ana's email. She wants 200 mugs for Friday.",
    toolCalls: [call("call-read", READ, { id: ANA.id })],
  },
  { id: "t1", role: "tool", toolCallId: "call-read", content: connector(ANA) },
  { id: "reasoning", role: "reasoning", content: "" },
  {
    id: "a2",
    role: "assistant",
    toolCalls: [call("call-send", SEND, { to: ["ana@example.test"] })],
  },
  {
    id: "approval:approval-send",
    role: "tool",
    toolCallId: "call-send",
    content: "The person allowed this share. Send it again now, unchanged.",
  },
  {
    id: "a3",
    role: "assistant",
    toolCalls: [call("call-send-2", SEND, { to: ["ana@example.test"] })],
  },
  {
    id: "t3",
    role: "tool",
    toolCallId: "call-send-2",
    content: connector({ id: "sent-1", threadId: ANA.threadId }),
  },
  {
    id: "a4",
    role: "assistant",
    content:
      "**Sent.** Ana now knows the order ships Friday.\n\nAnything else on the Hearth order is with Sam.",
  },
];

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    task: { id: "task-1", status: "ready_for_review" },
    messages: sendConversation,
    approvals: [send],
    firstTurnEndedAt: new Date("2026-10-23T09:41:12Z"),
    resumedEndedAt: new Map([
      ["approval-send", new Date("2026-10-23T09:42:20Z")],
    ]),
    lastMessageAt: new Date("2026-10-23T09:42:19Z"),
    ...overrides,
  };
}

describe("a task's decisions and updates", () => {
  test("in order: what it found, the person's Allow once where the conversation carried on, then what it did", () => {
    const report = buildTaskReport(input());
    expect(
      report.entries.map((entry) =>
        entry.kind === "decision"
          ? `decision ${entry.decision} by ${entry.by} at ${entry.at}`
          : `${entry.kind} ${entry.text} at ${entry.at}`,
      ),
    ).toEqual([
      // The first turn stopped to ask, so it ended when it asked.
      "update I read Ana's email. at 2026-10-23T09:41:10.000Z",
      "decision allow_once by you at 2026-10-23T09:42:00.000Z",
      // Carried on after the approval: its work item's end.
      "update Sent. at 2026-10-23T09:42:20.000Z",
    ]);
    const decision = report.entries[1];
    expect(decision?.kind === "decision" && decision.action).toEqual({
      toolRef: "openbot/share_private_information",
      effect: "share_private",
      scope: "external:ana@example.test",
      args: send.action.args,
      target: { kind: "external", id: "ana@example.test" },
    });
  });

  test("the task's own ask is not a reply; the person's replies are, in their words", () => {
    const report = buildTaskReport(
      input({
        messages: [
          ...sendConversation,
          {
            id: "u2",
            role: "user",
            content: "Thanks.\nAlso ask Sam which **box** to use.",
          },
          {
            id: "a5",
            role: "assistant",
            content:
              "I asked Sam in his thread. I'll tell you when he answers.",
          },
          {
            id: "u3",
            role: "user",
            content: [{ type: "text", text: "Great" }],
          },
          {
            id: "a6",
            role: "assistant",
            content: "Sam says double-wall boxes. Packing starts at noon.",
          },
        ],
      }),
    );
    const lines = report.entries.flatMap((entry) =>
      entry.kind === "decision"
        ? []
        : [`${entry.kind}: ${entry.text} @ ${entry.at}`],
    );
    expect(lines).toEqual([
      "update: I read Ana's email. @ 2026-10-23T09:41:10.000Z",
      "update: Sent. @ 2026-10-23T09:42:20.000Z",
      "reply: Thanks. Also ask Sam which box to use. @ null",
      // A turn the person started in their browser left no time anywhere, unless it is the latest.
      "update: I asked Sam in his thread. @ null",
      "reply: Great @ null",
      "update: Sam says double-wall boxes. @ 2026-10-23T09:42:19.000Z",
    ]);
  });

  test("successive corrections keep their own words and a replay adds no human reply", () => {
    const ask = "Draft a reply to Rosa.";
    const firstCorrection = frameTaskReply(ask, "Use the Oat Satin glaze.");
    const messages: ReportMessage[] = [
      { id: "initial", role: "user", content: frameTaskBrief(ask) },
      { id: "failed", role: "assistant", content: "I could not finish." },
      { id: "retry", role: "user", content: firstCorrection },
      { id: "failed-again", role: "assistant", content: "Still unavailable." },
    ];
    const report = () => buildTaskReport(input({ messages, approvals: [] }));
    expect(report().entries.filter((entry) => entry.kind === "reply")).toEqual([
      {
        kind: "reply",
        id: "retry",
        text: "Use the Oat Satin glaze.",
        at: null,
      },
    ]);
    messages.push(
      {
        id: "retry-again",
        role: "user",
        content: frameTaskReply(firstCorrection, "Ask for delivery on Friday."),
      },
      { id: "drafted", role: "assistant", content: "Drafted." },
      { id: "replay", role: "user", content: frameTaskBrief(ask) },
      { id: "done", role: "assistant", content: "Checked the draft." },
    );
    expect(report().entries).toEqual([
      {
        kind: "update",
        id: "failed",
        text: "I could not finish.",
        at: "2026-10-23T09:41:12.000Z",
      },
      {
        kind: "reply",
        id: "retry",
        text: "Use the Oat Satin glaze.",
        at: null,
      },
      {
        kind: "update",
        id: "failed-again",
        text: "Still unavailable.",
        at: null,
      },
      {
        kind: "reply",
        id: "retry-again",
        text: "Ask for delivery on Friday.",
        at: null,
      },
      { kind: "update", id: "drafted", text: "Drafted.", at: null },
      {
        kind: "update",
        id: "done",
        text: "Checked the draft.",
        at: "2026-10-23T09:42:19.000Z",
      },
    ]);
  });

  test("while the task works, its latest turn is still being written and is left out", () => {
    const report = buildTaskReport(
      input({ task: { id: "task-1", status: "working" } }),
    );
    expect(report.entries.map((entry) => entry.kind)).toEqual([
      "update",
      "decision",
    ]);
  });

  test("a refusal the conversation has not carried on from sits after the call it was about", () => {
    const refused: ReportApproval = {
      ...send,
      status: "denied",
      decision: "deny",
      completedAt: null,
    };
    const report = buildTaskReport(
      input({
        approvals: [refused],
        messages: sendConversation.slice(0, 5),
        resumedEndedAt: new Map(),
      }),
    );
    expect(
      report.entries.map((entry) =>
        entry.kind === "decision" ? `decision ${entry.decision}` : entry.kind,
      ),
    ).toEqual(["update", "decision deny"]);
  });

  test("an approval still waiting is not a decision, and one decided off the record goes last", () => {
    const waiting: ReportApproval = {
      ...send,
      status: "pending",
      decision: null,
      decidedAt: null,
    };
    expect(
      buildTaskReport(
        input({ approvals: [waiting], messages: sendConversation.slice(0, 5) }),
      ).entries.map((entry) => entry.kind),
    ).toEqual(["update"]);
    const elsewhere: ReportApproval = {
      ...send,
      id: "approval-other",
      toolCallId: "call-not-in-history",
      decision: "allow_always",
    };
    const report = buildTaskReport(input({ approvals: [send, elsewhere] }));
    expect(report.entries.at(-1)).toMatchObject({
      kind: "decision",
      id: "approval-other",
      decision: "allow_always",
    });
  });

  test("the first turn's update takes its work item's end when it did not stop to ask", () => {
    const report = buildTaskReport(
      input({
        approvals: [],
        messages: [
          brief,
          {
            id: "a1",
            role: "assistant",
            content: "Done. The notes are ready.",
          },
          { id: "u2", role: "user", content: "Thanks" },
        ],
      }),
    );
    expect(report.entries[0]).toEqual({
      kind: "update",
      id: "a1",
      text: "Done.",
      at: "2026-10-23T09:41:12.000Z",
    });
  });
});

describe("an update's first sentence", () => {
  test("stops at a sentence, not at an abbreviation or a number, without markdown, cut at a word", () => {
    expect(firstSentence("## Done\n\nThe deck is ready.")).toBe("Done");
    expect(firstSentence("- **Sent** the reply. Ana has it.")).toBe(
      "Sent the reply.",
    );
    expect(
      firstSentence("Order no. 5521 ships e.g. by Friday. Then Monday."),
    ).toBe("Order no. 5521 ships e.g. by Friday.");
    expect(firstSentence("See [the deck](https://x.test) for more")).toBe(
      "See the deck for more",
    );
    const long = `I ${"looked through every message about the Hearth order and ".repeat(4)}found it.`;
    const cut = firstSentence(long);
    expect(cut.length).toBeLessThanOrEqual(161);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("GET /api/tasks/:id/report", () => {
  const task: TaskRecord = {
    id: "task-1",
    botId: "assistant",
    channelId: "channel-1",
    threadId: "thread-1",
    title: "Reply to Ana",
    why: null,
    origin: "asked",
    suggestionId: null,
    sourceApp: null,
    sourceLink: null,
    status: "ready_for_review",
    failure: null,
    failedAt: null,
    next: null,
    queuedReplies: [],
    answeredQuestionIds: [],
    resolvedAt: null,
    createdAt: "2026-10-23T09:41:00.000Z",
    updatedAt: "2026-10-23T09:41:00.000Z",
  };
  const store = {
    get: async (owner: string, id: string) => {
      if (owner !== "owner" || id !== task.id) throw new TaskNotFoundError();
      return task;
    },
  } as unknown as TaskStore;
  const routes = (report?: TaskReportReader) => {
    const app = new Hono();
    app.route(
      "/tasks",
      createTaskRoutes(
        store,
        async (context, next) => {
          context.set("actor", {
            id: context.req.header("x-actor") ?? "owner",
          } as never);
          await next();
        },
        { report },
      ),
    );
    return app;
  };

  test("answers the owner's task's report, read for that owner", async () => {
    const asked: [string, string][] = [];
    const response = await routes(async (owner, read) => {
      asked.push([owner, read.id]);
      return buildTaskReport(input());
    }).request("/tasks/task-1/report");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      report: { taskId: string; entries: unknown[] };
    };
    expect(body.report).toEqual(
      JSON.parse(JSON.stringify(buildTaskReport(input()))),
    );
    expect(body.report.taskId).toBe("task-1");
    expect(body.report.entries).toHaveLength(3);
    expect(asked).toEqual([["owner", "task-1"]]);
  });

  test("another person's task is no task, a failed read says so, and no reader means no route", async () => {
    const reader: TaskReportReader = async () => buildTaskReport(input());
    const other = await routes(reader).request("/tasks/task-1/report", {
      headers: { "x-actor": "someone-else" },
    });
    expect(other.status).toBe(404);
    const failing = await routes(async () => {
      throw new Error("Intelligence is down");
    }).request("/tasks/task-1/report");
    expect(failing.status).toBe(503);
    expect(await failing.json()).toEqual({
      error: "Couldn't load this task's report. Try again.",
    });
    const absent = await routes().request("/tasks/task-1/report");
    expect(absent.status).toBe(404);
  });
});
