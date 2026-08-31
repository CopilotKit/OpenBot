/**
 * Whether a row in the trail is something this deployment turned away, something that was allowed
 * and then did not happen, or something that went through.
 *
 * THE TWO PLACES THAT DECIDE THIS HAVE TO BE ONE PLACE. The audit page asks the question twice: once
 * to colour and label a row, and once to build the `eventType` list behind the `Blocked` and
 * `Did not happen` saved views. They were two hand-written lists, and they had already drifted — a
 * refusal missing from the first is drawn as "Allowed", a refusal missing from the second is
 * missing from the view somebody clicks to ask what this deployment refused, and neither omission
 * says anything. So the lists live here, the page derives both from them, and a new refusal is added
 * in one place or in none.
 *
 * WHY "ALLOWED" IS THE ONE WRONG ANSWER. The page falls back to it for anything it does not
 * recognise, which is the right default for the many rows that are neither a refusal nor a failure —
 * a credential saved, a component published, a person's role changed. For a refusal it is not a
 * missing label, it is the opposite of what happened, on the screen an administrator opens to find
 * out what happened. A trail that is confidently wrong is worse than a silent one.
 */

/**
 * Refused: this deployment declined, and nothing was attempted.
 *
 * `mcp.callback_refused`, `routines.dispatch_refused` and `session.refused` are here even though no
 * policy judged anybody and, in the last two, no Bot was involved at all. Somebody filtering for
 * "what did this deployment turn away" wants them, and for each of the three this row is the only
 * evidence anywhere that anything was attempted: the wire answers all of them with the same opaque
 * refusal on purpose.
 */
export const REFUSED_EVENT_TYPES = [
  "computer.action_refused",
  "component.refused",
  "component.function_refused",
  "mcp.call_rejected",
  "mcp.callback_refused",
  "routines.dispatch_refused",
  /*
   * A hop one Bot was not allowed to make. `server/src/audit.ts` calls this "the more important of
   * the pair": a hop that happened is visible in the transcript anyway, and a hop that was refused
   * is invisible everywhere else.
   */
  "agent.handoff_refused",
  /** An endpoint a stored agent tried to reach and the deployment would not dial. */
  "agent.dial_refused",
  /** A rotation aimed at a key the credential does not belong to, or at a revoked one. */
  "credential.rotation_refused",
  /** A revoked person still holding a bookmark, or an address outside the deployment. */
  "session.refused",
] as const;

/**
 * Did not happen: nothing was refused, and nothing came of it either.
 *
 * Its own family because the difference is what somebody came to the row to find out. A boundary
 * holding and a Bot that was asked and never answered are different faults with different fixes, and
 * only one of them is the deployment working as configured.
 */
export const DID_NOT_HAPPEN_EVENT_TYPES = [
  "computer.action_failed",
  "agent.stream_stalled",
  /** A hop that was accepted, ran out of attempts, and never became the other Bot's turn. */
  "agent.handoff_failed",
  /** A question that reached nobody: the Bot stopped, and the person was never asked. */
  "agent.escalation_failed",
] as const;

export type AuditOutcome = "refused" | "did-not-happen" | "allowed";

const REFUSED = new Set<string>(REFUSED_EVENT_TYPES);
const DID_NOT_HAPPEN = new Set<string>(DID_NOT_HAPPEN_EVENT_TYPES);

/** What kind of thing this row is, for the label and the colour it is drawn in. */
export function outcomeOf(eventType: string): AuditOutcome {
  if (REFUSED.has(eventType)) return "refused";
  if (DID_NOT_HAPPEN.has(eventType)) return "did-not-happen";
  return "allowed";
}

/** The `eventType` query one of the saved views filters by. */
export function eventTypeFilter(
  types: readonly string[],
): `?eventType=${string}` {
  return `?eventType=${types.join(",")}`;
}
