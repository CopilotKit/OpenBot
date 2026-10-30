import { expect, test } from "bun:test";
import { orderTasks, RESOLVED_FOR_MS } from "@/lib/tasks/groups";
import type { BotTask } from "@/lib/tasks/queries";

/*
 * The order every list draws a person's tasks in, ported from OpenDuet's Active list: what to read,
 * then what to answer, then what to retry, then what is running, then what was marked done in the
 * last week. A conversation running a turn the server cannot see reads Working, except while it
 * waits on the person.
 */

const now = Date.parse("2026-10-30T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

const task = (
  id: string,
  status: BotTask["status"],
  updatedAt = ago(60_000),
  resolvedAt: string | null = null,
): BotTask => ({
  id,
  agentId: "inbox",
  channelId: `c-${id}`,
  threadId: `t-${id}`,
  title: id,
  why: null,
  origin: "check_in",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  status,
  failure: null,
  failedAt: null,
  next: null,
  resolvedAt,
  createdAt: updatedAt,
  updatedAt,
});

const order = (tasks: BotTask[], busy: string[] = []) =>
  orderTasks(tasks, (channelId) => busy.includes(channelId), now).map(
    ({ task, status }) => `${task.id}:${status}`,
  );

test("tasks list ready, needs input, failed, working, then resolved, newest first within each", () => {
  expect(
    order([
      task("done", "resolved", ago(DAY), ago(DAY)),
      task("running", "working"),
      task("old-ready", "ready_for_review", ago(DAY)),
      task("broke", "failed"),
      task("new-ready", "ready_for_review", ago(1000)),
      task("asks", "needs_input"),
    ]),
  ).toEqual([
    "new-ready:ready_for_review",
    "old-ready:ready_for_review",
    "asks:needs_input",
    "broke:failed",
    "running:working",
    "done:resolved",
  ]);
});

test("a task marked done stays listed for a week, then drops off", () => {
  expect(
    order([
      task("six-days", "resolved", ago(6 * DAY), ago(6 * DAY)),
      task("eight-days", "resolved", ago(8 * DAY), ago(8 * DAY)),
      task("exactly", "resolved", ago(RESOLVED_FOR_MS), ago(RESOLVED_FOR_MS)),
    ]),
  ).toEqual(["six-days:resolved", "exactly:resolved"]);
});

test("a conversation running a turn reads Working, but waiting on the person still comes first", () => {
  expect(
    order(
      [
        task("ready", "ready_for_review"),
        task("done", "resolved", ago(DAY), ago(DAY)),
        task("asks", "needs_input"),
      ],
      ["c-ready", "c-done", "c-asks"],
    ),
  ).toEqual(["asks:needs_input", "ready:working", "done:working"]);
});
