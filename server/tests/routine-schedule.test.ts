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

  /**
   * The floor must be a property of the expression, not of the clock at the moment of asking.
   *
   * "45,55 8 * * *" has one ten-minute pair per day. A check that samples only the next two
   * occurrences after `after` sees that pair when asked before 08:45 and a 23h50m gap when asked at
   * 08:50 — so the routine is accepted or refused depending on when the person happened to create
   * it, and an accepted one wedges at its first advance: the sweep hands `nextOccurrence` an `after`
   * of 08:45, the pair check throws, and `next_run_at` never moves again.
   */
  test("refuses a sub-floor adjacent pair no matter when it is asked about", () => {
    // Asked from a moment where the next two occurrences are 23h50m apart: the shape the
    // next-two-samples check accepted.
    expect(() =>
      nextOccurrence("45,55 8 * * *", "UTC", new Date("2026-01-01T08:50:00Z")),
    ).toThrow("Routines may run at most every 15 minutes.");
    // And from a moment where the pair is the next thing ahead, for symmetry.
    expect(() =>
      nextOccurrence("45,55 8 * * *", "UTC", new Date("2026-01-01T00:00:00Z")),
    ).toThrow(ScheduleRefusedError);
  });

  test("refuses a sub-floor pair that only exists on one day of the year", () => {
    // 09:00 and 09:10 every 25 December. Asked five minutes after the 09:05 of one Christmas, the
    // next two occurrences are 09:10 and NEXT year's 09:00 — the old sampling accepted that.
    expect(() =>
      nextOccurrence("0,10 9 25 12 *", "UTC", new Date("2026-12-25T09:05:00Z")),
    ).toThrow("Routines may run at most every 15 minutes.");
  });

  test("refuses a sub-floor gap that only appears across midnight", () => {
    // 00:00, 00:50, 23:00 and 23:50 every day: every same-day gap clears the floor, but 23:50 to
    // the next day's 00:00 is ten minutes. A scan that stopped at one day's occurrences would
    // accept it.
    expect(() =>
      nextOccurrence(
        "0,50 0,23 * * *",
        "UTC",
        new Date("2026-01-01T00:10:00Z"),
      ),
    ).toThrow("Routines may run at most every 15 minutes.");
  });

  test("still accepts a listed pair that clears the floor", () => {
    const result = nextOccurrence(
      "0,30 9 * * *",
      "UTC",
      new Date("2026-01-01T09:05:00Z"),
    );
    expect(result.toISOString()).toBe("2026-01-01T09:30:00.000Z");
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

  test("step minutes", () => {
    expect(describeCron("*/20 * * * *")).toBe("Every 20 minutes");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
  });

  // Cron minute steps restart every hour, so */40 does not actually fire every 40 minutes: it
  // fires at :00 and :40 past each hour, a 20-minute gap the second time round. "Every 40 minutes"
  // would be false prose, so a step that does not divide the hour evenly falls back to the raw
  // expression rather than claim a cadence the schedule does not keep.
  test("a step that does not evenly divide the hour falls through to the raw expression", () => {
    expect(describeCron("*/40 * * * *")).toBe("*/40 * * * *");
  });

  // */1 is reachable through the exported function even though the create-time floor refuses it,
  // and "Every 1 minutes" is bad grammar besides. A step of 1 falls back to the raw expression.
  test("a step of exactly 1 minute falls through to the raw expression", () => {
    expect(describeCron("*/1 * * * *")).toBe("*/1 * * * *");
  });

  test("a comma list of plain minutes on one hour", () => {
    expect(describeCron("0,30 9 * * *")).toBe("Every day at 09:00 and 09:30");
  });

  test("falls through to the raw expression when it is stranger than words", () => {
    expect(describeCron("*/7 3,4 * * *")).toBe("*/7 3,4 * * *");
  });

  // A comma list on the hour field (twice a day) has no narrow rendering here, and that is the
  // contract, not a gap: cron cannot be rendered exhaustively in prose without a dedicated
  // library, so this shape is expected to stay on the raw-expression fallback. If someone later
  // teaches `describeCron` this shape, that is a deliberate extension, not a bug fix.
  test("falls through to the raw expression for an hour list, by design", () => {
    expect(describeCron("0 9,17 * * *")).toBe("0 9,17 * * *");
  });

  test("never throws, even on garbage", () => {
    expect(describeCron("not a cron expression")).toBe("not a cron expression");
  });
});
