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
