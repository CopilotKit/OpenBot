/**
 * A Bot's lifecycle, as one person sees it: paused or not, how loudly it may reach them, and where
 * each kind of update goes.
 *
 * PER PERSON, NOT PER BOT. A public coworker is used by many people, and one of them pausing it
 * must stop the work done in their name without stopping anybody else's. Every row here is keyed by
 * the person first, and nothing in this file is read on behalf of anyone else.
 *
 * Wake-ups a Bot schedules for itself are not here: they are `work_items` rows of kind `bot.wakeup`,
 * on the same durable queue routines and responsibilities already run through.
 */
import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { agents, users } from "./core";

export const botLifecycle = pgTable(
  "bot_lifecycle",
  {
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** When this person paused the Bot, or null while it runs. Every dispatch point reads this. */
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    /**
     * How much this Bot may interrupt this person: `all`, `needs_input` (questions, approvals and
     * hand-offs only) or `none`. Badges on the web still show; this governs notifications.
     */
    notify: text("notify")
      .$type<"all" | "needs_input" | "none">()
      .notNull()
      .default("all"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.ownerUserId, table.agentId] })],
);

/**
 * Where one kind of update goes for one person: progress, a decision, or a question.
 *
 * A missing row is the default (every transport the person has set up). An empty list means only
 * the web, which always shows everything.
 */
export const updateRoutingPreferences = pgTable(
  "update_routing_preferences",
  {
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"progress" | "decision" | "question">().notNull(),
    transports: text("transports")
      .array()
      .$type<("slack" | "teams" | "sms" | "push")[]>()
      .notNull()
      .default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.ownerUserId, table.kind] })],
);
