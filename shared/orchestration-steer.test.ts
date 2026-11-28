import { expect, test } from "bun:test";
import {
  readTaskReport,
  STEER_MAX,
  steerWords,
  taskReportMessageId,
} from "./orchestration";

/**
 * What the person told a task in its thread, as the line under its card quotes it, and the id the
 * conversation that asked knows it by. Pure rules, held to the kinds of thing people type.
 */

test("a short steer is quoted as it was typed, on one line", () => {
  expect(steerWords("also check the Friday listings")).toBe(
    "also check the Friday listings",
  );
  expect(steerWords("  Skip basil.\n\nAdd  marigold instead \n")).toBe(
    "Skip basil. Add marigold instead",
  );
  expect(steerWords("価格も比較して 🙏")).toBe("価格も比較して 🙏");
});

test("a long steer is cut at a word, within the line's length, and says it was cut", () => {
  const long =
    "Actually, while you are in there, also pull the delivery estimates for each of the three seed packets, note which ones ship from overseas, and flag anything that would arrive after the first frost date in my area.";
  const line = steerWords(long);
  expect(Array.from(line).length).toBeLessThanOrEqual(STEER_MAX);
  expect(line.endsWith("…")).toBe(true);
  // Cut between words, with no punctuation left hanging before the ellipsis.
  const kept = line.slice(0, -1);
  expect(long.startsWith(kept)).toBe(true);
  expect(long.charAt(kept.length)).toMatch(/[\s,.]/);
  expect(kept).not.toMatch(/[\s,.;:]$/);
});

test("one long word, such as a link, is cut where it is", () => {
  const link = `https://shop.example/${"a".repeat(300)}`;
  const line = steerWords(`use ${link}`);
  expect(Array.from(line).length).toBe(STEER_MAX);
  expect(line.endsWith("…")).toBe(true);
});

test("a steer is read back from its message id, as a task's other reports are", () => {
  const id = taskReportMessageId("steer", "task-1", "run-1");
  expect(readTaskReport(id)).toEqual({ kind: "steer", taskId: "task-1" });
  expect(readTaskReport("task-report:nonsense:task-1:run-1")).toBeNull();
});
