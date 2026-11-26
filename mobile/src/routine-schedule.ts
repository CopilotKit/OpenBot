/**
 * A routine's schedule as the phone's form picks it, written to and read from the five cron fields
 * the API takes. The same choices, cron shapes and sentences as the web app's Routines page
 * (app/src/lib/routines/form.ts), so a routine made on one reads the same on the other. Anything
 * stranger ("every other Tuesday") is a conversation with the Bot, which writes any schedule.
 */

export const REPEATS = [
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "hourly",
] as const;

export type Repeat = (typeof REPEATS)[number];

export const REPEAT_LABEL: Record<Repeat, string> = {
  daily: "Every day",
  weekdays: "Every weekday",
  weekly: "Every week",
  monthly: "Every month",
  hourly: "Every hour",
};

/** Sunday first, as cron counts them: the index is the day-of-week field. */
export const WEEKDAY_LABEL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Up to the 28th, so the routine runs in every month. */
export const MONTH_DAYS = Array.from({ length: 28 }, (_, index) => index + 1);

export type Schedule = {
  repeat: Repeat;
  /** "HH:MM", on a 24-hour clock. */
  time: string;
  /** 0 (Sunday) to 6. */
  weekday: number;
  /** 1 to 28. */
  monthDay: number;
};

export const DEFAULT_SCHEDULE: Schedule = {
  repeat: "daily",
  time: "09:00",
  weekday: 1,
  monthDay: 1,
};

function hourAndMinute(time: string): [number, number] {
  const [hour, minute] = time.split(":").map((part) => Number(part));
  return [
    Number.isFinite(hour) ? (hour as number) : 9,
    Number.isFinite(minute) ? (minute as number) : 0,
  ];
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The five cron fields for a picked schedule. */
export function cronFrom(schedule: Schedule): string {
  const [hour, minute] = hourAndMinute(schedule.time);
  switch (schedule.repeat) {
    case "hourly":
      return "0 * * * *";
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${schedule.weekday}`;
    case "monthly":
      return `${minute} ${hour} ${schedule.monthDay} * *`;
    default:
      return `${minute} ${hour} * * *`;
  }
}

function plain(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

/**
 * The form's choices for a routine's cron, when the form can say them: the exact shapes `cronFrom`
 * writes. Null for any other schedule, which Edit keeps as it is unless the person picks a new one.
 */
export function scheduleFrom(cron: string): Schedule | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, dayField, monthField, weekdayField] =
    fields as [string, string, string, string, string];
  if (monthField !== "*") return null;
  if (
    minuteField === "0" &&
    hourField === "*" &&
    dayField === "*" &&
    weekdayField === "*"
  )
    return { ...DEFAULT_SCHEDULE, repeat: "hourly" };
  const minute = plain(minuteField, 0, 59);
  const hour = plain(hourField, 0, 23);
  if (minute === null || hour === null) return null;
  const time = `${pad(hour)}:${pad(minute)}`;
  if (dayField === "*" && weekdayField === "*")
    return { ...DEFAULT_SCHEDULE, repeat: "daily", time };
  if (dayField === "*" && weekdayField === "1-5")
    return { ...DEFAULT_SCHEDULE, repeat: "weekdays", time };
  const weekday = plain(weekdayField, 0, 6);
  if (dayField === "*" && weekday !== null)
    return { ...DEFAULT_SCHEDULE, repeat: "weekly", weekday, time };
  const monthDay = plain(dayField, 1, 28);
  if (weekdayField === "*" && monthDay !== null)
    return { ...DEFAULT_SCHEDULE, repeat: "monthly", monthDay, time };
  return null;
}

/** "9:00 AM". */
export function clockTime(time: string): string {
  const [hour, minute] = hourAndMinute(time);
  const period = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${pad(minute)} ${period}`;
}

function ordinal(day: number): string {
  const teen = day % 100 >= 11 && day % 100 <= 13;
  const suffix = teen
    ? "th"
    : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ??
      "th");
  return `${day}${suffix}`;
}

/** The picked schedule as a sentence, read back under the form: "Every weekday at 9:00 AM". */
export function scheduleSentence(schedule: Schedule): string {
  const at = clockTime(schedule.time);
  switch (schedule.repeat) {
    case "hourly":
      return "Every hour, on the hour";
    case "weekdays":
      return `Every weekday at ${at}`;
    case "weekly":
      return `Every ${WEEKDAY_LABEL[schedule.weekday] ?? "Monday"} at ${at}`;
    case "monthly":
      return `On the ${ordinal(schedule.monthDay)} of every month at ${at}`;
    default:
      return `Every day at ${at}`;
  }
}

/** "HH:MM" for a Date's own hours and minutes, and back. */
export function timeOf(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function dateAt(time: string): Date {
  const [hour, minute] = hourAndMinute(time);
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date;
}

/** The phone's own time zone. UTC when it says nothing. */
export function phoneTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
