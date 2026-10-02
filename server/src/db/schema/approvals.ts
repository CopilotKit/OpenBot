import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  ApprovalAction,
  ApprovalDecision,
  HostCommandPolicy,
  RuleBehaviour,
} from "../../approvals/types";
import { users } from "./core";
import { jsonb } from "./json";
export const approvalPreferences = pgTable(
  "approval_preferences",
  {
    ownerUserId: text("owner_user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    /** A model checks each account-affecting or sharing action against this person's request. */
    autoReview: boolean("auto_review").notNull().default(false),
    /** Commands on this person's own computer: ask every time, always allow, or never. */
    hostCommands: text("host_commands")
      .$type<HostCommandPolicy>()
      .notNull()
      .default("ask"),
  },
  (table) => [
    check(
      "approval_preferences_host_commands_check",
      sql`${table.hostCommands} IN ('ask', 'allow', 'never')`,
    ),
  ],
);

/**
 * The deployment's own approval settings, one row keyed `team`. Absent means every default below.
 *
 * `hostCommandsCap` is the most permissive host-command policy any member may hold; a member's own
 * stricter setting still applies. `customRulesEnabled` false means personal rules are kept but do not
 * apply, which is how a workspace switches custom rules off. Team rules and safety still apply.
 */
export const approvalTeamSettings = pgTable(
  "approval_team_settings",
  {
    id: text("id").primaryKey(),
    enforceAutoReview: boolean("enforce_auto_review").notNull().default(false),
    customRulesEnabled: boolean("custom_rules_enabled").notNull().default(true),
    hostCommandsCap: text("host_commands_cap")
      .$type<HostCommandPolicy>()
      .notNull()
      .default("allow"),
    updatedBy: text("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "approval_team_settings_host_commands_cap_check",
      sql`${table.hostCommandsCap} IN ('ask', 'allow', 'never')`,
    ),
  ],
);
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    actionDigest: text("action_digest").notNull(),
    action: jsonb("action").$type<ApprovalAction>().notNull(),
    status: text("status")
      .$type<"pending" | "approved" | "denied" | "consumed" | "completed">()
      .notNull()
      .default("pending"),
    decision: text("decision").$type<ApprovalDecision>(),
    result: jsonb("result").$type<{ content: string; error?: string }>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("approval_requests_action_idx").on(
      table.ownerUserId,
      table.runId,
      table.toolCallId,
    ),
    index("approval_requests_inbox_idx").on(table.ownerUserId, table.status),
    check(
      "approval_status_check",
      sql`${table.status} IN ('pending', 'approved', 'denied', 'consumed', 'completed')`,
    ),
    check(
      "approval_decision_check",
      sql`${table.decision} IN ('allow_once', 'allow_always', 'deny', 'handled')`,
    ),
  ],
);
export const approvalRules = pgTable(
  "approval_rules",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id").notNull(),
    toolRef: text("tool_ref").notNull(),
    effect: text("effect").notNull(),
    scope: text("scope").notNull(),
    /** What happens to a matching action. `allow` is what "Always allow here" has always saved. */
    behaviour: text("behaviour")
      .$type<RuleBehaviour>()
      .notNull()
      .default("allow"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("approval_rules_owner_idx").on(table.ownerUserId),
    check(
      "approval_rules_behaviour_check",
      sql`${table.behaviour} IN ('allow', 'pre_approved', 'ask', 'hand_off')`,
    ),
  ],
);

/**
 * Rules an administrator sets for everybody. Shown to members as locked rows; they layer with
 * personal rules and the strictest matching behaviour wins. Same action-class shape as a personal
 * rule: `botId`, `toolRef`, `effect` and `scope` are exact values or `*` globs.
 */
export const approvalTeamRules = pgTable(
  "approval_team_rules",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id").notNull(),
    toolRef: text("tool_ref").notNull(),
    effect: text("effect").notNull(),
    scope: text("scope").notNull(),
    behaviour: text("behaviour").$type<RuleBehaviour>().notNull(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "approval_team_rules_behaviour_check",
      sql`${table.behaviour} IN ('allow', 'pre_approved', 'ask', 'hand_off')`,
    ),
  ],
);
