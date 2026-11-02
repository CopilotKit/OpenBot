/**
 * Whether an approval may be answered with a standing rule ("Always allow here").
 *
 * Not one a task started from a check-in raised: those ask before every change whatever the
 * person's rules say (`TASK_ASKS` in server/src/approvals/service.ts), so a rule saved from one
 * would be ignored the next time and only mislead. Allow once and Deny stay.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, so the two cannot drift apart. The server refuses such a
 * rule (server/src/approvals/store.ts) and leaves the button off a chat card
 * (server/src/delivery/opentag-agent.ts); the browser draws its approval cards from the same answer
 * (app/src/components/approvals).
 */
export function offersStandingRule(action: {
  policy?: { source: string } | undefined;
}): boolean {
  return action.policy?.source !== "task";
}
