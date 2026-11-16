import {
  DELEGATE_TOOL,
  FOLLOW_UP_TOOL,
  readDelegateResult,
  readTaskActionResult,
  readTaskReport,
  STOP_TOOL,
} from "@openbot/shared/orchestration";
import type { TranscriptItem } from "@/components/channels/tool-activity";
import { asText } from "@/lib/plugins/tool-result";

/** The task whose card a row draws, or null for a row that draws no task's card. */
function cardOf(item: TranscriptItem): string | null {
  if (item.kind !== "tool" || item.result === undefined) return null;
  const name = item.toolCall.function.name;
  const answer = asText(item.result);
  if (name === DELEGATE_TOOL) return readDelegateResult(answer)?.taskId ?? null;
  // `follow_up` and `stop` draw the card of the task they reached, as it stands now.
  if (name === FOLLOW_UP_TOOL || name === STOP_TOOL)
    return readTaskActionResult(answer)?.taskId ?? null;
  return null;
}

/**
 * The results drawn directly under their own task's card: nothing between them but what that task
 * itself said (its needs-you line, the line saying what the person told it, an earlier result).
 *
 * THE CARD IS THE TASK. A result leads with a chip naming its task and leading into its thread, so
 * a result that lands away from its card (after the person asked something else, or under another
 * task's card) still says which task it is about. Directly under its own card the chip said the
 * card's title and its Open thread a second time, and the task read as shown twice. Those results
 * are drawn without it.
 */
export function reportsUnderTheirCards(
  items: readonly TranscriptItem[],
): ReadonlySet<string> {
  const under = new Set<string>();
  items.forEach((item, index) => {
    if (item.kind !== "text") return;
    const report = readTaskReport(item.id);
    if (report?.kind !== "result") return;
    for (let at = index - 1; at >= 0; at -= 1) {
      const before = items[at] as TranscriptItem;
      const card = cardOf(before);
      if (card !== null) {
        if (card === report.taskId) under.add(item.id);
        return;
      }
      // What this same task said since its card sits in the card's column too.
      if (
        before.kind === "text" &&
        readTaskReport(before.id)?.taskId === report.taskId
      )
        continue;
      return;
    }
  });
  return under;
}
