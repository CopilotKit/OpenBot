import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./core";

export const recorderConnectCodes = pgTable(
  "recorder_connect_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    via: text("via").$type<"web" | "desktop">().notNull(),
    /** Organization mode only: the minting request's organization session cookie, sealed with KEY_ENCRYPTION_KEY. */
    organizationSession: text("organization_session"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [index("recorder_connect_codes_user_idx").on(table.userId)],
);

export const recorderConnections = pgTable(
  "recorder_connections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    label: text("label").notNull(),
    via: text("via").$type<"web" | "desktop">().notNull(),
    extensionId: text("extension_id").notNull(),
    /** The connecting copy's install id for this OpenBot. */
    installId: text("install_id").notNull(),
    /** Organization mode only, copied from the connect code: re-verified against the authority. */
    organizationSession: text("organization_session"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("recorder_connections_user_idx").on(table.userId, table.createdAt),
    // One live connection per person and installed copy; connecting the same copy again revokes the older one.
    uniqueIndex("recorder_connections_live_install_idx")
      .on(table.userId, table.installId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);
