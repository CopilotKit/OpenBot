import { afterEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { createHandoffAttachmentStore } from "../src/agents/handoff-attachment-store";
import { createDatabase } from "../src/db/client";
import { agents, handoffAttachments } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const store = createHandoffAttachmentStore(database);
const botIds: string[] = [];

async function bots() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ids = {
    collector: `attachment-collector-${suffix}`,
    erp: `attachment-erp-${suffix}`,
    other: `attachment-other-${suffix}`,
  };
  botIds.push(...Object.values(ids));
  await database.insert(agents).values(
    Object.values(ids).map((id) => ({
      id,
      name: id,
      type: "built_in" as const,
      configuration: {},
    })),
  );
  return ids;
}

afterEach(async () => {
  if (botIds.length === 0) return;
  await database
    .delete(handoffAttachments)
    .where(inArray(handoffAttachments.fromBotId, botIds));
  await database.delete(agents).where(inArray(agents.id, botIds.splice(0)));
});

describe("handoff attachment metadata", () => {
  test("a recipient can resolve only its own copied attachment", async () => {
    const ids = await bots();
    const attachment = {
      id: crypto.randomUUID(),
      filename: "invoice.pdf",
      mediaType: "application/pdf",
      sizeBytes: 1234,
      sha256: "a".repeat(64),
      path: `inbox/${"b".repeat(64)}/attachment/invoice.pdf`,
    };

    await store.recordBatch({
      handoffId: "b".repeat(64),
      fromBotId: ids.collector,
      toBotId: ids.erp,
      attachments: [attachment],
    });

    expect(await store.ownedByRecipient(attachment.id, ids.erp)).toMatchObject({
      sha256: attachment.sha256,
      state: "copied",
    });
    expect(await store.ownedByRecipient(attachment.id, ids.other)).toBeNull();
    expect(
      await store.forHandoff("b".repeat(64), ids.collector, ids.erp),
    ).toHaveLength(1);
    expect(
      await store.forHandoff("b".repeat(64), ids.other, ids.erp),
    ).toHaveLength(0);
  });

  test("state changes cannot revive a deleted attachment", async () => {
    const ids = await bots();
    const id = crypto.randomUUID();
    await store.recordBatch({
      handoffId: "c".repeat(64),
      fromBotId: ids.collector,
      toBotId: ids.erp,
      attachments: [
        {
          id,
          filename: "invoice.pdf",
          mediaType: "application/pdf",
          sizeBytes: 42,
          sha256: "d".repeat(64),
          path: `inbox/${"c".repeat(64)}/${id}/invoice.pdf`,
        },
      ],
    });

    await store.markDeleted(id, "ingested");
    await expect(store.markTransferred(id, "erp-transfer")).rejects.toThrow(
      "stale attachment transition",
    );
  });

  test("binds one attachment to only one external transfer before bytes leave", async () => {
    const ids = await bots();
    const id = crypto.randomUUID();
    await store.recordBatch({
      handoffId: "f".repeat(64),
      fromBotId: ids.collector,
      toBotId: ids.erp,
      attachments: [
        {
          id,
          filename: "invoice.pdf",
          mediaType: "application/pdf",
          sizeBytes: 42,
          sha256: "f".repeat(64),
          path: `inbox/${"f".repeat(64)}/${id}/invoice.pdf`,
        },
      ],
    });
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();

    const results = await Promise.allSettled([
      store.claimTransfer(id, ids.erp, first),
      store.claimTransfer(id, ids.erp, second),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    const row = await store.ownedByRecipient(id, ids.erp);
    expect([first, second]).toContain(row?.externalTransferId);
    expect(
      await store.releaseTransfer(
        id,
        ids.erp,
        row?.externalTransferId ?? "missing",
      ),
    ).toBe(true);
    expect(
      (await store.ownedByRecipient(id, ids.erp))?.externalTransferId,
    ).toBeNull();
  });

  test("only one concurrent approval can claim the same idempotent transfer", async () => {
    const ids = await bots();
    const id = crypto.randomUUID();
    await store.recordBatch({
      handoffId: "a".repeat(64),
      fromBotId: ids.collector,
      toBotId: ids.erp,
      attachments: [
        {
          id,
          filename: "invoice.pdf",
          mediaType: "application/pdf",
          sizeBytes: 42,
          sha256: "a".repeat(64),
          path: `inbox/${"a".repeat(64)}/${id}/invoice.pdf`,
        },
      ],
    });
    const sameTransfer = crypto.randomUUID();

    const results = await Promise.allSettled([
      store.claimTransfer(id, ids.erp, sameTransfer),
      store.claimTransfer(id, ids.erp, sameTransfer),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
  });
});
