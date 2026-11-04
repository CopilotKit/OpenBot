/**
 * The check-ins a deployment kept before this release, as steps of the boot-time copy into
 * Intelligence (`schedules/upgrade.ts`). Parents first: settings, then the run ledger and the people,
 * then the pings, then the items, which name both a setting and a ping, so no record is ever copied
 * ahead of one it names.
 *
 * Every field as it was. A setting keeps its clock (`next_run_at`), so a check-in due at nine still
 * runs at nine on the first sweep after the upgrade, and its last status. A run keeps its outcome, so
 * the window, the daily cap and the admin's numbers read the same ledger as before. A person keeps
 * when they were last pinged, so nobody is pinged twice in an hour across the upgrade. A ping keeps
 * whether it was offered, so one written but never offered is still offered once. An item keeps its
 * normalized title and the ping that carried it, so the repeat check and the ping pass see what they
 * saw before.
 */
import { asc } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  proactivePeople,
  proactivePings,
  proactiveRuns,
  proactiveSettings,
  proactiveSuggestions,
} from "../db/schema/proactive";
import type { ScheduleCopyStep } from "../schedules/upgrade";

export function checkInCopySteps(database: Database): ScheduleCopyStep[] {
  return [
    {
      name: "schedules:check-in-settings",
      collection: "check-in-settings",
      read: async () =>
        (
          await database
            .select()
            .from(proactiveSettings)
            .orderBy(
              asc(proactiveSettings.createdAt),
              asc(proactiveSettings.id),
            )
        ).map((row) => ({
          id: row.id,
          ownerUserId: row.ownerUserId,
          agentId: row.agentId,
          channelId: row.channelId,
          threadId: row.threadId,
          focus: row.focus,
          subject: row.subject,
          sourceLink: row.sourceLink,
          enabled: row.enabled,
          intervalMinutes: row.intervalMinutes,
          nextRunAt: row.nextRunAt,
          lastRunAt: row.lastRunAt,
          lastStatus: row.lastStatus,
          lastError: row.lastError,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
    },
    {
      name: "schedules:check-in-runs",
      collection: "check-in-runs",
      read: async () =>
        (
          await database
            .select()
            .from(proactiveRuns)
            .orderBy(asc(proactiveRuns.startedAt), asc(proactiveRuns.id))
        ).map((row) => ({
          id: row.id,
          settingId: row.settingId,
          ownerUserId: row.ownerUserId,
          agentId: row.agentId,
          threadId: row.threadId,
          trigger: row.trigger,
          outcome: row.outcome,
          skipReason: row.skipReason,
          itemsRaised: row.itemsRaised,
          reads: row.reads,
          error: row.error,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          createdAt: row.startedAt,
        })),
    },
    {
      name: "schedules:check-in-people",
      collection: "check-in-people",
      read: async () =>
        (
          await database
            .select()
            .from(proactivePeople)
            .orderBy(asc(proactivePeople.ownerUserId))
        ).map((row) => ({
          id: row.ownerUserId,
          lastPingedAt: row.lastPingedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
    },
    {
      name: "schedules:check-in-pings",
      collection: "check-in-pings",
      read: async () =>
        (
          await database
            .select()
            .from(proactivePings)
            .orderBy(asc(proactivePings.createdAt), asc(proactivePings.id))
        ).map((row) => ({
          id: row.id,
          ownerUserId: row.ownerUserId,
          itemCount: row.itemCount,
          text: row.text,
          pushBody: row.pushBody,
          offeredAt: row.offeredAt,
          createdAt: row.createdAt,
        })),
    },
    {
      name: "schedules:check-in-suggestions",
      collection: "check-in-suggestions",
      read: async () =>
        (
          await database
            .select()
            .from(proactiveSuggestions)
            .orderBy(
              asc(proactiveSuggestions.createdAt),
              asc(proactiveSuggestions.id),
            )
        ).map((row) => ({
          id: row.id,
          ownerUserId: row.ownerUserId,
          agentId: row.agentId,
          settingId: row.settingId,
          runId: row.runId,
          title: row.title,
          detail: row.detail,
          sourceApp: row.sourceApp,
          sourceRef: row.sourceRef,
          sourceLink: row.sourceLink,
          status: row.status,
          dedupeKey: row.dedupeKey,
          pingId: row.pingId,
          deliveredAt: row.deliveredAt,
          resolvedAt: row.resolvedAt,
          createdAt: row.createdAt,
        })),
    },
  ];
}
