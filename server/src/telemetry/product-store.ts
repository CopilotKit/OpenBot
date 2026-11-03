import { randomBytes, randomUUID } from "node:crypto";
import { and, arrayContains, asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  enterpriseSettings,
  productTelemetryEvents,
  productTelemetryRuns,
} from "../db/schema";
import type {
  ProductFailure,
  ProductOutcome,
  ProductRun,
  ProductRunContext,
  ProductStore,
} from "./product";

type RunRow = typeof productTelemetryRuns.$inferSelect;
function fromRun(row: RunRow): ProductRun {
  return {
    actorUserId: row.actorUserId,
    threadId: row.threadId,
    context: row.context as ProductRunContext,
    acceptedAt: row.acceptedAt,
    ...(row.terminalAt ? { terminalAt: row.terminalAt } : {}),
    ...(row.outcome ? { outcome: row.outcome as ProductOutcome } : {}),
    ...(row.failureCategory
      ? { failureCategory: row.failureCategory as ProductFailure }
      : {}),
    resultMessageIds: row.resultMessageIds,
  };
}
export function createProductStore(database: Database): ProductStore {
  return {
    async identity() {
      const key = "product_telemetry_identity_v1";
      await database
        .insert(enterpriseSettings)
        .values({
          key,
          value: {
            deploymentId: randomUUID(),
            salt: randomBytes(32).toString("hex"),
          },
        })
        .onConflictDoNothing();
      const [row] = await database
        .select()
        .from(enterpriseSettings)
        .where(eq(enterpriseSettings.key, key));
      const value = row?.value;
      if (
        typeof value?.deploymentId !== "string" ||
        typeof value?.salt !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.salt)
      )
        throw new Error("Invalid persisted telemetry identity");
      return { deploymentId: value.deploymentId, salt: value.salt };
    },
    async accept(run) {
      await database
        .insert(productTelemetryRuns)
        .values({
          runId: run.context.run_id,
          actorUserId: run.actorUserId,
          threadId: run.threadId,
          context: run.context,
          acceptedAt: run.acceptedAt,
          resultMessageIds: [],
        })
        .onConflictDoNothing();
      const [row] = await database
        .select()
        .from(productTelemetryRuns)
        .where(
          and(
            eq(productTelemetryRuns.runId, run.context.run_id),
            eq(productTelemetryRuns.actorUserId, run.actorUserId),
            eq(productTelemetryRuns.threadId, run.threadId),
          ),
        );
      return row ? fromRun(row) : null;
    },
    async run(runId) {
      const [row] = await database
        .select()
        .from(productTelemetryRuns)
        .where(eq(productTelemetryRuns.runId, runId));
      return row ? fromRun(row) : null;
    },
    async finish(runId, outcome, failure, resultMessageIds, at) {
      const [row] = await database
        .update(productTelemetryRuns)
        .set({
          outcome,
          failureCategory: failure ?? null,
          resultMessageIds,
          terminalAt: at,
        })
        .where(
          and(
            eq(productTelemetryRuns.runId, runId),
            isNull(productTelemetryRuns.terminalAt),
          ),
        )
        .returning();
      return row ? fromRun(row) : null;
    },
    async linkResults(runId, resultMessageIds) {
      await database
        .update(productTelemetryRuns)
        .set({ resultMessageIds })
        .where(eq(productTelemetryRuns.runId, runId));
    },
    async result(actorUserId, threadId, messageId) {
      const [row] = await database
        .select()
        .from(productTelemetryRuns)
        .where(
          and(
            eq(productTelemetryRuns.actorUserId, actorUserId),
            eq(productTelemetryRuns.threadId, threadId),
            arrayContains(productTelemetryRuns.resultMessageIds, [messageId]),
          ),
        )
        .limit(1);
      return row ? fromRun(row) : null;
    },
    async event(event) {
      const [row] = await database
        .insert(productTelemetryEvents)
        .values(event)
        .onConflictDoNothing()
        .returning({ id: productTelemetryEvents.id });
      return !!row;
    },
    async pending(limit) {
      return database
        .select({
          id: productTelemetryEvents.id,
          name: productTelemetryEvents.name,
          properties: productTelemetryEvents.properties,
          createdAt: productTelemetryEvents.createdAt,
        })
        .from(productTelemetryEvents)
        .where(isNull(productTelemetryEvents.attemptedAt))
        .orderBy(asc(productTelemetryEvents.createdAt))
        .limit(limit);
    },
    async deliver(id, send) {
      return database.transaction(async (tx) => {
        // A transaction-scoped claim releases on rollback/process death. The shared
        // sender has a 3s timeout; at most one drain per replica holds this connection.
        const locks = await tx.execute(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${id}, 0)) as acquired`,
        );
        if (locks[0]?.acquired !== true) return false;
        const [event] = await tx
          .select({ attemptedAt: productTelemetryEvents.attemptedAt })
          .from(productTelemetryEvents)
          .where(eq(productTelemetryEvents.id, id));
        if (!event || event.attemptedAt) return false;
        await send();
        await tx
          .update(productTelemetryEvents)
          .set({
            attemptedAt: new Date(),
            attempts: sql`${productTelemetryEvents.attempts}+1`,
          })
          .where(eq(productTelemetryEvents.id, id));
        return true;
      });
    },
    async prune(before) {
      await database
        .delete(productTelemetryRuns)
        .where(lt(productTelemetryRuns.acceptedAt, before));
      await database
        .delete(productTelemetryEvents)
        .where(
          and(
            lt(productTelemetryEvents.createdAt, before),
            sql`${productTelemetryEvents.name} <> 'oss.runtime.openbot.first_human_success'`,
          ),
        );
    },
  };
}
