import { describe, expect, test } from "bun:test";
import { createAttachmentTransferTool } from "../src/agents/attachment-transfer-tool";
import type { HandoffAttachmentStore } from "../src/agents/handoff-attachment-store";
import type { AuditStore } from "../src/audit";
import type { ComputerAttachmentBroker } from "../src/computer/attachments";
import { parseWorkspaceUploadTarget } from "../src/computer/upload-target";

const attachmentId = "22222222-2222-4222-8222-222222222222";
const transferId = "11111111-1111-4111-8111-111111111111";
const sha256 = "a".repeat(64);
const bytes = Buffer.from("%PDF-1.7 invoice");

function setup(owner = "erp") {
  const calls: { url?: string; init?: RequestInit; transferred?: unknown[] } = {
    transferred: [],
  };
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
      id === attachmentId && botId === "erp" ? row : null,
    markTransferred: async (...args: unknown[]) => {
      calls.transferred?.push(args);
      return {
        ...row,
        state: "transferred" as const,
        externalTransferId: String(args[1]),
      };
    },
  } as HandoffAttachmentStore;
  const broker = {
    read: async () => ({
      bytes,
      filename: row.filename,
      mediaType: row.mediaType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
    }),
  } as unknown as ComputerAttachmentBroker;
  const auditStore: AuditStore = { insert: async () => {} };
  const tool = createAttachmentTransferTool({
    from: {
      botId: owner,
      actorId: "user-1",
      runId: "run-1",
      threadId: "thread-1",
    },
    store,
    broker,
    target: parseWorkspaceUploadTarget("https://erp.test", "server-only-token"),
    auditStore,
    fetchImpl: async (url, init) => {
      calls.url = String(url);
      calls.init = init;
      return new Response('{"secret":"must not escape"}', { status: 200 });
    },
  });
  return { tool, calls };
}

describe("transfer_workspace_file", () => {
  test("uploads an owned attachment to the fixed target and returns sanitized metadata", async () => {
    const { tool, calls } = setup();
    const result = await tool.execute({
      destination: "netsfera-erp",
      transferId,
      attachmentId,
    });

    expect(calls.url).toBe(
      `https://erp.test/api/agent-transfers/${transferId}`,
    );
    expect(calls.init?.redirect).toBe("manual");
    expect(calls.init?.headers).toMatchObject({
      authorization: "Bearer server-only-token",
      "content-type": "application/pdf",
      "content-length": String(bytes.length),
    });
    expect(result).toContain('"status":"UPLOADED"');
    expect(result).not.toContain("secret");
    expect(calls.transferred).toEqual([[attachmentId, transferId]]);
  });

  test("refuses an attachment not owned by the current recipient", async () => {
    const { tool, calls } = setup("other");
    const result = await tool.execute({
      destination: "netsfera-erp",
      transferId,
      attachmentId,
    });
    expect(result).toContain("not available");
    expect(calls.url).toBeUndefined();
  });
});
