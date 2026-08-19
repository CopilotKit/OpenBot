/**
 * When a routine is next due, whether it is due now, and whether a window went by unrun.
 *
 * Every function here takes `now` as an argument and reads no clock of its own. That is the whole
 * design: a scheduler that asks the current time in the middle of deciding is a scheduler whose
 * interesting cases, the eight o'clock that fell on a Sunday, the laptop that was shut at eight and
 * opened at noon, can only be reproduced by waiting for them. Passed in, all of it is a table of
 * inputs and expected answers.
 *
 * Times are UTC. A daily routine at `08:00` fires at eight o'clock UTC wherever its owner is, and
 * every surface that shows a time says so rather than letting somebody assume otherwise. A timezone
 * per routine would be the kinder answer and is the obvious next thing to add; what it must not do
 * is be inferred from the server's own locale, because then the same routine means two different
 * times on two machines and neither of them is written down anywhere.
 */

/** A single moment, and then never again. `at` is an ISO instant. */
export type OnceSchedule = { type: "once"; at: string };

/**
 * The same time on a set of weekdays.
 *
 * `time` is `HH:MM` in UTC. `weekdays` uses JavaScript's own numbering, 0 for Sunday through 6 for
 * Saturday, rather than a friendlier one of our own: this number is compared against
 * `Date.getUTCDay()` in one place, and a second numbering would exist only to be translated wrongly.
 * An empty set is legal and means never, which is what a form with nothing ticked should do rather
 * than silently meaning every day.
 */
export type DailySchedule = {
  type: "daily";
  time: string;
  weekdays: number[];
};

export type RoutineSchedule = OnceSchedule | DailySchedule;

/**
 * How late a window may be picked up and still run.
 *
 * A tick that arrives thirty seconds after eight should run the eight o'clock routine; a process
 * that starts at noon should not. Ten minutes is wide enough to cover a slow tick, a restart or a
 * machine that was briefly busy, and narrow enough that "the overnight alerts" are still overnight
 * when the Bot reads them. Beyond it the window is recorded as missed instead, which is a fact the
 * person can act on rather than a stale run they have to notice.
 */
export const DEFAULT_GRACE_MS = 10 * 60_000;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

/**
 * Read a schedule that arrived from the database or over HTTP.
 *
 * Returns null rather than throwing or repairing. A schedule is the thing that decides when a Bot
 * acts on somebody's live systems, and the two behaviours that must never happen here are guessing
 * at what a malformed value meant and letting it through unexamined. The caller decides what to do
 * with a null: a route refuses the request, and the scheduler skips the routine and leaves it
 * visible rather than firing something it does not understand.
 */
export function parseRoutineSchedule(value: unknown): RoutineSchedule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;

  if (candidate.type === "once") {
    if (typeof candidate.at !== "string") return null;
    const at = new Date(candidate.at);
    if (Number.isNaN(at.getTime())) return null;
    // Normalised on the way in, so two spellings of the same instant are one value in the database
    // and a test comparing schedules compares what was meant rather than how it was typed.
    return { type: "once", at: at.toISOString() };
  }

  if (candidate.type === "daily") {
    if (typeof candidate.time !== "string" || !HHMM.test(candidate.time)) {
      return null;
    }
    if (!Array.isArray(candidate.weekdays)) return null;
    const weekdays: number[] = [];
    for (const day of candidate.weekdays) {
      if (typeof day !== "number" || !Number.isInteger(day)) return null;
      if (day < 0 || day > 6) return null;
      if (!weekdays.includes(day)) weekdays.push(day);
    }
    return {
      type: "daily",
      time: candidate.time,
      weekdays: weekdays.sort((left, right) => left - right),
    };
  }

  return null;
}

/**
 * The most recent moment this schedule called for, at or before `at`.
 *
 * Null means it has never called for one yet, which is the honest answer for a `once` scheduled for
 * next Tuesday and for a daily routine on a weekday set that has not come round since it was
 * written.
 */
export function lastOccurrenceOnOrBefore(
  schedule: RoutineSchedule,
  at: Date,
): Date | null {
  if (schedule.type === "once") {
    const fires = new Date(schedule.at);
    return fires.getTime() <= at.getTime() ? fires : null;
  }
  if (schedule.weekdays.length === 0) return null;

  // Walk backwards a day at a time rather than solving for the weekday arithmetically. Eight
  // iterations at most, and it is obviously correct across a week boundary, a leap day and the ends
  // of a month, which the arithmetic version is not.
  for (let back = 0; back <= 7; back += 1) {
    const candidate = atTimeOnUtcDay(schedule.time, addDays(at, -back));
    if (
      candidate.getTime() <= at.getTime() &&
      schedule.weekdays.includes(candidate.getUTCDay())
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * The first moment this schedule calls for strictly after `at`.
 *
 * Strictly after, so asking at exactly eight o'clock returns tomorrow's eight rather than this one.
 * The caller that wants to know whether now is due asks {@link lastOccurrenceOnOrBefore}; this one
 * answers "and when next", which is what the list on screen shows.
 */
export function nextOccurrenceAfter(
  schedule: RoutineSchedule,
  at: Date,
): Date | null {
  if (schedule.type === "once") {
    const fires = new Date(schedule.at);
    return fires.getTime() > at.getTime() ? fires : null;
  }
  if (schedule.weekdays.length === 0) return null;

  for (let forward = 0; forward <= 7; forward += 1) {
    const candidate = atTimeOnUtcDay(schedule.time, addDays(at, forward));
    if (
      candidate.getTime() > at.getTime() &&
      schedule.weekdays.includes(candidate.getUTCDay())
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * When this routine is next expected to act, for the person reading the list.
 *
 * A `once` whose moment has passed and which has not run is still expected: it says so rather than
 * saying nothing, because a routine that was set for nine this morning and did not run is exactly
 * the thing somebody wants the page to admit to. Once it has run, a `once` is finished and this is
 * null, which the surface renders as such rather than as a date it will never reach.
 */
export function nextDueAt(
  schedule: RoutineSchedule,
  options: { now: Date; lastRunAt: Date | null },
): Date | null {
  if (schedule.type === "once") {
    if (options.lastRunAt) return null;
    return new Date(schedule.at);
  }
  return nextOccurrenceAfter(schedule, options.now);
}

export type ScheduleDecision =
  /** The window is open and nobody has taken it. `dueAt` is the window, not the moment asked about. */
  | { action: "run"; dueAt: Date }
  /** The window came and went unrun. Recorded rather than run late; see DEFAULT_GRACE_MS. */
  | { action: "missed"; dueAt: Date }
  /** Nothing to do. `nextDueAt` is null for a schedule that will never call again. */
  | { action: "wait"; nextDueAt: Date | null };

/**
 * The one decision the scheduler makes, made here where it can be tested.
 *
 * Three answers rather than a boolean, because "not due" is two different situations and collapsing
 * them is the bug this table exists to prevent. A window nobody was awake for must be recorded, or
 * the person is left reading a list that says nothing happened at eight and cannot tell whether that
 * means the Bot found nothing or the machine was asleep.
 *
 * `lastRunAt` is the start of the most recent run of any kind, including a manual one. That is
 * deliberate: somebody who pressed Run now at 07:58 does not want it again at 08:00, and treating a
 * manual run as unrelated would give them two.
 *
 * `createdAt` is what stops a brand new routine being told off for a morning it did not exist for.
 * Somebody who writes "every weekday at eight" at three in the afternoon has a schedule whose most
 * recent window is seven hours old and has never been run, which without this reads as a window the
 * deployment slept through: within a minute they are looking at a history that says "Missed, nothing
 * was running", and at an audit row agreeing with it, about a machine that was running perfectly
 * well. It is the most ordinary path there is, and the answer given on it has to be true or the
 * distinction the whole feature is built on — "it ran and found nothing" against "it never ran" — is
 * worth nothing. A window inside the grace period still runs, because somebody writing that schedule
 * at three minutes past eight has just said what they want and would be puzzled to wait a day.
 *
 * What that costs is a `once` written for a moment that had already gone: it never fires and is
 * never recorded, and the list goes on showing it as expected. That is the same answer given to a
 * time somebody typed wrongly and to one they typed a day late, and it is preferred to the
 * alternative, which is a run history asserting that this deployment was asleep when it was not.
 */
export function decideScheduleAction(
  schedule: RoutineSchedule,
  options: {
    now: Date;
    lastRunAt: Date | null;
    /** When the routine came into existence. Optional so a caller reasoning about a schedule alone
     * need not invent one; the scheduler always has it. */
    createdAt?: Date;
    graceMs?: number;
  },
): ScheduleDecision {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const window = lastOccurrenceOnOrBefore(schedule, options.now);

  if (!window) {
    return { action: "wait", nextDueAt: nextDueAt(schedule, options) };
  }

  // Already taken. A run that started at or after the window is that window's run, however long it
  // then took, so a routine mid-flight does not get a second one on the next tick.
  if (options.lastRunAt && options.lastRunAt.getTime() >= window.getTime()) {
    return { action: "wait", nextDueAt: nextDueAt(schedule, options) };
  }

  if (options.now.getTime() - window.getTime() > graceMs) {
    // A window older than the routine is not a window anybody missed. Nothing is recorded and
    // nothing is run: there was no routine at eight o'clock, so nothing happened at eight o'clock.
    if (options.createdAt && window.getTime() < options.createdAt.getTime()) {
      return { action: "wait", nextDueAt: nextDueAt(schedule, options) };
    }
    return { action: "missed", dueAt: window };
  }
  return { action: "run", dueAt: window };
}

/** The same wall-clock time on the UTC day `day` falls in. */
function atTimeOnUtcDay(time: string, day: Date): Date {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return new Date(
    Date.UTC(
      day.getUTCFullYear(),
      day.getUTCMonth(),
      day.getUTCDate(),
      hours,
      minutes,
      0,
      0,
    ),
  );
}

/**
 * Move by whole days.
 *
 * On the millisecond value rather than on the calendar fields, so it cannot be tripped by a month
 * with 28 days in it. Every calculation here is in UTC, where a day is always 86,400,000ms, so the
 * daylight-saving hazard that makes this wrong in local time does not apply.
 */
function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/** How a schedule reads on screen, in one place so the list and the run history agree. */
export function describeSchedule(schedule: RoutineSchedule): string {
  if (schedule.type === "once") {
    return `Once, at ${new Date(schedule.at).toISOString().replace("T", " ").slice(0, 16)} UTC`;
  }
  if (schedule.weekdays.length === 0) return "Never, no days are selected";
  if (schedule.weekdays.length === 7) {
    return `Every day at ${schedule.time} UTC`;
  }
  const names = schedule.weekdays.map((day) => DAY_NAMES[day] ?? String(day));
  return `${names.join(", ")} at ${schedule.time} UTC`;
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
