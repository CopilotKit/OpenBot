import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { routines } from "../db/schema/coworker";
import {
  responsibilities,
  responsibilityEvents,
  responsibilityRuns,
  responsibilityTriggers,
} from "../db/schema/responsibilities";
import { workItems } from "../db/schema/work";
import { RESPONSIBILITY_RUN_KIND } from "./engine";
import {
  type GoalRepeats,
  parseResponsibilityEvent,
  parseResponsibilityInput,
  parseResponsibilityPatch,
  ENDS_WITHOUT_OUTCOME,
  instructionNamesGoal,
  RECURS_AND_ENDS,
  type Responsibility,
  ResponsibilityNotFoundError,
  ResponsibilityRefusedError,
  type ResponsibilityStore,
  type RoutineGoalLink,
  routineRunsGoal,
  whyItRepeats,
} from "./types";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Connection = Database | Transaction;
/** An enabled routine, with what `routinesRunning` reads to tell which goal it runs. */
type EnabledRoutine = RoutineGoalLink & { id: string; agentId: string };
export type ResponsibilityTargetResolver = (
  ownerUserId: string,
  agentId: string,
  channelId: string,
) => Promise<{ threadId: string } | null>;

export function createResponsibilityStore(
  database: Database,
  options: { resolveTarget: ResponsibilityTargetResolver },
): ResponsibilityStore {
  async function owned(
    connection: Connection,
    ownerUserId: string,
    id: string,
    lock = false,
  ): Promise<Responsibility> {
    const query = connection
      .select()
      .from(responsibilities)
      .where(
        and(
          eq(responsibilities.id, id),
          eq(responsibilities.ownerUserId, ownerUserId),
        ),
      );
    const [row] = await (lock ? query.for("update") : query);
    if (!row) throw new ResponsibilityNotFoundError();
    return row;
  }
  async function queueRun(
    transaction: Transaction,
    runId: string,
    key = runId,
  ) {
    await transaction
      .insert(workItems)
      .values({ kind: RESPONSIBILITY_RUN_KIND, key, payload: { runId } })
      .onConflictDoNothing();
  }
  /**
   * The enabled routines that may run a goal of this Bot: this Bot's, plus any routine that records
   * one of `goalIds` whatever its Bot. `routinesRunning` narrows them to one goal; `repeatingGoals`
   * reads them once for all of a Bot's goals. One query for both, so a goal's repeat check and its
   * completion read the same routines.
   *
   * A person keeps at most 20 routines switched on (`MAX_ENABLED_ROUTINES`), so this read is small.
   */
  function enabledRoutines(
    connection: Connection,
    ownerUserId: string,
    agentId: string,
    goalIds: readonly string[],
  ): Promise<EnabledRoutine[]> {
    return connection
      .select({
        id: routines.id,
        agentId: routines.agentId,
        goalId: routines.goalId,
        goalByTitle: routines.goalByTitle,
        instruction: routines.instruction,
      })
      .from(routines)
      .where(
        and(
          eq(routines.ownerUserId, ownerUserId),
          eq(routines.enabled, true),
          goalIds.length > 0
            ? or(
                eq(routines.agentId, agentId),
                inArray(routines.goalId, [...goalIds]),
              )
            : eq(routines.agentId, agentId),
        ),
      );
  }
  /**
   * The ids of the enabled routines that run this goal, by `routineRunsGoal`: the goal a routine
   * records, or for an older routine its id or whole quoted title. The one place the goal store asks
   * which routines run a goal, so what makes it repeat is what its completion switches off, less a
   * routine that still runs another open goal, which that goal still repeats by
   * (`switchOffRoutinesOf`).
   *
   * FOUND IN REVIEW: completion switched off only the routines whose `goal_id` named the goal, while
   * `repeatsOf` also counted an older routine that names it in its instruction. That routine stayed
   * on after the goal was complete, kept firing, and every `run_goal` it made was refused.
   *
   * Read from this Bot's routines, plus any routine that records this goal whatever its Bot, which is
   * what completion switched off before. `enabled` is `enabledRoutines` already read for many goals
   * (`repeatingGoals`); absent, it is read for this goal.
   */
  async function routinesRunning(
    connection: Connection,
    goal: Pick<Responsibility, "id" | "ownerUserId" | "agentId" | "title">,
    enabled?: readonly EnabledRoutine[],
  ): Promise<string[]> {
    const candidates =
      enabled ??
      (await enabledRoutines(connection, goal.ownerUserId, goal.agentId, [
        goal.id,
      ]));
    return candidates
      .filter(
        (routine) =>
          (routine.agentId === goal.agentId || routine.goalId === goal.id) &&
          routineRunsGoal(routine, goal),
      )
      .map((routine) => routine.id);
  }
  /**
   * Completing a goal switches off the routines that run it (`routinesRunning`), but not one that
   * still runs another goal of its Bot that is not completed. Only an older routine can: a routine
   * that records its goal (`goal_id`) runs that goal alone, whatever its instruction quotes
   * (`routineRunsGoal`), so it is switched off with it. A paused goal is not completed, and can be
   * resumed, so a routine that runs one stays on.
   *
   * FOUND IN REVIEW: completion switched off every routine that ran the goal, including an older
   * routine that also named a second goal ("Weekly report" and "Inbox zero"). The second goal, still
   * active, silently stopped being run, and since nothing made it repeat any more, a run could then
   * complete it. What is left on is what `routinesRunning` still finds for that open goal, so it
   * still repeats (`repeatsOf`, `repeatingGoals`); the completed goal's `run_goal` is refused.
   *
   * Serialized per Bot, so two goals one routine runs, completed at once, can't each read the other
   * as still open and both leave it on: the second reads the first as completed, and switches it off.
   *
   * FOUND IN REVIEW: a broad routine ("Summarise my inbox, and if a release shipped run the goal")
   * records the goal its firing ran through run_goal (`linkGoal` in the routine store), though its
   * instruction never names it. Completing that goal switched the routine off, and switching it back
   * on was refused as `goal_complete`, so the rest of what it did stopped for good. A routine that
   * records this goal but whose instruction doesn't name it (`instructionNamesGoal`) is unlinked and
   * left on; one that names it is switched off.
   */
  async function switchOffRoutinesOf(
    transaction: Transaction,
    goal: Pick<Responsibility, "id" | "ownerUserId" | "agentId" | "title">,
  ) {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`goal-completion-${goal.ownerUserId}-${goal.agentId}`}))`,
    );
    const enabled = await enabledRoutines(
      transaction,
      goal.ownerUserId,
      goal.agentId,
      [goal.id],
    );
    const running = new Set(await routinesRunning(transaction, goal, enabled));
    const linkedOnly = enabled.filter(
      (routine) =>
        running.has(routine.id) &&
        routine.goalId === goal.id &&
        !instructionNamesGoal(routine.instruction, goal),
    );
    if (linkedOnly.length > 0)
      await transaction
        .update(routines)
        .set({ goalId: null, updatedAt: new Date() })
        .where(
          inArray(
            routines.id,
            linkedOnly.map((routine) => routine.id),
          ),
        );
    const runs = enabled.filter(
      (routine) => running.has(routine.id) && !linkedOnly.includes(routine),
    );
    const stillOpen = runs.some((routine) => !routine.goalId)
      ? await transaction
          .select({ id: responsibilities.id, title: responsibilities.title })
          .from(responsibilities)
          .where(
            and(
              eq(responsibilities.ownerUserId, goal.ownerUserId),
              eq(responsibilities.agentId, goal.agentId),
              ne(responsibilities.status, "completed"),
              ne(responsibilities.id, goal.id),
            ),
          )
      : [];
    const ids = runs
      .filter(
        (routine) =>
          !stillOpen.some((other) => routineRunsGoal(routine, other)),
      )
      .map((routine) => routine.id);
    if (ids.length === 0) return;
    await transaction
      .update(routines)
      .set({ enabled: false, updatedAt: new Date() })
      .where(inArray(routines.id, ids));
  }
  /**
   * Why this goal runs again and again (`GoalRepeats`), read where it already lives: its own flag,
   * its subscriptions, its enabled triggers, and the enabled routines that run it (`routinesRunning`).
   * A goal that ends when met (`endsWhenMet`) does not repeat, whatever runs it.
   *
   * `known` is `enabledRoutines` and the goals with an enabled trigger, read once for all of a Bot's
   * goals (`repeatingGoals`); absent, they are read for this goal.
   */
  async function repeatsOf(
    connection: Connection,
    goal: Pick<
      Responsibility,
      | "id"
      | "ownerUserId"
      | "agentId"
      | "title"
      | "recurring"
      | "endsWhenMet"
      | "subscriptions"
    >,
    known?: {
      enabled: readonly EnabledRoutine[];
      triggered: ReadonlySet<string>;
    },
  ): Promise<GoalRepeats | null> {
    if (goal.recurring) return "recurring";
    if (goal.endsWhenMet) return null;
    if ((await routinesRunning(connection, goal, known?.enabled)).length > 0)
      return "routine";
    if (goal.subscriptions.length > 0) return "event";
    if (known) return known.triggered.has(goal.id) ? "event" : null;
    const [trigger] = await connection
      .select({ id: responsibilityTriggers.id })
      .from(responsibilityTriggers)
      .where(
        and(
          eq(responsibilityTriggers.responsibilityId, goal.id),
          eq(responsibilityTriggers.enabled, true),
        ),
      )
      .limit(1);
    return trigger ? "event" : null;
  }
  const store: ResponsibilityStore = {
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
      const [row] = await database
        .insert(responsibilities)
        .values({
          id: randomUUID(),
          ownerUserId,
          threadId: target.threadId,
          ...value,
        })
        .returning();
      if (!row) throw new Error("Responsibility creation returned no row.");
      return row;
    },
    list: (ownerUserId) =>
      database
        .select()
        .from(responsibilities)
        .where(eq(responsibilities.ownerUserId, ownerUserId))
        .orderBy(desc(responsibilities.updatedAt))
        .limit(100),
    get: (ownerUserId, id) => owned(database, ownerUserId, id),
    async update(ownerUserId, id, input) {
      const patch = parseResponsibilityPatch(input);
      return database.transaction(async (transaction) => {
        const existing = await owned(transaction, ownerUserId, id, true);
        if (
          (patch.recurring ?? existing.recurring) &&
          (patch.endsWhenMet ?? existing.endsWhenMet)
        )
          throw new ResponsibilityRefusedError(RECURS_AND_ENDS);
        if (
          (patch.endsWhenMet ?? existing.endsWhenMet) &&
          !(patch.successCriteria ?? existing.successCriteria)
        )
          throw new ResponsibilityRefusedError(ENDS_WITHOUT_OUTCOME);
        const [row] = await transaction
          .update(responsibilities)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(responsibilities.id, id))
          .returning();
        if (!row) throw new ResponsibilityNotFoundError();
        return row;
      });
    },
    async transition(ownerUserId, id, status) {
      if (!["active", "paused", "completed"].includes(status))
        throw new ResponsibilityRefusedError(
          "Choose active, paused or completed.",
        );
      return database.transaction(async (transaction) => {
        const existing = await owned(transaction, ownerUserId, id, true);
        if (existing.status === "completed" && status !== "completed")
          throw new ResponsibilityRefusedError(
            "A completed goal can't be resumed. Create a new goal.",
          );
        const [row] = await transaction
          .update(responsibilities)
          .set({
            status,
            completedAt:
              status === "completed"
                ? (existing.completedAt ?? new Date())
                : null,
            updatedAt: new Date(),
          })
          .where(eq(responsibilities.id, id))
          .returning();
        if (!row) throw new ResponsibilityNotFoundError();
        if (status === "completed") await switchOffRoutinesOf(transaction, row);
        return row;
      });
    },
    async recordProgress(ownerUserId, id, input, agentId) {
      const summary = input.summary.trim();
      if (!summary || summary.length > 6000)
        throw new ResponsibilityRefusedError(
          "Progress must contain 1–6000 characters.",
        );
      return database.transaction(async (transaction) => {
        const existing = await owned(transaction, ownerUserId, id, true);
        if (agentId && existing.agentId !== agentId)
          throw new ResponsibilityNotFoundError();
        if (existing.status !== "active")
          throw new ResponsibilityRefusedError(
            "Only an active goal can make progress.",
          );
        if (input.sourceRunId) {
          const [run] = await transaction
            .select()
            .from(responsibilityRuns)
            .where(
              and(
                eq(responsibilityRuns.id, input.sourceRunId),
                eq(responsibilityRuns.responsibilityId, id),
                eq(responsibilityRuns.status, "running"),
              ),
            );
          if (!run)
            throw new ResponsibilityRefusedError(
              "Progress must come from the goal's current run.",
            );
          // A run of a goal that repeats is one of many: it records its result, and the person ends it.
          const repeats = input.complete
            ? await repeatsOf(transaction, existing)
            : null;
          if (repeats)
            throw new ResponsibilityRefusedError(
              `This goal repeats because ${whyItRepeats(repeats)}, so a run can't complete it. Record this run's progress without complete, and the goal stays active. Only the person ends it.`,
            );
        }
        const [row] = await transaction
          .update(responsibilities)
          .set({
            progress: summary,
            ...(input.complete
              ? { status: "completed" as const, completedAt: new Date() }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(responsibilities.id, id))
          .returning();
        if (!row) throw new ResponsibilityNotFoundError();
        if (input.complete) await switchOffRoutinesOf(transaction, row);
        return row;
      });
    },
    repeats: async (ownerUserId, id) =>
      repeatsOf(database, await owned(database, ownerUserId, id)),
    async renameUnlinksRoutine(ownerUserId, id, title) {
      const goal = await owned(database, ownerUserId, id);
      const enabled = await enabledRoutines(
        database,
        ownerUserId,
        goal.agentId,
        [id],
      );
      const renamed = new Set(
        await routinesRunning(database, { ...goal, title }, enabled),
      );
      return (await routinesRunning(database, goal, enabled)).some(
        (routine) => !renamed.has(routine),
      );
    },
    async repeatingGoals(ownerUserId, agentId) {
      // Only what `repeatsOf` reads, and not the completed ones: a completed goal stays completed
      // (`transition`), so no run or turn can be asked whether it may complete one. They are never
      // deleted, so reading them here would grow for as long as the Bot is used.
      const goals = await database
        .select({
          id: responsibilities.id,
          ownerUserId: responsibilities.ownerUserId,
          agentId: responsibilities.agentId,
          title: responsibilities.title,
          recurring: responsibilities.recurring,
          endsWhenMet: responsibilities.endsWhenMet,
          subscriptions: responsibilities.subscriptions,
        })
        .from(responsibilities)
        .where(
          and(
            eq(responsibilities.ownerUserId, ownerUserId),
            eq(responsibilities.agentId, agentId),
            ne(responsibilities.status, "completed"),
          ),
        );
      const ids = goals.map((goal) => goal.id);
      const [enabled, triggered] = await Promise.all([
        enabledRoutines(database, ownerUserId, agentId, ids),
        ids.length > 0
          ? database
              .selectDistinct({ id: responsibilityTriggers.responsibilityId })
              .from(responsibilityTriggers)
              .where(
                and(
                  inArray(responsibilityTriggers.responsibilityId, ids),
                  eq(responsibilityTriggers.enabled, true),
                ),
              )
          : [],
      ]);
      const known = {
        enabled,
        triggered: new Set(triggered.map((trigger) => trigger.id)),
      };
      const repeating = new Map<string, GoalRepeats>();
      for (const goal of goals) {
        const repeats = await repeatsOf(database, goal, known);
        if (repeats) repeating.set(goal.id, repeats);
      }
      return repeating;
    },
    async listRuns(ownerUserId, id) {
      await owned(database, ownerUserId, id);
      return database
        .select()
        .from(responsibilityRuns)
        .where(eq(responsibilityRuns.responsibilityId, id))
        .orderBy(desc(responsibilityRuns.createdAt))
        .limit(50);
    },
    async ingestEvent(input) {
      const event = parseResponsibilityEvent(input);
      return database.transaction(async (transaction) => {
        if (event.responsibilityId)
          await owned(transaction, event.ownerUserId, event.responsibilityId);
        if (event.triggerId) {
          // The ingress resolved this trigger server-side; re-checked here so a caller of the store
          // cannot name a trigger that is not this owner's registration for this responsibility.
          const [trigger] = await transaction
            .select({ id: responsibilityTriggers.id })
            .from(responsibilityTriggers)
            .where(
              and(
                eq(responsibilityTriggers.id, event.triggerId),
                eq(responsibilityTriggers.ownerUserId, event.ownerUserId),
                eq(
                  responsibilityTriggers.responsibilityId,
                  event.responsibilityId ?? "",
                ),
              ),
            );
          if (!trigger) throw new ResponsibilityNotFoundError();
        }
        const eventId = randomUUID();
        const inserted = await transaction
          .insert(responsibilityEvents)
          .values({
            id: eventId,
            ownerUserId: event.ownerUserId,
            source: event.source,
            externalId: event.externalId,
            type: event.type,
            payload: event.payload,
          })
          .onConflictDoNothing({
            target: [
              responsibilityEvents.ownerUserId,
              responsibilityEvents.source,
              responsibilityEvents.externalId,
            ],
          })
          .returning({ id: responsibilityEvents.id });
        if (inserted.length === 0) {
          const [existing] = await transaction
            .select({ id: responsibilityEvents.id })
            .from(responsibilityEvents)
            .where(
              and(
                eq(responsibilityEvents.ownerUserId, event.ownerUserId),
                eq(responsibilityEvents.source, event.source),
                eq(responsibilityEvents.externalId, event.externalId),
              ),
            );
          if (!existing)
            throw new Error(
              "Duplicate responsibility event could not be loaded.",
            );
          const runs = await transaction
            .select({ id: responsibilityRuns.id })
            .from(responsibilityRuns)
            .where(eq(responsibilityRuns.eventId, existing.id));
          return {
            eventId: existing.id,
            duplicate: true,
            runIds: runs.map((run) => run.id),
          };
        }
        const candidates = await transaction
          .select()
          .from(responsibilities)
          .where(
            and(
              eq(responsibilities.ownerUserId, event.ownerUserId),
              eq(responsibilities.status, "active"),
              ...(event.responsibilityId
                ? [eq(responsibilities.id, event.responsibilityId)]
                : []),
            ),
          )
          .for("update");
        const matching = candidates.filter(
          (goal) =>
            (event.source === "manual" && event.responsibilityId === goal.id) ||
            (event.triggerId !== undefined &&
              event.responsibilityId === goal.id) ||
            goal.subscriptions.some(
              (subscription) =>
                subscription.source === event.source &&
                (subscription.eventType === event.type ||
                  subscription.eventType === "*"),
            ),
        );
        const runIds: string[] = [];
        for (const goal of matching) {
          const runId = randomUUID();
          await transaction
            .insert(responsibilityRuns)
            .values({ id: runId, responsibilityId: goal.id, eventId });
          await queueRun(transaction, runId);
          runIds.push(runId);
        }
        return { eventId, duplicate: false, runIds };
      });
    },
    async beginRun(runId, recovery) {
      // Resolve access before taking pooled transaction connections. The resolver reads the
      // actor/Bot/channel stores; running it inside two simultaneous transactions on a pool of
      // two would deadlock both while each waited for a third connection.
      const [reference] = await database
        .select({ responsibilityId: responsibilityRuns.responsibilityId })
        .from(responsibilityRuns)
        .where(eq(responsibilityRuns.id, runId));
      if (!reference) return null;
      const [targetGoal] = await database
        .select()
        .from(responsibilities)
        .where(eq(responsibilities.id, reference.responsibilityId));
      if (!targetGoal) return null;
      const target =
        targetGoal.status === "active"
          ? await options.resolveTarget(
              targetGoal.ownerUserId,
              targetGoal.agentId,
              targetGoal.channelId,
            )
          : null;
      const repeats =
        targetGoal.status === "active"
          ? await repeatsOf(database, targetGoal)
          : null;
      return database.transaction(async (transaction) => {
        const [reference] = await transaction
          .select({ responsibilityId: responsibilityRuns.responsibilityId })
          .from(responsibilityRuns)
          .where(eq(responsibilityRuns.id, runId));
        if (!reference) return null;
        const [goal] = await transaction
          .select()
          .from(responsibilities)
          .where(eq(responsibilities.id, reference.responsibilityId))
          .for("update");
        if (!goal) return null;
        const [run] = await transaction
          .select()
          .from(responsibilityRuns)
          .where(eq(responsibilityRuns.id, runId))
          .for("update");
        if (!run) return null;
        if (run.status === "running" && recovery?.recovered) {
          await transaction
            .update(responsibilityRuns)
            .set({
              status: "failed",
              error:
                "The worker stopped during this run. Actions may already have executed; this run was not replayed.",
              finishedAt: new Date(),
            })
            .where(eq(responsibilityRuns.id, runId));
          return null;
        }
        if (run.status !== "queued") return null;
        if (
          goal.status !== "active" ||
          !target ||
          target.threadId !== goal.threadId
        ) {
          await transaction
            .update(responsibilityRuns)
            .set({
              status: "skipped",
              error:
                goal.status !== "active"
                  ? `The goal is ${goal.status}.`
                  : "Bot or conversation access changed.",
              finishedAt: new Date(),
            })
            .where(eq(responsibilityRuns.id, runId));
          return null;
        }
        const [event] = await transaction
          .select()
          .from(responsibilityEvents)
          .where(eq(responsibilityEvents.id, run.eventId));
        if (!event) throw new Error("Responsibility run has no event.");
        await transaction
          .update(responsibilityRuns)
          .set({ status: "running", startedAt: new Date(), finishedAt: null })
          .where(eq(responsibilityRuns.id, runId));
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
            source: event.source,
            type: event.type,
            payload: event.payload,
          },
          continuation: run.continuation,
          repeats,
        };
      });
    },
    async settleRun(runId, outcome) {
      await database.transaction(async (transaction) => {
        const [reference] = await transaction
          .select({ responsibilityId: responsibilityRuns.responsibilityId })
          .from(responsibilityRuns)
          .where(eq(responsibilityRuns.id, runId));
        if (!reference) throw new ResponsibilityNotFoundError();
        await transaction
          .select({ id: responsibilities.id })
          .from(responsibilities)
          .where(eq(responsibilities.id, reference.responsibilityId))
          .for("update");
        const [run] = await transaction
          .select()
          .from(responsibilityRuns)
          .where(eq(responsibilityRuns.id, runId))
          .for("update");
        if (run?.status !== "running")
          throw new ResponsibilityRefusedError(
            "This goal's run is no longer running.",
          );
        const replyText =
          outcome.status === "succeeded"
            ? outcome.replyText.slice(0, 32_000)
            : null;
        await transaction
          .update(responsibilityRuns)
          .set({
            status: outcome.status,
            replyText,
            error: "error" in outcome ? outcome.error : null,
            waiting: outcome.status === "waiting" ? outcome.waiting : null,
            continuation: null,
            finishedAt: outcome.status === "waiting" ? null : new Date(),
          })
          .where(eq(responsibilityRuns.id, runId));
        if (outcome.status === "succeeded")
          await transaction
            .update(responsibilities)
            .set({ lastResult: replyText, updatedAt: new Date() })
            .where(eq(responsibilities.id, run.responsibilityId));
      });
    },
    async requeueRun(runId) {
      const [requeued] = await database
        .update(responsibilityRuns)
        .set({ status: "queued", startedAt: null, finishedAt: null })
        .where(
          and(
            eq(responsibilityRuns.id, runId),
            eq(responsibilityRuns.status, "running"),
          ),
        )
        .returning({ id: responsibilityRuns.id });
      return Boolean(requeued);
    },
    async resumeWaiting(ownerUserId, runId, response) {
      if (JSON.stringify(response)?.length > 32_768)
        throw new ResponsibilityRefusedError(
          "Continuation response exceeds 32 KiB.",
        );
      return database.transaction(async (transaction) => {
        const [reference] = await transaction
          .select({ responsibilityId: responsibilityRuns.responsibilityId })
          .from(responsibilityRuns)
          .where(eq(responsibilityRuns.id, runId));
        if (!reference) throw new ResponsibilityNotFoundError();
        const goal = await owned(
          transaction,
          ownerUserId,
          reference.responsibilityId,
          true,
        );
        const [run] = await transaction
          .select()
          .from(responsibilityRuns)
          .where(eq(responsibilityRuns.id, runId))
          .for("update");
        if (!run) throw new ResponsibilityNotFoundError();
        if (goal.status !== "active")
          throw new ResponsibilityRefusedError(
            "Resume the goal before answering its waiting run.",
          );
        if (run.status !== "waiting" || !run.waiting) return false;
        await transaction
          .update(responsibilityRuns)
          .set({
            status: "queued",
            continuation: { waiting: run.waiting, response },
            error: null,
          })
          .where(eq(responsibilityRuns.id, runId));
        await queueRun(transaction, runId, `${runId}:resume:${randomUUID()}`);
        return true;
      });
    },
  };
  return store;
}
