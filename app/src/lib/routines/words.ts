import { relativeTime } from "@/lib/relative-time";
import type { RoutineRecord } from "./queries";

/**
 * How a routine's schedule and last run are said, wherever a routine is drawn: its page, its row,
 * and the line under the Routines box. Here, not in a component, so the routine writes can say when
 * something they made starts without importing a page that imports them.
 */

/** The browser's own time zone, for saying a schedule's only where it differs. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * When a routine starts, as its row says it: the schedule, with its time zone only where it isn't
 * the reader's own. "Weekdays at 09:00" in Madrid, read in Madrid, needs no zone; read in New York
 * it does. The details always name the zone.
 */
export function scheduleWords(
  routine: Pick<RoutineRecord, "schedule" | "timezone">,
  localZone: string = viewerTimeZone(),
): string {
  return routine.timezone === localZone
    ? routine.schedule
    : `${routine.schedule} · ${routine.timezone}`;
}

/**
 * What the last-run cell says, and in what tone.
 *
 * `lastRun === null` and `lastRun.status === null` are different facts, and saying the wrong one
 * invents news: the first is "this routine has never finished a run," the second is "one is open
 * right now" — which is also what a run stuck open after repeated dispatch failures looks like from
 * here. Neither is a failure, so neither gets the destructive tone; only `status: "failed"` does.
 */
export function lastRunLabel(lastRun: RoutineRecord["lastRun"]): {
  text: string;
  className: string;
} {
  if (lastRun === null)
    return { text: "Hasn't run yet", className: "text-muted-foreground" };
  if (lastRun.status === null)
    return { text: "Running…", className: "text-muted-foreground" };
  const when = lastRun.at ? relativeTime(lastRun.at) : "recently";
  if (lastRun.status === "failed")
    return { text: `Failed ${when}`, className: "text-destructive" };
  if (lastRun.status === "skipped")
    return {
      text: `Skipped ${when}`,
      className: "text-warning",
    };
  if (lastRun.status === "succeeded")
    return { text: `Ran ${when}`, className: "text-muted-foreground" };
  // An outcome this DTO doesn't recognise degrades to a neutral label rather than an invented
  // success: the contract typing makes a fourth outcome a build-time error, and this is the runtime
  // fallback if that ever slips through.
  return { text: `Finished ${when}`, className: "text-muted-foreground" };
}
