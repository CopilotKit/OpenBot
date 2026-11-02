import type {
  RecorderActivity,
  RecorderConnectVia,
} from "@openbot/shared/recorder-api";
import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./core";

export const recorderConnectCodes = pgTable(
  "recorder_connect_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    via: text("via").$type<RecorderConnectVia>().notNull(),
    /** Organization mode only: the minting request's organization session cookie, sealed with KEY_ENCRYPTION_KEY. The
     * code is deleted when it is used and once it has expired, and this copy with it. */
    organizationSession: text("organization_session"),
    /** When that cookie itself expires, which the connection made from this code keeps (connections.ts). */
    organizationSessionExpiresAt: timestamp("organization_session_expires_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
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
    via: text("via").$type<RecorderConnectVia>().notNull(),
    extensionId: text("extension_id").notNull(),
    /** The connecting copy's install id for this OpenBot. */
    installId: text("install_id").notNull(),
    /** Organization mode only, copied from the connect code: re-verified against the authority. Cleared on revoke. */
    organizationSession: text("organization_session"),
    /**
     * When the organization session cookie that copy was taken from expires: the connection ends then, and the copy with
     * it, since it must not outlive the cookie. Null for a connection made before this was kept, and once revoked.
     */
    organizationSessionExpiresAt: timestamp("organization_session_expires_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /**
     * What this connection's Recorder last said it was doing (`POST /api/recorder/activity`), and when that arrived on
     * this server: the Browser button's red dot, wherever the person records. Only the latest is kept, here rather than
     * in one server's memory, so every replica answers the same. Null until the Recorder first says.
     */
    activity: jsonb("activity").$type<RecorderActivity>(),
    activityAt: timestamp("activity_at", { withTimezone: true }),
  },
  (table) => [
    index("recorder_connections_user_idx").on(table.userId, table.createdAt),
    // One live connection per person and installed copy; connecting the same copy again revokes the older one.
    uniqueIndex("recorder_connections_live_install_idx")
      .on(table.userId, table.installId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

/**
 * Which person a Recorder trajectory belongs to, written by the capture pass's gate and read by its Learning space
 * selector, which joins it to that person's own Learning space. Nothing recorded is kept here: the trajectory itself
 * lives in Intelligence. A binding goes with its person.
 */
export const recorderTrajectoryBindings = pgTable(
  "recorder_trajectory_bindings",
  {
    trajectoryId: uuid("trajectory_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("recorder_trajectory_bindings_user_idx").on(table.userId)],
);
