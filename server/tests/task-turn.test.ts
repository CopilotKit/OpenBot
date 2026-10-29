import { describe, expect, test } from "bun:test";
import { frameTaskBrief, TASK_ENDING } from "@openbot/shared/task-brief";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { ThreadLockBusyError } from "@openbot/toolkit/lease";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { createTaskTurn } from "../src/tasks/threads";

const SCOPE = {
  ownerUserId: "owner",
  channelId: "task-channel",
  agentId: "assistant",
  threadId: "task-thread",
};
const ASK = "Prepare notes for the Hearth & Co visit.";

function turnWith(runTurn: TurnRunner, options: { final?: boolean } = {}) {
  const said: { text: string; agentId: string | null; id: string }[] = [];
  const busy: boolean[] = [];
  const run = createTaskTurn({
    channels: {
      recordActivity: async (_actor, channelId, activity, source) => {
        expect(channelId).toBe(SCOPE.channelId);
        said.push({
          text: activity.text,
          agentId: activity.agentId,
          id: source?.id ?? "",
        });
      },
      signalBusy: async (threadId, value) => {
        expect(threadId).toBe(SCOPE.threadId);
        busy.push(value);
      },
    },
    actorFor: async (id) => ({ id, role: "user" }),
    runTurn,
  });
  return {
    said,
    busy,
    start: () =>
      run(SCOPE, {
        runId: "task-1",
        text: frameTaskBrief(ASK),
        signal: new AbortController().signal,
        final: options.final ?? false,
      }),
  };
}

describe("a task's turn", () => {
  test("is the person's ask in the task's conversation, which reads as busy once it starts", async () => {
    const asked: Parameters<TurnRunner>[0][] = [];
    const turn = turnWith(async (input) => {
      asked.push(input);
      return { replyText: "Here are your notes." };
    });
    await turn.start();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      ...SCOPE,
      instruction: frameTaskBrief(ASK),
      userMessage: { id: "task-1", role: "user", content: frameTaskBrief(ASK) },
      initiator: { kind: "person" },
    });
    // The conversation reads the ask, never the frame around it, then the Bot's reply.
    expect(turn.said).toEqual([
      { text: ASK, agentId: null, id: "task-1:input" },
      {
        text: "Here are your notes.",
        agentId: "assistant",
        id: "task-1:reply",
      },
    ]);
    // Not busy any more is the engine's to say, once the turn is off the queue.
    expect(turn.busy).toEqual([true]);
  });

  test("tells the Bot how to end, once per task, so its last line reads plainly and asks only when it must", async () => {
    const asked: Parameters<TurnRunner>[0][] = [];
    const turn = turnWith(async (input) => {
      asked.push(input);
      return { replyText: "Booked." };
    });
    await turn.start();
    // One id for every turn of the task, so its conversation holds the guidance once.
    expect(asked[0]?.systemMessages).toEqual([
      { id: "task:ending", role: "system", content: TASK_ENDING },
    ]);
    expect(TASK_ENDING).toContain("Ask them a question only if");
    expect(TASK_ENDING).toContain('written to the person as "you"');
    expect(TASK_ENDING).toContain("Don't label");
  });

  test("records a long reply by how it ends, its next step, not how it starts", async () => {
    const opening = "I read Danny's email and the thread before it. ".repeat(6);
    const turn = turnWith(async () => ({
      replyText: `${opening}\n\n- Draft A: short\n- Draft B: warm\n\nShall I send draft A? It keeps the Friday date.`,
    }));
    await turn.start();
    expect(turn.said.at(-1)).toEqual({
      text: "Shall I send draft A?",
      agentId: "assistant",
      id: "task-1:reply",
    });
  });

  test("that stops for Allow once ends waiting on the person, not failed", async () => {
    const turn = turnWith(async () => {
      throw new HeadlessToolSuspension(
        "This action is waiting for your approval.",
        { kind: "approval", requestId: "a" },
      );
    });
    await turn.start();
    expect(turn.said.at(-1)).toEqual({
      text: "This action is waiting for your approval.",
      agentId: "assistant",
      id: "task-1:waiting",
    });
  });

  test("that fails says so to the queue, and nothing in the conversation while it has a run left", async () => {
    const turn = turnWith(async () => {
      throw new Error("The model is unavailable.");
    });
    await expect(turn.start()).rejects.toThrow("The model is unavailable.");
    expect(turn.said).toEqual([
      { text: ASK, agentId: null, id: "task-1:input" },
    ]);
  });

  test("refused the conversation's lock on its last run, it says nothing: it never ran", async () => {
    const error = new ThreadLockBusyError(new Error("Thread lock denied"));
    const turn = turnWith(
      async () => {
        throw error;
      },
      { final: true },
    );
    await expect(turn.start()).rejects.toBe(error);
    expect(turn.said).toEqual([
      { text: ASK, agentId: null, id: "task-1:input" },
    ]);
  });

  test("that fails on its last run says so in the conversation, in plain words", async () => {
    const turn = turnWith(
      async () => {
        throw new Error("The routine's turn was stopped after 300s.");
      },
      { final: true },
    );
    await expect(turn.start()).rejects.toThrow("stopped after 300s");
    expect(turn.said.at(-1)).toEqual({
      text: "I couldn't finish this: the run took longer than 5 minutes.",
      agentId: "assistant",
      id: "task-1:failed",
    });
  });

  test("with files or skills and nothing to read them with, fails rather than dropping them", async () => {
    const run = createTaskTurn({
      channels: {
        recordActivity: async () => {},
        signalBusy: async () => {},
      },
      actorFor: async (id) => ({ id, role: "user" }),
      runTurn: async () => ({ replyText: "unreachable" }),
    });
    await expect(
      run(SCOPE, {
        runId: "task-2",
        text: "",
        attachmentIds: ["12345678-1234-4123-8123-123456789abc"],
        signal: new AbortController().signal,
        final: false,
      }),
    ).rejects.toThrow("Files and skills are unavailable for this task.");
  });
});
