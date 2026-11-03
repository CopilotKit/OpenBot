import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { DurableTaskReply } from "@openbot/shared/task-reply";
import {
  isThreadAlreadyRunning,
  ThreadLockBusyError,
} from "@openbot/toolkit/lease";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AgentActor } from "../agents/profile-types";
import type { ChannelStore } from "../channels/routes";
import type { Database } from "../db/client";
import { proactiveSuggestions } from "../db/schema";
import type { TaskService } from "../proactive/contracts";
import type { WorkQueue } from "../work/queue";
import type { TaskReplyContextReader } from "./reply-context";
import {
  PROACTIVE_TASK_KIND,
  TASK_RUNS,
  TASK_TURN_MS,
  TASK_TURN_ORDER,
  TaskTurnTimeoutError,
} from "./state";
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
/**
 * How many of one person's task turns run at once, across every replica. The rest wait on the
 * queue, still Working, and start as those finish, so a run of replies, Starts or `start_task`
 * calls never becomes dozens of headless turns at once for one person. Counted under a lock, so
 * racing replicas can't both pass it (`runningAtMost` in work/queue.ts).
 */
export const TASK_TURNS_PER_PERSON = 3;
/** How many task turns one process runs at once, for everyone. The rest wait on the queue. */
const TASK_TURNS_AT_ONCE = 10;

/** An item a check-in raised, as the person started it. */
export type StartedItem = Parameters<TaskService["startFromItem"]>[0]["item"];

/**
 * The run id one execution of a task's turn goes by: the one its lines are recorded with. A rerun,
 * whether the retry or Try again, is a new run with its own id, so it never collides with what the
 * one before left there. The ask is drawn under the id of the turn's first run (attempt 1): the
 * retry carries on that same ask, and Try again, a turn of its own, asks under its own.
 */
export function taskExecutionId(input: {
  taskId: string;
  workKey: string;
  attempt: number;
  again?: boolean | undefined;
  /**
   * The id the browser drew the person's reply under. Its first run goes by it, so the message the
   * run records is the one already drawn; a retry is a run of its own.
   */
  messageId?: string | undefined;
}): string {
  const { taskId, workKey, attempt, again, messageId } = input;
  if (messageId && attempt === 1) return messageId;
  return again || attempt > 1 || messageId
    ? `task-${taskId}-${createHash("sha256").update(`${workKey}:${attempt}`).digest("hex").slice(0, 16)}`
    : `task-${taskId}`;
}

/** Work handed to a task of its own: the ask in the person's words, and where it came from. */
export type AskedTask = {
  title: string;
  instruction: string;
  why?: string | undefined;
  source?: string | undefined;
  link?: string | undefined;
  /** The id the browser made for a Start on Tasks, so a Start sent twice opens one task. */
  clientId?: string | undefined;
};

/** A task as `start_task` and the + on Tasks answer it. */
export type OpenedTask = { id: string; channelId: string; title: string };

/**
 * A task's turn as queued. `text` is the ask. One queued by a Start from before tasks has only the
 * item's id, and gets its task when it runs.
 */
const turnSchema = z.object({
  ownerUserId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  suggestionId: z.string().min(1).optional(),
  /** Empty only for a reply of files alone. */
  text: z.string().optional(),
  /** Queued by Try again, beside the turn that failed. */
  again: z.boolean().optional(),
  /**
   * How many runs this turn was queued with. A turn queued without it is from before retries, when
   * one failure was final, so it is never run a second time.
   */
  runs: z.number().int().positive().optional(),
  /** A reply the person sent in the task's conversation, rather than the task's own ask. */
  followup: z.boolean().optional(),
  /** The id the browser drew the reply under; its first run records the message with it. */
  messageId: z.string().min(1).optional(),
  /** The reply as the person sent it, while it waits its turn (`queuedReplies`). */
  reply: z.string().optional(),
  /** Questions waiting when the reply was taken, which it answers. */
  questionIds: z.array(z.string().min(1)).optional(),
  attachmentIds: z.array(z.string()).optional(),
  skillIds: z.array(z.string()).optional(),
});

/**
 * Another Start of the same item, or the same Start sent twice, opened its task first; this one's
 * conversation is rolled back.
 */
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
  /** The person's questions in a task's conversation, and answering them by a reply. */
  questions?: Pick<TaskStore, "pendingQuestions" | "answerQuestions">;
  /**
   * Checks the files and skills a reply names, and keeps the files, before the reply can wait on
   * the queue. Absent, a reply with either is refused.
   */
  replyContext?: Pick<TaskReplyContextReader, "accept">;
  /** How long a turn that threw waits for its retry. Tests pass 0. */
  retryMs?: number;
  /** How many task turns this process runs at once. Tests pass fewer. */
  turnsAtOnce?: number;
  /** See `TASK_TURN_MS`. Tests pass less. */
  turnMs?: number;
}) {
  const retryMs = deps.retryMs ?? TASK_RETRY_MS;
  const turnMs = deps.turnMs ?? TASK_TURN_MS;

  /**
   * A new conversation with the Bot and the task row that names it, committed together, so a lookup
   * never finds one without the other: `direct` tells a task's conversation by its row. `found`
   * finds a task this ask already opened, before and after: two at once race on a unique index, and
   * the loser rolls back without leaving a conversation.
   */
  async function openTask(
    ownerUserId: string,
    task: Omit<Parameters<TaskStore["create"]>[0], "ownerUserId" | "channelId">,
    found: () => Promise<OpenedTask | { id: string; channelId: string } | null>,
  ) {
    const first = await found();
    if (first) return first;
    const actor = await deps.actorFor(ownerUserId);
    try {
      return await deps.database.transaction(async (transaction) => {
        const channel = await deps.channels.create(
          actor,
          [task.agentId],
          transaction,
        );
        const opened = await deps.store.create(
          { ...task, ownerUserId, channelId: channel.id },
          transaction,
        );
        // Thrown, so its own conversation is rolled back with it.
        if (!opened) throw new ItemAlreadyOpened();
        return opened;
      });
    } catch (error) {
      if (!(error instanceof ItemAlreadyOpened)) throw error;
      const winner = await found();
      if (!winner) throw error;
      return winner;
    }
  }

  /**
   * The task an item becomes: a new conversation with the item's Bot and the row that names it,
   * committed together. Idempotent on the item: a second call, or two at once, find the one task.
   */
  async function open(
    ownerUserId: string,
    item: StartedItem,
  ): Promise<{ id: string; channelId: string }> {
    const { id, channelId } = await openTask(
      ownerUserId,
      {
        agentId: item.agentId,
        title: item.title,
        why: whyOf(item.detail),
        origin: "check_in",
        suggestionId: item.id,
        sourceApp: item.sourceApp,
        sourceLink: item.sourceLink,
      },
      () => deps.store.byItem(ownerUserId, item.id),
    );
    return { id, channelId };
  }

  /** Queue a task's turn, once per key, and start it now. */
  async function queueTurn(
    ownerUserId: string,
    taskId: string,
    key: string,
    text: string,
    again?: true,
    extra: Record<string, unknown> = {},
  ) {
    const queued = await deps.queue.offer({
      kind: PROACTIVE_TASK_KIND,
      key,
      payload: {
        ownerUserId,
        taskId,
        text,
        ...extra,
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
    if (work.text === "" && !work.attachmentIds?.length)
      throw new TaskRefusedError("This task has nothing to start.");
    /*
     * A reply answers the questions waiting when it was taken. Marked first, so a write that fails
     * after a turn that succeeded can never make the turn, and what it did, run again.
     */
    if (work.followup && work.questionIds?.length)
      await deps.questions?.answerQuestions(work.ownerUserId, work.questionIds);
    const ending = await deps.runTask(scope, {
      runId: taskExecutionId({
        taskId: task.id,
        workKey,
        attempt,
        again: work.again,
        messageId: work.messageId,
      }),
      // The turn's first run's id: a retry carries on the same ask rather than asking again.
      askId: taskExecutionId({
        taskId: task.id,
        workKey,
        attempt: 1,
        again: work.again,
        messageId: work.messageId,
      }),
      text:
        work.text ??
        itemAsk({
          title: task.title,
          detail: task.why ?? "",
          sourceLink: task.sourceLink,
        }),
      ...(work.attachmentIds?.length
        ? { attachmentIds: work.attachmentIds }
        : {}),
      ...(work.skillIds?.length ? { skillIds: work.skillIds } : {}),
      signal,
      final: attempt >= TASK_RUNS,
    });
    // Kept on the turn's work item, where the task's status reads it (`TaskTurnEnding`).
    return ending ? { ending } : undefined;
  }

  /**
   * Claim one queued task's turn and run it, up to `TASK_RUNS` times, the retry started after its
   * wait. False when there was nothing to claim.
   *
   * IN THE TASK'S ORDER (`TASK_TURN_ORDER`): a turn waits while another of its task's work runs or
   * is older and still due, and at most `TASK_TURNS_PER_PERSON` of one person's run at once.
   *
   * Each claim is owned under an id of its own, so a late finish from a run whose lease lapsed can
   * never finish or release a later claim of the same turn on this replica. A claim given back
   * unstarted repeats its attempt number, which makes that matter twice over.
   *
   * NEVER LONGER THAN `TASK_TURN_MS`. Past it the turn's signal is aborted and the claim let go
   * with a `TaskTurnTimeoutError`, whether or not the turn has wound down, so a step that never
   * answers can't hold it, renewing its lease, for ever.
   *
   * A TURN THAT NEVER BEGAN SPENDS NOTHING. Refused the conversation's lock on its first ask, or by
   * the runner while a run before it winds down, it goes back on the queue with its attempt given
   * back (`unstarted`). A provider's own 409, or the lock lost once the run was under way, still
   * spends its attempt and keeps its reason.
   */
  async function drainTask(): Promise<boolean> {
    const owner = `${deps.owner}:${randomUUID()}`;
    const [item] = await deps.queue.claim({
      kind: PROACTIVE_TASK_KIND,
      owner,
      leaseMs: TASK_LEASE_MS,
      limit: 1,
      maxAttempts: TASK_RUNS,
      serialBy: TASK_TURN_ORDER,
      // The expression `work_items_owner_task_idx` indexes, so the count is a lookup by person.
      runningAtMost: {
        by: (row) => sql`${row}.payload->>'ownerUserId'`,
        max: TASK_TURNS_PER_PERSON,
      },
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
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const kept = await Promise.race([
        runTurn(item.payload, controller.signal, item.attempts, item.key),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => {
            const error = new TaskTurnTimeoutError(turnMs);
            controller.abort(error);
            reject(error);
          }, turnMs);
          deadline.unref?.();
        }),
      ]);
      await deps.queue.finish({ ...held, ...(kept ? { payload: kept } : {}) });
    } catch (error) {
      const unstarted =
        error instanceof ThreadLockBusyError || isThreadAlreadyRunning(error);
      const released = await deps.queue.release({
        ...held,
        delayMs: retryMs,
        ...(unstarted
          ? { unstarted: true }
          : { reason: error instanceof Error ? error.message : String(error) }),
      });
      if (released && (unstarted || item.attempts < TASK_RUNS))
        track(sleep(retryMs).then(startSoon));
      if (!unstarted) throw error;
    } finally {
      clearInterval(renew);
      clearTimeout(deadline);
    }
    return true;
  }

  /**
   * `drainTask`, unless this process already runs as many task turns as it may. A start past the
   * cap leaves its turn queued, and each turn that finishes looks for the next, so a turn held back
   * starts as soon as there is room rather than at the next sweep.
   */
  const atOnce = deps.turnsAtOnce ?? TASK_TURNS_AT_ONCE;
  let turnsRunning = 0;
  async function drainTaskIfRoom(): Promise<boolean> {
    if (turnsRunning >= atOnce) return false;
    turnsRunning += 1;
    try {
      return await drainTask();
    } finally {
      turnsRunning -= 1;
    }
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
      drainTaskIfRoom()
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
      const { ask, turns, context } = await deps.store.failedTurn(
        ownerUserId,
        taskId,
      );
      // A reply's files and skills go with it again.
      const queued = await queueTurn(
        ownerUserId,
        taskId,
        `task:${taskId}:again:${turns}`,
        ask,
        true,
        context,
      );
      if (queued !== "queued")
        throw new TaskRefusedError("This task is already being tried again.");
    },
    /**
     * Work asked for in so many words, by `start_task` or the + on Tasks: opened as a task with its
     * own conversation and started there. No cap on how many a person has; how many run at once is
     * capped (`TASK_TURNS_PER_PERSON`).
     *
     * A Start sent again with the same `clientId` is the same Start: opening answers the task the
     * first one opened, and its turn is offered under the same key, so it is not queued twice.
     */
    async startAsked(
      ownerUserId: string,
      agentId: string,
      input: AskedTask,
    ): Promise<OpenedTask> {
      const clientId = input.clientId;
      const task = await openTask(
        ownerUserId,
        {
          agentId,
          title: input.title,
          why: input.why ?? null,
          origin: "asked",
          suggestionId: null,
          sourceApp: input.source ?? null,
          sourceLink: input.link ?? null,
          clientId: clientId ?? null,
        },
        async () =>
          clientId ? deps.store.byClientId(ownerUserId, clientId) : null,
      );
      await queueTurn(
        ownerUserId,
        task.id,
        `task:${task.id}`,
        input.instruction,
      );
      return { id: task.id, channelId: task.channelId, title: input.title };
    },
    /**
     * The person replied in a task's conversation. Taken onto the queue before it is answered, in
     * the task's own order, so it waits behind a turn still running there and survives a restart.
     * Keyed by the message, so sending it twice takes it once. The questions waiting as it is taken
     * are the ones it answers, whenever it runs.
     */
    async reply(
      ownerUserId: string,
      taskId: string,
      input: DurableTaskReply,
    ): Promise<void> {
      const task = await deps.store.locate(ownerUserId, taskId);
      const scope = task
        ? await deps.scopeFor(ownerUserId, task.channelId, task.agentId)
        : null;
      if (!scope)
        throw new TaskRefusedError("This task is no longer available to you.");
      if (input.attachmentIds?.length || input.skillIds?.length) {
        if (!deps.replyContext)
          throw new TaskRefusedError(
            "Files and skills are unavailable for this task.",
          );
        await deps.replyContext.accept(scope, input);
      }
      const questionIds =
        (await deps.questions?.pendingQuestions(ownerUserId, taskId)) ?? [];
      await queueTurn(
        ownerUserId,
        taskId,
        `task:${taskId}:reply:${input.messageId}`,
        input.reply,
        undefined,
        {
          reply: input.reply || "Sent attachments",
          messageId: input.messageId,
          followup: true,
          questionIds,
          ...(input.attachmentIds?.length
            ? { attachmentIds: input.attachmentIds }
            : {}),
          ...(input.skillIds?.length ? { skillIds: input.skillIds } : {}),
        },
      );
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
      if (await drainTaskIfRoom()) startSoon();
    },
  };
}
