/**
 * A Bot's Activity screen groups what it is doing as the web app's does: each entry once, in the group
 * where it stands, and a kind or status a newer server sends is never shown as a raw word nor listed as
 * waiting on the person.
 */
import { expect, test } from "bun:test";
import type {
  BotActivity,
  BotActivityItem,
  Task,
} from "../src/api/generated/model";
import {
  activitySummary,
  canStopTask,
  groupActivity,
  itemLine,
  kindLabel,
  routineIdOf,
  taskGroup,
  taskLabel,
} from "../src/bot-activity";

const item = (change: Partial<BotActivityItem>): BotActivityItem => ({
  id: "i1",
  kind: "handoff",
  title: "Ask Grace",
  detail: null,
  status: "running",
  at: "2026-11-20T10:00:00Z",
  channelId: null,
  needsYou: false,
  stoppable: false,
  cancellable: false,
  ...change,
});

const task = (change: Partial<Task>): Task =>
  ({
    id: "t1",
    botId: "b1",
    conversationId: "c1",
    title: "Reply to Sam",
    status: "working",
    updatedAt: "2026-11-20T09:00:00Z",
    ...change,
  }) as Task;

const empty: BotActivity = {
  inProgress: [],
  scheduled: [],
  onDemand: [],
  completed: [],
};

test("a task lands where it stands, and one the person stopped is not a failure", () => {
  expect(taskGroup(task({ status: "needs_input" }))).toBe("needs_you");
  expect(taskGroup(task({ status: "working" }))).toBe("working");
  expect(taskGroup(task({ status: "failed" }))).toBe("failed");
  expect(
    taskGroup(task({ status: "failed", stoppedAt: "2026-11-20T09:30:00Z" })),
  ).toBe("stopped");
  expect(taskGroup(task({ status: "ready_for_review" }))).toBe("done");
});

test("a task status the phone doesn't know is not waiting on the person, and has no label", () => {
  expect(taskGroup(task({ status: "parked" }))).toBe("done");
  expect(taskLabel(task({ status: "parked" }), "working")).toBeUndefined();
  expect(canStopTask(task({ status: "parked" }))).toBe(false);
  expect(canStopTask(task({ status: "needs_input" }))).toBe(true);
});

test("an approval inside a task's conversation is listed once, as the task", () => {
  const groups = groupActivity({
    activity: {
      ...empty,
      inProgress: [
        item({ id: "a1", kind: "approval", channelId: "c1", needsYou: true }),
        item({ id: "h1", kind: "handoff" }),
      ],
    },
    tasks: [task({ status: "needs_input" })],
  });
  expect(
    groups.map((group) => [group.id, group.entries.map((one) => one.key)]),
  ).toEqual([
    ["needs_you", ["task:t1"]],
    ["working", ["item:h1"]],
  ]);
});

test("routines recur, other lined-up work is scheduled soonest first, and finished work is done or failed", () => {
  const groups = groupActivity({
    activity: {
      inProgress: [],
      scheduled: [
        item({ id: "follow:2", kind: "follow_up", at: "2026-11-22T00:00:00Z" }),
        item({ id: "routine:r1", kind: "routine" }),
        item({ id: "follow:1", kind: "follow_up", at: "2026-11-21T00:00:00Z" }),
      ],
      onDemand: [item({ id: "g1", kind: "responsibility" })],
      completed: [
        item({ id: "d1", status: "done" }),
        item({ id: "f1", status: "failed" }),
      ],
    },
    tasks: [],
  });
  expect(
    groups.map((group) => [group.id, group.entries.map((one) => one.key)]),
  ).toEqual([
    ["scheduled", ["item:follow:1", "item:follow:2"]],
    ["done", ["item:d1"]],
    ["failed", ["item:f1"]],
    ["recurring", ["item:routine:r1", "item:g1"]],
  ]);
});

test("an item's line leaves out a kind the phone doesn't know", () => {
  expect(kindLabel("handoff")).toBe("Delegated task");
  expect(itemLine(item({ detail: "Grace" }), "Yesterday")).toBe(
    "Delegated task · running · Yesterday · Grace",
  );
  expect(itemLine(item({ kind: "meeting" as never, needsYou: true }), "")).toBe(
    "needs you",
  );
  expect(routineIdOf(item({ id: "routine:r9", kind: "routine" }))).toBe("r9");
  expect(routineIdOf(item({ id: "h1" }))).toBeUndefined();
});

test("the Activity row counts what the screen lists", () => {
  const activity = {
    ...empty,
    scheduled: [item({ id: "routine:r1", kind: "routine" })],
  };
  const tasks = [task({})];
  expect(activitySummary(activity, groupActivity({ activity, tasks }))).toBe(
    "1 in progress · 1 scheduled",
  );
  const done = { ...empty, completed: [item({ status: "done" })] };
  expect(
    activitySummary(done, groupActivity({ activity: done, tasks: [] })),
  ).toBe("Nothing running or scheduled");
  expect(activitySummary(empty, [])).toBe("No tasks, routines or goals yet");
});
