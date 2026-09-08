import type { ComputerAttachmentBroker } from "../computer/attachments";
import { type AuditStore, recordAuditEvent } from "../audit";
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
        try {
          await options.broker.remove({
            botId: attachment.recipientBotId,
            handoffId: attachment.handoffId,
            attachment,
          });
          await recordAuditEvent(options.auditStore, {
            eventType: "agent.attachment_expired",
            targetType: "handoff_attachment",
            targetId: attachment.id,
            payload: {
              handoffId: attachment.handoffId,
              recipientBotId: attachment.recipientBotId,
              sha256: attachment.sha256,
              sizeBytes: attachment.sizeBytes,
              reason: "expired",
            },
          });
          await options.store.markDeleted(attachment.id, "expired");
          deleted += 1;
        } catch (error) {
          console.warn(
            `[attachments] could not delete expired attachment ${attachment.id}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
      return { found: expired.length, deleted };
    },
  };
}
