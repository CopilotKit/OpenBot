import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  text,
  timestamp,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { channels, users } from "./core";
import { jsonb } from "./json";

export const groupBotThreads = pgTable(
  "group_bot_threads",
  {
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    threadId: text("thread_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerUserId, table.channelId, table.agentId],
    }),
    uniqueIndex("group_bot_threads_thread_idx").on(table.threadId),
  ],
);

export const groupMessages = pgTable(
  "group_messages",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id"),
    threadId: text("thread_id"),
    text: text("text").notNull(),
    status: text("status")
      .$type<"queued" | "running" | "waiting" | "completed" | "failed">()
      .notNull()
      .default("completed"),
    details: jsonb("details").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("group_messages_channel_idx").on(
      table.channelId,
      table.createdAt,
      table.id,
    ),
    check(
      "group_messages_status_check",
      sql`${table.status} IN ('queued', 'running', 'waiting', 'completed', 'failed')`,
    ),
  ],
);
