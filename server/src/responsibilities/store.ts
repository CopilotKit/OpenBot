import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  responsibilities,
  responsibilityEvents,
  responsibilityRuns,
  responsibilityTriggers,
} from "../db/schema/responsibilities";
import { workItems } from "../db/schema/work";
import { RESPONSIBILITY_RUN_KIND } from "./engine";
import {
  parseResponsibilityEvent,
  parseResponsibilityInput,
  parseResponsibilityPatch,
  type Responsibility,
  ResponsibilityNotFoundError,
  ResponsibilityRefusedError,
  type ResponsibilityStore,
} from "./types";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Connection = Database | Transaction;
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
        await owned(transaction, ownerUserId, id, true);
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
            "A completed responsibility cannot be resumed. Create a new responsibility.",
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
            "Only an active responsibility can make progress.",
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
              "Progress must come from the responsibility's current run.",
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
        return row;
      });
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
                  ? `Responsibility is ${goal.status}.`
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
            "This responsibility run is no longer running.",
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
            "Resume the responsibility before answering its waiting run.",
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
