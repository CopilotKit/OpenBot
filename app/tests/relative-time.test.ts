import { expect, test } from "bun:test";
import { relativeTime } from "../src/lib/relative-time";

/** The long relative times: a unit never shows its own upper bound after rounding. */

const now = new Date("2026-10-29T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

test("times inside a unit read in that unit", () => {
  expect(relativeTime(ago(5_000), now)).toBe(format.format(-5, "second"));
  expect(relativeTime(ago(5 * MINUTE), now)).toBe(format.format(-5, "minute"));
  expect(relativeTime(ago(3 * HOUR), now)).toBe(format.format(-3, "hour"));
  expect(relativeTime(ago(2 * DAY), now)).toBe(format.format(-2, "day"));
  expect(relativeTime(ago(6 * WEEK), now)).toBe(format.format(-6, "week"));
});

test("a time that rounds up to a unit's bound reads in the next unit", () => {
  expect(relativeTime(ago(59_700), now)).toBe(format.format(-1, "minute"));
  expect(relativeTime(ago(59 * MINUTE + 45_000), now)).toBe(
    format.format(-1, "hour"),
  );
  expect(relativeTime(ago(23 * HOUR + 45 * MINUTE), now)).toBe(
    format.format(-1, "day"),
  );
  expect(relativeTime(ago(6 * DAY + 13 * HOUR), now)).toBe(
    format.format(-1, "week"),
  );
});

test("a future time rounds the same way", () => {
  expect(relativeTime(ago(-59_700), now)).toBe(format.format(1, "minute"));
  expect(relativeTime(ago(-30 * MINUTE), now)).toBe(
    format.format(30, "minute"),
  );
});

test("an invalid date is returned unchanged", () => {
  expect(relativeTime("not a date", now)).toBe("not a date");
});
