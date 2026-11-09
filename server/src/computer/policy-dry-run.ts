/**
 * What would this policy have decided, about actions that already happened?
 *
 * A boundary is written blind: an administrator types a CEL rule, saves it, and finds out what it
 * actually matches from the refusals it produces. The trail already holds everything needed to do
 * better — every computer action and every app call is recorded with the facts the boundary judged it
 * on — so a candidate policy can be replayed over that history and answer, before it is saved, "these
 * are the actions you would have decided differently."
 *
 * Replay, not simulation: the context handed to `evaluateActionPolicy` here is rebuilt from the
 * audit row exactly as the gateway or `callTool` built it at decision time, through the same helpers.
 * A rule that behaves one way here and another way live would make this feature worse than absent.
 *
 * Both surfaces, because one policy governs both. Replaying computer actions alone answered "this rule
 * changes nothing" about `mcp.server == "salesforce" && mcp.effect == "write"`, a rule that refuses
 * every write to Salesforce, and that answer is believed.
 */

import type { AuditEvent, AuditInitiator } from "../audit";
import {
  APP_CALL_EVENT_TYPES,
  appCallFromAuditRow,
  appCallPolicyContext,
  initiatorFromColumns,
} from "../plugins/plugin-store/call-policy";
import { describeFile, hostOf, intentOf } from "./gateway";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
  type PolicyDecision,
  policyInitiator,
} from "./policy";

/**
 * The event types that record a policy DECISION about an action. In one place, for the query.
 *
 * Not `computer.action_failed`: the gateway writes that beside the decision row when a permitted
 * action is attempted and does not succeed, so it is a second row for an action already recorded
 * here, not a decision of its own. Replaying it too would score the action twice — see
 * {@link dryRunAgainstHistory}.
 *
 * All three app-call rows, because an app call's decision is recorded on whichever row it ends with:
 * a permitted call writes one row, succeeded, failed or rejected by a later check, and that row is
 * its decision. The second row a trial-mode refusal writes is paired with its first in
 * {@link dryRunAgainstHistory}.
 */
export const REPLAYABLE_EVENT_TYPES = [
  "computer.action_allowed",
  "computer.action_refused",
  ...APP_CALL_EVENT_TYPES,
] as const;

/** The target types those rows are filed under, so the query reads no folder action's rows. */
export const REPLAYABLE_TARGET_TYPES = ["computer", "mcp_tool"] as const;

/** One action the candidate policy would have decided differently. */
export type DryRunChange = {
  id: string;
  createdAt: string;
  /** Which surface the action was on: a Bot's computer, or a tool on an app. */
  kind: "computer" | "app";
  /** The computer's tool (`computer_click`), or the app's tool as `<app>/<tool>`. */
  action: string;
  bot: string;
  page: string;
  /** For a person reading the list; absent on file and command actions. */
  element: { role: string; name: string } | null;
  command: string | null;
  file: string | null;
  /** What started the run, as the rule's `initiator` saw it. */
  initiator: PolicyContext["initiator"];
  /** What the policy in force decided, from the action's decision row. */
  was: "allowed" | "refused";
  would: "allowed" | "refused";
  /** The candidate rule that decided it, or null for the default refusal. */
  rule: string | null;
  reason: string;
};

export type DryRunReport = {
  /** Rows replayed. Bounded by what the caller asked the trail for, and says so. */
  scanned: number;
  wouldRefuse: number;
  wouldAllow: number;
  unchanged: number;
  /** Capped; the counts above are over everything scanned. */
  changes: DryRunChange[];
};

/** Changes returned in full detail. The counts still cover every scanned row. */
const CHANGES_CAP = 50;

/**
 * The gateway's context, rebuilt from what it recorded.
 *
 * Field for field against the context the gateway constructs: absent browser facts become neutral
 * empty strings rather than missing keys, because cel-js throws on an unbound identifier and a
 * throw fails closed — a replay that refused everything the moment a rule named `command` would
 * report a boundary far stricter than the one being proposed. `intent` is not stored on the row; it
 * is derived from the tool and key here exactly as the gateway derives it at decision time.
 *
 * Null when the row does not carry enough to replay — a row from before a field existed, or a
 * hand-inserted one. Skipped rather than guessed at.
 */
/**
 * The initiator an audit payload carries, narrowed back to the union.
 *
 * Its own reader rather than the one in `callback-token.ts`: that one narrows a value this
 * deployment signed and can trust the shape of, and this one reads a stored row that may predate the
 * field, have been written by an older version, or been inserted by hand. Anything it does not
 * recognise reads as absent, and `policyInitiator` turns that into a person.
 */
function initiatorFromPayload(value: unknown): AuditInitiator | undefined {
  if (!value || typeof value !== "object") return undefined;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "person" || kind === "deployment") return { kind };
  if (kind !== "routine" && kind !== "handoff") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id ? { kind, id } : undefined;
}

export function contextFromAuditPayload(
  payload: Record<string, unknown>,
  /**
   * The initiator from the row's own columns, which is where the gateway writes it. Absent, as for a
   * payload read on its own, the payload's `initiator` is read instead.
   */
  recorded?: AuditInitiator,
): PolicyContext | null {
  const action = payload.action;
  const bot = payload.bot;
  if (typeof action !== "string" || typeof bot !== "string") return null;
  // A folder action on the person's own computer (`host/read_file`) is decided by its folder grant
  // and the desktop's own asking, never by this policy, so replaying it here would invent a change.
  if (action.startsWith("host/")) return null;

  const text = (value: unknown): string =>
    typeof value === "string" ? value : "";
  const page = text(payload.page);
  const key = text(payload.key);
  const file = text(payload.file);

  // Stored as an object on element actions, absent on file and command actions, and the literal
  // sentence "not in the current snapshot" when the server could not identify the element. Only the
  // object shape carries fields a rule can match; the other two replay as the neutral element.
  const element =
    payload.element && typeof payload.element === "object"
      ? (payload.element as Record<string, unknown>)
      : null;
  const intent = intentOf(action, key || undefined);

  return {
    tool: { name: action },
    bot: { id: bot },
    actor: { id: text(payload.actor) },
    page: { url: page, host: hostOf(page) },
    ...(intent ? { intent } : {}),
    key,
    element: {
      // The ref travels beside the element on the row, not inside it.
      ref: text(payload.ref),
      role: text(element?.role),
      name: text(element?.name),
      type: text(element?.type),
    },
    file: file ? describeFile(file) : { path: "", name: "", extension: "" },
    command: text(payload.command),
    mcp: { server: "", tool: "", effect: "" },
    /*
     * Read off the row, neutral when it says nothing. The gateway writes the run's initiator into
     * the row's columns, never its payload, and this read only the payload: every routine's click and
     * command replayed as a person's, so `initiator.kind == "routine" && intent == "run_command"`
     * previewed as stopping nothing on a deployment whose routines run commands nightly.
     */
    initiator: policyInitiator(
      recorded ?? initiatorFromPayload(payload.initiator),
    ),
  };
}

/** A change, as the report lists it, from the context the candidate judged. */
function changeOf(
  event: AuditEvent,
  kind: DryRunChange["kind"],
  action: string,
  context: PolicyContext,
  was: DryRunChange["was"],
  decision: PolicyDecision,
): DryRunChange {
  return {
    id: event.id,
    createdAt: event.createdAt,
    kind,
    action,
    bot: context.bot.id,
    page: context.page.url,
    element:
      context.element?.role || context.element?.name
        ? {
            role: context.element.role,
            name: context.element.name,
          }
        : null,
    command: context.command || null,
    file: context.file?.path || null,
    initiator: context.initiator,
    was,
    would: decision.allowed ? "allowed" : "refused",
    rule: decision.matched,
    reason: decision.reason,
  };
}

/**
 * The action one row records, ready to be judged again, or null when the row is not one to judge.
 *
 * Null for a row with nothing to replay, and for a row about an action already counted: the outcome
 * row of a computer action, and the second row of an app call. `attempts` holds the app calls seen.
 */
function replayable(
  event: AuditEvent,
  attempts: Set<string>,
): {
  kind: DryRunChange["kind"];
  action: string;
  context: PolicyContext;
  was: DryRunChange["was"];
} | null {
  if (event.eventType.startsWith("mcp.call_")) {
    const call = appCallFromAuditRow(event);
    /*
     * One call, one score. A trial-mode refusal is recorded refused and then recorded again with
     * what became of the call it let through, both carrying the refused decision; only the first is
     * the decision. A call written since rows carried an `attempt` is also counted once by it, which
     * holds for any second row a call writes.
     */
    if (!call?.decisionRow) return null;
    if (call.attempt) {
      if (attempts.has(call.attempt)) return null;
      attempts.add(call.attempt);
    }
    return {
      kind: "app",
      action: call.ref,
      context: appCallPolicyContext(call),
      was: call.allowed ? "allowed" : "refused",
    };
  }

  // Both carry a decision row already in this history, so scoring the outcome row would count the
  // action twice; a stop is skipped for the same reason a failure is.
  if (
    event.eventType === "computer.action_failed" ||
    event.eventType === "computer.action_stopped"
  )
    return null;
  const context = contextFromAuditPayload(
    event.payload,
    initiatorFromColumns(event),
  );
  if (!context) return null;

  /*
   * The policy's own verdict where the row records one. A refused row is not always the policy's
   * refusal: the person can deny an action the policy allowed, and that row keeps the policy's
   * `allowed: true`. Scored by its event type it would read as a refusal no rule made.
   */
  const recorded = (event.payload.decision as { allowed?: unknown } | undefined)
    ?.allowed;
  const was =
    typeof recorded === "boolean"
      ? recorded
        ? "allowed"
        : "refused"
      : event.eventType === "computer.action_refused"
        ? "refused"
        : "allowed";
  return { kind: "computer", action: context.tool.name, context, was };
}

/**
 * Replay judged actions under a candidate policy and report what changes.
 *
 * "Was" comes from the decision the row records, which is what the policy in force decided, including
 * a dry-run policy's refusals, which were recorded and then carried out. That is the honest
 * baseline: the question this answers is "what would decide differently than was decided", not
 * "what would run differently than ran". A row without one falls back to its event type.
 *
 * A `computer.action_failed` row is skipped rather than scored. It is the outcome of an action whose
 * decision row is already in this history, so counting it would score that action twice — and worse,
 * a dry-run policy carries a refused action out, so a refused-then-failed action would arrive as a
 * decision row that says "refused" and a failure row that reads as "allowed", inventing a change no
 * policy made. The decision is on the decision row; the failure row only says it did not finish.
 * Callers should exclude it from the query too ({@link REPLAYABLE_EVENT_TYPES}); this guards the
 * function against being handed one regardless.
 *
 * An app call is scored once, from its decision row, for the same reason: see `replayable`.
 */
export function dryRunAgainstHistory(
  policy: ActionPolicy,
  events: AuditEvent[],
): DryRunReport {
  const report: DryRunReport = {
    scanned: 0,
    wouldRefuse: 0,
    wouldAllow: 0,
    unchanged: 0,
    changes: [],
  };
  const attempts = new Set<string>();

  for (const event of events) {
    const action = replayable(event, attempts);
    if (!action) continue;
    report.scanned += 1;

    const decision = evaluateActionPolicy(policy, action.context);
    const would = decision.allowed ? "allowed" : "refused";

    if (action.was === would) {
      report.unchanged += 1;
      continue;
    }
    if (would === "refused") report.wouldRefuse += 1;
    else report.wouldAllow += 1;

    if (report.changes.length >= CHANGES_CAP) continue;
    report.changes.push(
      changeOf(
        event,
        action.kind,
        action.action,
        action.context,
        action.was,
        decision,
      ),
    );
  }

  return report;
}
