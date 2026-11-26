/**
 * A routine made on the phone gets the same cron as one made on the web app, and the form reads a
 * routine's cron back into its choices only when it wrote that shape itself.
 */
import { expect, test } from "bun:test";
import {
  cronFrom,
  DEFAULT_SCHEDULE,
  scheduleFrom,
  scheduleSentence,
} from "../src/routine-schedule";

test("each choice writes the web app's cron", () => {
  const at = { ...DEFAULT_SCHEDULE, time: "07:30" };
  expect(cronFrom({ ...at, repeat: "daily" })).toBe("30 7 * * *");
  expect(cronFrom({ ...at, repeat: "weekdays" })).toBe("30 7 * * 1-5");
  expect(cronFrom({ ...at, repeat: "weekly", weekday: 5 })).toBe("30 7 * * 5");
  expect(cronFrom({ ...at, repeat: "monthly", monthDay: 15 })).toBe(
    "30 7 15 * *",
  );
  expect(cronFrom({ ...at, repeat: "hourly" })).toBe("0 * * * *");
});

test("what the form writes, it reads back", () => {
  for (const schedule of [
    { ...DEFAULT_SCHEDULE, repeat: "daily" as const, time: "18:05" },
    { ...DEFAULT_SCHEDULE, repeat: "weekdays" as const },
    { ...DEFAULT_SCHEDULE, repeat: "weekly" as const, weekday: 0 },
    { ...DEFAULT_SCHEDULE, repeat: "monthly" as const, monthDay: 28 },
  ])
    expect(scheduleFrom(cronFrom(schedule))).toEqual(schedule);
});

test("a schedule the form can't say is left alone", () => {
  expect(scheduleFrom("0 9 * * 2/2")).toBeNull();
  expect(scheduleFrom("0 9 31 * *")).toBeNull();
  expect(scheduleFrom("0 9 * 1 *")).toBeNull();
  expect(scheduleFrom("nonsense")).toBeNull();
});

test("the choice reads back as a sentence", () => {
  expect(
    scheduleSentence({
      ...DEFAULT_SCHEDULE,
      repeat: "weekdays",
      time: "09:00",
    }),
  ).toBe("Every weekday at 9:00 AM");
  expect(
    scheduleSentence({ ...DEFAULT_SCHEDULE, repeat: "monthly", monthDay: 2 }),
  ).toBe("On the 2nd of every month at 9:00 AM");
});
