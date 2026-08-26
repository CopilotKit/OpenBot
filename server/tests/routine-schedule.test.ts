import { describe, expect, test } from "bun:test";
import {
  describeCron,
  MINIMUM_INTERVAL_MS,
  nextOccurrence,
  ScheduleRefusedError,
} from "../src/routines/schedule";

describe("nextOccurrence", () => {
  test("crosses the US spring-forward DST boundary at 09:30 local on both sides", () => {
    // 2026-03-08 is when America/New_York springs forward (02:00 -> 03:00 local).
    // A naive "+24h in UTC" implementation would land at 08:30 or 10:30 local on
    // one side of the transition; a correct implementation stays pinned at 09:30
    // local because it re-derives wall-clock time in the target zone each day.
    const before = nextOccurrence(
      "30 9 * * *",
      "America/New_York",
      new Date("2026-03-07T00:00:00Z"),
    );
    // 2026-03-07 09:30 EST (UTC-5) -> 14:30 UTC. Before the transition.
    expect(before.toISOString()).toBe("2026-03-07T14:30:00.000Z");

    const after = nextOccurrence("30 9 * * *", "America/New_York", before);
    // 2026-03-08 09:30 EDT (UTC-4) -> 13:30 UTC. After the transition.
    expect(after.toISOString()).toBe("2026-03-08T13:30:00.000Z");
  });

  test("refuses every-minute schedules with the floor sentence", () => {
    expect(() =>
      nextOccurrence("* * * * *", "UTC", new Date("2026-01-01T00:00:00Z")),
    ).toThrow(ScheduleRefusedError);
    expect(() =>
      nextOccurrence("* * * * *", "UTC", new Date("2026-01-01T00:00:00Z")),
    ).toThrow("Routines may run at most every 15 minutes.");
  });

  test("refuses every-5-minute schedules with the floor sentence", () => {
    expect(() =>
      nextOccurrence("*/5 * * * *", "UTC", new Date("2026-01-01T00:00:00Z")),
    ).toThrow("Routines may run at most every 15 minutes.");
  });

  test("accepts a 15-minute schedule, exactly at the floor", () => {
    expect(MINIMUM_INTERVAL_MS).toBe(15 * 60 * 1000);
    const result = nextOccurrence(
      "*/15 * * * *",
      "UTC",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(result).toBeInstanceOf(Date);
  });

  test("refuses an unknown IANA timezone", () => {
    expect(() =>
      nextOccurrence(
        "0 9 * * *",
        "Mars/Olympus",
        new Date("2026-01-01T00:00:00Z"),
      ),
    ).toThrow("That is not a timezone I know.");
  });

  test("refuses an expression that is not five whitespace-separated fields", () => {
    expect(() =>
      nextOccurrence("0 9 * *", "UTC", new Date("2026-01-01T00:00:00Z")),
    ).toThrow("That schedule could not be read.");
    expect(() =>
      nextOccurrence("0 9 * * * *", "UTC", new Date("2026-01-01T00:00:00Z")),
    ).toThrow("That schedule could not be read.");
  });

  test("refuses garbage that is not a cron expression at all", () => {
    expect(() =>
      nextOccurrence("every morning", "UTC", new Date("2026-01-01T00:00:00Z")),
    ).toThrow("That schedule could not be read.");
  });

  test("is strictly after `after`, even when `after` sits exactly on an occurrence", () => {
    // Midnight UTC is itself a "0 0 * * *" occurrence; the next one must be the
    // following midnight, not the same instant handed in.
    const after = new Date("2026-01-01T00:00:00Z");
    const result = nextOccurrence("0 0 * * *", "UTC", after);
    expect(result.getTime()).toBeGreaterThan(after.getTime());
    expect(result.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });
});

describe("describeCron", () => {
  test("every day", () => {
    expect(describeCron("30 18 * * *")).toBe("Every day at 18:30");
  });

  test("weekdays", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 09:00");
  });

  test("a single weekday", () => {
    expect(describeCron("0 9 * * 3")).toBe("Wednesdays at 09:00");
  });

  test("a listed set of weekdays", () => {
    expect(describeCron("0 9 * * 1,3,5")).toBe(
      "Mondays, Wednesdays and Fridays at 09:00",
    );
  });

  test("monthly on a day", () => {
    expect(describeCron("0 9 1 * *")).toBe("On the 1st of the month at 09:00");
  });

  test("falls through to the raw expression when it is stranger than words", () => {
    expect(describeCron("*/7 3,4 * * *")).toBe("*/7 3,4 * * *");
  });

  test("never throws, even on garbage", () => {
    expect(describeCron("not a cron expression")).toBe("not a cron expression");
  });
});
