import { CronExpressionParser } from "cron-parser";

/** Routines may run at most this often. A model can be talked into anything; the floor cannot. */
export const MINIMUM_INTERVAL_MS = 15 * 60 * 1000;

export class ScheduleRefusedError extends Error {}

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
 * The only reliable way to validate an IANA zone name in plain JS/TS: ask Intl to
 * build a formatter for it and see whether it throws. cron-parser (via luxon)
 * accepts an invalid zone silently at parse() time and only blows up later, with
 * a message ("unhandled timestamp: Invalid Date") that says nothing about
 * timezones — so we check this ourselves, up front, to give a sentence that means
 * something.
 */
function isKnownTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse, validate against the floor, and return the next occurrence after `after`.
 *
 * One function owns both acceptance and scheduling, so what was accepted is always schedulable:
 * the floor is checked on the gap between the next two occurrences, not on a guess about the
 * expression's shape.
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
    const minute = parsePlainInt(minuteField, 0, 59);
    const hour = parsePlainInt(hourField, 0, 23);
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
