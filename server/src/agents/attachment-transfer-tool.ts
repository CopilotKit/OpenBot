import { z } from "zod";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { ComputerAttachmentBroker } from "../computer/attachments";
import type { WorkspaceUploadTarget } from "../computer/upload-target";
import type { GrantedTool } from "../plugins/tools";
import type { RunAssertion } from "./callback-token";
import type { HandoffAttachmentStore } from "./handoff-attachment-store";

const uuid = z.string().uuid();
const parameters = z.object({
  destination: z.literal("netsfera-erp"),
  transferId: uuid.describe(
    "The upload transfer id returned by erp_documents_reserve_upload",
  ),
  attachmentId: uuid.describe("The id shown beside the attached file"),
});
const completionParameters = z.object({
  attachmentId: uuid,
  transferId: uuid,
  outcome: z.enum([
    "ingested",
    "exact_duplicate",
    "rejected",
    "failed",
    "stale",
  ]),
  erpReference: z.string().min(1).max(200).optional(),
});

export function createAttachmentTransferTool(options: {
  from: RunAssertion;
  store: HandoffAttachmentStore;
  broker: ComputerAttachmentBroker;
  target: WorkspaceUploadTarget;
  auditStore: AuditStore;
  fetchImpl?: typeof fetch;
}): GrantedTool {
  return {
    name: "transfer_workspace_file",
    ref: "bot/transfer_workspace_file",
    description:
      "Upload one file attached to you into the fixed Netsfera ERP transfer previously reserved with erp_documents_reserve_upload. The destination and credential are fixed by the deployment; pass only the attachment id and the ERP transfer id.",
    parameters,
    execute: async (args) => {
      const parsed = parameters.safeParse(args);
      if (!parsed.success) {
        return "The workspace file was not transferred: destination, attachment id, and transfer id must be valid.";
      }
      const { attachmentId, transferId } = parsed.data;
      const row = await options.store.ownedByRecipient(
        attachmentId,
        options.from.botId,
      );
      if (!row || row.state === "deleted") {
        return "That attachment is not available to this Bot.";
      }
      if (row.state === "transferred") {
        return row.externalTransferId === transferId
          ? success(row)
          : "That attachment has already been transferred under another ERP transfer id.";
      }
      if (row.state !== "copied") {
        return `That attachment cannot be transferred while it is ${row.state}.`;
      }

      try {
        const exported = await options.broker.read({
          botId: options.from.botId,
          path: row.path,
        });
        if (
          exported.filename !== row.filename ||
          exported.mediaType !== row.mediaType ||
          exported.sizeBytes !== row.sizeBytes ||
          exported.sha256 !== row.sha256
        ) {
          throw new Error("attachment metadata changed");
        }
        const response = await (options.fetchImpl ?? fetch)(
          `${options.target.origin}${options.target.pathFor(transferId)}`,
          {
            method: "PUT",
            redirect: "manual",
            headers: {
              authorization: `Bearer ${options.target.bearerToken}`,
              "content-type": row.mediaType,
              "content-length": String(row.sizeBytes),
            },
            body: new Uint8Array(exported.bytes),
            signal: AbortSignal.timeout(60_000),
          },
        );
        if (!response.ok) {
          throw new Error(`ERP upload returned ${response.status}`);
        }
        const transferred = await options.store.markTransferred(
          attachmentId,
          transferId,
        );
        await recordAuditEvent(options.auditStore, {
          eventType: "agent.attachment_transferred",
          targetType: "attachment",
          targetId: attachmentId,
          ...(options.from.actorId
            ? { actorUserId: options.from.actorId }
            : {}),
          payload: {
            bot: options.from.botId,
            attachmentId,
            transferId,
            destination: options.target.id,
            sha256: row.sha256,
            sizeBytes: row.sizeBytes,
            status: "UPLOADED",
          },
        });
        return success(transferred);
      } catch (error) {
        const reason =
          error instanceof Error &&
          /^ERP upload returned \d{3}$/.test(error.message)
            ? error.message
            : "the governed upload failed";
        return `The workspace file could not be transferred: ${reason}.`;
      }
    },
  };
}

export function createAttachmentCompletionTool(options: {
  from: RunAssertion;
  store: HandoffAttachmentStore;
  broker: ComputerAttachmentBroker;
  auditStore: AuditStore;
}): GrantedTool {
  return {
    name: "complete_workspace_file_transfer",
    ref: "bot/complete_workspace_file_transfer",
    description:
      "Finish a governed ERP file transfer after checking its durable ERP result. Use ingested or exact_duplicate only with the ERP invoice/document reference; retryable failed or stale outcomes retain the file.",
    parameters: completionParameters,
    execute: async (args) => {
      const parsed = completionParameters.safeParse(args);
      if (!parsed.success)
        return "The workspace transfer was not completed: invalid arguments.";
      const { attachmentId, transferId, outcome, erpReference } = parsed.data;
      if (
        (outcome === "ingested" || outcome === "exact_duplicate") &&
        !erpReference
      ) {
        return "The workspace transfer was not completed: the durable ERP reference is required.";
      }
      const row = await options.store.ownedByRecipient(
        attachmentId,
        options.from.botId,
      );
      if (!row) return "That attachment is not available to this Bot.";
      if (row.externalTransferId !== transferId) {
        return "That ERP transfer id does not belong to this attachment.";
      }
      if (row.state === "deleted") {
        return JSON.stringify({
          attachmentId,
          transferId,
          outcome,
          deleted: true,
        });
      }
      if (row.state !== "transferred") {
        return `That attachment cannot be completed while it is ${row.state}.`;
      }
      if (outcome === "failed" || outcome === "stale") {
        return JSON.stringify({
          attachmentId,
          transferId,
          outcome,
          retained: true,
        });
      }

      try {
        await options.broker.remove({
          botId: options.from.botId,
          handoffId: row.handoffId,
          attachment: row,
        });
        await options.store.markDeleted(
          attachmentId,
          `${outcome}${erpReference ? `:${erpReference}` : ""}`,
        );
        await recordAuditEvent(options.auditStore, {
          eventType: "agent.attachment_completed",
          targetType: "attachment",
          targetId: attachmentId,
          ...(options.from.actorId
            ? { actorUserId: options.from.actorId }
            : {}),
          payload: {
            bot: options.from.botId,
            attachmentId,
            transferId,
            outcome,
            ...(erpReference ? { erpReference } : {}),
            deleted: true,
          },
        });
        return JSON.stringify({
          attachmentId,
          transferId,
          outcome,
          deleted: true,
        });
      } catch {
        return "The ERP result was recorded, but the recipient file could not be deleted safely. It will be retried by cleanup.";
      }
    },
  };
}

function success(row: {
  id: string;
  externalTransferId: string | null;
  sha256: string;
  sizeBytes: number;
}): string {
  return JSON.stringify({
    attachmentId: row.id,
    transferId: row.externalTransferId,
    status: "UPLOADED",
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
  });
}
