import { describe, expect, test } from "bun:test";
import { createWorkspaceFileTransferService } from "../src/agents/attachment-transfer-tool";
import type { HandoffAttachmentStore } from "../src/agents/handoff-attachment-store";
import type { AuditStore } from "../src/audit";
import type { ComputerAttachmentBroker } from "../src/computer/attachments";

const attachmentId = "22222222-2222-4222-8222-222222222222";
const transferId = "11111111-1111-4111-8111-111111111111";
const renewedTransferId = "33333333-3333-4333-8333-333333333333";
const sha256 = "a".repeat(64);
const bytes = Buffer.from("%PDF-1.7 invoice");

function setup(
  owner = "erp",
  behavior: { readFails?: boolean; uploadStatuses?: number[] } = {},
) {
  const calls: {
    reserved: unknown[];
    urls: string[];
    init?: RequestInit;
    claimed?: unknown[];
    released?: unknown[];
  } = { reserved: [], urls: [] };
  const reservationIds = new Map<string, string>();
  let row = {
    id: attachmentId,
    handoffId: "b".repeat(64),
    fromBotId: "collector",
    recipientBotId: "erp",
    path: `inbox/${"b".repeat(64)}/${attachmentId}/invoice.pdf`,
    filename: "invoice.pdf",
    mediaType: "application/pdf",
    sizeBytes: bytes.length,
    sha256,
    state: "copied" as const,
    externalTransferId: null,
    resultReference: null,
    expiresAt: new Date(Date.now() + 1000),
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const store = {
    ownedByRecipient: async (id: string, botId: string) =>
      id === attachmentId && botId === owner ? row : null,
    claimTransfer: async (...args: unknown[]) => {
      calls.claimed = args;
      row = {
        ...row,
        externalTransferId: String(args[2]),
        updatedAt: new Date(row.updatedAt.getTime() + 1_000),
      };
      return row;
    },
    releaseTransfer: async (...args: unknown[]) => {
      calls.released = args;
      row = {
        ...row,
        externalTransferId: null,
        updatedAt: new Date(row.updatedAt.getTime() + 1_000),
      };
      return true;
    },
    markTransferred: async (_id: string, externalTransferId: string) => {
      row = {
        ...row,
        state: "transferred" as const,
        externalTransferId,
      };
      return row;
    },
  } as HandoffAttachmentStore;
  const service = createWorkspaceFileTransferService({
    store,
    broker: {
      read: async () => {
        if (behavior.readFails) throw new Error("computer unavailable");
        return {
          bytes,
          filename: row.filename,
          mediaType: row.mediaType,
          sizeBytes: row.sizeBytes,
          sha256: row.sha256,
        };
      },
    } as unknown as ComputerAttachmentBroker,
    connection: async () => ({
      url: "https://erp.test/api/mcp",
      token: "encrypted-store-token",
    }),
    reserve: async (input) => {
      calls.reserved.push(input);
      let reservedId = reservationIds.get(input.idempotencyKey);
      if (!reservedId) {
        reservedId = reservationIds.size === 0 ? transferId : renewedTransferId;
        reservationIds.set(input.idempotencyKey, reservedId);
      }
      return { transferId: reservedId };
    },
    auditStore: { insert: async () => {} } as AuditStore,
    fetchImpl: async (url, init) => {
      calls.urls.push(String(url));
      calls.init = init;
      return new Response('{"secret":"must not escape"}', {
        status: behavior.uploadStatuses?.shift() ?? 200,
      });
    },
  });
  return { service, calls };
}

describe("approved workspace file transfer", () => {
  test("previews immutable server metadata without moving bytes", async () => {
    const { service, calls } = setup();
    expect(await service.preview({ botId: "erp", attachmentId })).toMatchObject(
      { filename: "invoice.pdf", sha256, status: "READY" },
    );
    expect(calls.urls).toEqual([]);
  });

  test("claims then uploads through the MCP connector principal", async () => {
    const { service, calls } = setup();
    const result = await service.approve({
      botId: "erp",
      actorId: "user-1",
      attachmentId,
    });

    expect(calls.reserved).toEqual([
      {
        botId: "erp",
        actorId: "user-1",
        filename: "invoice.pdf",
        contentType: "application/pdf",
        expectedBytes: bytes.length,
        sha256,
        idempotencyKey: expect.stringContaining(
          `openbot-workspace-transfer:${attachmentId}:`,
        ),
      },
    ]);
    expect(calls.claimed).toEqual([attachmentId, "erp", transferId]);
    expect(calls.urls).toEqual([
      `https://erp.test/api/agent-transfers/${transferId}`,
    ]);
    expect(calls.init?.headers).toMatchObject({
      authorization: "Bearer encrypted-store-token",
      "content-type": "application/pdf",
      "content-length": String(bytes.length),
    });
    expect(result.status).toBe("UPLOADED");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("refuses an attachment not owned by the approved Bot", async () => {
    const { service, calls } = setup("other");
    await expect(
      service.approve({
        botId: "erp",
        actorId: "user-1",
        attachmentId,
      }),
    ).rejects.toThrow("not available");
    expect(calls.urls).toEqual([]);
  });

  test("does not reserve or claim when the verified bytes cannot be read", async () => {
    const { service, calls } = setup("erp", { readFails: true });
    await expect(
      service.approve({
        botId: "erp",
        actorId: "user-1",
        attachmentId,
      }),
    ).rejects.toThrow("could not be read");
    expect(calls.reserved).toEqual([]);
    expect(calls.claimed).toBeUndefined();
    expect(calls.released).toBeUndefined();
  });

  test("releases a definitively rejected reservation but keeps uncertain failures bound", async () => {
    const rejected = setup("erp", { uploadStatuses: [410] });
    await expect(
      rejected.service.approve({
        botId: "erp",
        actorId: "user-1",
        attachmentId,
      }),
    ).rejects.toThrow("410");
    expect(rejected.calls.released).toEqual([attachmentId, "erp", transferId]);

    const uncertain = setup("erp", { uploadStatuses: [500] });
    await expect(
      uncertain.service.approve({
        botId: "erp",
        actorId: "user-1",
        attachmentId,
      }),
    ).rejects.toThrow("500");
    expect(uncertain.calls.released).toBeUndefined();
  });

  test("retries an uncertain upload on its bound reservation without reserving again", async () => {
    const { service, calls } = setup("erp", { uploadStatuses: [500, 200] });
    await expect(
      service.approve({ botId: "erp", actorId: "user-1", attachmentId }),
    ).rejects.toThrow("500");

    const result = await service.approve({
      botId: "erp",
      actorId: "user-1",
      attachmentId,
    });

    expect(result.transferId).toBe(transferId);
    expect(calls.reserved).toHaveLength(1);
    expect(calls.urls).toEqual([
      `https://erp.test/api/agent-transfers/${transferId}`,
      `https://erp.test/api/agent-transfers/${transferId}`,
    ]);
  });

  test("uses a fresh idempotency key after a terminal reservation rejection", async () => {
    const { service, calls } = setup("erp", { uploadStatuses: [410, 200] });
    await expect(
      service.approve({ botId: "erp", actorId: "user-1", attachmentId }),
    ).rejects.toThrow("410");

    const result = await service.approve({
      botId: "erp",
      actorId: "user-1",
      attachmentId,
    });

    expect(result.transferId).toBe(renewedTransferId);
    expect(calls.reserved).toHaveLength(2);
    expect(
      (calls.reserved[0] as { idempotencyKey: string }).idempotencyKey,
    ).not.toBe(
      (calls.reserved[1] as { idempotencyKey: string }).idempotencyKey,
    );
  });
});
