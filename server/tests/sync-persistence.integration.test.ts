import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createSyncPersistence } from "../src/connectors/sync-persistence";
import { createDatabase } from "../src/db/client";
import { TEST_POOL } from "./support/database";
import { connectorInstances, credentials, documents } from "../src/db/schema";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const connectorIds: string[] = [];
const credentialIds: string[] = [];

afterEach(async () => {
  for (const connectorId of connectorIds.splice(0)) {
    await database
      .delete(connectorInstances)
      .where(eq(connectorInstances.id, connectorId));
  }
  for (const credentialId of credentialIds.splice(0)) {
    await database.delete(credentials).where(eq(credentials.id, credentialId));
  }
});

async function fixture() {
  const credentialId = randomUUID();
  const connectorId = randomUUID();
  await database.insert(credentials).values({
    id: credentialId,
    kind: "connector",
    provider: "test",
    encryptedValue: "test",
    keyId: "test",
    metadata: {},
  });
  await database.insert(connectorInstances).values({
    id: connectorId,
    type: "google_drive",
    credentialId,
    sourceMetadata: {},
  });
  connectorIds.push(connectorId);
  credentialIds.push(credentialId);
  return { connectorId, credentialId };
}

describe("sync persistence integration", () => {
  test("replays an upsert without duplicates, then deletes it with its cursor", async () => {
    const { connectorId } = await fixture();
    const persistence = createSyncPersistence(database, connectorId);
    const upsert = {
      kind: "upsert" as const,
      sourceId: "source-1",
      title: "Policy",
      canonicalUrl: "https://example.test/policy",
      contentHash: "v1",
      metadata: {},
      chunks: [
        { position: 0, content: "policy", embedding: Array(1536).fill(0) },
      ],
      acls: [{ principal: "group:finance", effect: "allow" as const }],
    };

    await persistence.persistBatch([upsert], "c1");
    await persistence.persistBatch([upsert], "c1");
    const rows = await database
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.connectorInstanceId, connectorId),
          eq(documents.sourceId, "source-1"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(await persistence.cursor()).toBe("c1");

    await persistence.persistBatch(
      [{ kind: "delete", sourceId: "source-1" }],
      "c2",
    );
    const documentId = rows[0]?.id;
    if (!documentId) throw new Error("Expected the upserted document.");
    expect(
      (
        await database
          .select()
          .from(documents)
          .where(eq(documents.id, documentId))
      )[0]?.deletedAt,
    ).toBeInstanceOf(Date);
    expect(await persistence.cursor()).toBe("c2");
  });
});
