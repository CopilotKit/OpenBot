import type { StalledHandoff } from "@/components/needs-you/stalled-handoffs";
import type { ApprovalInboxData } from "@/lib/approvals";
import type { ActivityItem } from "@/lib/bot-lifecycle/queries";
import {
  countsAsWaiting,
  heldByTaskOf,
  type ListedTask,
} from "@/lib/tasks/groups";

type WaitingQuestion = ApprovalInboxData["questions"][number];
type WaitingRequest = ApprovalInboxData["requests"][number];

/** One thing waiting on the person, whichever kind, with when it began to wait. */
export type NeedsYouEntry =
  | {
      kind: "question";
      id: string;
      botId: string;
      at: string;
      question: WaitingQuestion;
    }
  | {
      kind: "request";
      id: string;
      botId: string;
      at: string;
      request: WaitingRequest;
    }
  | { kind: "task"; id: string; botId: string; at: string; listed: ListedTask }
  | {
      kind: "handoff";
      id: string;
      botId: string;
      at: string;
      item: ActivityItem;
    };

/**
 * Oldest wait first. Leaves out a question or request a listed task holds (that is the task
 * waiting, listed once), and a task that does not count as waiting. Each kind waits from the time
 * the Needs you board uses for it.
 */
export function needsYouEntries(input: {
  questions: readonly WaitingQuestion[];
  requests: readonly WaitingRequest[];
  tasks: readonly ListedTask[];
  done: readonly ListedTask[];
  handoffs: readonly StalledHandoff[];
}): NeedsYouEntry[] {
  const held = heldByTaskOf([...input.tasks, ...input.done]);
  const entries: NeedsYouEntry[] = [];
  for (const question of input.questions) {
    if (held({ channelId: question.channelId, threadId: question.threadId }))
      continue;
    entries.push({
      kind: "question",
      id: question.id,
      botId: question.conversationBotId ?? question.botId,
      at: question.createdAt,
      question,
    });
  }
  for (const request of input.requests) {
    if (held({ threadId: request.action.threadId })) continue;
    entries.push({
      kind: "request",
      id: request.id,
      botId: request.action.botId,
      at: request.createdAt,
      request,
    });
  }
  for (const listed of input.tasks) {
    if (!countsAsWaiting(listed)) continue;
    entries.push({
      kind: "task",
      id: listed.task.id,
      botId: listed.task.agentId,
      at: listed.task.updatedAt,
      listed,
    });
  }
  for (const { botId, item } of input.handoffs)
    entries.push({ kind: "handoff", id: item.id, botId, at: item.at, item });
  return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** The two halves of the home page's line, each null when there is nothing to say. */
export function briefingParts(
  needsYou: number,
  working: number,
): { needsYou: string | null; working: string | null } {
  return {
    needsYou:
      needsYou > 0
        ? needsYou === 1
          ? "1 needs you."
          : `${needsYou} need you.`
        : null,
    working: working > 0 ? `${working} working.` : null,
  };
}

/** "3 need you. 2 working." / "3 need you." / "2 working." / null. Singular: "1 needs you." */
export function briefingLine(needsYou: number, working: number): string | null {
  const parts = briefingParts(needsYou, working);
  const line = [parts.needsYou, parts.working].filter(Boolean).join(" ");
  return line === "" ? null : line;
}
