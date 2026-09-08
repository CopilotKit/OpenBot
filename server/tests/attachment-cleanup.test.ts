import { describe, expect, test } from "bun:test";
import { createAttachmentCleanup } from "../src/agents/attachment-cleanup";
import type { HandoffAttachmentStore } from "../src/agents/handoff-attachment-store";
import type { ComputerAttachmentBroker } from "../src/computer/attachments";

const row = {
  id: "22222222-2222-4222-8222-222222222222",
  handoffId: "b".repeat(64),
  fromBotId: "collector",
  recipientBotId: "erp",
  path: "inbox/handoff/id/invoice.pdf",
  filename: "invoice.pdf",
  mediaType: "application/pdf",
  sizeBytes: 42,
  sha256: "a".repeat(64),
  state: "copied" as const,
  externalTransferId: null,
  resultReference: null,
  expiresAt: new Date(0),
  deletedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function setup(dryRun: boolean) {
  const removed: unknown[] = [];
  const marked: unknown[] = [];
  const cleanup = createAttachmentCleanup({
    store: {
      expired: async () => [row],
      markDeleted: async (...args: unknown[]) => {
        marked.push(args);
        return { ...row, state: "deleted" as const };
      },
    } as HandoffAttachmentStore,
    broker: {
      remove: async (input: unknown) => {
        removed.push(input);
        return { deleted: true };
      },
    } as ComputerAttachmentBroker,
    dryRun,
  });
  return { cleanup, removed, marked };
}

describe("expired handoff attachment cleanup", () => {
  test("removes the exact recipient copy and keeps deleted metadata", async () => {
    const built = setup(false);
    expect(await built.cleanup.sweep()).toEqual({ found: 1, deleted: 1 });
    expect(built.removed).toHaveLength(1);
    expect(built.marked).toEqual([[row.id, "expired"]]);
  });

  test("dry-run reports without deleting", async () => {
    const built = setup(true);
    expect(await built.cleanup.sweep()).toEqual({ found: 1, deleted: 0 });
    expect(built.removed).toHaveLength(0);
    expect(built.marked).toHaveLength(0);
  });
});
