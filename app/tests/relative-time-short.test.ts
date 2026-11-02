import { expect, test } from "bun:test";
import { relativeTimeShort } from "../src/lib/relative-time";

/** The sidebar's compact times: a number and a unit letter, so the row keeps its room for words. */

const now = new Date("2026-10-29T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

test("under a minute reads as now", () => {
  expect(relativeTimeShort(ago(0), now)).toBe("now");
  expect(relativeTimeShort(ago(59_000), now)).toBe("now");
});

test("minutes, hours, days and weeks read as one number and a letter", () => {
  expect(relativeTimeShort(ago(5 * MINUTE), now)).toBe("5m");
  expect(relativeTimeShort(ago(3 * HOUR), now)).toBe("3h");
  expect(relativeTimeShort(ago(2 * DAY), now)).toBe("2d");
  expect(relativeTimeShort(ago(6 * WEEK), now)).toBe("6w");
});

test("a unit never shows its own upper bound", () => {
  expect(relativeTimeShort(ago(59 * MINUTE + 59_000), now)).toBe("59m");
  expect(relativeTimeShort(ago(23 * HOUR + 59 * MINUTE), now)).toBe("23h");
});

test("a time a little ahead of this clock reads as now", () => {
  expect(relativeTimeShort(ago(-30_000), now)).toBe("now");
});

test("an invalid date comes back unchanged", () => {
  expect(relativeTimeShort("not a date", now)).toBe("not a date");
});
