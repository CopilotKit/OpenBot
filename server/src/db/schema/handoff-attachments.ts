import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./core";

export const handoffAttachmentState = pgEnum("handoff_attachment_state", [
  "copied",
  "transferred",
  "failed",
  "rejected",
  "expired",
  "deleted",
]);

export const handoffAttachments = pgTable(
  "handoff_attachments",
  {
    id: text("id").primaryKey(),
    handoffId: text("handoff_id").notNull(),
    fromBotId: text("from_bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    recipientBotId: text("recipient_bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    state: handoffAttachmentState("state").notNull().default("copied"),
    externalTransferId: text("external_transfer_id"),
    resultReference: text("result_reference"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("handoff_attachments_handoff_hash_recipient_uidx").on(
      table.handoffId,
      table.sha256,
      table.recipientBotId,
    ),
    index("handoff_attachments_state_expiry_idx").on(
      table.state,
      table.expiresAt,
    ),
  ],
);
