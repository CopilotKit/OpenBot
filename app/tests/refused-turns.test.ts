import { expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { readBrief } from "@openbot/shared/orchestration";
import { readFiring } from "@openbot/shared/routine-firing";
import type { RefusedTurn } from "@/lib/channels/queries";
import { withRefusedTurns } from "@/lib/channels/refused-turns";

/*
 * Refused turns put back into a conversation as the transcript draws it: nothing of a refused turn
 * reaches the thread, so the server's record (`listRefusedTurns`) is where its message and its
 * refusal come back from after a reload.
 */

const REFUSED =
  "This Bot uses GPT-4.1, which your team's models don't include. Ask an admin to change your team's models.";

const thread: Message[] = [
  { id: "asked", role: "user", content: "Name one primary colour." },
  { id: "answered", role: "assistant", content: "Red" },
];

function turn(
  id: string,
  rest: Partial<RefusedTurn> & Pick<RefusedTurn, "createdAt">,
): RefusedTurn {
  return {
    id,
    botId: "atlas",
    threadId: "thread",
    afterMessageId: null,
    message: null,
    initiator: "person",
    code: "MODEL_NOT_ALLOWED",
    detail: REFUSED,
    model: "openai/gpt-4.1",
    ...rest,
  };
}

test("two refused messages go back after the message each came after, oldest first, each with its refusal", () => {
  // Newest first, as the API lists them; the second was sent after the first.
  const turns = [
    turn("t2", {
      afterMessageId: "m1",
      message: { id: "m2", text: "And once more, one word." },
      createdAt: "2026-11-24T01:10:09.000Z",
    }),
    turn("t1", {
      afterMessageId: "answered",
      message: { id: "m1", text: "Say goodbye in one word." },
      createdAt: "2026-11-24T01:09:45.000Z",
    }),
  ];
  const { messages, refusals } = withRefusedTurns(thread, turns);
  expect(messages.map((message) => message.id)).toEqual([
    "asked",
    "answered",
    "m1",
    "m2",
  ]);
  expect(messages[2]).toEqual({
    id: "m1",
    role: "user",
    content: "Say goodbye in one word.",
  });
  expect([...refusals]).toEqual([
    ["m1", REFUSED],
    ["m2", REFUSED],
  ]);
});

test("a message the thread already holds (the live turn) is not drawn twice; its refusal is still said", () => {
  const live: Message[] = [
    ...thread,
    { id: "m1", role: "user", content: "Say goodbye in one word." },
  ];
  const { messages, refusals } = withRefusedTurns(live, [
    turn("t1", {
      afterMessageId: "answered",
      message: { id: "m1", text: "Say goodbye in one word." },
      createdAt: "2026-11-24T01:09:45.000Z",
    }),
  ]);
  expect(messages.map((message) => message.id)).toEqual([
    "asked",
    "answered",
    "m1",
  ]);
  expect(refusals.get("m1")).toBe(REFUSED);
});

test("a routine's and a task's refused turn read as their own kind of turn, after the thread's messages", () => {
  const { messages, refusals } = withRefusedTurns(thread, [
    turn("routine", {
      initiator: "routine",
      message: { id: null, text: "Say hello in one word." },
      createdAt: "2026-11-24T01:00:00.000Z",
    }),
    turn("task", {
      initiator: "task",
      message: { id: null, text: "Find this week's invoices." },
      createdAt: "2026-11-24T01:05:00.000Z",
    }),
  ]);
  const [routine, task] = messages.slice(2);
  // Drawn as the transcript draws a routine's turn (saying it didn't run) and a task's brief.
  expect(readFiring(String(routine?.content))).toBe("Say hello in one word.");
  expect(readBrief(String(task?.content))).toBe("Find this week's invoices.");
  expect(refusals.get("refused-turn:routine")).toBe(REFUSED);
  expect(refusals.get("refused-turn:task")).toBe(REFUSED);
});

test("a turn with no message says its refusal under the message it came after", () => {
  const { messages, refusals } = withRefusedTurns(thread, [
    turn("silent", { createdAt: "2026-11-24T01:00:00.000Z" }),
  ]);
  expect(messages).toEqual(thread);
  expect(refusals.get("answered")).toBe(REFUSED);
});
