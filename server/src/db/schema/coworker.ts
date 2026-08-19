/**
 * Coworker tables: bots, skills, routines, bot-to-bot handoff.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or computer.ts to do it.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";
// NOT drizzle's `jsonb`: that one serialises and so does the driver, so a schedule stored through it
// lands as a JSON string and cannot be read back as an object. See ./json.ts.
import { jsonb } from "./json";

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
    visibility: agentVisibility("visibility").notNull(),
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

/**
 * What set a run going.
 *
 * `schedule` is the clock coming round, `manual` is somebody pressing Run now, and `webhook` is
 * another system handing the Bot a piece of work. Recorded per run because they are not equally
 * surprising: a person watching their own Run now expects what follows, and nobody is watching the
 * other two.
 */
export const routineTrigger = pgEnum("routine_trigger", [
  "schedule",
  "manual",
  "webhook",
]);

/**
 * What became of one run.
 *
 * `missed` is the one that earns its place. A laptop asleep at eight o'clock cannot run the eight
 * o'clock routine, and the two things it must not do instead are fire it at noon as though nothing
 * had happened, or show nothing at all. Recording the window as missed is the only answer that
 * leaves a person able to tell "it ran and found nothing" from "it never ran".
 */
export const routineRunStatus = pgEnum("routine_run_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "missed",
]);

/**
 * A standing instruction a Bot carries out without being asked.
 *
 * The prompt is stored rather than a script, because the thing being scheduled is a conversation
 * turn: whatever the Bot would have done had somebody typed this at eight o'clock. That keeps a
 * routine exactly as capable as the Bot is, and stops this table becoming a second, weaker way of
 * describing work.
 */
export const routines = pgTable(
  "routines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /**
     * Whose routine it is, and whose authority it runs with.
     *
     * An unattended run still acts as somebody: the audit trail names them, and the Bots it may
     * reach are the ones that person may see. A routine with no owner would be a run nobody is
     * accountable for, which is the opposite of what this product is for.
     */
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    /**
     * `{ type: "once", at }` or `{ type: "daily", time, weekdays }`, as JSON rather than as a cron
     * string. Cron is a language an operator has to already know, and this has to be editable from a
     * form by somebody who does not. What "due" means is decided in routines/schedule.ts, which has
     * no clock of its own, so it is decided in one testable place rather than by whatever the
     * database happened to think the time was.
     */
    schedule: jsonb("schedule").notNull(),
    /**
     * Off means the schedule is ignored and nothing fires on its own. Kept rather than deleted so
     * somebody can stop a routine they are unsure about without losing what it said.
     */
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // The scheduler's own query, run once a minute forever. Worth having for the deployment whose
    // routines are mostly switched off, which is what a long-lived one drifts towards; it buys
    // nothing while most rows are enabled, because a planner reading most of the table will read all
    // of it and be right to.
    index("routines_enabled_idx").on(table.enabled),
    index("routines_owner_idx").on(table.ownerUserId),
  ],
);

/**
 * One attempt at a routine, whatever came of it.
 *
 * The row is written before the work starts, not after it finishes. A run that took the process down
 * with it would otherwise leave no trace at all, and "nothing happened" and "something happened and
 * we lost the record" look identical to the person reading the list.
 *
 * Deleted with its routine. A list of runs of something nobody can look at any more is not history
 * worth keeping, and somebody deleting a routine is asking for it to be gone.
 */
export const routineRuns = pgTable(
  "routine_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    routineId: uuid("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    trigger: routineTrigger("trigger").notNull(),
    status: routineRunStatus("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** What the Bot said at the end, so the list answers "what did it find" without opening a thread. */
    summary: text("summary"),
    /** Why it did not work, in the words a person reads. Null unless the status is `failed`. */
    error: text("error"),
    /**
     * The name given to the conversation this run had.
     *
     * A name, and deliberately described as one. It is minted in the same namespace every other
     * conversation in this deployment is minted in, and it is what tells one run's turns apart from
     * another run of the same routine wherever both are visible: the `routine.run_started` row
     * carries it, and so does the run row.
     *
     * What it is not is a transcript. An unattended run speaks to the Bot directly rather than
     * through the runtime that owns durable threads, so nothing writes the messages anywhere and
     * opening this id would find an empty conversation. That is the honest state of it, and stating
     * it here is the point: the alternative is a field that reads like a link to the whole
     * conversation and is a link to nothing, which is worse than no field at all.
     *
     * What a person actually gets for an unattended run is the summary on this row and the audit
     * rows for every action the Bot took, which the gateway writes whether anybody is watching or
     * not. Persisting the turns themselves is the obvious next thing to add, and this column is
     * where it would attach.
     */
    threadId: text("thread_id"),
  },
  (table) => [
    index("routine_runs_routine_started_idx").on(
      table.routineId,
      table.startedAt,
    ),
    /**
     * One live run per routine, enforced by the database rather than by the scheduler.
     *
     * Two ticks can overlap, and two processes can both be ticking. Either way the check-then-insert
     * a careful loop would do has a gap in the middle, and what fits through that gap is a routine
     * that runs twice: two emails sent, two forms filled in. A unique index closes it, because the
     * second insert loses rather than races.
     */
    uniqueIndex("routine_runs_one_active_idx")
      .on(table.routineId)
      .where(sql`status in ('queued', 'running')`),
  ],
);

/**
 * A URL another system can hand a Bot a piece of work through.
 *
 * This is the one thing in the product meant to be reachable by somebody who has not signed in, so
 * it is deliberately narrow: a random endpoint id, a bearer secret kept only as a hash, an optional
 * list of event types, and an off switch. It is served by a separate process on a separate port; see
 * routines/receiver.ts for why that is not a detail.
 *
 * A trigger either names a routine or carries a prompt of its own. Both exist because the two things
 * people ask for are genuinely different: "run my morning briefing when the build finishes" reuses a
 * routine, and "tell the Bot this happened" has no routine to reuse.
 */
export const webhookTriggers = pgTable(
  "webhook_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The public path segment, and the only part of this an outsider ever sees.
     *
     * Random rather than derived from the name, because a guessable path is one leaked secret away
     * from a Bot doing work for a stranger, and a name is the part people paste into chat messages.
     */
    endpointId: text("endpoint_id").notNull().unique(),
    name: text("name").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Set when this trigger reuses a routine. Null when it carries its own prompt below. */
    routineId: uuid("routine_id").references(() => routines.id, {
      onDelete: "cascade",
    }),
    /** Set together, and only when `routineId` is null: the work to do, with no routine to reuse. */
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    prompt: text("prompt"),
    /**
     * SHA-256 of the bearer secret.
     *
     * The secret itself is shown once, at creation and at rotation, and cannot be recovered
     * afterwards. A secret this table could return is a secret that an administrator's screen, a
     * backup and a database dump all hold, and the whole value of a bearer token is that only the
     * caller has it.
     */
    secretHash: text("secret_hash").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * True until somebody has looked at a real delivery and confirmed it.
     *
     * A newly created trigger accepts its first authenticated delivery, keeps it as a sample, and
     * runs nothing. The failure this avoids is the quiet one: a hook pointed at the wrong trigger,
     * or carrying a payload nothing like what was expected, starts real work on somebody's live
     * systems and the first anybody hears of it is the result.
     */
    verificationPending: boolean("verification_pending")
      .notNull()
      .default(true),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** The first authenticated delivery, kept so the confirmation above is an informed one. */
    sample: jsonb("sample"),
    /**
     * Which event types this trigger will act on. Empty means every one.
     *
     * An allowlist rather than an instruction in the prompt, because "only act on
     * deployment.succeeded" is a decision about what may reach the Bot at all, and a rule the model
     * is merely asked to follow is not one.
     */
    eventTypes: text("event_types").array().notNull().default([]),
    deliveryCount: integer("delivery_count").notNull().default(0),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("webhook_triggers_owner_idx").on(table.ownerUserId)],
);
