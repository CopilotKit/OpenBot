import type { AuditEvent, AuditInitiator } from "../../audit";
import { type PolicyContext, policyInitiator } from "../../computer/policy";
import { toolNameFor, UNATTRIBUTED_ACTOR } from "./model";

/**
 * How an app's tool call is put to the boundary, live and in replay.
 *
 * One place for both because they must agree. `callTool` builds this context to decide a call; the
 * boundaries backtest (`computer/policy-dry-run.ts`) rebuilds it from the call's audit row to say what
 * a candidate rule would have decided instead. A field built one way here and another way there makes
 * the backtest report a rule as reaching calls it would not reach, or as harmless when it is not, and
 * a person reading the preview has no way to tell.
 */

/** The facts about one call that the boundary judges, and that the call's audit row keeps. */
export type AppCallFacts = {
  /** `<server>/<tool>`, as the Bot named it. */
  ref: string;
  botId: string;
  /** Whose authority the call runs on. Empty when nobody could be attributed. */
  actorId: string;
  effect: "read" | "write";
  initiator?: AuditInitiator;
};

/**
 * The same policy the computer actions are judged by, asked about a tool call.
 *
 * Every field is present, including the ones a tool call has no use for, and that is load bearing
 * rather than tidy. This engine treats an expression it cannot evaluate as a match, which is correct
 * for a browser action on an element the server could not resolve. Applied to a tool call it is a
 * disaster: the boundary this product ships in `.env.example` denies
 * `contains(element.name, "submit") || key == "Enter"`, and with `element` and `key` absent that rule
 * is unevaluable, so it would match, so every deployment using the shipped preset would refuse every
 * MCP call for a reason mentioning a submit button.
 *
 * Neutral values instead. Empty strings match no substring, no key and no extension, so a rule written
 * about the browser evaluates to false against a tool call, which is the honest answer: a tool call
 * did not click anything. A rule meant to catch tool calls says so, with `mcp` or with `intent`.
 */
export function appCallPolicyContext(call: AppCallFacts): PolicyContext {
  const [server = "", ...rest] = call.ref.split("/");
  return {
    tool: { name: toolNameFor(call.ref) },
    bot: { id: call.botId },
    actor: { id: call.actorId },
    page: { url: "", host: "" },
    element: { ref: "", role: "", name: "", type: "" },
    key: "",
    file: { path: "", name: "", extension: "" },
    // Empty, like the browser fields above: an MCP call runs no shell command, but a
    // `deny: contains(command, "rm -rf")` names `command`, and an unbound identifier throws and
    // fails closed, which would refuse every MCP call once a deployment wrote a rule about its
    // shell. An empty command matches no such rule.
    command: "",
    intent: call.effect === "write" ? "write_tool" : "read_tool",
    mcp: { server, tool: rest.join("/"), effect: call.effect },
    /*
     * The real one, and this is the path where it is not neutral. A routine's turn reaches its tools
     * through here, carrying the initiator its run assertion was signed with, so this is where
     * `initiator.kind == "routine"` becomes a rule a deployment can actually write. A chat turn
     * arrives with none and reads as a person.
     */
    initiator: policyInitiator(call.initiator),
  };
}

/** The rows `callTool` writes once the boundary has decided a call. */
export const APP_CALL_EVENT_TYPES = [
  "mcp.call_succeeded",
  "mcp.call_failed",
  "mcp.call_rejected",
] as const;

/**
 * The initiator a row was written with, read back from its columns.
 *
 * The columns are what `recordAuditEvent` writes the initiator into, for a computer action and an app
 * call alike, so they are where a replay has to read it. A kind this version does not know, or a kind
 * that needs an id and has none, reads as absent, and `policyInitiator` turns that into a person.
 */
export function initiatorFromColumns(
  event: Pick<AuditEvent, "initiatorKind" | "initiatorId">,
): AuditInitiator | undefined {
  const kind = event.initiatorKind;
  if (kind === "person" || kind === "deployment") return { kind };
  if (
    kind !== "routine" &&
    kind !== "responsibility" &&
    kind !== "memory" &&
    kind !== "handoff"
  )
    return undefined;
  return event.initiatorId ? { kind, id: event.initiatorId } : undefined;
}

/** One call as its audit row records it: the facts it was judged on, and what the boundary decided. */
export type RecordedAppCall = AppCallFacts & {
  /** The boundary's own verdict, which is not always what happened: see `callTool`. */
  allowed: boolean;
  /** Shared by every row one call writes. Absent on rows written before it was. */
  attempt?: string;
  /**
   * Whether this is the row the decision is recorded on, rather than a later row about the same call.
   *
   * A call the boundary refuses in trial mode writes two rows: the refusal, and then whatever became
   * of the call it let through. Both carry the refused decision. Only the refusal is the decision.
   */
  decisionRow: boolean;
};

/**
 * The call an `mcp.call_*` row records, or null when it records no decision by the boundary.
 *
 * A call refused before the boundary was asked (a tool this Bot was never given, a check-in reaching
 * for a write, an account that is not the person's) leaves a row with no `decision` and no `effect`,
 * and is not the boundary's to replay.
 */
export function appCallFromAuditRow(event: AuditEvent): RecordedAppCall | null {
  if (!(APP_CALL_EVENT_TYPES as readonly string[]).includes(event.eventType))
    return null;
  const payload = event.payload ?? {};
  const decision = payload.decision as { allowed?: unknown } | undefined;
  const effect = payload.effect;
  if (typeof decision?.allowed !== "boolean") return null;
  if (effect !== "read" && effect !== "write") return null;
  if (typeof payload.bot !== "string") return null;

  const ref =
    event.targetId?.includes("/") === true
      ? event.targetId
      : typeof payload.server === "string" && typeof payload.tool === "string"
        ? `${payload.server}/${payload.tool}`
        : null;
  if (!ref) return null;

  const actor = typeof payload.actor === "string" ? payload.actor : "";
  const initiator = initiatorFromColumns(event);
  return {
    ref,
    botId: payload.bot,
    // The row says `unattributed` where the call was decided on an empty actor; see `callTool`.
    actorId: actor === UNATTRIBUTED_ACTOR ? "" : actor,
    effect,
    ...(initiator ? { initiator } : {}),
    allowed: decision.allowed,
    ...(typeof payload.attempt === "string"
      ? { attempt: payload.attempt }
      : {}),
    decisionRow:
      decision.allowed ||
      (event.eventType === "mcp.call_rejected" &&
        payload.refusal === undefined),
  };
}
