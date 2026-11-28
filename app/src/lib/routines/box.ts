import type { RoutineDraft, RoutineReading } from "@/lib/api/generated/model";
import { loadFailureText } from "@/lib/load-failure";
import type { ProactiveSetting } from "@/lib/proactive";
import { draftValues } from "./draft";
import type { RoutineFormValues } from "./form";
import { type MadeRoutine, SavedButRefused } from "./mutations";
import { checkInSubject } from "./plan";
import { brokenRules, SAME_CHECK_IN } from "./rules";

/**
 * What the line under the Routines box says, and what it offers beside the words. No line has a
 * close button: the next sentence sent, or leaving the page, clears it. `made` offers Open and Undo,
 * `finish` offers Finish, a refusal that needs an app offers Connect, and `unread`, `removed` and
 * `maybeMade` offer nothing.
 */
export type BoxLine =
  | { kind: "made"; botId: string; text: string; open: MadeRoutine }
  | { kind: "finish"; botId: string; text: string; draft: RoutineDraft }
  | { kind: "refused"; botId: string; text: string; fix: "connectApp" | null }
  | { kind: "maybeMade"; botId: string; text: string }
  | { kind: "unread"; botId: string; text: string }
  | { kind: "removed"; botId: string; text: "Removed." };

/** A reading that broke no rule: the box writes it, with the schedule and zone the sentence gave. */
export type BoxWrite = {
  kind: "write";
  values: RoutineFormValues;
  cron: string | null;
  timezone: string;
};

const NOT_A_ROUTINE = "Couldn't read that as a routine.";

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
    return { kind: "unread", botId, text: NOT_A_ROUTINE };

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
        return { kind: "unread", botId, text: NOT_A_ROUTINE };
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
  if (message) return { kind: "finish", botId, text: message, draft };
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
    text: `${botName} took “${draft.title}”${made.when ? ` · ${made.when}` : ""}`,
    open: made,
  };
}

/** What the line says once Undo has taken back what was made. */
export function lineForUndo(botId: string): BoxLine {
  return { kind: "removed", botId, text: "Removed." };
}

/**
 * What the line says when OpenBot could not pick a Bot for the sentence, for instance because two
 * Bots share the name the sentence used. Nothing was read or written, and there is nothing to fix
 * from the line.
 */
export function lineForRoutingRefusal(message: string, botId: string): BoxLine {
  return { kind: "refused", botId, text: message, fix: null };
}

/**
 * What the line says when the read failed: the error's own sentence, or a held 503's, with no
 * action. Plain words from `loadFailureText`, as for a failed write.
 */
export function lineForReadError(error: unknown, botId: string): BoxLine {
  return {
    kind: "unread",
    botId,
    text: loadFailureText(
      error,
      (error instanceof Error && error.message) ||
        "Couldn't read that. Try again.",
    ),
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
