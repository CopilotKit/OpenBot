import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  DemonstrationAction,
  DemonstrationDraft,
} from "../../demonstrations/types";
import { agents, bytea, users } from "./core";
import { jsonb } from "./json";
export const demonstrations = pgTable(
  "demonstrations",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status")
      .$type<"recording" | "stopped" | "drafted" | "published">()
      .notNull()
      .default("recording"),
    source: text("source")
      .$type<"computer" | "extension">()
      .notNull()
      .default("computer"),
    actions: jsonb("actions")
      .$type<DemonstrationAction[]>()
      .notNull()
      .default([]),
    /** Steps an extension recording holds in demonstration_steps while it records; 0 for cloud recordings. */
    stepCount: integer("step_count").notNull().default(0),
    draft: jsonb("draft").$type<DemonstrationDraft>(),
    skillSlug: text("skill_slug"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("demonstrations_owner_idx").on(table.ownerUserId, table.createdAt),
    // The cloud browser is one per Bot, so one recording per Bot at a time, across people.
    uniqueIndex("demonstrations_active_bot_idx")
      .on(table.botId)
      .where(
        sql`${table.status} = 'recording' and ${table.source} = 'computer'`,
      ),
    // An extension recording runs in the person's own browser, so it holds only that person's slot for that Bot.
    uniqueIndex("demonstrations_active_extension_idx")
      .on(table.ownerUserId, table.botId)
      .where(
        sql`${table.status} = 'recording' and ${table.source} = 'extension'`,
      ),
  ],
);

export const demonstrationTrajectories = pgTable(
  "demonstration_trajectories",
  {
    trajectoryId: uuid("trajectory_id").primaryKey(),
    // No .references() here: drizzle's generated name for this one,
    // demonstration_trajectories_demonstration_id_demonstrations_id_fk, is 64 characters and Postgres
    // truncates identifiers past 63, so the stored name would never match the snapshot. Named below.
    demonstrationId: text("demonstration_id").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Null while the extension may still send queued events; set when its outbox for this trajectory is empty. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** The Learning container the last pass assigned; null when none was. */
    learningContainerId: text("learning_container_id"),
    /** What the last pass found: null before the first pass. */
    learningState: text("learning_state").$type<
      | "assigned"
      | "unassigned"
      | "missing"
      | "learning-off"
      | "unverified"
      | "unjoined"
    >(),
  },
  (table) => [
    index("demonstration_trajectories_demonstration_idx").on(
      table.demonstrationId,
    ),
    foreignKey({
      name: "demonstration_trajectories_demonstration_fk",
      columns: [table.demonstrationId],
      foreignColumns: [demonstrations.id],
    }).onDelete("cascade"),
    check(
      "demonstration_trajectories_learning_state_check",
      sql`${table.learningState} IS NULL OR ${table.learningState} IN ('assigned', 'unassigned', 'missing', 'learning-off', 'unverified', 'unjoined')`,
    ),
  ],
);

/**
 * An extension recording's steps while it records, one row each; folded into demonstrations.actions
 * at Stop and deleted. `jsonb` here is the one from `./json` (see `schema/json.ts`): drizzle's own
 * `jsonb` would store a JSON string and break `jsonb_agg` at Stop.
 */
export const demonstrationSteps = pgTable(
  "demonstration_steps",
  {
    demonstrationId: text("demonstration_id")
      .notNull()
      .references(() => demonstrations.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    action: jsonb("action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.demonstrationId, table.index] })],
);

export const demonstrationMedia = pgTable(
  "demonstration_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    demonstrationId: text("demonstration_id")
      .notNull()
      .references(() => demonstrations.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"screen" | "audio" | "network">().notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull().default(0),
    chunkCount: integer("chunk_count"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("demonstration_media_demonstration_idx").on(table.demonstrationId),
    check(
      "demonstration_media_kind_check",
      sql`${table.kind} IN ('screen', 'audio', 'network')`,
    ),
  ],
);

export const demonstrationMediaChunks = pgTable(
  "demonstration_media_chunks",
  {
    mediaId: uuid("media_id")
      .notNull()
      .references(() => demonstrationMedia.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    bytes: bytea("bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.mediaId, table.index] })],
);
