/**
 * A person's standing instructions: keeping them, and guarding them.
 *
 * THIS FILE HAS TWO HALVES, AND THEY ARE SEPARABLE ON PURPOSE. The half below is the one a person
 * touches: create, list, change, remove, switch off. It is asked questions through a Bot, so every
 * refusal is a sentence a model can act on, every statement is guarded by the owner, and the owner is
 * never taken from an argument a model supplied. Its failures are one person's failures — a bad cron,
 * a channel they are not in — and none of them are about two things happening at once.
 *
 * The other half is the sweep's, and it starts at the marked boundary further down: the ledger read
 * on a clock (which routines are due, advancing the next run, opening and closing a run row).
 * Nothing there is asked a question by a person, and everything there is about concurrency — several
 * replicas reading the same due row in the same second. That is why the halves are worth telling
 * apart: only the second one has anything to do with concurrency, and only the second one needs to be
 * reasoned about as a race.
 *
 * WHERE IT LIVES. Routines and their runs are records in Intelligence's agent schedules now
 * (`schedules/`), not rows here. A person's reads and writes go to Intelligence; the sweep reads the
 * due routines from this instance's schedule directory, which Intelligence keeps fresh, and moves a
 * routine's clock with Intelligence's compare-and-set (`advance`). What used to be a row lock or an
 * advisory lock around a read and a write is a `withLocalLock` (`work/local-lock.ts`), because an
 * OpenBot transaction may never stay open across an Intelligence call. Only the sweep's heartbeat
 * (`routine_sweeps`) stays a row here: it is the sweeper's own bookmark, not anybody's data.
 *
 * NO CLAIM OR LEASE MACHINERY, EVER. Firing mechanics belong to the shared `work_items` queue in
 * `server/src/work/queue.ts`, which already owns `for update skip locked`, leases on the database's
 * clock, and an attempt count. A second lease grown on the routines table — a `claimed_by`, a
 * `locked_until` — is exactly the duplicated firing mechanism #235 exists to prevent: two half-right
 * implementations of the same hard thing, one of which nobody tests.
 */

import type { HeadlessWaiting } from "@openbot/toolkit/headless-tools";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  routineSweeps,
} from "../db/schema";
import {
  ScheduleAlreadyExistsError,
  ScheduleVersionConflictError,
} from "../schedules/client";
import { schedules } from "../schedules/directory";
import type { RoutineRecord, RoutineRunRecord } from "../schedules/types";
import { withLocalLock } from "../work/local-lock";
import { describeCron, nextOccurrence, ScheduleRefusedError } from "./schedule";

const SWEEP_ID = "routines";

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
/** Capped like audit payloads, because a failure is not a promise about length. */
export const MAX_RUN_ERROR = 400;
/**
 * How far back the failure count looks.
 *
 * Twice what the fatigue rule can act on, so the answer is never truncated where it matters, and
 * bounded because an unbounded read of a routine's whole history is the wrong shape for something
 * called on every failed firing, for ever: a routine that has failed nightly for a year would make
 * the count get slower exactly as the routine got worse.
 */
const FAILURE_SCAN_LIMIT = 20;

const NO_SHARED_CHANNEL =
  "I can only post into a channel you and I are both in.";
const NO_CHANNEL_AT_ALL =
  "We have no channel for me to post into. Start one and ask again.";
const INSTRUCTION_EMPTY = "A routine needs an instruction to carry out.";
const INSTRUCTION_TOO_LONG = `An instruction can be at most ${MAX_INSTRUCTION_CODE_POINTS} characters.`;
const TOO_MANY_ENABLED = `You already have ${MAX_ENABLED_ROUTINES} routines switched on. Switch one off before adding another.`;

/** How many names an ambiguity refusal reads out before it gives up and says "and others". */
const MAX_NAMED_CHANNELS = 5;

export type RoutineRunOutcome = "succeeded" | "failed" | "skipped" | "waiting";

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
   * The schedule in words — "Weekdays at 09:00" — for the shapes `describeCron` recognizes, and
   * the raw five-field expression for everything else. Prose where prose is possible; never a
   * value the client is expected to parse.
   *
   * Rendering cron exhaustively in English needs a real cron-description library, which this does
   * not carry. So a consumer must treat this as opaque display text: show it, never parse it, and
   * never compute a time from it. The authoritative next firing is `nextRunAt`, which the store
   * and the sweep both derive from the expression itself.
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

/**
 * One firing, and everything running it headlessly needs — the runner's read, and nobody else's.
 *
 * The owner comes back because the runner acts AS the owner: the channel it posts into, the thread
 * it continues and the grants the turn resolves are all that person's, and a runner that had to be
 * told whose they were would be a runner that could be told the wrong answer.
 */
export type RoutineRunContext = {
  routineId: string;
  ownerUserId: string;
  agentId: string;
  channelId: string;
  instruction: string;
  /**
   * Read at the moment of running, so a routine switched off after its firing was dispatched (or a
   * Run now that raced a pause) is closed as skipped instead of run. Paused never runs.
   */
  enabled?: boolean;
};

/** One row of a routine's run history. `status: null` is a run still in flight. */
export type RoutineRunSummary = {
  id: string;
  status: RoutineRunOutcome | null;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
  /** What started it: the schedule, a person's Run now, or an event trigger. */
  source: "schedule" | "run_now" | "trigger";
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
  /**
   * Run now (the page's Test): opens a run row for the owner's own enabled routine. Refused for a
   * paused routine and while another run of it is still open, so a double click is one run.
   */
  startManualRun(ownerUserId: string, id: string): Promise<{ runId: string }>;
  /** The owner's run history for one routine, newest first. */
  listRuns(
    ownerUserId: string,
    id: string,
    limit?: number,
  ): Promise<RoutineRunSummary[]>;

  /* The sweep's half. Deliberately not owner-scoped — see the boundary comment below. */

  /** Enabled routines whose next run has arrived, oldest due first. */
  dueRoutines(limit: number): Promise<{ id: string; nextRunAt: Date }[]>;
  /**
   * Compare-and-set the clock forward. False means another sweep got there first.
   *
   * The CAS always compares against `from`, the stamp the caller read. `computeFrom` is for the
   * stale-backlog case: a routine whose stamp is a month behind used to be stepped one occurrence
   * per pass — a fifteen-minute routine idle a month stayed silent another fortnight while its
   * clock caught up — so the sweep passes `now` here and one advance makes the clock current.
   */
  advanceNextRun(id: string, from: Date, computeFrom?: Date): Promise<boolean>;
  /** Open a run row. Its status stays null until something finishes it. */
  insertRun(routineId: string): Promise<{ runId: string }>;
  /**
   * Open the run for one firing under an id derived from the firing's work item, so a firing whose
   * worker died after opening it finds the same run again rather than opening a second. `finished`
   * says the earlier attempt already ran it to the end.
   */
  openRunFor(
    routineId: string,
    firingKey: string,
  ): Promise<{ runId: string; finished: boolean }>;
  /** The open runs of the routines that post into these channels, started within `withinMs`. */
  openRunsIn(
    channelIds: readonly string[],
    withinMs: number,
  ): Promise<
    {
      runId: string;
      routineId: string;
      channelId: string;
      ownerUserId: string;
      botId: string;
      startedAt: Date;
    }[]
  >;
  /**
   * The runner's read: an opened run row, joined to the routine it fires.
   *
   * Not owner-scoped, like everything else in this half — a run id is not something a person names,
   * it is something the queue hands back — and deliberately out of RoutineTools' reach: nothing a
   * model can call resolves a run id, so nothing a model can call gets an owner out of one. Null
   * means the routine was deleted between queueing and running, which takes its runs with it.
   */
  runContext(runId: string): Promise<RoutineRunContext | null>;
  /**
   * The sweep's read, like `dueRoutines` — not owner-scoped. A routine id here comes from a work
   * item's own payload, not from a person, so there is no owner to check it against. Answers exactly
   * what the consumer's re-read needs before firing: has the routine been deleted or switched off
   * since the offer. Null means deleted; otherwise `enabled` says the rest.
   */
  routineForFiring(
    id: string,
  ): Promise<{ id: string; enabled: boolean } | null>;
  /** Close a run row with its outcome, and the capped error when there was one. */
  finishRun(
    runId: string,
    status: RoutineRunOutcome,
    error?: string,
    waiting?: HeadlessWaiting,
  ): Promise<void>;
  /**
   * Close every run row that has sat open (`status is null`) longer than `olderThanMs` as
   * "skipped", with the same reason on all of them. Returns how many rows it closed.
   *
   * The sweep's reaper, and deliberately NOT scoped to one routine or one firing: it exists for the
   * rows nothing else can reach — a server that died mid-turn after the queue item was already
   * finished on the 202, or a dispatch-failure close that itself failed. The age bound is what keeps
   * it away from live work: a run younger than the cutoff may be a turn some server is still
   * running, and closing that row would make the real `finishRun` a silent no-op. "skipped" rather
   * than "failed" so an infrastructure death is not counted by the fatigue rule as the routine's own
   * failure.
   */
  reapAbandonedRuns(olderThanMs: number, error: string): Promise<number>;
  recordSweep(owner: string): Promise<void>;
  lastSweptAt(): Promise<Date | null>;
  /**
   * Switch a routine off because its own schedule refuses to advance, and record why.
   *
   * The sweep's off switch, not a person's, so it is not owner-scoped — like everything else in this
   * half, the id comes from the sweep's own read, not from a caller. A routine whose stored cron the
   * schedule module refuses (a row written before a validation existed, a hand-edited value) throws
   * out of `advanceNextRun` on every pass for ever: its clock never moves, it burns one of the
   * pass's due slots each time, and the owner sees a routine that silently stopped. Disabling it
   * ends that, and the finished "skipped" run row this writes is the announcement — the sweep has no
   * channel to speak in, and the run history is what `listFor` surfaces to the owner.
   */
  markUnschedulable(id: string, reason: string): Promise<void>;
  /** How many failures the routine has at the tail, for the fatigue rule to read. */
  consecutiveFailures(routineId: string): Promise<number>;
};

/** What drizzle hands the callback of `database.transaction`. */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** How often a write retries after Intelligence says the routine changed under it (a sweep moved its clock). */
const VERSION_RETRIES = 5;

function toRoutine(record: RoutineRecord): Routine {
  return {
    id: record.id,
    ownerUserId: record.ownerUserId,
    agentId: record.agentId,
    channelId: record.channelId,
    instruction: record.instruction,
    cron: record.cron,
    timezone: record.timezone,
    enabled: record.enabled,
    nextRunAt: record.nextRunAt,
    lastRunAt: record.lastRunAt,
    createdAt: record.createdAt,
  };
}

/** Capped in code points, like `validInstruction`, so an emoji-bearing error is never cut mid-pair. */
function capped(error: string): string {
  return Array.from(error).slice(0, MAX_RUN_ERROR).join("");
}

/**
 * The run id for one firing: the same firing, the same id, on every replica and every retry.
 * Hashed because a work item key holds a routine id and a minute, and a record id is at most 200
 * characters of a narrower alphabet.
 */
export function routineRunIdFor(firingKey: string): string {
  return `routine_run_${createHash("sha256").update(firingKey).digest("hex").slice(0, 40)}`;
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

/**
 * "A", "A, B", or five names and "and others" — a sentence, not a list a client renders.
 *
 * A name alone is not always enough to ask by: a real account turned up six channels all named
 * "General Assistant" with the same Bot, and a refusal built from names alone read "General
 * Assistant, General Assistant, … and others" — circular, because the person cannot answer it and
 * the model cannot map an answer back to a channelId. So every candidate whose name is shared by
 * another candidate gets its full id appended in parentheses; the id is the one thing the model can
 * pass back as `channelId` when names cannot tell two channels apart, and a person pasting it back
 * is ugly but functional. A candidate with a unique name stays bare, so the common case — and the
 * sentence's length — is unaffected by a collision elsewhere in the list.
 */
function nameThem(candidates: { id: string; name: string }[]): string {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.name, (counts.get(candidate.name) ?? 0) + 1);
  }
  const labels = candidates.map((candidate) =>
    (counts.get(candidate.name) ?? 0) > 1
      ? `${candidate.name} (${candidate.id})`
      : candidate.name,
  );
  if (labels.length <= MAX_NAMED_CHANNELS) return labels.join(", ");
  return [...labels.slice(0, MAX_NAMED_CHANNELS), "and others"].join(", ");
}

export function createRoutineStore(database: Database): RoutineStore {
  /**
   * Where the reply lands, decided here rather than at the tool boundary.
   *
   * Discovery confirmed the conversation's own channel is not reachable at the tool layer, so a model
   * asked to make a routine either names a channel or names nothing. Both are resolved against what
   * the owner and this agent actually share, which is the only check that stops a routine posting
   * one person's summary into another person's conversation. Channels are this deployment's own
   * rows, so this is still a query here.
   */
  async function resolveChannel(
    ownerUserId: string,
    agentId: string,
    channelId?: string,
    handle: Database | Transaction = database,
  ): Promise<string> {
    if (channelId !== undefined) {
      // One query for all four conditions: the channel exists, it is not deleted, the owner is a
      // member, and this agent is in it. Any miss is the same refusal, because telling them apart
      // would tell a caller which channel ids exist.
      const rows = await handle
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
    const candidates = await handle
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
          candidates,
        )}. Say which one.`,
      );
    }
    return only.id;
  }

  /**
   * This person's live routines as Intelligence holds them now, not as this instance last heard.
   * Every write that counts or checks reads this, so a routine made a moment ago on another replica
   * is counted even before its announcement arrives here.
   */
  async function ownedNow(ownerUserId: string): Promise<RoutineRecord[]> {
    const { items } = await schedules().client.all("routines", {
      ownerUserId,
    });
    for (const record of items) schedules().remember("routines", record);
    return items.filter((record) => record.deletedAt === null);
  }

  /** How many of this person's routines are switched on. The cap counts these, not records. */
  async function countEnabled(ownerUserId: string): Promise<number> {
    return (await ownedNow(ownerUserId)).filter((record) => record.enabled)
      .length;
  }

  /**
   * Serialize this owner's cap-guarded writes: count and write under one lock.
   *
   * The cap used to be a bare count-then-write, and two concurrent creates that both counted 19 both
   * inserted — the person held 21. The lock is the person's, so their creates and switch-ons take
   * turns; the count inside it reads Intelligence, which every replica writes to.
   */
  async function withEnabledCapLock<T>(
    ownerUserId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return withLocalLock(database, `routine-cap:${ownerUserId}`, work, {
      ttlMs: 60_000,
      waitMs: 30_000,
    });
  }

  /** The person's own live routine, read from Intelligence. Anybody else's does not exist. */
  async function loadOwned(
    ownerUserId: string,
    id: string,
  ): Promise<RoutineRecord> {
    const record = await schedules().refresh("routines", id);
    // A routine that is not yours is a routine that does not exist: the `setPinned` rule.
    if (
      !record ||
      record.deletedAt !== null ||
      record.ownerUserId !== ownerUserId
    )
      throw new RoutineNotFoundError();
    return record;
  }

  /**
   * Apply `changes` derived from the record as Intelligence holds it now, again if a sweep moved the
   * routine's clock in between. The old row lock made a person's edit wait for the sweep's update;
   * here the edit is redone on the newer version instead.
   */
  async function rewrite(
    ownerUserId: string,
    id: string,
    derive: (
      current: RoutineRecord,
    ) => Promise<Parameters<ReturnType<typeof schedules>["update"]>[3]>,
  ): Promise<RoutineRecord> {
    for (let attempt = 1; ; attempt++) {
      const current = await loadOwned(ownerUserId, id);
      const changes = await derive(current);
      try {
        return await schedules().update(
          "routines",
          id,
          current.version,
          changes,
        );
      } catch (error) {
        if (
          error instanceof ScheduleVersionConflictError &&
          attempt < VERSION_RETRIES
        )
          continue;
        throw error;
      }
    }
  }

  async function update(
    ownerUserId: string,
    id: string,
    patch: RoutinePatch,
  ): Promise<Routine> {
    const record = await withEnabledCapLock(ownerUserId, () =>
      rewrite(ownerUserId, id, async (existing) => {
        const changes: Partial<RoutineRecord> = {};
        if (patch.instruction !== undefined)
          changes.instruction = validInstruction(patch.instruction);
        if (patch.channelId !== undefined)
          changes.channelId = await resolveChannel(
            ownerUserId,
            existing.agentId,
            patch.channelId,
          );
        if (patch.enabled !== undefined) changes.enabled = patch.enabled;

        const enabling = patch.enabled === true && !existing.enabled;
        const cron = patch.cron ?? existing.cron;
        const timezone = patch.timezone ?? existing.timezone;
        if (patch.cron !== undefined) changes.cron = patch.cron;
        if (patch.timezone !== undefined) changes.timezone = timezone;
        /*
         * Recomputed for a new cron, a new zone, and for switching back on. That last one is the
         * subtle case: a routine switched off in June still holds June's `nextRunAt`, and enabling
         * it without recomputing hands the sweep a firing that was due months ago.
         */
        if (
          patch.cron !== undefined ||
          patch.timezone !== undefined ||
          enabling
        )
          changes.nextRunAt = nextRunFor(cron, timezone, new Date());

        if (
          enabling &&
          (await countEnabled(ownerUserId)) >= MAX_ENABLED_ROUTINES
        )
          throw new RoutineRefusedError(TOO_MANY_ENABLED);
        // Switching back on starts a new streak; see `consecutiveFailures`.
        if (enabling) changes.enabledAt = new Date();
        return changes;
      }),
    );
    return toRoutine(record);
  }

  /** One finish of an open run, or nothing when it already finished: a run finishes once. */
  async function closeRun(
    runId: string,
    status: RoutineRunOutcome,
    error: string | undefined,
    waiting: HeadlessWaiting | undefined,
  ): Promise<boolean> {
    const client = schedules().client;
    for (let attempt = 1; ; attempt++) {
      const run = await client.get("routine-runs", runId);
      // A run finishes once. The second call — succeeded, then a downstream throw whose catch calls
      // finishRun("failed") — changes nothing, rather than relabeling what the first recorded.
      if (!run || run.status !== null) return false;
      try {
        await client.update("routine-runs", runId, run.version, {
          status,
          finishedAt: new Date(),
          ...(waiting
            ? { waiting: waiting as unknown as Record<string, unknown> }
            : {}),
          // Left alone rather than nulled when there was no error.
          ...(error === undefined ? {} : { error: capped(error) }),
        });
        return true;
      } catch (failure) {
        if (
          failure instanceof ScheduleVersionConflictError &&
          attempt < VERSION_RETRIES
        )
          continue;
        throw failure;
      }
    }
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

      // Counted and created under the owner's cap lock, so two creates racing at 19 cannot both
      // count 19 and hand the person 21: the second waits, counts 20, and gets the refusal.
      const record = await withEnabledCapLock(input.ownerUserId, async () => {
        if ((await countEnabled(input.ownerUserId)) >= MAX_ENABLED_ROUTINES)
          throw new RoutineRefusedError(TOO_MANY_ENABLED);
        const now = new Date();
        return schedules().create("routines", {
          id: `routine_${crypto.randomUUID()}`,
          ownerUserId: input.ownerUserId,
          agentId: input.agentId,
          channelId,
          instruction,
          cron: input.cron,
          timezone,
          enabled: true,
          enabledAt: now,
          nextRunAt,
          lastRunAt: null,
        });
      });
      return toRoutine(record);
    },

    async listFor(ownerUserId) {
      // Intelligence's answer, not this instance's memory: a page shows what the person just did,
      // whichever replica they did it on. Newest first, as the page always listed them.
      const owned = (await ownedNow(ownerUserId)).sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          (right.id < left.id ? -1 : right.id > left.id ? 1 : 0),
      );
      if (owned.length === 0) return [];

      const channelIds = [...new Set(owned.map((record) => record.channelId))];
      // A channel row gone entirely (a hard delete somewhere else) and a soft-deleted one both make
      // the target unusable, and neither is allowed to hide the routine.
      const channelRows = await database
        .select({
          id: channels.id,
          name: channels.name,
          deletedAt: channels.deletedAt,
        })
        .from(channels)
        .where(inArray(channels.id, channelIds));
      const channelById = new Map(channelRows.map((row) => [row.id, row]));

      const lastRuns = new Map<
        string,
        { status: RoutineRunOutcome | null; finishedAt: Date | null }
      >();
      for (const run of await schedules().client.latestRoutineRuns(
        owned.map((record) => record.id),
      ))
        lastRuns.set(run.routineId, {
          status: run.status,
          finishedAt: run.finishedAt,
        });

      return owned.map((routine) => {
        const channel = channelById.get(routine.channelId);
        return {
          id: routine.id,
          agentId: routine.agentId,
          instruction: routine.instruction,
          schedule: describeCron(routine.cron),
          timezone: routine.timezone,
          enabled: routine.enabled,
          nextRunAt: routine.nextRunAt,
          channelId: routine.channelId,
          channelName: channel?.name ?? null,
          channelDeleted: !channel || channel.deletedAt !== null,
          lastRun: lastRuns.get(routine.id) ?? null,
        };
      });
    },

    async remove(ownerUserId, id) {
      const record = await loadOwned(ownerUserId, id);
      /*
       * Deleted in Intelligence, where a deleted routine stays readable and stops firing at once:
       * the sweep reads only live, enabled routines. Its runs stay, as history; only a purge (the
       * Bot or the person removed for good) removes them.
       */
      await schedules()
        .remove("routines", id, undefined, record.version)
        .catch(async (error: unknown) => {
          // A sweep moved its clock between the read and the delete: delete whatever is there now.
          if (!(error instanceof ScheduleVersionConflictError)) throw error;
          await schedules().remove("routines", id);
        });
    },

    async startManualRun(ownerUserId, id) {
      const routine = await loadOwned(ownerUserId, id);
      if (!routine.enabled)
        throw new RoutineRefusedError(
          "This routine is paused, and paused routines never run. Switch it on first.",
        );
      // Serialized per routine so two clicks cannot both see "nothing open" and both open a run.
      return withLocalLock(database, `routine-run:${id}`, async () => {
        const client = schedules().client;
        const { items: open } = await client.page(
          "routine-runs",
          {
            routineId: id,
            status: "open",
            // Younger than the reaper's cutoff: an older open run is abandoned, not running.
            startedAfter: new Date(Date.now() - 10 * 60_000),
          },
          null,
          1,
        );
        if (open.length > 0)
          throw new RoutineRefusedError(
            "This routine is already running. Wait for that run to finish.",
          );
        const run = await client.create("routine-runs", {
          id: `routine_run_${crypto.randomUUID()}`,
          routineId: id,
          source: "run_now",
          status: null,
          startedAt: new Date(),
          finishedAt: null,
          waiting: null,
          error: null,
        });
        return { runId: run.id };
      });
    },

    async listRuns(ownerUserId, id, limit = 50) {
      await loadOwned(ownerUserId, id);
      const { items } = await schedules().client.page(
        "routine-runs",
        { routineId: id },
        null,
        Math.min(Math.max(limit, 1), 100),
      );
      return items.map((run) => ({
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        error: run.error,
        source: run.source,
      }));
    },

    async setEnabled(ownerUserId, id, enabled) {
      // One field through the same path, so enabling re-checks the cap and recomputes the next run
      // rather than having a second, quieter version of those rules.
      await update(ownerUserId, id, { enabled });
    },

    /* =========================================================================================
     * THE SWEEP'S HALF STARTS HERE.
     *
     * Nobody asks a question below: a sweep on a clock reads the ledger, and every method has to be
     * read as a race between replicas. The due list comes from this instance's schedule directory,
     * which Intelligence keeps fresh; the clock moves only through Intelligence's compare-and-set,
     * so however stale one replica's copy is, exactly one replica moves a routine past a stamp.
     * ========================================================================================= */

    async dueRoutines(limit) {
      /*
       * NOT OWNER-SCOPED, ON PURPOSE. The sweep has no owner: it looks at every person's routines,
       * which is exactly why it returns ids and stamps and nothing a person wrote. From memory, so a
       * sweep every minute on every replica costs Intelligence nothing.
       */
      const now = Date.now();
      return (
        schedules()
          .live("routines")
          .filter(
            (record) => record.enabled && record.nextRunAt.getTime() <= now,
          )
          // Oldest due first, so a backlog drains in the order it built up; the id breaks ties.
          .sort(
            (left, right) =>
              left.nextRunAt.getTime() - right.nextRunAt.getTime() ||
              (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
          )
          .slice(0, limit)
          .map((record) => ({ id: record.id, nextRunAt: record.nextRunAt }))
      );
    },

    async advanceNextRun(id, from, computeFrom) {
      const record =
        schedules().peek("routines", id) ??
        (await schedules().find("routines", id));
      if (!record || record.deletedAt !== null) return false;
      // `computeFrom` moves only where the next occurrence is measured from, never what the
      // compare-and-set compares against: the sweep uses it to make a month-stale clock current in
      // one pass, and the guarantee that exactly one replica moves the routine survives that.
      const next = nextRunFor(
        record.cron,
        record.timezone,
        computeFrom ?? from,
      );
      /*
       * THE COMPARE-AND-SET IS THE WHOLE MECHANISM. Intelligence moves the clock only when it still
       * reads `from`: however many replicas see the same due routine in the same second, exactly one
       * succeeds and the rest learn the newer clock. And it happens AFTER the run is offered; the
       * offer key carries the minute the firing was due, so a re-offer of the same stamp collides on
       * `work_items`' `(kind, key)` rather than queueing a second run (see sweep.ts).
       */
      return (await schedules().advance("routines", id, from, next)) !== null;
    },

    async insertRun(routineId) {
      const run = await schedules().client.create("routine-runs", {
        id: `routine_run_${crypto.randomUUID()}`,
        routineId,
        source: "schedule",
        status: null,
        startedAt: new Date(),
        finishedAt: null,
        waiting: null,
        error: null,
      });
      return { runId: run.id };
    },

    async openRunFor(routineId, firingKey) {
      const runId = routineRunIdFor(firingKey);
      const client = schedules().client;
      try {
        await client.create(
          "routine-runs",
          {
            id: runId,
            routineId,
            source: "schedule",
            status: null,
            startedAt: new Date(),
            finishedAt: null,
            waiting: null,
            error: null,
          },
          `openbot:routine-run:${runId}`,
        );
        return { runId, finished: false };
      } catch (error) {
        if (!(error instanceof ScheduleAlreadyExistsError)) throw error;
        // This firing's run was opened by an attempt that died: the same run, not a second one.
        const run = await client.get("routine-runs", runId);
        return { runId, finished: run !== null && run.status !== null };
      }
    },

    async openRunsIn(channelIds, withinMs) {
      const wanted = new Set(channelIds);
      const routinesHere = schedules()
        .live("routines")
        .filter((record) => wanted.has(record.channelId));
      // Most conversations have no routine at all, and they cost Intelligence nothing here.
      if (routinesHere.length === 0) return [];
      const byId = new Map(routinesHere.map((record) => [record.id, record]));
      const { items } = await schedules().client.all("routine-runs", {
        routineId: [...byId.keys()],
        status: "open",
        startedAfter: new Date(Date.now() - withinMs),
      });
      return items.flatMap((run) => {
        const routine = byId.get(run.routineId);
        return routine
          ? [
              {
                runId: run.id,
                routineId: routine.id,
                channelId: routine.channelId,
                ownerUserId: routine.ownerUserId,
                botId: routine.agentId,
                startedAt: run.startedAt,
              },
            ]
          : [];
      });
    },

    async runContext(runId) {
      const run = await schedules().client.get("routine-runs", runId);
      if (!run) return null;
      // Read now rather than from memory: a routine switched off or deleted a moment ago on another
      // replica must not run. A deleted routine reads as no context, as when its runs went with it.
      const routine = await schedules().refresh("routines", run.routineId);
      if (!routine || routine.deletedAt !== null) return null;
      return {
        routineId: routine.id,
        ownerUserId: routine.ownerUserId,
        agentId: routine.agentId,
        channelId: routine.channelId,
        instruction: routine.instruction,
        enabled: routine.enabled,
      };
    },

    async routineForFiring(id) {
      // Intelligence's answer, not memory's: the consumer's re-read before firing is exactly the
      // question "has it been deleted or switched off since the offer", asked of the source.
      const routine = await schedules().refresh("routines", id);
      if (!routine || routine.deletedAt !== null) return null;
      return { id: routine.id, enabled: routine.enabled };
    },

    async finishRun(runId, status, error, waiting) {
      await closeRun(runId, status, error, waiting);
    },

    async recordSweep(owner) {
      await database
        .insert(routineSweeps)
        .values({ id: SWEEP_ID, owner, sweptAt: sql`now()` })
        .onConflictDoUpdate({
          target: routineSweeps.id,
          set: { owner, sweptAt: sql`now()` },
        });
    },

    async lastSweptAt() {
      const [row] = await database
        .select({ sweptAt: routineSweeps.sweptAt })
        .from(routineSweeps)
        .where(eq(routineSweeps.id, SWEEP_ID))
        .limit(1);
      return row?.sweptAt ?? null;
    },

    async reapAbandonedRuns(olderThanMs, error) {
      /*
       * Every open run older than the cutoff is abandoned: a server that died mid-turn after the
       * queue item was already finished, or a dispatch-failure close that itself failed. The age
       * bound keeps this away from live work. "skipped" rather than "failed" so an infrastructure
       * death is not counted by the fatigue rule as the routine's own failure.
       */
      const { items } = await schedules().client.all("routine-runs", {
        status: "open",
        startedBefore: new Date(Date.now() - olderThanMs),
      });
      let closed = 0;
      for (const run of items)
        if (await closeRun(run.id, "skipped", error, undefined)) closed += 1;
      return closed;
    },

    async markUnschedulable(id, reason) {
      const routine = await schedules().refresh("routines", id);
      // Deleted between the sweep's read and this write: gone is gone.
      if (!routine || routine.deletedAt !== null) return;
      for (let attempt = 1; ; attempt++) {
        const current = await schedules().refresh("routines", id);
        if (!current || current.deletedAt !== null) return;
        try {
          await schedules().update("routines", id, current.version, {
            enabled: false,
          });
          break;
        } catch (error) {
          if (
            error instanceof ScheduleVersionConflictError &&
            attempt < VERSION_RETRIES
          )
            continue;
          throw error;
        }
      }
      // A finished "skipped" run rather than "failed": no turn ran, so the fatigue rule must not
      // count this, and skipped is exactly the vocabulary for a firing that never became a turn.
      const now = new Date();
      await schedules().client.create("routine-runs", {
        id: `routine_run_${crypto.randomUUID()}`,
        routineId: id,
        source: "schedule",
        status: "skipped",
        startedAt: now,
        finishedAt: now,
        waiting: null,
        error: capped(reason),
      });
    },

    async consecutiveFailures(routineId) {
      const routine = await schedules().find("routines", routineId);
      if (!routine) return 0;
      /*
       * Bounded, then counted here: read on every failed firing, for ever, and the rule only acts on
       * the first handful. Finished runs only, and A SKIP IS NOT A FAILURE AND DOES NOT BREAK THE
       * STREAK (it means no turn ran), so skips are left out of the window rather than eating slots
       * in it. ONLY SINCE IT WAS LAST SWITCHED ON, so the first run after a person's fix does not
       * switch it straight off again.
       */
      const { items } = await schedules().client.page(
        "routine-runs",
        {
          routineId,
          status: ["succeeded", "failed", "waiting"],
          startedAfter: new Date(routine.enabledAt.getTime() - 1),
        },
        null,
        FAILURE_SCAN_LIMIT,
      );
      let failures = 0;
      for (const run of items as RoutineRunRecord[]) {
        if (run.status !== "failed") break;
        failures += 1;
      }
      return failures;
    },
  };
}

/**
 * A routine firing that stopped to wait on a person (an approval, a sign-in) is finished once that
 * person's answer has run: every run still `waiting` on that request becomes `succeeded`.
 *
 * Waiting runs are few at any moment, so they are read and matched here rather than asked of
 * Intelligence by a field inside `waiting`. Each is moved under its version, so a run something else
 * finished a moment ago is left as that left it.
 */
export async function finishRoutineRunsWaitingOn(
  field: "approvalId" | "signInRequestId",
  requestId: string,
): Promise<number> {
  const client = schedules().client;
  const { items } = await client.all("routine-runs", { status: "waiting" });
  let finished = 0;
  for (const run of items) {
    if (run.waiting?.[field] !== requestId) continue;
    try {
      await client.update("routine-runs", run.id, run.version, {
        status: "succeeded",
        finishedAt: new Date(),
        error: null,
        waiting: null,
      });
      finished += 1;
    } catch (error) {
      if (!(error instanceof ScheduleVersionConflictError)) throw error;
    }
  }
  return finished;
}

/** This person's live routines with this Bot, as Intelligence holds them now. */
export async function routinesOf(
  ownerUserId: string,
  agentId: string,
): Promise<RoutineRecord[]> {
  const { items } = await schedules().client.all("routines", {
    ownerUserId,
    agentId,
  });
  return items.filter((record) => record.deletedAt === null);
}

/**
 * Remove this person's routines with this Bot for good, runs included, as a reset of the Bot does:
 * the person starts over, so nothing of the old routines stays behind. Returns how many there were.
 */
export async function purgeRoutinesOf(
  ownerUserId: string,
  agentId: string,
): Promise<number> {
  const { items } = await schedules().client.all("routines", {
    ownerUserId,
    agentId,
    includeDeleted: true,
  });
  let live = 0;
  for (const record of items) {
    if (record.deletedAt === null) live += 1;
    await schedules().purge("routines", record.id);
  }
  return live;
}
