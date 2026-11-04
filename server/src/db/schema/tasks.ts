import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents, channels, users } from "./core";
import { proactiveSuggestions } from "./proactive";

/**
 * How a task began: from a check-in's item the person started, or asked for in so many words, by
 * `start_task` in a conversation or the + on Tasks (`POST /api/tasks`).
 */
export type BotTaskOrigin = "check_in" | "asked";

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
 * item opens one task: the unique index on `suggestion_id` makes a second Start find the first. An
 * item deleted later leaves its task, unlinked.
 *
 * `client_id` is the id the browser made for a Start on Tasks. The unique index on it, per person,
 * makes the same Start sent twice open one task: the second finds the first.
 */
export const botTasks = pgTable(
  "bot_tasks",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    suggestionId: text("suggestion_id").references(
      () => proactiveSuggestions.id,
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    why: text("why"),
    sourceApp: text("source_app"),
    sourceLink: text("source_link"),
    origin: text("origin").$type<BotTaskOrigin>().notNull(),
    clientId: text("client_id"),
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
    // A Start sent twice opens one task. Postgres keeps any number of nulls apart.
    uniqueIndex("bot_tasks_owner_client_idx").on(
      table.ownerUserId,
      table.clientId,
    ),
    check(
      "bot_tasks_origin_check",
      sql`${table.origin} IN ('check_in', 'asked')`,
    ),
  ],
);
