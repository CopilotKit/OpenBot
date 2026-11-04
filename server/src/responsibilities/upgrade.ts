/**
 * The responsibilities, triggers, bound repositories, events and runs a deployment kept before this
 * release, as steps of the boot-time copy into Intelligence (`schedules/upgrade.ts`). Parents first:
 * responsibilities, then the triggers that point at them, the bindings and the events, and the runs
 * last, so no run is ever copied ahead of the responsibility and event it belongs to.
 *
 * Every field as it was, including each run's state, so a run queued or waiting before the upgrade
 * is dispatched or resumed after it. A trigger's and a binding's secret stays in the vault: the
 * record carries the vault id the row held, as `credentialRef`.
 */
import { asc } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  responsibilities,
  responsibilityEvents,
  responsibilityRuns,
  responsibilitySourceBindings,
  responsibilityTriggers,
} from "../db/schema/responsibilities";
import type { ScheduleCopyStep } from "../schedules/upgrade";

export function responsibilityCopySteps(
  database: Database,
): ScheduleCopyStep[] {
  return [
    {
      name: "schedules:responsibilities",
      collection: "responsibilities",
      read: async () =>
        (
          await database
            .select()
            .from(responsibilities)
            .orderBy(asc(responsibilities.createdAt), asc(responsibilities.id))
        ).map((row) => ({
          id: row.id,
          ownerUserId: row.ownerUserId,
          agentId: row.agentId,
          channelId: row.channelId,
          threadId: row.threadId,
          title: row.title,
          instruction: row.instruction,
          successCriteria: row.successCriteria,
          status: row.status,
          progress: row.progress,
          lastResult: row.lastResult,
          subscriptions: row.subscriptions,
          completedAt: row.completedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
    },
    {
      name: "schedules:responsibility-triggers",
      collection: "responsibility-triggers",
      read: async () =>
        (
          await database
            .select()
            .from(responsibilityTriggers)
            .orderBy(
              asc(responsibilityTriggers.createdAt),
              asc(responsibilityTriggers.id),
            )
        ).map((row) => ({
          id: row.id,
          ownerUserId: row.ownerUserId,
          responsibilityId: row.responsibilityId,
          kind: row.kind,
          config: row.config,
          credentialRef: row.credentialId,
          enabled: row.enabled,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
    },
    {
      name: "schedules:responsibility-source-bindings",
      collection: "responsibility-source-bindings",
      read: async () =>
        (
          await database
            .select()
            .from(responsibilitySourceBindings)
            .orderBy(
              asc(responsibilitySourceBindings.createdAt),
              asc(responsibilitySourceBindings.id),
            )
        ).map((row) => ({
          id: row.id,
          ownerUserId: row.ownerUserId,
          source: row.source,
          repository: row.repository,
          credentialRef: row.credentialId,
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
        })),
    },
    {
      name: "schedules:responsibility-events",
      collection: "responsibility-events",
      read: async () =>
        (
          await database
            .select()
            .from(responsibilityEvents)
            .orderBy(
              asc(responsibilityEvents.createdAt),
              asc(responsibilityEvents.id),
            )
        ).map((row) => ({
          id: row.id,
          ownerUserId: row.ownerUserId,
          source: row.source,
          externalId: row.externalId,
          type: row.type,
          payload: row.payload,
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
        })),
    },
    {
      name: "schedules:responsibility-runs",
      collection: "responsibility-runs",
      read: async () =>
        (
          await database
            .select()
            .from(responsibilityRuns)
            .orderBy(
              asc(responsibilityRuns.createdAt),
              asc(responsibilityRuns.id),
            )
        ).map((row) => ({
          id: row.id,
          responsibilityId: row.responsibilityId,
          eventId: row.eventId,
          status: row.status,
          replyText: row.replyText,
          error: row.error,
          waiting: row.waiting ?? null,
          continuation: row.continuation ?? null,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          createdAt: row.createdAt,
          updatedAt: row.finishedAt ?? row.startedAt ?? row.createdAt,
        })),
    },
  ];
}
