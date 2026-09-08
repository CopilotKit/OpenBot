import { z } from "zod";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type {
  ComputerAttachmentBroker,
  ExportedAttachment,
} from "../computer/attachments";
import {
  type WorkspaceUploadTarget,
  workspaceUploadTargetFromMcp,
} from "../computer/upload-target";
import type {
  HandoffAttachmentStore,
  StoredHandoffAttachment,
} from "./handoff-attachment-store";

const uuid = z.string().uuid();
export const workspaceTransferInput = z.object({
  botId: z.string().min(1).max(120),
  transferId: uuid,
  attachmentId: uuid,
});
export type WorkspaceTransferInput = z.infer<typeof workspaceTransferInput>;

export type WorkspaceFileTransferService = {
  preview(input: WorkspaceTransferInput): Promise<{
    attachmentId: string;
    transferId: string;
    filename: string;
    mediaType: string;
    sizeBytes: number;
    sha256: string;
    status: "READY" | "UPLOADED";
  }>;
  approve(input: WorkspaceTransferInput & { actorId: string }): Promise<{
    attachmentId: string;
    transferId: string;
    filename: string;
    sha256: string;
    sizeBytes: number;
    status: "UPLOADED";
  }>;
};

export class WorkspaceTransferRefusedError extends Error {}

export function createWorkspaceFileTransferService(options: {
  store: HandoffAttachmentStore;
  broker: ComputerAttachmentBroker;
  connection: (input: {
    botId: string;
    actorId: string;
  }) => Promise<{ url: string; token?: string }>;
  auditStore: AuditStore;
  fetchImpl?: typeof fetch;
}): WorkspaceFileTransferService {
  async function owned(input: WorkspaceTransferInput) {
    const parsed = workspaceTransferInput.parse(input);
    const row = await options.store.ownedByRecipient(
      parsed.attachmentId,
      parsed.botId,
    );
    if (!row || row.state === "deleted") {
      throw new WorkspaceTransferRefusedError(
        "That attachment is not available to this Bot.",
      );
    }
    if (
      row.externalTransferId &&
      row.externalTransferId !== parsed.transferId
    ) {
      throw new WorkspaceTransferRefusedError(
        "That attachment is already bound to another ERP transfer.",
      );
    }
    if (row.state !== "copied" && row.state !== "transferred") {
      throw new WorkspaceTransferRefusedError(
        `That attachment cannot be transferred while it is ${row.state}.`,
      );
    }
    return { parsed, row };
  }

  return {
    async preview(input) {
      const { parsed, row } = await owned(input);
      return {
        attachmentId: row.id,
        transferId: parsed.transferId,
        filename: row.filename,
        mediaType: row.mediaType,
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
        status: row.state === "transferred" ? "UPLOADED" : "READY",
      };
    },
    async approve(input) {
      const { parsed, row } = await owned(input);
      if (row.state === "transferred") return success(row, parsed.transferId);

      let claimed: StoredHandoffAttachment;
      try {
        // Bind before the external side effect. A concurrent approval carrying another transfer id
        // loses this conditional update and therefore cannot upload the same bytes elsewhere.
        claimed = await options.store.claimTransfer(
          row.id,
          parsed.botId,
          parsed.transferId,
        );
      } catch {
        throw new WorkspaceTransferRefusedError(
          "That attachment was claimed by another ERP transfer.",
        );
      }

      const release = async () => {
        await options.store
          .releaseTransfer(claimed.id, parsed.botId, parsed.transferId)
          .catch(() => false);
      };
      let exported: ExportedAttachment;
      try {
        exported = await options.broker.read({
          botId: parsed.botId,
          path: claimed.path,
        });
      } catch {
        await release();
        throw new WorkspaceTransferRefusedError(
          "The verified attachment could not be read from this Bot's inbox.",
        );
      }
      if (
        exported.filename !== claimed.filename ||
        exported.mediaType !== claimed.mediaType ||
        exported.sizeBytes !== claimed.sizeBytes ||
        exported.sha256 !== claimed.sha256
      ) {
        await release();
        throw new WorkspaceTransferRefusedError(
          "The attachment no longer matches its verified handoff metadata.",
        );
      }

      let target: WorkspaceUploadTarget;
      try {
        const connection = await options.connection({
          botId: parsed.botId,
          actorId: input.actorId,
        });
        target = workspaceUploadTargetFromMcp(connection.url, connection.token);
      } catch {
        await release();
        throw new WorkspaceTransferRefusedError(
          "The ERP connector is not configured for governed binary uploads.",
        );
      }

      const response = await (options.fetchImpl ?? fetch)(
        `${target.origin}${target.pathFor(parsed.transferId)}`,
        {
          method: "PUT",
          redirect: "manual",
          headers: {
            authorization: `Bearer ${target.bearerToken}`,
            "content-type": claimed.mediaType,
            "content-length": String(claimed.sizeBytes),
          },
          body: new Uint8Array(exported.bytes),
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (!response.ok) {
        // These responses are definitive refusals: no successful upload is hidden behind them, so
        // a fresh ERP reservation may safely be bound. Timeouts, conflicts and server errors stay
        // bound because their external outcome may be unknown.
        if ([400, 401, 403, 404, 410, 422].includes(response.status)) {
          await release();
        }
        throw new WorkspaceTransferRefusedError(
          `The ERP upload returned ${response.status}.`,
        );
      }

      const transferred = await options.store.markTransferred(
        claimed.id,
        parsed.transferId,
      );
      await recordAuditEvent(options.auditStore, {
        eventType: "agent.attachment_transferred",
        targetType: "attachment",
        targetId: claimed.id,
        actorUserId: input.actorId,
        payload: {
          bot: parsed.botId,
          attachmentId: claimed.id,
          transferId: parsed.transferId,
          destination: target.id,
          sha256: claimed.sha256,
          sizeBytes: claimed.sizeBytes,
          status: "UPLOADED",
          approvedBy: input.actorId,
        },
      });
      return success(transferred, parsed.transferId);
    },
  };
}

function success(
  row: { id: string; filename: string; sha256: string; sizeBytes: number },
  transferId: string,
) {
  return {
    attachmentId: row.id,
    transferId,
    filename: row.filename,
    status: "UPLOADED" as const,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
  };
}
