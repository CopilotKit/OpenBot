import { and, eq, inArray, lte } from "drizzle-orm";
import type { HandoffAttachment } from "../computer/attachments";
import type { Database } from "../db/client";
import { handoffAttachments } from "../db/schema";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const transitionable = [
  "copied",
  "transferred",
  "failed",
  "rejected",
  "expired",
] as const;

export type StoredHandoffAttachment = typeof handoffAttachments.$inferSelect;

export type HandoffAttachmentStore = {
  recordBatch(input: {
    handoffId: string;
    fromBotId: string;
    toBotId: string;
    attachments: HandoffAttachment[];
    expiresAt?: Date;
  }): Promise<StoredHandoffAttachment[]>;
  forHandoff(
    handoffId: string,
    recipientBotId: string,
  ): Promise<StoredHandoffAttachment[]>;
  ownedByRecipient(
    id: string,
    recipientBotId: string,
  ): Promise<StoredHandoffAttachment | null>;
  markTransferred(
    id: string,
    externalTransferId: string,
    resultReference?: string,
  ): Promise<StoredHandoffAttachment>;
  markDeleted(
    id: string,
    resultReference?: string,
  ): Promise<StoredHandoffAttachment>;
  expired(now?: Date): Promise<StoredHandoffAttachment[]>;
};

export function createHandoffAttachmentStore(
  database: Database,
): HandoffAttachmentStore {
  async function oneOrStale(rows: StoredHandoffAttachment[]) {
    const row = rows[0];
    if (!row) throw new Error("stale attachment transition");
    return row;
  }

  return {
    async recordBatch(input) {
      if (input.attachments.length === 0) return [];
      const expiresAt = input.expiresAt ?? new Date(Date.now() + RETENTION_MS);
      return database
        .insert(handoffAttachments)
        .values(
          input.attachments.map((attachment) => ({
            ...attachment,
            handoffId: input.handoffId,
            fromBotId: input.fromBotId,
            recipientBotId: input.toBotId,
            expiresAt,
          })),
        )
        .onConflictDoNothing()
        .returning();
    },
    async forHandoff(handoffId, recipientBotId) {
      return database
        .select()
        .from(handoffAttachments)
        .where(
          and(
            eq(handoffAttachments.handoffId, handoffId),
            eq(handoffAttachments.recipientBotId, recipientBotId),
          ),
        );
    },
    async ownedByRecipient(id, recipientBotId) {
      const [row] = await database
        .select()
        .from(handoffAttachments)
        .where(
          and(
            eq(handoffAttachments.id, id),
            eq(handoffAttachments.recipientBotId, recipientBotId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async markTransferred(id, externalTransferId, resultReference) {
      return oneOrStale(
        await database
          .update(handoffAttachments)
          .set({
            state: "transferred",
            externalTransferId,
            ...(resultReference ? { resultReference } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(handoffAttachments.id, id),
              eq(handoffAttachments.state, "copied"),
            ),
          )
          .returning(),
      );
    },
    async markDeleted(id, resultReference) {
      return oneOrStale(
        await database
          .update(handoffAttachments)
          .set({
            state: "deleted",
            deletedAt: new Date(),
            ...(resultReference ? { resultReference } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(handoffAttachments.id, id),
              inArray(handoffAttachments.state, [...transitionable]),
            ),
          )
          .returning(),
      );
    },
    async expired(now = new Date()) {
      return database
        .select()
        .from(handoffAttachments)
        .where(
          and(
            eq(handoffAttachments.state, "copied"),
            lte(handoffAttachments.expiresAt, now),
          ),
        );
    },
  };
}
