import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * A trail row somebody has marked handled.
 *
 * The attention inbox is a view over the audit trail — refusals and stalls are already recorded
 * there, transactionally, by the gateway and the stall guard. What the trail cannot say is that a
 * person has dealt with one, because the trail is append-only and must stay that way. So resolution
 * is state ABOUT a trail row, held beside it: the row itself is never touched.
 *
 * Ids by value, no foreign keys, for the trail's own reason (see `actorUserId` on `audit_events`):
 * a cascade against an append-only table is an update the trigger refuses, and a person who had
 * ever resolved anything could otherwise never be deleted.
 */
export const attentionResolutions = pgTable(
  "attention_resolutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    auditEventId: uuid("audit_event_id").notNull(),
    resolvedBy: text("resolved_by").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * One resolution per trail row, enforced where two replicas cannot disagree about it. Two
     * people pressing Resolve at once is not a race to be lost: the second insert conflicts, and
     * the caller reads back who got there first.
     */
    uniqueIndex("attention_resolutions_event_idx").on(table.auditEventId),
  ],
);
