import { randomUUID } from "node:crypto";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { ComputerAttachmentBroker } from "../computer/attachments";
import type { HandoffAttachmentStore } from "./handoff-attachment-store";

export type AttachmentCleanup = {
  sweep(): Promise<{ found: number; deleted: number }>;
};

export function createAttachmentCleanup(options: {
  store: HandoffAttachmentStore;
  broker: ComputerAttachmentBroker;
  auditStore: AuditStore;
  dryRun: boolean;
}): AttachmentCleanup {
  return {
    async sweep() {
      const expired = await options.store.expired();
      if (options.dryRun) return { found: expired.length, deleted: 0 };
      let deleted = 0;
      for (const attachment of expired) {
        const leaseId = randomUUID();
        let claimed: typeof attachment;
        try {
          claimed = await options.store.claimDeletion(attachment.id, leaseId);
        } catch {
          continue;
        }
        try {
          await options.broker.remove({
            botId: claimed.recipientBotId,
            handoffId: claimed.handoffId,
            attachment: claimed,
          });
          await options.store.completeDeletion(claimed.id, "expired", leaseId);
          deleted += 1;
          await recordAuditEvent(options.auditStore, {
            eventType: "agent.attachment_expired",
            targetType: "handoff_attachment",
            targetId: claimed.id,
            payload: {
              handoffId: claimed.handoffId,
              recipientBotId: claimed.recipientBotId,
              sha256: claimed.sha256,
              sizeBytes: claimed.sizeBytes,
              reason: "expired",
            },
          });
        } catch (error) {
          await options.store
            .releaseDeletionLease(claimed.id, leaseId)
            .catch(() => false);
          console.warn(
            `[attachments] could not delete expired attachment ${claimed.id}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
      return { found: expired.length, deleted };
    },
  };
}
