/**
 * A newer server may send a status the phone doesn't know yet. The phone reads it as "other": it shows
 * nothing for it rather than "undefined" or a separator with nothing after it, and every status it
 * knows reads exactly as before.
 */
import { expect, test } from "bun:test";
import type { Task } from "../src/api";
import { colors } from "../src/colors";
import { lastRunLine, runColor, runLabel } from "../src/routines";
import { taskLine, waitingTasks } from "../src/tasks";

const task = (status: string, updatedAt: string): Task =>
  ({ id: status, status, updatedAt }) as unknown as Task;

test("a task status the phone doesn't know leaves the Bot's name alone on the card", () => {
  expect(taskLine("Ada", "paused")).toBe("Ada");
  expect(taskLine("Ada", "needs_input")).toBe("Ada · Needs input");
  expect(taskLine("Ada", "ready_for_review")).toBe("Ada · Ready for review");
});

test("a task in a status the phone doesn't know is not listed as waiting on the person", () => {
  const waiting = waitingTasks([
    task("paused", "2026-11-17T10:00:00Z"),
    task("failed", "2026-11-17T09:00:00Z"),
    task("ready_for_review", "2026-11-17T08:00:00Z"),
  ]);
  expect(waiting.map((each) => each.status)).toEqual([
    "ready_for_review",
    "failed",
  ]);
});

test("a run status the phone doesn't know shows no label, and a muted colour", () => {
  expect(runLabel("cancelled")).toBeNull();
  expect(runColor("cancelled")).toBe(colors.muted);
  expect(lastRunLine("cancelled")).toBeNull();
  expect(runLabel("succeeded")).toBe("Succeeded");
  expect(runColor("failed")).toBe(colors.error);
  expect(lastRunLine("waiting")).toBe("Last run: Waiting for you");
  expect(lastRunLine(null)).toBeNull();
});
