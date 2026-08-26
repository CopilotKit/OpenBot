/**
 * A person's standing instructions: keeping them, and guarding them.
 *
 * THIS FILE HAS TWO HALVES, AND THEY ARE SEPARABLE ON PURPOSE. The half below is the one a person
 * touches: create, list, change, remove, switch off. It is asked questions through a Bot, so every
 * refusal is a sentence a model can act on, every statement is guarded by the owner, and the owner is
 * never taken from an argument a model supplied. Its failures are one person's failures — a bad cron,
 * a channel they are not in — and none of them are about two things happening at once.
 *
 * The other half is the sweep's: the ledger read on a clock (which routines are due, advancing the
 * next run, opening and closing a run row). Nothing there is asked a question by a person, and
 * everything there is about concurrency — several replicas reading the same due row in the same
 * second. That is why the halves are worth telling apart: only the second one has anything to do with
 * concurrency, and only the second one needs to be reasoned about as a race. It lands in the next
 * commit, and this file deliberately does not contain it.
 *
 * NO CLAIM OR LEASE MACHINERY, EVER. Firing mechanics belong to the shared `work_items` queue in
 * `server/src/work/queue.ts`, which already owns `for update skip locked`, leases on the database's
 * clock, and an attempt count. A second lease grown on the routines table — a `claimed_by`, a
 * `locked_until` — is exactly the duplicated firing mechanism #235 exists to prevent: two half-right
 * implementations of the same hard thing, one of which nobody tests.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  routineRuns,
  routines,
} from "../db/schema";
import { ScheduleRefusedError, describeCron, nextOccurrence } from "./schedule";

export class RoutineNotFoundError extends Error {
  constructor(message = "That routine does not exist.") {
    super(message);
    this.name = "RoutineNotFoundError";
  }
}

/** The floor, the cap, a bad zone, a channel that is not the caller's. Carries the sentence verbatim. */
export class RoutineRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineRefusedError";
  }
}

/** A person may keep this many routines switched on. A constant with a reason, not a setting. */
export const MAX_ENABLED_ROUTINES = 20;
/** Same code-point cap discipline as channel activity. */
export const MAX_INSTRUCTION_CODE_POINTS = 2000;

const NO_SHARED_CHANNEL =
  "I can only post into a channel you and I are both in.";
const NO_CHANNEL_AT_ALL =
  "We have no channel for me to post into. Start one and ask again.";
const INSTRUCTION_EMPTY = "A routine needs an instruction to carry out.";
const INSTRUCTION_TOO_LONG = `An instruction can be at most ${MAX_INSTRUCTION_CODE_POINTS} characters.`;
const TOO_MANY_ENABLED = `You already have ${MAX_ENABLED_ROUTINES} routines switched on. Switch one off before adding another.`;

/** How many names an ambiguity refusal reads out before it gives up and says "and others". */
const MAX_NAMED_CHANNELS = 5;

export type RoutineRunOutcome = "succeeded" | "failed" | "skipped";

export type Routine = {
  id: string;
  ownerUserId: string;
  agentId: string;
  channelId: string;
  instruction: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: Date;
  lastRunAt: Date | null;
  createdAt: Date;
};

/** One row of the routines page: everything it draws, and nothing it would have to parse. */
export type RoutineSummary = {
  id: string;
  agentId: string;
  instruction: string;
  /**
   * The schedule in words — "Weekdays at 09:00" — never the cron expression.
   *
   * The client never parses a schedule. A cron string on the wire is an invitation for the browser
   * to grow a second, disagreeing parser, and for the page to render one thing while the sweep does
   * another.
   */
  schedule: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: Date;
  channelId: string;
  /** The target channel's name, or null when the row is gone entirely rather than soft-deleted. */
  channelName: string | null;
  /** Whether the target channel was deleted. A broken routine is shown, not hidden. */
  channelDeleted: boolean;
  /** The most recent firing, or null when it has never fired. */
  lastRun: { status: RoutineRunOutcome | null; finishedAt: Date | null } | null;
};

export type RoutineInput = {
  ownerUserId: string;
  agentId: string;
  channelId?: string;
  instruction: string;
  cron: string;
  timezone?: string;
};

export type RoutinePatch = Partial<{
  instruction: string;
  cron: string;
  timezone: string;
  channelId: string;
  enabled: boolean;
}>;

export type RoutineStore = {
  create(input: RoutineInput): Promise<Routine>;
  listFor(ownerUserId: string): Promise<RoutineSummary[]>;
  update(
    ownerUserId: string,
    id: string,
    patch: RoutinePatch,
  ): Promise<Routine>;
  remove(ownerUserId: string, id: string): Promise<void>;
  setEnabled(ownerUserId: string, id: string, enabled: boolean): Promise<void>;
};

type RoutineRow = typeof routines.$inferSelect;

function toRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    agentId: row.agentId,
    channelId: row.channelId,
    instruction: row.instruction,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
  };
}

/** Trim, then measure in code points like channel activity does — not in UTF-16 units. */
function validInstruction(instruction: string): string {
  const trimmed = instruction.trim();
  if (trimmed.length === 0) throw new RoutineRefusedError(INSTRUCTION_EMPTY);
  if (Array.from(trimmed).length > MAX_INSTRUCTION_CODE_POINTS) {
    throw new RoutineRefusedError(INSTRUCTION_TOO_LONG);
  }
  return trimmed;
}

/**
 * The schedule module owns both acceptance and the next occurrence, so its refusal sentence is the
 * one a person should read. It is carried through verbatim rather than reworded here: a model that
 * gets "Routines may run at most every 15 minutes" can propose a schedule that works, and a model
 * that gets "invalid cron" cannot.
 */
function nextRunFor(cron: string, timezone: string, after: Date): Date {
  try {
    return nextOccurrence(cron, timezone, after);
  } catch (error) {
    if (error instanceof ScheduleRefusedError) {
      throw new RoutineRefusedError(error.message);
    }
    throw error;
  }
}

/** "A", "A, B", or five names and "and others" — a sentence, not a list a client renders. */
function nameThem(names: string[]): string {
  if (names.length <= MAX_NAMED_CHANNELS) return names.join(", ");
  return [...names.slice(0, MAX_NAMED_CHANNELS), "and others"].join(", ");
}

export function createRoutineStore(database: Database): RoutineStore {
  /**
   * Where the reply lands, decided here rather than at the tool boundary.
   *
   * Discovery confirmed the conversation's own channel is not reachable at the tool layer, so a model
   * asked to make a routine either names a channel or names nothing. Both are resolved against what
   * the owner and this agent actually share, which is the only check that stops a routine posting
   * one person's summary into another person's conversation.
   */
  async function resolveChannel(
    ownerUserId: string,
    agentId: string,
    channelId?: string,
  ): Promise<string> {
    if (channelId !== undefined) {
      // One query for all four conditions: the channel exists, it is not deleted, the owner is a
      // member, and this agent is in it. Any miss is the same refusal, because telling them apart
      // would tell a caller which channel ids exist.
      const rows = await database
        .select({ id: channels.id })
        .from(channels)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, channels.id),
            eq(channelMemberships.userId, ownerUserId),
          ),
        )
        .innerJoin(
          channelAgents,
          and(
            eq(channelAgents.channelId, channels.id),
            eq(channelAgents.agentId, agentId),
          ),
        )
        .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
        .limit(1);
      const found = rows[0];
      if (!found) throw new RoutineRefusedError(NO_SHARED_CHANNEL);
      return found.id;
    }

    // Six rows is enough to answer the question: one resolves, more than one refuses, and the
    // sentence names at most five before it says "and others".
    const candidates = await database
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, ownerUserId),
        ),
      )
      .innerJoin(
        channelAgents,
        and(
          eq(channelAgents.channelId, channels.id),
          eq(channelAgents.agentId, agentId),
        ),
      )
      .where(isNull(channels.deletedAt))
      .orderBy(desc(channels.createdAt), desc(channels.id))
      .limit(MAX_NAMED_CHANNELS + 1);

    const only = candidates[0];
    if (!only) throw new RoutineRefusedError(NO_CHANNEL_AT_ALL);
    if (candidates.length > 1) {
      // Named, because this refusal goes back to the model: a sentence listing the channels is a
      // question it can put to the person, and "be more specific" is not.
      throw new RoutineRefusedError(
        `You are in more than one channel with me — ${nameThem(
          candidates.map((candidate) => candidate.name),
        )}. Say which one.`,
      );
    }
    return only.id;
  }

  /** How many of this person's routines are switched on. The cap counts these, not rows. */
  async function countEnabled(ownerUserId: string): Promise<number> {
    const [row] = await database
      .select({ total: sql<number>`count(*)::int` })
      .from(routines)
      .where(
        and(eq(routines.ownerUserId, ownerUserId), eq(routines.enabled, true)),
      );
    return row?.total ?? 0;
  }

  async function loadOwned(
    ownerUserId: string,
    id: string,
  ): Promise<RoutineRow> {
    const [row] = await database
      .select()
      .from(routines)
      .where(and(eq(routines.id, id), eq(routines.ownerUserId, ownerUserId)))
      .limit(1);
    // A routine that is not yours is a routine that does not exist: the `setPinned` rule.
    if (!row) throw new RoutineNotFoundError();
    return row;
  }

  async function update(
    ownerUserId: string,
    id: string,
    patch: RoutinePatch,
  ): Promise<Routine> {
    const existing = await loadOwned(ownerUserId, id);

    const values: Partial<typeof routines.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (patch.instruction !== undefined) {
      values.instruction = validInstruction(patch.instruction);
    }
    if (patch.channelId !== undefined) {
      values.channelId = await resolveChannel(
        ownerUserId,
        existing.agentId,
        patch.channelId,
      );
    }
    if (patch.enabled !== undefined) values.enabled = patch.enabled;

    const enabling = patch.enabled === true && !existing.enabled;
    if (enabling && (await countEnabled(ownerUserId)) >= MAX_ENABLED_ROUTINES) {
      throw new RoutineRefusedError(TOO_MANY_ENABLED);
    }

    const cron = patch.cron ?? existing.cron;
    const timezone = patch.timezone ?? existing.timezone;
    if (patch.cron !== undefined) values.cron = patch.cron;
    if (patch.timezone !== undefined) values.timezone = timezone;
    /*
     * Recomputed for a new cron, a new zone, and for switching back on. That last one is the subtle
     * case: a routine switched off in June still holds June's `next_run_at`, and enabling it without
     * recomputing hands the sweep a firing that was due months ago.
     */
    if (patch.cron !== undefined || patch.timezone !== undefined || enabling) {
      values.nextRunAt = nextRunFor(cron, timezone, new Date());
    }

    const [row] = await database
      .update(routines)
      .set(values)
      .where(and(eq(routines.id, id), eq(routines.ownerUserId, ownerUserId)))
      .returning();
    if (!row) throw new RoutineNotFoundError();
    return toRoutine(row);
  }

  return {
    update,

    async create(input) {
      const instruction = validInstruction(input.instruction);
      const timezone = input.timezone ?? "UTC";
      const channelId = await resolveChannel(
        input.ownerUserId,
        input.agentId,
        input.channelId,
      );
      const nextRunAt = nextRunFor(input.cron, timezone, new Date());

      if ((await countEnabled(input.ownerUserId)) >= MAX_ENABLED_ROUTINES) {
        throw new RoutineRefusedError(TOO_MANY_ENABLED);
      }

      const [row] = await database
        .insert(routines)
        .values({
          id: `routine_${crypto.randomUUID()}`,
          ownerUserId: input.ownerUserId,
          agentId: input.agentId,
          channelId,
          instruction,
          cron: input.cron,
          timezone,
          nextRunAt,
        })
        .returning();
      // An insert that returned nothing is not a missing routine, it is a broken database: loud
      // rather than folded into the not-found sentence a caller is meant to be able to trust.
      if (!row) throw new Error("inserting a routine returned no row");
      return toRoutine(row);
    },

    async listFor(ownerUserId) {
      /*
       * The last-run join reads `routine_runs`, which migration 0020 already created even though
       * nothing in THIS commit writes a row to it — the sweep's half does. The join is not dead code;
       * it is the half of the page that stays empty until the sweep lands.
       *
       * `distinct on (routine_id) ... order by started_at desc` gives one row per routine, the most
       * recent, in a single index scan of `routine_runs_by_routine_idx`. Reading the runs in a
       * separate statement rather than a lateral keeps the main query one flat join.
       */
      const rows = await database
        .select({
          routine: routines,
          channelName: channels.name,
          channelDeletedAt: channels.deletedAt,
          // A left join, and the id is selected to tell "no channel row at all" (a hard delete
          // somewhere else) from "soft-deleted": both mean the target is unusable, and neither is
          // allowed to hide the routine, which is why `channel_id` is not a foreign key.
          channelExists: channels.id,
        })
        .from(routines)
        .leftJoin(channels, eq(channels.id, routines.channelId))
        .where(eq(routines.ownerUserId, ownerUserId))
        .orderBy(desc(routines.createdAt), desc(routines.id));

      const routineIds = rows.map((row) => row.routine.id);
      const lastRuns = new Map<
        string,
        { status: RoutineRunOutcome | null; finishedAt: Date | null }
      >();
      if (routineIds.length > 0) {
        const runRows = await database
          .selectDistinctOn([routineRuns.routineId], {
            routineId: routineRuns.routineId,
            status: routineRuns.status,
            finishedAt: routineRuns.finishedAt,
          })
          .from(routineRuns)
          .where(inArray(routineRuns.routineId, routineIds))
          .orderBy(routineRuns.routineId, desc(routineRuns.startedAt));
        for (const run of runRows) {
          lastRuns.set(run.routineId, {
            status: run.status,
            finishedAt: run.finishedAt,
          });
        }
      }

      return rows.map(
        ({ routine, channelName, channelDeletedAt, channelExists }) => ({
          id: routine.id,
          agentId: routine.agentId,
          instruction: routine.instruction,
          schedule: describeCron(routine.cron),
          timezone: routine.timezone,
          enabled: routine.enabled,
          nextRunAt: routine.nextRunAt,
          channelId: routine.channelId,
          channelName,
          channelDeleted: channelExists === null || channelDeletedAt !== null,
          lastRun: lastRuns.get(routine.id) ?? null,
        }),
      );
    },

    async remove(ownerUserId, id) {
      // Hard, unlike a channel: nothing reads a routine that was deleted, and its runs cascade.
      const deleted = await database
        .delete(routines)
        .where(and(eq(routines.id, id), eq(routines.ownerUserId, ownerUserId)))
        .returning({ id: routines.id });
      if (deleted.length === 0) throw new RoutineNotFoundError();
    },

    async setEnabled(ownerUserId, id, enabled) {
      // One field through the same path, so enabling re-checks the cap and recomputes the next run
      // rather than having a second, quieter version of those rules.
      await update(ownerUserId, id, { enabled });
    },
  };
}
