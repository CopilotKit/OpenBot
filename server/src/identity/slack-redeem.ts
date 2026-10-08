import { type AuditStore, recordAuditEvent } from "../audit";
import { slackRealm } from "./providers";
import type { IdentityStore } from "./store";
import {
  IdentityConflictError,
  IdentityInputError,
  IdentityLinkError,
} from "./types";

/**
 * Redeems a link code a person sent from Slack, or (`discard`) cancels one they exposed in a shared
 * conversation, reporting whether a live Slack code was cancelled. Failures a person can cause (a bad or used code, or a
 * blank or rejected team id, all reported as "invalid") become a result; any other error propagates. The audit event is written after the link commits; a failed write is
 * logged and the person is still told they are linked. It names the link and provider, never the realm or Slack subject.
 */
export function slackCodeRedeemer(
  store: Pick<IdentityStore, "redeemChallenge" | "discardChallenge">,
  auditStore?: AuditStore,
): {
  redeem(
    code: string,
    sender: { teamId: string; userId: string },
  ): Promise<"linked" | "conflict" | "invalid">;
  discard(code: string): Promise<boolean>;
} {
  return {
    discard: (code) => store.discardChallenge(code, "slack"),
    async redeem(code, sender) {
      let link: Awaited<ReturnType<typeof store.redeemChallenge>>;
      try {
        const realm = slackRealm({
          connectionId: "opentag",
          installationId: "opentag",
          workspaceId: sender.teamId,
        });
        link = await store.redeemChallenge(code, {
          provider: "slack",
          realm,
          subject: sender.userId,
        });
      } catch (error) {
        if (
          error instanceof IdentityLinkError ||
          error instanceof IdentityInputError
        )
          return "invalid";
        if (error instanceof IdentityConflictError) return "conflict";
        throw error;
      }
      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: "identity.linked",
          targetType: "identity_link",
          targetId: link.id,
          actorUserId: link.userId,
          payload: { actor: link.userId, provider: "slack" },
        }).catch((error) =>
          console.error(
            JSON.stringify({
              type: "identity-link-audit-failed",
              provider: "slack",
              error: String(error),
            }),
          ),
        );
      }
      return "linked";
    },
  };
}
