import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./core";
import { jsonb } from "./json";
import { mcpServers } from "./plugins";

/**
 * What an administrator approved for one Bot reaching one Shared app: who may steer a run that uses
 * the account, and whether outside input may. One row per (Bot, app); no row means no approval and
 * every shared call from that Bot is refused.
 */
export const sharedUseApprovals = pgTable(
  "shared_use_approvals",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    audience: text("audience").$type<"owner" | "people" | "team">().notNull(),
    outsideInput: boolean("outside_input").notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.serverId] }),
    check(
      "shared_use_approvals_audience_check",
      sql`${table.audience} IN ('owner', 'people', 'team')`,
    ),
  ],
);

/**
 * The published list a `people` approval was given against, as it stood when approved. Groups are
 * kept by name, so the directory still decides who is in them; a person or group added to the Bot's
 * publication later is not here, and is refused until an administrator approves again.
 */
export const sharedUseApprovalMembers = pgTable(
  "shared_use_approval_members",
  {
    agentId: text("agent_id").notNull(),
    serverId: text("server_id").notNull(),
    kind: text("kind").$type<"user" | "group">().notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.agentId, table.serverId, table.kind, table.value],
    }),
    foreignKey({
      columns: [table.agentId, table.serverId],
      foreignColumns: [sharedUseApprovals.agentId, sharedUseApprovals.serverId],
      name: "shared_use_approval_members_approval_fk",
    }).onDelete("cascade"),
    check(
      "shared_use_approval_members_kind_check",
      sql`${table.kind} IN ('user', 'group')`,
    ),
  ],
);

/** A request for an administrator to approve, or widen, a Bot's use of a Shared app. */
export const sharedUseRequests = pgTable(
  "shared_use_requests",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    proposedAudience: text("proposed_audience")
      .$type<"owner" | "people" | "team">()
      .notNull(),
    proposedOutsideInput: boolean("proposed_outside_input").notNull(),
    proposedMembers: jsonb("proposed_members")
      .$type<{ kind: "user" | "group"; value: string }[]>()
      .notNull()
      .default([]),
    reason: text("reason")
      .$type<"publish" | "trigger" | "grant" | "refused_call">()
      .notNull(),
    requestedBy: text("requested_by").notNull(),
    status: text("status")
      .$type<"pending" | "approved" | "declined" | "superseded">()
      .notNull()
      .default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("shared_use_requests_pending_idx")
      .on(table.agentId, table.serverId)
      .where(sql`${table.status} = 'pending'`),
    index("shared_use_requests_status_idx").on(table.status),
    check(
      "shared_use_requests_audience_check",
      sql`${table.proposedAudience} IN ('owner', 'people', 'team')`,
    ),
    check(
      "shared_use_requests_reason_check",
      sql`${table.reason} IN ('publish', 'trigger', 'grant', 'refused_call')`,
    ),
    check(
      "shared_use_requests_status_check",
      sql`${table.status} IN ('pending', 'approved', 'declined', 'superseded')`,
    ),
  ],
);
