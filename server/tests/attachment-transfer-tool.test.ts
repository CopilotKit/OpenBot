import { describe, expect, test } from "bun:test";
import { createWorkspaceFileTransferService } from "../src/agents/attachment-transfer-tool";
import type { HandoffAttachmentStore } from "../src/agents/handoff-attachment-store";
import type { AuditStore } from "../src/audit";
import type { ComputerAttachmentBroker } from "../src/computer/attachments";

const attachmentId = "22222222-2222-4222-8222-222222222222";
const transferId = "11111111-1111-4111-8111-111111111111";
const sha256 = "a".repeat(64);
const bytes = Buffer.from("%PDF-1.7 invoice");

function setup(owner = "erp") {
  const calls: { url?: string; init?: RequestInit; claimed?: unknown[] } = {};
  const row = {
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
      return { ...row, externalTransferId: String(args[2]) };
    },
    markTransferred: async () => ({
      ...row,
      state: "transferred" as const,
      externalTransferId: transferId,
    }),
  } as HandoffAttachmentStore;
  const service = createWorkspaceFileTransferService({
    store,
    broker: {
      read: async () => ({
        bytes,
        filename: row.filename,
        mediaType: row.mediaType,
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
      }),
    } as unknown as ComputerAttachmentBroker,
    connection: async () => ({
      url: "https://erp.test/api/mcp",
      token: "encrypted-store-token",
    }),
    auditStore: { insert: async () => {} } as AuditStore,
    fetchImpl: async (url, init) => {
      calls.url = String(url);
      calls.init = init;
      return new Response('{"secret":"must not escape"}', { status: 200 });
    },
  });
  return { service, calls };
}

describe("approved workspace file transfer", () => {
  test("previews immutable server metadata without moving bytes", async () => {
    const { service, calls } = setup();
    expect(
      await service.preview({ botId: "erp", attachmentId, transferId }),
    ).toMatchObject({ filename: "invoice.pdf", sha256, status: "READY" });
    expect(calls.url).toBeUndefined();
  });

  test("claims then uploads through the MCP connector principal", async () => {
    const { service, calls } = setup();
    const result = await service.approve({
      botId: "erp",
      actorId: "user-1",
      transferId,
      attachmentId,
    });

    expect(calls.claimed).toEqual([attachmentId, "erp", transferId]);
    expect(calls.url).toBe(
      `https://erp.test/api/agent-transfers/${transferId}`,
    );
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
        transferId,
        attachmentId,
      }),
    ).rejects.toThrow("not available");
    expect(calls.url).toBeUndefined();
  });
});
