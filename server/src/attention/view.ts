/**
 * The attention inbox: the trail rows that mean a Bot is waiting on a person, minus the ones a
 * person has already handled.
 *
 * A view, not a store. Refusals and stalls are already recorded transactionally by the gateway and
 * the stall guard, so deriving the inbox from those rows means it cannot miss one: there is no
 * second write to forget, and nothing here runs on the action path. The only state the inbox owns
 * is the resolution — who marked a row handled, and when — which lives beside the trail rather than
 * in it, because the trail is append-only and must stay that way.
 */

import type { AuditEvent } from "../audit";

/** The trail rows that mean "a Bot is waiting on a person". In one place, for the query. */
export const ATTENTION_EVENT_TYPES = [
  "computer.action_refused",
  "mcp.call_rejected",
  "agent.stream_stalled",
] as const;

export type AttentionKind = "refused" | "tool_rejected" | "stalled";

export type AttentionItem = {
  /** The trail row's own id: resolving cites the exact row, not a copy of it. */
  id: string;
  kind: AttentionKind;
  botId: string;
  at: string;
  /** One sentence a person can act on, built from what the trail recorded. */
  sentence: string;
};

const KIND_BY_EVENT_TYPE: Record<string, AttentionKind> = {
  "computer.action_refused": "refused",
  "mcp.call_rejected": "tool_rejected",
  "agent.stream_stalled": "stalled",
};

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

/**
 * The Bot a row is about. The three event types write it differently, and the difference is not
 * cosmetic: the computer and the stall guard put the Bot in `targetId`, but a tool rejection's
 * target is the TOOL — `targetType: "mcp_tool"`, `targetId` the ref — and its Bot travels only in
 * the payload. Reading `targetId` unconditionally made the inbox call a refusal's Bot
 * "google-drive/search_files", which is not a Bot, which `canUseBot` correctly denies, which hid
 * every tool rejection from exactly the person it was for.
 */
export function botOf(
  event: Pick<AuditEvent, "targetType" | "targetId" | "payload">,
): string {
  if (event.targetType === "computer" || event.targetType === "agent") {
    return event.targetId ?? text(event.payload.bot);
  }
  return text(event.payload.bot);
}

/** What to tell the person. Prefers the sentence the recording code already wrote for one. */
function sentenceFor(event: AuditEvent, kind: AttentionKind): string {
  const payload = event.payload;
  if (kind === "stalled") {
    return "The Bot's stream went quiet mid-turn and the run was ended.";
  }
  if (kind === "tool_rejected") {
    // The rejection records the decision's own reason, written for a person. Use it whole.
    const reason = text(payload.reason);
    if (reason) return reason;
    const tool = text(payload.tool) || "a tool";
    return `A call to ${tool} was refused by this deployment's boundary.`;
  }
  // A computer refusal records the gateway's own reason, written for a person. Use it whole.
  const decision =
    payload.decision && typeof payload.decision === "object"
      ? (payload.decision as Record<string, unknown>)
      : null;
  const reason = text(decision?.reason);
  if (reason) return reason;
  const action = text(payload.action) || "an action";
  return `${action} was refused by this deployment's boundary.`;
}

/**
 * Compose the inbox from trail rows and the set of resolved row ids.
 *
 * Rows without a Bot are dropped rather than guessed at: an item that cannot say whose trouble it
 * is cannot be scoped to a person, and showing it to everybody would leak across the same line
 * `canUseBot` exists to hold.
 */
export function attentionItemsFrom(
  events: AuditEvent[],
  resolvedEventIds: ReadonlySet<string>,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const event of events) {
    const kind = KIND_BY_EVENT_TYPE[event.eventType];
    if (!kind) continue;
    if (resolvedEventIds.has(event.id)) continue;
    const botId = botOf(event);
    if (!botId) continue;
    items.push({
      id: event.id,
      kind,
      botId,
      at: event.createdAt,
      sentence: sentenceFor(event, kind),
    });
  }
  return items;
}
