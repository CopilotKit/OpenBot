/**
 * Whether an approval may be answered with a standing answer: "Always allow here", or "Allow for
 * this conversation".
 *
 * OPEN BY DEFAULT. Deleting, sending, sharing, posting, paying and changing account settings ask
 * (server/src/approvals/policy.ts), and the person can allow each of them once, for the conversation,
 * or always, as they can anything else that asks. An admin closes a kind of action for everybody
 * (Admin → Approvals); then it asks every time and only Allow once and Deny stay (`closed`).
 *
 * Not one a task started from a check-in raised: those ask before every change whatever the
 * person's rules say (`TASK_ASKS` in server/src/approvals/service.ts), so a standing answer saved from
 * one would be ignored the next time and only mislead.
 *
 * Not a hand-off: the person does that themselves, so there is nothing for the Bot to be allowed.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, so the two cannot drift apart. The server refuses such an
 * answer (server/src/approvals/store.ts) and leaves the button off a chat card
 * (server/src/delivery/opentag-agent.ts); the browser draws its approval cards from the same answer
 * (app/src/components/approvals).
 */
export function offersStandingRule(action: {
  policy?: { source: string; behaviour?: string; closed?: boolean } | undefined;
}): boolean {
  const policy = action.policy;
  return (
    policy?.source !== "task" &&
    policy?.closed !== true &&
    policy?.behaviour !== "hand_off"
  );
}
