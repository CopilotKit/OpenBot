import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { TaskOrigin } from "../../tasks/types";
import { agents, channels, users } from "./core";
import { proactiveSuggestions } from "./proactive";

/**
 * Work a Bot does for a person in the background, each in a conversation of its own, so the
 * conversation it was asked in stays one thread. Read by Tasks and the task page (tasks/store.ts).
 *
 * NO STATUS COLUMN. Whether a task is working, waiting on the person or ready to read is worked out
 * on every read from the ledgers that already say so: the work queue, the approval inbox and the
 * questions a Bot asked. A copy here would drift from them the first time one changed without it.
 * Only the person's own "done" is stored, as `resolved_at`.
 *
 * `channel_id` is the task's own conversation, made with it, one task per conversation, and the
 * task goes with it. `suggestion_id` is the suggestion it was started from: a suggestion is started
 * once, so it opens one task, and the task outlives the suggestion.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    why: text("why"),
    origin: text("origin").$type<TaskOrigin>().notNull(),
    suggestionId: text("suggestion_id").references(
      () => proactiveSuggestions.id,
      { onDelete: "set null" },
    ),
    sourceApp: text("source_app"),
    sourceLink: text("source_link"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("tasks_owner_created_idx").on(table.ownerUserId, table.createdAt),
    uniqueIndex("tasks_channel_idx").on(table.channelId),
    // Postgres keeps any number of nulls apart, so tasks asked for directly never collide.
    uniqueIndex("tasks_suggestion_idx").on(table.suggestionId),
    check(
      "tasks_origin_check",
      sql`${table.origin} IN ('asked', 'suggestion')`,
    ),
  ],
);
