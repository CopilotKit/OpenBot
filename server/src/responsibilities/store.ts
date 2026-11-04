/**
 * A person's responsibilities, the events that wake them, and the ledger of their runs.
 *
 * WHERE IT LIVES. Responsibilities, events and runs are records in Intelligence's agent schedules
 * (`schedules/`), not rows here. A responsibility is read through this instance's schedule directory
 * (Intelligence keeps it fresh) and every write that decides something reads Intelligence first; the
 * run history is read from Intelligence when a page asks for it. What used to be a row lock on the
 * responsibility around a read and a write is `withLocalLock("responsibility:<id>")`
 * (`work/local-lock.ts`), because an OpenBot transaction may never stay open across an Intelligence
 * call; each record still moves under its version (If-Match), so a write that slipped past the lock
 * is refused rather than lost. Only the work queue (`work_items`) stays here: it is in-flight work.
 *
 * AN EVENT IS NEVER LOST ONCE ACCEPTED, AND A RUN JOB NEVER EXISTS BEFORE ITS RUN. An accepted event
 * is first written as a local `responsibility.ingest` work item carrying it (the outbox), leased to
 * the caller, and executed at once: the event is created in Intelligence (its source id is the dedupe
 * rule), then one run per matching responsibility under an id derived from the pair (the run rule
 * makes a retry the same run), and only then the `responsibility.run` items. A process that dies part
 * way leaves the ingest item behind and the work loop (`recover`) finishes it. Resuming a waiting run
 * moves the run back to `queued` first and offers its item after; `recover` also offers an item for
 * any queued run left without one, so a crash between the two never strands a run.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { workItems } from "../db/schema/work";
import {
  ScheduleAlreadyExistsError,
  ScheduleConflictError,
  ScheduleVersionConflictError,
} from "../schedules/client";
import { schedules } from "../schedules/directory";
import type {
  ResponsibilityRecord,
  ResponsibilityRunRecord,
  ScheduleChanges,
} from "../schedules/types";
import { withLocalLock } from "../work/local-lock";
import { createWorkQueue } from "../work/queue";
import { RESPONSIBILITY_RUN_KIND } from "./engine";
import {
  parseResponsibilityEvent,
  parseResponsibilityInput,
  parseResponsibilityPatch,
  type Responsibility,
  type ResponsibilityContinuation,
  type ResponsibilityEvent,
  type ResponsibilityEventResult,
  ResponsibilityNotFoundError,
  ResponsibilityRefusedError,
  type ResponsibilityRun,
  type ResponsibilityStore,
  type ResponsibilitySubscription,
} from "./types";

export type ResponsibilityTargetResolver = (
  ownerUserId: string,
  agentId: string,
  channelId: string,
) => Promise<{ threadId: string } | null>;

/** The outbox: one accepted event, until its event, runs and run items exist. */
export const RESPONSIBILITY_INGEST_KIND = "responsibility.ingest";

/** Long enough for an ingest's handful of Intelligence calls; a dead process frees it after this. */
const INGEST_LEASE_MS = 60_000;
/** How long the work loop waits before trying a failed ingest again. */
const INGEST_RETRY_MS = 5_000;
const INGEST_MAX_ATTEMPTS = 10;
/** A queued run younger than this may be a resume between its write and its offer; left alone. */
const STRANDED_AFTER_MS = 2 * 60_000;
/** How often the work loop looks for queued runs without an item. It reads Intelligence. */
const RECONCILE_EVERY_MS = 60_000;
/**
 * How long a finished ingest item is kept. Its key is the event's own id, so a later offer never
 * collides with it; it is kept only to be read when a delivery is asked about.
 */
const INGEST_FINISHED_KEPT_MS = 24 * 60 * 60_000;
/** How long an ingest that gave up stays readable, with its last error, before it is cleared. */
const INGEST_GAVE_UP_KEPT_MS = 30 * 24 * 60 * 60_000;
/** How often a write is redone after Intelligence says the record changed under it. */
const VERSION_RETRIES = 5;

/** What the work loop calls on every pass. Not part of the store a person or a Bot uses. */
export type ResponsibilityRecovery = {
  /**
   * Finish the ingests a process accepted and did not see through, and offer an item for any queued
   * run that has none. Returns what it did.
   */
  recover(input: {
    owner: string;
  }): Promise<{ ingests: number; requeued: string[] }>;
};

function toResponsibility(record: ResponsibilityRecord): Responsibility {
  return {
    id: record.id,
    ownerUserId: record.ownerUserId,
    agentId: record.agentId,
    channelId: record.channelId,
    threadId: record.threadId,
    title: record.title,
    instruction: record.instruction,
    successCriteria: record.successCriteria,
    subscriptions: record.subscriptions as ResponsibilitySubscription[],
    status: record.status,
    progress: record.progress,
    lastResult: record.lastResult,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
  };
}

function toRun(record: ResponsibilityRunRecord): ResponsibilityRun {
  return {
    id: record.id,
    responsibilityId: record.responsibilityId,
    eventId: record.eventId,
    status: record.status,
    replyText: record.replyText,
    error: record.error,
    waiting: record.waiting as ResponsibilityRun["waiting"],
    continuation: record.continuation as ResponsibilityContinuation | null,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    createdAt: record.createdAt,
  };
}

/**
 * The run for one responsibility woken by one event: the same pair, the same id, on every replica
 * and every retry. Shaped like a UUID, as run ids always were.
 */
export function responsibilityRunIdFor(
  responsibilityId: string,
  eventId: string,
): string {
  const hex = createHash("sha256")
    .update(`${responsibilityId}\u001f${eventId}`)
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/** The item that runs a queued run: the run's id the first time, its version after a resume. */
export function responsibilityRunItemKey(
  run: Pick<ResponsibilityRunRecord, "id" | "version">,
): string {
  return run.version === 1 ? run.id : `${run.id}:resume:${run.version}`;
}

/** Whether a responsibility listens for this event. The rule the store always applied. */
function wakes(goal: ResponsibilityRecord, event: ResponsibilityEvent) {
  return (
    (event.source === "manual" && event.responsibilityId === goal.id) ||
    (event.triggerId !== undefined && event.responsibilityId === goal.id) ||
    goal.subscriptions.some(
      (subscription) =>
        subscription.source === event.source &&
        (subscription.eventType === event.type ||
          subscription.eventType === "*"),
    )
  );
}

export function createResponsibilityStore(
  database: Database,
  options: { resolveTarget: ResponsibilityTargetResolver },
): ResponsibilityStore & ResponsibilityRecovery {
  const queue = createWorkQueue(database);
  let reconciledAt = 0;

  /** Serialize every decision about one responsibility and its runs, across replicas. */
  const guarded = <T>(responsibilityId: string, work: () => Promise<T>) =>
    withLocalLock(database, `responsibility:${responsibilityId}`, work, {
      ttlMs: 60_000,
      waitMs: 30_000,
    });

  /** The responsibility as Intelligence holds it now, or null when it is gone. */
  async function current(id: string): Promise<ResponsibilityRecord | null> {
    const record = await schedules().refresh("responsibilities", id);
    return record && record.deletedAt === null ? record : null;
  }

  /** The person's own responsibility, read from Intelligence. Anybody else's does not exist. */
  async function owned(
    ownerUserId: string,
    id: string,
  ): Promise<ResponsibilityRecord> {
    const record = await current(id);
    if (!record || record.ownerUserId !== ownerUserId)
      throw new ResponsibilityNotFoundError();
    return record;
  }

  /**
   * Apply `changes` derived from the responsibility as Intelligence holds it now, again if it changed
   * in between. The old row lock made a second writer wait; here the second writer redoes its change
   * on the newer version.
   */
  async function rewrite(
    ownerUserId: string,
    id: string,
    derive: (
      existing: ResponsibilityRecord,
    ) => Promise<ScheduleChanges<"responsibilities">>,
  ): Promise<ResponsibilityRecord> {
    for (let attempt = 1; ; attempt++) {
      const existing = await owned(ownerUserId, id);
      const changes = await derive(existing);
      try {
        return await schedules().update(
          "responsibilities",
          id,
          existing.version,
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

  /** Move a run under its version; on a conflict read it again and let `derive` decide again. */
  async function moveRun(
    runId: string,
    derive: (
      run: ResponsibilityRunRecord,
    ) => ScheduleChanges<"responsibility-runs"> | null,
  ): Promise<ResponsibilityRunRecord | null> {
    const client = schedules().client;
    for (let attempt = 1; ; attempt++) {
      const run = await client.get("responsibility-runs", runId);
      if (!run) return null;
      const changes = derive(run);
      if (!changes) return null;
      try {
        return await client.update(
          "responsibility-runs",
          runId,
          run.version,
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

  /**
   * Everything one accepted event does, safe to run again: the event (its source id decides a
   * duplicate), a run per responsibility it wakes, and each run's item. `eventId` is chosen when the
   * event is accepted, so an existing event with that id is this ingest's own, from an attempt that
   * died; one with another id is the same delivery arriving twice.
   */
  async function processIngest(
    eventId: string,
    event: ResponsibilityEvent,
  ): Promise<ResponsibilityEventResult> {
    const client = schedules().client;
    let resumed = false;
    try {
      await client.create(
        "responsibility-events",
        {
          id: eventId,
          ownerUserId: event.ownerUserId,
          source: event.source,
          externalId: event.externalId,
          type: event.type,
          payload: event.payload,
        },
        `openbot:responsibility-event:${eventId}`,
      );
    } catch (error) {
      if (error instanceof ScheduleAlreadyExistsError) resumed = true;
      else if (
        error instanceof ScheduleConflictError &&
        error.existingId &&
        error.existingId !== eventId
      ) {
        const { items } = await client.all("responsibility-runs", {
          eventId: error.existingId,
        });
        return {
          eventId: error.existingId,
          duplicate: true,
          runIds: items.map((run) => run.id),
        };
      } else throw error;
    }
    const candidates = event.responsibilityId
      ? [await current(event.responsibilityId)].filter(
          (goal): goal is ResponsibilityRecord =>
            goal !== null &&
            goal.ownerUserId === event.ownerUserId &&
            goal.status === "active",
        )
      : (
          await client.all("responsibilities", {
            ownerUserId: event.ownerUserId,
            status: "active",
          })
        ).items;
    const runIds = candidates
      .filter((goal) => wakes(goal, event))
      .map((goal) => {
        const runId = responsibilityRunIdFor(goal.id, eventId);
        return { runId, responsibilityId: goal.id };
      });
    for (const { runId, responsibilityId } of runIds) {
      try {
        await client.create(
          "responsibility-runs",
          {
            id: runId,
            responsibilityId,
            eventId,
            status: "queued",
            replyText: null,
            error: null,
            waiting: null,
            continuation: null,
            startedAt: null,
            finishedAt: null,
          },
          `openbot:responsibility-run:${runId}`,
        );
      } catch (error) {
        // An attempt that died already made it: the same run, not a second one.
        if (
          !(error instanceof ScheduleAlreadyExistsError) &&
          !(error instanceof ScheduleConflictError)
        )
          throw error;
      }
    }
    const ids = runIds.map(({ runId }) => runId);
    if (resumed) {
      // The attempt that died may have woken a responsibility that has since been paused.
      const { items } = await client.all("responsibility-runs", { eventId });
      for (const run of items) if (!ids.includes(run.id)) ids.push(run.id);
    }
    for (const runId of ids)
      await queue.offer({
        kind: RESPONSIBILITY_RUN_KIND,
        key: runId,
        payload: { runId },
      });
    return { eventId, duplicate: false, runIds: ids };
  }

  /** The ingest items a process accepted and did not finish, taken over and seen through. */
  async function retryIngests(owner: string): Promise<number> {
    const items = await queue.claim({
      kind: RESPONSIBILITY_INGEST_KIND,
      owner,
      leaseMs: INGEST_LEASE_MS,
      limit: 10,
      maxAttempts: INGEST_MAX_ATTEMPTS,
    });
    for (const item of items) {
      const { eventId, event } = item.payload as {
        eventId: string;
        event: ResponsibilityEvent;
      };
      try {
        await processIngest(eventId, event);
        await queue.finish({
          kind: RESPONSIBILITY_INGEST_KIND,
          key: item.key,
          owner,
        });
      } catch (error) {
        await queue.release({
          kind: RESPONSIBILITY_INGEST_KIND,
          key: item.key,
          owner,
          delayMs: INGEST_RETRY_MS * item.attempts,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return items.length;
  }

  /**
   * Queued runs with no item waiting to run them: a process died between moving a run back to
   * queued and offering its item. Offered under the key that move would have used, so a late offer
   * by the process that moved it is the same item.
   */
  async function requeueStrandedRuns(): Promise<string[]> {
    const { items } = await schedules().client.all("responsibility-runs", {
      status: "queued",
    });
    const cutoff = Date.now() - STRANDED_AFTER_MS;
    const stale = items.filter((run) => run.updatedAt.getTime() < cutoff);
    if (stale.length === 0) return [];
    const live = await database
      .select({ runId: sql<string>`${workItems.payload}->>'runId'` })
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, RESPONSIBILITY_RUN_KIND),
          isNull(workItems.finishedAt),
          inArray(
            sql<string>`${workItems.payload}->>'runId'`,
            stale.map((run) => run.id),
          ),
        ),
      );
    const waiting = new Set(live.map((row) => row.runId));
    const requeued: string[] = [];
    for (const run of stale) {
      if (waiting.has(run.id)) continue;
      const offered = await queue.offer({
        kind: RESPONSIBILITY_RUN_KIND,
        key: responsibilityRunItemKey(run),
        payload: { runId: run.id },
      });
      if (offered === "queued") requeued.push(run.id);
    }
    if (requeued.length > 0)
      console.warn(
        JSON.stringify({
          type: "responsibility-runs-requeued",
          note: "Queued runs had no item to run them; each was offered one.",
          runIds: requeued,
        }),
      );
    return requeued;
  }

  const store: ResponsibilityStore & ResponsibilityRecovery = {
    async create(ownerUserId, input) {
      const value = parseResponsibilityInput(input);
      const target = await options.resolveTarget(
        ownerUserId,
        value.agentId,
        value.channelId,
      );
      if (!target)
        throw new ResponsibilityRefusedError(
          "Choose an accessible Bot and conversation you belong to.",
        );
      const id = randomUUID();
      const record = await schedules().create(
        "responsibilities",
        {
          id,
          ownerUserId,
          agentId: value.agentId,
          channelId: value.channelId,
          threadId: target.threadId,
          title: value.title,
          instruction: value.instruction,
          successCriteria: value.successCriteria,
          status: "active",
          progress: "",
          lastResult: null,
          subscriptions: value.subscriptions,
          completedAt: null,
        },
        `openbot:responsibility:${id}`,
      );
      return toResponsibility(record);
    },

    async list(ownerUserId) {
      // Intelligence's answer, not this instance's memory: a page shows what the person just did,
      // whichever replica they did it on. Most recently changed first, as the page always listed them.
      const { items } = await schedules().client.all("responsibilities", {
        ownerUserId,
      });
      for (const record of items)
        schedules().remember("responsibilities", record);
      return items
        .sort(
          (left, right) =>
            right.updatedAt.getTime() - left.updatedAt.getTime() ||
            (right.id < left.id ? -1 : right.id > left.id ? 1 : 0),
        )
        .slice(0, 100)
        .map(toResponsibility);
    },

    get: async (ownerUserId, id) =>
      toResponsibility(await owned(ownerUserId, id)),

    async update(ownerUserId, id, input) {
      const patch = parseResponsibilityPatch(input);
      return toResponsibility(
        await guarded(id, () => rewrite(ownerUserId, id, async () => patch)),
      );
    },

    async transition(ownerUserId, id, status) {
      if (!["active", "paused", "completed"].includes(status))
        throw new ResponsibilityRefusedError(
          "Choose active, paused or completed.",
        );
      return toResponsibility(
        await guarded(id, () =>
          rewrite(ownerUserId, id, async (existing) => {
            if (existing.status === "completed" && status !== "completed")
              throw new ResponsibilityRefusedError(
                "A completed responsibility cannot be resumed. Create a new responsibility.",
              );
            return {
              status,
              completedAt:
                status === "completed"
                  ? (existing.completedAt ?? new Date())
                  : null,
            };
          }),
        ),
      );
    },

    async recordProgress(ownerUserId, id, input, agentId) {
      const summary = input.summary.trim();
      if (!summary || summary.length > 6000)
        throw new ResponsibilityRefusedError(
          "Progress must contain 1–6000 characters.",
        );
      return toResponsibility(
        await guarded(id, () =>
          rewrite(ownerUserId, id, async (existing) => {
            if (agentId && existing.agentId !== agentId)
              throw new ResponsibilityNotFoundError();
            if (existing.status !== "active")
              throw new ResponsibilityRefusedError(
                "Only an active responsibility can make progress.",
              );
            if (input.sourceRunId) {
              const run = await schedules().client.get(
                "responsibility-runs",
                input.sourceRunId,
              );
              if (run?.responsibilityId !== id || run.status !== "running")
                throw new ResponsibilityRefusedError(
                  "Progress must come from the responsibility's current run.",
                );
            }
            return {
              progress: summary,
              ...(input.complete
                ? { status: "completed" as const, completedAt: new Date() }
                : {}),
            };
          }),
        ),
      );
    },

    async listRuns(ownerUserId, id) {
      await owned(ownerUserId, id);
      const { items } = await schedules().client.page(
        "responsibility-runs",
        { responsibilityId: id },
        null,
        50,
      );
      return items.map(toRun);
    },

    async ingestEvent(input) {
      const event = parseResponsibilityEvent(input);
      // Checked before anything is written, so a refusal leaves nothing behind.
      if (event.responsibilityId) {
        const goal = await owned(event.ownerUserId, event.responsibilityId);
        if (event.triggerId) {
          // The ingress resolved this trigger from memory; re-checked against Intelligence so a caller
          // of the store cannot name a trigger that is not this owner's registration for this
          // responsibility, and so a trigger paused or a responsibility paused on another replica a
          // moment ago records nothing (resuming later must not replay what arrived meanwhile).
          const trigger = await schedules().refresh(
            "responsibility-triggers",
            event.triggerId,
          );
          if (
            !trigger ||
            trigger.deletedAt !== null ||
            trigger.ownerUserId !== event.ownerUserId ||
            trigger.responsibilityId !== event.responsibilityId
          )
            throw new ResponsibilityNotFoundError();
          if (!trigger.enabled)
            throw new ResponsibilityRefusedError("This trigger is paused.");
          if (goal.status !== "active")
            throw new ResponsibilityRefusedError(
              `The responsibility is ${goal.status}.`,
            );
        }
      } else if (event.triggerId) throw new ResponsibilityNotFoundError();

      const eventId = randomUUID();
      const owner = `responsibility-ingest:${randomUUID()}`;
      // The outbox, leased to this call from the moment it is written: the work loop takes it over
      // only if this process stops before finishing it.
      await database.insert(workItems).values({
        kind: RESPONSIBILITY_INGEST_KIND,
        key: eventId,
        payload: { eventId, event },
        claimedBy: owner,
        leaseUntil: sql`now() + make_interval(secs => ${INGEST_LEASE_MS / 1000})`,
        attempts: 1,
      });
      let result: ResponsibilityEventResult;
      try {
        result = await processIngest(eventId, event);
      } catch (error) {
        // Accepted, so not dropped: the work loop tries it again shortly.
        await queue
          .release({
            kind: RESPONSIBILITY_INGEST_KIND,
            key: eventId,
            owner,
            delayMs: INGEST_RETRY_MS,
            reason: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
        throw error;
      }
      await queue.finish({
        kind: RESPONSIBILITY_INGEST_KIND,
        key: eventId,
        owner,
      });
      return result;
    },

    async beginRun(runId, recovery) {
      // Access is resolved before the lock is taken, as it was resolved before the transaction: the
      // resolver reads the actor, Bot and channel stores and must not wait behind this run.
      const reference = await schedules().client.get(
        "responsibility-runs",
        runId,
      );
      if (!reference) return null;
      const targetGoal = await current(reference.responsibilityId);
      if (!targetGoal) return null;
      const target =
        targetGoal.status === "active"
          ? await options.resolveTarget(
              targetGoal.ownerUserId,
              targetGoal.agentId,
              targetGoal.channelId,
            )
          : null;
      return guarded(targetGoal.id, async () => {
        const goal = await current(targetGoal.id);
        if (!goal) return null;
        const client = schedules().client;
        const run = await client.get("responsibility-runs", runId);
        if (!run) return null;
        if (run.status === "running" && recovery?.recovered) {
          await moveRun(runId, (latest) =>
            latest.status === "running"
              ? {
                  status: "failed",
                  error:
                    "The worker stopped during this run. Actions may already have executed; this run was not replayed.",
                  finishedAt: new Date(),
                }
              : null,
          );
          return null;
        }
        if (run.status !== "queued") return null;
        if (
          goal.status !== "active" ||
          !target ||
          target.threadId !== goal.threadId
        ) {
          await moveRun(runId, (latest) =>
            latest.status === "queued"
              ? {
                  status: "skipped",
                  error:
                    goal.status !== "active"
                      ? `Responsibility is ${goal.status}.`
                      : "Bot or conversation access changed.",
                  finishedAt: new Date(),
                }
              : null,
          );
          return null;
        }
        const event = await client.get("responsibility-events", run.eventId);
        if (!event) throw new Error("Responsibility run has no event.");
        const started = await moveRun(runId, (latest) =>
          latest.status === "queued"
            ? { status: "running", startedAt: new Date(), finishedAt: null }
            : null,
        );
        if (!started) return null;
        return {
          runId,
          responsibilityId: goal.id,
          ownerUserId: goal.ownerUserId,
          agentId: goal.agentId,
          channelId: goal.channelId,
          threadId: goal.threadId,
          instruction: goal.instruction,
          successCriteria: goal.successCriteria,
          progress: goal.progress,
          eventId: run.eventId,
          event: {
            source: event.source as ResponsibilityEvent["source"],
            type: event.type,
            payload: event.payload,
          },
          continuation:
            started.continuation as ResponsibilityContinuation | null,
        };
      });
    },

    async settleRun(runId, outcome) {
      const reference = await schedules().client.get(
        "responsibility-runs",
        runId,
      );
      if (!reference) throw new ResponsibilityNotFoundError();
      await guarded(reference.responsibilityId, async () => {
        const replyText =
          outcome.status === "succeeded"
            ? outcome.replyText.slice(0, 32_000)
            : null;
        const settled = await moveRun(runId, (run) => {
          if (run.status !== "running")
            throw new ResponsibilityRefusedError(
              "This responsibility run is no longer running.",
            );
          return {
            status: outcome.status,
            replyText,
            error: "error" in outcome ? outcome.error : null,
            waiting:
              outcome.status === "waiting"
                ? (outcome.waiting as unknown as Record<string, unknown>)
                : null,
            continuation: null,
            finishedAt: outcome.status === "waiting" ? null : new Date(),
          };
        });
        if (!settled) throw new ResponsibilityNotFoundError();
        if (outcome.status !== "succeeded") return;
        for (let attempt = 1; ; attempt++) {
          const goal = await current(settled.responsibilityId);
          if (!goal) return;
          try {
            await schedules().update(
              "responsibilities",
              goal.id,
              goal.version,
              {
                lastResult: replyText,
              },
            );
            return;
          } catch (error) {
            if (
              error instanceof ScheduleVersionConflictError &&
              attempt < VERSION_RETRIES
            )
              continue;
            throw error;
          }
        }
      });
    },

    async resumeWaiting(ownerUserId, runId, response) {
      if (JSON.stringify(response)?.length > 32_768)
        throw new ResponsibilityRefusedError(
          "Continuation response exceeds 32 KiB.",
        );
      const reference = await schedules().client.get(
        "responsibility-runs",
        runId,
      );
      if (!reference) throw new ResponsibilityNotFoundError();
      await owned(ownerUserId, reference.responsibilityId);
      return guarded(reference.responsibilityId, async () => {
        const goal = await owned(ownerUserId, reference.responsibilityId);
        if (goal.status !== "active")
          throw new ResponsibilityRefusedError(
            "Resume the responsibility before answering its waiting run.",
          );
        const queued = await moveRun(runId, (run) =>
          run.status === "waiting" && run.waiting
            ? {
                status: "queued",
                continuation: { waiting: run.waiting, response },
                error: null,
              }
            : null,
        );
        if (!queued) return false;
        // After the run is queued, never before: a run item never exists before its run is ready.
        // Lost between the two, `recover` offers the same key.
        await queue.offer({
          kind: RESPONSIBILITY_RUN_KIND,
          key: responsibilityRunItemKey(queued),
          payload: { runId },
        });
        return true;
      });
    },

    async recover({ owner }) {
      const ingests = await retryIngests(owner);
      let requeued: string[] = [];
      if (Date.now() - reconciledAt >= RECONCILE_EVERY_MS) {
        reconciledAt = Date.now();
        requeued = await requeueStrandedRuns();
        // One row per accepted delivery: cleared once done with, so the outbox stays small.
        await queue.purge({
          kind: RESPONSIBILITY_INGEST_KIND,
          olderThanMs: INGEST_GAVE_UP_KEPT_MS,
          finishedOlderThanMs: INGEST_FINISHED_KEPT_MS,
          maxAttempts: INGEST_MAX_ATTEMPTS,
        });
      }
      return { ingests, requeued };
    },
  };
  return store;
}

/**
 * The waiting run a person's answer (an approval, a sign-in) is for, if any. Waiting runs are few at
 * any moment, so they are read and matched here rather than asked of Intelligence by a field inside
 * `waiting`.
 */
export async function responsibilityRunWaitingOn(
  field: "approvalId" | "signInRequestId",
  requestId: string,
): Promise<string | null> {
  const { items } = await schedules().client.all("responsibility-runs", {
    status: "waiting",
  });
  return items.find((run) => run.waiting?.[field] === requestId)?.id ?? null;
}

/** This person's live responsibilities with this Bot, as Intelligence holds them now. */
export async function responsibilitiesOf(
  ownerUserId: string,
  agentId: string,
): Promise<ResponsibilityRecord[]> {
  const { items } = await schedules().client.all("responsibilities", {
    ownerUserId,
    agentId,
  });
  return items;
}

/**
 * Remove this person's responsibilities with this Bot for good, their runs and triggers with them,
 * as a reset of the Bot does. Returns how many live ones there were.
 */
export async function purgeResponsibilitiesOf(
  ownerUserId: string,
  agentId: string,
): Promise<number> {
  const { items } = await schedules().client.all("responsibilities", {
    ownerUserId,
    agentId,
    includeDeleted: true,
  });
  let live = 0;
  for (const record of items) {
    if (record.deletedAt === null) live += 1;
    await schedules().purge("responsibilities", record.id);
  }
  // Their triggers went with them in Intelligence; this instance forgets them at once too.
  const gone = new Set(items.map((record) => record.id));
  for (const trigger of schedules().cached("responsibility-triggers"))
    if (gone.has(trigger.responsibilityId))
      await schedules().refresh("responsibility-triggers", trigger.id);
  return live;
}
