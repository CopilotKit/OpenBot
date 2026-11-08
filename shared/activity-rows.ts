/**
 * What the personal edition's Activity page shows, decided once for the page and for the server.
 *
 * The page asks the server to leave {@link OPENBOT_WORKING_EVENT_TYPES} out and draws each action
 * once ({@link oneRowPerAction}). The Activity report a Bot draws counts the same rows
 * (`botActivity` in `server/src/components/functions.ts`), so its figure for a Bot is the number of
 * rows the person finds on the page for that Bot.
 */

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
  // The same build's newer wording for a description nobody had edited.
  "component.description_updated",
  /*
   * The computer's boundary and isolation as the server read them at start-up, two rows at every
   * start. The personal edition has one computer and no admin setting either.
   */
  "computer.policy_loaded",
  "computer.isolation_loaded",
] as const;

/**
 * Routines calls whose change the routine store records itself (`routine.created`, `routine.updated`
 * and `routine.deleted`, in `auditRoutineStore` on the server). A Bot creating a routine wrote two
 * rows for one action: "Create routine / Called on this Bot's behalf" for the call, and "Create a
 * routine / Allowed" for the routine it made. Activity leaves the call's row out when it succeeded,
 * and shows the change, which is written whoever made it, a Bot or a person on the Routines page. A
 * call that failed made no change and keeps its row.
 */
export const CALLS_RECORDED_AS_CHANGES = [
  "routines/create_routine",
  "routines/update_routine",
  "routines/delete_routine",
] as const;

/**
 * The rows that end an action's attempt: a computer's or a folder's action that failed, was stopped
 * or was refused after its first row was written. Each carries the `attempt` id of that first row.
 */
export const ACTION_ENDINGS = [
  "computer.action_failed",
  "computer.action_stopped",
  "computer.action_refused",
] as const;

const ENDINGS = new Set<string>(ACTION_ENDINGS);

type Row = { eventType: string; payload?: Record<string, unknown> };

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
      .filter((event) => ENDINGS.has(event.eventType))
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
