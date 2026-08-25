/**
 * What would this policy have decided, about actions that already happened?
 *
 * A boundary is written blind: an administrator types a CEL rule, saves it, and finds out what it
 * actually matches from the refusals it produces. The trail already holds everything needed to do
 * better — every computer action is recorded with the same facts the gateway judged it on — so a
 * candidate policy can be replayed over that history and answer, before it is saved, "these are the
 * actions you would have decided differently."
 *
 * Replay, not simulation: the context handed to `evaluateActionPolicy` here is rebuilt from the
 * audit row exactly as the gateway built it at decision time, through the same helpers. A rule that
 * behaves one way here and another way live would make this feature worse than absent.
 */

import type { AuditEvent } from "../audit";
import { describeFile, hostOf, intentOf } from "./gateway";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
} from "./policy";

/** The event types the gateway writes for a judged computer action. In one place, for the query. */
export const REPLAYABLE_EVENT_TYPES = [
  "computer.action_allowed",
  "computer.action_refused",
  "computer.action_failed",
] as const;

/** One action the candidate policy would have decided differently. */
export type DryRunChange = {
  id: string;
  createdAt: string;
  action: string;
  bot: string;
  page: string;
  /** For a person reading the list; absent on file and command actions. */
  element: { role: string; name: string } | null;
  command: string | null;
  file: string | null;
  /** What actually happened, from the trail. A failed action was permitted first, so it was allowed. */
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
export function contextFromAuditPayload(
  payload: Record<string, unknown>,
): PolicyContext | null {
  const action = payload.action;
  const bot = payload.bot;
  if (typeof action !== "string" || typeof bot !== "string") return null;

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
  };
}

/**
 * Replay judged actions under a candidate policy and report what changes.
 *
 * "Was" comes from the row's event type, which records what the policy in force decided — including
 * a dry-run policy's refusals, which were recorded and then carried out. That is the honest
 * baseline: the question this answers is "what would decide differently than was decided", not
 * "what would run differently than ran".
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

  for (const event of events) {
    const context = contextFromAuditPayload(event.payload);
    if (!context) continue;
    report.scanned += 1;

    const was =
      event.eventType === "computer.action_refused" ? "refused" : "allowed";
    const decision = evaluateActionPolicy(policy, context);
    const would = decision.allowed ? "allowed" : "refused";

    if (was === would) {
      report.unchanged += 1;
      continue;
    }
    if (would === "refused") report.wouldRefuse += 1;
    else report.wouldAllow += 1;

    if (report.changes.length >= CHANGES_CAP) continue;
    report.changes.push({
      id: event.id,
      createdAt: event.createdAt,
      action: context.tool.name,
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
      was,
      would,
      rule: decision.matched,
      reason: decision.reason,
    });
  }

  return report;
}
