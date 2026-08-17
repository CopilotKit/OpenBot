import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  chunks,
  connectorCursors,
  documentAcls,
  documents,
  syncRuns,
} from "../db/schema";
import type { ConnectorChange } from "./contract";

export function createSyncPersistence(
  database: Database,
  connectorInstanceId: string,
) {
  return {
    async persistBatch(changes: ConnectorChange[], cursor: string | null) {
      await database.transaction(async (transaction) => {
        for (const change of changes) {
          if (change.kind === "delete") {
            await transaction
              .update(documents)
              .set({ deletedAt: new Date(), updatedAt: new Date() })
              .where(
                and(
                  eq(documents.connectorInstanceId, connectorInstanceId),
                  eq(documents.sourceId, change.sourceId),
                ),
              );
            continue;
          }
          const [document] = await transaction
            .insert(documents)
            .values({
              connectorInstanceId,
              sourceId: change.sourceId,
              title: change.title,
              canonicalUrl: change.canonicalUrl,
              metadata: change.metadata,
              contentHash: change.contentHash,
              deletedAt: null,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [documents.connectorInstanceId, documents.sourceId],
              set: {
                title: change.title,
                canonicalUrl: change.canonicalUrl,
                metadata: change.metadata,
                contentHash: change.contentHash,
                deletedAt: null,
                updatedAt: new Date(),
              },
            })
            .returning({ id: documents.id });
          if (!document)
            throw new Error("Document upsert did not return an ID.");
          await transaction
            .delete(chunks)
            .where(eq(chunks.documentId, document.id));
          await transaction
            .delete(documentAcls)
            .where(eq(documentAcls.documentId, document.id));
          if (change.chunks.length) {
            await transaction.insert(chunks).values(
              change.chunks.map((chunk) => ({
                documentId: document.id,
                position: chunk.position,
                content: chunk.content,
                embedding: chunk.embedding,
              })),
            );
          }
          if (change.acls.length) {
            await transaction
              .insert(documentAcls)
              .values(
                change.acls.map((acl) => ({ documentId: document.id, ...acl })),
              );
          }
        }
        await transaction.insert(syncRuns).values({
          connectorInstanceId,
          status: "succeeded",
          completedAt: new Date(),
          stats: { changes: changes.length },
        });
        if (cursor !== null) {
          await transaction
            .insert(connectorCursors)
            .values({ connectorInstanceId, cursor, updatedAt: new Date() })
            .onConflictDoUpdate({
              target: connectorCursors.connectorInstanceId,
              set: { cursor, updatedAt: new Date() },
            });
        }
      });
    },
    async cursor() {
      const [record] = await database
        .select({ cursor: connectorCursors.cursor })
        .from(connectorCursors)
        .where(eq(connectorCursors.connectorInstanceId, connectorInstanceId));
      return record?.cursor ?? null;
    },
  };
}
