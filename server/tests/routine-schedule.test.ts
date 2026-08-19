import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GRACE_MS,
  decideScheduleAction,
  describeSchedule,
  lastOccurrenceOnOrBefore,
  nextDueAt,
  nextOccurrenceAfter,
  parseRoutineSchedule,
  type RoutineSchedule,
} from "../src/routines/schedule";

/**
 * The arithmetic, which is where the mistakes live.
 *
 * Every case here is one a deployment actually meets, and several of them have an obvious answer
 * that is wrong. A daily time that has already passed today must not fire again today. A weekday set
 * that excludes today must skip to the next day it does include, across the end of the week. A
 * machine that was asleep must record the window rather than run it four hours late. None of these
 * can be seen from a green typecheck, and none of them would be caught by a test that only checked
 * that a schedule at nine o'clock fires at nine o'clock.
 *
 * The clock is an argument everywhere, so the eight o'clock that fell on a Sunday is a line of test
 * rather than something to wait for.
 */

/**
 * Thursday, 13 August 2026, midnight UTC.
 *
 * A real date rather than a relative one, so a reader can check the weekday arithmetic by eye and a
 * failing test means the arithmetic changed rather than that the week did.
 */
const THURSDAY = "2026-08-13T00:00:00.000Z";
const at = (iso: string) => new Date(iso);

const weekdaysAtEight: RoutineSchedule = {
  type: "daily",
  time: "08:00",
  weekdays: [1, 2, 3, 4, 5],
};

describe("reading a schedule", () => {
  test("accepts a once and normalises the instant", () => {
    expect(
      parseRoutineSchedule({ type: "once", at: "2026-08-13T08:00:00Z" }),
    ).toEqual({ type: "once", at: "2026-08-13T08:00:00.000Z" });
  });

  test("accepts a daily and sorts and de-duplicates its days", () => {
    expect(
      parseRoutineSchedule({
        type: "daily",
        time: "08:00",
        weekdays: [5, 1, 1, 3],
      }),
    ).toEqual({ type: "daily", time: "08:00", weekdays: [1, 3, 5] });
  });

  test("an empty weekday set is legal, and means never", () => {
    const schedule = parseRoutineSchedule({
      type: "daily",
      time: "08:00",
      weekdays: [],
    });
    expect(schedule).toEqual({ type: "daily", time: "08:00", weekdays: [] });
    // A form with nothing ticked must not quietly mean every day. Nothing ticked means nothing runs.
    expect(
      nextOccurrenceAfter(schedule as RoutineSchedule, at(THURSDAY)),
    ).toBeNull();
  });

  /*
   * Every one of these is refused rather than repaired. A schedule decides when a Bot acts on
   * somebody's live systems, and accepting a value in a shape other than the one it was written in
   * is the single behaviour that must never happen here.
   */
  test.each([
    ["a time with no minutes", { type: "daily", time: "08", weekdays: [1] }],
    ["a 24th hour", { type: "daily", time: "24:00", weekdays: [1] }],
    ["a 60th minute", { type: "daily", time: "08:60", weekdays: [1] }],
    ["a weekday out of range", { type: "daily", time: "08:00", weekdays: [7] }],
    ["a fractional weekday", { type: "daily", time: "08:00", weekdays: [1.5] }],
    [
      "weekdays that are not a list",
      { type: "daily", time: "08:00", weekdays: 1 },
    ],
    ["an unparseable instant", { type: "once", at: "next Tuesday" }],
    ["a type nobody implements", { type: "hourly", minute: 0 }],
    ["nothing at all", null],
    ["a list", [{ type: "once", at: THURSDAY }]],
  ])("refuses %s", (_label, value) => {
    expect(parseRoutineSchedule(value)).toBeNull();
  });
});

describe("a daily schedule on weekdays", () => {
  test("the next occurrence after Thursday midnight is Thursday morning", () => {
    expect(
      nextOccurrenceAfter(weekdaysAtEight, at(THURSDAY))?.toISOString(),
    ).toBe("2026-08-13T08:00:00.000Z");
  });

  test("a time that has already passed today goes to tomorrow, not round again", () => {
    // The obvious wrong answer is today's eight o'clock, which is behind us.
    expect(
      nextOccurrenceAfter(
        weekdaysAtEight,
        at("2026-08-13T09:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-08-14T08:00:00.000Z");
  });

  test("asked at exactly the hour, the next one is tomorrow", () => {
    expect(
      nextOccurrenceAfter(
        weekdaysAtEight,
        at("2026-08-13T08:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-08-14T08:00:00.000Z");
  });

  test("Friday evening skips the weekend and lands on Monday", () => {
    expect(
      nextOccurrenceAfter(
        weekdaysAtEight,
        at("2026-08-14T20:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-08-17T08:00:00.000Z");
  });

  test("the most recent window on a Sunday is the Friday before it", () => {
    expect(
      lastOccurrenceOnOrBefore(
        weekdaysAtEight,
        at("2026-08-16T12:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-08-14T08:00:00.000Z");
  });

  test("before the first hour of the day, the most recent window is yesterday's", () => {
    expect(
      lastOccurrenceOnOrBefore(
        weekdaysAtEight,
        at("2026-08-13T07:59:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-08-12T08:00:00.000Z");
  });

  test("a Sunday-only schedule crosses the week boundary in both directions", () => {
    const sundays: RoutineSchedule = {
      type: "daily",
      time: "23:30",
      weekdays: [0],
    };
    expect(
      nextOccurrenceAfter(
        sundays,
        at("2026-08-17T00:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-08-23T23:30:00.000Z");
    expect(
      lastOccurrenceOnOrBefore(
        sundays,
        at("2026-08-17T00:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-08-16T23:30:00.000Z");
  });

  test("crossing the end of a month is ordinary", () => {
    expect(
      nextOccurrenceAfter(
        { type: "daily", time: "06:15", weekdays: [0, 1, 2, 3, 4, 5, 6] },
        at("2026-08-31T23:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-09-01T06:15:00.000Z");
  });
});

describe("deciding what to do about a daily routine", () => {
  test("runs it when the window has just opened and nobody has taken it", () => {
    expect(
      decideScheduleAction(weekdaysAtEight, {
        now: at("2026-08-13T08:00:30.000Z"),
        lastRunAt: null,
      }),
    ).toEqual({ action: "run", dueAt: at("2026-08-13T08:00:00.000Z") });
  });

  test("does not run it twice when a run already covers the window", () => {
    const decision = decideScheduleAction(weekdaysAtEight, {
      now: at("2026-08-13T08:03:00.000Z"),
      lastRunAt: at("2026-08-13T08:00:10.000Z"),
    });
    expect(decision.action).toBe("wait");
  });

  /*
   * A person who pressed Run now at two minutes to eight does not want it again at eight. Manual
   * runs are not a separate history for exactly this reason: a run is a run, and the routine has
   * just done its work.
   */
  test("a manual run just before the window takes the window with it", () => {
    const decision = decideScheduleAction(weekdaysAtEight, {
      now: at("2026-08-13T08:01:00.000Z"),
      lastRunAt: at("2026-08-13T08:00:30.000Z"),
    });
    expect(decision.action).toBe("wait");
  });

  test("a run from before the window does not count as having taken it", () => {
    const decision = decideScheduleAction(weekdaysAtEight, {
      now: at("2026-08-13T08:01:00.000Z"),
      lastRunAt: at("2026-08-12T08:00:10.000Z"),
    });
    expect(decision.action).toBe("run");
  });

  test("a window older than the grace period is missed, not run late", () => {
    // The laptop was shut at eight and opened at noon. Firing now would send the overnight summary
    // at lunchtime, and saying nothing would leave the person unable to tell that from a quiet night.
    const decision = decideScheduleAction(weekdaysAtEight, {
      now: at("2026-08-13T12:00:00.000Z"),
      lastRunAt: null,
    });
    expect(decision).toEqual({
      action: "missed",
      dueAt: at("2026-08-13T08:00:00.000Z"),
    });
  });

  test("the grace period's own edge runs rather than misses", () => {
    const decision = decideScheduleAction(weekdaysAtEight, {
      now: new Date(
        at("2026-08-13T08:00:00.000Z").getTime() + DEFAULT_GRACE_MS,
      ),
      lastRunAt: null,
    });
    expect(decision.action).toBe("run");
  });

  test("one millisecond past it misses", () => {
    const decision = decideScheduleAction(weekdaysAtEight, {
      now: new Date(
        at("2026-08-13T08:00:00.000Z").getTime() + DEFAULT_GRACE_MS + 1,
      ),
      lastRunAt: null,
    });
    expect(decision.action).toBe("missed");
  });

  /*
   * Recording a miss stamps the run with the window's own time, so this is what the next tick sees.
   * Without that, the same window would be recorded as missed once a minute until the next one came
   * round, and the history would be four hundred identical rows.
   */
  test("a recorded miss stops the same window being recorded again", () => {
    const decision = decideScheduleAction(weekdaysAtEight, {
      now: at("2026-08-13T12:01:00.000Z"),
      lastRunAt: at("2026-08-13T08:00:00.000Z"),
    });
    expect(decision.action).toBe("wait");
  });

  test("waits on a Sunday, when the last window is Friday's and was taken", () => {
    const decision = decideScheduleAction(weekdaysAtEight, {
      now: at("2026-08-16T09:00:00.000Z"),
      lastRunAt: at("2026-08-14T08:00:05.000Z"),
    });
    expect(decision).toEqual({
      action: "wait",
      nextDueAt: at("2026-08-17T08:00:00.000Z"),
    });
  });

  test("a schedule with no days never runs and never misses", () => {
    const decision = decideScheduleAction(
      { type: "daily", time: "08:00", weekdays: [] },
      { now: at("2026-08-13T23:00:00.000Z"), lastRunAt: null },
    );
    expect(decision).toEqual({ action: "wait", nextDueAt: null });
  });
});

describe("a once schedule", () => {
  const once: RoutineSchedule = {
    type: "once",
    at: "2026-08-13T08:00:00.000Z",
  };

  test("waits while its moment is still ahead", () => {
    expect(
      decideScheduleAction(once, {
        now: at("2026-08-12T08:00:00.000Z"),
        lastRunAt: null,
      }),
    ).toEqual({ action: "wait", nextDueAt: at("2026-08-13T08:00:00.000Z") });
  });

  test("runs when its moment arrives", () => {
    expect(
      decideScheduleAction(once, {
        now: at("2026-08-13T08:00:00.000Z"),
        lastRunAt: null,
      }).action,
    ).toBe("run");
  });

  test("is missed rather than fired late when nothing was running for it", () => {
    expect(
      decideScheduleAction(once, {
        now: at("2026-08-14T08:00:00.000Z"),
        lastRunAt: null,
      }),
    ).toEqual({ action: "missed", dueAt: at("2026-08-13T08:00:00.000Z") });
  });

  /*
   * The one that would be easy to get wrong. A `once` that has fired is finished, and a decision
   * function that only compared times would fire it again on every tick for the rest of the
   * deployment's life.
   */
  test("never runs a second time once it has run", () => {
    expect(
      decideScheduleAction(once, {
        now: at("2026-09-01T08:00:00.000Z"),
        lastRunAt: at("2026-08-13T08:00:01.000Z"),
      }),
    ).toEqual({ action: "wait", nextDueAt: null });
  });

  test("an overdue once still says when it was expected", () => {
    // Null here would render as "nothing scheduled", which is exactly wrong for a routine that was
    // set for this morning and did not happen.
    expect(
      nextDueAt(once, {
        now: at("2026-08-14T08:00:00.000Z"),
        lastRunAt: null,
      })?.toISOString(),
    ).toBe("2026-08-13T08:00:00.000Z");
  });
});

describe("how a schedule reads", () => {
  test("names the days when only some are chosen", () => {
    expect(describeSchedule(weekdaysAtEight)).toBe(
      "Monday, Tuesday, Wednesday, Thursday, Friday at 08:00 UTC",
    );
  });

  test("says every day rather than listing seven", () => {
    expect(
      describeSchedule({
        type: "daily",
        time: "06:15",
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      }),
    ).toBe("Every day at 06:15 UTC");
  });

  test("admits when nothing is selected", () => {
    expect(
      describeSchedule({ type: "daily", time: "08:00", weekdays: [] }),
    ).toBe("Never, no days are selected");
  });

  test("every description says UTC, because the arithmetic is", () => {
    expect(
      describeSchedule({ type: "once", at: "2026-08-13T08:00:00.000Z" }),
    ).toContain("UTC");
  });
});
