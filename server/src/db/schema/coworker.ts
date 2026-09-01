/**
 * Coworker tables: bots, skills, routines, bot-to-bot handoff.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or computer.ts to do it.
 */
import {
  boolean,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const agentVisibility = pgEnum("agent_visibility", [
  "public",
  "private",
]);

export const agentProfiles = pgTable(
  "agent_profiles",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    roleDescription: text("role_description").notNull(),
    avatarSeed: text("avatar_seed").notNull(),
    /** A user-chosen image, falling back to the deterministic seed when absent. */
    avatarImage: text("avatar_image"),
    visibility: agentVisibility("visibility").notNull(),
    /*
     * The credential this Bot's agent presents when it calls a tool back.
     *
     * A hash, never the token. We issue it, the agent's owner holds it, and this side only ever needs
     * to check one: storing the token itself would mean a database dump is a set of working
     * credentials for every registered agent.
     *
     * Null means the agent has not been issued one and may not call tools back, which is the right
     * default: a URL somebody pasted gets no capability until an administrator hands it one.
     */
    callbackTokenHash: text("callback_token_hash"),
    callbackTokenIssuedAt: timestamp("callback_token_issued_at", {
      withTimezone: true,
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("agent_profiles_visibility_deleted_idx").on(
      table.visibility,
      table.deletedAt,
    ),
  ],
);

export const agentPreferences = pgTable(
  "agent_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);

export const routineRunStatus = pgEnum("routine_run_status", [
  "succeeded",
  "failed",
  "skipped",
]);

/**
 * A standing instruction one person gave one Bot, on a schedule.
 *
 * Owned rows all the way down: the owner is who the headless turn runs as, so the routine can do
 * exactly what its owner could do in chat and nothing more. The channel is where the reply lands.
 */
export const routines = pgTable(
  "routines",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /**
     * Not a foreign key. Channels soft-delete (`channels.deletedAt`), and a routine pointing at a
     * deleted channel must survive to be shown as broken rather than vanish in a cascade.
     */
    channelId: text("channel_id").notNull(),
    instruction: text("instruction").notNull(),
    /** Five-field cron. Validated at the tool boundary; never parsed by the client. */
    cron: text("cron").notNull(),
    /** IANA zone the cron is read in. UTC when the person never said otherwise. */
    timezone: text("timezone").notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    /** The sweep's read target. Recomputed on every write and CAS-advanced by the sweep. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    /**
     * The last occurrence stamp the sweep advanced past — fired OR silently drained as stale.
     * Not "when this last ran": the run history lives in routine_runs, and everything a person
     * sees reads that table. This is the scheduler's own bookmark, kept because a CAS needs the
     * value it compared against recorded somewhere a human can inspect when a clock looks wrong.
     */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("routines_due_idx").on(table.enabled, table.nextRunAt),
    /** Owner-scoped reads and writes: listFor, countEnabled, and the users cascade all hit this. */
    index("routines_by_owner_idx").on(table.ownerUserId, table.enabled),
  ],
);

/** One row per firing, which is what the page's "last ran" and the fatigue rule read. */
export const routineRuns = pgTable(
  "routine_runs",
  {
    id: text("id").primaryKey(),
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Null means the firing is still in flight; only a finished run has succeeded/failed/skipped. */
    status: routineRunStatus("status"),
    /** The refusal or the throw, capped like audit payloads. Never shown raw to a person. */
    error: text("error"),
  },
  (table) => [
    index("routine_runs_by_routine_idx").on(table.routineId, table.startedAt),
  ],
);
