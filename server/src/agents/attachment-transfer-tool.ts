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
  attachmentId: uuid,
});
export type WorkspaceTransferInput = z.infer<typeof workspaceTransferInput>;

export type WorkspaceFileTransferService = {
  preview(input: WorkspaceTransferInput): Promise<{
    attachmentId: string;
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
  reserve: (input: {
    botId: string;
    actorId: string;
    filename: string;
    contentType: string;
    expectedBytes: number;
    sha256: string;
    idempotencyKey: string;
  }) => Promise<{ transferId: string }>;
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
      !uuid.safeParse(row.externalTransferId).success
    ) {
      throw new WorkspaceTransferRefusedError(
        "That attachment has an invalid ERP transfer binding.",
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
      const { row } = await owned(input);
      return {
        attachmentId: row.id,
        filename: row.filename,
        mediaType: row.mediaType,
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
        status: row.state === "transferred" ? "UPLOADED" : "READY",
      };
    },
    async approve(input) {
      const { parsed, row } = await owned(input);
      if (row.state === "transferred" && row.externalTransferId) {
        return success(row, row.externalTransferId);
      }

      let exported: ExportedAttachment;
      try {
        exported = await options.broker.read({
          botId: parsed.botId,
          path: row.path,
        });
      } catch {
        throw new WorkspaceTransferRefusedError(
          "The verified attachment could not be read from this Bot's inbox.",
        );
      }
      if (
        exported.filename !== row.filename ||
        exported.mediaType !== row.mediaType ||
        exported.sizeBytes !== row.sizeBytes ||
        exported.sha256 !== row.sha256
      ) {
        throw new WorkspaceTransferRefusedError(
          "The attachment no longer matches its verified handoff metadata.",
        );
      }

      let transferId: string;
      let claimed: StoredHandoffAttachment;
      if (row.externalTransferId) {
        // A timeout or 5xx leaves the external outcome unknown. Keep using the durable binding: the
        // ERP accepts an identical replay whether the first PUT stopped before or after committing.
        transferId = uuid.parse(row.externalTransferId);
        claimed = row;
      } else {
        try {
          const reserved = await options.reserve({
            botId: parsed.botId,
            actorId: input.actorId,
            filename: row.filename,
            contentType: row.mediaType,
            expectedBytes: row.sizeBytes,
            sha256: row.sha256,
            // `updatedAt` changes when a definitive rejection releases a binding. That gives the
            // next attempt a fresh ERP reservation while retries of the same attempt stay idempotent.
            idempotencyKey: `openbot-workspace-transfer:${row.id}:${row.updatedAt.getTime()}`,
          });
          transferId = uuid.parse(reserved.transferId);
        } catch {
          throw new WorkspaceTransferRefusedError(
            "The ERP could not reserve an upload for this verified attachment.",
          );
        }

        try {
          // Bind before the external side effect. A concurrent approval carrying another transfer id
          // loses this conditional update and therefore cannot upload the same bytes elsewhere.
          claimed = await options.store.claimTransfer(
            row.id,
            parsed.botId,
            transferId,
          );
        } catch {
          throw new WorkspaceTransferRefusedError(
            "That attachment was claimed by another ERP transfer.",
          );
        }
      }

      const release = async () => {
        await options.store
          .releaseTransfer(claimed.id, parsed.botId, transferId)
          .catch(() => false);
      };

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
        `${target.origin}${target.pathFor(transferId)}`,
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
        if ([400, 401, 403, 404, 409, 410, 422].includes(response.status)) {
          await release();
        }
        throw new WorkspaceTransferRefusedError(
          `The ERP upload returned ${response.status}.`,
        );
      }

      const transferred = await options.store.markTransferred(
        claimed.id,
        transferId,
      );
      await recordAuditEvent(options.auditStore, {
        eventType: "agent.attachment_transferred",
        targetType: "attachment",
        targetId: claimed.id,
        actorUserId: input.actorId,
        payload: {
          bot: parsed.botId,
          attachmentId: claimed.id,
          transferId,
          destination: target.id,
          sha256: claimed.sha256,
          sizeBytes: claimed.sizeBytes,
          status: "UPLOADED",
          approvedBy: input.actorId,
        },
      });
      return success(transferred, transferId);
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
