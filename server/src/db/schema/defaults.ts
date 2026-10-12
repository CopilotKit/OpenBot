import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";

/** What a person can switch off that OpenBot otherwise switches on for them. */
export type DefaultFeature = "memory_source" | "proactive_research";

/**
 * A default a person turned down, so OpenBot never switches it back on.
 *
 * Memory sources and background research are on by default (see `memory/defaults.ts`): a person who
 * talks to one of their Bots gets research from it, and each app they connected that the Bot can read
 * becomes a memory source. Turning one OFF keeps its row with `enabled = false`, and that row alone
 * stops it coming back. REMOVING one deletes the row, so the removal is written here instead, and
 * adoption reads this table before it creates anything.
 *
 * `scope` narrows the feature: for a memory source it is the app (the server id), because a person who
 * removed their Bot's Gmail source said "not Gmail for this Bot", whichever Gmail action it read. For
 * background research it is empty: one setting per person and Bot.
 */
export const defaultOptOuts = pgTable(
  "default_opt_outs",
  {
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    feature: text("feature").$type<DefaultFeature>().notNull(),
    scope: text("scope").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerUserId, table.agentId, table.feature, table.scope],
    }),
    check(
      "default_opt_outs_feature_check",
      sql`${table.feature} IN ('memory_source', 'proactive_research')`,
    ),
  ],
);
