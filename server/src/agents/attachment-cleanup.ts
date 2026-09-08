import type { ComputerAttachmentBroker } from "../computer/attachments";
import type { HandoffAttachmentStore } from "./handoff-attachment-store";

export type AttachmentCleanup = {
  sweep(): Promise<{ found: number; deleted: number }>;
};

export function createAttachmentCleanup(options: {
  store: HandoffAttachmentStore;
  broker: ComputerAttachmentBroker;
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
