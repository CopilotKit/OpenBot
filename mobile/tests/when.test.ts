/**
 * Times read as a sentence reads them, not as a database writes them: a routine's next run is
 * "Tomorrow, 9:00 AM", never "11/26/2026, 9:00:00 AM".
 */
import { expect, test } from "bun:test";
import { momentWhen, took } from "../src/when";

const now = new Date(2026, 10, 25, 12, 0); // Wednesday, November 25th 2026, noon
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).toISOString();
const time = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

test("today, tomorrow and yesterday are named", () => {
  expect(momentWhen(at(25, 15), now)).toBe(`Today, ${time(25, 15)}`);
  expect(momentWhen(at(26, 9), now)).toBe(`Tomorrow, ${time(26, 9)}`);
  expect(momentWhen(at(24, 17, 42), now)).toBe(
    `Yesterday, ${time(24, 17, 42)}`,
  );
});

test("within the week, the weekday; further, the date; never seconds", () => {
  expect(momentWhen(at(30, 17), now)).toStartWith(
    new Date(2026, 10, 30).toLocaleDateString(undefined, { weekday: "long" }),
  );
  expect(momentWhen(at(10, 17), now)).not.toContain("2026");
  expect(momentWhen(at(26, 9), now)).not.toMatch(/:\d\d:\d\d/);
});

test("no time, or a time that isn't one, reads as nothing", () => {
  expect(momentWhen(null, now)).toBe("");
  expect(momentWhen("not a date", now)).toBe("");
});

test("how long a run took reads in minutes and hours", () => {
  const start = new Date(2026, 10, 25, 9, 0).toISOString();
  const after = (minutes: number) =>
    new Date(2026, 10, 25, 9, minutes).toISOString();
  expect(took(start, after(0))).toBe("under a minute");
  expect(took(start, after(2))).toBe("2 min");
  expect(took(start, after(65))).toBe("1 hr 5 min");
  expect(took(start, after(120))).toBe("2 hr");
  expect(took(start, null)).toBe("");
  expect(took(after(5), start)).toBe("");
});
