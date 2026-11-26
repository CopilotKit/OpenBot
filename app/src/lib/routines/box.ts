import type { RoutineDraft, RoutineReading } from "@/lib/api/generated/model";
import { loadFailureText } from "@/lib/load-failure";
import type { ProactiveSetting } from "@/lib/proactive";
import { type RoutineFormValues, scheduleFrom, scheduleSentence } from "./form";
import { draftValues } from "./draft";
import { intervalLabel } from "./merged";
import { type MadeRoutine, SavedButRefused } from "./mutations";
import { checkInSubject } from "./plan";
import { brokenRules, SAME_CHECK_IN } from "./rules";

/** What the line under the Routines box says, and what it offers beside the words. */
export type BoxLine =
  | { kind: "made"; botId: string; text: string; open: MadeRoutine }
  | { kind: "finish"; botId: string; text: string; draft: RoutineDraft }
  | { kind: "refused"; botId: string; text: string; fix: "connectApp" | null }
  | { kind: "maybeMade"; botId: string; text: string }
  | {
      kind: "useForm";
      botId: string;
      text: string;
      draft: RoutineDraft | null;
    };

/** A reading that broke no rule: the box writes it, with the schedule and zone the sentence gave. */
export type BoxWrite = {
  kind: "write";
  values: RoutineFormValues;
  cron: string | null;
  timezone: string;
};

const NOT_A_ROUTINE = "Couldn't read that as a routine.";

/** When a drafted routine runs, in a few words: how often it checks, or its schedule. */
export function describeDraftWhen(draft: RoutineDraft): string {
  if (draft.does === "tell")
    return `Checks ${intervalLabel(draft.intervalMinutes ?? 1440).toLowerCase()}`;
  const schedule = draft.cron ? scheduleFrom(draft.cron) : null;
  if (schedule) return scheduleSentence(schedule);
  return draft.cron ?? "";
}

/** What the line says, or the write to make, for what the server read from the sentence. */
export function lineForReading(
  reading: RoutineReading,
  ctx: {
    botId: string;
    botName: string;
    allowed: boolean;
    checkIns: ProactiveSetting[] | undefined;
  },
): BoxLine | BoxWrite {
  const { botId, botName, allowed, checkIns } = ctx;

  if (reading.outcome === "notRoutine")
    return { kind: "useForm", botId, text: NOT_A_ROUTINE, draft: null };

  if (reading.outcome === "refused")
    return {
      kind: "refused",
      botId,
      text: reading.detail,
      fix: reading.fix === "connectApp" ? "connectApp" : null,
    };

  const { draft } = reading;

  if (reading.outcome === "needsMore") {
    const title = draft.title;
    switch (reading.missing) {
      case "time":
        return {
          kind: "finish",
          botId,
          text: `${botName} needs to know when for “${title}”`,
          draft,
        };
      case "event":
        return {
          kind: "finish",
          botId,
          text: `${botName} needs to know which event starts “${title}”`,
          draft,
        };
      case "once":
        return {
          kind: "finish",
          botId,
          text: `“${title}” is something to do once, now. Finish it on the form.`,
          draft,
        };
      default:
        return { kind: "useForm", botId, text: NOT_A_ROUTINE, draft };
    }
  }

  const values = draftValues(draft, botId);
  const messages = brokenRules(values, allowed, checkIns);
  if (messages.does)
    return {
      kind: "refused",
      botId,
      text: `Your admin turned check-ins off, so ${botName} can only act for you.`,
      fix: null,
    };
  if (messages.title === SAME_CHECK_IN)
    return {
      kind: "refused",
      botId,
      text: `${botName} already checks in on “${checkInSubject(values)}”.`,
      fix: null,
    };
  const [message] = Object.values(messages);
  if (message) return { kind: "useForm", botId, text: message, draft };
  return {
    kind: "write",
    values,
    cron: draft.cron,
    timezone: draft.timezone,
  };
}

/** What the line says once the routine, goal or check-in is made. */
export function lineForMade(
  made: MadeRoutine,
  draft: RoutineDraft,
  botId: string,
  botName: string,
): BoxLine {
  return {
    kind: "made",
    botId,
    text: `${botName} took “${draft.title}” · ${describeDraftWhen(draft)}`,
    open: made,
  };
}

/**
 * What the line says when the write failed. A write that may have landed must not be sent again.
 * Plain words from `loadFailureText`: `failureSaid` draws a ReactNode, and the line holds text.
 */
export function lineForWriteError(error: unknown, botId: string): BoxLine {
  if (error instanceof SavedButRefused)
    return {
      kind: "maybeMade",
      botId,
      text: "It may have been made. Check the list before sending it again.",
    };
  return {
    kind: "refused",
    botId,
    text: loadFailureText(
      error,
      (error instanceof Error && error.message) ||
        "Couldn't set up that routine. Try again.",
    ),
    fix: null,
  };
}
