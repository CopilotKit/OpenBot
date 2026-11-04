import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { channels, users } from "./core";

/** How a task began. Only from a check-in's item for now, so the check keeps it to that. */
export type BotTaskOrigin = "check_in";

/**
 * MOVED TO INTELLIGENCE: tasks are agent tasks in its conversations capability (tasks/store.ts),
 * made in one write with their own conversation. Kept for one release with no writes, for the
 * upgrade copy; then dropped.
 */
/**
 * Work a Bot does for a person in a conversation of its own. Written when the person starts an item a
 * check-in raised (`tasks.startFromItem`), read by the task list and the "Needs you" counts.
 *
 * NO STATUS COLUMN. Whether a task is working, waiting on the person, failed or ready to read is
 * worked out on every read from the ledgers that already say so: the work queue, the approval inbox
 * and the questions a Bot asked. A copy here would drift from them the first time one changed
 * without it. Only the person's own "done" is stored, as `resolved_at`.
 *
 * `channel_id` is the task's own conversation, made with it, one task per conversation. Starting an
 * item opens one task: the unique index on `suggestion_id` makes a second Start find the first. The
 * item lives in Intelligence, so nothing here follows it: one purged later leaves its task naming an
 * item that no longer exists, which nothing reads back.
 */
export const botTasks = pgTable(
  "bot_tasks",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** The check-in item it was started from, in Intelligence's check-in suggestions. */
    suggestionId: text("suggestion_id"),
    title: text("title").notNull(),
    why: text("why"),
    sourceApp: text("source_app"),
    sourceLink: text("source_link"),
    origin: text("origin").$type<BotTaskOrigin>().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("bot_tasks_owner_created_idx").on(table.ownerUserId, table.createdAt),
    uniqueIndex("bot_tasks_channel_idx").on(table.channelId),
    // An item is started once, so it opens one task. Postgres keeps any number of nulls apart.
    uniqueIndex("bot_tasks_suggestion_idx").on(table.suggestionId),
    check("bot_tasks_origin_check", sql`${table.origin} IN ('check_in')`),
  ],
);
