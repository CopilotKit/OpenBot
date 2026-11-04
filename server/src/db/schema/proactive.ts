import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  ProactiveRunOutcome,
  ProactiveRunTrigger,
  ProactiveSkipReason,
} from "../../proactive/contracts";
import type {
  ProactiveRunStatus,
  SuggestionStatus,
} from "../../proactive/types";
import { agents, users } from "./core";

/**
 * Background research by one of a person's Bots.
 *
 * On by default: OpenBot writes the row when a person first talks to the Bot in a conversation with
 * it alone (memory/defaults.ts), and never again once they turn it off (`enabled = false`) or remove
 * it (`default_opt_outs`). Bounded by `interval_minutes` (one to twenty-four hours) so a Bot never
 * reads a person's apps more often than they chose; hourly unless they chose otherwise. Rows written
 * while the default was four hours keep it, because a person's choice and the old default look the
 * same.
 *
 * Each check-in runs in a fresh thread of its own, recorded on its `proactive_runs` row, never in the
 * person's chat. A shared thread would hand every hourly run the whole history of every run before
 * it, mail included. `thread_id` is the thread runs used before that, kept so nothing is dropped.
 */
export const proactiveSettings = pgTable(
  "proactive_settings",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id").notNull(),
    focus: text("focus").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    intervalMinutes: integer("interval_minutes").notNull().default(60),
    nextRunAt: timestamp("next_run_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastStatus: text("last_status")
      .$type<ProactiveRunStatus>()
      .notNull()
      .default("idle"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("proactive_settings_owner_agent_idx").on(
      table.ownerUserId,
      table.agentId,
    ),
    index("proactive_settings_due_idx").on(table.enabled, table.nextRunAt),
    check(
      "proactive_settings_interval_check",
      sql`${table.intervalMinutes} >= 60 AND ${table.intervalMinutes} <= 1440`,
    ),
    check(
      "proactive_settings_status_check",
      sql`${table.lastStatus} IN ('idle', 'running', 'succeeded', 'error')`,
    ),
  ],
);

/**
 * A next step a check-in raised, for its owner to start or hide.
 *
 * It stays open until the person starts it, hides it (`dismissed`), or a later check-in clears it as
 * no longer needed (`superseded`). `dedupe_key` is its title normalized the way the repeat check
 * compares titles, so the partial unique index below stops two check-ins racing to open the same
 * thing for one person and Bot. Older rows have none and are left out of it.
 *
 * `ping_id` is the ping that carried it to the person, and `delivered_at` when. An open item with no
 * ping is waiting for the person's hourly slot (`proactive_people`).
 */
export const proactiveSuggestions = pgTable(
  "proactive_suggestions",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    settingId: text("setting_id")
      .notNull()
      .references(() => proactiveSettings.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    sourceApp: text("source_app"),
    sourceRef: text("source_ref"),
    sourceLink: text("source_link"),
    status: text("status").$type<SuggestionStatus>().notNull().default("open"),
    dedupeKey: text("dedupe_key"),
    pingId: text("ping_id").references(() => proactivePings.id, {
      onDelete: "set null",
    }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("proactive_suggestions_owner_idx").on(
      table.ownerUserId,
      table.status,
      table.createdAt,
    ),
    index("proactive_suggestions_run_idx").on(table.runId),
    // The backstop for the repeat check: one open item per normalized title, per person and Bot.
    uniqueIndex("proactive_suggestions_open_dedupe_idx")
      .on(table.ownerUserId, table.agentId, table.dedupeKey)
      .where(sql`${table.status} = 'open' AND ${table.dedupeKey} IS NOT NULL`),
    /*
     * The ping pass's own query, run every minute on every replica: whose open items no ping has
     * carried yet. Partial, so it stays as small as what is waiting, however long the history.
     */
    index("proactive_suggestions_unpinged_idx")
      .on(table.ownerUserId)
      .where(sql`${table.status} = 'open' AND ${table.pingId} IS NULL`),
    check(
      "proactive_suggestions_status_check",
      sql`${table.status} IN ('open', 'dismissed', 'started', 'superseded')`,
    ),
  ],
);

/**
 * One row per check-in, run or skipped: the ledger the window, the caps and the admin's numbers read.
 *
 * A check-in reads what is new since the start of the setting's last `quiet` or `raised` run, so
 * "since" comes from here, never from `proactive_settings.last_run_at`, which Run now can overwrite.
 *
 * A gate that stops a check-in before the model writes a `skipped` row with its reason and no
 * thread. `running` is the only unfinished outcome, and the partial unique index keeps one per
 * setting, so a second replica or a Run now cannot start another beside it. A replica that died
 * mid-run leaves its row `running`; the next sweep closes it as `failed` once its lease has passed.
 *
 * `reads` is how many reads the audit trail recorded for the run, `items_raised` how many items it
 * opened. Counts only: what a run read stays in the audit trail, never here. Pruned on the audit
 * retention schedule.
 */
export const proactiveRuns = pgTable(
  "proactive_runs",
  {
    id: text("id").primaryKey(),
    settingId: text("setting_id")
      .notNull()
      .references(() => proactiveSettings.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** The run's own fresh thread. Null when a gate skipped it before any thread was made. */
    threadId: text("thread_id"),
    trigger: text("trigger").$type<ProactiveRunTrigger>().notNull(),
    outcome: text("outcome")
      .$type<ProactiveRunOutcome>()
      .notNull()
      .default("running"),
    skipReason: text("skip_reason").$type<ProactiveSkipReason>(),
    itemsRaised: integer("items_raised").notNull().default(0),
    reads: integer("reads").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    // The daily cap (per person and Bot) and the window both read one setting's recent runs.
    index("proactive_runs_setting_started_idx").on(
      table.settingId,
      table.startedAt,
    ),
    index("proactive_runs_owner_started_idx").on(
      table.ownerUserId,
      table.startedAt,
    ),
    // The admin's numbers are per Bot.
    index("proactive_runs_agent_started_idx").on(
      table.agentId,
      table.startedAt,
    ),
    // One check-in at a time per setting, across every replica.
    uniqueIndex("proactive_runs_one_running_idx")
      .on(table.settingId)
      .where(sql`${table.outcome} = 'running'`),
    check(
      "proactive_runs_trigger_check",
      sql`${table.trigger} IN ('schedule', 'run_now')`,
    ),
    check(
      "proactive_runs_outcome_check",
      sql`${table.outcome} IN ('running', 'quiet', 'raised', 'failed', 'skipped')`,
    ),
    /*
     * A skipped run says why; no other run has a skip reason. `IS NOT NULL` is spelled out because
     * `NULL IN (...)` is unknown, not false, and a check that comes out unknown passes.
     */
    check(
      "proactive_runs_skip_reason_check",
      sql`(${table.outcome} = 'skipped' AND ${table.skipReason} IS NOT NULL AND ${table.skipReason} IN ('off_admin', 'off_person', 'paused', 'capped', 'unreachable', 'no_sources', 'busy')) OR (${table.outcome} <> 'skipped' AND ${table.skipReason} IS NULL)`,
    ),
    // Only a running check-in is unfinished.
    check(
      "proactive_runs_finished_check",
      sql`(${table.outcome} = 'running') = (${table.finishedAt} IS NULL)`,
    ),
  ],
);

/**
 * One row per person who has check-ins: the hourly ping slot.
 *
 * A person hears from their Bots at most once an hour, every Bot's waiting items folded into one
 * message, so the slot is the person's, not any one Bot's. Taking it is one conditional UPDATE of
 * `last_pinged_at` on this row: the row lock serializes replicas, and Postgres re-checks the
 * condition against the row a winner just wrote, so two replicas finishing check-ins in the same
 * second send one ping. A person with no row has never been pinged.
 */
export const proactivePeople = pgTable("proactive_people", {
  ownerUserId: text("owner_user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** When the last ping went out. Null until the first. */
  lastPingedAt: timestamp("last_pinged_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * One message to a person that something needs them, folding every open item no ping had carried
 * yet, across all their Bots. The items point here through `proactive_suggestions.ping_id`, each
 * still knowing its Bot.
 *
 * Written in the same transaction that takes the person's slot, with the text it sends, so a
 * replica that stops between that commit and delivery leaves a ping the next pass can offer again,
 * word for word. `offered_at` is null until delivery rows were offered; delivery's own dedupe keys
 * stop a second send when it is offered twice.
 *
 * `text` is the folded message for Slack, Teams and SMS, which names each item's Bot. `push_body` is
 * the one line a phone or browser notification shows.
 */
export const proactivePings = pgTable(
  "proactive_pings",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    itemCount: integer("item_count").notNull(),
    text: text("text").notNull(),
    pushBody: text("push_body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    offeredAt: timestamp("offered_at", { withTimezone: true }),
  },
  (table) => [
    index("proactive_pings_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt,
    ),
    // What the ping pass offers again after a crash: kept as small as what is unoffered.
    index("proactive_pings_unoffered_idx")
      .on(table.createdAt)
      .where(sql`${table.offeredAt} IS NULL`),
    // A ping is only taken when something waits.
    check("proactive_pings_item_count_check", sql`${table.itemCount} > 0`),
  ],
);
