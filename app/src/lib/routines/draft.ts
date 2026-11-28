import type { RoutineDraft } from "../api/generated/model";
import {
  NEW_CONVERSATION,
  ROUTINE_FORM_DEFAULTS,
  type RoutineFormValues,
  scheduleFrom,
} from "./form";

/**
 * What a sentence said, as New routine's answers. The picker only holds the shapes `scheduleFrom`
 * reads, so any other schedule leaves the picker at its defaults, and a start the sentence did not
 * give is a schedule, which is what the form opens on.
 */
export function draftValues(
  draft: RoutineDraft,
  botId: string,
): RoutineFormValues {
  const schedule = draft.cron ? scheduleFrom(draft.cron) : null;
  return {
    ...ROUTINE_FORM_DEFAULTS,
    ...(schedule ?? {}),
    agentId: botId,
    channelId: draft.conversationId ?? NEW_CONVERSATION,
    instruction: draft.instruction,
    title: draft.title,
    does: draft.does,
    starts: draft.starts === "unsaid" ? "schedule" : draft.starts,
    doneWhen: draft.doneWhen,
    interval:
      draft.intervalMinutes === null
        ? ROUTINE_FORM_DEFAULTS.interval
        : String(draft.intervalMinutes),
  };
}
