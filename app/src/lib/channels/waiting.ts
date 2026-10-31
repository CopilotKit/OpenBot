import type { ApprovalInboxData } from "@/lib/approvals";

/**
 * The threads that wait on the person: each one with a pending approval or an open question.
 *
 * A request can still be listed once decided, under another status, so only "pending" counts. The
 * inbox lists open questions only, so every one counts. Read from the same inbox query the
 * approvals screens poll, so a conversation stops waiting on the next refresh after it is answered.
 */
export function waitingThreadIds(
  inbox: ApprovalInboxData | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const request of inbox?.requests ?? []) {
    if (request.status === "pending") ids.add(request.action.threadId);
  }
  for (const question of inbox?.questions ?? []) {
    ids.add(question.threadId);
  }
  return ids;
}
