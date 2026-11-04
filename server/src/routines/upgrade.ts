/**
 * The routines and their runs a deployment kept before this release, as steps of the boot-time copy
 * into Intelligence (`schedules/upgrade.ts`). Routines first, so no run is ever copied ahead of the
 * routine it belongs to. Every field as it was, including each routine's clock (`next_run_at`), so a
 * routine due at nine still fires at nine on the first sweep after the upgrade, and every run's
 * outcome, so the routines page and the fatigue rule read the same history as before.
 */
import { asc } from "drizzle-orm";
import type { Database } from "../db/client";
import { routineRuns, routines } from "../db/schema";
import type { ScheduleCopyStep } from "../schedules/upgrade";

export function routineCopySteps(database: Database): ScheduleCopyStep[] {
  return [
    {
      name: "schedules:routines",
      collection: "routines",
      read: async () =>
        (
          await database
            .select()
            .from(routines)
            .orderBy(asc(routines.createdAt), asc(routines.id))
        ).map((row) => ({
          id: row.id,
          ownerUserId: row.ownerUserId,
          agentId: row.agentId,
          channelId: row.channelId,
          instruction: row.instruction,
          cron: row.cron,
          timezone: row.timezone,
          enabled: row.enabled,
          enabledAt: row.enabledAt,
          nextRunAt: row.nextRunAt,
          lastRunAt: row.lastRunAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
    },
    {
      name: "schedules:routine-runs",
      collection: "routine-runs",
      read: async () =>
        (
          await database
            .select()
            .from(routineRuns)
            .orderBy(asc(routineRuns.startedAt), asc(routineRuns.id))
        ).map((row) => ({
          id: row.id,
          routineId: row.routineId,
          source: row.source,
          status: row.status,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          waiting: row.waiting ?? null,
          error: row.error,
          createdAt: row.startedAt,
        })),
    },
  ];
}
