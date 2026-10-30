import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AgentActor } from "../agents/profile-types";
import type { ChannelStore } from "../channels/routes";
import type { Database } from "../db/client";
import { proactiveSuggestions } from "../db/schema";
import type { TaskService } from "../proactive/contracts";
import type { WorkQueue } from "../work/queue";
import { PROACTIVE_TASK_KIND, TASK_RUNS } from "./state";
import { itemAsk, TaskRefusedError, type TaskStore, whyOf } from "./store";
import type { TaskScope, TaskTurn } from "./turn";

/*
 * Started work: an item the person started becomes a task in a conversation of its own with the
 * item's Bot, and its turn runs there as the person's own.
 *
 * NOT A NEW ORCHESTRATOR. A task's turn is a `proactive.task` item on the existing work queue, run
 * by whichever replica claims it, through the same turn runner every started piece of work uses. It
 * starts now, not at the next sweep: the person was just told it started. The sweep is the backstop
 * for a turn a crash or a restart left behind.
 *
 * A NEW CONVERSATION EVERY TIME, never the person's own with the Bot, so the work stays out of the
 * conversation they chat in. The channel store leaves task conversations out when it looks for that
 * one (`direct`), so nothing that wants "the person's conversation with this Bot" adopts a task's.
 */

/**
 * A task's lease, short so a turn a restart cut off is picked up again within minutes. Longer than
 * the thread lock's two minutes (`TURN_LIMITS.lockTtlSeconds`), so the dead run's lock on the
 * conversation has gone by the time the retry asks for it.
 */
const TASK_LEASE_MS = 3 * 60_000;
/** How long a task's turn that threw waits before its one retry. */
const TASK_RETRY_MS = 10_000;

/** An item a check-in raised, as the person started it. */
export type StartedItem = Parameters<TaskService["startFromItem"]>[0]["item"];

/**
 * The run id one execution of a task's turn goes by: the id its ask is drawn under in the
 * conversation, and the one its lines are recorded with. A rerun, whether the retry or Try again, is
 * a new run with its own id, so it never collides with what the one before left there.
 */
export function taskExecutionId(input: {
  taskId: string;
  workKey: string;
  attempt: number;
  again?: boolean | undefined;
}): string {
  const { taskId, workKey, attempt, again } = input;
  return again || attempt > 1
    ? `task-${taskId}-${createHash("sha256").update(`${workKey}:${attempt}`).digest("hex").slice(0, 16)}`
    : `task-${taskId}`;
}

/**
 * A task's turn as queued. `text` is the ask. One queued by a Start from before tasks has only the
 * item's id, and gets its task when it runs.
 */
const turnSchema = z.object({
  ownerUserId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  suggestionId: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  /** Queued by Try again, beside the turn that failed. */
  again: z.boolean().optional(),
  /**
   * How many runs this turn was queued with. A turn queued without it is from before retries, when
   * one failure was final, so it is never run a second time.
   */
  runs: z.number().int().positive().optional(),
});

/** Another Start of the same item opened its task first; this one's conversation is rolled back. */
class ItemAlreadyOpened extends Error {
  constructor() {
    super("This item already opened a task.");
    this.name = "ItemAlreadyOpened";
  }
}

export type TaskRunner = ReturnType<typeof createTaskRunner>;

export function createTaskRunner(deps: {
  database: Pick<Database, "transaction" | "select">;
  store: TaskStore;
  channels: Pick<ChannelStore, "create">;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  queue: WorkQueue;
  /** Who claims, for the queue: `workOwner("tasks")`. */
  owner: string;
  /** The task's conversation as a turn needs it, or null once the person cannot reach it or its Bot. */
  scopeFor(
    ownerUserId: string,
    channelId: string,
    agentId: string,
  ): Promise<TaskScope | null>;
  runTask: TaskTurn;
  /** How long a turn that threw waits for its retry. Tests pass 0. */
  retryMs?: number;
}) {
  const retryMs = deps.retryMs ?? TASK_RETRY_MS;

  /**
   * The task an item becomes: a new conversation with the item's Bot and the row that names it,
   * committed together. Idempotent on the item: a second call, or two at once, find the one task.
   */
  async function open(
    ownerUserId: string,
    item: StartedItem,
  ): Promise<{ id: string; channelId: string }> {
    const found = await deps.store.byItem(ownerUserId, item.id);
    if (found) return found;
    const actor = await deps.actorFor(ownerUserId);
    try {
      return await deps.database.transaction(async (transaction) => {
        const channel = await deps.channels.create(
          actor,
          [item.agentId],
          transaction,
        );
        const task = await deps.store.create(
          {
            ownerUserId,
            agentId: item.agentId,
            channelId: channel.id,
            title: item.title,
            why: whyOf(item.detail),
            origin: "check_in",
            suggestionId: item.id,
            sourceApp: item.sourceApp,
            sourceLink: item.sourceLink,
          },
          transaction,
        );
        /*
         * Two Starts of one item at once: the second waits on the first's row under the unique
         * index, then finds it there. Thrown, so its own conversation is rolled back with it.
         */
        if (!task) throw new ItemAlreadyOpened();
        return task;
      });
    } catch (error) {
      if (!(error instanceof ItemAlreadyOpened)) throw error;
      const winner = await deps.store.byItem(ownerUserId, item.id);
      if (!winner) throw error;
      return winner;
    }
  }

  /** Queue a task's turn, once per key, and start it now. */
  async function queueTurn(
    ownerUserId: string,
    taskId: string,
    key: string,
    text: string,
    again?: true,
  ) {
    const queued = await deps.queue.offer({
      kind: PROACTIVE_TASK_KIND,
      key,
      payload: {
        ownerUserId,
        taskId,
        text,
        ...(again ? { again } : {}),
        runs: TASK_RUNS,
      },
    });
    startSoon();
    return queued;
  }

  async function startFromItem({
    ownerUserId,
    item,
  }: Parameters<TaskService["startFromItem"]>[0]) {
    const task = await open(ownerUserId, item);
    /*
     * Keyed on the item, so the turn is queued once however often this is called for it. Called
     * again after a crash between the task's commit and this offer, it queues the turn that crash
     * lost; called again after that, it finds the turn already there.
     */
    await queueTurn(ownerUserId, task.id, item.id, itemAsk(item));
    return task;
  }

  /**
   * Runs one queued task's turn in its own conversation, as the person's message. Its last run is
   * `final`: if it fails, the Bot says so there.
   */
  async function runTurn(
    payload: Record<string, unknown>,
    signal: AbortSignal,
    attempt: number,
    workKey: string,
  ) {
    const work = turnSchema.parse(payload);
    /*
     * A turn from before retries failed once and was left, as final then. Run again now, it would
     * act late on whatever it was asked; refused instead, before anything is opened for it.
     */
    if (attempt > 1 && work.runs === undefined)
      throw new TaskRefusedError(
        "This turn failed before it could be tried again.",
      );
    if (!work.taskId) {
      /*
       * Queued by a Start from before tasks, which ran the ask in the person's own conversation. It
       * gets its task now, and its turn is queued as a task's, so started work never lands there.
       */
      const [item] = work.suggestionId
        ? await deps.database
            .select()
            .from(proactiveSuggestions)
            .where(
              and(
                eq(proactiveSuggestions.ownerUserId, work.ownerUserId),
                eq(proactiveSuggestions.id, work.suggestionId),
              ),
            )
            .limit(1)
        : [];
      if (!item) throw new TaskRefusedError("This task has nothing to start.");
      const task = await open(work.ownerUserId, item);
      await queueTurn(
        work.ownerUserId,
        task.id,
        `task:${task.id}`,
        itemAsk(item),
      );
      return;
    }
    const task = await deps.store.locate(work.ownerUserId, work.taskId);
    const scope = task
      ? await deps.scopeFor(work.ownerUserId, task.channelId, task.agentId)
      : null;
    if (!task || !scope)
      throw new TaskRefusedError(
        "This Bot or its conversation is no longer available to you.",
      );
    await deps.runTask(scope, {
      runId: taskExecutionId({
        taskId: task.id,
        workKey,
        attempt,
        again: work.again,
      }),
      text:
        work.text ??
        itemAsk({
          title: task.title,
          detail: task.why ?? "",
          sourceLink: task.sourceLink,
        }),
      signal,
      final: attempt >= TASK_RUNS,
    });
  }

  /**
   * Claim one queued task's turn and run it, up to `TASK_RUNS` times, the retry started after its
   * wait. False when there was nothing to claim.
   *
   * Each claim is owned under an id of its own, so a late finish from a run whose lease lapsed can
   * never finish or release a later claim of the same turn on this replica.
   */
  async function drainTask(): Promise<boolean> {
    const owner = `${deps.owner}:${randomUUID()}`;
    const [item] = await deps.queue.claim({
      kind: PROACTIVE_TASK_KIND,
      owner,
      leaseMs: TASK_LEASE_MS,
      limit: 1,
      maxAttempts: TASK_RUNS,
    });
    if (!item) return false;
    const held = { kind: PROACTIVE_TASK_KIND, key: item.key, owner };
    const controller = new AbortController();
    const renew = setInterval(() => {
      void deps.queue.renew({ ...held, leaseMs: TASK_LEASE_MS }).then(
        (kept) => {
          if (!kept) controller.abort();
        },
        () => controller.abort(),
      );
    }, TASK_LEASE_MS / 3);
    renew.unref?.();
    try {
      await runTurn(item.payload, controller.signal, item.attempts, item.key);
      await deps.queue.finish(held);
    } catch (error) {
      const released = await deps.queue.release({
        ...held,
        delayMs: retryMs,
        reason: error instanceof Error ? error.message : String(error),
      });
      if (released && item.attempts < TASK_RUNS)
        track(sleep(retryMs).then(startSoon));
      throw error;
    } finally {
      clearInterval(renew);
    }
    return true;
  }

  /*
   * A turn starts now, not at the next sweep: the person was just told it started. Each start claims
   * one queued turn, so tasks started together run side by side, one per start, and the sweep stays
   * the backstop for any a crash left behind.
   */
  const kicked = new Set<Promise<unknown>>();
  function track(work: Promise<unknown>) {
    const tracked = work.finally(() => kicked.delete(tracked));
    kicked.add(tracked);
  }
  function startSoon() {
    track(
      drainTask()
        .then((ran) => {
          if (ran) startSoon();
        })
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              type: "task-turn-error",
              error: error instanceof Error ? error.name : "UnknownError",
              timestamp: new Date().toISOString(),
            }),
          );
        }),
    );
  }

  const service: TaskService = {
    startFromItem,
    counts: (ownerUserId) => deps.store.counts(ownerUserId),
  };

  return {
    ...service,
    /**
     * Try again: a task whose turn couldn't finish runs it once more, in the same conversation, as a
     * turn of its own beside the one that failed. Keyed on how many turns the task has had, so two
     * presses at once run it once and the second is refused.
     */
    async again(ownerUserId: string, taskId: string): Promise<void> {
      const { ask, turns } = await deps.store.failedTurn(ownerUserId, taskId);
      const queued = await queueTurn(
        ownerUserId,
        taskId,
        `task:${taskId}:again:${turns}`,
        ask,
        true,
      );
      if (queued !== "queued")
        throw new TaskRefusedError("This task is already being tried again.");
    },
    /** Settles once every turn started straight away has finished. For tests and shutdown. */
    async idle() {
      while (kicked.size > 0) await Promise.allSettled([...kicked]);
    },
    /**
     * One pass of the backstop: run one due turn, a crash's or a retry's, and start on any others
     * behind it. Throws what the turn threw, for the caller to log.
     */
    async sweep() {
      if (await drainTask()) startSoon();
    },
  };
}
