import { z } from "zod";

/**
 * How often a routine made on the Routines page runs.
 *
 * The common schedules other assistants offer in their own Scheduled screens: every day, every
 * weekday, one day a week, one day a month, every hour. Anything stranger ("every other Tuesday")
 * is a conversation with the Bot, which writes any five-field schedule through the same store.
 */
export const REPEATS = [
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "hourly",
] as const;

export type Repeat = (typeof REPEATS)[number];

/** What each choice reads as in the picker. */
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

/**
 * The days of the month offered. Up to the 28th, so the routine runs in every month: a cron pinned
 * to the 31st skips the seven months that have no 31st, and says nothing about it.
 */
export const MONTH_DAYS = Array.from({ length: 28 }, (_, index) =>
  String(index + 1),
);

/** "A new conversation", in the Posts in picker. Not a channel id, so it cannot collide with one. */
export const NEW_CONVERSATION = "new";

export const routineFormSchema = z.object({
  agentId: z.string().min(1, "Choose a Bot."),
  instruction: z.string().trim().min(1, "Say what the Bot should do."),
  title: z.string().trim().max(100, "Keep the name under 100 characters."),
  repeat: z.enum(REPEATS),
  /** `HH:MM`, 24-hour, as `<input type="time">` writes it. */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Choose a time."),
  weekday: z.string().regex(/^[0-6]$/),
  monthDay: z.string().regex(/^([1-9]|1\d|2[0-8])$/),
  /** A channel id, or {@link NEW_CONVERSATION}. */
  channelId: z.string().min(1, "Choose where it posts."),
});

export type RoutineFormValues = z.infer<typeof routineFormSchema>;

type Schedule = Pick<
  RoutineFormValues,
  "repeat" | "time" | "weekday" | "monthDay"
>;

function hourAndMinute(time: string): [number, number] {
  const [hour, minute] = time.split(":").map((part) => Number(part));
  return [hour ?? 9, minute ?? 0];
}

/**
 * The five cron fields for a schedule picked on the page.
 *
 * Built from the picker's own choices and never parsed back: the list reads the schedule in words
 * from the server, which describes every routine the same way whoever made it.
 */
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

/** "9:00 AM", on the person's own clock. */
export function clockTime(time: string): string {
  const [hour, minute] = hourAndMinute(time);
  const period = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, "0")} ${period}`;
}

function ordinal(day: number): string {
  const teen = day % 100 >= 11 && day % 100 <= 13;
  const suffix = teen
    ? "th"
    : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ??
      "th");
  return `${day}${suffix}`;
}

/**
 * The picked schedule as a sentence, shown under the picker so the person reads back what they
 * chose: "Every weekday at 9:00 AM".
 */
export function scheduleSentence(schedule: Schedule): string {
  const at = clockTime(schedule.time);
  switch (schedule.repeat) {
    case "hourly":
      return "Every hour, on the hour";
    case "weekdays":
      return `Every weekday at ${at}`;
    case "weekly":
      return `Every ${WEEKDAY_LABEL[Number(schedule.weekday)] ?? "Monday"} at ${at}`;
    case "monthly":
      return `On the ${ordinal(Number(schedule.monthDay))} of every month at ${at}`;
    default:
      return `Every day at ${at}`;
  }
}

/** The person's own time zone, as their browser says it. UTC when it says nothing. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
