import type { ApprovalInboxData } from "@/lib/approvals";

/**
 * How many things wait on the person, for the Tasks tab's badge and the Needs input heading: the
 * pending approvals and the questions OpenBot's `WaitingForYou` lists, counted the way it filters
 * them, so the badge and the rows never disagree. `tests/skins-openduet-model.test.ts` renders
 * `WaitingForYou` and holds the two to the same number.
 */
export function waitingCount(inbox: ApprovalInboxData | undefined): number {
  if (!inbox) return 0;
  const pending = inbox.requests.filter(
    (request) => request.status === "pending",
  ).length;
  return pending + inbox.questions.length;
}
