// server/tests/support/check-ins.ts
//
// Check-ins for the tests, in the real test Intelligence (`support/schedules.ts`).
//
// Settings, runs, items and pings live in Intelligence's agent schedules now, so where a test used to
// write a row to set the scene (a setting due a minute ago, a ping an hour old) it changes the record
// there instead, through the same client the server uses, under the record's version.
import { randomUUID } from "node:crypto";
import { suggestionOf } from "../../src/proactive/store";
import { ScheduleVersionConflictError } from "../../src/schedules/client";
import type {
  CheckInRunRecord,
  CheckInSettingRecord,
  CheckInSuggestionRecord,
  ScheduleChanges,
  ScheduleFilter,
} from "../../src/schedules/types";
import { testScheduleClient, useTestSchedules } from "./schedules";

/** Change a check-in setting as time or another replica would, and let this process's memory know. */
export async function changeCheckIn(
  id: string,
  changes: ScheduleChanges<"check-in-settings">,
): Promise<CheckInSettingRecord> {
  const directory = await useTestSchedules();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await directory.refresh("check-in-settings", id);
    if (!current) throw new Error(`No check-in setting ${id} to change.`);
    try {
      return await directory.update(
        "check-in-settings",
        id,
        current.version,
        changes,
      );
    } catch (error) {
      if (!(error instanceof ScheduleVersionConflictError)) throw error;
    }
  }
  throw new Error(`Check-in setting ${id} kept changing.`);
}

/** Make a check-in setting due: its clock a moment ago. */
export function makeDue(id: string, at = new Date(Date.now() - 1_000)) {
  return changeCheckIn(id, { nextRunAt: at });
}

/** Change one record of a check-in's history, under its version. */
export async function changeHistory<
  C extends "check-in-runs" | "check-in-suggestions" | "check-in-pings",
>(collection: C, id: string, changes: ScheduleChanges<C>) {
  const client = testScheduleClient();
  const current = await client.get(collection, id);
  if (!current) throw new Error(`No ${collection} record ${id} to change.`);
  return client.update(collection, id, current.version, changes);
}

/** Every run in a setting's ledger, newest first. */
export async function runsOf(settingId: string): Promise<CheckInRunRecord[]> {
  return (await testScheduleClient().all("check-in-runs", { settingId })).items;
}

/** A person's runs, newest first. */
export async function runsOfPerson(
  ownerUserId: string,
): Promise<CheckInRunRecord[]> {
  return (await testScheduleClient().all("check-in-runs", { ownerUserId }))
    .items;
}

/** A person's items, newest first, whatever their state. */
export async function itemsOf(
  ownerUserId: string,
): Promise<CheckInSuggestionRecord[]> {
  return (
    await testScheduleClient().all("check-in-suggestions", { ownerUserId })
  ).items;
}

/** A person's pings, oldest first. */
export async function pingsOf(ownerUserId: string) {
  return (await testScheduleClient().all("check-in-pings", { ownerUserId }))
    .items;
}

/** The person's check-in settings, as Intelligence has them (not this process's memory). */
export async function settingsOf(ownerUserId: string) {
  return (
    await testScheduleClient().all("check-in-settings", {
      ownerUserId,
    })
  ).items;
}

/**
 * Remove everything these people have in Intelligence's schedules, for good, and forget it here: the
 * cleanup a suite does in `afterAll`, as deleting its people used to cascade.
 */
export async function purgeSchedulesOf(owners: readonly string[]) {
  const directory = await useTestSchedules();
  const client = testScheduleClient();
  for (const owner of owners) await client.purgeOwner(owner);
  await directory.resync();
}

/**
 * Remove a person's items, pings and ping slot for good, keeping their settings: a suite's reset
 * between tests, as deleting those rows used to be.
 */
export async function purgeCheckInHistoryOf(ownerUserId: string) {
  const directory = await useTestSchedules();
  const client = testScheduleClient();
  for (const item of await itemsOf(ownerUserId))
    await client.purge("check-in-suggestions", item.id);
  for (const ping of await pingsOf(ownerUserId))
    await client.purge("check-in-pings", ping.id);
  for (const run of await runsOfPerson(ownerUserId))
    await client.purge("check-in-runs", run.id);
  await directory.purge("check-in-people", ownerUserId);
}

/** Free the person's hourly ping slot, as an hour passing would. */
export async function freeSlot(ownerUserId: string) {
  const directory = await useTestSchedules();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const person = await directory.refresh("check-in-people", ownerUserId);
    if (!person?.lastPingedAt) return;
    try {
      await directory.update("check-in-people", ownerUserId, person.version, {
        lastPingedAt: null,
      });
      return;
    } catch (error) {
      if (!(error instanceof ScheduleVersionConflictError)) throw error;
    }
  }
}

/** Set when the person was last pinged, as if their last ping went out then. */
export async function pingedAt(ownerUserId: string, at: Date | null) {
  const directory = await useTestSchedules();
  const person = await directory.refresh("check-in-people", ownerUserId);
  if (!person)
    return directory.create("check-in-people", {
      id: ownerUserId,
      lastPingedAt: at,
    });
  return directory.update("check-in-people", ownerUserId, person.version, {
    lastPingedAt: at,
  });
}

/** Remove for good every record of a check-in history collection that matches the filter. */
export async function purgeWhere(
  collection: "check-in-runs" | "check-in-suggestions" | "check-in-pings",
  filter: ScheduleFilter,
) {
  const client = testScheduleClient();
  for (const record of (await client.all(collection, filter)).items)
    await client.purge(collection, record.id);
}

/** Copy history in as it would have been written at the time: dates in the past included. */
export async function seedHistory(
  collection: "check-in-runs" | "check-in-suggestions" | "check-in-pings",
  records: readonly Record<string, unknown>[],
) {
  const stored = await testScheduleClient().importRecords(collection, records);
  if (stored !== records.length)
    throw new Error(
      `Intelligence holds ${stored} of the ${records.length} ${collection} records seeded.`,
    );
}

/** A record as `/import` takes it: every field as Intelligence answered it, dates included. */
function asImported(record: Record<string, unknown>) {
  const { version: _version, updatedAt: _updatedAt, ...rest } = record;
  return rest;
}

/** Write a check-in run again as though it had happened differently: started earlier, say. */
export async function rewriteRun(
  id: string,
  changes: ScheduleChanges<"check-in-runs">,
) {
  return changeHistory("check-in-runs", id, changes);
}

/**
 * Write a ping again as though it had been written at another time, with the items it carries still
 * naming it. When it was written is Intelligence's to keep, so the ping and its items are removed and
 * copied back in, the way an upgrade copies history in.
 */
export async function rewritePing(id: string, changes: { createdAt: Date }) {
  const client = testScheduleClient();
  const ping = await client.get("check-in-pings", id);
  if (!ping) throw new Error(`No check-in ping ${id} to rewrite.`);
  const { items } = await client.all("check-in-suggestions", { pingId: [id] });
  for (const item of items) await client.purge("check-in-suggestions", item.id);
  await client.purge("check-in-pings", id);
  await seedHistory("check-in-pings", [asImported({ ...ping, ...changes })]);
  if (items.length > 0)
    await seedHistory(
      "check-in-suggestions",
      items.map((item) => asImported({ ...item })),
    );
}

/**
 * A check-in setting for this person and Bot, and one open item an earlier check-in raised on it: the
 * scene a test of starting an item needs. The item as the store reads it.
 */
export async function settingWithItem(input: {
  ownerUserId: string;
  agentId: string;
  channelId: string;
  threadId: string;
  runId: string;
  title: string;
  detail: string;
  sourceApp: string | null;
  sourceRef: string | null;
  sourceLink: string | null;
}) {
  const directory = await useTestSchedules();
  const setting = await directory.create("check-in-settings", {
    id: randomUUID(),
    ownerUserId: input.ownerUserId,
    agentId: input.agentId,
    channelId: input.channelId,
    threadId: input.threadId,
    focus: "",
    subject: "",
    sourceLink: null,
    enabled: true,
    intervalMinutes: 60,
    nextRunAt: new Date(Date.now() + 3_600_000),
    lastRunAt: null,
    lastStatus: "idle",
    lastError: null,
  });
  const item = await directory.client.create("check-in-suggestions", {
    id: randomUUID(),
    ownerUserId: input.ownerUserId,
    agentId: input.agentId,
    settingId: setting.id,
    runId: input.runId,
    title: input.title,
    detail: input.detail,
    sourceApp: input.sourceApp,
    sourceRef: input.sourceRef,
    sourceLink: input.sourceLink,
    status: "open",
    dedupeKey: null,
    pingId: null,
    deliveredAt: null,
    resolvedAt: null,
  });
  return { setting, item: suggestionOf(item) };
}
