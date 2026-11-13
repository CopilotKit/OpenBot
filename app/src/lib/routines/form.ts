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

/** What a routine does: act on its own, or tell the person something. */
export const DOES = ["act", "tell"] as const;

/** When it starts: on a schedule, when an event happens, or right now. */
export const STARTS = ["schedule", "event", "now"] as const;

/**
 * What an Only tell you watches: the apps the person connected that the Bot can read, or one public
 * web page.
 */
export const WATCHES = ["apps", "page"] as const;

/** Where an event that starts a routine comes from. */
export const EVENT_SOURCES = ["github", "slack", "connector"] as const;

/** Not `EventSource`, which would shadow the DOM global. */
export type RoutineEventSource = (typeof EVENT_SOURCES)[number];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A web address, as far as the form can tell: the server checks it is a public one. */
const PAGE_ADDRESS = /^https?:\/\/[^\s/]+\.[^\s]+$/i;

/** A field whose rule reads other answers, so its message changes when they do. */
export type CrossFieldName =
  | "instruction"
  | "time"
  | "eventType"
  | "doneWhen"
  | "pageAddress";

export interface CrossFieldIssue {
  path: CrossFieldName;
  message: string;
}

/**
 * The rules that read more than their own field, run by the schema's superRefine: the page shows
 * what the schema says about the answers now, so these follow every answer they read. What each
 * depends on:
 * - instruction: does (1000 for Only tell you), starts and doneWhen (2000 for a routine, 6000 for a goal)
 * - time: does, starts and repeat (asked only on a schedule that is not hourly)
 * - eventType: does and starts (asked only when an event starts it)
 * - doneWhen: does (not drawn, so not measured, for Only tell you)
 * - pageAddress: does and watches (asked only for Only tell you on a web page)
 */
export function crossFieldIssues(
  value: Pick<
    RoutineFormValues,
    | "does"
    | "starts"
    | "repeat"
    | "instruction"
    | "time"
    | "eventType"
    | "doneWhen"
    | "watches"
    | "pageAddress"
  >,
): CrossFieldIssue[] {
  const issues: CrossFieldIssue[] = [];
  const refuse = (path: CrossFieldName, message: string) =>
    issues.push({ path, message });
  if (value.does === "tell") {
    // The server caps a check-in's focus at 1000 (server/src/proactive/types.ts:75).
    if (value.instruction.trim().length > 1000)
      refuse(
        "instruction",
        "Keep it under 1000 characters when it only tells you.",
      );
    if (
      value.watches === "page" &&
      !PAGE_ADDRESS.test(value.pageAddress.trim())
    )
      refuse(
        "pageAddress",
        "Enter the page's address, starting with https://.",
      );
    return issues; // Starts, its branches and Done when are not drawn.
  }
  // A schedule with no Done when is a routine, which the server measures in code points
  // (server/src/routines/store.ts). Every other answer is a goal, whose instruction the server
  // caps at 6000 UTF-16 units (server/src/responsibilities/types.ts). Same split as planRoutine.
  const instruction = value.instruction.trim();
  const isRoutine =
    value.starts === "schedule" && value.doneWhen.trim().length === 0;
  if (isRoutine) {
    if (Array.from(instruction).length > 2000)
      refuse("instruction", "Keep it to 2000 characters or fewer.");
  } else if (instruction.length > 6000)
    refuse("instruction", "Keep it to 6000 characters or fewer.");
  if (
    value.starts === "schedule" &&
    value.repeat !== "hourly" &&
    !TIME.test(value.time)
  )
    refuse("time", "Choose a time.");
  if (value.starts === "event") {
    const eventType = value.eventType.trim();
    if (!eventType) refuse("eventType", "Say which event starts it.");
    else if (eventType.length > 128)
      refuse("eventType", "Keep the event under 128 characters.");
  }
  if (value.doneWhen.trim().length > 3000)
    refuse("doneWhen", "Keep it under 3000 characters.");
  return issues;
}

export const routineFormSchema = z
  .object({
    agentId: z.string().min(1, "Choose a Bot."),
    instruction: z.string().trim().min(1, "Say what the Bot should do."),
    title: z.string().trim().max(100, "Keep the name under 100 characters."),
    repeat: z.enum(REPEATS),
    /** `HH:MM`, 24-hour, as `<input type="time">` writes it. */
    time: z.string(),
    weekday: z.string().regex(/^[0-6]$/),
    monthDay: z.string().regex(/^([1-9]|1\d|2[0-8])$/),
    /** A channel id, or {@link NEW_CONVERSATION}. */
    channelId: z.string().min(1, "Choose where it posts."),
    does: z.enum(DOES),
    starts: z.enum(STARTS),
    /** What "done" looks like, in the person's words. */
    doneWhen: z.string(),
    eventSource: z.enum(EVENT_SOURCES),
    eventType: z.string(),
    /** Minutes between check-ins, as one of the `CHECK_IN_INTERVALS`. */
    interval: z.string(),
    /** What an Only tell you watches. */
    watches: z.enum(WATCHES),
    /** The page it reads, when it watches a web page. */
    pageAddress: z.string(),
  })
  .superRefine((value, ctx) => {
    for (const { path, message } of crossFieldIssues(value))
      ctx.addIssue({ code: "custom", path: [path], message });
  });

export type RoutineFormValues = z.infer<typeof routineFormSchema>;

export const ROUTINE_FORM_DEFAULTS: Omit<
  RoutineFormValues,
  "agentId" | "channelId"
> = {
  instruction: "",
  title: "",
  repeat: "weekdays",
  time: "09:00",
  weekday: "1",
  monthDay: "1",
  does: "act",
  starts: "schedule",
  doneWhen: "",
  eventSource: "github",
  eventType: "",
  interval: "1440",
  watches: "apps",
  pageAddress: "",
};

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
