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
  /** A Bot asked for a computer of its own by somebody without "Isolated Bots", or that has no owner. */
  "bot.isolation_refused",
  /** A run that would have sent more tools than its model accepts, never sent to it. */
  "agent.tool_limit_refused",
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
  /** A person pressed Stop mid-action: the action did not happen, and nothing broke. */
  "computer.action_stopped",
  "agent.stream_stalled",
  /** A hop that was accepted, ran out of attempts, and never became the other Bot's turn. */
  "agent.handoff_failed",
  /** A question that reached nobody: the Bot stopped, and the person was never asked. */
  "agent.escalation_failed",
  /*
   * A tool call this deployment permitted and the vendor did not complete.
   *
   * The direct sibling of `computer.action_failed`, written by the same decide-record-then-act
   * order on the other acting surface: `callTool` writes the decision row first, attempts the
   * call, and then writes this instead of `mcp.call_succeeded` when the vendor answers `isError`
   * or the attempt throws. Every failure of a per-person connector lands here — no connection for
   * the asker, a refresh token the vendor stopped accepting, an API not enabled for the project —
   * which makes it the row somebody most often comes to this page to find, and it was the one row
   * of the family drawn in the same muted colour as a call that worked.
   */
  "mcp.call_failed",
  /*
   * A component's read that was granted and then broke.
   *
   * `server/src/audit.ts` says this one is "deliberately not a refusal", and that is right: nothing
   * was forbidden. But it is not an allowance either. The row exists precisely because the read did
   * not happen, and the page already labels it "Could not be read" while colouring it as though it
   * had been.
   */
  "component.function_failed",
] as const;

/**
 * Every row about one action a Bot took on its computer, whatever became of it.
 *
 * The Computer actions view used to ask for `computer.action_allowed` alone, so a refused, failed or
 * stopped action was missing from the one view named for them, and the actions that remained all
 * read as allowed.
 */
export const COMPUTER_ACTION_EVENT_TYPES = [
  "computer.action_allowed",
  "computer.action_refused",
  "computer.action_failed",
  "computer.action_stopped",
] as const;

/**
 * OpenBot's own working, which the personal edition's Activity leaves out. None of it is something
 * a Bot did or a person can act on, and Admin keeps all of it.
 */
export const OPENBOT_WORKING_EVENT_TYPES = [
  /*
   * Which tools a run was offered, written on every turn ("Choose tools for a run, 96 of 96 tools").
   * Everything offered was already the Bot's, and a run offered too many says so on its own row
   * (`agent.tool_limit_refused`). Admin keeps it for tuning which skills declare which tools.
   */
  "mcp.tools_discovered",
  /*
   * Which Bot a message went to, written on every message ("Sent to the default Bot, fallback:
   * one-candidate"). The conversation already shows which Bot answered, and a person picks another
   * with @. Admin keeps it for tuning the router.
   */
  "channel.routed",
  /*
   * A build's components, published as OpenBot first sees them. The personal edition has no way for
   * a person to publish or withdraw one, so every such row is OpenBot setting itself up.
   */
  "component.published",
  /*
   * The computer's boundary and isolation as the server read them at start-up, two rows at every
   * start. The personal edition has one computer and no admin setting either.
   */
  "computer.policy_loaded",
  "computer.isolation_loaded",
] as const;

export type AuditOutcome = "refused" | "did-not-happen" | "allowed";

const REFUSED = new Set<string>(REFUSED_EVENT_TYPES);
const DID_NOT_HAPPEN = new Set<string>(DID_NOT_HAPPEN_EVENT_TYPES);

type Row = { eventType: string; payload?: Record<string, unknown> };

/**
 * What kind of thing this row is, for the label and the colour it is drawn in.
 *
 * Mostly its type. The two approval rows are the exception, because one type covers every answer:
 * `approval.person_decided` is a person allowing or denying, and `approval.evaluated` is the gate
 * allowing, asking or refusing. Read by type alone, a denial was drawn as "Allowed". They stay out of
 * the Blocked view, whose list is by type; the action a denial stopped is there as its own row.
 */
export function outcomeOf(row: string | Row): AuditOutcome {
  const { eventType, payload } =
    typeof row === "string" ? { eventType: row, payload: undefined } : row;
  if (REFUSED.has(eventType)) return "refused";
  if (DID_NOT_HAPPEN.has(eventType)) return "did-not-happen";
  // A folder action recorded before it was a computer's says how it went in its payload.
  if (
    eventType === "configuration.changed" &&
    payload?.change === "host_access_tool_call"
  ) {
    if (payload.outcome === "refused") return "refused";
    if (payload.outcome === "failed" || payload.outcome === "stopped")
      return "did-not-happen";
  }
  if (eventType === "approval.person_decided" && payload?.decision === "deny")
    return "refused";
  if (
    eventType === "approval.evaluated" &&
    (payload?.outcome as { behaviour?: unknown } | undefined)?.behaviour ===
      "deny"
  )
    return "refused";
  return "allowed";
}

/**
 * The rows to draw, with each failed, stopped or refused action shown once.
 *
 * The computer writes an action's row before it acts, so there is no way to act off the trail, and a
 * second row when the action then fails or is stopped. Both carry the same `attempt` id. Drawn as they
 * were, a read of a missing file was two rows, "Allowed" and "Did not happen", and the first is the
 * one a reader believes. The failure row carries everything the first did, so the first is left out
 * when its failure is loaded beside it. The trail itself, and the CSV export, keep both.
 *
 * A refusal can end an attempt too: a folder action on the person's own computer is written as it
 * goes to the desktop, which then asks them, and their Deny is the refused row that ends it.
 */
export function oneRowPerAction<T extends Row>(events: T[]): T[] {
  const ended = new Set(
    events
      .filter(
        (event) =>
          DID_NOT_HAPPEN.has(event.eventType) ||
          event.eventType === "computer.action_refused",
      )
      .map((event) => event.payload?.attempt)
      .filter((attempt): attempt is string => typeof attempt === "string"),
  );
  if (ended.size === 0) return events;
  return events.filter(
    (event) =>
      event.eventType !== "computer.action_allowed" ||
      typeof event.payload?.attempt !== "string" ||
      !ended.has(event.payload.attempt),
  );
}

/** The `eventType` query one of the saved views filters by. */
export function eventTypeFilter(
  types: readonly string[],
): `?eventType=${string}` {
  return `?eventType=${types.join(",")}`;
}
