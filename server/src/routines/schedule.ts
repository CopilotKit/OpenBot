import { CronExpressionParser } from "cron-parser";

/** Routines may run at most this often. A model can be talked into anything; the floor cannot. */
export const MINIMUM_INTERVAL_MS = 15 * 60 * 1000;

export class ScheduleRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleRefusedError";
  }
}

const UNREADABLE_MESSAGE = "That schedule could not be read.";
const UNKNOWN_TIMEZONE_MESSAGE = "That is not a timezone I know.";
const TOO_FREQUENT_MESSAGE = "Routines may run at most every 15 minutes.";

/**
 * cron-parser is lenient about field count on purpose (it also accepts a leading
 * seconds field or a trailing year field), so it will happily "parse" a four-field
 * or six-field string by filling in defaults. We want a hard five-field contract,
 * so that check happens here, before the string ever reaches the parser.
 */
function hasFiveFields(cron: string): boolean {
  return cron.trim().split(/\s+/).length === 5;
}

/**
 * Both memo caches below are keyed by caller-supplied strings, so an unbounded map is a slow leak a
 * hostile caller can drive on purpose: one invalid timezone per request grows it forever. Cleared
 * wholesale at the cap rather than evicted piecemeal — the population that matters (the handful of
 * zones and expressions real routines use) is re-learned in one pass and the code stays one line.
 */
const MAX_MEMOIZED_VERDICTS = 1000;

const timeZoneVerdicts = new Map<string, boolean>();

/**
 * The only reliable way to validate an IANA zone name in plain JS/TS: ask Intl to
 * build a formatter for it and see whether it throws. cron-parser (via luxon)
 * accepts an invalid zone silently at parse() time and only blows up later, with
 * a message ("unhandled timestamp: Invalid Date") that says nothing about
 * timezones — so we check this ourselves, up front, to give a sentence that means
 * something.
 *
 * Memoized because this sits on the sweep's hot path: `advanceNextRun` calls in here for every due
 * routine on every pass, and building an Intl.DateTimeFormat per call is the expensive way to keep
 * re-learning that "UTC" is a timezone.
 */
function isKnownTimeZone(timezone: string): boolean {
  const cached = timeZoneVerdicts.get(timezone);
  if (cached !== undefined) return cached;
  let known: boolean;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    known = true;
  } catch {
    known = false;
  }
  if (timeZoneVerdicts.size >= MAX_MEMOIZED_VERDICTS) timeZoneVerdicts.clear();
  timeZoneVerdicts.set(timezone, known);
  return known;
}

/**
 * Where the floor scan starts, fixed so acceptance is a property of the expression rather than of
 * the clock at the moment somebody asked. The failure this prevents: `45,55 8 * * *` asked about at
 * 08:50 sees 08:55 and then tomorrow's 08:45 as its next two occurrences — a 23h50m gap — so a check
 * that samples from "now" accepts at some times of day what it refuses at others, and the accepted
 * routine then wedges the moment the sweep tries to advance it past the ten-minute pair. A leap-year
 * start, so expressions pinned to 29 February are scanned on days they actually fire.
 */
const FLOOR_SCAN_START = new Date("2024-01-01T00:00:00Z");

/**
 * How many successive occurrences the floor scan walks.
 *
 * The intra-day pattern of a five-field cron is the same on every day it fires (minutes × hours),
 * so the first firing day already shows every within-day gap, and the densest day the floor allows
 * is 96 firings — 200 covers a full day of those plus the wrap into the next firing day, and for
 * sparse expressions the iterator simply walks forward until it has seen 200 real firings, however
 * far apart they are. Not exhaustive: a sub-floor gap that only exists under a DST compression more
 * than 200 occurrences from the scan start can still slip through, which is why the per-call pair
 * check below stays as the runtime backstop.
 */
const FLOOR_SCAN_OCCURRENCES = 200;

/** null means the expression cleared the floor; a string is the refusal to throw. */
const floorVerdicts = new Map<string, string | null>();

/**
 * Refuse any expression whose own cycle contains an adjacent pair under the floor, deterministically.
 *
 * Scanned from a fixed start rather than from `after`, because the caller's `after` moves with the
 * clock and a floor sampled near it is a floor that depends on when the question was asked. Parse
 * and iteration errors are swallowed here on purpose: an unreadable expression is the caller's
 * refusal to make (with the unreadable-schedule sentence), and an expression that runs out of
 * occurrences mid-scan has shown every gap it has. Memoized because this runs inside
 * `nextOccurrence`, which the sweep calls for every due routine on every pass.
 */
function refuseSubFloorCycle(cron: string, timezone: string): void {
  const key = `${timezone}\u0000${cron}`;
  const cached = floorVerdicts.get(key);
  if (cached !== undefined) {
    if (cached !== null) throw new ScheduleRefusedError(cached);
    return;
  }

  let verdict: string | null = null;
  try {
    const expression = CronExpressionParser.parse(cron, {
      tz: timezone,
      currentDate: FLOOR_SCAN_START,
    });
    let previous = expression.next().toDate().getTime();
    for (let index = 1; index < FLOOR_SCAN_OCCURRENCES; index += 1) {
      const current = expression.next().toDate().getTime();
      if (current - previous < MINIMUM_INTERVAL_MS) {
        verdict = TOO_FREQUENT_MESSAGE;
        break;
      }
      previous = current;
    }
  } catch {
    // Unreadable, or fewer occurrences than the scan wanted. Either way the gaps seen were fine,
    // and unreadability is refused by the parse in `nextOccurrence` with the sentence for it.
  }

  if (floorVerdicts.size >= MAX_MEMOIZED_VERDICTS) floorVerdicts.clear();
  floorVerdicts.set(key, verdict);
  if (verdict !== null) throw new ScheduleRefusedError(verdict);
}

/**
 * Parse, validate against the floor, and return the next occurrence after `after`.
 *
 * One function owns both acceptance and scheduling, so what was accepted is always schedulable. The
 * floor is enforced twice, on purpose: `refuseSubFloorCycle` scans the expression's own cycle from a
 * fixed start, so acceptance cannot depend on the time of the asking, and the pair check at the
 * bottom re-measures the gap actually ahead of `after`, catching the rare shapes the bounded scan
 * cannot see (a DST compression far from the scan window). A pair-check throw at sweep time is what
 * the sweep's unschedulable-routine switch-off exists for.
 */
export function nextOccurrence(
  cron: string,
  timezone: string,
  after: Date,
): Date {
  if (!hasFiveFields(cron)) {
    throw new ScheduleRefusedError(UNREADABLE_MESSAGE);
  }
  if (!isKnownTimeZone(timezone)) {
    throw new ScheduleRefusedError(UNKNOWN_TIMEZONE_MESSAGE);
  }
  refuseSubFloorCycle(cron, timezone);

  let first: Date;
  let second: Date;
  try {
    const expression = CronExpressionParser.parse(cron, {
      tz: timezone,
      currentDate: after,
    });
    // next() is strictly after currentDate, including when currentDate itself
    // lands exactly on an occurrence.
    first = expression.next().toDate();
    second = expression.next().toDate();
  } catch {
    throw new ScheduleRefusedError(UNREADABLE_MESSAGE);
  }

  if (second.getTime() - first.getTime() < MINIMUM_INTERVAL_MS) {
    throw new ScheduleRefusedError(TOO_FREQUENT_MESSAGE);
  }

  return first;
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function ordinal(day: number): string {
  const remainder100 = day % 100;
  if (remainder100 >= 11 && remainder100 <= 13) {
    return `${day}th`;
  }
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/** Joins names the way a person would say them: "A", "A and B", "A, B and C". */
function joinWords(words: string[]): string {
  if (words.length === 1) return words[0];
  const last = words[words.length - 1];
  const rest = words.slice(0, -1);
  return `${rest.join(", ")} and ${last}`;
}

function parsePlainInt(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const value = Number.parseInt(field, 10);
  if (value < min || value > max) return null;
  return value;
}

/**
 * "Weekdays at 09:00", "Every day at 18:30", or the raw expression when it is stranger than
 * words.
 *
 * This string gets read by a model mid-conversation and rendered on a page. A formatter that
 * throws on a weird expression would take a page down over a schedule nobody could read anyway,
 * so unrecognized shapes fall back to the raw expression rather than raising anything, and the
 * whole body is wrapped in a belt-and-suspenders try/catch to guarantee it.
 */
export function describeCron(cron: string): string {
  try {
    const fields = cron.trim().split(/\s+/);
    if (fields.length !== 5) return cron;

    const [
      minuteField,
      hourField,
      dayOfMonthField,
      monthField,
      dayOfWeekField,
    ] = fields;

    const wideOpen =
      dayOfMonthField === "*" && monthField === "*" && dayOfWeekField === "*";

    // "*/20 * * * *": a step under the floor's shape but at or above the floor itself, e.g. */15
    // and up. Only when hour/day/month/weekday are all "*" — a step on any other field is stranger
    // than this narrow rendering is meant to cover.
    if (wideOpen && hourField === "*") {
      const stepMatch = /^\*\/(\d{1,2})$/.exec(minuteField);
      if (stepMatch) {
        const step = Number.parseInt(stepMatch[1] as string, 10);
        // A minute step restarts every hour rather than counting continuously from the first
        // firing, so it only actually recurs every N minutes when N divides the hour evenly
        // (e.g. */20 fires at :00, :20, :40 — a steady 20-minute gap). A step like */40 fires at
        // :00 and :40 and then wraps, a 20-minute gap the second time round, so "Every 40 minutes"
        // would be false. `step > 1` also rules out */1, which is reachable here even though the
        // create-time floor refuses it, and would otherwise render the ungrammatical "Every 1
        // minutes". Anything that fails this falls back to the raw expression.
        if (Number.isInteger(step) && step > 1 && 60 % step === 0) {
          return `Every ${step} minutes`;
        }
      }
    }

    const minute = parsePlainInt(minuteField, 0, 59);
    const hour = parsePlainInt(hourField, 0, 23);

    // "0,30 9 * * *": a handful of plain minutes within one hour, every day. Only when the hour is
    // a single plain value and day/month/weekday are all "*" — anything with its own weekday or
    // day-of-month shape stays out of this narrow rendering.
    if (wideOpen && hour !== null && /^\d{1,2}(,\d{1,2})+$/.test(minuteField)) {
      const minutes = minuteField
        .split(",")
        .map((part) => parsePlainInt(part, 0, 59));
      if (minutes.every((value): value is number => value !== null)) {
        const times = [...minutes]
          .sort((a, b) => a - b)
          .map((value) => `${pad2(hour)}:${pad2(value)}`);
        return `Every day at ${joinWords(times)}`;
      }
    }

    if (minute === null || hour === null) return cron;

    const time = `${pad2(hour)}:${pad2(minute)}`;

    if (dayOfMonthField === "*" && monthField === "*") {
      if (dayOfWeekField === "*") {
        return `Every day at ${time}`;
      }
      if (dayOfWeekField === "1-5") {
        return `Weekdays at ${time}`;
      }
      if (/^[0-6]$/.test(dayOfWeekField)) {
        const dayIndex = Number.parseInt(dayOfWeekField, 10);
        return `${WEEKDAY_NAMES[dayIndex]}s at ${time}`;
      }
      if (/^[0-6](,[0-6])+$/.test(dayOfWeekField)) {
        const names = dayOfWeekField
          .split(",")
          .map((digit) => `${WEEKDAY_NAMES[Number.parseInt(digit, 10)]}s`);
        return `${joinWords(names)} at ${time}`;
      }
    }

    if (monthField === "*" && dayOfWeekField === "*") {
      const day = parsePlainInt(dayOfMonthField, 1, 31);
      if (day !== null) {
        return `On the ${ordinal(day)} of the month at ${time}`;
      }
    }

    return cron;
  } catch {
    return cron;
  }
}
