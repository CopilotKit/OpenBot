import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";
import { skills } from "./plugins";

/**
 * A person's request to offer a recorded Skill to everyone (`share`), or to publish a Bot that
 * carries it (`make_bot`). An administrator decides it in Approvals, as with shared-use requests.
 */
export const skillShareRequests = pgTable(
  "skill_share_requests",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<"share" | "make_bot">().notNull(),
    skillSlug: text("skill_slug")
      .notNull()
      .references(() => skills.slug, { onDelete: "cascade" }),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botName: text("bot_name"),
    botTitle: text("bot_title"),
    botRoleDescription: text("bot_role_description"),
    status: text("status")
      .$type<"pending" | "approved" | "declined" | "superseded">()
      .notNull()
      .default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdBotId: text("created_bot_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("skill_share_requests_pending_idx")
      .on(table.kind, table.skillSlug)
      .where(sql`${table.status} = 'pending'`),
    index("skill_share_requests_status_idx").on(table.status, table.createdAt),
    index("skill_share_requests_requested_by_idx").on(table.requestedBy),
    check(
      "skill_share_requests_kind_check",
      sql`${table.kind} IN ('share', 'make_bot')`,
    ),
    check(
      "skill_share_requests_status_check",
      sql`${table.status} IN ('pending', 'approved', 'declined', 'superseded')`,
    ),
    check(
      "skill_share_requests_bot_check",
      sql`(${table.kind} = 'make_bot') = (${table.botName} IS NOT NULL AND ${table.botTitle} IS NOT NULL AND ${table.botRoleDescription} IS NOT NULL)`,
    ),
  ],
);
