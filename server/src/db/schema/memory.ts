import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { MemoryRecord, MemorySource } from "../../memory/types";
import { agents, users } from "./core";
import { jsonb } from "./json";

export const memorySources = pgTable(
  "memory_sources",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toolRef: text("tool_ref").notNull(),
    title: text("title").notNull(),
    args: jsonb("args").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    syncStatus: text("sync_status")
      .$type<MemorySource["syncStatus"]>()
      .notNull()
      .default("idle"),
    syncError: text("sync_error"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("memory_sources_owner_idx").on(table.ownerUserId),
    index("memory_sources_due_idx").on(table.enabled, table.nextSyncAt),
  ],
);
export const personalMemories = pgTable(
  "personal_memories",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceId: text("source_id").references(() => memorySources.id, {
      onDelete: "cascade",
    }),
    externalId: text("external_id"),
    importDigest: text("import_digest"),
    content: text("content").notNull(),
    provenance: text("provenance").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    reviewState: text("review_state")
      .$type<MemoryRecord["reviewState"]>()
      .notNull()
      .default("unreviewed"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /**
     * Who formed it: the person, a source import, or a Bot that observed it. A Bot-formed memory is
     * delivered only to the Bot that formed it, and only while that Bot still holds the app it
     * was read from (`source_ref`), so revoking the app withdraws the memory with it.
     */
    formedBy: text("formed_by")
      .$type<MemoryRecord["formedBy"]>()
      .notNull()
      .default("person"),
    formedByAgentId: text("formed_by_agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    sourceApp: text("source_app"),
    sourceRef: text("source_ref"),
    sourceLink: text("source_link"),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("personal_memories_owner_idx").on(table.ownerUserId, table.enabled),
    index("personal_memories_formed_idx").on(
      table.ownerUserId,
      table.formedByAgentId,
    ),
    uniqueIndex("personal_memories_import_idx").on(
      table.sourceId,
      table.externalId,
    ),
    // One Bot-formed fact per person, Bot, and content: two runs of the same Bot forming the
    // same fact at once store it once, which a read-then-insert cannot promise. A second Bot
    // forming the same fact keeps its own row so its readback can see it.
    uniqueIndex("personal_memories_formed_digest_idx")
      .on(table.ownerUserId, table.formedByAgentId, table.importDigest)
      .where(sql`${table.formedBy} = 'bot'`),
  ],
);
