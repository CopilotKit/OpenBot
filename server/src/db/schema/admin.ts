/**
 * Enterprise controls: what members may use, how Bot computers reach the network, and the records
 * kept about what Bots did.
 *
 * Owned by `server/src/admin/**`. Every table here is read by an enforcement point that fails closed,
 * so a missing row means "the built-in default", never "unknown".
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * One switch, at one scope.
 *
 * `organization` has an empty `scope_id` and is the baseline. `role` names `admin` or `user` and
 * replaces the baseline for that role. `group` names a directory group (the values in
 * `users.groups`, written by SCIM) and can only widen: a group row of `true` grants the capability to
 * its members whatever the baseline says, and a group row of `false` changes nothing. That is the
 * Grok Bot rule ("group settings only widen").
 */
export const capabilitySettings = pgTable(
  "capability_settings",
  {
    scopeKind: text("scope_kind")
      .$type<"organization" | "role" | "group">()
      .notNull(),
    scopeId: text("scope_id").notNull().default(""),
    capability: text("capability").notNull(),
    allowed: boolean("allowed").notNull(),
    updatedBy: text("updated_by"),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.scopeKind, table.scopeId, table.capability] }),
    check(
      "capability_settings_scope_kind_check",
      sql`${table.scopeKind} IN ('organization', 'role', 'group')`,
    ),
  ],
);

/**
 * Deployment-wide enterprise switches that are one value each.
 *
 * Keys: `sso_required`, `action_recording`, `inactive_computer_days`, `model_allowlist`,
 * `mcp_allowlist`. The value is `{ value: ... }` so every key stores a JSON object.
 */
export const enterpriseSettings = pgTable("enterprise_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: updatedAt(),
});

/**
 * Where Bot computers may connect.
 *
 * One row for the organization (`scope_id` empty) and optionally one per directory group. A group
 * row replaces the organization policy for Bots its members own, unless the organization row is
 * `locked`.
 */
export const networkPolicies = pgTable(
  "network_policies",
  {
    scopeKind: text("scope_kind").$type<"organization" | "group">().notNull(),
    scopeId: text("scope_id").notNull().default(""),
    mode: text("mode")
      .$type<"allow_all" | "defaults_plus_allowlist" | "allowlist_only">()
      .notNull(),
    /** `[{ type: "domain", value }, { type: "cidr", value, ports? }]`. */
    rules: jsonb("rules").notNull().default({ entries: [] }),
    locked: boolean("locked").notNull().default(false),
    updatedBy: text("updated_by"),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.scopeKind, table.scopeId] }),
    check(
      "network_policies_scope_kind_check",
      sql`${table.scopeKind} IN ('organization', 'group')`,
    ),
    check(
      "network_policies_mode_check",
      sql`${table.mode} IN ('allow_all', 'defaults_plus_allowlist', 'allowlist_only')`,
    ),
  ],
);

/**
 * Action Recording: every shell command a Bot ran, with secrets scrubbed, kept 90 days.
 *
 * Off by default and written only while `enterprise_settings.action_recording` is on. Separate from
 * the audit trail because it has its own retention and its own switch, and because the command text
 * here is scrubbed before it is stored.
 */
export const actionRecords = pgTable(
  "action_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `cloud` for a Bot computer, `local` for a member's own machine. */
    surface: text("surface").$type<"cloud" | "local">().notNull(),
    botId: text("bot_id"),
    actorUserId: text("actor_user_id"),
    toolName: text("tool_name").notNull(),
    command: text("command").notNull(),
    outcome: text("outcome").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("action_records_created_idx").on(table.createdAt),
    index("action_records_bot_idx").on(table.botId, table.createdAt),
    check(
      "action_records_surface_check",
      sql`${table.surface} IN ('cloud', 'local')`,
    ),
  ],
);

/**
 * Which model served each Bot run, for the usage view and the allowlist.
 *
 * `source` says how the model is known: `configured` is the deployment's built-in model for a
 * built-in Bot, `observed` is a model the AG-UI stream itself named, `unknown` is a remote Bot that
 * named none.
 */
export const modelUsage = pgTable(
  "model_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id"),
    agentId: text("agent_id").notNull(),
    threadId: text("thread_id"),
    runId: text("run_id"),
    model: text("model").notNull(),
    source: text("source")
      .$type<"configured" | "observed" | "unknown">()
      .notNull(),
    allowed: boolean("allowed").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("model_usage_created_idx").on(table.createdAt),
    index("model_usage_model_idx").on(table.model, table.createdAt),
    check(
      "model_usage_source_check",
      sql`${table.source} IN ('configured', 'observed', 'unknown')`,
    ),
  ],
);
