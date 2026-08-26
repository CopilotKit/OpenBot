/**
 * The one piece of state the inbox owns: which trail rows a person has marked handled.
 */

import { eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { attentionResolutions, auditEvents } from "../db/schema";

export type AttentionResolution = {
  auditEventId: string;
  resolvedBy: string;
  resolvedAt: string;
};

export type AttentionStore = {
  /** The resolved ids among these, for subtracting from the view. */
  resolvedAmong(eventIds: string[]): Promise<Set<string>>;
  /** The trail row itself, so a resolve can check what it is resolving. */
  event(eventId: string): Promise<{
    id: string;
    eventType: string;
    targetType: string;
    targetId: string | null;
    payload: Record<string, unknown>;
  } | null>;
  /**
   * Mark handled. First writer wins by unique index — not by check-then-write — so two replicas
   * cannot both believe they resolved it. Returns the resolution that stands, and whether this call
   * is the one that wrote it.
   */
  resolve(
    eventId: string,
    userId: string,
  ): Promise<AttentionResolution & { alreadyResolved: boolean }>;
};

export function createAttentionStore(database: Database): AttentionStore {
  return {
    resolvedAmong: async (eventIds) => {
      if (eventIds.length === 0) return new Set();
      const rows = await database
        .select({ auditEventId: attentionResolutions.auditEventId })
        .from(attentionResolutions)
        .where(inArray(attentionResolutions.auditEventId, eventIds));
      return new Set(rows.map((row) => row.auditEventId));
    },

    event: async (eventId) => {
      const rows = await database
        .select({
          id: auditEvents.id,
          eventType: auditEvents.eventType,
          targetType: auditEvents.targetType,
          targetId: auditEvents.targetId,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(eq(auditEvents.id, eventId))
        .limit(1);
      const row = rows[0];
      return row
        ? { ...row, payload: row.payload as Record<string, unknown> }
        : null;
    },

    resolve: async (eventId, userId) => {
      const inserted = await database
        .insert(attentionResolutions)
        .values({ auditEventId: eventId, resolvedBy: userId })
        .onConflictDoNothing({ target: attentionResolutions.auditEventId })
        .returning({
          auditEventId: attentionResolutions.auditEventId,
          resolvedBy: attentionResolutions.resolvedBy,
          resolvedAt: attentionResolutions.resolvedAt,
        });
      const row = inserted[0];
      if (row) {
        return {
          auditEventId: row.auditEventId,
          resolvedBy: row.resolvedBy,
          resolvedAt: row.resolvedAt.toISOString(),
          alreadyResolved: false,
        };
      }
      // The conflict path: somebody got there first. Read back who, which is the answer the second
      // presser actually wants.
      const standing = await database
        .select()
        .from(attentionResolutions)
        .where(eq(attentionResolutions.auditEventId, eventId))
        .limit(1);
      const existing = standing[0];
      if (!existing) {
        // Conflict on insert and absent on read means a concurrent resolve was rolled back between
        // the two statements. Vanishingly rare; the honest report is a retryable failure.
        throw new Error("The resolution could not be read back. Try again.");
      }
      return {
        auditEventId: existing.auditEventId,
        resolvedBy: existing.resolvedBy,
        resolvedAt: existing.resolvedAt.toISOString(),
        alreadyResolved: true,
      };
    },
  };
}
