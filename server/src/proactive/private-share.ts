/**
 * Before a Bot shares something from its owner's private conversation or memory with other
 * people, the owner has to have allowed it.
 *
 * WHAT COUNTS. Any send whose audience includes someone other than the owner: a Slack or channel
 * post others can read, a group conversation, a handoff to another person's Bot. Content that came
 * only from a conversation those same people are already in is not private to the owner and passes.
 * Everything else is treated as private, because a sender cannot prove otherwise.
 *
 * WHERE PERMISSION LIVES. In the existing approvals ledger, always on, regardless of the owner's
 * general approvals switch: this is a check dots makes unconditionally. An "allow always" answer is
 * a standing rule for this Bot and this audience; "allow once" covers the same content to the same
 * audience in the same conversation for thirty minutes, so the Bot's retry after an approval passes
 * instead of asking again.
 *
 * OUTCOMES. `allowed`; `denied` (the person said no); or `pending`, where the caller must not send
 * and either throws the returned suspension (headless turns wait and resume on the decision) or
 * answers the model with the message.
 */
import { createHash } from "node:crypto";
import {
  type ApprovalContinuation,
  type ApprovalStore,
  approvalAction,
  approvalPreview,
  currentApprovalContext,
} from "../approvals/types";
import { HeadlessToolSuspension } from "../computer/headless-tools";

export const PRIVATE_SHARE_TOOL_REF = "openbot/share_private_information";
export const PRIVATE_SHARE_EFFECT = "share_private";
const ONCE_WINDOW_MS = 30 * 60_000;

export type ShareAudience = {
  /** Where it is going. Named in the approval the person sees. */
  kind: "slack_channel" | "channel" | "group" | "handoff" | "external";
  /** A stable id for where it is going: a Slack channel id, a group id, a person id. */
  id: string;
  /** Everyone who will be able to read it, as user ids where known. */
  recipientUserIds: readonly string[];
  /** Human label, e.g. "#design" or "Priya's Bot". */
  label?: string;
};

export type PrivateShareInput = {
  ownerUserId: string;
  botId: string;
  audience: ShareAudience;
  /** The text about to be sent. Only a digest and a redacted preview reach the approval. */
  content: string;
  /**
   * Where the content came from. `shared_conversation` with `sharedWithUserIds` naming the same
   * audience is the only origin that skips the check.
   */
  origin:
    | { kind: "private_conversation" | "memory" | "unknown" }
    | { kind: "shared_conversation"; sharedWithUserIds: readonly string[] };
  /** The run and tool call this send belongs to; defaults to the current approval context. */
  continuation?: ApprovalContinuation;
};

export type PrivateShareVerdict =
  | { status: "allowed"; reason: string }
  | { status: "denied"; message: string }
  | {
      status: "pending";
      approvalId: string;
      message: string;
      suspension: HeadlessToolSuspension;
    };

/**
 * What a permission is for. A group or channel's people can change (any member can add someone), so
 * its scope names who was in it when the owner answered: a person added later is not covered by an
 * "always allow" given before they joined, and the owner is asked again.
 */
function audienceScope(audience: ShareAudience) {
  const where = `${audience.kind}:${audience.id}`;
  if (audience.kind !== "group" && audience.kind !== "channel") return where;
  const people = [...new Set(audience.recipientUserIds)].sort();
  const members = createHash("sha256")
    .update(people.join("\n"))
    .digest("hex")
    .slice(0, 16);
  return `${where}:members:${members}`;
}

export function sharesWithOthers(input: PrivateShareInput) {
  return (
    input.audience.recipientUserIds.some((id) => id !== input.ownerUserId) ||
    input.audience.kind === "external"
  );
}

export function createPrivateShareCheck(deps: {
  approvals: Pick<ApprovalStore, "open" | "list" | "rules">;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  return async function checkPrivateShare(
    input: PrivateShareInput,
  ): Promise<PrivateShareVerdict> {
    if (!sharesWithOthers(input))
      return { status: "allowed", reason: "Only the owner can read it." };
    if (input.origin.kind === "shared_conversation") {
      const shared = new Set(input.origin.sharedWithUserIds);
      if (
        input.audience.kind !== "external" &&
        input.audience.recipientUserIds.every(
          (id) => id === input.ownerUserId || shared.has(id),
        )
      )
        return {
          status: "allowed",
          reason: "Everyone it goes to was already in the conversation.",
        };
    }
    const scope = audienceScope(input.audience);
    const rules = await deps.approvals.rules(input.ownerUserId);
    if (
      rules.some(
        (rule) =>
          !rule.revokedAt &&
          rule.botId === input.botId &&
          rule.toolRef === PRIVATE_SHARE_TOOL_REF &&
          rule.effect === PRIVATE_SHARE_EFFECT &&
          rule.scope === scope,
      )
    )
      return { status: "allowed", reason: "You always allow this." };

    const continuation = input.continuation ?? currentApprovalContext();
    if (!continuation)
      return {
        status: "denied",
        message:
          "Sharing private information with other people needs your permission, and this send is not part of a run that can ask. It was not sent.",
      };
    const contentDigest = createHash("sha256")
      .update(input.content)
      .digest("hex");
    const candidate = {
      actorId: input.ownerUserId,
      botId: input.botId,
      toolRef: PRIVATE_SHARE_TOOL_REF,
      effect: PRIVATE_SHARE_EFFECT,
      scope,
      args: {
        audience: input.audience.label ?? scope,
        recipients: input.audience.recipientUserIds.length,
        contentDigest,
        preview: approvalPreview(input.content.slice(0, 280)),
      },
      target: { kind: input.audience.kind, id: input.audience.id },
      continuation,
    };
    const action = approvalAction(candidate);

    // The retry after an "allow once": same content, same audience, same conversation, recently.
    const recent = (await deps.approvals.list(input.ownerUserId)).find(
      (record) =>
        record.action.actionDigest === action.actionDigest &&
        record.action.threadId === action.threadId &&
        (record.decision === "allow_once" ||
          record.decision === "allow_always") &&
        record.decidedAt &&
        now().getTime() - record.decidedAt.getTime() < ONCE_WINDOW_MS,
    );
    if (recent) return { status: "allowed", reason: "You allowed this share." };

    const request = await deps.approvals.open(action);
    if (request.status === "denied")
      return {
        status: "denied",
        message: "You declined sharing this with them. It was not sent.",
      };
    if (request.status !== "pending")
      return { status: "allowed", reason: "You allowed this share." };
    const message = `Waiting for permission to share private information with ${input.audience.label ?? scope}. Nothing was sent.`;
    return {
      status: "pending",
      approvalId: request.id,
      message,
      suspension: new HeadlessToolSuspension(message, {
        kind: "approval",
        approvalId: request.id,
        requestId: request.id,
        continuation: action.continuation,
      }),
    };
  };
}
export type CheckPrivateShare = ReturnType<typeof createPrivateShareCheck>;
