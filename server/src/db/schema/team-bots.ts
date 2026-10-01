/**
 * Team Bots: a Bot its owner has published to the team, or to named people and groups.
 *
 * Kept beside `agent_profiles.visibility` rather than widening that enum. Public and private stay what
 * they were; a publication is a separate, revocable fact with its own audience, so unpublishing is
 * one delete and the Bot's own visibility is untouched by it.
 */
import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";

const at = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

/** One row per published Team Bot. No row is not published. */
export const teamBotPublications = pgTable(
  "team_bot_publications",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    publishedBy: text("published_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `team` is everybody signed in here; `people` is only the audience rows below. */
    audience: text("audience").$type<"team" | "people">().notNull(),
    publishedAt: at("published_at"),
  },
  (table) => [
    check(
      "team_bot_publications_audience_check",
      sql`${table.audience} IN ('team', 'people')`,
    ),
  ],
);

/** Who a `people` publication reaches: a person by id, or everybody in a named group. */
export const teamBotAudience = pgTable(
  "team_bot_audience",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"user" | "group">().notNull(),
    value: text("value").notNull(),
    createdAt: at("created_at"),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.kind, table.value] }),
    check(
      "team_bot_audience_kind_check",
      sql`${table.kind} IN ('user', 'group')`,
    ),
  ],
);

/**
 * An administrator's assignment of a published Team Bot to a group (`*` is the whole team). An
 * assigned Bot is in those people's sidebars and they cannot hide it.
 */
export const teamBotAssignments = pgTable(
  "team_bot_assignments",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    groupName: text("group_name").notNull(),
    assignedBy: text("assigned_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedAt: at("assigned_at"),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.groupName] })],
);

/**
 * A teammate's answer to "may this Team Bot use your own account on this server". `always` stands
 * until cleared; `once` is spent by the next call that uses it. Skip is no row.
 */
export const teamBotConsents = pgTable(
  "team_bot_consents",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    serverId: text("server_id").notNull(),
    decision: text("decision").$type<"always" | "once">().notNull(),
    updatedAt: at("updated_at"),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.agentId, table.serverId] }),
    check(
      "team_bot_consents_decision_check",
      sql`${table.decision} IN ('always', 'once')`,
    ),
  ],
);

/**
 * "Always allow for all Team Bots": a teammate's standing consent for every Team Bot to use their own
 * account on this server. Cleared with the rest of their connector preferences.
 */
export const teamBotConsentDefaults = pgTable(
  "team_bot_consent_defaults",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: text("server_id").notNull(),
    updatedAt: at("updated_at"),
  },
  (table) => [primaryKey({ columns: [table.userId, table.serverId] })],
);
